import type { CloudProvider, DetectionConfig } from '@cloudatlas/shared'
import { createDb, defaultDbPath } from '../db/index.js'
import { DemoProvider } from './demo/index.js'
import { LiveProvider } from './live/index.js'

export interface ProviderOptions {
  rootDir: string
  log?: (message: string, detail?: Record<string, unknown>) => void
  /** From cloudatlas.config.json; Cost Explorer is billed per request. */
  enableCostExplorer?: boolean
  detection?: DetectionConfig
  healthTtlMs?: number
}

export function createProvider(kind: 'live' | 'demo', options: ProviderOptions): CloudProvider {
  if (kind === 'demo') return new DemoProvider()
  return new LiveProvider({
    db: createDb(defaultDbPath(options.rootDir)),
    enableCostExplorer: options.enableCostExplorer ?? false,
    ...(options.detection ? { detection: options.detection } : {}),
    ...(options.healthTtlMs ? { healthTtlMs: options.healthTtlMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
}

export { DemoProvider, LiveProvider }
export { NotImplementedError } from './live/index.js'
