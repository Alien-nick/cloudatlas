import { describe, expect, it } from 'vitest'
import type { GetMetricDataOutput } from '@aws-sdk/client-cloudwatch'
import type { GraphNode, MetricDef } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { fetchMetrics, MAX_QUERIES_PER_CALL } from './batch.js'

const START = Date.UTC(2026, 0, 1, 0, 0, 0)
const END = Date.UTC(2026, 0, 1, 0, 5, 0)
const MINUTE = 60_000

function instance(): GraphNode {
  return {
    id: 'i-0123456789abcdef0',
    arn: null,
    type: 'ec2',
    category: 'compute',
    name: 'web-1',
    abbr: 'EC2',
    typeLabel: 'EC2 instance',
    region: 'us-east-1',
    az: 'us-east-1a',
    vpcId: 'vpc-1',
    subnetId: 'subnet-1',
    parentId: 'subnet-1',
    state: 'running',
    tags: [],
    props: [{ k: 'Instance type', v: 'm5.large', mono: true }],
    raw: {},
    logGroups: [],
    health: 'unknown',
    securityGroupIds: [],
    monthlyCostUsd: null,
    consoleUrl: null,
  }
}

const cpu: MetricDef = {
  name: 'CPUUtilization',
  namespace: 'AWS/EC2',
  label: 'CPU utilization',
  unit: '%',
  stat: 'Average',
  group: 'Core',
}

/** Records the calls it receives and replays a scripted list of responses. */
function stubClient(responses: GetMetricDataOutput[]): {
  aws: AwsClient
  calls: Array<Record<string, unknown>>
} {
  const calls: Array<Record<string, unknown>> = []
  let index = 0
  const aws = {
    async send(_service: string, _region: string, operation: string, command: { input: Record<string, unknown> }) {
      expect(operation).toBe('GetMetricData')
      calls.push(command.input)
      return responses[index++] ?? {}
    },
  } as unknown as AwsClient
  return { aws, calls }
}

describe('fetching a batch', () => {
  it('preserves a gap as null rather than zero-filling it', async () => {
    // CloudWatch omits timestamps with no data, so the response below is what a
    // two-minute outage in the middle of the window actually looks like.
    const { aws } = stubClient([
      {
        MetricDataResults: [
          {
            Id: 'm0',
            Timestamps: [new Date(START), new Date(START + 4 * MINUTE)],
            Values: [41.2, 38.9],
          },
        ],
      },
    ])

    const series = await fetchMetrics({
      aws,
      region: 'us-east-1',
      node: instance(),
      defs: [cpu],
      period: 60,
      start: START,
      end: END,
    })

    expect(series).toHaveLength(1)
    expect(series[0]?.values).toEqual([41.2, null, null, null, 38.9])
    expect(series[0]?.timestamps).toHaveLength(5)
    expect(series[0]?.unavailableReason).toBeNull()
  })

  it('merges datapoints for the same query id across pages', async () => {
    // A NextToken continues the same ids, so m0 arrives in two pieces. Taking
    // only the last page would silently truncate the chart.
    const { aws, calls } = stubClient([
      {
        MetricDataResults: [{ Id: 'm0', Timestamps: [new Date(START)], Values: [10] }],
        NextToken: 'page-2',
      },
      {
        MetricDataResults: [
          {
            Id: 'm0',
            Timestamps: [new Date(START + 2 * MINUTE), new Date(START + 3 * MINUTE)],
            Values: [20, 30],
          },
        ],
      },
    ])

    const series = await fetchMetrics({
      aws,
      region: 'us-east-1',
      node: instance(),
      defs: [cpu],
      period: 60,
      start: START,
      end: END,
    })

    expect(calls).toHaveLength(2)
    expect(calls[1]?.NextToken).toBe('page-2')
    expect(series[0]?.values).toEqual([10, null, 20, 30, null])
  })

  it('distinguishes "asked and got nothing" from "did not ask"', async () => {
    const { aws } = stubClient([
      { MetricDataResults: [{ Id: 'm0', Timestamps: [], Values: [] }] },
    ])

    const series = await fetchMetrics({
      aws,
      region: 'us-east-1',
      node: instance(),
      defs: [cpu],
      period: 60,
      start: START,
      end: END,
    })

    expect(series[0]?.values).toEqual([])
    expect(series[0]?.unavailableReason).toMatch(/no datapoints/i)
    // The reason names the dimensions, so a wrong mapping is visible in the UI
    // rather than looking like an idle resource.
    expect(series[0]?.unavailableReason).toContain('InstanceId=i-0123456789abcdef0')
  })

  it('splits into several calls once past the query limit', async () => {
    const defs: MetricDef[] = Array.from({ length: MAX_QUERIES_PER_CALL + 3 }, (_, i) => ({
      ...cpu,
      name: `Metric${i}`,
      label: `Metric ${i}`,
    }))
    const { aws, calls } = stubClient([{}, {}])

    await fetchMetrics({
      aws,
      region: 'us-east-1',
      node: instance(),
      defs,
      period: 60,
      start: START,
      end: END,
    })

    expect(calls).toHaveLength(2)
    expect((calls[0]?.MetricDataQueries as unknown[]).length).toBe(MAX_QUERIES_PER_CALL)
    expect((calls[1]?.MetricDataQueries as unknown[]).length).toBe(3)
    expect(calls[0]?.ScanBy).toBe('TimestampAscending')
  })

  it('returns skipped metrics alongside fetched ones, never dropping either', async () => {
    const credits: MetricDef = { ...cpu, name: 'CPUCreditBalance', label: 'CPU credits' }
    const { aws } = stubClient([
      {
        MetricDataResults: [{ Id: 'm0', Timestamps: [new Date(START)], Values: [12] }],
      },
    ])

    const series = await fetchMetrics({
      aws,
      region: 'us-east-1',
      node: instance(),
      defs: [cpu, credits],
      period: 60,
      start: START,
      end: END,
    })

    expect(series).toHaveLength(2)
    const byName = new Map(series.map((s) => [s.metricName, s]))
    expect(byName.get('CPUUtilization')?.unavailableReason).toBeNull()
    // m5.large is not burstable, so this one was never queried.
    expect(byName.get('CPUCreditBalance')?.unavailableReason).toMatch(/burstable/i)
  })
})
