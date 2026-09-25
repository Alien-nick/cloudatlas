import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UnclassifiedFailure } from './client.js'
import { TranscriptExhaustedError } from './errors.js'

/**
 * A recorded API exchange. Inputs are kept so a capture can be inspected and
 * diffed by a human before it is committed — that review is the whole point of
 * the capture workflow.
 */
export interface TranscriptEntry {
  service: string
  operation: string
  region: string
  input: unknown
  output: unknown
  /** Milliseconds the live call took. */
  durationMs: number
  /** Set when the call failed; `output` is then null. */
  error?: { name: string; message: string; code?: string }
}

/** Minimal contract replay needs. Telemetry lives in meta.json. */
export interface TranscriptManifest {
  name: string
  /** ISO timestamp of the capture. */
  capturedAt: string
  regions: string[]
  totalCalls: number
}

export interface RegionTelemetry {
  /** Wall clock from the first collector starting to the last finishing. */
  wallMs: number
  /** Summed time inside API calls; exceeds wallMs when calls overlap. */
  apiMs: number
  calls: number
  callsByAction: Record<string, number>
  retries: number
  throttles: number
  accessDenied: string[]
  /** AWS failures no classifier recognised. Empty is the expected state. */
  unclassified: UnclassifiedFailure[]
  resourceCount: number
}

/**
 * Everything measured during the capture. Written to meta.json so the
 * performance target is a recorded number rather than console output that
 * scrolls away.
 */
export interface CaptureMeta {
  name: string
  capturedAt: string
  regions: string[]
  totalWallMs: number
  totalCalls: number
  totalRetries: number
  totalThrottles: number
  totalResources: number
  /**
   * Every AWS failure that matched no classifier, across all regions. Surfaced
   * at the top level because an empty list is the thing to check for, and a
   * non-empty one names the error shapes we still need to teach the classifier.
   */
  unclassified: UnclassifiedFailure[]
  byRegion: Record<string, RegionTelemetry>
  target: {
    resources: number
    seconds: number
    /** Measured rate scaled to the target resource count. */
    projectedSeconds: number
    pass: boolean
  }
  redaction: {
    replaced: Record<string, number>
    keptTagKeys: string[]
  }
  denyCheck: {
    wordsChecked: number
    allowedWords: string[]
  }
}

/**
 * Replay reads responses in the order they were recorded, per
 * (region, service, operation). Pagination is inherently sequential, and every
 * other repeated call follows a deterministic iteration order, so ordering is
 * stable without having to hash opaque tokens that redaction rewrites anyway.
 */
export class TranscriptReader {
  private readonly queues = new Map<string, TranscriptEntry[]>()
  private readonly cursors = new Map<string, number>()
  readonly manifest: TranscriptManifest | null

  constructor(private readonly dir: string) {
    this.manifest = this.readManifest()
    this.load()
  }

  private readManifest(): TranscriptManifest | null {
    const path = join(this.dir, 'manifest.json')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as TranscriptManifest
  }

  private load(): void {
    if (!existsSync(this.dir)) {
      throw new Error(`No capture directory at ${this.dir}`)
    }
    for (const region of readdirSync(this.dir, { withFileTypes: true })) {
      if (!region.isDirectory()) continue
      const regionDir = join(this.dir, region.name)
      for (const file of readdirSync(regionDir)) {
        if (!file.endsWith('.json')) continue
        const entries = JSON.parse(readFileSync(join(regionDir, file), 'utf8')) as TranscriptEntry[]
        if (entries.length === 0) continue
        const first = entries[0]
        if (!first) continue
        this.queues.set(keyOf(region.name, first.service, first.operation), entries)
      }
    }
  }

  /** Next recorded response, or throw with a message that says what to do. */
  next(region: string, service: string, operation: string): unknown {
    const key = keyOf(region, service, operation)
    const queue = this.queues.get(key)
    const cursor = this.cursors.get(key) ?? 0
    const entry = queue?.[cursor]
    if (!entry) throw new TranscriptExhaustedError(service, operation, region)
    this.cursors.set(key, cursor + 1)
    if (entry.error) {
      const error = new Error(entry.error.message)
      error.name = entry.error.name
      // The code has to be restored, not just the name. Several services carry
      // the denial signal in `Code` while `name` is a generic service
      // exception — dropping it would make a recorded AccessDenied replay as
      // "unclassified", which is precisely the fixture the warning UI is built
      // against.
      if (entry.error.code) Object.assign(error, { Code: entry.error.code })
      throw error
    }
    return entry.output
  }

  /** Recorded calls that replay never consumed — a sign the collectors changed. */
  unconsumed(): Array<{ key: string; remaining: number }> {
    const out: Array<{ key: string; remaining: number }> = []
    for (const [key, queue] of this.queues) {
      const used = this.cursors.get(key) ?? 0
      if (used < queue.length) out.push({ key, remaining: queue.length - used })
    }
    return out
  }

  get regions(): string[] {
    return this.manifest?.regions ?? []
  }
}

/** Accumulates a capture in memory; redaction and writing happen at the end. */
export class TranscriptWriter {
  private readonly entries: TranscriptEntry[] = []

  record(entry: TranscriptEntry): void {
    this.entries.push(entry)
  }

  all(): readonly TranscriptEntry[] {
    return this.entries
  }

  /**
   * Render the capture as a relative-path -> contents map, without writing
   * anything. The deny-word postcondition scans exactly these bytes, so a
   * failing capture never reaches the filesystem at all — there is no window
   * in which unredacted data sits on disk waiting to be deleted.
   */
  static materialize(
    entries: readonly TranscriptEntry[],
    manifest: TranscriptManifest,
    meta: CaptureMeta,
  ): Map<string, string> {
    const grouped = new Map<string, TranscriptEntry[]>()
    for (const entry of entries) {
      const key = `${entry.region}/${entry.service}.${entry.operation}.json`
      const list = grouped.get(key)
      if (list) list.push(entry)
      else grouped.set(key, [entry])
    }

    const files = new Map<string, string>()
    for (const [path, list] of grouped) {
      files.set(path, `${JSON.stringify(list, null, 2)}\n`)
    }
    files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    files.set('meta.json', `${JSON.stringify(meta, null, 2)}\n`)
    return files
  }

  /** Commit a materialised capture to disk. Call only after the deny check. */
  static writeFiles(dir: string, files: Map<string, string>): void {
    mkdirSync(dir, { recursive: true })
    for (const [relative, contents] of files) {
      const full = join(dir, relative)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, contents)
    }
  }
}

function keyOf(region: string, service: string, operation: string): string {
  return `${region}|${service}|${operation}`
}
