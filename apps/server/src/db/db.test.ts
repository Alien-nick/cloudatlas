import { beforeEach, describe, expect, it } from 'vitest'
import type { Finding, Graph } from '@cloudatlas/shared'
import { SqliteDb } from './sqlite.js'
import type { CloudAtlasDb, ScanRecord } from './types.js'

function graph(nodeIds: string[]): Graph {
  return {
    nodes: nodeIds.map((id) => ({
      id,
      arn: null,
      type: 'ec2',
      category: 'compute',
      name: id,
      abbr: 'EC2',
      typeLabel: 'EC2 instance',
      region: 'us-east-1',
      az: null,
      vpcId: null,
      subnetId: null,
      parentId: null,
      state: 'running',
      tags: [],
      props: [],
      raw: {},
      logGroups: [],
      health: 'unknown',
      securityGroupIds: [],
      monthlyCostUsd: null,
      consoleUrl: null,
    })),
    edges: [],
    securityGroups: [],
    regions: [{ id: 'us-east-1', count: nodeIds.length }],
    missingPermissions: [],
    collectorFailures: [],
    scannedAt: 1,
    accountId: '111122223333',
    accountAlias: null,
    profile: 'p',
  }
}

function scan(id: string, profile: string, scannedAt: number): ScanRecord {
  return {
    id,
    profile,
    accountId: '111122223333',
    regions: ['us-east-1'],
    scannedAt,
    graph: graph([`i-${id}`]),
  }
}

const finding: Finding = {
  id: 'f1',
  nodeId: 'i-a',
  severity: 'critical',
  kind: 'metric-spike',
  title: 'spike',
  detail: 'detail',
  metric: 'CPUUtilization',
  startedAt: 1000,
  endedAt: null,
  evidence: ['a'],
  sparkline: [1, 2, 3],
  logGroups: [],
}

describe('SqliteDb', () => {
  let db: CloudAtlasDb

  beforeEach(() => {
    db = new SqliteDb(':memory:')
  })

  it('round-trips a scan including the full graph', () => {
    db.saveScan(scan('a', 'prod', 100))
    const loaded = db.getScan('a')
    expect(loaded?.graph.nodes.map((n) => n.id)).toEqual(['i-a'])
    expect(loaded?.regions).toEqual(['us-east-1'])
    expect(loaded?.accountId).toBe('111122223333')
  })

  it('returns the newest scan for a profile', () => {
    db.saveScan(scan('old', 'prod', 100))
    db.saveScan(scan('new', 'prod', 200))
    db.saveScan(scan('other', 'staging', 300))
    expect(db.latestScan('prod')?.id).toBe('new')
    expect(db.latestScan('staging')?.id).toBe('other')
  })

  it('returns null before the first scan', () => {
    expect(db.latestScan('prod')).toBeNull()
    expect(db.getScan('nope')).toBeNull()
  })

  it('replaces a scan saved under the same id', () => {
    db.saveScan(scan('a', 'prod', 100))
    db.saveScan({ ...scan('a', 'prod', 150), graph: graph(['i-x', 'i-y']) })
    expect(db.listScans('prod')).toHaveLength(1)
    expect(db.getScan('a')?.graph.nodes).toHaveLength(2)
  })

  it('lists scans newest first with node counts, without loading graphs', () => {
    db.saveScan(scan('a', 'prod', 100))
    db.saveScan(scan('b', 'prod', 200))
    const summaries = db.listScans('prod')
    expect(summaries.map((s) => s.id)).toEqual(['b', 'a'])
    expect(summaries[0]?.nodeCount).toBe(1)
  })

  it('prunes all but the newest N scans for a profile', () => {
    for (let i = 0; i < 5; i++) db.saveScan(scan(`s${i}`, 'prod', i * 100))
    db.saveScan(scan('keep-me', 'staging', 50))

    const deleted = db.pruneScans('prod', 2)
    expect(deleted).toBe(3)
    expect(db.listScans('prod').map((s) => s.id)).toEqual(['s4', 's3'])
    // Pruning one profile must not touch another.
    expect(db.listScans('staging')).toHaveLength(1)
  })

  it('round-trips findings and replaces them wholesale per scan', () => {
    db.saveFindings('a', [finding])
    expect(db.getFindings('a')).toEqual([finding])

    db.saveFindings('a', [{ ...finding, id: 'f2', title: 'other' }])
    const after = db.getFindings('a')
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe('f2')
  })

  it('scopes findings to their scan', () => {
    db.saveFindings('a', [finding])
    db.saveFindings('b', [{ ...finding, id: 'f9' }])
    expect(db.getFindings('a').map((f) => f.id)).toEqual(['f1'])
    expect(db.getFindings('b').map((f) => f.id)).toEqual(['f9'])
  })

  it('round-trips agent sessions and lists them newest first', () => {
    db.saveAgentSession({
      id: 's1',
      profile: 'prod',
      title: 'Why is pg spiking?',
      createdAt: 1,
      updatedAt: 10,
      messages: [{ role: 'user', content: 'hi' }],
    })
    db.saveAgentSession({
      id: 's2',
      profile: 'prod',
      title: null,
      createdAt: 2,
      updatedAt: 20,
      messages: [],
    })

    expect(db.listAgentSessions('prod').map((s) => s.id)).toEqual(['s2', 's1'])
    expect(db.getAgentSession('s1')?.messages).toEqual([{ role: 'user', content: 'hi' }])

    db.deleteAgentSession('s1')
    expect(db.getAgentSession('s1')).toBeNull()
  })
})
