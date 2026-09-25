import { describe, expect, it } from 'vitest'
import type { WafSampledRequest, WafSampledRequestsRequest } from '@cloudatlas/shared'
import type { AwsClient } from '../aws/client.js'
import { clampWindow, getWafSampled, SAMPLE_RETENTION_MS, tally } from './waf.js'
import { describeLoggingDestination, summarizeRules } from '../collectors/waf.js'

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0)

function stubClient(samplesByRule: Record<string, unknown[]>): {
  aws: AwsClient
  inputs: Array<Record<string, unknown>>
} {
  const inputs: Array<Record<string, unknown>> = []
  const aws = {
    async send(_s: string, _r: string, _op: string, command: { input: Record<string, unknown> }) {
      inputs.push(command.input)
      const rule = command.input.RuleMetricName as string
      return { SampledRequests: samplesByRule[rule] ?? [] }
    },
  } as unknown as AwsClient
  return { aws, inputs }
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    Timestamp: new Date(NOW - 60_000),
    Weight: 1,
    Action: 'BLOCK',
    Request: { ClientIP: '203.0.113.47', Country: 'US', URI: '/api/login', Method: 'POST' },
    ...overrides,
  }
}

function request(overrides: Partial<WafSampledRequestsRequest> = {}): WafSampledRequestsRequest {
  return { webAclNodeId: 'acl', start: NOW - 3_600_000, end: NOW, ...overrides }
}

describe('the three-hour retention edge', () => {
  it('clamps a window WAF never held, and says it did', () => {
    // Silently adjusting would make "we asked for a window that does not exist"
    // indistinguishable from "nothing was blocked".
    const clamped = clampWindow(NOW - 24 * 3_600_000, NOW, NOW)
    expect(clamped.startTime.getTime()).toBe(NOW - SAMPLE_RETENTION_MS)
    expect(clamped.note).toMatch(/three hours/)
  })

  it('leaves a window inside the retention alone and adds no note', () => {
    const clamped = clampWindow(NOW - 3_600_000, NOW, NOW)
    expect(clamped.startTime.getTime()).toBe(NOW - 3_600_000)
    expect(clamped.note).toBeNull()
  })

  it('never produces an end at or before the start', () => {
    const clamped = clampWindow(NOW + 60_000, NOW + 120_000, NOW)
    expect(clamped.endTime.getTime()).toBeGreaterThan(clamped.startTime.getTime())
  })
})

describe('sample weights', () => {
  it('sums weights rather than counting samples', () => {
    // A sample stands for `Weight` real requests. Counting rows understates a
    // spike by the sampling ratio — the exact number being read in an incident.
    const requests: WafSampledRequest[] = [
      { timestamp: NOW, clientIp: 'a', country: 'US', uri: '/', method: 'GET', action: 'BLOCK', ruleName: 'r', weight: 40 },
      { timestamp: NOW, clientIp: 'a', country: 'US', uri: '/', method: 'GET', action: 'BLOCK', ruleName: 'r', weight: 60 },
      { timestamp: NOW, clientIp: 'b', country: 'GB', uri: '/', method: 'GET', action: 'BLOCK', ruleName: 'r', weight: 5 },
    ]
    expect(tally(requests, (entry) => entry.clientIp)).toEqual([
      { key: 'a', count: 100 },
      { key: 'b', count: 5 },
    ])
  })

  it('orders ties deterministically so a re-run does not reshuffle', () => {
    const requests: WafSampledRequest[] = ['b', 'a'].map((ip) => ({
      timestamp: NOW, clientIp: ip, country: 'US', uri: '/', method: 'GET',
      action: 'BLOCK', ruleName: 'r', weight: 1,
    }))
    expect(tally(requests, (entry) => entry.clientIp).map((entry) => entry.key)).toEqual(['a', 'b'])
  })

  it('keeps the top 25 only', () => {
    const requests: WafSampledRequest[] = Array.from({ length: 40 }, (_, i) => ({
      timestamp: NOW, clientIp: `ip-${i}`, country: 'US', uri: '/', method: 'GET',
      action: 'BLOCK', ruleName: 'r', weight: i,
    }))
    expect(tally(requests, (entry) => entry.clientIp)).toHaveLength(25)
  })
})

