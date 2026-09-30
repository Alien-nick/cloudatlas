import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Graph, SimChange, Simulation } from '@cloudatlas/shared'
import { evaluateCompliance } from '../compliance/evaluate.js'
import { DemoProvider } from '../providers/demo/index.js'
import { scopeGraph } from './scope.js'
import { applySimulation, settingsOf } from './apply.js'
import { exportCli, exportTerraform } from './export.js'
import { simulationImpact } from './impact.js'
import { MemorySimulationStore, SqliteSimulationStore } from './store.js'

const PROD_VPC = 'vpc-0a91c2'
const PUBLIC_SUBNET = 'subnet-0a12'
const PRIVATE_SUBNET = 'subnet-0c11'

let provider: DemoProvider
let base: Graph

beforeAll(async () => {
  provider = new DemoProvider()
  base = await provider.scan({ profile: 'cortex-prod', regions: ['us-east-1', 'us-west-2', 'eu-west-1'] })
})

function simulate(changes: SimChange[]): Simulation {
  return {
    id: 'test',
    name: 'Test',
    accountId: base.accountId,
    profile: base.profile,
    createdAt: 0,
    updatedAt: 0,
    baseScannedAt: base.scannedAt,
    scope: null,
    changes,
  }
}

const jumpBox: SimChange = {
  op: 'add',
  resource: {
    id: 'sim-jump',
    type: 'ec2',
    name: 'jump-box',
    region: 'us-east-1',
    vpcId: PROD_VPC,
    subnetId: PUBLIC_SUBNET,
    settings: { instanceType: 't3.large', publicIp: true, openPorts: '22', imdsv2: false },
  },
}
const toPrimary: SimChange = { op: 'connect', id: 'c1', source: 'sim-jump', target: 'rds-primary', port: 5432 }

describe('applying a simulation', () => {
  it('writes new resources in the scan’s own vocabulary, so compliance reads them', () => {
    const db: SimChange = {
      op: 'add',
      resource: {
        id: 'sim-db',
        type: 'rds',
        name: 'orders-db',
        region: 'us-east-1',
        vpcId: PROD_VPC,
        subnetId: PRIVATE_SUBNET,
        settings: { publiclyAccessible: true, encrypted: false },
      },
    }
    const simulated = applySimulation(base, simulate([db]))
    const failing = evaluateCompliance(simulated.graph)
      .results.filter((result) => result.nodeId === 'sim-db' && result.status === 'fail')
      .map((result) => result.checkId)
    expect(failing).toEqual(expect.arrayContaining(['rds-not-public', 'rds-encrypted']))
    expect(simulated.status['sim-db']).toBe('added')
    expect(simulated.graph.nodes.find((node) => node.id === 'sim-db')?.parentId).toBe(PRIVATE_SUBNET)
  })

  it('never changes the snapshot it was given', () => {
    const before = JSON.stringify(base)
    applySimulation(base, simulate([jumpBox, toPrimary, { op: 'remove', nodeId: PROD_VPC }]))
    expect(JSON.stringify(base)).toBe(before)
  })

  it('turns a connection into a rule on the target’s security group', () => {
    const simulated = applySimulation(base, simulate([jumpBox, toPrimary]))
    const primarySg = base.nodes.find((node) => node.id === 'rds-primary')!.securityGroupIds[0]
    const rule = simulated.graph.securityGroups
      .find((sg) => sg.id === primarySg)!
      .rules.find((candidate) => candidate.source === 'sg-sim-jump')
    expect(rule).toMatchObject({ direction: 'in', port: '5432' })
    expect(simulated.status['rds-primary']).toBe('changed')
  })

  it('adds the internet node when a change opens a sensitive port', () => {
    const simulated = applySimulation(base, simulate([jumpBox]))
    expect(simulated.graph.edges.some((edge) => edge.kind === 'risk' && edge.target === 'sim-jump')).toBe(true)
    expect(simulated.graph.nodes.some((node) => node.id === 'internet')).toBe(true)
  })

  it('keeps web ACL associations when it recomputes security edges', () => {
    const wafEdges = (graph: Graph) => graph.edges.filter((edge) => edge.meta.via === 'web ACL association').length
    expect(wafEdges(applySimulation(base, simulate([jumpBox])).graph)).toBe(wafEdges(base))
  })

  it('removes a container with everything in it', () => {
    const simulated = applySimulation(base, simulate([{ op: 'remove', nodeId: PROD_VPC }]))
    expect(simulated.graph.nodes.some((node) => node.vpcId === PROD_VPC)).toBe(false)
    expect(simulated.removed.map((entry) => entry.id)).toContain('rds-primary')
  })

  it('edits an existing resource and reads its settings back', () => {
    const primary = base.nodes.find((node) => node.id === 'rds-primary')!
    expect(settingsOf(primary, base)).toMatchObject({ engine: 'postgres', multiAz: true, backupDays: 35 })
    const simulated = applySimulation(base, simulate([{ op: 'update', nodeId: 'rds-primary', settings: { multiAz: false } }]))
    expect(simulated.settings['rds-primary']).toMatchObject({ multiAz: false })
    expect(simulated.status['rds-primary']).toBe('changed')
  })

  it('reports changes that no longer apply instead of failing', () => {
    const simulated = applySimulation(base, simulate([{ op: 'update', nodeId: 'gone', settings: {} }, { op: 'connect', id: 'x', source: 'a', target: 'b', port: 1 }]))
    expect(simulated.problems).toHaveLength(2)
  })
})

