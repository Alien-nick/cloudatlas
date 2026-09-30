import { GetProductsCommand, type GetProductsCommandOutput } from '@aws-sdk/client-pricing'
import type { AwsClient } from '../aws/client.js'

/**
 * On-demand list prices from the AWS Price List API.
 *
 * Free to call, and asked only for what the scan contains: the handful of
 * instance types, database classes and volume types actually running, in the
 * regions they run in. Prices are cached for a day, because list prices change
 * a few times a year and a scan runs every few minutes.
 *
 * Every price is on-demand, Linux, shared tenancy — the list price. Reserved
 * instances, savings plans, enterprise discounts and credits all make the real
 * bill lower, which is why the UI calls these estimates.
 */

export type PriceKey =
  | { kind: 'ec2'; region: string; instanceType: string }
  | { kind: 'ebs'; region: string; volumeType: string }
  | { kind: 'rds'; region: string; instanceClass: string; engine: string; multiAz: boolean }
  | { kind: 'rds-storage'; region: string; storageType: string; multiAz: boolean }
  | { kind: 'elasticache'; region: string; nodeType: string; engine: string }
  | { kind: 'nat'; region: string }
  | { kind: 'alb' | 'nlb'; region: string }
  | { kind: 'fargate-vcpu' | 'fargate-gb'; region: string }

/** Hourly price, or per GB-month for storage kinds. */
export interface PriceBook {
  readonly source: string
  get(key: PriceKey): number | null
}

export function priceKeyId(key: PriceKey): string {
  return Object.values(key).map(String).join('|')
}

/** The unit each kind is priced in, as the Price List API names it. */
export function unitOf(key: PriceKey): 'Hrs' | 'GB-Mo' {
  return key.kind === 'ebs' || key.kind === 'rds-storage' ? 'GB-Mo' : 'Hrs'
}

// ---------------------------------------------------------------------------
// Price List API queries
// ---------------------------------------------------------------------------

interface Query {
  serviceCode: string
  filters: Record<string, string>
  /** Picks among several products when the filters cannot narrow to one. */
  pick?: (attributes: Record<string, string>) => boolean
}

/** RDS engine strings, as the scan reports them, to the Price List's names. */
export function rdsEngineName(engine: string): string | null {
  const name = engine.toLowerCase()
  if (name.includes('aurora') && name.includes('postgres')) return 'Aurora PostgreSQL'
  if (name.includes('aurora')) return 'Aurora MySQL'
  if (name.includes('postgres')) return 'PostgreSQL'
  if (name.includes('mariadb')) return 'MariaDB'
  if (name.includes('mysql')) return 'MySQL'
  // Oracle and SQL Server prices depend on licence model and edition, which
  // the scan does not carry; a guess would be wrong by multiples.
  return null
}

const RDS_STORAGE: Record<string, string> = {
  gp2: 'General Purpose',
  gp3: 'General Purpose-GP3',
  io1: 'Provisioned IOPS',
  io2: 'Provisioned IOPS-IO2',
  standard: 'Magnetic',
}

export function queryFor(key: PriceKey): Query | null {
  const region = { regionCode: key.region }
  switch (key.kind) {
    case 'ec2':
      return {
        serviceCode: 'AmazonEC2',
        filters: {
          ...region,
          instanceType: key.instanceType,
          operatingSystem: 'Linux',
          tenancy: 'Shared',
          preInstalledSw: 'NA',
          capacitystatus: 'Used',
          licenseModel: 'No License required',
        },
      }
    case 'ebs':
      return { serviceCode: 'AmazonEC2', filters: { ...region, productFamily: 'Storage', volumeApiName: key.volumeType } }
    case 'rds':
      return {
        serviceCode: 'AmazonRDS',
        filters: {
          ...region,
          instanceType: key.instanceClass,
          databaseEngine: key.engine,
          deploymentOption: key.multiAz ? 'Multi-AZ' : 'Single-AZ',
        },
      }
    case 'rds-storage': {
      const volumeType = RDS_STORAGE[key.storageType]
      if (!volumeType) return null
      return {
        serviceCode: 'AmazonRDS',
        filters: {
          ...region,
          productFamily: 'Database Storage',
          volumeType,
          deploymentOption: key.multiAz ? 'Multi-AZ' : 'Single-AZ',
        },
      }
    }
    case 'elasticache':
      return {
        serviceCode: 'AmazonElastiCache',
        filters: { ...region, instanceType: key.nodeType, cacheEngine: key.engine, productFamily: 'Cache Instance' },
      }
    case 'nat':
      return { serviceCode: 'AmazonEC2', filters: { ...region, productFamily: 'NAT Gateway' } }
    case 'alb':
      return { serviceCode: 'AWSELB', filters: { ...region, productFamily: 'Load Balancer-Application' } }
    case 'nlb':
      return { serviceCode: 'AWSELB', filters: { ...region, productFamily: 'Load Balancer-Network' } }
    case 'fargate-vcpu':
    case 'fargate-gb': {
      const usage = key.kind === 'fargate-vcpu' ? 'Fargate-vCPU-Hours:perCPU' : 'Fargate-GB-Hours'
      return {
        serviceCode: 'AmazonECS',
        filters: { ...region, productFamily: 'Compute' },
        // Linux on x86, on demand: the usage type ends in exactly this, while
        // the ARM, Windows and Spot variants carry extra qualifiers.
        pick: (attributes) => (attributes.usagetype ?? '').endsWith(`-${usage}`) || attributes.usagetype === usage,
      }
    }
  }
}

