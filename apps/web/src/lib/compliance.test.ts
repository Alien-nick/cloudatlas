import { describe, expect, it } from 'vitest'
import { summarizeControls, type ComplianceReport } from '@cloudatlas/shared'
import { fixScript, gapsCsv } from './compliance'

const report: ComplianceReport = {
  frameworks: [
    {
      id: 'hipaa',
      name: 'HIPAA',
      version: 'test',
      description: '',
      controls: [
        { id: 'hipaa:a', framework: 'hipaa', ref: '§164.312(b)', title: 'Audit controls', checkIds: ['logs'] },
      ],
    },
  ],
  checks: [
    {
      id: 'logs',
      title: 'Flow logs are enabled',
      category: 'logging',
      severity: 'medium',
      rationale: '',
      remediation: 'aws ec2 create-flow-logs --resource-ids "vpc-1"',
      appliesTo: ['VPC'],
    },
  ],
  results: [
    {
      checkId: 'logs',
      nodeId: 'vpc-1',
      status: 'fail',
      evidence: ['Flow logs: not enabled', 'second, line'],
      fix: { commands: ['aws ec2 create-flow-logs --resource-ids vpc-1 --log-destination arn:aws:s3:::<log-bucket-name>'], caution: 'Billed per GB.', needsInput: true },
    },
    { checkId: 'logs', nodeId: 'vpc-2', status: 'unknown', evidence: [] },
    { checkId: 'logs', nodeId: 'vpc-3', status: 'pass', evidence: [] },
  ],
  scopes: [],
  scannedAt: 0,
}

describe('gapsCsv', () => {
  const csv = gapsCsv(report, summarizeControls(report, 'hipaa', null), (id) => `name of ${id}`)
  const lines = csv.trim().split('\n')

  it('writes one row per failing or unreadable resource, and none for passes', () => {
    expect(lines).toHaveLength(3)
    expect(csv).not.toContain('vpc-3')
  })

  it('quotes cells containing commas or quotes', () => {
    expect(lines[1]).toContain('"Flow logs: not enabled; second, line"')
    expect(lines[1]).toContain('"aws ec2 create-flow-logs --resource-ids ""vpc-1"""')
  })

  it('carries the citation, the resource and the fix', () => {
    expect(lines[1]?.startsWith('HIPAA,§164.312(b),Audit controls,gap,Flow logs are enabled,medium,name of vpc-1,vpc-1,')).toBe(true)
    expect(lines[2]).toContain(',unknown,')
  })
})

describe('fixScript', () => {
  const script = fixScript(report.checks[0], report.results, (id) => `name of ${id}`)

  it('says up front that the user runs it, and carries the caution', () => {
    const [first, second] = script.split('\n')
    expect(first).toContain('CloudAtlas does not run this')
    expect(second).toBe('# Caution: Billed per GB.')
  })

  it('warns about placeholders, and heads each resource with a comment', () => {
    expect(script).toContain('# Replace every <placeholder>')
    expect(script).toContain('# name of vpc-1 (vpc-1)\naws ec2 create-flow-logs')
  })

  it('writes a command shared by several resources once', () => {
    const shared = { commands: ['aws ec2 enable-ebs-encryption-by-default', 'aws ec2 create-snapshot'], caution: null, needsInput: false }
    const twice = fixScript(
      report.checks[0],
      [
        { checkId: 'logs', nodeId: 'a', status: 'fail', evidence: [], fix: shared },
        { checkId: 'logs', nodeId: 'b', status: 'fail', evidence: [], fix: { ...shared, commands: [shared.commands[0]!, 'aws ec2 create-snapshot --b'] } },
      ],
      (id) => id,
    )
    expect(twice.match(/enable-ebs-encryption-by-default/g)).toHaveLength(1)
    expect(twice).toContain('# b (b)\naws ec2 create-snapshot --b')
  })

  it('skips results with no command', () => {
    expect(script).not.toContain('vpc-2')
    expect(fixScript(report.checks[0], [], () => '')).toBe('')
  })
})
