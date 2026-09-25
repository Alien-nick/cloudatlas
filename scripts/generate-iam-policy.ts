/**
 * Emit docs/iam-policy.json and docs/iam-policy.md from the operation registry.
 *
 *   npm run iam-policy    regenerate and write
 *   npm run check:iam     verify, write nothing, fail on any drift
 *
 * The policy is derived from apps/server/src/aws/operations.ts rather than
 * written by hand, and `aws/client.ts` refuses to call anything not in that
 * registry. The check closes the loop in both directions:
 *
 *   - a call site with no registry entry fails at runtime (the guard), and
 *   - a registry entry with no call site fails here.
 *
 * The second one matters because unused entries are how an IAM policy quietly
 * widens over time. Every action in the committed policy has to be justified by
 * a line of code that calls it.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  actionOf,
  AWS_OPERATIONS,
  type AwsOperationSpec,
} from '../apps/server/src/aws/operations.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
const SERVER_SRC = join(ROOT, 'apps/server/src')

const checkOnly = process.argv.includes('--check')

// ---------------------------------------------------------------------------
// Call-site discovery
// ---------------------------------------------------------------------------

/** Files that mention an operation name without calling it. */
const EXCLUDED = ['aws/operations.ts', 'aws/operations.test.ts']

function sourceFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(SERVER_SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const full = join(entry.parentPath ?? entry.path, entry.name)
    const relative = full.slice(SERVER_SRC.length + 1)
    if (EXCLUDED.some((skip) => relative.endsWith(skip))) continue
    if (relative.endsWith('.test.ts')) continue
    out.push({ path: relative, text: readFileSync(full, 'utf8') })
  }
  return out
}

/**
 * A real call site has three things in the same file: the operation name as a
 * string literal (the guard argument), the SDK command constructor, and the
 * service name. All three, because the name alone also appears in places like
 * `new NotImplementedError('FilterLogEvents', 'Milestone 4')` — which is a
 * message, not a call, and must not count as one.
 */
function findCallSites(
  spec: AwsOperationSpec,
  files: Array<{ path: string; text: string }>,
): string[] {
  const nameLiterals = [`'${spec.operation}'`, `"${spec.operation}"`]
  const constructor = `new ${spec.operation}Command`
  const serviceLiterals = [`'${spec.service}'`, `"${spec.service}"`]

  return files
    .filter(
      ({ text }) =>
        nameLiterals.some((needle) => text.includes(needle)) &&
        text.includes(constructor) &&
        serviceLiterals.some((needle) => text.includes(needle)),
    )
    .map(({ path }) => path)
}

interface RegistryAudit {
  unusedActive: AwsOperationSpec[]
  calledButPlanned: Array<{ spec: AwsOperationSpec; files: string[] }>
}

function auditRegistry(): RegistryAudit {
  const files = sourceFiles()
  const unusedActive: AwsOperationSpec[] = []
  const calledButPlanned: Array<{ spec: AwsOperationSpec; files: string[] }> = []

  for (const spec of AWS_OPERATIONS) {
    // An implied permission has no call site by definition.
    if (spec.impliedBy) continue
    const sites = findCallSites(spec, files)
    if (spec.status === 'active' && sites.length === 0) unusedActive.push(spec)
    // A planned operation with a call site would throw at runtime; catch it here.
    if (spec.status === 'planned' && sites.length > 0) calledButPlanned.push({ spec, files: sites })
  }

  return { unusedActive, calledButPlanned }
}

// ---------------------------------------------------------------------------
// Policy generation
// ---------------------------------------------------------------------------

interface Statement {
  Sid: string
  Effect: 'Allow'
  Action: string[]
  Resource: '*'
}

function sortedActions(specs: AwsOperationSpec[]): string[] {
  return [...new Set(specs.map(actionOf))].sort((a, b) => a.localeCompare(b))
}

const active = AWS_OPERATIONS.filter((s) => s.status === 'active' && !s.optional)
const planned = AWS_OPERATIONS.filter((s) => s.status === 'planned' && !s.optional)
const optional = AWS_OPERATIONS.filter((s) => s.optional === true)

