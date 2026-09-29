import { describe, expect, it } from 'vitest'
import { planLaunch, ssmCommand, TerminalLaunchError } from './ssm.js'

const target = { instanceId: 'i-05cc1fb57a27a15d5', profile: 'prod-admin', region: 'us-east-1' }
const expected =
  'aws ssm start-session --target i-05cc1fb57a27a15d5 --profile prod-admin --region us-east-1'

describe('ssmCommand', () => {
  it('builds the start-session command', () => {
    expect(ssmCommand(target)).toBe(expected)
  })

  it('rejects anything that could escape into a shell', () => {
    for (const bad of [
      { ...target, instanceId: 'i-123; rm -rf ~' },
      { ...target, instanceId: 'i-0123456789abcdef0 && x' },
      { ...target, region: 'us-east-1`id`' },
      { ...target, profile: "a'b" },
      { ...target, profile: 'a b' },
      { ...target, profile: 'a&calc' },
      { ...target, profile: '$(id)' },
    ]) {
      expect(() => ssmCommand(bad)).toThrow(TerminalLaunchError)
    }
  })
})

describe('planLaunch', () => {
  it('opens a .command file on macOS so the default terminal handles it', () => {
    const plan = planLaunch(target, 'darwin', {})
    expect(plan.file).toBe('open')
    expect(plan.script?.path).toMatch(/ssm-i-05cc1fb57a27a15d5\.command$/)
    expect(plan.args).toEqual([plan.script?.path])
    expect(plan.script?.body).toContain(`\n${expected}\n`)
  })

  it('uses start with a persistent cmd window on Windows', () => {
    const plan = planLaunch(target, 'win32', {})
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(plan.args.at(-1)).toBe(`start "SSM i-05cc1fb57a27a15d5" cmd.exe /k ${expected}`)
  })

  it('prefers $TERMINAL on Linux, then the first known emulator on PATH', () => {
    expect(planLaunch(target, 'linux', { TERMINAL: 'foot' }, () => true).file).toBe('foot')
    const plan = planLaunch(target, 'linux', {}, (bin) => bin === 'konsole')
    expect(plan.file).toBe('konsole')
    expect(plan.args.slice(0, 3)).toEqual(['-e', 'sh', '-c'])
    expect(plan.args[3]).toContain(expected)
  })

  it('says so when Linux has no terminal to open', () => {
    expect(() => planLaunch(target, 'linux', {}, () => false)).toThrow(/No terminal emulator/)
  })
})
