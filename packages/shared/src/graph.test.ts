import { describe, expect, it } from 'vitest'
import {
  CATEGORY_COLORS,
  findingSchema,
  graphSchema,
  isActiveState,
  isContainerType,
  isPostureFinding,
  nodeCategorySchema,
} from './graph.js'
import { detectSeverity, templatesForKinds } from './logs.js'

describe('node classification', () => {
  it('treats only structural kinds as containers', () => {
    for (const type of ['region', 'vpc', 'az', 'subnet', 'lane'] as const) {
      expect(isContainerType(type)).toBe(true)
    }
    for (const type of ['ec2', 'rds', 's3', 'internet'] as const) {
      expect(isContainerType(type)).toBe(false)
    }
  })

  it('has a colour for every category', () => {
    for (const category of nodeCategorySchema.options) {
      expect(CATEGORY_COLORS[category]).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
  })

  it('recognises the states AWS reports for a healthy resource', () => {
    for (const state of ['running', 'available', 'ACTIVE', 'deployed', 'ready']) {
      expect(isActiveState(state)).toBe(true)
    }
    for (const state of ['stopped', 'terminated', 'pending', 'failed']) {
      expect(isActiveState(state)).toBe(false)
    }
  })
})

describe('findings', () => {
  it('separates configuration posture from live incidents', () => {
    expect(isPostureFinding('risky-sg-rule')).toBe(true)
    expect(isPostureFinding('imdsv1-allowed')).toBe(true)
    expect(isPostureFinding('metric-spike')).toBe(false)
    expect(isPostureFinding('alarm')).toBe(false)
  })

  it('applies schema defaults for optional evidence fields', () => {
    const finding = findingSchema.parse({
      id: 'f1',
      nodeId: 'n1',
      severity: 'critical',
      kind: 'metric-spike',
      title: 't',
      detail: 'd',
      metric: 'CPUUtilization',
      startedAt: 1,
      endedAt: null,
      evidence: [],
    })
    expect(finding.sparkline).toEqual([])
    expect(finding.logGroups).toEqual([])
  })
})

describe('graph schema', () => {
  it('rejects an edge with an unknown kind', () => {
    const result = graphSchema.safeParse({
      nodes: [],
      edges: [{ id: 'e', source: 'a', target: 'b', kind: 'telepathy' }],
      securityGroups: [],
      regions: [],
      missingPermissions: [],
      scannedAt: 0,
      accountId: '1',
      accountAlias: null,
      profile: 'p',
    })
    expect(result.success).toBe(false)
  })
})

describe('log helpers', () => {
  it('extracts severity from common log shapes', () => {
    expect(detectSeverity('2026-09-20 [123] FATAL:  remaining connection slots')).toBe('fatal')
    expect(detectSeverity('{"level":"ERROR","msg":"boom"}')).toBe('error')
    expect(detectSeverity('WARN slow request')).toBe('warn')
    expect(detectSeverity('plain text with no level')).toBeNull()
  })

  it('offers RDS and WAF templates only to the matching group kinds', () => {
    const rds = templatesForKinds(['rds']).map((t) => t.id)
    expect(rds).toContain('rds-slow-queries')
    expect(rds).not.toContain('waf-top-blocked-ips')

    const waf = templatesForKinds(['waf']).map((t) => t.id)
    expect(waf).toContain('waf-top-blocked-ips')
    expect(waf).not.toContain('rds-slow-queries')
  })
})
