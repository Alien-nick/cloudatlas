import type { SavingRisk } from '@cloudatlas/shared'

/**
 * Money as people read it: whole dollars once the cents stop mattering,
 * cents below that, so a $1.60 saving does not round to "$2".
 */
export function money(value: number | null, currency = 'USD'): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const symbol = currency === 'USD' ? '$' : `${currency} `
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : 2
  return `${sign}${symbol}${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

/** Risk travels with a word and a glyph, never colour alone. */
export const RISK: Record<SavingRisk, { label: string; glyph: string; color: string }> = {
  low: { label: 'Low risk', glyph: '●', color: 'var(--ca-ok)' },
  medium: { label: 'Medium risk', glyph: '▲', color: 'var(--ca-warn)' },
  high: { label: 'High risk', glyph: '◆', color: 'var(--ca-bad)' },
}