describe('fetching samples', () => {
  it('asks each rule separately and merges by timestamp', async () => {
    const { aws, inputs } = stubClient({
      ALL: [sample({ Timestamp: new Date(NOW - 30_000) })],
      'rate-limit': [sample({ Timestamp: new Date(NOW - 90_000) })],
    })
    const result = await getWafSampled({
      aws,
      request: request(),
      webAclArn: 'arn:aws:wafv2:us-east-1:111122223333:regional/webacl/x/1',
      region: 'us-east-1',
      scope: 'REGIONAL',
      ruleMetricNames: ['ALL', 'rate-limit'],
      now: NOW,
    })
    expect(inputs).toHaveLength(2)
    expect(result.requests.map((entry) => entry.timestamp)).toEqual([NOW - 90_000, NOW - 30_000])
  })

  it('passes the scope through, since the two are not interchangeable', async () => {
    const { aws, inputs } = stubClient({ ALL: [] })
    await getWafSampled({
      aws,
      request: request(),
      webAclArn: 'arn',
      region: 'us-east-1',
      scope: 'CLOUDFRONT',
      ruleMetricNames: ['ALL'],
      now: NOW,
    })
    expect(inputs[0]?.Scope).toBe('CLOUDFRONT')
  })

  it('falls back to the rule metric name when the sample names no sub-rule', async () => {
    const { aws } = stubClient({ 'rate-limit': [sample({ RuleNameWithinRuleGroup: undefined })] })
    const result = await getWafSampled({
      aws, request: request(), webAclArn: 'arn', region: 'us-east-1',
      scope: 'REGIONAL', ruleMetricNames: ['rate-limit'], now: NOW,
    })
    expect(result.requests[0]?.ruleName).toBe('rate-limit')
  })

  it('drops a sample with no request or timestamp instead of inventing one', async () => {
    const { aws } = stubClient({
      ALL: [sample({ Request: undefined }), sample({ Timestamp: undefined }), sample()],
    })
    const result = await getWafSampled({
      aws, request: request(), webAclArn: 'arn', region: 'us-east-1',
      scope: 'REGIONAL', ruleMetricNames: ['ALL'], now: NOW,
    })
    expect(result.requests).toHaveLength(1)
  })
})

describe('web ACL summarising', () => {
  it('separates managed rule groups from custom rules and reads the rate limit', () => {
    const summary = summarizeRules({
      Rules: [
        { Name: 'aws-common', Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'Common' } } },
        { Name: 'aws-bad-inputs', Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'BadInputs' } } },
        { Name: 'rate-limit-login', Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: 'IP', EvaluationWindowSec: 300 } } },
      ],
    } as never)
    expect(summary).toEqual({
      managed: 2,
      custom: 1,
      rateLimits: ['2,000 req / 5 min per IP'],
    })
  })

  it('assumes the documented five-minute default when no window is set', () => {
    const summary = summarizeRules({
      Rules: [{ Statement: { RateBasedStatement: { Limit: 100, AggregateKeyType: 'IP' } } }],
    } as never)
    expect(summary.rateLimits).toEqual(['100 req / 5 min per IP'])
  })

  it('handles an ACL with no rules at all', () => {
    expect(summarizeRules(undefined)).toEqual({ managed: 0, custom: 0, rateLimits: [] })
  })
})

describe('logging destinations', () => {
  it('names the destination type, which is what determines where to look', () => {
    expect(
      describeLoggingDestination({
        LoggingConfiguration: {
          ResourceArn: 'x',
          LogDestinationConfigs: ['arn:aws:logs:us-east-1:111122223333:log-group:aws-waf-logs-cortex'],
        },
      } as never),
    ).toBe('cloudwatch:aws-waf-logs-cortex')

    expect(
      describeLoggingDestination({
        LoggingConfiguration: { ResourceArn: 'x', LogDestinationConfigs: ['arn:aws:s3:::my-waf-logs'] },
      } as never),
    ).toBe('s3:my-waf-logs')
  })

  it('says logging is off rather than leaving the prop blank', () => {
    expect(describeLoggingDestination(undefined)).toBe('not configured')
  })
})