interface Product {
  attributes: Record<string, string>
  prices: Array<{ unit: string; usd: number }>
}

/** One Price List entry: attributes plus every on-demand price dimension. */
export function parseProduct(json: string): Product | null {
  let parsed: {
    product?: { attributes?: Record<string, string> }
    terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, { unit?: string; pricePerUnit?: { USD?: string } }> }> }
  }
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const prices: Product['prices'] = []
  for (const term of Object.values(parsed.terms?.OnDemand ?? {})) {
    for (const dimension of Object.values(term.priceDimensions ?? {})) {
      const usd = Number(dimension.pricePerUnit?.USD)
      if (dimension.unit && Number.isFinite(usd)) prices.push({ unit: dimension.unit, usd })
    }
  }
  return { attributes: parsed.product?.attributes ?? {}, prices }
}

/**
 * The price in the expected unit from the first matching product. A zero
 * price is ignored: free-tier and placeholder rows would otherwise make a
 * resource look free.
 */
export function selectPrice(products: Product[], unit: string, pick?: Query['pick']): number | null {
  for (const product of products) {
    if (pick && !pick(product.attributes)) continue
    const price = product.prices.find((candidate) => candidate.unit === unit && candidate.usd > 0)
    if (price) return price.usd
  }
  return null
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000
const cache = new Map<string, { at: number; price: number | null }>()

export interface LoadedPriceBook {
  book: PriceBook
  /** Set when the API could not be used at all; the run-rate says so. */
  failure: string | null
}

/** Fetch every price the scan needs, then answer from memory. */
export async function loadPriceBook(aws: AwsClient, keys: PriceKey[], now = Date.now()): Promise<LoadedPriceBook> {
  const unique = new Map(keys.map((key) => [priceKeyId(key), key]))
  let failure: string | null = null

  for (const [id, key] of unique) {
    const cached = cache.get(id)
    if (cached && now - cached.at < DAY) continue
    const query = queryFor(key)
    if (!query) {
      cache.set(id, { at: now, price: null })
      continue
    }
    try {
      const products = await getProducts(aws, query)
      cache.set(id, { at: now, price: selectPrice(products, unitOf(key), query.pick) })
    } catch (error) {
      const err = error as Error & { name: string }
      if (err.name === 'AccessDeniedException') {
        failure = 'pricing:GetProducts was denied, so no estimates could be made. Add it to the profile’s policy.'
        break
      }
      // One failed lookup leaves that resource unpriced; it does not stop the rest.
      cache.set(id, { at: now, price: null })
    }
  }

  return {
    failure,
    book: {
      source: 'AWS Price List API · on-demand list prices · Linux, shared tenancy',
      get: (key) => cache.get(priceKeyId(key))?.price ?? null,
    },
  }
}

async function getProducts(aws: AwsClient, query: Query): Promise<Product[]> {
  const products: Product[] = []
  let token: string | undefined
  // Two pages at most: the filters are tight, and anything wider is a query bug
  // worth failing on rather than paginating through thousands of SKUs.
  for (let page = 0; page < 2; page++) {
    const output = await aws.send<GetProductsCommandOutput>(
      'pricing',
      'us-east-1',
      'GetProducts',
      new GetProductsCommand({
        ServiceCode: query.serviceCode,
        FormatVersion: 'aws_v1',
        MaxResults: 100,
        NextToken: token,
        Filters: Object.entries(query.filters).map(([Field, Value]) => ({ Type: 'TERM_MATCH', Field, Value })),
      }),
    )
    for (const json of output.PriceList ?? []) {
      const product = parseProduct(typeof json === 'string' ? json : JSON.stringify(json))
      if (product) products.push(product)
    }
    token = output.NextToken
    if (!token) break
  }
  return products
}

/** For tests: forget cached prices. */
export function clearPriceCache(): void {
  cache.clear()
}
