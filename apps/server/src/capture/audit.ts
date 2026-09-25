/**
 * Read a written capture back for human review.
 *
 *   npm run capture:audit fixtures/capture-01
 *
 * Two outputs, in order of risk:
 *
 *  1. Every recorded error string, in full. An AccessDenied message is the
 *     densest PII in the corpus — principal ARN, SSO role, session name and
 *     often an email, in one string — so these are printed for reading rather
 *     than skimming.
 *  2. The unique string set, the equivalent of
 *     `jq -r '.. | strings' | sort -u`. The deny gate proves the absence of
 *     words we thought of; this is how the class nobody thought of gets found.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CaptureMeta } from '../aws/transcript.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

interface RecordedError {
  file: string
  service: string
  operation: string
  region: string
  name: string
  code?: string
  message: string
}

function jsonFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.json')) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

/** Every string in a parsed JSON value, including object keys. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value
    return
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    yield String(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* strings(item)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      yield key
      yield* strings(child)
    }
  }
}

function main(): void {
  const target = process.argv[2]
  if (!target) {
    console.error('\nUsage:\n  npm run capture:audit <capture-dir>\n')
    process.exit(1)
  }

  const dir = resolve(ROOT, target)
  if (!existsSync(dir)) {
    console.error(`\nNo capture at ${dir}\n`)
    process.exit(1)
  }

  const files = jsonFiles(dir)
  const errors: RecordedError[] = []
  const unique = new Set<string>()
  let meta: CaptureMeta | null = null

  for (const file of files) {
    const relativePath = relative(dir, file)
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown

    if (relativePath === 'meta.json') meta = parsed as CaptureMeta

    for (const text of strings(parsed)) unique.add(text)

    if (!Array.isArray(parsed)) continue
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const error = entry.error as RecordedError | undefined
      if (!error) continue
      errors.push({
        file: relativePath,
        service: String(entry.service ?? '?'),
        operation: String(entry.operation ?? '?'),
        region: String(entry.region ?? '?'),
        name: error.name,
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
      })
    }
  }

  console.log(`\nCapture: ${dir}`)
  console.log(`Files: ${files.length} · unique strings: ${unique.size}`)
  if (meta) {
    console.log(
      `Captured ${meta.capturedAt} · ${meta.regions.join(', ')} · ` +
        `${meta.totalResources} resources · ${meta.totalCalls} calls`,
    )
    if (meta.redaction.keptTagKeys.length > 0) {
      console.log(`Tag values kept unredacted: ${meta.redaction.keptTagKeys.join(', ')}`)
    }
  }

  // --- 1. recorded errors, in full ---------------------------------------
  console.log(`\n${'='.repeat(72)}`)
  console.log('RECORDED ERROR STRINGS — read these closely')
  console.log('='.repeat(72))

  if (errors.length === 0) {
    console.log('\n  None. No call failed during this capture.')
  } else {
    for (const error of errors) {
      console.log(
        `\n  ${error.service}:${error.operation} · ${error.region} · ` +
          `${error.name}${error.code ? ` / ${error.code}` : ''}`,
      )
      console.log(`  ${error.file}`)
      console.log(`  ${'-'.repeat(68)}`)
      console.log(`  ${error.message}`)
    }
  }

  const unclassified = meta?.unclassified ?? []
  console.log(`\n${'-'.repeat(72)}`)
  if (unclassified.length === 0) {
    console.log('UNCLASSIFIED: none — every failure was recognised.')
  } else {
    console.log(`UNCLASSIFIED: ${unclassified.length} failure(s) matched no classifier.`)
    console.log('If any of these is really a permission denial, teach errors.ts its shape:\n')
    for (const failure of unclassified) {
      console.log(
        `  ${failure.service}:${failure.operation} · ${failure.region} · ` +
          `${failure.errorName}${failure.errorCode ? ` / ${failure.errorCode}` : ''}`,
      )
      console.log(`    ${failure.message}`)
    }
  }

  // --- 2. unique string set ----------------------------------------------
  console.log(`\n${'='.repeat(72)}`)
  console.log(`UNIQUE STRINGS (${unique.size}) — skim for anything that should not be public`)
  console.log('='.repeat(72) + '\n')

  for (const text of [...unique].sort((a, b) => a.localeCompare(b))) {
    console.log(text)
  }
}

main()
