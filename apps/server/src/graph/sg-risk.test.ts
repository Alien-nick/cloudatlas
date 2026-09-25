import { describe, expect, it } from 'vitest'
import { INTERNET_NODE_ID, type GraphNode, type SecurityGroup } from '@cloudatlas/shared'
import { analyzeSecurityGroups, __testing } from './sg-risk.js'

const NOW = 1_700_000_000_000

function node(id: string, securityGroupIds: string[]): GraphNode {
  return {
    id,
    arn: null,
    type: 'ec2',
    category: 'compute',
    name: id,
    abbr: 'EC2',
    typeLabel: 'EC2 instance',
    region: 'us-east-1',
    az: 'us-east-1a',
    vpcId: 'vpc-1',
    subnetId: 'subnet-1',
    parentId: 'subnet-1',
    state: 'running',
    tags: [],
    props: [],
    raw: {},
    logGroups: [],
    health: 'unknown',
    securityGroupIds,
    monthlyCostUsd: null,
    consoleUrl: null,
  }
}

function group(id: string, rules: SecurityGroup['rules']): SecurityGroup {
  return { id, name: `name-${id}`, vpcId: 'vpc-1', rules }
}

describe('coveredSensitivePorts', () => {
  it('flags a sensitive port inside a range', () => {
    const hits = __testing.coveredSensitivePorts({
      direction: 'in',
      protocol: 'tcp',
      port: '20-30',
      fromPort: 20,
      toPort: 30,
      source: '0.0.0.0/0',
    })
    expect(hits.some((h) => h.startsWith('22'))).toBe(true)
  })

  it('treats an all-ports rule as exposing every sensitive port', () => {
    const hits = __testing.coveredSensitivePorts({
      direction: 'in',
      protocol: '-1',
      port: 'all',
      fromPort: null,
      toPort: null,
      source: '0.0.0.0/0',
    })
    expect(hits.length).toBeGreaterThan(5)
  })

  it('ignores a range with nothing sensitive in it', () => {
    expect(
      __testing.coveredSensitivePorts({
        direction: 'in',
        protocol: 'tcp',
        port: '8080',
        fromPort: 8080,
        toPort: 8080,
        source: '0.0.0.0/0',
      }),
    ).toEqual([])
  })
})

describe('analyzeSecurityGroups', () => {
  it('raises a risk edge and finding for SSH open to the world', () => {
    const sgs = [
      group('sg-bad', [
        { direction: 'in', protocol: 'tcp', port: '22', fromPort: 22, toPort: 22, source: '0.0.0.0/0' },
      ]),
    ]
    const result = analyzeSecurityGroups(sgs, [node('worker', ['sg-bad'])], NOW)

    expect(result.riskEdges).toHaveLength(1)
    expect(result.riskEdges[0]?.source).toBe(INTERNET_NODE_ID)
    expect(result.riskEdges[0]?.target).toBe('worker')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.kind).toBe('risky-sg-rule')
    expect(result.findings[0]?.severity).toBe('warning')
    expect(result.securityGroups[0]?.rules[0]?.risky).toBe(true)
  })

  it('also covers IPv6 ::/0', () => {
    const sgs = [
      group('sg-v6', [
        { direction: 'in', protocol: 'tcp', port: '3389', fromPort: 3389, toPort: 3389, source: '::/0' },
      ]),
    ]
    expect(analyzeSecurityGroups(sgs, [node('win', ['sg-v6'])], NOW).findings).toHaveLength(1)
  })

  it('leaves HTTPS from the world alone', () => {
    const sgs = [
      group('sg-alb', [
        { direction: 'in', protocol: 'tcp', port: '443', fromPort: 443, toPort: 443, source: '0.0.0.0/0' },
      ]),
    ]
    const result = analyzeSecurityGroups(sgs, [node('alb', ['sg-alb'])], NOW)
    expect(result.findings).toHaveLength(0)
    expect(result.riskEdges).toHaveLength(0)
    expect(result.securityGroups[0]?.rules[0]?.risky).toBeUndefined()
  })

  it('ignores egress rules to the world', () => {
    const sgs = [
      group('sg-out', [
        { direction: 'out', protocol: '-1', port: 'all', fromPort: null, toPort: null, source: '0.0.0.0/0' },
      ]),
    ]
    expect(analyzeSecurityGroups(sgs, [node('a', ['sg-out'])], NOW).findings).toHaveLength(0)
  })

  it('derives app-tier edges from security-group references', () => {
    const sgs = [
      group('sg-app', []),
      group('sg-db', [
        { direction: 'in', protocol: 'tcp', port: '5432', fromPort: 5432, toPort: 5432, source: 'sg-app' },
      ]),
    ]
    const nodes = [node('task-1', ['sg-app']), node('task-2', ['sg-app']), node('db', ['sg-db'])]
    const result = analyzeSecurityGroups(sgs, nodes, NOW)

    expect(result.sgEdges).toHaveLength(2)
    expect(result.sgEdges.every((e) => e.target === 'db' && e.label === '5432')).toBe(true)
    expect(result.sgEdges.map((e) => e.source).sort()).toEqual(['task-1', 'task-2'])
  })

  it('does not emit a self-edge when one group references itself', () => {
    const sgs = [
      group('sg-self', [
        { direction: 'in', protocol: 'tcp', port: '7000', fromPort: 7000, toPort: 7000, source: 'sg-self' },
      ]),
    ]
    const result = analyzeSecurityGroups(sgs, [node('only', ['sg-self'])], NOW)
    expect(result.sgEdges).toHaveLength(0)
  })

  it('never mutates the caller\'s security groups', () => {
    const rule = {
      direction: 'in' as const,
      protocol: 'tcp',
      port: '22',
      fromPort: 22,
      toPort: 22,
      source: '0.0.0.0/0',
    }
    const sgs = [group('sg-bad', [rule])]
    analyzeSecurityGroups(sgs, [node('worker', ['sg-bad'])], NOW)
    expect(rule).not.toHaveProperty('risky')
  })
})
