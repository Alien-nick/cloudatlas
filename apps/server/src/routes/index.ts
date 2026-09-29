import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  insightsRequestSchema,
  logQueryRequestSchema,
  metricsRequestSchema,
  scanRequestSchema,
  wafSampledRequestSchemaRequest,
  type CloudProvider,
  type ScanEvent,
} from '@cloudatlas/shared'
import type { ServerConfig } from '../config.js'
import { UNIMPLEMENTED, VERSION } from '../config.js'
import { openSse } from './sse.js'
import { runAgent } from '../agent/run.js'
import { streamMetrics } from '../metrics/stream.js'

const metricStreamQuery = z.object({
  nodeIds: z.string().min(1),
  metricNames: z.string().optional(),
  windowMs: z.coerce.number().min(60_000).max(7 * 24 * 60 * 60_000).default(3_600_000),
})

const agentChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1),
      }),
    )
    .min(1),
  /** The resource the user has open, so "this database" resolves. */
  selectedNodeId: z.string().nullable().optional(),
})

export interface RouteContext {
  provider: CloudProvider
  config: ServerConfig
}

const profileQuery = z.object({ profile: z.string().min(1) })

const scanStreamQuery = z.object({
  profile: z.string().min(1),
  /** Comma-separated so the browser can open an EventSource with a plain URL. */
  regions: z.string().min(1),
})

const tailQuery = z.object({
  logGroups: z.string().min(1),
  region: z.string().min(1),
  filterPattern: z.string().optional(),
})

const changesQuery = z.object({
  start: z.coerce.number(),
  end: z.coerce.number(),
})

const alarmHistoryQuery = z.object({ region: z.string().min(1) })
const alarmsQuery = z.object({ state: z.string().optional() })

