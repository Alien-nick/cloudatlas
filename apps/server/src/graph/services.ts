import type { GraphEdge, GraphNode, Tag } from '@cloudatlas/shared'
import type { GlobalScanData, RegionScanData, WafData } from '../collectors/types.js'
import { describeLoggingDestination, summarizeRules } from '../collectors/waf.js'
import { GLOBAL_LANE_ID, laneId, node, prop, props, toTags } from './helpers.js'
import { POSTURE_FACTS } from './posture-facts.js'

/**
 * Nodes for services that are not VPC-resident, and the edges between them.
 *
 * Split from build.ts because the placement rules are different: these sit in a
 * region's service lane or in the global lane rather than inside a subnet, and
 * several of them only connect to the rest of the graph by name resolution
 * rather than by an id the API handed us.
 */

function tagsFromRecord(record: Record<string, string> | undefined): Tag[] {
  if (!record) return []
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

/** Queue name is the last segment of the URL. */
export function queueNameFromUrl(url: string): string {
  const parts = url.split('/')
  return parts[parts.length - 1] ?? url
}

/**
 * Trust-policy principal, e.g. "lambda.amazonaws.com".
 *
 * The document arrives URL-encoded inside the API response, which is easy to
 * miss: `JSON.parse` on the raw value throws, and a try/catch that swallows it
 * would silently drop the one fact that makes a role node worth drawing.
 */
export function trustedPrincipals(document: string | undefined): string[] {
  if (!document) return []
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(document))
    const statements = (parsed as { Statement?: unknown }).Statement
    if (!Array.isArray(statements)) return []
    const out: string[] = []
    for (const statement of statements) {
      const service = (statement as { Principal?: { Service?: string | string[] } }).Principal
        ?.Service
      if (typeof service === 'string') out.push(service)
      else if (Array.isArray(service)) out.push(...service)
    }
    return [...new Set(out)]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Regional services
// ---------------------------------------------------------------------------

/**
 * Lambda, SQS and Network Firewall for one region.
 *
 * A VPC-attached Lambda is placed in one of its subnets so the diagram shows it
 * inside the network it can actually reach; everything else goes in the region
 * lane.
 */
export function buildRegionalServiceNodes(
  data: RegionScanData,
  region: string,
  accountId: string,
): GraphNode[] {
  const nodes: GraphNode[] = []

  for (const fn of data.functions) {
    if (!fn.FunctionName || !fn.FunctionArn) continue
    const tags = tagsFromRecord(data.functionTags[fn.FunctionArn])
    const subnetIds = fn.VpcConfig?.SubnetIds ?? []
    const inVpc = subnetIds.length > 0
    const logGroup = fn.LoggingConfig?.LogGroup ?? `/aws/lambda/${fn.FunctionName}`

    nodes.push(
      node({
        id: fn.FunctionArn,
        type: 'lambda',
        category: 'compute',
        name: fn.FunctionName,
        abbr: 'λ',
        subtitle: fn.Runtime,
        typeLabel: 'Lambda function',
        region,
        arn: fn.FunctionArn,
        consoleId: fn.FunctionName,
        ...(inVpc
          ? {
              vpcId: fn.VpcConfig?.VpcId ?? null,
              subnetId: subnetIds[0] ?? null,
              parentId: subnetIds[0] ?? laneId(region),
            }
          : { parentId: laneId(region) }),
        state: fn.State === 'Active' ? 'active' : (fn.State ?? 'unknown'),
        tags,
        securityGroupIds: fn.VpcConfig?.SecurityGroupIds ?? [],
        logGroups: [logGroup],
        raw: fn,
        props: props([
          prop('Function', fn.FunctionName),
          prop('Runtime', fn.Runtime),
          prop('Memory', fn.MemorySize ? `${fn.MemorySize} MB` : undefined),
          prop('Timeout', fn.Timeout ? `${fn.Timeout}s` : undefined),
          prop('Handler', fn.Handler),
          prop('Architecture', (fn.Architectures ?? []).join(', ')),
          prop('IAM role', fn.Role),
          prop('VPC', inVpc ? subnetIds.join(', ') : 'not attached to a VPC'),
          prop('Log group', logGroup),
          prop('Last modified', fn.LastModified),
        ]),
      }),
    )
  }

  for (const url of data.queueUrls) {
    const attributes = data.queueAttributes[url] ?? {}
    const arn = attributes.QueueArn ?? url
    const name = queueNameFromUrl(url)
    const isFifo = name.endsWith('.fifo')
    const encrypted = attributes.KmsMasterKeyId ?? (attributes.SqsManagedSseEnabled === 'true' ? 'SSE-SQS' : null)
    const redrive = attributes.RedrivePolicy

    nodes.push(
      node({
        id: arn,
        type: 'sqs',
        category: 'integration',
        name,
        abbr: 'SQS',
        subtitle: isFifo ? 'FIFO queue' : 'standard queue',
        typeLabel: 'SQS queue',
        region,
        arn,
        consoleId: url,
        parentId: laneId(region),
        state: 'active',
        tags: tagsFromRecord(data.queueTags[url]),
        raw: { url, attributes },
        props: props([
          prop('Queue', name),
          prop('URL', url),
          prop('Type', isFifo ? 'FIFO' : 'Standard'),
          prop('Messages available', attributes.ApproximateNumberOfMessages),
          prop('Messages in flight', attributes.ApproximateNumberOfMessagesNotVisible),
          prop('Visibility timeout', attributes.VisibilityTimeout ? `${attributes.VisibilityTimeout}s` : undefined),
          prop('Retention', attributes.MessageRetentionPeriod ? `${attributes.MessageRetentionPeriod}s` : undefined),
          // Read by the unencrypted-storage posture detector.
          prop(POSTURE_FACTS.storageEncryption.key, encrypted ?? POSTURE_FACTS.storageEncryption.absent),
          prop('Dead-letter queue', redrive ? redriveTarget(redrive) : 'none'),
        ]),
      }),
    )
  }

  for (const meta of data.firewallMetadata) {
    const arn = meta.FirewallArn
    if (!arn) continue
    const firewall = data.firewalls[arn]
    const logging = data.firewallLogging[arn]
    const subnetIds = (firewall?.SubnetMappings ?? [])
      .map((mapping) => mapping.SubnetId)
      .filter((id): id is string => typeof id === 'string')

    nodes.push(
      node({
        id: arn,
        type: 'network-firewall',
        category: 'security',
        name: firewall?.FirewallName ?? meta.FirewallName ?? arn,
        abbr: 'NFW',
        subtitle: 'Network Firewall',
        typeLabel: 'AWS Network Firewall',
        region,
        arn,
        consoleId: firewall?.FirewallName ?? meta.FirewallName,
        vpcId: firewall?.VpcId ?? null,
        subnetId: subnetIds[0] ?? null,
        parentId: subnetIds[0] ?? laneId(region),
        state: 'active',
        tags: toTags(firewall?.Tags),
        raw: { ...meta, ...firewall },
        props: props([
          prop('Firewall', firewall?.FirewallName ?? meta.FirewallName),
          prop('VPC', firewall?.VpcId),
          prop('Subnets', subnetIds.join(', ')),
          prop('Policy', firewall?.FirewallPolicyArn),
          prop('Delete protection', firewall?.DeleteProtection ? 'on' : 'off'),
          prop(
            'Logging',
            (logging?.LogDestinationConfigs ?? [])
              .map((config) => `${config.LogType}:${config.LogDestinationType}`)
              .join(', ') || 'not configured',
          ),
        ]),
      }),
    )
  }

  // Buckets are collected once for the account but belong to a region, so they
  // are placed by their own location rather than by the pass that found them.
  void accountId
  return nodes
}

/** `{"deadLetterTargetArn":"arn:...:dlq"}` -> the queue name. */
function redriveTarget(policy: string): string {
  try {
    const parsed: unknown = JSON.parse(policy)
    const arn = (parsed as { deadLetterTargetArn?: string }).deadLetterTargetArn
    if (!arn) return 'configured'
    const name = arn.split(':').pop()
    const count = (parsed as { maxReceiveCount?: number }).maxReceiveCount
    return count ? `${name} after ${count} receives` : (name ?? 'configured')
  } catch {
    return 'configured'
  }
}

/** S3 buckets whose location is this region. */
export function buildBucketNodes(global: GlobalScanData, region: string): GraphNode[] {
  const nodes: GraphNode[] = []
  for (const bucket of global.buckets) {
    const name = bucket.Name
    if (!name) continue
    if ((global.bucketRegions[name] ?? 'us-east-1') !== region) continue

    const encryption = global.bucketEncryption[name]
    const blocked = global.bucketPublicAccessBlocked[name]

    nodes.push(
      node({
        id: `arn:aws:s3:::${name}`,
        type: 's3',
        category: 'storage',
        name,
        abbr: 'S3',
        subtitle: 'S3 bucket',
        typeLabel: 'S3 bucket',
        region,
        arn: `arn:aws:s3:::${name}`,
        consoleId: name,
        parentId: laneId(region),
        state: 'active',
        tags: tagsFromRecord(global.bucketTags[name]),
        raw: bucket,
        props: props([
          prop('Bucket', name),
          prop('Created', bucket.CreationDate ? new Date(bucket.CreationDate).toISOString() : undefined),
          // Three distinct states, and conflating any two of them misleads.
          // `undefined` means the call failed, so nothing is claimed. `null`
          // means no bucket-level default policy is set — which since 2023 is
          // not the same as unencrypted, because S3 applies SSE-S3 to new
          // objects regardless. Only an explicit algorithm is reported as one.
          encryption === undefined
            ? null
            : prop(
                POSTURE_FACTS.storageEncryption.key,
                encryption ?? 'no bucket default policy (objects still use SSE-S3)',
              ),
          blocked === undefined
            ? null
            : prop('Public access', blocked ? 'blocked (all four settings)' : 'NOT fully blocked'),
        ]),
      }),
    )
  }
  return nodes
}

// ---------------------------------------------------------------------------
// Global services
// ---------------------------------------------------------------------------

export interface BuiltGlobal {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * CloudFront, Route 53 and the IAM roles something else references.
 *
 * `referencedRoleArns` is passed in rather than derived here: only the region
 * builders know which roles an instance profile, task or function actually
 * uses, and an account's full role list is mostly service-linked roles that
 * would bury the handful that are part of the architecture.
 */
export function buildGlobalGraph(
  global: GlobalScanData,
  referencedRoleArns: Set<string>,
): BuiltGlobal {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  for (const distribution of global.distributions) {
    if (!distribution.Id || !distribution.DomainName) continue
    const aliases = distribution.Aliases?.Items ?? []
    const origins = (distribution.Origins?.Items ?? [])
      .map((origin) => origin.DomainName)
      .filter((name): name is string => typeof name === 'string')

    nodes.push(
      node({
        id: distribution.ARN ?? distribution.Id,
        type: 'cloudfront',
        category: 'network',
        name: aliases[0] ?? distribution.DomainName,
        abbr: 'CF',
        subtitle: 'CloudFront',
        typeLabel: 'CloudFront distribution',
        region: 'global',
        arn: distribution.ARN ?? null,
        consoleId: distribution.Id,
        parentId: GLOBAL_LANE_ID,
        state: distribution.Enabled ? (distribution.Status ?? 'Deployed') : 'disabled',
        raw: distribution,
        props: props([
          prop('Distribution ID', distribution.Id),
          prop('Domain', distribution.DomainName),
          prop('Aliases', aliases.join(', ') || 'none'),
          prop('Origins', origins.join(', ')),
          prop('Price class', distribution.PriceClass),
          prop('HTTP version', distribution.HttpVersion),
          prop(
            'Viewer protocol',
            distribution.DefaultCacheBehavior?.ViewerProtocolPolicy,
          ),
          prop('Web ACL', distribution.WebACLId || 'none'),
        ]),
      }),
    )
  }

  for (const zone of global.hostedZones) {
    if (!zone.Id || !zone.Name) continue
    const records = global.recordSets[zone.Id] ?? []
    nodes.push(
      node({
        id: zone.Id,
        type: 'route53-zone',
        category: 'network',
        name: zone.Name.replace(/\.$/, ''),
        abbr: 'R53',
        subtitle: zone.Config?.PrivateZone ? 'private zone' : 'public zone',
        typeLabel: 'Route 53 hosted zone',
        region: 'global',
        consoleId: zone.Id.replace('/hostedzone/', ''),
        parentId: GLOBAL_LANE_ID,
        state: 'active',
        raw: { zone, records },
        props: props([
          prop('Zone', zone.Name),
          prop('Zone ID', zone.Id.replace('/hostedzone/', '')),
          prop('Visibility', zone.Config?.PrivateZone ? 'private' : 'public'),
          prop('Records', zone.ResourceRecordSetCount),
          prop(
            'Linking records',
            records.length > 0 ? `${records.length} A/AAAA/CNAME or alias` : 'none',
          ),
        ]),
      }),
    )
  }

  for (const role of global.roles) {
    if (!role.Arn || !role.RoleName) continue
    if (!referencedRoleArns.has(role.Arn)) continue
    const principals = trustedPrincipals(role.AssumeRolePolicyDocument)

    nodes.push(
      node({
        id: role.Arn,
        type: 'iam-role',
        category: 'security',
        name: role.RoleName,
        abbr: 'IAM',
        subtitle: 'IAM role',
        typeLabel: 'IAM role',
        region: 'global',
        arn: role.Arn,
        consoleId: role.RoleName,
        parentId: GLOBAL_LANE_ID,
        state: 'active',
        tags: toTags(role.Tags),
        raw: role,
        props: props([
          prop('Role', role.RoleName),
          prop('Path', role.Path),
          prop('Trusted services', principals.join(', ') || 'none found in trust policy'),
          prop('Max session', role.MaxSessionDuration ? `${role.MaxSessionDuration}s` : undefined),
          prop('Created', role.CreateDate ? new Date(role.CreateDate).toISOString() : undefined),
          prop('Permission boundary', role.PermissionsBoundary?.PermissionsBoundaryArn ?? 'none'),
        ]),
      }),
    )
  }

  // CLOUDFRONT-scope web ACLs are account-wide, so they belong here rather
  // than in any one region's lane.
  nodes.push(...buildWebAclNodes(global, 'CLOUDFRONT'))

  if (nodes.length > 0) {
    nodes.unshift(
      node({
        id: GLOBAL_LANE_ID,
        type: 'lane',
        category: 'network',
        name: 'Edge & global services',
        abbr: 'G',
        typeLabel: 'Service lane',
        region: 'global',
        parentId: null,
        state: 'active',
        raw: {},
      }),
    )
  }

  return { nodes, edges }
}

/** Role ARNs referenced by instances, tasks and functions in one region. */
export function referencedRoles(data: RegionScanData): string[] {
  const arns: string[] = []
  for (const fn of data.functions) if (fn.Role) arns.push(fn.Role)
  for (const instance of data.instances) {
    // An instance profile ARN is not a role ARN; the role it contains has the
    // same name but a different path. Matching by name happens in the caller.
    const profile = instance.IamInstanceProfile?.Arn
    if (profile) arns.push(profile)
  }
  for (const definition of Object.values(data.taskDefinitions)) {
    if (definition.taskRoleArn) arns.push(definition.taskRoleArn)
    if (definition.executionRoleArn) arns.push(definition.executionRoleArn)
  }
  return arns
}

// ---------------------------------------------------------------------------
// Cross-graph edges
// ---------------------------------------------------------------------------

/** Trailing-dot-insensitive, lowercase. DNS names are case-insensitive. */
function normalizeDns(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * Index every DNS name the graph knows about, so a Route 53 alias or a
 * CloudFront origin can be resolved to the node it actually points at.
 *
 * This is name-based rather than id-based, which is the only option AWS gives
 * us here: an alias record stores a hostname, not an ARN. That makes it the
 * one place in the builder where a match can be *wrong* rather than merely
 * missing, so only exact names are matched — no suffix or prefix heuristics.
 */
export function dnsIndex(nodes: GraphNode[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const candidate of nodes) {
    for (const entry of candidate.props) {
      if (entry.k !== 'DNS name' && entry.k !== 'Domain' && entry.k !== 'Endpoint') continue
      const key = normalizeDns(entry.v)
      // First writer wins, so a resource cannot be stolen by a later node that
      // happens to advertise the same name.
      if (key.length > 0 && !index.has(key)) index.set(key, candidate.id)
    }
    // S3 website and REST endpoints are derivable from the bucket name.
    if (candidate.type === 's3') {
      index.set(normalizeDns(`${candidate.name}.s3.amazonaws.com`), candidate.id)
      index.set(normalizeDns(`${candidate.name}.s3.${candidate.region}.amazonaws.com`), candidate.id)
    }
  }
  return index
}

/**
 * Edges that can only be resolved once every region and the global pass have
 * been built: SQS into Lambda, Route 53 into whatever it aliases, CloudFront
 * into its origins.
 */
export function buildServiceEdges(
  nodes: GraphNode[],
  regions: RegionScanData[],
  global: GlobalScanData,
): GraphEdge[] {
  const edges: GraphEdge[] = []
  const byId = new Set(nodes.map((candidate) => candidate.id))
  const dns = dnsIndex(nodes)

  // --- event sources: SQS/streams -> Lambda ------------------------------
  for (const data of regions) {
    for (const mapping of data.eventSourceMappings) {
      const source = mapping.EventSourceArn
      const target = mapping.FunctionArn
      if (!source || !target) continue
      if (!byId.has(source) || !byId.has(target)) continue
      edges.push({
        id: `event:${source}->${target}`,
        source,
        target,
        kind: 'event',
        label: mapping.BatchSize ? `batch ${mapping.BatchSize}` : undefined,
        meta: { via: 'event source mapping', state: mapping.State ?? 'unknown' },
      })
    }

    // --- dead-letter queues --------------------------------------------
    for (const [url, attributes] of Object.entries(data.queueAttributes)) {
      const arn = attributes.QueueArn
      const policy = attributes.RedrivePolicy
      if (!arn || !policy) continue
      try {
        const parsed: unknown = JSON.parse(policy)
        const dlq = (parsed as { deadLetterTargetArn?: string }).deadLetterTargetArn
        if (!dlq || !byId.has(dlq) || !byId.has(arn)) continue
        edges.push({
          id: `event:${arn}->${dlq}:dlq`,
          source: arn,
          target: dlq,
          kind: 'event',
          label: 'DLQ',
          meta: { via: 'redrive policy' },
        })
      } catch {
        // A malformed redrive policy costs this edge, not the scan.
      }
      void url
    }
  }

  // --- S3 bucket notifications -------------------------------------------
  for (const [bucket, targets] of Object.entries(global.bucketNotifications)) {
    const source = `arn:aws:s3:::${bucket}`
    if (!byId.has(source)) continue
    for (const target of targets) {
      // An SNS topic is a valid destination but is not collected as a node, so
      // the edge is skipped rather than pointing at nothing.
      if (!byId.has(target)) continue
      edges.push({
        id: `event:${source}->${target}`,
        source,
        target,
        kind: 'event',
        meta: { via: 'bucket notification' },
      })
    }
  }

  // --- CloudFront -> origins ---------------------------------------------
  for (const distribution of global.distributions) {
    const id = distribution.ARN ?? distribution.Id
    if (!id || !byId.has(id)) continue
    for (const origin of distribution.Origins?.Items ?? []) {
      if (!origin.DomainName) continue
      const target = dns.get(normalizeDns(origin.DomainName))
      if (!target || target === id) continue
      edges.push({
        id: `traffic:${id}->${target}:origin`,
        source: id,
        target,
        kind: 'traffic',
        meta: { via: 'CloudFront origin' },
      })
    }
  }

  // --- Route 53 -> alias targets -----------------------------------------
  for (const zone of global.hostedZones) {
    const zoneId = zone.Id
    if (!zoneId || !byId.has(zoneId)) continue
    for (const record of global.recordSets[zoneId] ?? []) {
      const alias = record.AliasTarget?.DNSName
      const cname = record.Type === 'CNAME' ? record.ResourceRecords?.[0]?.Value : undefined
      const pointer = alias ?? cname
      if (!pointer) continue
      const target = dns.get(normalizeDns(pointer))
      if (!target) continue
      edges.push({
        id: `traffic:${zoneId}->${target}:${record.Name ?? ''}`,
        source: zoneId,
        target,
        kind: 'traffic',
        label: record.Name?.replace(/\.$/, ''),
        meta: { via: alias ? 'alias record' : 'CNAME' },
      })
    }
  }

  // De-duplicate: a zone with several records aliasing one target should draw
  // one edge, not one per record.
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const key = `${edge.source}->${edge.target}:${edge.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}


// ---------------------------------------------------------------------------
// WAF
// ---------------------------------------------------------------------------

/**
 * Web ACL nodes for either scope.
 *
 * A CLOUDFRONT ACL is account-wide and lands in the global lane; a REGIONAL one
 * protects resources in its own region and lands in that region's lane. Both
 * come from the same shape, so one builder covers them.
 */
export function buildWebAclNodes(data: WafData, forScope: 'REGIONAL' | 'CLOUDFRONT'): GraphNode[] {
  const nodes: GraphNode[] = []

  for (const summary of data.webAclSummaries) {
    if (summary.Scope !== forScope) continue
    if (!summary.ARN || !summary.Name) continue

    const acl = data.webAcls[summary.ARN]
    const { managed, custom, rateLimits } = summarizeRules(acl)
    const protectedArns = data.webAclResources[summary.ARN] ?? []
    const isGlobal = forScope === 'CLOUDFRONT'
    const region = isGlobal ? 'global' : summary.Region

    nodes.push(
      node({
        id: summary.ARN,
        type: 'waf-web-acl',
        category: 'security',
        name: summary.Name,
        abbr: 'WAF',
        subtitle: `WAF v2 web ACL · ${isGlobal ? 'global' : summary.Region}`,
        typeLabel: 'WAF v2 web ACL',
        region,
        arn: summary.ARN,
        consoleId: summary.Id,
        parentId: isGlobal ? GLOBAL_LANE_ID : laneId(summary.Region),
        state: 'active',
        raw: acl ?? summary,
        props: props([
          prop('Scope', forScope),
          prop('Web ACL ID', summary.Id),
          prop('Description', summary.Description),
          prop('Rules', `${managed} managed, ${custom} custom`),
          prop('Default action', acl?.DefaultAction?.Allow ? 'Allow' : acl?.DefaultAction?.Block ? 'Block' : undefined),
          prop('Rate limit', rateLimits.join(' · ') || 'none'),
          prop('Associated', protectedArns.length > 0 ? String(protectedArns.length) : isGlobal ? 'CloudFront distributions' : 'none'),
          prop('Capacity', acl?.Capacity ? `${acl.Capacity} WCU` : undefined),
          prop('Logging', describeLoggingDestination(data.webAclLogging[summary.ARN])),
        ]),
      }),
    )
  }
  return nodes
}

/**
 * Edges from a web ACL to what it protects.
 *
 * REGIONAL associations are read directly from ListResourcesForWebACL. The
 * CloudFront side is the reverse: a distribution names its ACL in `WebACLId`,
 * which for WAF v2 is the ACL ARN rather than an id despite the field name.
 */
export function buildWafEdges(
  nodes: GraphNode[],
  regions: RegionScanData[],
  global: GlobalScanData,
): GraphEdge[] {
  const edges: GraphEdge[] = []
  const byId = new Set(nodes.map((candidate) => candidate.id))

  for (const data of [...regions, global]) {
    for (const [aclArn, resourceArns] of Object.entries(data.webAclResources)) {
      if (!byId.has(aclArn)) continue
      for (const resourceArn of resourceArns) {
        if (!byId.has(resourceArn)) continue
        edges.push({
          id: `sg:${aclArn}->${resourceArn}`,
          source: aclArn,
          target: resourceArn,
          kind: 'sg',
          meta: { via: 'web ACL association' },
        })
      }
    }
  }

  for (const distribution of global.distributions) {
    const id = distribution.ARN ?? distribution.Id
    const aclArn = distribution.WebACLId
    if (!id || !aclArn || !byId.has(id) || !byId.has(aclArn)) continue
    edges.push({
      id: `sg:${aclArn}->${id}`,
      source: aclArn,
      target: id,
      kind: 'sg',
      meta: { via: 'web ACL association' },
    })
  }

  return edges
}
