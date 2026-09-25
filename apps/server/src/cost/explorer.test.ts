import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@cloudatlas/shared'
import { applyCosts, currentMonthWindow, parseCosts } from './explorer.js'

function node(type: string, id = type): GraphNode {
  return {
    id, arn: null, type: type as GraphNode['type'], category: 'compute', name: id, abbr: 'X',
    typeLabel: type, region: 'us-east-1', az: null, vpcId: null, subnetId: null, parentId: null,
    state: 'running', tags: [], props: [], raw: {}, logGroups: [], health: 'unknown',
    securityGroupIds: [], monthlyCostUsd: null, consoleUrl: null,
  }
}

describe('the reporting window', () => {
  it('runs from the start of the month to tomorrow', () => {
    // Cost Explorer's end date is exclusive: today..today returns nothing.
    const window = currentMonthWindow(new Date(Date.UTC(2026, 8, 23, 12, 0, 0)))
    expect(window.start).toBe('2026-09-01')
    expect(window.end).toBe('2026-09-24')
  })

  it('works on the first of the month', () => {
    const window = currentMonthWindow(new Date(Date.UTC(2026, 8, 1, 3, 0, 0)))
    expect(window.start).toBe('2026-09-01')
    expect(window.end).toBe('2026-09-02')
  })
})

describe('parsing costs', () => {
  const output = {
    ResultsByTime: [
      {
        Groups: [
          { Keys: ['Amazon Relational Database Service'], Metrics: { UnblendedCost: { Amount: '642.10' } } },
          { Keys: ['AWS Lambda'], Metrics: { UnblendedCost: { Amount: '3.20' } } },
          { Keys: ['Amazon Route 53'], Metrics: { UnblendedCost: { Amount: '0' } } },
        ],
      },
    ],
  }

  it('sums by service, largest first, dropping zero spend', () => {
    expect(parseCosts(output as never)).toEqual([
      { service: 'Amazon Relational Database Service', amountUsd: 642.1 },
      { service: 'AWS Lambda', amountUsd: 3.2 },
    ])
  })

  it('handles an empty response without throwing', () => {
    expect(parseCosts({} as never)).toEqual([])
  })
})

describe('attributing cost', () => {
  it('attaches the service total to every node of that service', () => {
    // Cost Explorer reports per service, not per resource. Dividing the total
    // across resources would produce a number that looks precise and is not.
    const nodes = [node('rds', 'db-1'), node('rds', 'db-2'), node('lambda', 'fn')]
    applyCosts(nodes, [
      { service: 'Amazon Relational Database Service', amountUsd: 642.1 },
      { service: 'AWS Lambda', amountUsd: 3.2 },
    ])
    expect(nodes[0]?.monthlyCostUsd).toBe(642.1)
    expect(nodes[1]?.monthlyCostUsd).toBe(642.1)
    expect(nodes[2]?.monthlyCostUsd).toBe(3.2)
  })

  it('leaves a node null when its service reported no spend', () => {
    const nodes = [node('s3', 'bucket')]
    applyCosts(nodes, [{ service: 'AWS Lambda', amountUsd: 3.2 }])
    expect(nodes[0]?.monthlyCostUsd).toBeNull()
  })
})
