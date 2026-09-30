import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  addCredentialsRequestSchema,
  simChangeSchema,
  simulationScopeSchema,
  builtInTemplates,
  inRegion,
  summarizeTemplate,
  templateFromChanges,
  type ProjectTemplate,
  type RunRate,
  type SimChange,
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
import { launchSsmTerminal, TerminalLaunchError } from '../terminal/ssm.js'
import { evaluateCompliance } from '../compliance/evaluate.js'
import { CredentialsError, addAccessKeys } from '../aws/credentials-store.js'
import { applySimulation } from '../simulation/apply.js'
import { exportCli, exportTerraform } from '../simulation/export.js'
import { simulationImpact } from '../simulation/impact.js'
import { scopeGraph } from '../simulation/scope.js'
import { emptyGraph } from '../simulation/project.js'
import type { SimulationStore } from '../simulation/store.js'

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
  simulations: SimulationStore
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

const ssmTerminalSchema = z.object({ nodeId: z.string().min(1), profile: z.string().min(1) })

const alarmHistoryQuery = z.object({ region: z.string().min(1) })
const costQuery = z.object({ refresh: z.enum(['0', '1']).optional() })
const costExplorerSchema = z.object({ enabled: z.boolean() })
const simulationCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Omitted for the whole scan. */
  scope: simulationScopeSchema.nullable().optional(),
})
const simulationUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  changes: z.array(simChangeSchema).max(500).optional(),
})
const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'Not an AWS region'),
  /** A built-in or saved template to start from; omitted for a blank canvas. */
  templateId: z.string().nullable().optional(),
})
const templateSaveSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
})
const simulationExportQuery = z.object({ format: z.enum(['cli', 'terraform']).default('cli') })
const alarmsQuery = z.object({ state: z.string().optional() })

