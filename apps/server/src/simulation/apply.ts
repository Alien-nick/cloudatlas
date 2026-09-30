import {
  INTERNET_NODE_ID,
  catalogEntry,
  defaultSettings,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type PropEntry,
  type SecurityGroup,
  type SettingValue,
  type SimResource,
  type Simulated,
  type Simulation,
} from '@cloudatlas/shared'
import { fact } from '../aws/cli-command.js'
import { attachedVolumes, engine, environment, fargateSize, instanceType, lambdaArchitecture, rdsStorage } from '../cost/facts.js'
import { laneId, node as makeNode, prop, props, regionId, azId } from '../graph/helpers.js'
import { POSTURE_FACTS } from '../graph/posture-facts.js'
import { analyzeSecurityGroups } from '../graph/sg-risk.js'
import { internetNode } from '../scan/run.js'

/**
 * Replaying a simulation's changes onto its snapshot.
 *
 * The output is an ordinary `Graph`. New resources are written with the same
 * props a real scan writes — the posture-facts vocabulary — so compliance,
 * cost and security analysis read them exactly as they read a scanned
 * resource. A connection becomes a security-group rule on the target, the same
 * rule the exports will create, and the security layer is then recomputed by
 * the existing analysis rather than special-cased here.
 */

type Settings = Record<string, SettingValue>

const TYPE_META: Record<SimResource['type'], { category: GraphNode['category']; abbr: string; typeLabel: string }> = {
  vpc: { category: 'network', abbr: 'V', typeLabel: 'VPC' },
  subnet: { category: 'network', abbr: 'SN', typeLabel: 'Subnet' },
  ec2: { category: 'compute', abbr: 'EC2', typeLabel: 'EC2 instance' },
  rds: { category: 'database', abbr: 'RDS', typeLabel: 'RDS instance' },
  elasticache: { category: 'database', abbr: 'EC$', typeLabel: 'ElastiCache Redis node' },
  alb: { category: 'network', abbr: 'ALB', typeLabel: 'Application Load Balancer' },
  'nat-gateway': { category: 'network', abbr: 'NAT', typeLabel: 'NAT Gateway' },
  'ecs-task': { category: 'compute', abbr: 'ECS', typeLabel: 'ECS Fargate task' },
  lambda: { category: 'compute', abbr: 'λ', typeLabel: 'Lambda function' },
  s3: { category: 'storage', abbr: 'S3', typeLabel: 'S3 bucket' },
  sqs: { category: 'integration', abbr: 'SQS', typeLabel: 'SQS queue' },
}

const ENGINE_VERSION: Record<string, string> = { postgres: '16.4', mysql: '8.0.39', mariadb: '10.11.9' }
const LOG_TYPES: Record<string, string> = { postgres: 'postgresql', mysql: 'error, general, slowquery', mariadb: 'error, general, slowquery' }

