import type {
  ComplianceCheck,
  ComplianceReport,
  ComplianceResult,
  ControlStatus,
  ControlSummary,
} from '@cloudatlas/shared'

/**
 * Status presentation. Colour always travels with a glyph and a word, so a
 * status never depends on telling red from amber.
 */
export const CONTROL_STATUS: Record<ControlStatus, { label: string; glyph: string; color: string }> = {
  gap: { label: 'Gap', glyph: '✕', color: 'var(--ca-bad)' },
  unknown: { label: 'Unknown', glyph: '?', color: 'var(--ca-warn)' },
  met: { label: 'Met', glyph: '✓', color: 'var(--ca-ok)' },
  'not-applicable': { label: 'No resources', glyph: '–', color: 'var(--ca-faint)' },
  'not-assessed': { label: 'Manual', glyph: '◇', color: 'var(--ca-faint)' },
}

export const SEVERITY_COLOR: Record<ComplianceCheck['severity'], string> = {
  high: 'var(--ca-bad)',
  medium: 'var(--ca-warn)',
  low: 'var(--ca-muted)',
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The gap list as CSV: one row per failing or unreadable resource per control.
 *
 * This is what gets attached to a ticket or handed to an auditor, so it
 * carries everything needed to act on a row without opening the app — the
 * control citation, the resource, the observed fact and the fix.
 */
export function gapsCsv(
  report: ComplianceReport,
  summaries: ControlSummary[],
  resourceName: (nodeId: string) => string,
): string {
  const checkById = new Map(report.checks.map((check) => [check.id, check]))
  const header = ['Framework', 'Control', 'Control title', 'Status', 'Check', 'Severity', 'Resource', 'Resource id', 'Evidence', 'Remediation', 'Commands']
  const rows: string[][] = []

  for (const summary of summaries) {
    const framework = report.frameworks.find((f) => f.id === summary.control.framework)?.name ?? ''
    for (const result of [...summary.failing, ...summary.unknown]) {
      const check = checkById.get(result.checkId)
      rows.push([
        framework,
        summary.control.ref,
        summary.control.title,
        result.status === 'fail' ? 'gap' : 'unknown',
        check?.title ?? result.checkId,
        check?.severity ?? '',
        resourceName(result.nodeId),
        result.nodeId,
        result.evidence.join('; '),
        check?.remediation ?? '',
        result.fix?.commands.join('\n') ?? '',
      ])
    }
  }

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
}

/**
 * Fix commands for several resources as one script to review and paste.
 *
 * Comments carry the caution and the placeholder warning, so the text stays
 * safe to read even out of context — pasted into a ticket or a runbook.
 * Results without a command-line fix are skipped, and a command already in
 * the script is not repeated — account- and region-wide settings such as EBS
 * encryption by default come back once per resource otherwise.
 */
export function fixScript(
  check: ComplianceCheck | undefined,
  results: ComplianceResult[],
  resourceName: (nodeId: string) => string,
): string {
  const withFix = results.filter((result) => result.fix && result.fix.commands.length > 0)
  if (withFix.length === 0) return ''
  const lines: string[] = [`# ${check?.title ?? 'Fix'} — review before running; CloudAtlas does not run this`]
  const caution = withFix[0]?.fix?.caution
  if (caution) lines.push(`# Caution: ${caution}`)
  if (withFix.some((result) => result.fix?.needsInput)) {
    lines.push('# Replace every <placeholder> with your own value first.')
  }
  const seen = new Set<string>()
  for (const result of withFix) {
    const commands = (result.fix?.commands ?? []).filter((command) => !seen.has(command))
    for (const command of commands) seen.add(command)
    if (commands.length > 0) lines.push('', `# ${resourceName(result.nodeId)} (${result.nodeId})`, ...commands)
  }
  return lines.join('\n') + '\n'
}

export function downloadText(filename: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
