import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The postcondition on redaction.
 *
 * Replay verification proves the fixture still *builds the same graph*. It
 * proves nothing about whether redaction happened — component-wise substitution
 * is a blocklist, so anything that matches no known pattern passes through
 * verbatim. This scans the finished, serialised fixture for strings that must
 * not appear in it, and refuses to let the capture be written if any are found.
 *
 * It is the last gate before bytes hit the disk, so it runs over exactly what
 * would be written: every file, every nested value, keys included.
 */

export interface DenyConfig {
  deny: string[]
  allow: string[]
}

export interface DenyHit {
  /** Path of the file, relative to the capture directory. */
  file: string
  /** JSON path within that file, e.g. `[3].output.Reservations.Instances.Tags`. */
  path: string
  /** The deny word that matched, as configured. */
  word: string
  /** Surrounding text with the match itself masked. */
  excerpt: string
}

export interface DenyResult {
  hits: DenyHit[]
  /** Words actually checked, after auto-additions and allow-list removal. */
  checked: string[]
  /** Allow-list entries that suppressed a word. */
  suppressed: string[]
}

const CONFIG_FILE = 'capture.deny.json'

export function loadDenyConfig(rootDir: string): DenyConfig {
  const path = resolve(rootDir, CONFIG_FILE)
  if (!existsSync(path)) return { deny: [], allow: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DenyConfig>
    return {
      deny: (parsed.deny ?? []).filter((word) => typeof word === 'string'),
      allow: (parsed.allow ?? []).filter((word) => typeof word === 'string'),
    }
  } catch (error) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`)
  }
}

/**
 * Words that are always checked, whether or not anyone remembered to configure
 * them: the real account id in both the raw and dash-grouped forms the UI uses,
 * and every profile name involved in the capture.
 */
export function automaticDenyWords(accountId: string, profiles: string[]): string[] {
  const words = new Set<string>()
  if (accountId && accountId !== 'unknown') {
    words.add(accountId)
    const dashed = accountId.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3')
    if (dashed !== accountId) words.add(dashed)
  }
  for (const profile of profiles) {
    if (profile && profile.length >= 3) words.add(profile)
  }
  return [...words]
}

function maskMatch(haystack: string, index: number, length: number, context = 48): string {
  const start = Math.max(0, index - context)
  const end = Math.min(haystack.length, index + length + context)
  const before = haystack.slice(start, index)
  const after = haystack.slice(index + length, end)
  const lead = start > 0 ? '…' : ''
  const tail = end < haystack.length ? '…' : ''
  // The whole point is to report a leak without printing the secret.
  return `${lead}${before}***REDACTED(${length})***${after}${tail}`
}

/** Walk a parsed JSON value, yielding every string with its JSON path. */
function* walkStrings(value: unknown, path = ''): Generator<{ path: string; text: string }> {
  if (typeof value === 'string') {
    yield { path, text: value }
    return
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    // A 12-digit account id can legitimately arrive as a number.
    yield { path, text: String(value) }
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* walkStrings(item, `${path}[${index}]`)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Keys are checked too: a bucket name can be a map key.
      yield { path: path ? `${path}.${key}` : key, text: key }
      yield* walkStrings(child, path ? `${path}.${key}` : key)
    }
  }
}

export interface ScanOptions {
  /** Relative file path -> file contents, exactly as they would be written. */
  files: Map<string, string>
  deny: string[]
  allow: string[]
}

/**
 * Case-insensitive substring scan. Substring rather than word-boundary on
 * purpose: an account id embedded in an ARN, or an org name inside a longer
 * identifier, is exactly what we are looking for.
 */
export function scanForDenyWords(options: ScanOptions): DenyResult {
  const allowLower = new Set(options.allow.map((word) => word.toLowerCase()))
  const suppressed: string[] = []
  const checked: string[] = []

  for (const word of new Set(options.deny)) {
    if (!word) continue
    if (allowLower.has(word.toLowerCase())) {
      suppressed.push(word)
      continue
    }
    checked.push(word)
  }

  const hits: DenyHit[] = []
  const needles = checked.map((word) => ({ word, lower: word.toLowerCase() }))
  if (needles.length === 0) return { hits, checked, suppressed }

  for (const [file, contents] of options.files) {
    // Cheap pre-filter: if the whole file does not contain the word, skip the
    // structural walk entirely.
    const contentsLower = contents.toLowerCase()
    const present = needles.filter(({ lower }) => contentsLower.includes(lower))
    if (present.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(contents)
    } catch {
      // Unparseable output should never happen, but a raw scan still beats
      // skipping the file.
      for (const { word, lower } of present) {
        const index = contentsLower.indexOf(lower)
        hits.push({ file, path: '(unparsed)', word, excerpt: maskMatch(contents, index, word.length) })
      }
      continue
    }

    for (const { path, text } of walkStrings(parsed)) {
      const lowerText = text.toLowerCase()
      for (const { word, lower } of present) {
        const index = lowerText.indexOf(lower)
        if (index === -1) continue
        hits.push({ file, path: path || '(root)', word, excerpt: maskMatch(text, index, word.length) })
      }
    }
  }

  return { hits, checked, suppressed }
}

/** Human-readable failure report. Never prints the matched value itself. */
export function formatDenyFailure(result: DenyResult): string {
  const lines: string[] = []
  lines.push('')
  lines.push('╔════════════════════════════════════════════════════════════════╗')
  lines.push('║  DO NOT COMMIT — sensitive values survived redaction           ║')
  lines.push('╚════════════════════════════════════════════════════════════════╝')
  lines.push('')
  lines.push(`${result.hits.length} match${result.hits.length === 1 ? '' : 'es'}. Nothing was written to disk.`)
  lines.push('')

  const byWord = new Map<string, DenyHit[]>()
  for (const hit of result.hits) {
    const list = byWord.get(hit.word) ?? []
    list.push(hit)
    byWord.set(hit.word, list)
  }

  for (const [word, hits] of byWord) {
    lines.push(`  deny word "${word}" — ${hits.length} occurrence${hits.length === 1 ? '' : 's'}`)
    for (const hit of hits.slice(0, 5)) {
      lines.push(`    ${hit.file}`)
      lines.push(`      at ${hit.path}`)
      lines.push(`      ${hit.excerpt}`)
    }
    if (hits.length > 5) lines.push(`    … and ${hits.length - 5} more`)
    lines.push('')
  }

  lines.push('Fix by either:')
  lines.push('  - adding the field class to apps/server/src/aws/redact.ts, or')
  lines.push('  - passing --allow-word <value> if this is genuinely safe to publish.')
  return lines.join('\n')
}
