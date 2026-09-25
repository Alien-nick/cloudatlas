import {
  type GraphNode,
  type NodeCategory,
  type NodeType,
  type PropEntry,
  type Tag,
  type TargetGroupRef,
} from '@cloudatlas/shared'
import { buildConsoleUrl } from './console-url.js'
import { POSTURE_FACTS } from './posture-facts.js'

// ---------------------------------------------------------------------------
// Shared node-construction helpers
//
// Used by build.ts (VPC-resident resources) and services.ts (regional and
// global services). Kept in one place so a node built by either path has the
// same shape — the canvas, the detail panel and the posture detectors all
// assume every node was made the same way.
// ---------------------------------------------------------------------------

/** EC2/RDS use `Key`/`Value`; ECS uses `key`/`value`. Accept either. */
type AwsTag = { Key?: string; Value?: string; key?: string; value?: string }

export function toTags(tags: AwsTag[] | undefined): Tag[] {
  return (tags ?? [])
    .map((tag) => {
      const key = tag.Key ?? tag.key
      const value = tag.Value ?? tag.value
      return key ? { key, value: value ?? '' } : null
    })
    .filter((tag): tag is Tag => tag !== null)
}

export function tagValue(tags: Tag[], key: string): string | undefined {
  return tags.find((tag) => tag.key.toLowerCase() === key.toLowerCase())?.value
}

/** "Name" tag if present, otherwise the resource id. */
export function displayName(tags: Tag[], fallback: string): string {
  const name = tagValue(tags, 'Name')
  return name && name.length > 0 ? name : fallback
}

export function prop(k: string, v: string | number | boolean | null | undefined, mono = true): PropEntry | null {
  if (v === null || v === undefined || v === '') return null
  return { k, v: String(v), mono }
}

export function props(entries: Array<PropEntry | null>): PropEntry[] {
  return entries.filter((entry): entry is PropEntry => entry !== null)
}

/**
 * Encryption state across an instance's attached volumes, in the vocabulary the
 * posture detector matches on. Returns null when there are no volumes, so the
 * prop is omitted rather than claiming everything is encrypted.
 */
export function ebsEncryptionFact(volumes: Array<{ Encrypted?: boolean }>): string | null {
  if (volumes.length === 0) return null
  const unencrypted = volumes.filter((volume) => volume.Encrypted !== true).length
  return unencrypted === 0
    ? POSTURE_FACTS.ebsEncryption.allEncrypted
    : POSTURE_FACTS.ebsEncryption.unencrypted(unencrypted, volumes.length)
}

/** `service:cortex-api` -> `cortex-api`; anything else yields null. */
export function serviceNameOf(group: string | undefined): string | null {
  if (!group || !group.startsWith('service:')) return null
  const name = group.slice('service:'.length)
  return name.length > 0 ? name : null
}

/** Last segment of an ARN-ish string, for display. */
export function lastSegment(value: string): string {
  const slash = value.lastIndexOf('/')
  return slash === -1 ? value : value.slice(slash + 1)
}

export interface NodeInit {
  id: string
  type: NodeType
  category: NodeCategory
  name: string
  abbr: string
  typeLabel: string
  region: string
  subtitle?: string
  arn?: string | null
  az?: string | null
  vpcId?: string | null
  subnetId?: string | null
  parentId: string | null
  state: string
  tags?: Tag[]
  props?: PropEntry[]
  raw: unknown
  logGroups?: string[]
  securityGroupIds?: string[]
  cidr?: string
  isPublic?: boolean
  targetGroups?: TargetGroupRef[]
  consoleId?: string
  consoleExtra?: Parameters<typeof buildConsoleUrl>[3]
}

export function node(init: NodeInit): GraphNode {
  return {
    id: init.id,
    arn: init.arn ?? null,
    type: init.type,
    category: init.category,
    name: init.name,
    abbr: init.abbr,
    subtitle: init.subtitle,
    typeLabel: init.typeLabel,
    region: init.region,
    az: init.az ?? null,
    vpcId: init.vpcId ?? null,
    subnetId: init.subnetId ?? null,
    parentId: init.parentId,
    state: init.state,
    tags: init.tags ?? [],
    props: init.props ?? [],
    raw: init.raw,
    logGroups: init.logGroups ?? [],
    health: 'unknown',
    securityGroupIds: init.securityGroupIds ?? [],
    monthlyCostUsd: null,
    cidr: init.cidr,
    isPublic: init.isPublic,
    targetGroups: init.targetGroups,
    consoleUrl: init.consoleId
      ? buildConsoleUrl(init.type, init.region, init.consoleId, init.consoleExtra ?? {})
      : null,
  }
}


export const azId = (vpcId: string, az: string): string => `az:${vpcId}:${az}`
export const regionId = (region: string): string => `region:${region}`
export const laneId = (region: string): string => `lane:${region}`
export const GLOBAL_LANE_ID = 'lane:global'
