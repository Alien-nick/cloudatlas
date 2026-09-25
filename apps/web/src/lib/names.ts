import type { GraphNode } from '@cloudatlas/shared'

/**
 * Shorten resource names for display by removing the prefix they all share.
 *
 * In a real account almost every resource in a VPC is named after it —
 * `production-moh-supply-chain-db`, `production-moh-supply-chain-private-2`,
 * and so on. The shared part carries no information *inside* that VPC, and it
 * is long enough to push the distinguishing part out of a node tile: a label
 * reading `production-moh-s…` tells you nothing, and every tile reads the same.
 *
 * Three rules keep this from destroying information:
 *
 *  - Only cut at a token boundary (`-`, `_`, `.`, `/`). Trimming `prod` from
 *    `production` and `prodigy` would invent a false relationship between them.
 *  - Keep something meaningful behind. `db` is a fine name; `2` is not, so the
 *    remainder has to contain a letter rather than merely be long enough.
 *  - Require a clear majority to share it. Two names out of fifty sharing a
 *    stem is a coincidence; it does not have to be unanimous, because real
 *    VPCs mix convention-named resources with bare instance ids.
 *
 * The full name is never lost — it stays in the tooltip, the detail panel and
 * search, so shortening only ever affects what is drawn.
 */

const SEPARATORS = new Set(['-', '_', '.', '/'])

/** Minimum names that must share the prefix for it to be a convention. */
const MIN_SHARED = 3

/** And it must cover this share of the group, so a minority does not win. */
const MIN_COVERAGE = 0.4

/** Shortest prefix worth removing; below this the gain is not worth the loss. */
const MIN_PREFIX = 6

/**
 * A remainder is meaningful when it has a letter in it.
 *
 * Length alone is the wrong test in both directions: it rejects `db`, which is
 * a perfectly good name, and accepts `2.1`, which is not.
 */
function isMeaningful(remainder: string): boolean {
  return /[a-z]/i.test(remainder)
}

/** Every prefix of `name` that ends on a separator. */
function tokenPrefixes(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < name.length; i++) {
    if (SEPARATORS.has(name[i] ?? '')) out.push(name.slice(0, i + 1))
  }
  return out
}

/**
 * The naming convention most of a group follows.
 *
 * Deliberately not the prefix *every* name shares. A real VPC mixes
 * convention-named resources with bare instance ids like `i-05ccfb57a27a15d5`,
 * and requiring unanimity means the rule never fires on the accounts that need
 * it most. So the longest prefix carried by a clear majority wins, and names
 * outside the convention are simply left alone.
 */
export function dominantPrefix(names: string[]): string {
  if (names.length < MIN_SHARED) return ''

  const counts = new Map<string, number>()
  for (const name of names) {
    // Per name, so a repeated name cannot inflate its own prefix.
    for (const prefix of new Set(tokenPrefixes(name))) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
    }
  }

  const needed = Math.max(MIN_SHARED, Math.ceil(names.length * MIN_COVERAGE))
  let best = ''
  for (const [prefix, count] of counts) {
    if (count < needed || prefix.length < MIN_PREFIX) continue
    // Longest wins: it removes the most noise while still covering a majority.
    if (prefix.length > best.length) best = prefix
  }
  if (!best) return ''

  // Every name that carries it must keep something meaningful behind.
  for (const name of names) {
    if (!name.startsWith(best)) continue
    if (!isMeaningful(name.slice(best.length))) return ''
  }
  return best
}

/**
 * Display names keyed by node id.
 *
 * Scoped per top-level container — a VPC's naming convention is its own, and a
 * prefix shared across two unrelated VPCs would be a coincidence rather than
 * something worth hiding.
 */
export function shortNames(nodes: GraphNode[]): Map<string, string> {
  const byScope = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    // Synthetic containers carry names CloudAtlas generates, not the
    // account's. Counting them dilutes the coverage test with names that could
    // never match a convention no matter how consistently it is applied.
    if (node.type === 'region' || node.type === 'lane' || node.type === 'az') continue
    const scope = node.vpcId ?? node.region
    const list = byScope.get(scope) ?? []
    list.push(node)
    byScope.set(scope, list)
  }

  const shortened = new Map<string, string>()
  for (const group of byScope.values()) {
    const prefix = dominantPrefix(group.map((node) => node.name))
    if (!prefix) continue
    for (const node of group) {
      if (!node.name.startsWith(prefix)) continue
      shortened.set(node.id, node.name.slice(prefix.length))
    }
  }
  return shortened
}
