import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Graph, SimChange, Simulation, SimulationScope, SimulationSummary } from '@cloudatlas/shared'

/**
 * Where simulations live: a frozen copy of the scan they were cloned from,
 * and their change log. Local only, in the same data directory as the scans.
 */

export interface StoredSimulation {
  simulation: Simulation
  base: Graph
}

export interface SimulationStore {
  list(accountId: string): SimulationSummary[]
  get(id: string): StoredSimulation | null
  create(name: string, base: Graph, now?: number, scope?: SimulationScope | null): Simulation
  update(id: string, patch: { name?: string; changes?: SimChange[] }, now?: number): Simulation | null
  /** Replace the snapshot with a newer scan, keeping the change log. */
  rebase(id: string, base: Graph, now?: number): Simulation | null
  remove(id: string): boolean
}

function summarize(simulation: Simulation): SimulationSummary {
  const { changes, ...rest } = simulation
  return { ...rest, changeCount: changes.length }
}

function fresh(name: string, base: Graph, now: number, scope: SimulationScope | null): Simulation {
  return {
    scope,
    id: randomUUID(),
    name,
    accountId: base.accountId,
    profile: base.profile,
    createdAt: now,
    updatedAt: now,
    baseScannedAt: base.scannedAt,
    changes: [],
  }
}

export class MemorySimulationStore implements SimulationStore {
  private readonly items = new Map<string, StoredSimulation>()

  list(accountId: string): SimulationSummary[] {
    return [...this.items.values()]
      .filter((item) => item.simulation.accountId === accountId)
      .map((item) => summarize(item.simulation))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): StoredSimulation | null {
    const item = this.items.get(id)
    return item ? structuredClone(item) : null
  }

  create(name: string, base: Graph, now = Date.now(), scope: SimulationScope | null = null): Simulation {
    const simulation = fresh(name, base, now, scope)
    this.items.set(simulation.id, { simulation, base: structuredClone(base) })
    return simulation
  }

  update(id: string, patch: { name?: string; changes?: SimChange[] }, now = Date.now()): Simulation | null {
    const item = this.items.get(id)
    if (!item) return null
    item.simulation = { ...item.simulation, ...patch, updatedAt: now }
    return item.simulation
  }

  rebase(id: string, base: Graph, now = Date.now()): Simulation | null {
    const item = this.items.get(id)
    if (!item) return null
    item.base = structuredClone(base)
    item.simulation = { ...item.simulation, baseScannedAt: base.scannedAt, updatedAt: now }
    return item.simulation
  }

  remove(id: string): boolean {
    return this.items.delete(id)
  }
}

interface Row {
  id: string
  name: string
  account_id: string
  profile: string
  created_at: number
  updated_at: number
  base_scanned_at: number
  changes: string
  base: string
  scope: string | null
}

export class SqliteSimulationStore implements SimulationStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS simulations (
        id              TEXT PRIMARY KEY,
        name            TEXT    NOT NULL,
        account_id      TEXT    NOT NULL,
        profile         TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        base_scanned_at INTEGER NOT NULL,
        changes         TEXT    NOT NULL,
        base            TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS simulations_by_account ON simulations (account_id, updated_at DESC);
    `)
    // Added after the first release; older databases get the column here.
    const columns = this.db.prepare('PRAGMA table_info(simulations)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'scope')) this.db.exec('ALTER TABLE simulations ADD COLUMN scope TEXT')
  }

  private toSimulation(row: Row): Simulation {
    return {
      id: row.id,
      name: row.name,
      accountId: row.account_id,
      profile: row.profile,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      baseScannedAt: row.base_scanned_at,
      scope: row.scope ? (JSON.parse(row.scope) as SimulationScope) : null,
      changes: JSON.parse(row.changes) as SimChange[],
    }
  }

  list(accountId: string): SimulationSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM simulations WHERE account_id = ? ORDER BY updated_at DESC')
      .all(accountId) as unknown as Row[]
    return rows.map((row) => summarize(this.toSimulation(row)))
  }

  get(id: string): StoredSimulation | null {
    const row = this.db.prepare('SELECT * FROM simulations WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? { simulation: this.toSimulation(row), base: JSON.parse(row.base) as Graph } : null
  }

  create(name: string, base: Graph, now = Date.now(), scope: SimulationScope | null = null): Simulation {
    const simulation = fresh(name, base, now, scope)
    this.db
      .prepare(
        'INSERT INTO simulations (id, name, account_id, profile, created_at, updated_at, base_scanned_at, changes, base, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(simulation.id, name, base.accountId, base.profile, now, now, base.scannedAt, '[]', JSON.stringify(base), scope ? JSON.stringify(scope) : null)
    return simulation
  }

  update(id: string, patch: { name?: string; changes?: SimChange[] }, now = Date.now()): Simulation | null {
    const current = this.get(id)
    if (!current) return null
    const next = { ...current.simulation, ...patch, updatedAt: now }
    this.db
      .prepare('UPDATE simulations SET name = ?, changes = ?, updated_at = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.changes), now, id)
    return next
  }

  rebase(id: string, base: Graph, now = Date.now()): Simulation | null {
    const current = this.get(id)
    if (!current) return null
    this.db
      .prepare('UPDATE simulations SET base = ?, base_scanned_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(base), base.scannedAt, now, id)
    return { ...current.simulation, baseScannedAt: base.scannedAt, updatedAt: now }
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM simulations WHERE id = ?').run(id).changes) > 0
  }
}
