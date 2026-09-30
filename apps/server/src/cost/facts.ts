import type { GraphNode } from '@cloudatlas/shared'
import { fact } from '../aws/cli-command.js'

/**
 * The cost-relevant facts about a resource, read from its props.
 *
 * Props rather than raw SDK objects, for the same reason as the compliance
 * checks: estimates and savings then run identically over a live scan, a
 * replayed fixture and the demo. Each reader returns null when the fact is
 * absent, and a null fact means "not priced", never a guessed default.
 */

/** First token of a value like "m6i.xlarge · 4 vCPU / 16 GiB". */
function firstToken(value: string | undefined): string | null {
  const token = value?.trim().split(/[\s·]+/)[0]
  return token ? token : null
}

export function instanceType(node: GraphNode): string | null {
  if (node.type === 'ec2') return firstToken(fact(node, 'Instance type'))
  if (node.type === 'rds' || node.type === 'rds-cluster') return firstToken(fact(node, 'Instance class'))
  if (node.type === 'elasticache') return firstToken(fact(node, 'Node type'))
  return null
}

export interface Volume {
  id: string
  sizeGiB: number
  type: string
}

/** EC2's "EBS" prop, written as "vol-0abc 80 GiB gp3, vol-0def 20 GiB gp2". */
export function attachedVolumes(node: GraphNode): Volume[] {
  const value = fact(node, 'EBS') ?? ''
  return [...value.matchAll(/(vol-[0-9a-f]+)\s+(\d+)\s*GiB\s+([a-z0-9]+)/g)].map((match) => ({
    id: match[1] as string,
    sizeGiB: Number(match[2]),
    type: match[3] as string,
  }))
}

/** A volume node of its own: the ones attached to nothing. */
export function standaloneVolume(node: GraphNode): Volume | null {
  if (node.type !== 'ebs-volume') return null
  const size = Number(/(\d+)/.exec(fact(node, 'Size') ?? '')?.[1])
  const type = fact(node, 'Volume type')
  if (!Number.isFinite(size) || !type) return null
  return { id: fact(node, 'Volume ID') ?? node.id, sizeGiB: size, type }
}

/** RDS "Storage", e.g. "1024 GiB gp3 · 12000 IOPS". */
export function rdsStorage(node: GraphNode): { sizeGiB: number; type: string } | null {
  const match = /(\d+)\s*GiB\s+([a-z0-9]+)/.exec(fact(node, 'Storage') ?? '')
  return match ? { sizeGiB: Number(match[1]), type: match[2] as string } : null
}

export function engine(node: GraphNode): string | null {
  return firstToken(fact(node, 'Engine'))
}

export function isMultiAz(node: GraphNode): boolean {
  return (fact(node, 'Multi-AZ') ?? '').toLowerCase().startsWith('enabled')
}

export function isReplica(node: GraphNode): boolean {
  return fact(node, 'Replica of') !== undefined
}

/** Cache nodes in the cluster; one when not stated. */
export function cacheNodeCount(node: GraphNode): number {
  const count = Number(fact(node, 'Nodes'))
  return Number.isFinite(count) && count > 0 ? count : 1
}

/**
 * vCPU and GB of memory for a Fargate task. Reads the builder's
 * "CPU / memory" (task units: 1024 per vCPU, MiB) and the demo's
 * "Fargate · 1 vCPU / 2 GB".
 */
export function fargateSize(node: GraphNode): { vcpu: number; gb: number } | null {
  if (node.type !== 'ecs-task') return null
  const launch = (fact(node, 'Launch type') ?? '').toLowerCase()
  if (!launch.includes('fargate')) return null

  const units = /(\d+)\s*\/\s*(\d+)/.exec(fact(node, 'CPU / memory') ?? '')
  if (units) return { vcpu: Number(units[1]) / 1024, gb: Number(units[2]) / 1024 }

  const readable = /(\d+(?:\.\d+)?)\s*vCPU\s*\/\s*(\d+(?:\.\d+)?)\s*GB/i.exec(fact(node, 'Launch type') ?? '')
  return readable ? { vcpu: Number(readable[1]), gb: Number(readable[2]) } : null
}

export function lambdaArchitecture(node: GraphNode): 'arm64' | 'x86_64' | null {
  const value = `${fact(node, 'Architecture') ?? ''} ${fact(node, 'Runtime') ?? ''}`
  if (/arm64/.test(value)) return 'arm64'
  if (/x86_64/.test(value)) return 'x86_64'
  return null
}

/** Load balancer targets across its target groups; null when not recorded. */
export function registeredTargets(node: GraphNode): number | null {
  const count = Number(fact(node, 'Registered targets'))
  return Number.isFinite(count) ? count : null
}

const PROD = /^(prod|production|prd|live)$/i
const NON_PROD = /^(dev|development|test|testing|qa|stage|staging|sandbox|sbx|uat|demo)$/i

/**
 * The environment a resource declares through its tags. "unknown" is common
 * and deliberate: savings that trade away resilience are only suggested when a
 * resource says outright that it is not production.
 */
export function environment(node: GraphNode): 'prod' | 'non-prod' | 'unknown' {
  const tag = node.tags.find((candidate) => /^(env|environment|stage)$/i.test(candidate.key))?.value.trim()
  if (!tag) return 'unknown'
  if (PROD.test(tag)) return 'prod'
  if (NON_PROD.test(tag)) return 'non-prod'
  return 'unknown'
}

export function isRunning(node: GraphNode): boolean {
  return !/stopped|stopping|terminated|shutting-down/i.test(node.state)
}
