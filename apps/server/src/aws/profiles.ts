import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Profile } from '@cloudatlas/shared'

/**
 * Keys we are willing to read out of the AWS config files. Credentials
 * (aws_access_key_id, aws_secret_access_key, aws_session_token) are
 * deliberately absent: CloudAtlas never reads, stores or forwards them — the
 * SDK's own credential chain resolves them inside this process.
 */
const ALLOWED_KEYS = new Set(['region', 'sso_start_url', 'sso_session', 'sso_account_id'])

interface IniSection {
  name: string
  values: Record<string, string>
}

function parseIni(content: string): IniSection[] {
  const sections: IniSection[] = []
  let current: IniSection | null = null

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    const header = /^\[(.+)\]$/.exec(line)
    if (header?.[1]) {
      current = { name: header[1].trim(), values: {} }
      sections.push(current)
      continue
    }

    if (!current) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    if (!ALLOWED_KEYS.has(key)) continue
    current.values[key] = line.slice(eq + 1).trim()
  }

  return sections
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function awsConfigPaths(): { config: string; credentials: string } {
  const home = homedir()
  return {
    config: process.env.AWS_CONFIG_FILE ?? join(home, '.aws', 'config'),
    credentials: process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, '.aws', 'credentials'),
  }
}

/**
 * Profile names from ~/.aws/config and ~/.aws/credentials. Only names, regions
 * and SSO markers leave this function.
 */
export function listLocalProfiles(): Profile[] {
  const paths = awsConfigPaths()
  const merged = new Map<string, Profile>()

  const configContent = readIfPresent(paths.config)
  if (configContent) {
    for (const section of parseIni(configContent)) {
      // "[profile foo]" and "[default]"; "[sso-session foo]" is not a profile.
      if (section.name.startsWith('sso-session')) continue
      const name = section.name === 'default' ? 'default' : section.name.replace(/^profile\s+/, '')
      if (name === section.name && name !== 'default') continue // malformed header
      merged.set(name, {
        name,
        region: section.values.region ?? null,
        sso: Boolean(section.values.sso_start_url ?? section.values.sso_session),
        source: 'config',
      })
    }
  }

  const credentialsContent = readIfPresent(paths.credentials)
  if (credentialsContent) {
    for (const section of parseIni(credentialsContent)) {
      const existing = merged.get(section.name)
      if (existing) {
        merged.set(section.name, { ...existing, source: 'both' })
      } else {
        merged.set(section.name, {
          name: section.name,
          region: section.values.region ?? null,
          sso: false,
          source: 'credentials',
        })
      }
    }
  }

  return [...merged.values()].sort((a, b) => {
    if (a.name === 'default') return -1
    if (b.name === 'default') return 1
    return a.name.localeCompare(b.name)
  })
}

export const __testing = { parseIni }
