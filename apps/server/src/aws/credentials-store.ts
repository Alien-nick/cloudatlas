import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AddCredentialsRequest, AddCredentialsResponse, Identity } from '@cloudatlas/shared'
import { AwsClient } from './client.js'
import { getIdentity } from './identity.js'
import { awsConfigPaths, listLocalProfiles } from './profiles.js'

/**
 * Saving access keys the user typed in, for a machine with no AWS profile.
 *
 * The one place CloudAtlas handles key material, so the rules are narrow:
 *
 *   - Keys are verified with sts:GetCallerIdentity *before* anything touches
 *     disk. Keys that do not work are never written.
 *   - They are written only to the AWS shared credentials file, as a named
 *     profile, exactly as `aws configure` would — owner-read-write only. From
 *     then on they are an ordinary profile, resolved by the SDK's own chain
 *     like every other.
 *   - Existing profiles are never overwritten, and existing file content is
 *     never rewritten: the new section is appended.
 *   - Nothing here returns, logs or stores the keys anywhere else. The
 *     response carries the profile name and the verified identity.
 *
 * This file writes to the local filesystem, not to AWS. The read-only
 * guarantee is about AWS APIs, and verification goes through the same guarded
 * client as everything else.
 */

export class CredentialsError extends Error {
  constructor(
    message: string,
    /** HTTP status the route should answer with. */
    readonly status: 400 | 409 | 502,
    readonly code: string,
  ) {
    super(message)
    this.name = 'CredentialsError'
  }
}

/** AWS error names meaning "these keys are wrong", mapped to what to do about it. */
const REJECTED: Record<string, string> = {
  InvalidClientTokenId: 'AWS does not recognise this access key ID. Check it was copied in full.',
  UnrecognizedClientException: 'AWS does not recognise this access key ID. Check it was copied in full.',
  InvalidAccessKeyId: 'AWS does not recognise this access key ID. Check it was copied in full.',
  SignatureDoesNotMatch: 'The secret access key does not match this access key ID.',
  IncompleteSignature: 'The secret access key does not match this access key ID.',
  ExpiredToken: 'These temporary keys have expired. Generate new ones and try again.',
  ExpiredTokenException: 'These temporary keys have expired. Generate new ones and try again.',
  InvalidToken: 'The session token is not valid for these keys.',
}

/** Check the keys against AWS without saving them anywhere. */
export async function verifyAccessKeys(keys: AddCredentialsRequest): Promise<Identity> {
  const aws = new AwsClient({
    profile: keys.profile,
    mode: 'live',
    staticCredentials: {
      accessKeyId: keys.accessKeyId,
      secretAccessKey: keys.secretAccessKey,
      ...(keys.sessionToken ? { sessionToken: keys.sessionToken } : {}),
    },
  })
  try {
    return await getIdentity(aws, keys.profile, keys.region)
  } catch (error) {
    const name = (error as { errorName?: string; name?: string }).errorName ?? (error as Error).name
    const known = REJECTED[name]
    if (known) throw new CredentialsError(known, 400, 'KEYS_REJECTED')
    // Deliberately not echoing the SDK message: it is not needed to act on,
    // and not passing it through means nothing about the request leaks.
    throw new CredentialsError(
      `Could not verify the keys with AWS (${name}). Check your network connection and try again.`,
      502,
      'VERIFY_FAILED',
    )
  } finally {
    await aws.destroy()
  }
}

function endsWithNewline(path: string): boolean {
  if (!existsSync(path)) return true
  const content = readFileSync(path, 'utf8')
  return content.length === 0 || content.endsWith('\n')
}

/**
 * Append an INI section, creating the file owner-only if it does not exist.
 * Appending rather than rewriting means an existing file's other profiles,
 * comments and formatting are untouched even if this process dies mid-write.
 */
function appendSection(path: string, header: string, entries: Array<[string, string]>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const created = !existsSync(path)
  const lines = [`[${header}]`, ...entries.map(([key, value]) => `${key} = ${value}`)]
  const block = `${endsWithNewline(path) ? '' : '\n'}${created ? '' : '\n'}${lines.join('\n')}\n`
  appendFileSync(path, block, { mode: 0o600 })
  // `mode` applies only on creation; an existing file keeps its permissions.
  if (created) chmodSync(path, 0o600)
}

/** Write the profile to the shared credentials and config files. */
export function saveProfile(keys: AddCredentialsRequest): { credentialsPath: string } {
  if (listLocalProfiles().some((profile) => profile.name === keys.profile)) {
    throw new CredentialsError(
      `A profile named "${keys.profile}" already exists. Choose another name.`,
      409,
      'PROFILE_EXISTS',
    )
  }

  const paths = awsConfigPaths()
  appendSection(paths.credentials, keys.profile, [
    ['aws_access_key_id', keys.accessKeyId],
    ['aws_secret_access_key', keys.secretAccessKey],
    ...(keys.sessionToken ? ([['aws_session_token', keys.sessionToken]] as Array<[string, string]>) : []),
  ])
  // The config file names non-default profiles "profile <name>".
  appendSection(paths.config, keys.profile === 'default' ? 'default' : `profile ${keys.profile}`, [
    ['region', keys.region],
  ])
  return { credentialsPath: paths.credentials }
}

export interface AddAccessKeysDeps {
  verify?: typeof verifyAccessKeys
  save?: typeof saveProfile
}

/** Verify, then save. Nothing is written unless AWS accepted the keys. */
export async function addAccessKeys(
  keys: AddCredentialsRequest,
  deps: AddAccessKeysDeps = {},
): Promise<AddCredentialsResponse> {
  const verify = deps.verify ?? verifyAccessKeys
  const save = deps.save ?? saveProfile

  // Checked up front as well as at save time, so a name clash is reported
  // before a network round trip rather than after it.
  if (listLocalProfiles().some((profile) => profile.name === keys.profile)) {
    throw new CredentialsError(
      `A profile named "${keys.profile}" already exists. Choose another name.`,
      409,
      'PROFILE_EXISTS',
    )
  }

  const identity = await verify(keys)
  const { credentialsPath } = save(keys)
  return { profile: keys.profile, identity: { ...identity, profile: keys.profile }, credentialsPath }
}
