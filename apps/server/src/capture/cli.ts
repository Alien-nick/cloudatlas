/**
 * Capture a redacted AWS fixture.
 *
 *   npm run capture -- --profile prod --region us-east-1 --out fixtures/capture-01
 *
 * Runs the real collectors once, redacts the transcript, checks the result
 * against a deny list, and only then writes anything. If any deny word survives
 * redaction, nothing is written and the command exits non-zero.
 *
 * It also replays what it would write, to prove the fixture still builds the
 * same graph — redaction that breaks a cross-reference is as bad as redaction
 * that misses a secret.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AwsClient } from '../aws/client.js'
import { getIdentity } from '../aws/identity.js'
import { DEFAULT_KEEP_TAG_KEYS, Redactor } from '../aws/redact.js'
import {
  TranscriptReader,
  TranscriptWriter,
  type CaptureMeta,
  type RegionTelemetry,
  type TranscriptEntry,
} from '../aws/transcript.js'
import { runScan } from '../scan/run.js'
import { automaticDenyWords, formatDenyFailure, loadDenyConfig } from './deny.js'
import { gateAndWrite } from './write.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The spec's performance target, reported as a measured number. */
const TARGET_RESOURCES = 500
const TARGET_SECONDS = 60

interface Args {
  profile: string
  regions: string[]
  out: string
  keepTagKeys: string[]
  keepNoTags: boolean
  denyWords: string[]
  allowWords: string[]
}

const USAGE = `
Usage:
  npm run capture -- --profile <name> --region <region>[,<region>] --out <dir>

Options:
  --keep-tag <key>     Tag keys whose values are NOT redacted (repeatable).
                       Default: ${DEFAULT_KEEP_TAG_KEYS.join(', ')}
  --keep-no-tags       Redact every tag value, including the defaults. Use this
                       for a client account where no tag value should survive.
  --deny-word <s>      Extra string that must not appear in the output
                       (repeatable). capture.deny.json is read automatically.
  --allow-word <s>     Suppress a deny-word false positive (repeatable).

Example:
  npm run capture -- --profile sandbox --region us-east-1 \\
      --out fixtures/capture-01 --keep-tag Environment
`

