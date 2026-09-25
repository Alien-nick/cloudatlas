/**
 * Structurally compare two captures.
 *
 *   npm run capture:diff fixtures/capture-01 fixtures/capture-02
 *
 * Runs in three stages, because "the graphs differ" has three possible causes
 * and they need separating before either fixture is pinned:
 *
 *   1. **Self-diff.** Each capture is replayed and built twice, and the two
 *      results compared. A capture cannot drift against itself, so any
 *      difference here is nondeterminism in the collectors or the builders.
 *      This has to be empty before stage 3 means anything.
 *   2. **Inventory.** Node counts by type and edge counts by kind, side by side.
 *   3. **Cross-diff**, with every removal attributed to a denied permission
 *      where one accounts for it. What is left over is real account drift — or
 *      a bug — and is the only part that should need thinking about.
 */
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Graph } from '@cloudatlas/shared'
import { attribute, diffGraphs, isIdentical, type GraphDiff } from './diff.js'
import { replayCapture, type ReplayResult } from './replay.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

function pad(value: string | number, width: number): string {
  return String(value).padStart(width)
}

function reportChanges(label: string, changes: GraphDiff['structuralChanges'], limit = 12): void {
  if (changes.length === 0) return
  console.log(`\n  ${label} (${changes.length})`)
  for (const change of changes.slice(0, limit)) {
    console.log(`    ${change.id}`)
    console.log(`      ${change.field}: ${change.before} → ${change.after}`)
  }
  if (changes.length > limit) console.log(`    … and ${changes.length - limit} more`)
}

async function selfDiff(dir: string, label: string): Promise<{ ok: boolean; graph: Graph; replay: ReplayResult }> {
  const first = await replayCapture(dir)
  const second = await replayCapture(dir)
  const diff = diffGraphs(first.graph, second.graph)
  const ok = isIdentical(diff)

  console.log(
    `  ${label.padEnd(24)} ${ok ? 'IDENTICAL across two builds' : 'NONDETERMINISTIC'}`,
  )

  if (!ok) {
    console.log('')
    console.log('    A capture cannot drift against itself. Every difference below is')
    console.log('    nondeterminism in the collectors or builders — unstable ordering,')
    console.log('    iteration order leaking into an id, or runtime state in a')
    console.log('    structural field.')
    reportChanges('structural', diff.structuralChanges)
    reportChanges('runtime', diff.runtimeChanges)
    reportChanges('edge meta', diff.edgeMetaChanges)
    if (diff.addedNodes.length > 0 || diff.removedNodes.length > 0) {
      console.log(
        `\n    nodes differ: +${diff.addedNodes.length} / -${diff.removedNodes.length}`,
      )
    }
    if (diff.addedEdges.length > 0 || diff.removedEdges.length > 0) {
      console.log(
        `    edges differ: +${diff.addedEdges.length} / -${diff.removedEdges.length}`,
      )
    }
  }

  return { ok, graph: first.graph, replay: first }
}

