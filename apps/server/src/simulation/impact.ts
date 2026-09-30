import {
  isContainerType,
  monthlyByNode,
  runRateTotal,
  scoreControls,
  summarizeControls,
  type ComplianceReport,
  type Graph,
  type RunRate,
  type Simulated,
  type SimulationImpact,
} from '@cloudatlas/shared'
import { evaluateCompliance } from '../compliance/evaluate.js'
import { internetReach, reachByEntry } from './exposure.js'

/**
 * What a simulation changes, compared with the snapshot it came from.
 *
 * Every figure here is the same engine run twice — once on the snapshot, once
 * on the simulated graph — and the difference between the two. Nothing is
 * modelled specially for simulations, which is what makes the comparison fair.
 */

const round = (value: number): number => Math.round(value * 100) / 100

export function simulationImpact(base: Graph, simulated: Simulated, runRates: [RunRate, RunRate]): SimulationImpact {
  const sim = simulated.graph
  const nameOf = (id: string): string =>
    sim.nodes.find((node) => node.id === id)?.name ?? base.nodes.find((node) => node.id === id)?.name ?? id

  // --- cost ------------------------------------------------------------------
  const [baseRate, simRate] = runRates
  const before = monthlyByNode(baseRate)
  const after = monthlyByNode(simRate)
  const touched = new Set([
    ...Object.keys(simulated.status),
    ...simulated.removed.map((entry) => entry.id),
  ])
  const lines: SimulationImpact['cost']['lines'] = []
  for (const id of touched) {
    const was = before.get(id) ?? 0
    const now = after.get(id) ?? 0
    const change = simulated.removed.some((entry) => entry.id === id)
      ? 'removed'
      : simulated.status[id] === 'added'
        ? 'added'
        : 'changed'
    // A changed resource whose cost did not move (a new security-group rule,
    // say) is not a cost line.
    if (Math.abs(now - was) < 0.005) continue
    lines.push({ nodeId: id, name: nameOf(id), change, before: round(was), after: round(now) })
  }
  lines.sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
  const notEstimated = simRate.unpriced.filter((entry) => simulated.status[entry.nodeId] === 'added')

  // --- compliance ----------------------------------------------------------
  const baseReport = evaluateCompliance(base)
  const simReport = evaluateCompliance(sim)
  const compliance = baseReport.frameworks.map((framework) => {
    const checkIds = new Set(framework.controls.flatMap((control) => control.checkIds))
    const controlsFor = (checkId: string): string[] =>
      framework.controls.filter((control) => control.checkIds.includes(checkId)).map((control) => control.ref)
    const failing = (report: ComplianceReport): Map<string, string> =>
      new Map(
        report.results
          .filter((result) => result.status === 'fail' && checkIds.has(result.checkId))
          .map((result) => [`${result.checkId}|${result.nodeId}`, result.checkId]),
      )
    const was = failing(baseReport)
    const now = failing(simReport)
    const titleOf = (checkId: string): string => simReport.checks.find((check) => check.id === checkId)?.title ?? checkId
    const describe = (key: string, checkId: string) => {
      const nodeId = key.slice(checkId.length + 1)
      return { checkId, checkTitle: titleOf(checkId), nodeId, controls: controlsFor(checkId) }
    }
    const score = (report: ComplianceReport): number | null =>
      scoreControls(summarizeControls(report, framework.id, null)).percent
    return {
      framework: framework.id,
      frameworkName: framework.name,
      before: score(baseReport),
      after: score(simReport),
      newGaps: [...now].filter(([key]) => !was.has(key)).map(([key, checkId]) => describe(key, checkId)),
      fixed: [...was].filter(([key]) => !now.has(key)).map(([key, checkId]) => describe(key, checkId)),
    }
  })

  // --- exposure -----------------------------------------------------------
  const baseReach = internetReach(base)
  const simReach = internetReach(sim)
  const isResource = (id: string): boolean => {
    const node = sim.nodes.find((candidate) => candidate.id === id) ?? base.nodes.find((candidate) => candidate.id === id)
    return node !== undefined && !isContainerType(node.type) && node.type !== 'internet'
  }
  // A new route is an entry point that reaches a resource in the simulation
  // but did not reach it before — whether or not something else already did.
  const baseByEntry = reachByEntry(base)
  const simByEntry = reachByEntry(sim)
  const newlyReachable: SimulationImpact['exposure']['newlyReachable'] = []
  for (const [nodeId, entries] of simByEntry) {
    if (!isResource(nodeId)) continue
    const before = baseByEntry.get(nodeId)
    const fresh = [...entries].filter(([entry]) => !before?.has(entry)).map(([, reach]) => reach)
    if (fresh.length === 0) continue
    const shortest = fresh.sort((a, b) => a.path.length - b.path.length)[0] as { path: string[]; entryReason: string }
    newlyReachable.push({ nodeId, path: shortest.path, entryReason: shortest.entryReason })
  }
  // Existing resources first: a new route to the production database matters
  // more than a new load balancer being public, which is what it is for.
  const existing = (id: string): boolean => simulated.status[id] !== 'added'
  newlyReachable.sort((a, b) => Number(existing(b.nodeId)) - Number(existing(a.nodeId)) || b.path.length - a.path.length)
  const noLongerReachable = [...baseReach.keys()]
    .filter((id) => !simReach.has(id) && isResource(id))
    .map((nodeId) => ({ nodeId, name: nameOf(nodeId) }))

  return {
    cost: {
      source: simRate.source,
      before: round(runRateTotal(baseRate)),
      after: round(runRateTotal(simRate)),
      lines,
      notEstimated,
      message: simRate.message ?? baseRate.message ?? null,
    },
    compliance,
    exposure: { newlyReachable, noLongerReachable },
  }
}
