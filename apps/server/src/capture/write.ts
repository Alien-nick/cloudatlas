import { existsSync } from 'node:fs'
import { TranscriptWriter } from '../aws/transcript.js'
import { scanForDenyWords, type DenyResult } from './deny.js'

export interface GateOptions {
  dir: string
  /** Relative path -> contents, exactly as they would be written. */
  files: Map<string, string>
  deny: string[]
  allow: string[]
}

export interface GateOutcome {
  written: boolean
  result: DenyResult
}

/**
 * The only path by which a capture reaches disk.
 *
 * Scanning happens on the in-memory file map, so a failing capture is never
 * written and then deleted — it is simply never written. Both the transcript
 * files and the generated `manifest.json` / `meta.json` are in the map, which
 * matters because an AccessDenied recorded during collection carries the
 * caller's principal ARN and the target resource name.
 */
export function gateAndWrite(options: GateOptions): GateOutcome {
  const result = scanForDenyWords({
    files: options.files,
    deny: options.deny,
    allow: options.allow,
  })

  if (result.hits.length > 0) return { written: false, result }

  TranscriptWriter.writeFiles(options.dir, options.files)
  return { written: true, result }
}

/** True when a capture directory already holds a written fixture. */
export function captureExists(dir: string): boolean {
  return existsSync(dir)
}