const statements: Statement[] = [
  { Sid: 'CloudAtlasScanReadOnly', Effect: 'Allow', Action: sortedActions(active), Resource: '*' },
  {
    Sid: 'CloudAtlasPlannedReadOnly',
    Effect: 'Allow',
    Action: sortedActions(planned),
    Resource: '*',
  },
]
if (optional.length > 0) {
  statements.push({
    Sid: 'CloudAtlasCostExplorerOptional',
    Effect: 'Allow',
    Action: sortedActions(optional),
    Resource: '*',
  })
}

const policyJson = `${JSON.stringify({ Version: '2012-10-17', Statement: statements }, null, 2)}\n`

// ---------------------------------------------------------------------------
// Human-readable companion
// ---------------------------------------------------------------------------

const byService = new Map<string, AwsOperationSpec[]>()
for (const spec of AWS_OPERATIONS) {
  const list = byService.get(spec.service)
  if (list) list.push(spec)
  else byService.set(spec.service, [spec])
}

const gaps = AWS_OPERATIONS.filter((s) => s.readOnlyAccess === 'gap')
const unverified = AWS_OPERATIONS.filter((s) => s.readOnlyAccess === 'unverified')

function table(specs: AwsOperationSpec[]): string {
  const rows = specs
    .slice()
    .sort((a, b) => actionOf(a).localeCompare(actionOf(b)))
    .map((spec) => {
      const coverage =
        spec.readOnlyAccess === 'covered'
          ? 'yes'
          : spec.readOnlyAccess === 'gap'
            ? '**no**'
            : 'unverified'
      const purpose = spec.impliedBy
        ? `${spec.purpose} _(no call of its own; implied by ${spec.impliedBy})_`
        : spec.purpose
      return `| \`${actionOf(spec)}\` | ${spec.status} | ${spec.milestone} | ${coverage} | ${purpose} |`
    })
  return [
    '| Action | Status | Milestone | In ReadOnlyAccess | Why CloudAtlas calls it |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

const markdown = `# IAM permissions

<!-- Generated by scripts/generate-iam-policy.ts — run \`npm run iam-policy\`. Do not edit by hand. -->

CloudAtlas is read-only. \`apps/server/src/aws/client.ts\` refuses to execute any
operation that is not registered in \`apps/server/src/aws/operations.ts\`, and
this policy is generated from that same registry.

\`npm run check:iam\` enforces both directions: a call site with no registry
entry fails at runtime, and a registry entry with no call site fails the check.
Every action below is justified by a line of code that calls it.

## Which policy to attach

\`docs/iam-policy.json\` contains three statements. Keep the ones you want and
delete the rest:

| Sid | Actions | When you need it |
| --- | --- | --- |
| \`CloudAtlasScanReadOnly\` | ${active.length} | Always. This is what a scan calls today. |
| \`CloudAtlasPlannedReadOnly\` | ${planned.length} | Attach now to avoid re-attaching at Milestones 3–5. Nothing calls these yet. |
| \`CloudAtlasCostExplorerOptional\` | ${optional.length} | Only if you set \`enableCostExplorer: true\`. Cost Explorer bills per request. |

### The simpler alternative

The AWS managed policy **\`ReadOnlyAccess\`** covers almost everything here and is
a reasonable choice if you would rather not manage a custom policy.

${
  gaps.length > 0
    ? `**Known gap.** ${gaps.length === 1 ? 'This action is' : 'These actions are'} not granted by \`ReadOnlyAccess\`:

${gaps.map((s) => `- \`${actionOf(s)}\` — ${s.purpose}`).join('\n')}

Without ${gaps.length === 1 ? 'it' : 'them'}, the affected panel shows a "missing permission" notice and the rest of the app keeps working.`
    : 'No known gaps.'
}

${
  unverified.length > 0
    ? `**Unverified.** We have not confirmed these against the live managed policy, and we would rather say so than guess:

${unverified.map((s) => `- \`${actionOf(s)}\``).join('\n')}

Check them yourself with:

\`\`\`bash
aws iam get-policy-version \\
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess \\
  --version-id "$(aws iam get-policy --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess --query 'Policy.DefaultVersionId' --output text)" \\
  --query 'PolicyVersion.Document' | grep -iE '${[...new Set(unverified.map((s) => s.service))].join('|')}'
\`\`\``
    : ''
}