export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { provider, config } = ctx

  // ---- meta -------------------------------------------------------------

  app.get('/api/info', async () => ({
    provider: provider.kind,
    version: VERSION,
    agentReady: config.anthropicApiKey !== null,
    model: config.model,
    costEnabled: config.enableCostExplorer,
    defaultRegions: config.defaultRegions,
    healthPollSeconds: config.healthPollSeconds,
    autoRefreshSeconds: config.autoRefreshSeconds,
    unimplemented: UNIMPLEMENTED,
  }))

  app.get('/api/profiles', async () => provider.listProfiles())

  app.get('/api/identity', async (request) => {
    const { profile } = profileQuery.parse(request.query)
    return provider.getIdentity(profile)
  })

  app.get('/api/regions', async (request) => {
    const { profile } = profileQuery.parse(request.query)
    return provider.listRegions(profile)
  })

  // ---- scanning ---------------------------------------------------------

  app.post('/api/scan', async (request) => {
    const body = scanRequestSchema.parse(request.body)
    const existing = provider.getGraph()
    if (existing && !body.force) return existing
    return provider.scan({ profile: body.profile, regions: body.regions })
  })

  app.get('/api/scan/stream', async (request, reply) => {
    const query = scanStreamQuery.parse(request.query)
    const regions = query.regions.split(',').map((r) => r.trim()).filter(Boolean)
    const channel = openSse(request, reply)

    const emit = (event: ScanEvent): void => channel.send(event)
    emit({ type: 'start', regions })

    try {
      const graph = await provider.scan({
        profile: query.profile,
        regions,
        signal: channel.signal,
        onProgress: (progress) => emit({ type: 'progress', progress }),
        onWarning: (warning) => emit({ type: 'warning', warning }),
        onFailure: (failure) => emit({ type: 'failure', failure }),
      })
      emit({ type: 'done', graph })
    } catch (error) {
      emit({ type: 'error', message: (error as Error).message })
    } finally {
      channel.close()
    }
    return reply
  })

  app.get('/api/graph', async (_request, reply) => {
    const graph = provider.getGraph()
    // 204 rather than 404: "no scan yet" is the expected first-run state, and
    // a 404 shows up as a console error in the browser for no good reason.
    if (!graph) return reply.code(204).send()
    return graph
  })

  // ---- metrics ----------------------------------------------------------

  app.post('/api/metrics', async (request) => {
    const body = metricsRequestSchema.parse(request.body)
    return provider.getMetrics(body)
  })

  /**
   * Continuous metric updates for a set of resources.
   *
   * One connection for however many resources are on screen, rather than a
   * timer per open panel: the cadence is derived from the metric period, so
   * the server does not spend GetMetricData calls re-fetching a datapoint that
   * CloudWatch has not replaced yet.
   */
  app.get('/api/metrics/stream', async (request, reply) => {
    const query = metricStreamQuery.parse(request.query)
    const channel = openSse(request, reply)

    const nodeIds = query.nodeIds.split(',').map((id) => id.trim()).filter(Boolean)
    const metricNames = (query.metricNames ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)

    try {
      const stream = streamMetrics({
        provider,
        nodeIds,
        metricNames,
        windowMs: query.windowMs,
        signal: channel.signal,
      })
      for await (const event of stream) {
        if (channel.closed) break
        channel.send(event)
      }
    } catch (error) {
      channel.send({ type: 'error', message: (error as Error).message })
    } finally {
      channel.close()
    }
    return reply
  })

  // ---- health -----------------------------------------------------------

  app.get('/api/findings', async () => ({
    findings: await provider.getFindings(),
    evaluatedAt: Date.now(),
    missingPermissions: [],
  }))

  app.get('/api/alarms', async (request) => {
    const { state } = alarmsQuery.parse(request.query)
    return { alarms: await provider.getAlarms(state), missingPermissions: [] }
  })

  app.get<{ Params: { name: string } }>('/api/alarms/:name/history', async (request) => {
    const { region } = alarmHistoryQuery.parse(request.query)
    return provider.getAlarmHistory(request.params.name, region)
  })

  // ---- logs -------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/nodes/:id/log-groups', async (request) =>
    provider.listLogGroups(request.params.id),
  )

  app.post('/api/logs/query', async (request) => {
    const body = logQueryRequestSchema.parse(request.body)
    return provider.queryLogs(body)
  })

  app.post('/api/logs/insights', async (request) => {
    const body = insightsRequestSchema.parse(request.body)
    return provider.queryInsights(body)
  })

  app.get('/api/logs/tail', async (request, reply) => {
    const query = tailQuery.parse(request.query)
    const channel = openSse(request, reply)
    const logGroups = query.logGroups.split(',').map((g) => g.trim()).filter(Boolean)

    try {
      const stream = provider.tailLogs({
        logGroups,
        region: query.region,
        filterPattern: query.filterPattern,
        signal: channel.signal,
      })
      for await (const batch of stream) {
        if (channel.closed) break
        channel.send({ type: 'events', events: batch })
      }
    } catch (error) {
      channel.send({ type: 'error', message: (error as Error).message })
    } finally {
      channel.close()
    }
    return reply
  })

  app.get<{ Params: { id: string } }>('/api/nodes/:id/db-load', async (request) => {
    const { start, end } = changesQuery.parse(request.query)
    return provider.getDatabaseLoad(request.params.id, start, end)
  })

  // ---- agent -------------------------------------------------------------

  app.post('/api/agent/chat', async (request, reply) => {
    if (!config.anthropicApiKey) {
      // 503 rather than 501: the feature exists, the key does not.
      return reply.code(503).send({
        error: 'Agent unavailable',
        message:
          'Set ANTHROPIC_API_KEY in .env to enable the agent. CloudAtlas never sends AWS credentials to the API — the agent reads this account through the same read-only tools the UI uses.',
        statusCode: 503,
      })
    }

    const body = agentChatSchema.parse(request.body)
    const channel = openSse(request, reply)

    try {
      const stream = runAgent({
        apiKey: config.anthropicApiKey,
        model: config.model,
        provider,
        selectedNodeId: body.selectedNodeId ?? null,
        messages: body.messages,
        signal: channel.signal,
      })
      for await (const event of stream) {
        if (channel.closed) break
        channel.send(event)
      }
    } catch (error) {
      channel.send({ type: 'error', message: (error as Error).message })
    } finally {
      channel.close()
    }
    return reply
  })

  // ---- WAF & change history --------------------------------------------

  app.post('/api/waf/sampled', async (request) => {
    const body = wafSampledRequestSchemaRequest.parse(request.body)
    return provider.getWafSampled(body)
  })

  app.get('/api/changes', async (request) => {
    const { start, end } = changesQuery.parse(request.query)
    return provider.getRecentChanges(start, end)
  })
}