async function main(): Promise<void> {
  const [a, b] = process.argv.slice(2)
  if (!a || !b) {
    console.error('\nUsage:\n  npm run capture:diff <dirA> <dirB>\n')
    process.exit(1)
  }

  const dirA = resolve(ROOT, a)
  const dirB = resolve(ROOT, b)
  // Repo-relative when it is inside the repo, otherwise just the folder name —
  // a wall of ../.. helps nobody.
  const label = (dir: string): string => {
    const rel = relative(ROOT, dir)
    return rel.startsWith('..') ? basename(dir) : rel
  }
  const labelA = label(dirA)
  const labelB = label(dirB)

  // --- 1. nondeterminism -------------------------------------------------
  console.log('\n─── self-diff (nondeterminism check) ───')
  const left = await selfDiff(dirA, labelA)
  const right = await selfDiff(dirB, labelB)

  if (!left.ok || !right.ok) {
    console.error('\nStop here. Fix the nondeterminism before comparing the two captures —')
    console.error('until it is gone, a cross-diff cannot tell drift from noise.')
    process.exit(1)
  }

  for (const [label, replay] of [
    [labelA, left.replay],
    [labelB, right.replay],
  ] as const) {
    if (replay.unconsumed.length > 0) {
      console.log(`\n  ${label}: ${replay.unconsumed.length} recorded call(s) never replayed`)
      for (const entry of replay.unconsumed.slice(0, 8)) {
        console.log(`    ${entry.key} (${entry.remaining} left)`)
      }
      console.log('    The collectors make fewer calls than the capture holds.')
    }
  }

  // --- 2. inventory ------------------------------------------------------
  const diff = diffGraphs(left.graph, right.graph)

  const columnWidth = Math.max(12, labelA.length, labelB.length)
  console.log(`\n─── inventory ───`)
  console.log(
    `  ${'type'.padEnd(18)} ${pad(labelA, columnWidth)} ${pad(labelB, columnWidth)}   delta`,
  )
  for (const [type, [before, after]] of Object.entries(diff.nodeCountsByType).sort()) {
    const delta = after - before
    console.log(
      `  ${type.padEnd(18)} ${pad(before, 12)} ${pad(after, 12)}   ${delta === 0 ? '·' : delta > 0 ? `+${delta}` : delta}`,
    )
  }
  console.log('')
  for (const [kind, [before, after]] of Object.entries(diff.edgeCountsByKind).sort()) {
    const delta = after - before
    console.log(
      `  ${`${kind} edges`.padEnd(18)} ${pad(before, 12)} ${pad(after, 12)}   ${delta === 0 ? '·' : delta > 0 ? `+${delta}` : delta}`,
    )
  }

  // --- 3. permissions and attribution -----------------------------------
  const deniedA = [...new Set(left.replay.warnings.map((w) => w.action))].sort()
  const deniedB = [...new Set(right.replay.warnings.map((w) => w.action))].sort()
  const newlyDenied = deniedB.filter((action) => !deniedA.includes(action))

  console.log('\n─── missing permissions ───')
  console.log(`  ${labelA}: ${deniedA.length > 0 ? deniedA.join(', ') : 'none'}`)
  console.log(`  ${labelB}: ${deniedB.length > 0 ? deniedB.join(', ') : 'none'}`)

  const unclassifiedA = left.replay.unclassified
  const unclassifiedB = right.replay.unclassified
  if (unclassifiedA.length > 0 || unclassifiedB.length > 0) {
    console.log('\n─── unclassified failures ───')
    for (const [label, list] of [
      [labelA, unclassifiedA],
      [labelB, unclassifiedB],
    ] as const) {
      for (const failure of list) {
        console.log(
          `  ${label}: ${failure.service}:${failure.operation} · ${failure.errorName}` +
            `${failure.errorCode ? ` / ${failure.errorCode}` : ''}`,
        )
      }
    }
  }

  const { explained, unexplained } = attribute(diff, newlyDenied)

  if (explained.length > 0) {
    console.log('\n─── explained by the narrowed policy ───')
    for (const line of explained) console.log(`  ${line}`)
  }

  // Redaction numbers its fakes in encounter order, so a denied call that
  // shortens the sequence renumbers everything after it. Same resources, new
  // ids. Reported, never fatal.
  if (diff.idShifts.length > 0) {
    const shiftedNodes = new Set(diff.idShifts.map((change) => change.id))
    console.log(
      `\n─── id-shifted (expected — redaction is encounter-ordered) ───`,
    )
    console.log(
      `  ${shiftedNodes.size} matched resource(s), ${diff.idShifts.length} field(s) renumbered`,
    )
    for (const change of diff.idShifts.filter((c) => c.field === 'id').slice(0, 10)) {
      console.log(`    ${change.type.padEnd(14)} ${change.before}  →  ${change.after}`)
    }
    const idOnly = diff.idShifts.filter((c) => c.field === 'id').length
    if (idOnly > 10) console.log(`    … and ${idOnly - 10} more`)
  }

  if (diff.ambiguities.length > 0) {
    console.log('\n─── AMBIGUOUS PAIRINGS ───')
    console.log('  Refused rather than guessed: a wrong pairing would invent a')
    console.log('  changed field that never changed.\n')
    for (const ambiguity of diff.ambiguities) {
      console.log(
        `  ${ambiguity.type}: ${ambiguity.beforeCount} vs ${ambiguity.afterCount} candidates`,
      )
      console.log(`    ${ambiguity.reason}`)
    }
  }

  reportChanges('runtime changes (expected between two runs)', diff.runtimeChanges, 6)
  reportChanges('edge meta changes (expected)', diff.edgeMetaChanges, 6)

  console.log('\n─── unexplained ───')
  if (unexplained.length === 0) {
    console.log('  none — every difference traces to a denied permission')
  } else {
    for (const line of unexplained) console.log(`  ${line}`)
    console.log('')
    console.log('  These are account drift or a bug. Work out which before pinning')
    console.log('  the replay suite to either fixture.')
    process.exitCode = 1
  }
  console.log('')
}

main().catch((error: unknown) => {
  console.error(`\nDiff failed: ${(error as Error).message}`)
  process.exit(1)
})
