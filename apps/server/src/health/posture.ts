import type { Finding, GraphNode } from '@cloudatlas/shared'
import { POSTURE_FACTS, isUnencryptedVolumeValue } from '../graph/posture-facts.js'

/**
 * Configuration findings, as opposed to live incidents.
 *
 * These are the detectors that need no CloudWatch, no time-series and no
 * statistics: every fact they rely on was already collected during the scan.
 * That makes them verifiable by eye against a real account, which the spike
 * detector will not be — so they land first and prove the whole findings path
 * (detector → Finding → node badge → health strip → Health view) before
 * anything harder depends on it.
 *
 * `isPostureFinding()` routes all of these into the Posture group and caps the
 * affected node's health at `warn`: a misconfiguration is not an outage.
 */

function propValue(node: GraphNode, key: string): string | undefined {
  return node.props.find((prop) => prop.k === key)?.v
}

function whereClause(node: GraphNode): string {
  return [node.name, node.region].filter(Boolean).join(' · ')
}

/**
 * IMDSv1 lets any process that can make an HTTP request from the instance read
 * its role credentials — which is what turns a server-side request forgery bug
 * into credential theft. IMDSv2 requires a PUT to obtain a token first, which
 * SSRF generally cannot perform.
 */
export function detectImdsV1(nodes: GraphNode[], now: number): Finding[] {
  const findings: Finding[] = []
  for (const node of nodes) {
    if (node.type !== 'ec2') continue
    if (propValue(node, POSTURE_FACTS.imds.key) !== POSTURE_FACTS.imds.v1Allowed) continue

    findings.push({
      id: `imdsv1:${node.id}`,
      nodeId: node.id,
      severity: 'warning',
      kind: 'imdsv1-allowed',
      title: `${node.name} allows IMDSv1`,
      detail:
        'The instance metadata service accepts unauthenticated v1 requests, so any code that can ' +
        'make an HTTP request from this instance can read its IAM role credentials. A server-side ' +
        'request forgery bug in an application on this host becomes credential theft.',
      metric: null,
      startedAt: now,
      endedAt: null,
      evidence: [
        `Instance: ${node.id}`,
        `MetadataOptions.HttpTokens: optional (${POSTURE_FACTS.imds.v1Allowed})`,
        'Remediation: aws ec2 modify-instance-metadata-options --http-tokens required',
      ],
      sparkline: [],
      logGroups: [],
    })
  }
  return findings
}

/**
 * A publicly accessible RDS instance has a resolvable public endpoint. A
 * security group may still be restricting it, so this is reported as a posture
 * finding rather than an incident — but combined with a world-open rule it is
 * the pair that matters, and the risky-rule detector covers the other half.
 */
export function detectPublicDatabase(nodes: GraphNode[], now: number): Finding[] {
  const findings: Finding[] = []
  for (const node of nodes) {
    if (node.type !== 'rds' && node.type !== 'rds-cluster') continue
    if (propValue(node, POSTURE_FACTS.publiclyAccessible.key) !== POSTURE_FACTS.publiclyAccessible.yes) {
      continue
    }

    const endpoint = propValue(node, 'Endpoint')
    findings.push({
      id: `public-database:${node.id}`,
      nodeId: node.id,
      severity: 'critical',
      kind: 'public-database',
      title: `${node.name} is publicly accessible`,
      detail:
        'This database is configured with a public endpoint, so it resolves to a routable address ' +
        'from the internet. Whether traffic actually reaches it depends on its security group — ' +
        'check the Security tab for a rule allowing the database port from 0.0.0.0/0.',
      metric: null,
      startedAt: now,
      endedAt: null,
      evidence: [
        `Instance: ${node.id} (${whereClause(node)})`,
        `PubliclyAccessible: true`,
        ...(endpoint ? [`Endpoint: ${endpoint}`] : []),
        'Remediation: aws rds modify-db-instance --no-publicly-accessible',
      ],
      sparkline: [],
      logGroups: [],
    })
  }
  return findings
}

/**
 * Unencrypted storage at rest.
 *
 * Covers RDS storage and attached EBS volumes. S3 bucket encryption needs the
 * S3 collector, which lands after Milestone 3 — until then this detector is
 * knowingly partial, and says so rather than implying full coverage.
 */
export function detectUnencryptedStorage(nodes: GraphNode[], now: number): Finding[] {
  const findings: Finding[] = []

  for (const node of nodes) {
    if (node.type === 'rds' || node.type === 'rds-cluster') {
      if (propValue(node, POSTURE_FACTS.storageEncryption.key) !== POSTURE_FACTS.storageEncryption.absent) {
        continue
      }
      findings.push({
        id: `unencrypted-storage:${node.id}`,
        nodeId: node.id,
        severity: 'warning',
        kind: 'unencrypted-storage',
        title: `${node.name} storage is not encrypted at rest`,
        detail:
          'This database was created without storage encryption. RDS cannot enable it in place — ' +
          'it requires a snapshot, a copy of that snapshot with encryption enabled, and a restore, ' +
          'so the fix involves downtime and should be planned rather than applied ad hoc.',
        metric: null,
        startedAt: now,
        endedAt: null,
        evidence: [
          `Instance: ${node.id} (${whereClause(node)})`,
          'StorageEncrypted: false',
          'Remediation: snapshot → copy-db-snapshot --kms-key-id → restore-db-instance-from-db-snapshot',
        ],
        sparkline: [],
        logGroups: [],
      })
      continue
    }

    if (node.type === 'ec2') {
      const value = propValue(node, POSTURE_FACTS.ebsEncryption.key)
      if (!value || !isUnencryptedVolumeValue(value)) continue
      findings.push({
        id: `unencrypted-storage:${node.id}`,
        nodeId: node.id,
        severity: 'warning',
        kind: 'unencrypted-storage',
        title: `${node.name} has unencrypted EBS volumes`,
        detail:
          'One or more attached volumes are not encrypted at rest, so their contents are readable ' +
          'from a snapshot. Existing volumes cannot be encrypted in place: the volume has to be ' +
          'snapshotted, the snapshot copied with encryption enabled, and a new volume attached.',
        metric: null,
        startedAt: now,
        endedAt: null,
        evidence: [
          `Instance: ${node.id} (${whereClause(node)})`,
          `${POSTURE_FACTS.ebsEncryption.key}: ${value}`,
          ...(propValue(node, 'EBS') ? [`Volumes: ${propValue(node, 'EBS')}`] : []),
          'Remediation: create-snapshot → copy-snapshot --encrypted → create-volume → attach',
        ],
        sparkline: [],
        logGroups: [],
      })
    }
  }

  return findings
}

/**
 * Every posture detector, in the order they should be read: the one that
 * exposes data to the internet first.
 */
export function detectPosture(nodes: GraphNode[], now: number): Finding[] {
  return [
    ...detectPublicDatabase(nodes, now),
    ...detectImdsV1(nodes, now),
    ...detectUnencryptedStorage(nodes, now),
  ]
}
