import type {
  Alarm,
  AlarmsResponse,
  FindingsResponse,
  Graph,
  Identity,
  LogGroupRef,
  InsightsRequest,
  InsightsResponse,
  LogEvent,
  LogQueryRequest,
  DatabaseLoad,
  LogQueryResponse,
  MetricSeries,
  WafSampledRequestsRequest,
  WafSampledResponse,
  MetricsRequest,
  MetricsResponse,
  Profile,
  ScanEvent,
  ServerInfo,
} from '@cloudatlas/shared'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly missingPermission: string | null,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  } catch (cause) {
    throw new ApiError(
      'Cannot reach the CloudAtlas API. Is the server running on 127.0.0.1:5174?',
      0,
      'NETWORK',
      null,
    )
  }

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    let code: string | null = null
    let missingPermission: string | null = null
    try {
      const body = (await response.json()) as {
        error?: string
        code?: string | null
        missingPermission?: string | null
      }
      if (body.error) message = body.error
      code = body.code ?? null
      missingPermission = body.missingPermission ?? null
    } catch {
      // Non-JSON error body; keep the status line.
    }
    throw new ApiError(message, response.status, code, missingPermission)
  }

  if (response.status === 204) {
    // Drain the (empty) body; leaving it unread makes Chrome log ERR_ABORTED.
    await response.text()
    return null as T
  }
  return (await response.json()) as T
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export const api = {
  info: () => request<ServerInfo>('/api/info'),
  profiles: () => request<Profile[]>('/api/profiles'),
  identity: (profile: string) =>
    request<Identity>(`/api/identity?profile=${encodeURIComponent(profile)}`),
  regions: (profile: string) =>
    request<string[]>(`/api/regions?profile=${encodeURIComponent(profile)}`),

  /** Null until the first scan completes. */
  graph: () => request<Graph | null>('/api/graph'),
  scan: (profile: string, regions: string[], force = false) =>
    post<Graph>('/api/scan', { profile, regions, force }),

  metrics: (body: MetricsRequest) => post<MetricsResponse>('/api/metrics', body),

  findings: () => request<FindingsResponse>('/api/findings'),
  alarms: (state?: string) =>
    request<AlarmsResponse>(`/api/alarms${state ? `?state=${encodeURIComponent(state)}` : ''}`),
  alarmHistory: (name: string, region: string) =>
    request<Alarm[]>(
      `/api/alarms/${encodeURIComponent(name)}/history?region=${encodeURIComponent(region)}`,
    ),

  logGroups: (nodeId: string) =>
    request<LogGroupRef[]>(`/api/nodes/${encodeURIComponent(nodeId)}/log-groups`),
  queryLogs: (body: LogQueryRequest) => post<LogQueryResponse>('/api/logs/query', body),
  queryInsights: (body: InsightsRequest) => post<InsightsResponse>('/api/logs/insights', body),
  databaseLoad: (nodeId: string, start: number, end: number) =>
    request<DatabaseLoad>(
      `/api/nodes/${encodeURIComponent(nodeId)}/db-load?start=${start}&end=${end}`,
    ),
  wafSampled: (body: WafSampledRequestsRequest) =>
    post<WafSampledResponse>('/api/waf/sampled', body),

  /** Opens the user's terminal on `aws ssm start-session` for an EC2 node. */
  openSsmTerminal: (nodeId: string, profile: string) =>
    post<{ command: string }>('/api/terminal/ssm', { nodeId, profile }),
}

/**
 * Incremental SSE frame parser.
 *
 * A network chunk has no relationship to a frame boundary: one read can carry
 * half an event, three events, or the first byte of a fourth. Anything that
 * parses a chunk in isolation drops whatever straddles the split, which shows
 * up as occasional missing events under load and almost never in a quick test.
 *
 * Extracted from the stream reader so that behaviour is testable without a
 * server, a `fetch`, or a model.
 */
export function createSseParser<T>(): { push: (chunk: string) => T[] } {
  let buffer = ''
  return {
    push(chunk: string): T[] {
      buffer += chunk
      const events: T[] = []

      // Frames are separated by a blank line. A trailing partial frame stays in
      // the buffer until the rest of it arrives.
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')

        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          try {
            events.push(JSON.parse(line.slice(5).trim()) as T)
          } catch {
            // A malformed frame costs one event, not the stream.
          }
        }
      }
      return events
    },
  }
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface AgentHandlers {
  onEvent: (event: AgentEvent) => void
  onClose: () => void
}

/**
 * Stream an agent turn.
 *
 * A POST rather than an EventSource, because the conversation goes in the body
 * — EventSource is GET-only and a long transcript does not belong in a URL.
 * Returns a disposer; calling it aborts the turn, and the server stops its own
 * work when the connection drops.
 */