describe('impact', () => {
  async function impactOf(changes: SimChange[]) {
    const simulated = applySimulation(base, simulate(changes))
    const [before, after] = await provider.estimateRunRates([base, simulated.graph])
    return simulationImpact(base, simulated, [before!, after!])
  }

  it('reports a new internet route to a resource that was already reachable', async () => {
    const impact = await impactOf([jumpBox, toPrimary])
    const route = impact.exposure.newlyReachable.find((entry) => entry.nodeId === 'rds-primary')
    expect(route?.path).toEqual(['sim-jump', 'rds-primary'])
    // The replica behind it is a new route too, through replication.
    expect(impact.exposure.newlyReachable.find((entry) => entry.nodeId === 'dr-rds')?.path).toEqual(['sim-jump', 'rds-primary', 'dr-rds'])
    // Existing resources lead the list; the new jump box itself comes after.
    expect(impact.exposure.newlyReachable[0]?.nodeId.startsWith('sim-')).toBe(false)
    expect(impact.exposure.newlyReachable.at(-1)?.nodeId).toBe('sim-jump')
  })

  it('prices what is added, and leaves out changes that do not move the cost', async () => {
    const impact = await impactOf([jumpBox, toPrimary])
    expect(impact.cost.lines.map((line) => line.nodeId)).toEqual(['sim-jump'])
    expect(impact.cost.after).toBeGreaterThan(impact.cost.before)
  })

  it('names the controls a change breaks and the ones it fixes', async () => {
    const impact = await impactOf([jumpBox, { op: 'remove', nodeId: 'ec2-legacy' }])
    const hipaa = impact.compliance.find((entry) => entry.framework === 'hipaa')!
    expect(hipaa.newGaps.map((gap) => `${gap.checkId}@${gap.nodeId}`)).toContain('sg-no-world-admin-ports@sim-jump')
    expect(hipaa.fixed.map((gap) => `${gap.checkId}@${gap.nodeId}`)).toContain('sg-no-world-admin-ports@ec2-legacy')
  })
})

