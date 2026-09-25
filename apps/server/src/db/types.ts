import type { Finding, Graph } from '@cloudatlas/shared'

export interface ScanRecord {
  id: string
  profile: string
  accountId: string
  regions: string[]
  scannedAt: number
  graph: Graph
}

export interface ScanSummary {
  id: string
  profile: string
  accountId: string
  regions: string[]
  scannedAt: number
  nodeCount: number
}

export interface AgentSessionRecord {
  id: string
  profile: string
  title: string | null
  createdAt: number
  updatedAt: number
  /** Opaque to the repository; the agent owns the shape. Milestone 5. */
  messages: unknown[]
}

/**
 * The persistence seam.
 *
 * The concrete implementation uses `node:sqlite`, which needs no native build
 * step. Everything the app does is key-value by scan id plus two small tables,
 * so the interface is narrow enough that swapping in `better-sqlite3` — or
 * anything else — is a single-file change with no call sites touched.
 */
export interface CloudAtlasDb {
  saveScan(record: ScanRecord): void
  /** Most recent completed scan for a profile, or null before the first one. */
  latestScan(profile: string): ScanRecord | null
  getScan(id: string): ScanRecord | null
  listScans(profile: string, limit?: number): ScanSummary[]
  /** Keeps the newest `keep` scans per profile and deletes the rest. */
  pruneScans(profile: string, keep: number): number

  saveFindings(scanId: string, findings: Finding[]): void
  getFindings(scanId: string): Finding[]

  saveAgentSession(session: AgentSessionRecord): void
  getAgentSession(id: string): AgentSessionRecord | null
  listAgentSessions(profile: string, limit?: number): AgentSessionRecord[]
  deleteAgentSession(id: string): void

  close(): void
}
