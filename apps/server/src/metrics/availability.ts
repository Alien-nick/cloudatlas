import type { GraphNode, MetricDef } from '@cloudatlas/shared'

/**
 * Why a metric has no data.
 *
 * An empty chart is ambiguous: it can mean the resource is idle, that the
 * metric does not exist for this configuration, or that we asked the wrong
 * question. CloudWatch cannot tell those apart for us — every one of them comes
 * back as an empty `Values` array. These rules recover the distinction from
 * what the scan already knows, so the UI can say "stopped since Tuesday"
 * instead of drawing a flat line at zero.
 *
 * Every rule here is a *precondition*: it is checked before the query, and a
 * non-null result means the metric is not worth asking for. Rules must only
 * fire on facts the collector actually observed — guessing "probably no agent"
 * would suppress a real signal.
 */

/**
 * The vocabulary the fixture provider and this module share for the CloudWatch
 * agent, in the same spirit as graph/posture-facts.ts. Written down because the
 * obvious check — `value.includes('installed')` — is true for "not installed",
 * and a test is the only thing that ever notices.
 */
export const CLOUDWATCH_AGENT = {
  key: 'CloudWatch agent',
  installed: 'installed',
  absent: 'not installed',
} as const

/** True only for a value that positively asserts the agent is running. */
export function agentIsInstalled(value: string): boolean {
  return /^installed\b/i.test(value.trim())
}

function propValue(node: GraphNode, key: string): string | undefined {
  return node.props.find((prop) => prop.k === key)?.v
}

/** t2/t3/t4g and friends earn CPU credits; nothing else publishes the metric. */
export function isBurstableInstance(instanceType: string | undefined): boolean {
  return typeof instanceType === 'string' && /^t\d/i.test(instanceType)
}

/**
 * RDS publishes BurstBalance only for gp2. gp3 has provisioned baseline
 * throughput and no burst bucket, so the metric is absent by design.
 */
export function hasBurstableStorage(storage: string | undefined): boolean {
  return typeof storage === 'string' && /\bgp2\b/i.test(storage)
}

/**
 * A reason to skip `def` on `node`, or null to go ahead and query.
 *
 * The strings are shown verbatim in the detail panel, so they are written as
 * explanations to a human, not as error codes.
 */
export function unavailableReason(node: GraphNode, def: MetricDef): string | null {
  const state = node.state.toLowerCase()

  // A stopped instance publishes nothing at all — not even zeros.
  if (node.type === 'ec2' && state !== 'running') {
    return `Instance is ${state} — CloudWatch reports no datapoints.`
  }
  if (node.type === 'rds' && state !== 'available') {
    return `Database is ${state} — RDS reports metrics only while it is available.`
  }

  if (def.namespace === 'CWAgent') {
    // Against a live account there is no describe call that reports whether the
    // agent is running, so this stays null and the explanation is attached
    // after the empty response instead (see emptySeriesReason). The fixture
    // provider does know, and records it as a prop; when that fact is present
    // it is used, because a fact beats an inference.
    const agent = propValue(node, CLOUDWATCH_AGENT.key)
    if (agent && !agentIsInstalled(agent)) {
      return 'Install the CloudWatch agent to collect memory and disk metrics.'
    }
    return null
  }

  if (def.name === 'CPUCreditBalance' && !isBurstableInstance(propValue(node, 'Instance type'))) {
    return 'CPU credits are only reported for burstable (t-family) instance types.'
  }

  if (def.name === 'BurstBalance' && !hasBurstableStorage(propValue(node, 'Storage'))) {
    return 'Burst balance is only reported for gp2 storage.'
  }

  if (def.name === 'ReplicaLag' && node.type === 'rds' && !propValue(node, 'Replica of')) {
    return 'Not a read replica — there is no replication lag to report.'
  }

  return null
}

/**
 * Explanation for a query that ran and came back with no datapoints.
 *
 * Distinct from `unavailableReason`, which is decided before asking. This one
 * is only ever attached to a series we genuinely queried, so it must never
 * claim more than "CloudWatch had nothing", except where a namespace has a
 * single dominant cause worth naming.
 */
export function emptySeriesReason(def: MetricDef, dimensions: string): string {
  if (def.namespace === 'CWAgent') {
    return `No data — ${def.name} comes from the CloudWatch agent, which does not appear to be reporting on this instance. Queried ${dimensions}.`
  }
  return `No datapoints in this window. Queried ${dimensions}.`
}
