import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listLocalProfiles, __testing } from './profiles.js'

const CONFIG = `
[default]
region = us-east-1
output = json

[profile cortex-prod]
sso_session = corp
sso_account_id = 482177301192
region = us-east-1

[sso-session corp]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1

# a comment
[profile legacy]
region = eu-west-1
`

const CREDENTIALS = `
[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[ci-bot]
aws_access_key_id = AKIAI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY
aws_session_token = FwoGZXIvYXdzEBYaDEXAMPLE
`

const originalConfig = process.env.AWS_CONFIG_FILE
const originalCredentials = process.env.AWS_SHARED_CREDENTIALS_FILE

function writeFixtures(): void {
  const dir = mkdtempSync(join(tmpdir(), 'cloudatlas-aws-'))
  const config = join(dir, 'config')
  const credentials = join(dir, 'credentials')
  writeFileSync(config, CONFIG)
  writeFileSync(credentials, CREDENTIALS)
  process.env.AWS_CONFIG_FILE = config
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentials
}

afterEach(() => {
  if (originalConfig === undefined) delete process.env.AWS_CONFIG_FILE
  else process.env.AWS_CONFIG_FILE = originalConfig
  if (originalCredentials === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE
  else process.env.AWS_SHARED_CREDENTIALS_FILE = originalCredentials
})

describe('parseIni', () => {
  it('reads only the allowlisted keys, never credentials', () => {
    const sections = __testing.parseIni(CREDENTIALS)
    for (const section of sections) {
      expect(Object.keys(section.values)).not.toContain('aws_access_key_id')
      expect(Object.keys(section.values)).not.toContain('aws_secret_access_key')
      expect(Object.keys(section.values)).not.toContain('aws_session_token')
    }
  })

  it('skips comments and blank lines', () => {
    const names = __testing.parseIni(CONFIG).map((s) => s.name)
    expect(names).toEqual(['default', 'profile cortex-prod', 'sso-session corp', 'profile legacy'])
  })
})

describe('listLocalProfiles', () => {
  it('strips the "profile " prefix and keeps [default] as-is', () => {
    writeFixtures()
    const names = listLocalProfiles().map((p) => p.name)
    expect(names).toContain('default')
    expect(names).toContain('cortex-prod')
    expect(names).toContain('legacy')
  })

  it('does not treat an [sso-session] block as a profile', () => {
    writeFixtures()
    expect(listLocalProfiles().map((p) => p.name)).not.toContain('corp')
  })

  it('marks SSO profiles and records the configured region', () => {
    writeFixtures()
    const prod = listLocalProfiles().find((p) => p.name === 'cortex-prod')
    expect(prod?.sso).toBe(true)
    expect(prod?.region).toBe('us-east-1')
  })

  it('merges profiles present in both files and lists credentials-only ones', () => {
    writeFixtures()
    const profiles = listLocalProfiles()
    expect(profiles.find((p) => p.name === 'default')?.source).toBe('both')
    expect(profiles.find((p) => p.name === 'ci-bot')?.source).toBe('credentials')
  })

  it('sorts default first, then alphabetically', () => {
    writeFixtures()
    expect(listLocalProfiles()[0]?.name).toBe('default')
  })

  it('returns an empty list rather than throwing when no config exists', () => {
    process.env.AWS_CONFIG_FILE = join(tmpdir(), 'cloudatlas-does-not-exist', 'config')
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(
      tmpdir(),
      'cloudatlas-does-not-exist',
      'credentials',
    )
    expect(listLocalProfiles()).toEqual([])
  })
})
