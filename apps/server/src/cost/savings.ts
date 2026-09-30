import { HOURS_PER_MONTH, type Fix, type Graph, type GraphNode, type Saving, type SavingRisk } from '@cloudatlas/shared'
import { awsCli, fact, instanceId, q, rdsTarget, withInputFlag, type CliContext } from '../aws/cli-command.js'
import {
  attachedVolumes,
  engine,
  environment,
  isMultiAz,
  isReplica,
  isRunning,
  lambdaArchitecture,
  instanceType,
  rdsStorage,
  registeredTargets,
  standaloneVolume,
} from './facts.js'
import { rdsEngineName, type PriceBook, type PriceKey } from './pricing.js'

/**
 * Ways to spend less, each with an estimated monthly saving.
 *
 * A check is a *candidate*: the prices it needs (the cheaper alternative, the
 * gp3 rate, the Single-AZ rate) plus a function that turns those prices into a
 * saving. Declaring the prices up front lets them be fetched with the rest.
 *
 * Savings are list-price differences. When a price cannot be found the
 * candidate yields nothing rather than a guess, and savings that depend on
 * usage (Lambda duration) are stated as a proportion, never a dollar figure.
 */

export interface Candidate {
  keys: PriceKey[]
  build: (book: PriceBook) => Saving | null
}

interface SavingInit {
  kind: string
  title: string
  node: GraphNode
  monthly: number | null
  note?: string
  rationale: string
  risk: SavingRisk
  evidence: string[]
  fix?: Omit<Fix, 'needsInput'>
}

function saving(init: SavingInit): Saving | null {
  // A change that saves nothing, or costs more, is not a saving.
  if (init.monthly !== null && init.monthly < 0.5) return null
  return {
    id: `${init.kind}:${init.node.id}`,
    kind: init.kind,
    title: init.title,
    nodeId: init.node.id,
    monthlySavingsUsd: init.monthly === null ? null : Math.round(init.monthly * 100) / 100,
    savingsNote: init.note ?? null,
    rationale: init.rationale,
    risk: init.risk,
    evidence: init.evidence,
    ...(init.fix ? { fix: withInputFlag(init.fix) } : {}),
  }
}

const perMonth = (hourly: number): number => hourly * HOURS_PER_MONTH
const dollars = (value: number): string => `$${value.toFixed(2)}`

// ---------------------------------------------------------------------------
// Instance families
// ---------------------------------------------------------------------------

/** "db.r5.2xlarge" → { prefix: "db.", family: "r5", size: "2xlarge" } */
export function splitType(type: string): { prefix: string; family: string; size: string } | null {
  const match = /^((?:db|cache)\.)?([a-z0-9-]+)\.([a-z0-9]+)$/.exec(type)
  if (!match) return null
  return { prefix: match[1] ?? '', family: match[2] as string, size: match[3] as string }
}

/** Previous generations and the current generation at the same size and architecture. */
const PREVIOUS_GENERATION: Record<string, string> = {
  t2: 't3',
  m3: 'm5',
  m4: 'm5',
  c3: 'c5',
  c4: 'c5',
  r3: 'r5',
  r4: 'r5',
}

/** Current x86 families and their Graviton (arm64) counterpart. */
const GRAVITON: Record<string, string> = {
  t3: 't4g',
  t3a: 't4g',
  m5: 'm6g',
  m5a: 'm6g',
  m6i: 'm6g',
  m6a: 'm6g',
  c5: 'c6g',
  c6i: 'c6g',
  r5: 'r6g',
  r6i: 'r6g',
}

function alternative(type: string, table: Record<string, string>): string | null {
  const parts = splitType(type)
  const family = parts ? table[parts.family] : undefined
  return parts && family ? `${parts.prefix}${family}.${parts.size}` : null
}

/** The price key for a resource's instance, at a given type. */
function instanceKey(node: GraphNode, type: string, multiAz = isMultiAz(node)): PriceKey | null {
  if (node.type === 'ec2') return { kind: 'ec2', region: node.region, instanceType: type }
  if (node.type === 'rds' || node.type === 'rds-cluster') {
    const name = rdsEngineName(engine(node) ?? '')
    return name ? { kind: 'rds', region: node.region, instanceClass: type, engine: name, multiAz } : null
  }
  if (node.type === 'elasticache') {
    const cacheEngine = (engine(node) ?? '').toLowerCase().includes('memcached') ? 'Memcached' : 'Redis'
    return { kind: 'elasticache', region: node.region, nodeType: type, engine: cacheEngine }
  }
  return null
}

