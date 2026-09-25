import {
  METRIC_CATALOG,
  choosePeriod,
  primaryMetricsFor,
  type CloudProvider,
  type GraphNode,
} from '@cloudatlas/shared'

/**
 * What the agent is allowed to do.
 *
 * Every tool goes through the `CloudProvider` interface, which is the same seam
 * the UI uses. That is the whole security argument: the agent never holds
 * credentials, never constructs an AWS client, and cannot reach an API that is
 * not already in the read-only registry. Adding a capability here cannot widen
 * the permission surface — only adding a registry entry can, and that is a
 * separate, reviewable change.
 *
 * The tools are also shaped to return *small* answers. Handing back a whole
 * graph or ten thousand log lines would spend the context window on data the
 * model has to summarise anyway, so each tool returns the shape a human would
 * ask for: a node and its neighbours, a metric's recent numbers, the top log
 * lines.
 */

export interface ToolContext {
  provider: CloudProvider
  /** Node the user had selected, so "this database" resolves. */
  selectedNodeId: string | null
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Node summary without `raw`, which is large and mostly redundant. */
function summarizeNode(node: GraphNode): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    typeLabel: node.typeLabel,
    region: node.region,
    az: node.az,
    state: node.state,
    health: node.health,
    vpcId: node.vpcId,
    subnetId: node.subnetId,
    props: Object.fromEntries(node.props.map((prop) => [prop.k, prop.v])),
    tags: Object.fromEntries(node.tags.map((tag) => [tag.key, tag.value])),
    logGroups: node.logGroups,
  }
}

function resolveNode(
  input: Record<string, unknown>,
  context: ToolContext,
  nodes: GraphNode[],
): GraphNode | undefined {
  const requested = str(input, 'nodeId') ?? context.selectedNodeId ?? undefined
  if (!requested) return undefined
  return (
    nodes.find((node) => node.id === requested) ??
    // Fall back to an exact name match, because the model will often have read
    // the name off the diagram rather than the id.
    nodes.find((node) => node.name === requested)
  )
}

const HOUR = 3_600_000