export function streamAgent(
  body: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; selectedNodeId: string | null },
  handlers: AgentHandlers,
): () => void {
  const controller = new AbortController()

  void (async () => {
    try {
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null
        handlers.onEvent({
          type: 'error',
          message: detail?.message ?? `Agent request failed (${response.status}).`,
        })
        handlers.onClose()
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        handlers.onEvent({ type: 'error', message: 'The agent response had no body.' })
        handlers.onClose()
        return
      }

      const decoder = new TextDecoder()
      const parser = createSseParser<AgentEvent>()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          handlers.onEvent(event)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        handlers.onEvent({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      handlers.onClose()
    }
  })()

  return () => controller.abort()
}

export interface MetricStreamUpdate {
  type: 'metrics'
  nodeId: string
  series: MetricSeries[]
  /** Age of the newest datapoint, in ms. Null when there is none. */
  lagMs: number | null
  missingPermissions: string[]
}

export type MetricStreamEvent = MetricStreamUpdate | { type: 'error'; message: string }

export interface MetricStreamHandlers {
  onUpdate: (update: MetricStreamUpdate) => void
  onError: (message: string) => void
}

/**
 * Subscribe to continuous metric updates. Returns a disposer.
 *
 * One connection covers every resource passed in, and the server only pushes
 * when a datapoint the client has not seen actually lands — so this is quieter
 * than a timer, not busier.
 */
export function streamMetrics(
  params: { nodeIds: string[]; metricNames?: string[]; windowMs: number },
  handlers: MetricStreamHandlers,
): () => void {
  const query = new URLSearchParams({
    nodeIds: params.nodeIds.join(','),
    windowMs: String(params.windowMs),
  })
  if (params.metricNames?.length) query.set('metricNames', params.metricNames.join(','))

  const source = new EventSource(`/api/metrics/stream?${query.toString()}`)
  let closed = false

  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as MetricStreamEvent
      if (event.type === 'metrics') handlers.onUpdate(event)
      else handlers.onError(event.message)
    } catch {
      // A malformed frame costs one update, not the stream.
    }
  }
  source.onerror = () => {
    if (!closed && source.readyState === EventSource.CLOSED) {
      handlers.onError('The metric stream disconnected.')
    }
  }

  return () => {
    closed = true
    source.close()
  }
}

export interface TailHandlers {
  onEvents: (events: LogEvent[]) => void
  onError: (message: string) => void
}

/**
 * Subscribe to live tail. Returns a disposer.
 *
 * Closing the EventSource is what ends the CloudWatch session — the server
 * aborts its stream when the connection drops — so the caller must always call
 * the disposer, including on unmount.
 */
export function streamTail(
  params: { logGroups: string[]; region: string; filterPattern: string },
  handlers: TailHandlers,
): () => void {
  const query = new URLSearchParams({
    logGroups: params.logGroups.join(','),
    region: params.region,
    filterPattern: params.filterPattern,
  })
  const source = new EventSource(`/api/logs/tail?${query.toString()}`)
  let closed = false

  source.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data) as
        | { type: 'events'; events: LogEvent[] }
        | { type: 'error'; message: string }
      if (payload.type === 'events') handlers.onEvents(payload.events)
      else handlers.onError(payload.message)
    } catch {
      // A malformed frame costs one batch, not the session.
    }
  }
  source.onerror = () => {
    // EventSource fires onerror on normal close too; only surface real failures.
    if (!closed && source.readyState === EventSource.CLOSED) {
      handlers.onError('The live tail connection closed.')
    }
  }

  return () => {
    closed = true
    source.close()
  }
}

export interface ScanStreamHandlers {
  onEvent: (event: ScanEvent) => void
  onError: (message: string) => void
}

/**
 * Subscribe to scan progress. Returns a disposer; call it to cancel the scan
 * stream (the server aborts its own work when the connection drops).
 */
export function streamScan(
  profile: string,
  regions: string[],
  handlers: ScanStreamHandlers,
): () => void {
  const params = new URLSearchParams({ profile, regions: regions.join(',') })
  const source = new EventSource(`/api/scan/stream?${params.toString()}`)
  let finished = false

  source.onmessage = (message) => {
    let event: ScanEvent
    try {
      event = JSON.parse(message.data as string) as ScanEvent
    } catch {
      return
    }
    handlers.onEvent(event)
    if (event.type === 'done' || event.type === 'error') {
      finished = true
      source.close()
    }
  }

  source.onerror = () => {
    // EventSource fires onerror on normal close too; only surface real failures.
    if (!finished) handlers.onError('Scan stream disconnected.')
    source.close()
  }

  return () => {
    finished = true
    source.close()
  }
}