function resizeFix(node: GraphNode, context: CliContext, target: string): Omit<Fix, 'needsInput'> | undefined {
  if (node.type === 'ec2') {
    const id = instanceId(node)
    return {
      commands: [
        awsCli(node, context, `ec2 stop-instances --instance-ids ${q(id)}`),
        awsCli(node, context, `ec2 wait instance-stopped --instance-ids ${q(id)}`),
        awsCli(node, context, `ec2 modify-instance-attribute --instance-id ${q(id)} --instance-type ${q(JSON.stringify({ Value: target }))}`),
        awsCli(node, context, `ec2 start-instances --instance-ids ${q(id)}`),
      ],
      caution:
        'Stops the instance for a few minutes. Newer families need the ENA and NVMe drivers, which ' +
        'current Amazon Linux, Ubuntu and Windows AMIs include; check an older AMI first.',
    }
  }
  if (node.type === 'rds' || node.type === 'rds-cluster') {
    return {
      commands: [awsCli(node, context, `rds ${rdsTarget(node)} --db-instance-class ${q(target)}`)],
      caution:
        'Applied in the next maintenance window, with a restart (a failover on Multi-AZ). Add ' +
        '--apply-immediately to do it now.',
    }
  }
  if (node.type === 'elasticache') {
    const group = fact(node, 'Replication group') ?? '<replication-group-id>'
    return {
      commands: [
        awsCli(node, context, `elasticache modify-replication-group --replication-group-id ${q(group)} --cache-node-type ${q(target)}`),
      ],
      caution: 'Applied in the next maintenance window; nodes are replaced one at a time. Add --apply-immediately to do it now.',
    }
  }
  return undefined
}