export const TOOLS: ToolDefinition[] = [
  {
    name: 'find_resources',
    description:
      'Search the scanned graph for resources by name, type, tag or region. Use this first to turn a name the user mentioned into a node id. Returns at most 25 matches.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring matched against name, id and tags.' },
        type: { type: 'string', description: 'Exact node type, e.g. "rds", "ec2", "alb".' },
        region: { type: 'string' },
      },
    },
    run: async (input, context) => {
      const graph = context.provider.getGraph()
      if (!graph) return { error: 'No scan has been run yet.' }
      const query = str(input, 'query')?.toLowerCase()
      const type = str(input, 'type')
      const region = str(input, 'region')

      const matches = graph.nodes.filter((node) => {
        if (type && node.type !== type) return false
        if (region && node.region !== region) return false
        if (!query) return true
        const haystack = [node.name, node.id, ...node.tags.map((tag) => `${tag.key}=${tag.value}`)]
          .join(' ')
          .toLowerCase()
        return haystack.includes(query)
      })

      return {
        total: matches.length,
        resources: matches.slice(0, 25).map((node) => ({
          id: node.id,
          name: node.name,
          type: node.type,
          region: node.region,
          state: node.state,
          health: node.health,
        })),
      }
    },
  },

  {
    name: 'describe_resource',
    description:
      'Full configuration of one resource, plus what it connects to. Defaults to the resource the user has selected.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'string' } },
    },
    run: async (input, context) => {
      const graph = context.provider.getGraph()
      if (!graph) return { error: 'No scan has been run yet.' }
      const node = resolveNode(input, context, graph.nodes)
      if (!node) return { error: 'No such resource. Use find_resources first.' }

      const edges = graph.edges.filter(
        (edge) => edge.source === node.id || edge.target === node.id,
      )
      const byId = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]))

      return {
        resource: summarizeNode(node),
        connections: edges.map((edge) => {
          const otherId = edge.source === node.id ? edge.target : edge.source
          const other = byId.get(otherId)
          return {
            direction: edge.source === node.id ? 'outbound' : 'inbound',
            kind: edge.kind,
            via: edge.meta?.via ?? null,
            resource: other ? { id: other.id, name: other.name, type: other.type } : otherId,
          }
        }),
      }
    },
  },

  {
    name: 'get_metrics',
    description:
      'Recent CloudWatch metrics for a resource. Returns summary statistics rather than every datapoint. Use this to check whether something is actually under load.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        metricNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Empty for the primary metrics of this resource type.',
        },
        hours: { type: 'number', description: 'Window to look back. Defaults to 3.' },
      },
    },
    run: async (input, context) => {
      const graph = context.provider.getGraph()
      if (!graph) return { error: 'No scan has been run yet.' }
      const node = resolveNode(input, context, graph.nodes)
      if (!node) return { error: 'No such resource. Use find_resources first.' }
      if (primaryMetricsFor(node.type).length === 0 && !METRIC_CATALOG[node.type]) {
        return { error: `CloudAtlas has no metric catalog for ${node.typeLabel}.` }
      }

      const end = Date.now()
      const start = end - (num(input, 'hours') ?? 3) * HOUR
      const names = Array.isArray(input.metricNames)
        ? (input.metricNames as unknown[]).filter((name): name is string => typeof name === 'string')
        : []

      const response = await context.provider.getMetrics({
        nodeId: node.id,
        metricNames: names,
        start,
        end,
        period: choosePeriod(start, end),
      })

      // Summarised rather than raw: a 3-hour window at 1-minute resolution is
      // 180 numbers per metric, and the model needs the shape, not the series.
      return {
        nodeId: node.id,
        window: { start, end },
        series: response.series.map((series) => {
          const values = series.values.filter((value): value is number => value !== null)
          return {
            metric: series.metricName,
            label: series.label,
            unit: series.unit,
            unavailableReason: series.unavailableReason,
            datapoints: values.length,
            latest: values[values.length - 1] ?? null,
            min: values.length > 0 ? Math.min(...values) : null,
            max: values.length > 0 ? Math.max(...values) : null,
            average:
              values.length > 0
                ? values.reduce((sum, value) => sum + value, 0) / values.length
                : null,
          }
        }),
        missingPermissions: response.missingPermissions,
      }
    },
  },

  {
    name: 'get_findings',
    description:
      'Current health findings — live incidents and configuration posture issues — across the account.',
    input_schema: { type: 'object', properties: {} },
    run: async (_input, context) => {
      const findings = await context.provider.getFindings()
      return {
        total: findings.length,
        findings: findings.map((finding) => ({
          id: finding.id,
          nodeId: finding.nodeId,
          severity: finding.severity,
          kind: finding.kind,
          title: finding.title,
          detail: finding.detail,
          metric: finding.metric,
          startedAt: finding.startedAt,
          evidence: finding.evidence,
        })),
      }
    },
  },

  {
    name: 'search_logs',
    description:
      "Search a resource's log groups. Returns matching lines, newest last. Prefer a specific search term over an empty one.",
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        search: { type: 'string', description: 'Substring, or a CloudWatch filter pattern.' },
        hours: { type: 'number', description: 'Defaults to 1.' },
        limit: { type: 'number', description: 'Defaults to 50, max 200.' },
      },
    },
    run: async (input, context) => {
      const graph = context.provider.getGraph()
      if (!graph) return { error: 'No scan has been run yet.' }
      const node = resolveNode(input, context, graph.nodes)
      if (!node) return { error: 'No such resource. Use find_resources first.' }

      const groups = await context.provider.listLogGroups(node.id)
      const existing = groups.filter((group) => group.exists).map((group) => group.name)
      if (existing.length === 0) {
        return {
          error: 'This resource has no CloudWatch log groups.',
          // The hints say what to switch on, which is usually the real answer.
          groups: groups.map((group) => ({ name: group.name, hint: group.hint })),
        }
      }

      const end = Date.now()
      const start = end - (num(input, 'hours') ?? 1) * HOUR
      const limit = Math.min(200, num(input, 'limit') ?? 50)
      const response = await context.provider.queryLogs({
        logGroups: existing,
        region: node.region === 'global' ? 'us-east-1' : node.region,
        start,
        end,
        filterPattern: str(input, 'search') ?? '',
        limit,
      })

      return {
        nodeId: node.id,
        searched: existing,
        truncated: response.truncated,
        matches: response.events.length,
        events: response.events.map((event) => ({
          timestamp: event.timestamp,
          severity: event.severity,
          message: event.message.slice(0, 1000),
        })),
        missingPermissions: response.missingPermissions,
      }
    },
  },

  {
    name: 'get_database_load',
    description:
      'Performance Insights for an RDS instance: average active sessions, the statements driving load, and the wait events behind them. Use this when a database looks busy and you need to know what it is busy with — CPU and connection counts do not say that.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        hours: { type: 'number', description: 'Defaults to 1.' },
      },
    },
    run: async (input, context) => {
      const graph = context.provider.getGraph()
      if (!graph) return { error: 'No scan has been run yet.' }
      const node = resolveNode(input, context, graph.nodes)
      if (!node) return { error: 'No such resource. Use find_resources first.' }

      const end = Date.now()
      const load = await context.provider.getDatabaseLoad(
        node.id,
        end - (num(input, 'hours') ?? 1) * HOUR,
        end,
      )
      return {
        ...load,
        // Stated rather than left for the model to infer: load above the vCPU
        // count means sessions are queuing, which is the reading that matters.
        interpretation:
          load.averageLoad !== null && load.vcpus !== null
            ? load.averageLoad > load.vcpus
              ? `Average load ${load.averageLoad} exceeds ${load.vcpus} vCPUs — sessions are queuing.`
              : `Average load ${load.averageLoad} is within ${load.vcpus} vCPUs.`
            : null,
      }
    },
  },

  {
    name: 'get_recent_changes',
    description:
      'Write events from CloudTrail in a time window — deploys, configuration changes, scaling actions. Use this to check whether an incident followed a change.',
    input_schema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'Defaults to 3.' } },
    },
    run: async (input, context) => {
      const end = Date.now()
      const start = end - (num(input, 'hours') ?? 3) * HOUR
      const changes = await context.provider.getRecentChanges(start, end)
      return { total: changes.length, changes: changes.slice(0, 50) }
    },
  },

  {
    name: 'get_alarms',
    description: 'CloudWatch alarms and their current state.',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'ALARM, OK or INSUFFICIENT_DATA.' },
      },
    },
    run: async (input, context) => {
      const alarms = await context.provider.getAlarms(str(input, 'state'))
      return { total: alarms.length, alarms: alarms.slice(0, 50) }
    },
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))
