import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { loadConfig } from './config.js'
import { loggerOptions } from './logger.js'
import { createProvider } from './providers/index.js'
import { defaultDbPath } from './db/index.js'
import { MemorySimulationStore, SqliteSimulationStore, type SimulationStore } from './simulation/store.js'
import { registerRoutes } from './routes/index.js'
import { registerLocalOnlyGuard } from './security.js'

const here = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(here, '../../..')

const config = loadConfig(rootDir)

const app: FastifyInstance = Fastify({
  logger: loggerOptions(config.logLevel),
  bodyLimit: 4 * 1024 * 1024,
})

registerLocalOnlyGuard(app)

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: `Invalid request: ${error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
      missingPermission: null,
      code: 'BAD_REQUEST',
    })
  }

  // Fastify 5 types the handler's error as `unknown`; narrow once, up front.
  const err: Error & { statusCode?: number; operation?: string } =
    error instanceof Error ? error : new Error(String(error))
  const statusCode = err.statusCode ?? 500
  const name = err.name

  // AWS AccessDenied must never take down a whole panel — the UI renders a
  // "missing permission" notice against the section instead.
  if (name === 'AccessDeniedException' || name === 'AccessDenied' || statusCode === 403) {
    return reply.code(403).send({
      error: err.message,
      missingPermission: err.operation ?? null,
      code: 'ACCESS_DENIED',
    })
  }

  if (statusCode >= 500) request.log.error({ err }, 'request failed')

  return reply.code(statusCode).send({
    error: err.message,
    missingPermission: null,
    code: name || 'ERROR',
  })
})

const provider = createProvider(config.provider, {
  rootDir,
  enableCostExplorer: config.enableCostExplorer,
  detection: config.detection,
  keepScans: config.keepScans,
  healthTtlMs: config.healthPollSeconds * 1000,
  log: (message, detail) => app.log.info(detail ?? {}, message),
})

// Simulations sit beside the scan history, in the same local database file.
// Demo mode keeps them in memory: the demo account is fiction, and plans made
// against it do not belong in the database that holds real scans.
const simulations: SimulationStore =
  config.provider === 'demo' ? new MemorySimulationStore() : new SqliteSimulationStore(defaultDbPath(rootDir))

async function start(): Promise<void> {
  await registerRoutes(app, { provider, config, simulations })
  await app.listen({ host: config.host, port: config.port })

  const notes = [
    `provider=${config.provider}`,
    `model=${config.model}`,
    config.anthropicApiKey ? 'agent=ready' : 'agent=no ANTHROPIC_API_KEY',
  ].join(' · ')
  app.log.info(`CloudAtlas API on http://${config.host}:${config.port} — ${notes}`)
  if (config.provider === 'live') {
    app.log.info(
      'Live provider: topology scanning is active. Metrics, health detection and logs arrive in Milestones 3–4 — until then those panels return 501 rather than empty data.',
    )
  }
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`)
  await provider.dispose?.()
  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

start().catch((error: unknown) => {
  app.log.error({ err: error }, 'failed to start')
  process.exit(1)
})