function parseArgs(argv: string[]): Args {
  const regions: string[] = []
  const keepTagKeys: string[] = []
  const denyWords: string[] = []
  const allowWords: string[] = []
  let profile = ''
  let out = ''
  let keepNoTags = false

  const push = (target: string[], value: string | undefined): void => {
    if (value) target.push(...value.split(',').map((v) => v.trim()).filter(Boolean))
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--profile':
        profile = value ?? ''
        i++
        break
      case '--region':
      case '--regions':
        push(regions, value)
        i++
        break
      case '--out':
        out = value ?? ''
        i++
        break
      case '--keep-tag':
        push(keepTagKeys, value)
        i++
        break
      case '--keep-no-tags':
        keepNoTags = true
        break
      case '--deny-word':
        push(denyWords, value)
        i++
        break
      case '--allow-word':
        push(allowWords, value)
        i++
        break
      default:
        break
    }
  }

  if (!profile || regions.length === 0 || !out) {
    console.error(USAGE)
    process.exit(1)
  }

  return {
    profile,
    regions,
    out: resolve(ROOT, out),
    keepTagKeys,
    keepNoTags,
    denyWords,
    allowWords,
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function bar(label: string, value: number, max: number, width = 24): string {
  const filled = max > 0 ? Math.max(1, Math.round((value / max) * width)) : 0
  return `    ${label.padEnd(40)} ${'█'.repeat(filled).padEnd(width)} ${value}`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  console.log(`\nCapturing ${args.profile} · ${args.regions.join(', ')}`)
  console.log('Read-only. Nothing is written until the deny-word check passes.\n')

  const writer = new TranscriptWriter()
  const missing: string[] = []
  const aws = new AwsClient({
    profile: args.profile,
    mode: 'capture',
    writer,
    onMissingPermission: (action, region) => {
      missing.push(`${action} (${region})`)
      console.warn(`  missing permission: ${action} in ${region}`)
    },
    onUnclassified: (failure) => {
      console.warn(
        `  UNCLASSIFIED ${failure.service}:${failure.operation} in ${failure.region} ` +
          `(${failure.errorName}${failure.errorCode ? ` / ${failure.errorCode}` : ''})`,
      )
    },
  })

  const startedAt = Date.now()
  let identity
  try {
    identity = await getIdentity(aws, args.profile)
  } catch (error) {
    console.error(`\nCould not authenticate with profile "${args.profile}".`)
    console.error(`  ${(error as Error).message}`)
    console.error(`\nIf this is an SSO profile: aws sso login --profile ${args.profile}`)
    process.exit(1)
  }

  console.log(
    `  account ${identity.accountId}${identity.accountAlias ? ` (${identity.accountAlias})` : ''}\n`,
  )

  const regionStarted = new Map<string, number>()
  const regionEnded = new Map<string, number>()
  const regionResources = new Map<string, number>()

  const live = await runScan({
    aws,
    profile: args.profile,
    accountId: identity.accountId,
    accountAlias: identity.accountAlias,
    regions: args.regions,
    onProgress: (progress) => {
      if (progress.state === 'scanning' && !regionStarted.has(progress.region)) {
        regionStarted.set(progress.region, Date.now())
      }
      if (progress.state === 'done') {
        regionEnded.set(progress.region, Date.now())
        regionResources.set(progress.region, progress.resourceCount)
        process.stdout.write(
          `  ${progress.region.padEnd(16)} ${String(progress.resourceCount).padStart(4)} resources\n`,
        )
      }
    },
  })
  const totalWallMs = Date.now() - startedAt
  await aws.destroy()

  // --- redact (learn, then replace) --------------------------------------
  const redactor = new Redactor({
    keepTagKeys: args.keepTagKeys,
    keepNoTags: args.keepNoTags,
  })
  const redacted = redactor.redactAll(writer.all() as readonly TranscriptEntry[])
  const redaction = redactor.summary()

  // --- telemetry ---------------------------------------------------------
  const byRegion: Record<string, RegionTelemetry> = {}
  let totalResources = 0
  for (const region of args.regions) {
    const stats = aws.stats.byRegion[region]
    const start = regionStarted.get(region)
    const end = regionEnded.get(region)
    const resourceCount = regionResources.get(region) ?? 0
    totalResources += resourceCount
    byRegion[region] = {
      wallMs: start && end ? end - start : 0,
      apiMs: stats?.apiMs ?? 0,
      calls: stats?.calls ?? 0,
      callsByAction: stats?.callsByAction ?? {},
      retries: stats?.retries ?? 0,
      throttles: stats?.throttles ?? 0,
      accessDenied: [...new Set(stats?.accessDenied ?? [])],
      unclassified: stats?.unclassified ?? [],
      resourceCount,
    }
  }

  const perResourceMs = totalResources > 0 ? totalWallMs / totalResources : 0
  const projectedSeconds = Number(((perResourceMs * TARGET_RESOURCES) / 1000).toFixed(1))

  const name = args.out.split('/').pop() ?? 'capture'
  const capturedAt = new Date().toISOString()

  const meta: CaptureMeta = {
    name,
    capturedAt,
    regions: args.regions,
    totalWallMs,
    totalCalls: aws.stats.totalCalls,
    totalRetries: aws.stats.retries,
    totalThrottles: aws.stats.throttles,
    totalResources,
    unclassified: aws.stats.unclassified,
    byRegion,
    target: {
      resources: TARGET_RESOURCES,
      seconds: TARGET_SECONDS,
      projectedSeconds,
      pass: projectedSeconds <= TARGET_SECONDS,
    },
    redaction: { replaced: redaction.replaced, keptTagKeys: redaction.keptTagKeys },
    denyCheck: { wordsChecked: 0, allowedWords: args.allowWords },
  }

  const files = TranscriptWriter.materialize(
    redacted,
    { name, capturedAt, regions: args.regions, totalCalls: aws.stats.totalCalls },
    meta,
  )

  // --- the gate ----------------------------------------------------------
  const configured = loadDenyConfig(ROOT)
  const automatic = automaticDenyWords(identity.accountId, [args.profile])
  const deny = [...configured.deny, ...args.denyWords, ...automatic]
  const allow = [...configured.allow, ...args.allowWords]

  // Settle meta.json before the scan so the scanned bytes are the written bytes.
  meta.denyCheck.wordsChecked = new Set(deny).size
  files.set('meta.json', `${JSON.stringify(meta, null, 2)}\n`)

  console.log(
    `\nDeny-word check: ${meta.denyCheck.wordsChecked} words over ${files.size} files ` +
      `(${automatic.length} automatic, ${configured.deny.length} from capture.deny.json, ` +
      `${args.denyWords.length} from flags)`,
  )

  const outcome = gateAndWrite({ dir: args.out, files, deny, allow })
  const denyResult = outcome.result

  if (!outcome.written) {
    console.error(formatDenyFailure(denyResult))
    process.exit(1)
  }
  console.log('  PASS — no denied value survived redaction, in any file')

  // --- verify by replaying what we just wrote ----------------------------
  console.log('\nVerifying the fixture replays to the same graph…')
  const replayAws = new AwsClient({
    profile: 'replay',
    mode: 'replay',
    reader: new TranscriptReader(args.out),
  })
  let replayOk = true
  try {
    const replayed = await runScan({
      aws: replayAws,
      profile: args.profile,
      accountId: identity.accountId,
      accountAlias: identity.accountAlias,
      regions: args.regions,
    })
    replayOk =
      replayed.graph.nodes.length === live.graph.nodes.length &&
      replayed.graph.edges.length === live.graph.edges.length
    if (replayOk) {
      console.log(
        `  PASS — ${replayed.graph.nodes.length} nodes · ${replayed.graph.edges.length} edges reproduce exactly`,
      )
    } else {
      console.error(
        `  MISMATCH  nodes ${live.graph.nodes.length} → ${replayed.graph.nodes.length}, ` +
          `edges ${live.graph.edges.length} → ${replayed.graph.edges.length}`,
      )
      console.error('  Redaction broke a cross-reference. Do not commit this capture.')
    }
  } catch (error) {
    replayOk = false
    console.error(`  Replay failed: ${(error as Error).message}`)
  }

  // --- report ------------------------------------------------------------
  console.log('\n─── per region ───')
  console.log(
    `  ${'region'.padEnd(16)} ${'wall'.padStart(8)} ${'api'.padStart(9)} ` +
      `${'calls'.padStart(6)} ${'retry'.padStart(6)} ${'thr'.padStart(4)} ${'res'.padStart(5)}`,
  )
  for (const region of args.regions) {
    const t = byRegion[region]
    if (!t) continue
    console.log(
      `  ${region.padEnd(16)} ${formatMs(t.wallMs).padStart(8)} ${formatMs(t.apiMs).padStart(9)} ` +
        `${String(t.calls).padStart(6)} ${String(t.retries).padStart(6)} ` +
        `${String(t.throttles).padStart(4)} ${String(t.resourceCount).padStart(5)}`,
    )
  }
  console.log(
    `  ${'TOTAL'.padEnd(16)} ${formatMs(totalWallMs).padStart(8)} ${''.padStart(9)} ` +
      `${String(aws.stats.totalCalls).padStart(6)} ${String(aws.stats.retries).padStart(6)} ` +
      `${String(aws.stats.throttles).padStart(4)} ` +
      `${String(totalResources).padStart(5)}`,
  )

  console.log(
    `\n  Projected for ${TARGET_RESOURCES} resources: ${projectedSeconds}s ` +
      `(target ${TARGET_SECONDS}s) ${meta.target.pass ? 'PASS' : 'OVER'}`,
  )

  console.log('\n─── API calls by operation ───')
  for (const region of args.regions) {
    const t = byRegion[region]
    if (!t || t.calls === 0) continue
    const actions = Object.entries(t.callsByAction).sort(([, a], [, b]) => b - a)
    const max = actions[0]?.[1] ?? 1
    console.log(`  ${region}`)
    for (const [action, count] of actions) console.log(bar(action, count, max))
  }

  console.log('\n─── redaction ───')
  for (const [cls, count] of Object.entries(redaction.replaced)) {
    console.log(`  ${cls.padEnd(16)} ${count} distinct values replaced`)
  }

  if (redaction.keptTagKeys.length > 0) {
    console.log('')
    console.log(`  !! TAG VALUES KEPT UNREDACTED for: ${redaction.keptTagKeys.join(', ')}`)
    console.log('     Those values are committed verbatim. Use --keep-no-tags to redact them all.')
  } else {
    console.log('\n  All tag values redacted.')
  }

  if (denyResult.suppressed.length > 0) {
    console.log('')
    console.log(`  !! DENY WORDS SUPPRESSED by --allow-word: ${denyResult.suppressed.join(', ')}`)
    console.log('     Those strings were NOT checked. Re-confirm each is safe to publish.')
  }

  if (missing.length > 0) {
    console.log('\n─── missing permissions ───')
    for (const action of [...new Set(missing)]) console.log(`  ${action}`)
    console.log('  The scan continued without them; affected sections show a notice.')
  }

  // The unknown-unknowns bucket. AWS's phrasing for a denial is not a closed
  // set, so rather than chasing the next variant, anything unrecognised is
  // reported here and recorded in meta.json.
  if (aws.stats.unclassified.length > 0) {
    console.log('\n─── UNCLASSIFIED FAILURES ───')
    console.log('  These matched no classifier. If any is really a permission denial,')
    console.log('  add its code or phrasing to apps/server/src/aws/errors.ts.\n')
    for (const failure of aws.stats.unclassified) {
      console.log(
        `  ${failure.service}:${failure.operation} · ${failure.region} · ` +
          `${failure.errorName}${failure.errorCode ? ` / ${failure.errorCode}` : ''}`,
      )
    }
    console.log(`\n  Full messages: npm run capture:audit ${args.out}`)
  } else {
    console.log('\n  No unclassified failures.')
  }

  console.log(`\nWrote ${redacted.length} recorded calls to ${args.out}`)
  console.log('Telemetry in meta.json. Review the diff before committing.')
  if (!replayOk) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(`\nCapture failed: ${(error as Error).message}`)
  process.exit(1)
})
