import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Finding, Graph } from '@cloudatlas/shared'
import type { AgentSessionRecord, CloudAtlasDb, ScanRecord, ScanSummary } from './types.js'

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id         TEXT PRIMARY KEY,
  profile    TEXT    NOT NULL,
  account_id TEXT    NOT NULL,
  regions    TEXT    NOT NULL,
  scanned_at INTEGER NOT NULL,
  node_count INTEGER NOT NULL,
  graph      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS scans_by_profile ON scans (profile, scanned_at DESC);

CREATE TABLE IF NOT EXISTS findings (
  scan_id    TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  node_id    TEXT    NOT NULL,
  severity   TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (scan_id, id)
);
CREATE INDEX IF NOT EXISTS findings_by_node ON findings (scan_id, node_id);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id         TEXT PRIMARY KEY,
  profile    TEXT    NOT NULL,
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  messages   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_by_profile ON agent_sessions (profile, updated_at DESC);
`

interface ScanRow {
  id: string
  profile: string
  account_id: string
  regions: string
  scanned_at: number
  node_count: number
  graph: string
}

interface FindingRow {
  payload: string
}

interface AgentRow {
  id: string
  profile: string
  title: string | null
  created_at: number
  updated_at: number
  messages: string
}

/**
 * `node:sqlite` implementation. Stable since Node 24, which the root
 * package.json pins, so there is no native build step and no chance of a Node
 * major breaking the install.
 */
export class SqliteDb implements CloudAtlasDb {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    // WAL keeps the scan write from blocking concurrent reads from the UI.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION))
  }

  saveScan(record: ScanRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scans
           (id, profile, account_id, regions, scanned_at, node_count, graph)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.profile,
        record.accountId,
        JSON.stringify(record.regions),
        record.scannedAt,
        record.graph.nodes.length,
        JSON.stringify(record.graph),
      )
  }

  latestScan(profile: string): ScanRecord | null {
    const row = this.db
      .prepare('SELECT * FROM scans WHERE profile = ? ORDER BY scanned_at DESC LIMIT 1')
      .get(profile) as ScanRow | undefined
    return row ? toScanRecord(row) : null
  }

  getScan(id: string): ScanRecord | null {
    const row = this.db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as ScanRow | undefined
    return row ? toScanRecord(row) : null
  }

  listScans(profile: string, limit = 20): ScanSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, profile, account_id, regions, scanned_at, node_count
           FROM scans WHERE profile = ? ORDER BY scanned_at DESC LIMIT ?`,
      )
      .all(profile, limit) as Array<Omit<ScanRow, 'graph'>>
    return rows.map((row) => ({
      id: row.id,
      profile: row.profile,
      accountId: row.account_id,
      regions: JSON.parse(row.regions) as string[],
      scannedAt: row.scanned_at,
      nodeCount: row.node_count,
    }))
  }

  pruneScans(profile: string, keep: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM scans
          WHERE profile = ?
            AND id NOT IN (
              SELECT id FROM scans WHERE profile = ? ORDER BY scanned_at DESC LIMIT ?
            )`,
      )
      .run(profile, profile, keep)
    return Number(result.changes)
  }

  saveFindings(scanId: string, findings: Finding[]): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM findings WHERE scan_id = ?').run(scanId)
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO findings
           (scan_id, id, node_id, severity, kind, started_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const finding of findings) {
        insert.run(
          scanId,
          finding.id,
          finding.nodeId,
          finding.severity,
          finding.kind,
          finding.startedAt,
          JSON.stringify(finding),
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getFindings(scanId: string): Finding[] {
    const rows = this.db
      .prepare('SELECT payload FROM findings WHERE scan_id = ? ORDER BY started_at DESC')
      .all(scanId) as unknown as FindingRow[]
    return rows.map((row) => JSON.parse(row.payload) as Finding)
  }

  saveAgentSession(session: AgentSessionRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_sessions
           (id, profile, title, created_at, updated_at, messages)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.profile,
        session.title,
        session.createdAt,
        session.updatedAt,
        JSON.stringify(session.messages),
      )
  }

  getAgentSession(id: string): AgentSessionRecord | null {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
      | AgentRow
      | undefined
    return row ? toAgentSession(row) : null
  }

  listAgentSessions(profile: string, limit = 50): AgentSessionRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM agent_sessions WHERE profile = ? ORDER BY updated_at DESC LIMIT ?',
      )
      .all(profile, limit) as unknown as AgentRow[]
    return rows.map(toAgentSession)
  }

  deleteAgentSession(id: string): void {
    this.db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id)
  }

  close(): void {
    this.db.close()
  }
}

function toScanRecord(row: ScanRow): ScanRecord {
  return {
    id: row.id,
    profile: row.profile,
    accountId: row.account_id,
    regions: JSON.parse(row.regions) as string[],
    scannedAt: row.scanned_at,
    graph: JSON.parse(row.graph) as Graph,
  }
}

function toAgentSession(row: AgentRow): AgentSessionRecord {
  return {
    id: row.id,
    profile: row.profile,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: JSON.parse(row.messages) as unknown[],
  }
}
