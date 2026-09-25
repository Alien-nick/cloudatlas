import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Redactor } from '../aws/redact.js'
import { TranscriptWriter, type CaptureMeta, type TranscriptEntry } from '../aws/transcript.js'
import { automaticDenyWords, formatDenyFailure } from './deny.js'
import { gateAndWrite } from './write.js'

const ACCOUNT = '482177301192'
const PROFILE = 'cortex-audit'
const SECRET = 'acmecorp'

const created: string[] = []
function tempDir(): string {
  // Deliberately a path that does NOT exist yet, so "wrote nothing" is
  // observable as "the directory was never created".
  const base = mkdtempSync(join(tmpdir(), 'cloudatlas-gate-'))
  created.push(base)
  return join(base, 'capture-01')
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const META: CaptureMeta = {
  name: 'capture-01',
  capturedAt: '2026-09-20T00:00:00.000Z',
  regions: ['us-east-1'],
  totalWallMs: 1,
  totalCalls: 1,
  totalRetries: 0,
  totalThrottles: 0,
  totalResources: 1,
  unclassified: [],
  byRegion: {},
  target: { resources: 500, seconds: 60, projectedSeconds: 1, pass: true },
  redaction: { replaced: {}, keptTagKeys: [] },
  denyCheck: { wordsChecked: 0, allowedWords: [] },
}

function entry(output: unknown, patch: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    service: 'ec2',
    operation: 'DescribeInstances',
    region: 'us-east-1',
    input: {},
    output,
    durationMs: 1,
    ...patch,
  }
}

function materialize(entries: TranscriptEntry[], meta: CaptureMeta = META): Map<string, string> {
  const redacted = new Redactor().redactAll(entries)
  return TranscriptWriter.materialize(
    redacted,
    { name: meta.name, capturedAt: meta.capturedAt, regions: meta.regions, totalCalls: entries.length },
    meta,
  )
}

describe('the gate actually fails', () => {
  it('writes nothing when a deny word is buried in a nested tag value', () => {
    const dir = tempDir()
    // Nested three levels down, inside a tag value that keepNoTags is off for.
    const files = materialize([
      entry({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-0af22c9e13b7d4410',
                Tags: [{ Key: 'Name', Value: `${SECRET}-legacy-worker` }],
              },
            ],
          },
        ],
      }),
    ])

    const outcome = gateAndWrite({ dir, files, deny: [SECRET], allow: [] })

    expect(outcome.written).toBe(false)
    expect(outcome.result.hits.length).toBeGreaterThan(0)
    expect(outcome.result.hits[0]?.path).toContain('Tags')
    // The whole point: nothing on disk, not even a partial directory.
    expect(existsSync(dir)).toBe(false)
  })

  it('writes nothing when a deny word appears as an unquoted number', () => {
    const dir = tempDir()
    const files = materialize([entry({ Reservations: [{ OwnerId: 999988887777 }] })])

    const outcome = gateAndWrite({ dir, files, deny: ['999988887777'], allow: [] })

    expect(outcome.written).toBe(false)
    expect(outcome.result.hits[0]?.path).toContain('OwnerId')
    expect(existsSync(dir)).toBe(false)
  })

  it('writes nothing when the leak is only in meta.json', () => {
    const dir = tempDir()
    const files = materialize([entry({})], { ...META, name: `capture-for-${SECRET}` })

    const outcome = gateAndWrite({ dir, files, deny: [SECRET], allow: [] })

    expect(outcome.written).toBe(false)
    expect(new Set(outcome.result.hits.map((h) => h.file))).toEqual(
      new Set(['manifest.json', 'meta.json']),
    )
    expect(existsSync(dir)).toBe(false)
  })

  it('catches a principal ARN recorded in an AccessDenied error', () => {
    const dir = tempDir()
    const files = materialize([
      entry(null, {
        service: 'elasticache',
        operation: 'DescribeCacheClusters',
        error: {
          name: 'AccessDenied',
          message: `User: arn:aws:sts::${ACCOUNT}:assumed-role/${SECRET}-PlatformEng/x is not authorized to perform: elasticache:DescribeCacheClusters`,
        },
      }),
    ])

    // Redaction should already have removed it; the gate is the proof.
    const outcome = gateAndWrite({ dir, files, deny: [SECRET, ACCOUNT], allow: [] })
    expect(outcome.written).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  it('reports the failure without printing the secret', () => {
    const dir = tempDir()
    const files = materialize([entry({ Unmapped: `${SECRET}-internal` })])
    const outcome = gateAndWrite({ dir, files, deny: [SECRET], allow: [] })

    const message = formatDenyFailure(outcome.result)
    expect(message).toContain('DO NOT COMMIT')
    expect(message).not.toContain(`${SECRET}-internal`)
    expect(message).toContain('***REDACTED')
  })
})

describe('the gate lets clean captures through', () => {
  it('writes every file when nothing is denied', () => {
    const dir = tempDir()
    const files = materialize([
      entry({ Reservations: [{ OwnerId: ACCOUNT, Instances: [{ InstanceId: 'i-0af22c9e13b7' }] }] }),
      entry({ DBInstances: [] }, { service: 'rds', operation: 'DescribeDBInstances' }),
    ])

    const outcome = gateAndWrite({
      dir,
      files,
      deny: automaticDenyWords(ACCOUNT, [PROFILE]),
      allow: [],
    })

    expect(outcome.written).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['manifest.json', 'meta.json', 'us-east-1'])
    expect(readdirSync(join(dir, 'us-east-1')).sort()).toEqual([
      'ec2.DescribeInstances.json',
      'rds.DescribeDBInstances.json',
    ])
  })

  it('writes exactly the bytes that were scanned', () => {
    const dir = tempDir()
    const files = materialize([entry({ InstanceId: 'i-0af22c9e13b7' })])
    gateAndWrite({ dir, files, deny: [], allow: [] })

    for (const [relative, contents] of files) {
      expect(readFileSync(join(dir, relative), 'utf8')).toBe(contents)
    }
  })
})

describe('--allow-word', () => {
  it('suppresses a known false positive and writes the capture', () => {
    const dir = tempDir()
    const files = materialize([entry({ Unmapped: `${SECRET}-internal` })])

    const outcome = gateAndWrite({ dir, files, deny: [SECRET], allow: [SECRET] })

    expect(outcome.written).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  it('records the suppression so it cannot be forgotten', () => {
    const dir = tempDir()
    const files = materialize([entry({ Unmapped: `${SECRET}-internal` })])
    const outcome = gateAndWrite({ dir, files, deny: [SECRET], allow: [SECRET] })

    expect(outcome.result.suppressed).toEqual([SECRET])
    expect(outcome.result.checked).not.toContain(SECRET)
  })

  it('only suppresses the exact word, not neighbouring ones', () => {
    const dir = tempDir()
    const files = materialize([entry({ a: `${SECRET}-internal`, b: 'othercorp-internal' })])

    const outcome = gateAndWrite({
      dir,
      files,
      deny: [SECRET, 'othercorp'],
      allow: [SECRET],
    })

    expect(outcome.written).toBe(false)
    expect(outcome.result.hits.every((hit) => hit.word === 'othercorp')).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})
