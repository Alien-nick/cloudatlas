import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@cloudatlas/shared'
import { DemoProvider } from '../providers/demo/index.js'
import { CHECKS, buildCheckContext } from './checks.js'
import { evaluateCompliance } from './evaluate.js'
import { __testing, fixFor, type FixContext } from './fixes.js'

const { q, logTypesFor, BUILDERS } = __testing

async function demoReport() {
  const graph = await new DemoProvider().scan({
    profile: 'cortex-prod',
    regions: ['us-east-1', 'us-west-2', 'eu-west-1'],
  })
  return { graph, report: evaluateCompliance(graph) }
}

describe('fix commands', () => {
  it('are text only: the module cannot reach an AWS client', async () => {
    // The promise to the user is that CloudAtlas never runs a fix. That holds
    // while this module builds strings and nothing else.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('./fixes.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/aws\/client|@aws-sdk\//)
  })

  it('exist only for checks that exist', () => {
    const ids = new Set(CHECKS.map((check) => check.id))
    for (const checkId of Object.keys(BUILDERS)) expect(ids, checkId).toContain(checkId)
  })

  it('attach only to failing results', async () => {
    const { report } = await demoReport()
    for (const result of report.results) {
      if (result.status !== 'fail') expect(result.fix, `${result.checkId} ${result.nodeId}`).toBeUndefined()
    }
  })

  it('name the resource, region and profile in every command for the demo gaps', async () => {
    const { report } = await demoReport()
    const failing = report.results.filter((result) => result.status === 'fail')
    expect(failing.every((result) => result.fix)).toBe(true)
    for (const result of failing) {
      for (const command of result.fix!.commands.filter((c) => c.startsWith('aws '))) {
        expect(command).toContain('--profile cortex-prod')
        expect(command).toMatch(/--region [a-z]{2}-[a-z]+-\d/)
      }
    }
  })

  it('revokes exactly the offending rule', async () => {
    const { report } = await demoReport()
    const ssh = report.results.find((r) => r.checkId === 'sg-no-world-admin-ports' && r.nodeId === 'ec2-legacy')
    expect(ssh?.fix?.commands).toEqual([
      'aws ec2 revoke-security-group-ingress --group-id sg-0e91aa30 --ip-permissions ' +
        `'[{"IpProtocol":"tcp","FromPort":22,"ToPort":22,"IpRanges":[{"CidrIp":"0.0.0.0/0"}]}]' ` +
        '--region us-east-1 --profile cortex-prod',
    ])
    expect(ssh?.fix?.needsInput).toBe(false)
    expect(ssh?.fix?.caution).toBeTruthy()
  })

  it('fills in the instance id for IMDSv2', async () => {
    const { report } = await demoReport()
    const imds = report.results.find((r) => r.checkId === 'ec2-imdsv2' && r.nodeId === 'ec2-legacy')
    expect(imds?.fix?.commands.at(-1)).toBe(
      'aws ec2 modify-instance-metadata-options --instance-id i-0af22c9e13b7d4410 --http-tokens required ' +
        '--http-endpoint enabled --region us-east-1 --profile cortex-prod',
    )
  })

  it('marks a fix that needs a value only the user knows', async () => {
    const { report } = await demoReport()
    const waf = report.results.find((r) => r.checkId === 'public-alb-waf' && r.nodeId === 'dr-alb')
    expect(waf?.fix?.needsInput).toBe(true)
    expect(waf?.fix?.commands.join('\n')).toContain('<web-acl-arn>')
  })

  it('quotes values a shell would split', () => {
    const node = { id: 'db', name: 'db', type: 'rds', region: 'us-east-1', props: [], securityGroupIds: [] } as unknown as GraphNode
    const context: FixContext = { ...buildCheckContext({ nodes: [], edges: [], securityGroups: [] } as never), profile: 'my profile', accountId: '1' }
    expect(fixFor('rds-deletion-protection', node, context)?.commands[0]).toContain("--profile 'my profile'")
    expect(q("it's")).toBe(`'it'\\''s'`)
  })

  it('exports the log types the engine actually has', () => {
    expect(logTypesFor('PostgreSQL 15.4')).toEqual(['postgresql', 'upgrade'])
    expect(logTypesFor('mysql 8.0')).toEqual(['error', 'general', 'slowquery'])
    expect(logTypesFor('something-new')).toBeNull()
  })
})