## When a permission is missing

An \`AccessDenied\` never fails the scan. The collector records it, the scan
continues, and the affected section of the UI renders a "missing permission:
\`<action>\`" notice. A partial diagram beats no diagram.

## Every action, by service

${[...byService.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([service, specs]) => `### \`${service}\`\n\n${table(specs)}`)
  .join('\n\n')}

## Regenerating

\`\`\`bash
npm run iam-policy
\`\`\`

Adding a collector means adding its operations to the registry first — the
client guard will throw on an unregistered call, which is the point.
`

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const audit = auditRegistry()
const problems: string[] = []

if (audit.unusedActive.length > 0) {
  problems.push(
    `${audit.unusedActive.length} registry entr${audit.unusedActive.length === 1 ? 'y is' : 'ies are'} marked "active" but called from nowhere:\n` +
      audit.unusedActive.map((s) => `    ${actionOf(s)}`).join('\n') +
      '\n  Either wire up the call site, or change status to "planned" so the ' +
      'action leaves the base policy.',
  )
}

if (audit.calledButPlanned.length > 0) {
  problems.push(
    `${audit.calledButPlanned.length} operation${audit.calledButPlanned.length === 1 ? ' is' : 's are'} called but registered as "planned" — the guard will throw at runtime:\n` +
      audit.calledButPlanned
        .map(({ spec, files }) => `    ${actionOf(spec)}  (${files.join(', ')})`)
        .join('\n'),
  )
}

if (checkOnly) {
  const policyPath = join(DOCS, 'iam-policy.json')
  const markdownPath = join(DOCS, 'iam-policy.md')
  let committedPolicy = ''
  let committedMarkdown = ''
  try {
    committedPolicy = readFileSync(policyPath, 'utf8')
    committedMarkdown = readFileSync(markdownPath, 'utf8')
  } catch {
    problems.push('docs/iam-policy.json is missing. Run: npm run iam-policy')
  }

  if (committedPolicy && committedPolicy !== policyJson) {
    const committedActions = new Set(
      (JSON.parse(committedPolicy) as { Statement: Statement[] }).Statement.flatMap(
        (s) => s.Action,
      ),
    )
    const generatedActions = new Set(statements.flatMap((s) => s.Action))
    const added = [...generatedActions].filter((a) => !committedActions.has(a))
    const removed = [...committedActions].filter((a) => !generatedActions.has(a))
    problems.push(
      'docs/iam-policy.json is out of date with the registry.' +
        (added.length > 0 ? `\n    would add:    ${added.join(', ')}` : '') +
        (removed.length > 0 ? `\n    would remove: ${removed.join(', ')}` : '') +
        '\n  Run: npm run iam-policy',
    )
  }

  if (committedMarkdown && committedMarkdown !== markdown) {
    problems.push('docs/iam-policy.md is out of date with the registry.\n  Run: npm run iam-policy')
  }

  if (problems.length > 0) {
    console.error('\nIAM policy check failed:\n')
    for (const problem of problems) console.error(`  - ${problem}\n`)
    process.exit(1)
  }

  console.log(
    `IAM policy check OK — ${active.length} active actions, all with call sites; docs in sync.`,
  )
} else {
  if (problems.length > 0) {
    console.error('\nCannot generate: the registry has problems.\n')
    for (const problem of problems) console.error(`  - ${problem}\n`)
    process.exit(1)
  }

  mkdirSync(DOCS, { recursive: true })
  writeFileSync(join(DOCS, 'iam-policy.json'), policyJson)
  writeFileSync(join(DOCS, 'iam-policy.md'), markdown)

  console.log(
    `docs/iam-policy.json  ${active.length} active · ${planned.length} planned · ${optional.length} optional`,
  )
  console.log(`docs/iam-policy.md    ${AWS_OPERATIONS.length} actions across ${byService.size} services`)
  if (gaps.length > 0) console.log(`ReadOnlyAccess gaps:  ${gaps.map(actionOf).join(', ')}`)
}