const bool = (value: SettingValue | undefined): boolean => value === true || value === 'true'
const num = (value: SettingValue | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const str = (value: SettingValue | undefined, fallback = ''): string => (value === undefined ? fallback : String(value))

export function openPorts(settings: Settings): number[] {
  return str(settings.openPorts)
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
}

/** The simulated security group of an added resource. */
export const simSgId = (resourceId: string): string => `sg-${resourceId}`

/** Props for a resource of a catalog type, in the scan's own vocabulary. */
function propsFor(type: SimResource['type'], s: Settings, id: string): Array<PropEntry | null> {
  switch (type) {
    case 'vpc':
      return [
        prop('CIDR', str(s.cidr)),
        prop(POSTURE_FACTS.flowLogs.key, bool(s.flowLogs) ? `cloud-watch-logs:/aws/vpc/flowlogs/${id}` : POSTURE_FACTS.flowLogs.absent),
        prop(POSTURE_FACTS.defaultVpc.key, POSTURE_FACTS.defaultVpc.no),
      ]
    case 'subnet':
      return [
        prop('CIDR', str(s.cidr)),
        prop('Route to internet', bool(s.public) ? '0.0.0.0/0 → internet gateway' : 'via NAT or none'),
        prop(
          POSTURE_FACTS.autoPublicIp.key,
          bool(s.autoPublicIp) ? POSTURE_FACTS.autoPublicIp.enabled : POSTURE_FACTS.autoPublicIp.disabled,
        ),
      ]
    case 'ec2': {
      const encrypted = bool(s.encrypted)
      return [
        prop('Instance ID', id),
        prop('Instance type', str(s.instanceType)),
        prop(POSTURE_FACTS.publicIpv4.key, bool(s.publicIp) ? 'assigned at launch' : POSTURE_FACTS.publicIpv4.none),
        prop(POSTURE_FACTS.imds.key, bool(s.imdsv2) ? POSTURE_FACTS.imds.v2Required : POSTURE_FACTS.imds.v1Allowed),
        prop('EBS', `vol-${id.replace(/^sim-/, 'sim')} ${num(s.volumeGiB, 30)} GiB ${str(s.volumeType, 'gp3')}`),
        prop(
          POSTURE_FACTS.ebsEncryption.key,
          encrypted ? POSTURE_FACTS.ebsEncryption.allEncrypted : POSTURE_FACTS.ebsEncryption.unencrypted(1, 1),
        ),
      ]
    }
    case 'rds': {
      const engineName = str(s.engine, 'postgres')
      const days = num(s.backupDays, 7)
      return [
        prop('Engine', `${engineName} ${ENGINE_VERSION[engineName] ?? ''}`.trim()),
        prop('Instance class', str(s.instanceClass)),
        prop('Storage', `${num(s.storageGiB, 100)} GiB ${str(s.storageType, 'gp3')}`),
        prop(POSTURE_FACTS.multiAz.key, bool(s.multiAz) ? POSTURE_FACTS.multiAz.enabledPrefix : POSTURE_FACTS.multiAz.disabled),
        prop(POSTURE_FACTS.storageEncryption.key, bool(s.encrypted) ? 'KMS aws/rds' : POSTURE_FACTS.storageEncryption.absent),
        prop(
          POSTURE_FACTS.publiclyAccessible.key,
          bool(s.publiclyAccessible) ? POSTURE_FACTS.publiclyAccessible.yes : POSTURE_FACTS.publiclyAccessible.no,
        ),
        prop(
          POSTURE_FACTS.backupRetention.key,
          days > 0 ? POSTURE_FACTS.backupRetention.days(days) : POSTURE_FACTS.backupRetention.disabled,
        ),
        prop(
          POSTURE_FACTS.deletionProtection.key,
          bool(s.deletionProtection) ? POSTURE_FACTS.deletionProtection.on : POSTURE_FACTS.deletionProtection.off,
        ),
        prop(POSTURE_FACTS.logExports.key, bool(s.logExports) ? (LOG_TYPES[engineName] ?? 'error') : POSTURE_FACTS.logExports.none),
      ]
    }
    case 'elasticache':
      return [
        prop('Engine', 'redis 7.1'),
        prop('Node type', str(s.nodeType)),
        prop('Nodes', num(s.nodes, 1)),
        prop('Replication group', id),
        prop(
          POSTURE_FACTS.cacheEncryptionAtRest.key,
          bool(s.encryptionAtRest) ? POSTURE_FACTS.cacheEncryptionAtRest.enabled : POSTURE_FACTS.cacheEncryptionAtRest.disabled,
        ),
        prop(
          POSTURE_FACTS.cacheEncryptionInTransit.key,
          bool(s.encryptionInTransit)
            ? POSTURE_FACTS.cacheEncryptionInTransit.enabled
            : POSTURE_FACTS.cacheEncryptionInTransit.disabled,
        ),
      ]
    case 'alb':
      return [
        prop(POSTURE_FACTS.loadBalancerScheme.key, str(s.scheme, 'internet-facing')),
        prop('Listeners', bool(s.httpsOnly) ? 'HTTPS:443, HTTP:80 → redirect' : 'HTTP:80'),
        prop(POSTURE_FACTS.plaintextListeners.key, bool(s.httpsOnly) ? POSTURE_FACTS.plaintextListeners.none : 'HTTP:80'),
      ]
    case 'nat-gateway':
      return [prop('Connectivity', 'public')]
    case 'ecs-task': {
      const vcpu = num(s.vcpu, 0.5)
      const memory = num(s.memoryGB, 1)
      return [prop('Launch type', 'FARGATE'), prop('CPU / memory', `${Math.round(vcpu * 1024)} / ${Math.round(memory * 1024)}`)]
    }
    case 'lambda':
      return [
        prop('Runtime', str(s.runtime, 'python3.12')),
        prop('Architecture', str(s.architecture, 'arm64')),
        prop('Memory', `${num(s.memoryMB, 512)} MB`),
      ]
    case 's3':
      return [
        prop(POSTURE_FACTS.storageEncryption.key, str(s.encryption, 'aws:kms')),
        prop(
          POSTURE_FACTS.s3PublicAccess.key,
          bool(s.blockPublic) ? POSTURE_FACTS.s3PublicAccess.blocked : POSTURE_FACTS.s3PublicAccess.notBlocked,
        ),
      ]
    case 'sqs':
      return [prop(POSTURE_FACTS.storageEncryption.key, bool(s.encrypted) ? 'SSE-SQS' : POSTURE_FACTS.storageEncryption.absent)]
  }
}

/**
 * Settings read back off an existing resource, so the editor starts from what
 * is there. Only types in the catalog are editable; anything unread falls back
 * to the catalog default.
 */
export function settingsOf(node: GraphNode, graph: Graph): Settings | null {
  const type = node.type as SimResource['type']
  const entry = catalogEntry(type)
  if (!entry) return null
  const s: Settings = { ...defaultSettings(type) }
  const env = environment(node)
  if (env !== 'unknown') s.environment = env === 'prod' ? 'prod' : (node.tags.find((t) => /^(env|environment|stage)$/i.test(t.key))?.value ?? 'dev')

  switch (type) {
    case 'vpc':
      if (node.cidr) s.cidr = node.cidr
      s.flowLogs = fact(node, POSTURE_FACTS.flowLogs.key) !== POSTURE_FACTS.flowLogs.absent
      break
    case 'subnet':
      if (node.cidr) s.cidr = node.cidr
      s.public = node.isPublic === true
      s.autoPublicIp = fact(node, POSTURE_FACTS.autoPublicIp.key) === POSTURE_FACTS.autoPublicIp.enabled
      if (node.az) s.az = node.az.slice(-1)
      break
    case 'ec2': {
      const volume = attachedVolumes(node)[0]
      s.instanceType = instanceType(node) ?? s.instanceType!
      if (volume) {
        s.volumeGiB = volume.sizeGiB
        s.volumeType = volume.type
      }
      s.encrypted = fact(node, POSTURE_FACTS.ebsEncryption.key) !== undefined
        ? fact(node, POSTURE_FACTS.ebsEncryption.key) === POSTURE_FACTS.ebsEncryption.allEncrypted
        : s.encrypted!
      s.imdsv2 = fact(node, POSTURE_FACTS.imds.key) !== POSTURE_FACTS.imds.v1Allowed
      s.publicIp = !(fact(node, POSTURE_FACTS.publicIpv4.key) ?? '—').startsWith('—')
      break
    }
    case 'rds': {
      const name = (engine(node) ?? '').toLowerCase()
      s.engine = name.includes('maria') ? 'mariadb' : name.includes('mysql') ? 'mysql' : 'postgres'
      s.instanceClass = instanceType(node) ?? s.instanceClass!
      const disk = rdsStorage(node)
      if (disk) {
        s.storageGiB = disk.sizeGiB
        s.storageType = disk.type
      }
      s.multiAz = (fact(node, POSTURE_FACTS.multiAz.key) ?? '').toLowerCase().startsWith('enabled')
      s.encrypted = fact(node, POSTURE_FACTS.storageEncryption.key) !== POSTURE_FACTS.storageEncryption.absent
      s.publiclyAccessible = fact(node, POSTURE_FACTS.publiclyAccessible.key) === POSTURE_FACTS.publiclyAccessible.yes
      const days = /(\d+)/.exec(fact(node, POSTURE_FACTS.backupRetention.key) ?? '')?.[1]
      if (fact(node, POSTURE_FACTS.backupRetention.key) !== undefined) s.backupDays = days ? Number(days) : 0
      if (fact(node, POSTURE_FACTS.deletionProtection.key) !== undefined) {
        s.deletionProtection = fact(node, POSTURE_FACTS.deletionProtection.key) === POSTURE_FACTS.deletionProtection.on
      }
      s.logExports = (fact(node, POSTURE_FACTS.logExports.key) ?? POSTURE_FACTS.logExports.none) !== POSTURE_FACTS.logExports.none
      break
    }
    case 'elasticache':
      s.nodeType = instanceType(node) ?? s.nodeType!
      s.nodes = num(fact(node, 'Nodes'), 1)
      s.encryptionAtRest = fact(node, POSTURE_FACTS.cacheEncryptionAtRest.key) !== POSTURE_FACTS.cacheEncryptionAtRest.disabled
      s.encryptionInTransit =
        fact(node, POSTURE_FACTS.cacheEncryptionInTransit.key) !== POSTURE_FACTS.cacheEncryptionInTransit.disabled
      break
    case 'alb':
      s.scheme = fact(node, POSTURE_FACTS.loadBalancerScheme.key) ?? s.scheme!
      s.httpsOnly = (fact(node, POSTURE_FACTS.plaintextListeners.key) ?? POSTURE_FACTS.plaintextListeners.none) === POSTURE_FACTS.plaintextListeners.none
      s.waf = graph.edges.some(
        (edge) => edge.target === node.id && graph.nodes.find((n) => n.id === edge.source)?.type === 'waf-web-acl',
      )
      break
    case 'ecs-task': {
      const size = fargateSize(node)
      if (size) {
        s.vcpu = String(size.vcpu)
        s.memoryGB = size.gb
      }
      break
    }
    case 'lambda':
      s.architecture = lambdaArchitecture(node) ?? s.architecture!
      s.runtime = (fact(node, 'Runtime') ?? str(s.runtime)).split(/[\s·]+/)[0] ?? s.runtime!
      break
    case 's3':
      s.blockPublic = fact(node, POSTURE_FACTS.s3PublicAccess.key) === POSTURE_FACTS.s3PublicAccess.blocked
      break
    case 'sqs':
      s.encrypted = fact(node, POSTURE_FACTS.storageEncryption.key) !== POSTURE_FACTS.storageEncryption.absent
      break
  }
  return s
}

/** Replace props by key and append new ones, keeping the rest in order. */
function mergeProps(existing: PropEntry[], updates: PropEntry[]): PropEntry[] {
  const byKey = new Map(updates.map((entry) => [entry.k, entry]))
  const merged = existing.map((entry) => byKey.get(entry.k) ?? entry)
  const seen = new Set(existing.map((entry) => entry.k))
  return [...merged, ...updates.filter((entry) => !seen.has(entry.k))]
}

function withEnvironment(tags: GraphNode['tags'], settings: Settings): GraphNode['tags'] {
  if (settings.environment === undefined) return tags
  const rest = tags.filter((tag) => !/^(env|environment)$/i.test(tag.key))
  return [...rest, { key: 'Environment', value: String(settings.environment) }]
}

// ---------------------------------------------------------------------------

export interface ApplyContext {
  now: number
}

export function applySimulation(base: Graph, simulation: Simulation, context: ApplyContext = { now: Date.now() }): Simulated {
  const graph: Graph = structuredClone(base)
  const status: Simulated['status'] = {}
  const settings: Simulated['settings'] = {}
  const removed: Simulated['removed'] = []
  const problems: string[] = []
  const byId = (): Map<string, GraphNode> => new Map(graph.nodes.map((n) => [n.id, n]))
  const added = new Map<string, Settings>()
  /** Settings as they stand after this change log, for added and edited resources. */
  const applied = new Map<string, Settings>()

  const ensureContainer = (candidate: GraphNode): void => {
    if (!graph.nodes.some((n) => n.id === candidate.id)) graph.nodes.push(candidate)
  }
  const regionNode = (region: string): string => {
    ensureContainer(makeNode({ id: regionId(region), type: 'region', category: 'network', name: `Region · ${region}`, abbr: 'R', typeLabel: 'AWS Region', region, parentId: null, state: 'active', raw: {} }))
    return regionId(region)
  }
  const laneNode = (region: string): string => {
    ensureContainer(makeNode({ id: laneId(region), type: 'lane', category: 'network', name: 'Regional services', abbr: 'G', typeLabel: 'Service lane', region, parentId: regionNode(region), state: 'active', raw: {} }))
    return laneId(region)
  }

  for (const change of simulation.changes) {
    const nodes = byId()
    switch (change.op) {
      case 'add': {
        const resource = change.resource
        if (nodes.has(resource.id)) {
          problems.push(`${resource.name}: a resource with id ${resource.id} already exists`)
          break
        }
        const entry = catalogEntry(resource.type)!
        const s = { ...defaultSettings(resource.type), ...resource.settings }
        const vpc = resource.vpcId ? nodes.get(resource.vpcId) : undefined
        const subnet = resource.subnetId ? nodes.get(resource.subnetId) : undefined
        if (entry.placement !== 'region' && !vpc) {
          problems.push(`${resource.name}: its VPC is not in the simulation`)
          break
        }
        if (entry.placement === 'subnet' && !subnet) {
          problems.push(`${resource.name}: its subnet is not in the simulation`)
          break
        }

        let parentId: string
        let az: string | null = null
        let cidr: string | undefined
        let isPublic: boolean | undefined
        if (resource.type === 'vpc') {
          parentId = regionNode(resource.region)
          cidr = str(s.cidr)
        } else if (resource.type === 'subnet') {
          az = `${resource.region}${str(s.az, 'a')}`
          const azNodeId = azId(resource.vpcId!, az)
          ensureContainer(makeNode({ id: azNodeId, type: 'az', category: 'network', name: `AZ ${az}`, abbr: 'AZ', typeLabel: 'Availability Zone', region: resource.region, az, vpcId: resource.vpcId, parentId: resource.vpcId, state: 'available', raw: {} }))
          parentId = azNodeId
          cidr = str(s.cidr)
          isPublic = bool(s.public)
        } else if (entry.placement === 'subnet') {
          parentId = subnet!.id
          az = subnet!.az
        } else {
          parentId = laneNode(resource.region)
        }

        const meta = TYPE_META[resource.type]
        const hasSg = ['ec2', 'rds', 'elasticache', 'alb', 'ecs-task'].includes(resource.type)
        graph.nodes.push({
          ...makeNode({
            id: resource.id,
            type: resource.type,
            category: meta.category,
            name: resource.name,
            abbr: meta.abbr,
            subtitle: 'planned',
            typeLabel: meta.typeLabel,
            region: resource.region,
            az,
            vpcId: resource.type === 'vpc' ? resource.id : resource.vpcId,
            subnetId: resource.type === 'subnet' ? resource.id : (resource.subnetId ?? null),
            parentId,
            state: 'planned',
            tags: withEnvironment([{ key: 'Name', value: resource.name }], s),
            props: props(propsFor(resource.type, s, resource.id)),
            raw: { simulated: true, resource },
            cidr,
            isPublic,
            securityGroupIds: hasSg ? [simSgId(resource.id)] : [],
          }),
        })
        if (hasSg) {
          const rules: SecurityGroup['rules'] = [
            { direction: 'out', protocol: '-1', port: 'all', fromPort: null, toPort: null, source: '0.0.0.0/0' },
          ]
          const world = resource.type === 'alb' && s.scheme === 'internet-facing' ? [443, 80] : openPorts(s)
          for (const port of world) {
            rules.push({ direction: 'in', protocol: 'tcp', port: String(port), fromPort: port, toPort: port, source: '0.0.0.0/0' })
          }
          graph.securityGroups.push({ id: simSgId(resource.id), name: `${resource.name}-sg`, vpcId: resource.vpcId, rules })
        }
        status[resource.id] = 'added'
        added.set(resource.id, s)
        applied.set(resource.id, s)
        break
      }
      case 'update': {
        const target = nodes.get(change.nodeId)
        if (!target) {
          problems.push(`An edit refers to ${change.nodeId}, which is not in the simulation`)
          break
        }
        const current = applied.get(target.id) ?? settingsOf(target, graph)
        if (!current) {
          problems.push(`${target.name} is not a type the simulator can edit`)
          break
        }
        const next = { ...current, ...change.settings }
        target.props = mergeProps(target.props, props(propsFor(target.type as SimResource['type'], next, target.id)))
        target.tags = withEnvironment(target.tags, next)
        if (target.type === 'subnet') target.isPublic = bool(next.public)
        applied.set(target.id, next)
        if (added.has(target.id)) added.set(target.id, next)
        else status[target.id] = 'changed'
        break
      }
      case 'remove': {
        const target = nodes.get(change.nodeId)
        if (!target) {
          problems.push(`A removal refers to ${change.nodeId}, which is not in the simulation`)
          break
        }
        // A container takes everything inside it.
        const doomed = new Set([target.id])
        let grew = true
        while (grew) {
          grew = false
          for (const candidate of graph.nodes) {
            if (candidate.parentId && doomed.has(candidate.parentId) && !doomed.has(candidate.id)) {
              doomed.add(candidate.id)
              grew = true
            }
          }
        }
        for (const id of doomed) {
          const gone = nodes.get(id)
          if (gone && !added.has(id) && !gone.id.includes('::')) removed.push({ id, name: gone.name, typeLabel: gone.typeLabel })
          delete status[id]
          added.delete(id)
          applied.delete(id)
        }
        graph.nodes = graph.nodes.filter((candidate) => !doomed.has(candidate.id))
        graph.edges = graph.edges.filter((edge) => !doomed.has(edge.source) && !doomed.has(edge.target))
        break
      }
      case 'connect': {
        const source = nodes.get(change.source)
        const target = nodes.get(change.target)
        if (!source || !target) {
          problems.push('A connection refers to a resource that is not in the simulation')
          break
        }
        graph.edges.push({
          id: `sim-conn:${change.id}`,
          source: source.id,
          target: target.id,
          kind: 'traffic',
          label: change.port === null ? 'access' : String(change.port),
          meta: { via: 'simulated connection', connectionId: change.id },
        })
        // The rule that makes the connection real: the target's first group
        // admits the source's first group on the port.
        const targetSgId = target.securityGroupIds[0]
        const sourceSgId = source.securityGroupIds[0]
        if (change.port !== null && targetSgId && sourceSgId) {
          const sg = graph.securityGroups.find((candidate) => candidate.id === targetSgId)
          if (sg) {
            sg.rules = [
              ...sg.rules,
              { direction: 'in', protocol: 'tcp', port: String(change.port), fromPort: change.port, toPort: change.port, source: sourceSgId, description: 'simulated connection' },
            ]
            if (!status[target.id]) status[target.id] = 'changed'
          }
        }
        break
      }
      case 'disconnect': {
        const edge = graph.edges.find((candidate) => candidate.meta.connectionId === change.connectionId)
        if (!edge) {
          problems.push('A disconnection refers to a connection that is not in the simulation')
          break
        }
        graph.edges = graph.edges.filter((candidate) => candidate !== edge)
        break
      }
    }
  }

  finishLoadBalancers(graph, applied, added)
  recomputeSecurity(graph, context.now)

  for (const candidate of graph.nodes) {
    const s = applied.get(candidate.id) ?? settingsOf(candidate, graph)
    if (s) settings[candidate.id] = s
  }
  graph.scannedAt = base.scannedAt
  return { simulation, graph, status, removed, settings, problems }
}

/** WAF attachments and target counts, which depend on everything else being in place. */
function finishLoadBalancers(graph: Graph, applied: Map<string, Settings>, added: Map<string, Settings>): void {
  for (const lb of graph.nodes.filter((candidate) => candidate.type === 'alb')) {
    // Only resources this change log touched ask for a WAF; untouched ones keep what they have.
    const settings = applied.get(lb.id)
    const wantsWaf = settings ? bool(settings.waf) : false
    const hasWaf = graph.edges.some(
      (edge) => edge.target === lb.id && graph.nodes.find((n) => n.id === edge.source)?.type === 'waf-web-acl',
    )
    if (wantsWaf && !hasWaf) {
      const wafId = `${lb.id}::waf`
      graph.nodes.push(
        makeNode({
          id: wafId,
          type: 'waf-web-acl',
          category: 'security',
          name: `${lb.name}-waf`,
          abbr: 'WAF',
          subtitle: 'planned',
          typeLabel: 'WAF v2 web ACL',
          region: lb.region,
          parentId: graph.nodes.some((n) => n.id === laneId(lb.region)) ? laneId(lb.region) : regionId(lb.region),
          state: 'planned',
          raw: { simulated: true },
          props: props([prop('Scope', 'REGIONAL'), prop(POSTURE_FACTS.wafLogging.key, `cloudwatch:aws-waf-logs-${lb.name}`)]),
        }),
      )
      graph.edges.push({ id: `sg:${wafId}->${lb.id}`, source: wafId, target: lb.id, kind: 'sg', meta: { via: 'web ACL association' } })
    }
    // Targets for a simulated load balancer are its simulated connections.
    if (added.has(lb.id)) {
      const targets = graph.edges.filter((edge) => edge.source === lb.id && edge.meta.via === 'simulated connection').length
      lb.props = mergeProps(lb.props, props([prop('Registered targets', targets)]))
    }
  }
}

/**
 * Security-group relationships and internet exposure, recomputed from the
 * simulated groups. Edges the analysis derived for the snapshot are dropped
 * first — but only those: WAF associations share the `sg` kind and stay.
 */
function recomputeSecurity(graph: Graph, now: number): void {
  const derived = (edge: GraphEdge): boolean => edge.kind === 'risk' || (edge.kind === 'sg' && edge.meta.securityGroupId !== undefined)
  const analysis = analyzeSecurityGroups(graph.securityGroups, graph.nodes, now)
  graph.securityGroups = analysis.securityGroups
  graph.edges = [...graph.edges.filter((edge) => !derived(edge)), ...analysis.sgEdges, ...analysis.riskEdges]
  // Risk edges start at the internet, as in a scan; the node exists only when they do.
  const hasInternet = graph.nodes.some((n) => n.id === INTERNET_NODE_ID)
  if (analysis.riskEdges.length > 0 && !hasInternet) graph.nodes.push(internetNode())
  if (analysis.riskEdges.length === 0 && hasInternet) graph.nodes = graph.nodes.filter((n) => n.id !== INTERNET_NODE_ID)
}
