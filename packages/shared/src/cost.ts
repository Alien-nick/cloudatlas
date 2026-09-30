import { z } from 'zod'
import { fixSchema } from './compliance.js'

/**
 * Cost: where the money goes, and how to spend less.
 *
 * Two different numbers live here, and they must never be confused:
 *
 *   - **Actual spend** comes from AWS Cost Explorer. It is what the account was
 *     billed, including data transfer and every usage charge, but Cost Explorer
 *     groups it by service, region and day — not by resource.
 *   - **Estimated run-rate** is on-demand list price × what is running now, per
 *     resource. It can say which VPC or database costs what, but it leaves out
 *     usage charges, discounts and credits, so it is not the bill.
 *
 * Savings are estimated against the same list prices, and every one says what
 * it assumes.
 */

export const HOURS_PER_MONTH = 730

// ---------------------------------------------------------------------------
// Actual spend (Cost Explorer)
// ---------------------------------------------------------------------------

export const spendStatusSchema = z.enum([
  /** Cost Explorer is off; nothing was requested and nothing was billed. */
  'disabled',
  'ok',
  /** The profile lacks ce:GetCostAndUsage. */
  'denied',
  'error',
  /** Demo mode: illustrative figures, not a real bill. */
  'demo',
])
export type SpendStatus = z.infer<typeof spendStatusSchema>

export const amountByKeySchema = z.object({ key: z.string(), amount: z.number() })

export const actualSpendSchema = z.object({
  status: spendStatusSchema,
  message: z.string().nullable(),
  currency: z.string(),
  /** Epoch ms the figures were fetched; cached figures keep their original time. */
  fetchedAt: z.number().nullable(),
  monthToDate: z.number().nullable(),
  lastMonth: z.number().nullable(),
  /** Cost Explorer's projection for the whole current month. */
  forecastMonthEnd: z.number().nullable(),
  /** Month to date, and last month for the same service, largest first. */
  byService: z.array(z.object({ key: z.string(), monthToDate: z.number(), lastMonth: z.number() })),
  byRegion: z.array(amountByKeySchema),
  /** Last 30 days, oldest first; `key` is YYYY-MM-DD. */
  daily: z.array(amountByKeySchema),
})
export type ActualSpend = z.infer<typeof actualSpendSchema>

// ---------------------------------------------------------------------------
// Estimated run-rate (list prices)
// ---------------------------------------------------------------------------

export const estimateLineSchema = z.object({
  nodeId: z.string(),
  /** What is being priced, e.g. "Instance (m6i.xlarge)" or "Storage (gp2, 100 GiB)". */
  component: z.string(),
  monthlyUsd: z.number(),
  /** e.g. "$0.192/hr × 730 h". */
  basis: z.string(),
})
export type EstimateLine = z.infer<typeof estimateLineSchema>

export const unpricedSchema = z.object({
  nodeId: z.string(),
  /** Why no estimate: usage-based, unknown engine, price not found… */
  reason: z.string(),
})

export const runRateSchema = z.object({
  /** Where prices came from, e.g. "AWS Price List API, on-demand, Linux". */
  source: z.string(),
  lines: z.array(estimateLineSchema),
  unpriced: z.array(unpricedSchema),
  /** Set when prices could not be fetched at all, e.g. a denied pricing call. */
  message: z.string().nullable(),
})
export type RunRate = z.infer<typeof runRateSchema>

// ---------------------------------------------------------------------------
// Savings
// ---------------------------------------------------------------------------

export const savingRiskSchema = z.enum(['low', 'medium', 'high'])
export type SavingRisk = z.infer<typeof savingRiskSchema>

export const savingSchema = z.object({
  /** Stable per check and resource. */
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  nodeId: z.string(),
  /** Estimated from list prices; null when the saving depends on usage. */
  monthlySavingsUsd: z.number().nullable(),
  /** Stated when there is no dollar figure, e.g. "about 20% of duration charges". */
  savingsNote: z.string().nullable(),
  rationale: z.string(),
  /** How disruptive the change is: downtime, compatibility, data loss. */
  risk: savingRiskSchema,
  evidence: z.array(z.string()),
  fix: fixSchema.optional(),
})
export type Saving = z.infer<typeof savingSchema>

export const costReportSchema = z.object({
  actual: actualSpendSchema,
  runRate: runRateSchema,
  savings: z.array(savingSchema),
  /** Epoch ms of the scan the run-rate and savings describe. */
  scannedAt: z.number(),
})
export type CostReport = z.infer<typeof costReportSchema>

// ---------------------------------------------------------------------------
// Roll-ups, shared so the UI and the agent agree
// ---------------------------------------------------------------------------

export function monthlyByNode(runRate: RunRate): Map<string, number> {
  const totals = new Map<string, number>()
  for (const line of runRate.lines) totals.set(line.nodeId, (totals.get(line.nodeId) ?? 0) + line.monthlyUsd)
  return totals
}

export function runRateTotal(runRate: RunRate): number {
  return runRate.lines.reduce((sum, line) => sum + line.monthlyUsd, 0)
}

export function savingsTotal(savings: Saving[]): number {
  // One resource can have several suggestions that overlap (resize *and*
  // move to Graviton). Summing both would promise money that does not
  // exist, so each resource contributes only its largest saving.
  const best = new Map<string, number>()
  for (const saving of savings) {
    if (saving.monthlySavingsUsd === null) continue
    best.set(saving.nodeId, Math.max(best.get(saving.nodeId) ?? 0, saving.monthlySavingsUsd))
  }
  return [...best.values()].reduce((sum, value) => sum + value, 0)
}
