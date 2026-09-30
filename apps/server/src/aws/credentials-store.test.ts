import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addCredentialsRequestSchema, type Identity } from '@cloudatlas/shared'

vi.mock('./identity.js', () => ({ getIdentity: vi.fn() }))
const { getIdentity } = await import('./identity.js')
const { CredentialsError, addAccessKeys, verifyAccessKeys } = await import('./credentials-store.js')
const { listLocalProfiles } = await import('./profiles.js')

// AWS's own documentation example keys: shaped like real ones, valid nowhere.
const EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
}
const IDENTITY: Identity = {
  accountId: '111122223333',
  accountAlias: null,
  arn: 'arn:aws:iam::111122223333:user/reader',
  userId: 'AIDAEXAMPLE',
  profile: 'cloudatlas',
}
const accepted = async () => IDENTITY

let dir: string
let credentials: string
let config: string

beforeEach(() => {
  // Point the SDK-compatible paths at a scratch directory: these tests must
  // never read or write the real ~/.aws.
  dir = mkdtempSync(join(tmpdir(), 'cloudatlas-creds-'))
  credentials = join(dir, 'credentials')
  config = join(dir, 'config')
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentials)
  vi.stubEnv('AWS_CONFIG_FILE', config)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('the request schema', () => {
  it('defaults the profile and region', () => {
    expect(addCredentialsRequestSchema.parse(EXAMPLE)).toMatchObject({ profile: 'cloudatlas', region: 'us-east-1' })
  })

  it('rejects a malformed key without echoing it', () => {
    const result = addCredentialsRequestSchema.safeParse({ ...EXAMPLE, accessKeyId: 'not-a-key' })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).not.toContain(EXAMPLE.secretAccessKey)
  })

  it('requires the session token for temporary keys', () => {
    const temporary = { ...EXAMPLE, accessKeyId: 'ASIAIOSFODNN7EXAMPLE' }
    expect(addCredentialsRequestSchema.safeParse(temporary).success).toBe(false)
    expect(addCredentialsRequestSchema.safeParse({ ...temporary, sessionToken: 'token' }).success).toBe(true)
  })

  it('refuses a profile name that could break out of an INI header', () => {
    expect(addCredentialsRequestSchema.safeParse({ ...EXAMPLE, profile: 'x]\n[default' }).success).toBe(false)
  })
})

describe('addAccessKeys', () => {
  const keys = () => addCredentialsRequestSchema.parse({ ...EXAMPLE, region: 'eu-west-1' })

  it('writes a profile the SDK and the profile list can read, owner-only', async () => {
    const result = await addAccessKeys(keys(), { verify: accepted })

    expect(result).toEqual({ profile: 'cloudatlas', identity: IDENTITY, credentialsPath: credentials })
    expect(readFileSync(credentials, 'utf8')).toBe(
      `[cloudatlas]\naws_access_key_id = ${EXAMPLE.accessKeyId}\naws_secret_access_key = ${EXAMPLE.secretAccessKey}\n`,
    )
    expect(readFileSync(config, 'utf8')).toBe('[profile cloudatlas]\nregion = eu-west-1\n')
    expect(statSync(credentials).mode & 0o777).toBe(0o600)
    expect(listLocalProfiles().map((profile) => profile.name)).toContain('cloudatlas')
  })

  it('never returns the keys', async () => {
    const serialized = JSON.stringify(await addAccessKeys(keys(), { verify: accepted }))
    expect(serialized).not.toContain(EXAMPLE.secretAccessKey)
    expect(serialized).not.toContain(EXAMPLE.accessKeyId)
  })

  it('appends to an existing file without touching what is there', async () => {
    const existing = '# managed by hand\n[work]\naws_access_key_id = existing-value'
    writeFileSync(credentials, existing)
    await addAccessKeys(keys(), { verify: accepted })
    const content = readFileSync(credentials, 'utf8')
    expect(content.startsWith(`${existing}\n\n[cloudatlas]\n`)).toBe(true)
  })

  it('writes nothing when AWS rejects the keys', async () => {
    const rejected = async () => {
      throw new CredentialsError('rejected', 400, 'KEYS_REJECTED')
    }
    await expect(addAccessKeys(keys(), { verify: rejected })).rejects.toThrow('rejected')
    expect(existsSync(credentials)).toBe(false)
    expect(existsSync(config)).toBe(false)
  })

  it('refuses to overwrite an existing profile, before calling AWS', async () => {
    writeFileSync(credentials, '[cloudatlas]\naws_access_key_id = existing-value\n')
    const verify = vi.fn(accepted)
    await expect(addAccessKeys(keys(), { verify })).rejects.toMatchObject({ status: 409, code: 'PROFILE_EXISTS' })
    expect(verify).not.toHaveBeenCalled()
    expect(readFileSync(credentials, 'utf8')).toBe('[cloudatlas]\naws_access_key_id = existing-value\n')
  })

  it('names the default profile the way the config file expects', async () => {
    await addAccessKeys(addCredentialsRequestSchema.parse({ ...EXAMPLE, profile: 'default' }), { verify: accepted })
    expect(readFileSync(config, 'utf8')).toBe('[default]\nregion = us-east-1\n')
  })

  it('writes the session token for temporary keys', async () => {
    const temporary = addCredentialsRequestSchema.parse({
      ...EXAMPLE,
      accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      sessionToken: 'FwoGZXIvYXdzEXAMPLE',
    })
    await addAccessKeys(temporary, { verify: accepted })
    expect(readFileSync(credentials, 'utf8')).toContain('aws_session_token = FwoGZXIvYXdzEXAMPLE\n')
  })
})

describe('verifyAccessKeys', () => {
  const keys = () => addCredentialsRequestSchema.parse(EXAMPLE)

  it('turns a wrong secret into a message that says so', async () => {
    vi.mocked(getIdentity).mockRejectedValueOnce(Object.assign(new Error('x'), { errorName: 'SignatureDoesNotMatch' }))
    await expect(verifyAccessKeys(keys())).rejects.toMatchObject({
      status: 400,
      message: 'The secret access key does not match this access key ID.',
    })
  })

  it('does not pass an unexpected AWS message through', async () => {
    vi.mocked(getIdentity).mockRejectedValueOnce(new Error(`request with ${EXAMPLE.accessKeyId} failed`))
    const error = (await verifyAccessKeys(keys()).then(
      () => new Error('expected a rejection'),
      (caught: Error) => caught,
    )) as Error
    expect(error).toMatchObject({ status: 502, code: 'VERIFY_FAILED' })
    expect(error.message).not.toContain(EXAMPLE.accessKeyId)
  })
})
