import type { ActualSpend, CostReport, Graph } from '@cloudatlas/shared'
import type { CliContext } from '../aws/cli-command.js'
import { estimateRunRate, neededPrices } from './estimate.js'
import type { PriceBook, PriceKey } from './pricing.js'
import { findSavings, savingCandidates } from './savings.js'

/**
 * One cost report: actual spend, the estimated run-rate and the savings.
 *
 * The price book is loaded by the caller, because loading is where the
 * providers differ — the live one asks the Price List API, the demo reads a
 * table — and everything after it is the same pure computation.
 */

export interface CostPlan {
  /** Every price the estimate and the savings need, to load in one pass. */
  keys: PriceKey[]
  build: (book: PriceBook, failure: string | null, actual: ActualSpend) => CostReport
}

export function planCostReport(graph: Graph, context: CliContext): CostPlan {
  const candidates = savingCandidates(graph, context)
  return {
    keys: [...neededPrices(graph), ...candidates.flatMap((candidate) => candidate.keys)],
    build: (book, failure, actual) => ({
      actual,
      runRate: estimateRunRate(graph, book, failure),
      savings: findSavings(candidates, book),
      scannedAt: graph.scannedAt,
    }),
  }
}
