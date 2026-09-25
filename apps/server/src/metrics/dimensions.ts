import type { GraphNode, MetricDef } from '@cloudatlas/shared'

/**
 * CloudWatch dimensions for a node, per namespace.
 *
 * This is the part of the metrics pipeline most likely to be quietly wrong.
 * Getting a dimension name or value wrong does not raise an error — CloudWatch
 * returns an empty result set, which is indistinguishable from "this resource
 * genuinely has no data". So every mapping here is derived from an identifier
 * the collector already holds, never guessed, and `describeDimensions()` exists
 * so a caller can show what was actually queried when a series comes back empty.
 */

export interface Dimension {
  Name: string
  Value: string
}

/** `arn:…:loadbalancer/app/my-alb/50dc6c49` -> `app/my-alb/50dc6c49`. */
export function loadBalancerDimension(arn: string): string | null {
  const marker = ':loadbalancer/'
  const index = arn.indexOf(marker)
  if (index === -1) return null
  return arn.slice(index + marker.length)
}

/** `arn:…:targetgroup/tg-api/9d2c4f1a` -> `targetgroup/tg-api/9d2c4f1a`. */
export function targetGroupDimension(arn: string): string | null {
  const marker = ':targetgroup/'
  const index = arn.indexOf(marker)
  if (index === -1) return null
  return `targetgroup/${arn.slice(index + marker.length)}`
}

function propValue(node: GraphNode, key: string): string | undefined {
  const value = node.props.find((prop) => prop.k === key)?.v
  return value && value.length > 0 ? value : undefined
}

/**
 * Dimensions for `node` in `namespace`, or null when the pair is not something
 * we know how to address. Null means "do not query", not "query with none" —
 * an unqualified query would return account-wide aggregates presented as if
 * they belonged to one resource.
 */
export function dimensionsFor(node: GraphNode, namespace: string): Dimension[] | null {
  switch (namespace) {
    case 'AWS/EC2':
      return node.type === 'ec2' ? [{ Name: 'InstanceId', Value: node.id }] : null

    case 'CWAgent':
      // The agent reports under the same InstanceId, but only if it is running.
      return node.type === 'ec2' ? [{ Name: 'InstanceId', Value: node.id }] : null

    case 'AWS/RDS':
      if (node.type === 'rds') return [{ Name: 'DBInstanceIdentifier', Value: node.id }]
      if (node.type === 'rds-cluster') return [{ Name: 'DBClusterIdentifier', Value: node.id }]
      return null

    case 'AWS/ElastiCache':
      return node.type === 'elasticache' ? [{ Name: 'CacheClusterId', Value: node.id }] : null

    case 'AWS/ApplicationELB':
    case 'AWS/NetworkELB': {
      // The namespaces are not interchangeable: an ALB publishes nothing under
      // AWS/NetworkELB and vice versa, so the pairing is checked, not assumed.
      const expected = namespace === 'AWS/NetworkELB' ? 'nlb' : 'alb'
      if (node.type !== expected) return null
      // The node id is the ARN; the dimension is its tail.
      const value = loadBalancerDimension(node.id)
      return value ? [{ Name: 'LoadBalancer', Value: value }] : null
    }

    case 'AWS/ECS': {
      // Service-level metrics need both dimensions. A task has no metrics of
      // its own, so it borrows its service's — which we only have if the
      // collector recorded one.
      const cluster = propValue(node, 'Cluster')
      const service = propValue(node, 'Service') ?? propValue(node, 'Service name')
      if (!cluster || !service) return null
      return [
        { Name: 'ClusterName', Value: cluster },
        { Name: 'ServiceName', Value: service },
      ]
    }

    default:
      return null
  }
}

/** Human-readable form, for explaining an empty result. */
export function describeDimensions(dimensions: Dimension[]): string {
  return dimensions.map((d) => `${d.Name}=${d.Value}`).join(', ')
}


/**
 * One CloudWatch query per series to fetch for `def` on `node`.
 *
 * Usually exactly one. Metrics published per target group fan out into one per
 * attached group, because the load-balancer-only query for those returns an
 * empty result rather than a rollup.
 */
export interface MetricQuery {
  dimensions: Dimension[]
  /** Appended to the series label when a def produces more than one query. */
  labelSuffix: string | null
}

export function queriesFor(node: GraphNode, def: MetricDef): MetricQuery[] {
  const base = dimensionsFor(node, def.namespace)
  if (!base) return []
  if (!def.perTargetGroup) return [{ dimensions: base, labelSuffix: null }]

  const groups = node.targetGroups ?? []
  return groups.map((group) => ({
    dimensions: [...base, { Name: 'TargetGroup', Value: group.dimension }],
    labelSuffix: group.name,
  }))
}

/**
 * Why `queriesFor` produced nothing, phrased for the detail panel. Returning a
 * reason rather than an empty chart keeps "we did not ask" distinct from
 * "we asked and CloudWatch had no data".
 */
export function noQueryReason(node: GraphNode, def: MetricDef): string {
  if (def.perTargetGroup && (node.targetGroups ?? []).length === 0) {
    return 'No target groups attached — CloudWatch publishes this metric per target group.'
  }
  if (def.namespace === 'AWS/ECS' && !propValue(node, 'Service')) {
    return 'Not managed by an ECS service — there are no service-level metrics for this task.'
  }
  return `No CloudWatch dimensions are known for ${node.typeLabel} in ${def.namespace}.`
}
