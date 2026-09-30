import { HOURS_PER_MONTH, type EstimateLine, type Graph, type GraphNode, type RunRate } from '@cloudatlas/shared'
import {
  attachedVolumes,
  cacheNodeCount,
  engine,
  fargateSize,
  instanceType,
  isMultiAz,
  isRunning,
  rdsStorage,
  standaloneVolume,
} from './facts.js'
import { rdsEngineName, type PriceBook, type PriceKey } from './pricing.js'

/**
 * Estimated monthly run-rate: list price × what is running now.
 *
 * Two passes over the same logic: first collect every price the scan needs
 * (so they can be fetched in one go), then price each resource. Keeping both
 * in `priceItems` means the fetch list cannot drift from what is priced.
 */

/** Services charged by usage — requests, GB, invocations — which a snapshot cannot price. */
const USAGE_BASED: Partial<Record<GraphNode['type'], string>> = {
  lambda: 'Charged per request and duration — see actual spend',
  s3: 'Charged per GB stored and per request — see actual spend',
  sqs: 'Charged per request — see actual spend',
  sns: 'Charged per message — see actual spend',
  cloudfront: 'Charged per request and GB served — see actual spend',
  'route53-zone': 'Hosted zone plus per-query charges — see actual spend',
  'waf-web-acl': 'Per web ACL, rule and request — see actual spend',
  'eventbridge-rule': 'Charged per event — see actual spend',
  'network-firewall': 'Per endpoint-hour and GB processed — see actual spend',
  'vpc-endpoint': 'Per endpoint-hour and GB processed — see actual spend',
}

interface PriceItem {
  component: string
  key: PriceKey
  /** Hours for hourly prices, GiB for storage. */
  quantity: number
  describe: (price: number) => string
}

const money = (value: number): string => `$${value < 0.1 ? value.toFixed(4) : value.toFixed(3)}`

function hourly(component: string, key: PriceKey, units = 1, unitLabel = ''): PriceItem {
  return {
    component,
    key,
    quantity: HOURS_PER_MONTH * units,
    describe: (price) =>
      `${money(price)}/hr${units !== 1 ? ` × ${units}${unitLabel}` : ''} × ${HOURS_PER_MONTH} h`,
  }
}

function storage(component: string, key: PriceKey, gib: number): PriceItem {
  return { component, key, quantity: gib, describe: (price) => `${money(price)}/GB-month × ${gib} GiB` }
}

/** What to price for one resource, or a reason it cannot be priced. */
export function priceItems(node: GraphNode): PriceItem[] | { reason: string } {
  const region = node.region
  const type = instanceType(node)

  switch (node.type) {
    case 'ec2': {
      const items: PriceItem[] = []
      // A stopped instance bills nothing for compute; its volumes still bill.
      if (isRunning(node)) {
        if (!type) return { reason: 'Instance type not recorded' }
        items.push(hourly(`Instance (${type})`, { kind: 'ec2', region, instanceType: type }))
      }
      for (const volume of attachedVolumes(node)) {
        items.push(storage(`Volume ${volume.id} (${volume.type})`, { kind: 'ebs', region, volumeType: volume.type }, volume.sizeGiB))
      }
      return items.length > 0 ? items : { reason: 'Stopped, and no attached volumes recorded' }
    }
    case 'ebs-volume': {
      const volume = standaloneVolume(node)
      if (!volume) return { reason: 'Volume size or type not recorded' }
      return [storage(`Volume (${volume.type}, unattached)`, { kind: 'ebs', region, volumeType: volume.type }, volume.sizeGiB)]
    }
    case 'rds':
    case 'rds-cluster': {
      if (!isRunning(node)) return { reason: 'Stopped' }
      const name = rdsEngineName(engine(node) ?? '')
      if (!type) return { reason: 'Instance class not recorded' }
      if (!name) return { reason: 'Commercial engine: licence model not recorded, so not estimated' }
      const multiAz = isMultiAz(node)
      const items = [
        hourly(`Instance (${type}${multiAz ? ', Multi-AZ' : ''})`, {
          kind: 'rds',
          region,
          instanceClass: type,
          engine: name,
          multiAz,
        }),
      ]
      const disk = rdsStorage(node)
      // Aurora storage is billed per GB used across the cluster, not allocated.
      if (disk && !name.startsWith('Aurora')) {
        items.push(storage(`Storage (${disk.type})`, { kind: 'rds-storage', region, storageType: disk.type, multiAz }, disk.sizeGiB))
      }
      return items
    }
    case 'elasticache': {
      if (!type) return { reason: 'Node type not recorded' }
      const cacheEngine = (engine(node) ?? 'redis').toLowerCase().includes('memcached') ? 'Memcached' : 'Redis'
      const count = cacheNodeCount(node)
      return [
        hourly(`Nodes (${count} × ${type})`, { kind: 'elasticache', region, nodeType: type, engine: cacheEngine }, count, ' nodes'),
      ]
    }
    case 'nat-gateway':
      return [hourly('NAT gateway (hourly; data processing not included)', { kind: 'nat', region })]
    case 'alb':
    case 'nlb':
      return [hourly('Load balancer (hourly; capacity units not included)', { kind: node.type, region })]
    case 'ecs-task': {
      if (!isRunning(node)) return { reason: 'Not running' }
      const size = fargateSize(node)
      if (!size) return { reason: 'EC2 launch type: billed through the instances it runs on' }
      return [
        hourly(`Fargate vCPU`, { kind: 'fargate-vcpu', region }, size.vcpu, ' vCPU'),
        hourly(`Fargate memory`, { kind: 'fargate-gb', region }, size.gb, ' GB'),
      ]
    }
    default: {
      const usage = USAGE_BASED[node.type]
      return usage ? { reason: usage } : []
    }
  }
}

/** Every price the graph needs, for loading ahead of estimation. */
export function neededPrices(graph: Graph): PriceKey[] {
  return graph.nodes.flatMap((node) => {
    const items = priceItems(node)
    return Array.isArray(items) ? items.map((item) => item.key) : []
  })
}

export function estimateRunRate(graph: Graph, book: PriceBook, failure: string | null = null): RunRate {
  const lines: EstimateLine[] = []
  const unpriced: RunRate['unpriced'] = []

  for (const node of graph.nodes) {
    const items = priceItems(node)
    if (!Array.isArray(items)) {
      unpriced.push({ nodeId: node.id, reason: items.reason })
      continue
    }
    let missing = false
    for (const item of items) {
      const price = book.get(item.key)
      if (price === null) {
        missing = true
        continue
      }
      lines.push({
        nodeId: node.id,
        component: item.component,
        monthlyUsd: Math.round(price * item.quantity * 100) / 100,
        basis: item.describe(price),
      })
    }
    if (missing) unpriced.push({ nodeId: node.id, reason: failure ? 'Prices unavailable' : 'No list price found for part of this resource' })
  }

  return { source: book.source, lines, unpriced, message: failure }
}
