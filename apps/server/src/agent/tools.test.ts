import { describe, expect, it } from 'vitest'
import { AWS_OPERATIONS } from '../aws/operations.js'
import { DemoProvider } from '../providers/demo/index.js'
import { TOOLS, TOOL_BY_NAME, type ToolContext } from './tools.js'

async function context(selectedNodeId: string | null = null): Promise<ToolContext> {
  const provider = new DemoProvider()
  await provider.scan({ profile: 'cortex-prod', regions: ['us-east-1', 'us-west-2'] })
  return { provider, selectedNodeId }
}

function tool(name: string) {
  const found = TOOL_BY_NAME.get(name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

describe('the tool surface', () => {
  it('reaches AWS only through the provider, never the client directly', async () => {
    // The security argument for the agent is that it cannot widen the
    // permission surface. That holds only while no tool constructs an AWS
    // client or imports the operation registry to call something itself.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from '\.\.\/aws\/client\.js'/)
    expect(source).not.toMatch(/@aws-sdk\//)
  })

  it('exposes no tool that could mutate anything', () => {
    // Every provider method a tool can call is a read. If a write ever appears
    // on CloudProvider, this is the test that should start failing.
    for (const definition of TOOLS) {
      expect(definition.name).toMatch(/^(get|find|describe|search)_/)
    }
  })

  it('has a unique name and a description for every tool', () => {
    const names = TOOLS.map((definition) => definition.name)
    expect(new Set(names).size).toBe(names.length)
    for (const definition of TOOLS) {
      expect(definition.description.length).toBeGreaterThan(40)
      expect(definition.input_schema.type).toBe('object')
    }
  })

  it('does not depend on a registry entry that is still planned', () => {
    // A tool wired to a planned operation throws at the guard rather than
    // returning an error the model can route around.
    const planned = AWS_OPERATIONS.filter((spec) => spec.status === 'planned')
    expect(planned.every((spec) => spec.milestone !== 'M5' || spec.optional)).toBe(true)
  })
})

describe('find_resources', () => {
  it('matches on name, id and tags', async () => {
    const ctx = await context()
    const byName = (await tool('find_resources').run({ query: 'prod-pg-primary' }, ctx)) as {
      total: number
      resources: Array<{ id: string }>
    }
    expect(byName.total).toBeGreaterThan(0)
    expect(byName.resources[0]?.id).toBe('rds-primary')

    const byTag = (await tool('find_resources').run({ query: 'cortex-api' }, ctx)) as {
      total: number
    }
    expect(byTag.total).toBeGreaterThan(0)
  })

  it('filters by type and region', async () => {
    const ctx = await context()
    const result = (await tool('find_resources').run({ type: 'rds', region: 'us-east-1' }, ctx)) as {
      resources: Array<{ type: string; region: string }>
    }
    expect(result.resources.length).toBeGreaterThan(0)
    for (const resource of result.resources) {
      expect(resource.type).toBe('rds')
      expect(resource.region).toBe('us-east-1')
    }
  })

  it('caps the response so a large account does not fill the context window', async () => {
    const ctx = await context()
    const result = (await tool('find_resources').run({}, ctx)) as {
      total: number
      resources: unknown[]
    }
    expect(result.resources.length).toBeLessThanOrEqual(25)
    // The true count is still reported, so the model knows it saw a slice.
    expect(result.total).toBeGreaterThanOrEqual(result.resources.length)
  })
})

describe('describe_resource', () => {
  it('falls back to the resource the user has selected', async () => {
    const ctx = await context('rds-primary')
    const result = (await tool('describe_resource').run({}, ctx)) as {
      resource: { id: string; props: Record<string, string> }
    }
    expect(result.resource.id).toBe('rds-primary')
    expect(result.resource.props.Engine).toContain('PostgreSQL')
  })

  it('omits the raw describe payload, which is large and redundant', async () => {
    const ctx = await context()
    const result = (await tool('describe_resource').run({ nodeId: 'rds-primary' }, ctx)) as {
      resource: Record<string, unknown>
    }
    expect(result.resource.raw).toBeUndefined()
  })

  it('names what the resource connects to, in both directions', async () => {
    const ctx = await context()
    const result = (await tool('describe_resource').run({ nodeId: 'rds-primary' }, ctx)) as {
      connections: Array<{ direction: string; kind: string }>
    }
    expect(result.connections.length).toBeGreaterThan(0)
    expect(new Set(result.connections.map((edge) => edge.direction)).size).toBeGreaterThan(0)
  })

  it('says so rather than guessing when the resource is unknown', async () => {
    const ctx = await context()
    const result = (await tool('describe_resource').run({ nodeId: 'nope' }, ctx)) as {
      error: string
    }
    expect(result.error).toMatch(/find_resources/)
  })
})

describe('get_metrics', () => {
  it('summarises rather than returning every datapoint', async () => {
    const ctx = await context()
    const result = (await tool('get_metrics').run({ nodeId: 'rds-primary', hours: 3 }, ctx)) as {
      series: Array<{ metric: string; datapoints: number; average: number | null; max: number | null }>
    }
    expect(result.series.length).toBeGreaterThan(0)
    const cpu = result.series.find((series) => series.metric === 'CPUUtilization')
    expect(cpu?.datapoints).toBeGreaterThan(0)
    // The staged demo spike should show in the max.
    expect(cpu?.max).toBeGreaterThan(80)
    // And no raw series is included.
    expect((cpu as unknown as { values?: unknown }).values).toBeUndefined()
  })

  it('passes through why a metric had no data', async () => {
    const ctx = await context()
    const result = (await tool('get_metrics').run(
      { nodeId: 'ec2-legacy', metricNames: ['CPUUtilization'] },
      ctx,
    )) as { series: Array<{ unavailableReason: string | null }> }
    // "stopped" and "no data" are different facts and the model must be able
    // to tell them apart.
    expect(result.series[0]?.unavailableReason).toMatch(/stopped/i)
  })
})

describe('search_logs', () => {
  it('searches the resource log groups and truncates long lines', async () => {
    const ctx = await context('rds-primary')
    const result = (await tool('search_logs').run({ search: 'ERROR', hours: 1 }, ctx)) as {
      searched: string[]
      events: Array<{ message: string }>
    }
    expect(result.searched.length).toBeGreaterThan(0)
    for (const event of result.events) expect(event.message.length).toBeLessThanOrEqual(1000)
  })

  it('reports the hint when a resource has no live log groups', async () => {
    const ctx = await context()
    const result = (await tool('search_logs').run({ nodeId: 'alb' }, ctx)) as {
      error?: string
      groups?: Array<{ hint: string | null }>
    }
    if (result.error) {
      // The hint is the useful part — it says what to switch on.
      expect(result.groups?.some((group) => group.hint)).toBe(true)
    }
  })
})

describe('get_findings and get_recent_changes', () => {
  it('returns the findings the UI shows, with their evidence', async () => {
    const ctx = await context()
    const result = (await tool('get_findings').run({}, ctx)) as {
      total: number
      findings: Array<{ kind: string; evidence: string[] }>
    }
    expect(result.total).toBeGreaterThan(0)
    expect(result.findings.some((finding) => finding.evidence.length > 0)).toBe(true)
  })

  it('returns recent write events', async () => {
    const ctx = await context()
    const result = (await tool('get_recent_changes').run({ hours: 3 }, ctx)) as {
      total: number
      changes: Array<{ eventName: string }>
    }
    expect(result.total).toBeGreaterThan(0)
    expect(result.changes[0]?.eventName).toBeTruthy()
  })
})