describe('exports', () => {
  const simulated = () => applySimulation(base, simulate([jumpBox, toPrimary, { op: 'remove', nodeId: 'ec2-legacy' }]))

  it('writes a script that captures new ids and opens exactly the connection', () => {
    const { text } = exportCli(base, simulated())
    const primarySg = base.nodes.find((node) => node.id === 'rds-primary')!.securityGroupIds[0]
    expect(text).toContain('JUMP_BOX_SG=$(aws ec2 create-security-group')
    expect(text).toContain(`--group-id ${primarySg} --protocol tcp --port 5432 --source-group "$JUMP_BOX_SG"`)
    expect(text.startsWith('#!/usr/bin/env bash')).toBe(true)
  })

  it('comments out deletions, so they cannot run with the rest', () => {
    const { text } = exportCli(base, simulated())
    const terminate = text.split('\n').find((line) => line.includes('terminate-instances'))
    expect(terminate?.startsWith('# aws ec2 terminate-instances')).toBe(true)
  })

  it('never writes a database password', () => {
    const db: SimChange = {
      op: 'add',
      resource: { id: 'sim-db', type: 'rds', name: 'orders-db', region: 'us-east-1', vpcId: PROD_VPC, subnetId: PRIVATE_SUBNET, settings: {} },
    }
    const withDb = applySimulation(base, simulate([db]))
    const cli = exportCli(base, withDb).text
    const tf = exportTerraform(base, withDb).text
    expect(cli).toContain('--manage-master-user-password')
    expect(tf).toContain('manage_master_user_password = true')
    // The safe flag is --manage-master-user-password; a literal password never appears.
    expect(cli).not.toMatch(/--master-user-password\s/)
    expect(tf).not.toMatch(/\bpassword\s*=\s*"/)
  })

  it('writes Terraform that references new resources and literal ids for existing ones', () => {
    const { text } = exportTerraform(base, simulated())
    expect(text).toContain('resource "aws_instance" "jump_box"')
    expect(text).toContain('vpc_security_group_ids = [aws_security_group.jump_box_sg.id]')
    expect(text).toContain('referenced_security_group_id = aws_security_group.jump_box_sg.id')
  })
})

describe('the store', () => {
  let dir: string
  beforeAll(() => (dir = mkdtempSync(join(tmpdir(), 'cloudatlas-sim-'))))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  for (const [label, make] of [
    ['memory', () => new MemorySimulationStore()],
    ['sqlite', () => new SqliteSimulationStore(join(dir, `${Math.random()}.sqlite`))],
  ] as const) {
    it(`${label}: keeps the snapshot and changes, lists by account, and rebases without losing changes`, () => {
      const store = make()
      const created = store.create('Plan', base, 10)
      store.update(created.id, { changes: [jumpBox] }, 20)
      expect(store.list(base.accountId).map((entry) => [entry.name, entry.changeCount])).toEqual([['Plan', 1]])
      expect(store.list('someone-else')).toEqual([])

      const newer = { ...base, scannedAt: base.scannedAt + 1000 }
      store.rebase(created.id, newer, 30)
      const loaded = store.get(created.id)!
      expect(loaded.simulation.changes).toEqual([jumpBox])
      expect(loaded.simulation.baseScannedAt).toBe(newer.scannedAt)
      expect(loaded.base.nodes.length).toBe(base.nodes.length)

      expect(store.remove(created.id)).toBe(true)
      expect(store.get(created.id)).toBeNull()
    })
  }
})

describe('scopeGraph', () => {
  it('keeps the chosen VPC whole, with its region, and nothing from other VPCs', () => {
    const vpc = base.nodes.find((node) => node.type === 'vpc')!
    const scoped = scopeGraph(base, { vpcIds: [vpc.id], includeOutside: false })
    const inVpc = base.nodes.filter((node) => node.vpcId === vpc.id)
    expect(inVpc.every((node) => scoped.nodes.some((kept) => kept.id === node.id))).toBe(true)
    expect(scoped.nodes.some((node) => node.vpcId && node.vpcId !== vpc.id)).toBe(false)
    expect(scoped.nodes.some((node) => node.id === vpc.parentId)).toBe(true)
    const ids = new Set(scoped.nodes.map((node) => node.id))
    expect(scoped.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true)
    // Still a valid base: the simulation engine runs over it.
    expect(() => applySimulation(scoped, { ...simulate([]), scope: { vpcIds: [vpc.id], includeOutside: false } })).not.toThrow()
  })

  it('adds resources outside any VPC only when asked', () => {
    const vpc = base.nodes.find((node) => node.type === 'vpc')!
    const outside = base.nodes.find((node) => node.type === 's3')!
    expect(scopeGraph(base, { vpcIds: [vpc.id], includeOutside: false }).nodes.some((n) => n.id === outside.id)).toBe(false)
    expect(scopeGraph(base, { vpcIds: [vpc.id], includeOutside: true }).nodes.some((n) => n.id === outside.id)).toBe(true)
  })
})