export async function registerRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { provider, config, simulations } = ctx

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

  // Access keys typed into the first-run screen, for a machine with no AWS
  // profile. Verified with STS, then saved as a profile in ~/.aws/credentials;
  // the response never contains the keys. See aws/credentials-store.ts.
  app.post('/api/credentials', async (request, reply) => {
    if (provider.kind !== 'live') {
      return reply.code(409).send({
        error: 'Demo mode uses fixture data and has no AWS connection. Start with npm run dev:live.',
        missingPermission: null,
        code: 'DEMO_MODE',
      })
    }
    const keys = addCredentialsRequestSchema.parse(request.body)
    try {
      return await addAccessKeys(keys)
    } catch (error) {
      if (!(error instanceof CredentialsError)) throw error
      return reply.code(error.status).send({ error: error.message, missingPermission: null, code: error.code })
    }
  })

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

  // Derived from the graph on each request rather than stored: it is a pure
  // function over a few hundred nodes, and computing it fresh means it can
  // never disagree with the scan it describes.
  app.get('/api/compliance', async (_request, reply) => {
    const graph = provider.getGraph()
    if (!graph) return reply.code(204).send()
    return evaluateCompliance(graph)
  })

  // Actual spend (Cost Explorer, cached), estimated run-rate and savings.
  // `refresh` re-reads Cost Explorer, which bills per request; the cache
  // still refuses a refresh within ten minutes of the last one.
  app.get('/api/cost', async (request, reply) => {
    const { refresh } = costQuery.parse(request.query)
    const report = await provider.getCostReport({ refresh: refresh === '1' })
    if (!report) return reply.code(204).send()
    return report
  })

  app.post('/api/cost/explorer', async (request) => {
    const { enabled } = costExplorerSchema.parse(request.body)
    await provider.setCostExplorerEnabled(enabled)
    return { enabled }
  })

  // ---- simulations ------------------------------------------------------
  // What-if copies of the scan. Nothing here calls AWS except pricing (read
  // only, free); the exports are text for the user to run.

  const loadSimulation = (id: string) => {
    const stored = simulations.get(id)
    if (!stored) return null
    return { stored, simulated: applySimulation(stored.base, stored.simulation) }
  }
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: 'No such simulation', missingPermission: null, code: 'NOT_FOUND' })

  app.get('/api/simulations', async () => {
    const graph = provider.getGraph()
    return graph ? simulations.list({ kind: 'simulation', accountId: graph.accountId }) : []
  })

  app.post('/api/simulations', async (request, reply) => {
    const { name, scope } = simulationCreateSchema.parse(request.body)
    const graph = provider.getGraph()
    if (!graph) return reply.code(409).send({ error: 'Scan an account before cloning it.', missingPermission: null, code: 'NO_SCAN' })
    const simulation = simulations.create(name, scopeGraph(graph, scope ?? null), Date.now(), { scope: scope ?? null })
    return loadSimulation(simulation.id)!.simulated
  })

  app.get<{ Params: { id: string } }>('/api/simulations/:id', async (request, reply) => {
    const loaded = loadSimulation(request.params.id)
    return loaded ? loaded.simulated : notFound(reply)
  })

  app.put<{ Params: { id: string } }>('/api/simulations/:id', async (request, reply) => {
    const patch = simulationUpdateSchema.parse(request.body)
    if (!simulations.update(request.params.id, patch)) return notFound(reply)
    return loadSimulation(request.params.id)!.simulated
  })

  app.delete<{ Params: { id: string } }>('/api/simulations/:id', async (request, reply) => {
    return simulations.remove(request.params.id) ? reply.code(204).send() : notFound(reply)
  })

  /** Replace the frozen snapshot with the latest scan, keeping every change. */
  app.post<{ Params: { id: string } }>('/api/simulations/:id/rebase', async (request, reply) => {
    const graph = provider.getGraph()
    if (!graph) return reply.code(409).send({ error: 'No scan to rebase onto.', missingPermission: null, code: 'NO_SCAN' })
    const current = simulations.get(request.params.id)
    if (!current) return notFound(reply)
    if (current.simulation.kind === 'project') {
      return reply.code(409).send({ error: 'A project is not a copy of a scan.', missingPermission: null, code: 'NOT_A_SIMULATION' })
    }
    simulations.rebase(request.params.id, scopeGraph(graph, current.simulation.scope))
    return loadSimulation(request.params.id)!.simulated
  })

  app.get<{ Params: { id: string } }>('/api/simulations/:id/impact', async (request, reply) => {
    const loaded = loadSimulation(request.params.id)
    if (!loaded) return notFound(reply)
    let rates: RunRate[]
    try {
      rates = await provider.estimateRunRates([loaded.stored.base, loaded.simulated.graph])
    } catch (error) {
      // A project can be sketched before any account is connected; the rest
      // of its impact does not need prices, so it is still worth showing.
      const message = `Prices could not be looked up: ${(error as Error).message}. Connect an AWS profile to estimate cost.`
      rates = [0, 1].map(() => ({ source: 'Not priced', lines: [], unpriced: [], message }))
    }
    return simulationImpact(loaded.stored.base, loaded.simulated, [rates[0]!, rates[1]!])
  })

  app.get<{ Params: { id: string } }>('/api/simulations/:id/export', async (request, reply) => {
    const { format } = simulationExportQuery.parse(request.query)
    const loaded = loadSimulation(request.params.id)
    if (!loaded) return notFound(reply)
    return format === 'terraform'
      ? exportTerraform(loaded.stored.base, loaded.simulated)
      : exportCli(loaded.stored.base, loaded.simulated)
  })

  // ---- projects ---------------------------------------------------------
  // Designs from scratch: a simulation on an empty snapshot, optionally
  // started from a template. Edited, priced and exported through the
  // simulation routes above.

  const templates = (): ProjectTemplate[] => [...builtInTemplates(), ...simulations.listTemplates()]

  app.get('/api/projects', async () => simulations.list({ kind: 'project' }))

  app.get('/api/project-templates', async () => templates().map(summarizeTemplate))

  app.post('/api/projects', async (request, reply) => {
    const body = projectCreateSchema.parse(request.body)
    let changes: SimChange[] = []
    if (body.templateId) {
      const template = templates().find((candidate) => candidate.id === body.templateId)
      if (!template) return reply.code(404).send({ error: 'No such template', missingPermission: null, code: 'NOT_FOUND' })
      changes = inRegion(template.changes, body.region)
    }
    const base = emptyGraph(body.region, provider.getGraph()?.profile ?? '')
    const project = simulations.create(body.name, base, Date.now(), {
      kind: 'project',
      description: body.description,
      templateId: body.templateId ?? null,
      changes,
    })
    return loadSimulation(project.id)!.simulated
  })

  /** Save a project's design as a template for new projects. */
  app.post<{ Params: { id: string } }>('/api/projects/:id/template', async (request, reply) => {
    const { name, description } = templateSaveSchema.parse(request.body)
    const stored = simulations.get(request.params.id)
    if (!stored) return notFound(reply)
    const template = templateFromChanges(`saved-${randomUUID()}`, name, description, stored.simulation.changes, Date.now())
    simulations.saveTemplate(template)
    return summarizeTemplate(template)
  })

  app.delete<{ Params: { id: string } }>('/api/project-templates/:id', async (request, reply) => {
    return simulations.removeTemplate(request.params.id) ? reply.code(204).send() : notFound(reply)
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

  // ---- terminal ---------------------------------------------------------

  // Opens the user's terminal on `aws ssm start-session`. The target comes
  // from the scanned graph, not the request, and the profile must be one we
  // listed, so the browser can only name an instance, never a command.
  app.post('/api/terminal/ssm', async (request, reply) => {
    const body = ssmTerminalSchema.parse(request.body)
    if (provider.kind === 'demo') {
      return reply.code(409).send({
        error: 'Demo instances are not real — there is nothing to connect to.',
        missingPermission: null,
        code: 'DEMO',
      })
    }
    const node = provider.getGraph()?.nodes.find((n) => n.id === body.nodeId)
    const profiles = await provider.listProfiles()
    if (!node || node.type !== 'ec2' || !profiles.some((p) => p.name === body.profile)) {
      return reply.code(400).send({
        error: 'Unknown EC2 instance or profile.',
        missingPermission: null,
        code: 'BAD_REQUEST',
      })
    }
    const instanceId = node.props.find((p) => p.k === 'Instance ID')?.v ?? node.name
    try {
      return await launchSsmTerminal({ instanceId, profile: body.profile, region: node.region })
    } catch (error) {
      if (!(error instanceof TerminalLaunchError)) throw error
      return reply.code(error.code === 'INVALID_TARGET' ? 400 : 500).send({
        error: error.message,
        missingPermission: null,
        code: error.code,
      })
    }
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
