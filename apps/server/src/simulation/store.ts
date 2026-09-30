import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Graph, ProjectTemplate, SimChange, Simulation, SimulationScope, SimulationSummary } from '@cloudatlas/shared'

/**
 * Where simulations and projects live: a frozen copy of the graph they start
 * from (a scan, or an empty one for a project), and their change log. Local
 * only, in the same data directory as the scans. Saved project templates are
 * kept alongside.
 */

export interface StoredSimulation {
  simulation: Simulation
  base: Graph
}

export type SimulationKind = Simulation['kind']

export interface CreateOptions {
  scope?: SimulationScope | null
  kind?: SimulationKind
  description?: string
  templateId?: string | null
  changes?: SimChange[]
}

export interface SimulationPatch {
  name?: string
  description?: string
  changes?: SimChange[]
}

export interface SimulationStore {
  /** Simulations of one account, or every project — projects belong to no account. */
  list(filter: { kind: 'simulation'; accountId: string } | { kind: 'project' }): SimulationSummary[]
  get(id: string): StoredSimulation | null
  create(name: string, base: Graph, now?: number, options?: CreateOptions): Simulation
  update(id: string, patch: SimulationPatch, now?: number): Simulation | null
  /** Replace the snapshot with a newer scan, keeping the change log. */
  rebase(id: string, base: Graph, now?: number): Simulation | null
  remove(id: string): boolean

  listTemplates(): ProjectTemplate[]
  getTemplate(id: string): ProjectTemplate | null
  saveTemplate(template: ProjectTemplate): void
  removeTemplate(id: string): boolean
}

function summarize(simulation: Simulation): SimulationSummary {
  const { changes, ...rest } = simulation
  return { ...rest, changeCount: changes.length }
}

function matches(simulation: Simulation, filter: Parameters<SimulationStore['list']>[0]): boolean {
  if (simulation.kind !== filter.kind) return false
  return filter.kind === 'project' || simulation.accountId === filter.accountId
}

function fresh(name: string, base: Graph, now: number, options: CreateOptions): Simulation {
  return {
    id: randomUUID(),
    name,
    accountId: base.accountId,
    profile: base.profile,
    createdAt: now,
    updatedAt: now,
    baseScannedAt: base.scannedAt,
    scope: options.scope ?? null,
    kind: options.kind ?? 'simulation',
    description: options.description ?? '',
    templateId: options.templateId ?? null,
    changes: options.changes ?? [],
  }
}

export class MemorySimulationStore implements SimulationStore {
  private readonly items = new Map<string, StoredSimulation>()
  private readonly templates = new Map<string, ProjectTemplate>()

  list(filter: Parameters<SimulationStore['list']>[0]): SimulationSummary[] {
    return [...this.items.values()]
      .filter((item) => matches(item.simulation, filter))
      .map((item) => summarize(item.simulation))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): StoredSimulation | null {
    const item = this.items.get(id)
    return item ? structuredClone(item) : null
  }

  create(name: string, base: Graph, now = Date.now(), options: CreateOptions = {}): Simulation {
    const simulation = fresh(name, base, now, options)
    this.items.set(simulation.id, { simulation, base: structuredClone(base) })
    return simulation
  }

  update(id: string, patch: SimulationPatch, now = Date.now()): Simulation | null {
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

  listTemplates(): ProjectTemplate[] {
    return [...this.templates.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  getTemplate(id: string): ProjectTemplate | null {
    return this.templates.get(id) ?? null
  }

  saveTemplate(template: ProjectTemplate): void {
    this.templates.set(template.id, structuredClone(template))
  }

  removeTemplate(id: string): boolean {
    return this.templates.delete(id)
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
  kind: string | null
  description: string | null
  template_id: string | null
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
      CREATE TABLE IF NOT EXISTS project_templates (
        id         TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        body       TEXT    NOT NULL
      );
    `)
    // Added after the first release; older databases get the columns here.
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(simulations)').all() as Array<{ name: string }>).map((column) => column.name),
    )
    for (const column of ['scope', 'kind', 'description', 'template_id']) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE simulations ADD COLUMN ${column} TEXT`)
    }
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
      kind: row.kind === 'project' ? 'project' : 'simulation',
      description: row.description ?? '',
      templateId: row.template_id,
      changes: JSON.parse(row.changes) as SimChange[],
    }
  }

  list(filter: Parameters<SimulationStore['list']>[0]): SimulationSummary[] {
    // Listing reads only the summary columns: a project's base is small, but a
    // simulation's is a whole scan.
    const columns = 'id, name, account_id, profile, created_at, updated_at, base_scanned_at, changes, scope, kind, description, template_id'
    const rows = (
      filter.kind === 'project'
        ? this.db.prepare(`SELECT ${columns} FROM simulations WHERE kind = 'project' ORDER BY updated_at DESC`).all()
        : this.db
            .prepare(
              `SELECT ${columns} FROM simulations WHERE account_id = ? AND (kind IS NULL OR kind = 'simulation') ORDER BY updated_at DESC`,
            )
            .all(filter.accountId)
    ) as unknown as Row[]
    return rows.map((row) => summarize(this.toSimulation(row)))
  }

  get(id: string): StoredSimulation | null {
    const row = this.db.prepare('SELECT * FROM simulations WHERE id = ?').get(id) as unknown as Row | undefined
    return row ? { simulation: this.toSimulation(row), base: JSON.parse(row.base) as Graph } : null
  }

  create(name: string, base: Graph, now = Date.now(), options: CreateOptions = {}): Simulation {
    const simulation = fresh(name, base, now, options)
    this.db
      .prepare(
        `INSERT INTO simulations
           (id, name, account_id, profile, created_at, updated_at, base_scanned_at, changes, base, scope, kind, description, template_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        simulation.id,
        name,
        base.accountId,
        base.profile,
        now,
        now,
        base.scannedAt,
        JSON.stringify(simulation.changes),
        JSON.stringify(base),
        simulation.scope ? JSON.stringify(simulation.scope) : null,
        simulation.kind,
        simulation.description,
        simulation.templateId,
      )
    return simulation
  }

  update(id: string, patch: SimulationPatch, now = Date.now()): Simulation | null {
    const current = this.get(id)
    if (!current) return null
    const next = { ...current.simulation, ...patch, updatedAt: now }
    this.db
      .prepare('UPDATE simulations SET name = ?, description = ?, changes = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, JSON.stringify(next.changes), now, id)
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

  listTemplates(): ProjectTemplate[] {
    const rows = this.db.prepare('SELECT body FROM project_templates ORDER BY created_at DESC').all() as Array<{ body: string }>
    return rows.map((row) => JSON.parse(row.body) as ProjectTemplate)
  }

  getTemplate(id: string): ProjectTemplate | null {
    const row = this.db.prepare('SELECT body FROM project_templates WHERE id = ?').get(id) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as ProjectTemplate) : null
  }

  saveTemplate(template: ProjectTemplate): void {
    this.db
      .prepare('INSERT OR REPLACE INTO project_templates (id, created_at, body) VALUES (?, ?, ?)')
      .run(template.id, template.createdAt, JSON.stringify(template))
  }

  removeTemplate(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM project_templates WHERE id = ?').run(id).changes) > 0
  }
}
