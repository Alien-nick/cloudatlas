import { join } from 'node:path'
import type { CloudAtlasDb } from './types.js'
import { SqliteDb } from './sqlite.js'

export * from './types.js'
export { SqliteDb } from './sqlite.js'

export function defaultDbPath(rootDir: string): string {
  return join(rootDir, 'data', 'cloudatlas.sqlite')
}

/**
 * Single construction point. Swapping the engine means changing this function
 * and `sqlite.ts`; nothing else imports a concrete implementation.
 */
export function createDb(path: string): CloudAtlasDb {
  return new SqliteDb(path)
}