function familyCandidates(node: GraphNode, context: CliContext): Candidate[] {
  if (!isRunning(node)) return []
  const current = instanceType(node)
  if (!current) return []
  const currentKey = instanceKey(node, current)
  if (!currentKey) return []
  const candidates: Candidate[] = []

  const newer = alternative(current, PREVIOUS_GENERATION)
  const newerKey = newer ? instanceKey(node, newer) : null
  if (newer && newerKey) {
    candidates.push({
      keys: [currentKey, newerKey],
      build: (book) => {
        const now = book.get(currentKey)
        const then = book.get(newerKey)
        if (now === null || then === null) return null
        return saving({
          kind: 'previous-generation',
          title: `Move ${current} to ${newer}`,
          node,
          monthly: perMonth(now - then),
          rationale:
            'Previous-generation instances cost more than the current generation at the same size, ' +
            'and are slower. The newer family is a drop-in replacement on the same architecture.',
          risk: 'medium',
          evidence: [`${current}: ${dollars(perMonth(now))}/mo`, `${newer}: ${dollars(perMonth(then))}/mo`],
          fix: resizeFix(node, context, newer),
        })
      },
    })
  }

  const arm = alternative(newer ?? current, GRAVITON)
  const armKey = arm ? instanceKey(node, arm) : null
  if (arm && armKey) {
    const managed = node.type !== 'ec2'
    candidates.push({
      keys: [currentKey, armKey],
      build: (book) => {
        const now = book.get(currentKey)
        const then = book.get(armKey)
        if (now === null || then === null) return null
        return saving({
          kind: 'graviton',
          title: `Move ${current} to Graviton (${arm})`,
          node,
          monthly: perMonth(now - then),
          rationale: managed
            ? 'Graviton (arm64) instances cost less than their x86 equivalents. The managed engine ' +
              'runs unchanged on them; only the instance class changes.'
            : 'Graviton (arm64) instances cost less than their x86 equivalents, but the workload has to ' +
              'run on arm64: a new arm64 AMI, and any native dependencies rebuilt.',
          risk: managed ? 'medium' : 'high',
          evidence: [`${current}: ${dollars(perMonth(now))}/mo`, `${arm}: ${dollars(perMonth(then))}/mo`],
          // Changing an x86 AMI's instance type to arm64 does not boot, so EC2
          // gets no command — only the managed engines can be switched in place.
          fix: managed ? resizeFix(node, context, arm) : undefined,
        })
      },
    })
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function volumeCandidates(node: GraphNode, context: CliContext): Candidate[] {
  const candidates: Candidate[] = []
  const volumes = node.type === 'ebs-volume' ? [standaloneVolume(node)].filter((v) => v !== null) : attachedVolumes(node)
  // Volumes doing nothing — unattached, or on a stopped instance — are billed
  // in full. The suggestion for those is to retire them, not to tune them.
  const idle = node.type === 'ebs-volume' || (node.type === 'ec2' && !isRunning(node)) ? volumes : []
  const gp2 = idle.length > 0 ? [] : volumes.filter((volume) => volume.type === 'gp2')

  if (gp2.length > 0) {
    const gp2Key: PriceKey = { kind: 'ebs', region: node.region, volumeType: 'gp2' }
    const gp3Key: PriceKey = { kind: 'ebs', region: node.region, volumeType: 'gp3' }
    const gib = gp2.reduce((sum, volume) => sum + volume.sizeGiB, 0)
    candidates.push({
      keys: [gp2Key, gp3Key],
      build: (book) => {
        const now = book.get(gp2Key)
        const then = book.get(gp3Key)
        if (now === null || then === null) return null
        return saving({
          kind: 'gp2-to-gp3',
          title: `Convert ${gp2.length === 1 ? 'volume' : `${gp2.length} volumes`} from gp2 to gp3`,
          node,
          monthly: gib * (now - then),
          rationale:
            'gp3 costs less per GB than gp2 and gives a 3,000 IOPS baseline at any size, where gp2 ' +
            'scales IOPS with size. The change happens online.',
          risk: 'low',
          evidence: gp2.map((volume) => `${volume.id}: ${volume.sizeGiB} GiB gp2`),
          fix: {
            commands: gp2.map((volume) => awsCli(node, context, `ec2 modify-volume --volume-id ${q(volume.id)} --volume-type gp3`)),
            caution:
              'No downtime. A gp2 volume above 1 TiB had more than 3,000 IOPS; add --iops to keep it. ' +
              'A volume cannot be modified again for six hours.',
          },
        })
      },
    })
  }

  if (idle.length > 0) {
    const keys = idle.map((volume): PriceKey => ({ kind: 'ebs', region: node.region, volumeType: volume.type }))
    const unattached = node.type === 'ebs-volume'
    candidates.push({
      keys,
      build: (book) => {
        let total = 0
        for (const [index, volume] of idle.entries()) {
          const price = book.get(keys[index] as PriceKey)
          if (price === null) return null
          total += volume.sizeGiB * price
        }
        const volume = idle[0]
        return saving({
          kind: unattached ? 'unattached-volume' : 'stopped-instance-storage',
          title: unattached ? 'Delete an unattached volume' : 'Retire a stopped instance’s volumes',
          node,
          monthly: total,
          note: 'Before the cost of keeping a snapshot, which is billed per GB of data actually used.',
          rationale: unattached
            ? 'This volume is attached to nothing but is billed every month for its full size.'
            : 'A stopped instance bills nothing for compute, but its volumes are billed in full. If it ' +
              'is no longer needed, an image keeps it recoverable for far less.',
          risk: unattached ? 'medium' : 'high',
          evidence: idle.map((entry) => `${entry.id}: ${entry.sizeGiB} GiB ${entry.type}`),
          fix: unattached && volume
            ? {
                commands: [
                  awsCli(node, context, `ec2 create-snapshot --volume-id ${q(volume.id)} --description ${q(`before deleting ${volume.id}`)}`),
                  awsCli(node, context, 'ec2 wait snapshot-completed --snapshot-ids <snapshot-id-from-above>'),
                  awsCli(node, context, `ec2 delete-volume --volume-id ${q(volume.id)}`),
                ],
                caution: 'Deleting a volume is permanent. The snapshot is what lets you get it back; keep it until you are sure.',
              }
            : {
                commands: [
                  awsCli(node, context, `ec2 create-image --instance-id ${q(instanceId(node))} --name ${q(`${node.name}-before-terminate`)}`),
                  awsCli(node, context, 'ec2 wait image-available --image-ids <image-id-from-above>'),
                  awsCli(node, context, `ec2 terminate-instances --instance-ids ${q(instanceId(node))}`),
                ],
                caution:
                  'Terminating is permanent and deletes volumes marked delete-on-termination. The image ' +
                  'is the way back; confirm it is available before terminating.',
              },
        })
      },
    })
  }
  return candidates
}

function rdsStorageCandidate(node: GraphNode, context: CliContext): Candidate[] {
  if (node.type !== 'rds') return []
  const disk = rdsStorage(node)
  if (!disk || disk.type !== 'gp2') return []
  const multiAz = isMultiAz(node)
  const gp2Key: PriceKey = { kind: 'rds-storage', region: node.region, storageType: 'gp2', multiAz }
  const gp3Key: PriceKey = { kind: 'rds-storage', region: node.region, storageType: 'gp3', multiAz }
  return [
    {
      keys: [gp2Key, gp3Key],
      build: (book) => {
        const now = book.get(gp2Key)
        const then = book.get(gp3Key)
        if (now === null || then === null) return null
        return saving({
          kind: 'rds-gp2-to-gp3',
          title: 'Convert database storage from gp2 to gp3',
          node,
          monthly: disk.sizeGiB * (now - then),
          rationale: 'gp3 storage costs less per GB and gives baseline IOPS independent of size.',
          risk: 'low',
          evidence: [`${disk.sizeGiB} GiB gp2`],
          fix: {
            commands: [awsCli(node, context, `rds ${rdsTarget(node)} --storage-type gp3`)],
            caution:
              'Applied in the next maintenance window, or add --apply-immediately. Storage optimisation ' +
              'then runs for several hours with normal performance; it cannot be modified again for six.',
          },
        })
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Resilience that non-production does not need
// ---------------------------------------------------------------------------

function multiAzCandidate(node: GraphNode, context: CliContext): Candidate[] {
  if (node.type !== 'rds' || !isMultiAz(node) || isReplica(node) || environment(node) !== 'non-prod') return []
  const type = instanceType(node)
  const multi = type ? instanceKey(node, type, true) : null
  const single = type ? instanceKey(node, type, false) : null
  if (!multi || !single) return []
  return [
    {
      keys: [multi, single],
      build: (book) => {
        const now = book.get(multi)
        const then = book.get(single)
        if (now === null || then === null) return null
        return saving({
          kind: 'non-prod-multi-az',
          title: 'Run a non-production database Single-AZ',
          node,
          monthly: perMonth(now - then),
          rationale:
            'Multi-AZ doubles the instance cost to keep a standby for failover. This database is ' +
            'tagged as non-production, where a restore is usually an acceptable recovery.',
          risk: 'medium',
          evidence: [`Environment tag: ${node.tags.find((tag) => /env|stage/i.test(tag.key))?.value ?? ''}`, 'Multi-AZ: enabled'],
          fix: {
            commands: [awsCli(node, context, `rds ${rdsTarget(node)} --no-multi-az`)],
            caution: 'Removes automatic failover. Applied in the next maintenance window, or add --apply-immediately.',
          },
        })
      },
    },
  ]
}

function natCandidates(graph: Graph, context: CliContext): Candidate[] {
  const byVpc = new Map<string, GraphNode[]>()
  for (const node of graph.nodes) {
    if (node.type !== 'nat-gateway' || !node.vpcId) continue
    byVpc.set(node.vpcId, [...(byVpc.get(node.vpcId) ?? []), node])
  }
  const candidates: Candidate[] = []
  for (const [vpcId, nats] of byVpc) {
    const vpc = graph.nodes.find((candidate) => candidate.id === vpcId)
    const nonProd = [vpc, ...nats].some((node) => node && environment(node) === 'non-prod')
    const prod = [vpc, ...nats].some((node) => node && environment(node) === 'prod')
    if (nats.length < 2 || !nonProd || prod) continue
    const [keep, ...extra] = nats
    for (const nat of extra) {
      const key: PriceKey = { kind: 'nat', region: nat.region }
      candidates.push({
        keys: [key],
        build: (book) => {
          const price = book.get(key)
          if (price === null) return null
          return saving({
            kind: 'non-prod-nat',
            title: 'Share one NAT gateway in a non-production VPC',
            node: nat,
            monthly: perMonth(price),
            note: 'Hourly charge only; traffic crossing zones to reach the shared gateway adds a little back.',
            rationale:
              'One NAT gateway per zone buys resilience to a zone outage. A non-production VPC can ' +
              'usually route every private subnet through one.',
            risk: 'medium',
            evidence: [`${nats.length} NAT gateways in ${vpc?.name ?? vpcId}`, `Keep: ${keep?.name ?? ''}`],
            fix: {
              commands: [
                awsCli(nat, context, `ec2 describe-route-tables --filters Name=route.nat-gateway-id,Values=${q(nat.id)}`),
                awsCli(nat, context, `ec2 replace-route --route-table-id <route-table-id> --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${q(keep?.id ?? '<nat-to-keep>')}`),
                awsCli(nat, context, `ec2 delete-nat-gateway --nat-gateway-id ${q(nat.id)}`),
              ],
              caution:
                'Repoint every route table that uses this gateway before deleting it, or those subnets ' +
                'lose internet access. Release its Elastic IP afterwards, which is billed on its own.',
            },
          })
        },
      })
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Idle and usage-based
// ---------------------------------------------------------------------------

function idleLoadBalancer(node: GraphNode, context: CliContext): Candidate[] {
  if ((node.type !== 'alb' && node.type !== 'nlb') || registeredTargets(node) !== 0) return []
  const key: PriceKey = { kind: node.type, region: node.region }
  return [
    {
      keys: [key],
      build: (book) => {
        const price = book.get(key)
        if (price === null) return null
        return saving({
          kind: 'idle-load-balancer',
          title: 'Remove a load balancer with no targets',
          node,
          monthly: perMonth(price),
          rationale:
            'A load balancer is billed by the hour whether or not it has anywhere to send traffic. ' +
            'This one has no registered targets.',
          risk: 'medium',
          evidence: ['Registered targets: 0'],
          fix: {
            commands: [
              awsCli(node, context, `elbv2 describe-listeners --load-balancer-arn ${q(node.arn ?? node.id)}`),
              awsCli(node, context, `elbv2 delete-load-balancer --load-balancer-arn ${q(node.arn ?? node.id)}`),
            ],
            caution:
              'Check the listeners first: one that only redirects or returns a fixed response is doing ' +
              'a job without targets. Anything resolving its DNS name stops working when it is deleted.',
          },
        })
      },
    },
  ]
}

function lambdaArm(node: GraphNode, context: CliContext): Candidate[] {
  if (node.type !== 'lambda' || lambdaArchitecture(node) !== 'x86_64') return []
  return [
    {
      keys: [],
      build: () =>
        saving({
          kind: 'lambda-arm64',
          title: 'Run the function on arm64',
          node,
          monthly: null,
          note: 'About 20% of this function’s duration charges; the amount depends on its usage.',
          rationale:
            'Lambda bills arm64 (Graviton) duration about 20% lower than x86_64. Pure Python, Node.js ' +
            'and Java code moves as-is; native dependencies need an arm64 build.',
          risk: 'medium',
          evidence: ['Architecture: x86_64'],
          fix: {
            commands: [
              awsCli(node, context, `lambda update-function-code --function-name ${q(node.name)} --architectures arm64 --zip-file fileb://<arm64-package.zip>`),
            ],
            caution: 'Deploy a package built for arm64. Test it on a copy of the function or a new version first.',
          },
        }),
    },
  ]
}

// ---------------------------------------------------------------------------

export function savingCandidates(graph: Graph, context: CliContext): Candidate[] {
  return [
    ...graph.nodes.flatMap((node) => [
      ...familyCandidates(node, context),
      ...volumeCandidates(node, context),
      ...rdsStorageCandidate(node, context),
      ...multiAzCandidate(node, context),
      ...idleLoadBalancer(node, context),
      ...lambdaArm(node, context),
    ]),
    ...natCandidates(graph, context),
  ]
}

/** Largest estimated saving first; usage-based ones, with no figure, last. */
export function findSavings(candidates: Candidate[], book: PriceBook): Saving[] {
  return candidates
    .map((candidate) => candidate.build(book))
    .filter((result): result is Saving => result !== null)
    .sort((a, b) => (b.monthlySavingsUsd ?? -1) - (a.monthlySavingsUsd ?? -1))
}
