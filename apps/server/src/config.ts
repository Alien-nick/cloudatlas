import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configSchema, type CloudAtlasConfig } from '@cloudatlas/shared'

export const VERSION = '0.1.0'

/** Milestones not yet implemented. The UI reads this to show honest empty states. */
export const UNIMPLEMENTED: string[] = [
  // M3 cleared 'live-metrics', 'spike-detection', 'health-detection' and
  // 'alarm-history'. M4 cleared 'logs' and 'waf': discovery, FilterLogEvents
  // search, Logs Insights, StartLiveTail, web ACL collection in both scopes
  // and GetSampledRequests are all wired to the live provider.
  // M5 cleared 'agent': CloudTrail change lookup and the Claude agent with
  // read-only tools over the provider are both wired up.
  // M6 cleared 'command-palette' and 'export'. Nothing is outstanding.
]

export interface ServerConfig extends CloudAtlasConfig {
  port: number
  host: string
  logLevel: string
  anthropicApiKey: string | null
  model: string
  /** Absolute path of the repo root, used to resolve cloudatlas.config.json. */
  rootDir: string
}

function loadConfigFile(rootDir: string): unknown {
  const path = resolve(rootDir, 'cloudatlas.config.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw new Error(`cloudatlas.config.json is not valid JSON: ${(error as Error).message}`)
  }
}

function loadDotEnv(rootDir: string): void {
  // Minimal .env reader: we only need a handful of keys and want zero deps.
  let raw: string
  try {
    raw = readFileSync(resolve(rootDir, '.env'), 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key] !== undefined) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

export function loadConfig(rootDir: string): ServerConfig {
  loadDotEnv(rootDir)
  const fileConfig = configSchema.parse(loadConfigFile(rootDir))

  const providerEnv = process.env.CLOUDATLAS_PROVIDER
  const provider =
    providerEnv === 'live' || providerEnv === 'demo' ? providerEnv : fileConfig.provider

  const key = process.env.ANTHROPIC_API_KEY?.trim()

  return {
    ...fileConfig,
    provider,
    port: Number(process.env.CLOUDATLAS_PORT ?? 5174),
    host: '127.0.0.1',
    logLevel: process.env.CLOUDATLAS_LOG_LEVEL ?? 'info',
    anthropicApiKey: key && key.length > 0 ? key : null,
    model: process.env.CLOUDATLAS_MODEL ?? 'claude-sonnet-5',
    rootDir,
  }
}
