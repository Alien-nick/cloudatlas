import { describe, expect, it } from 'vitest'
import type { GraphNode, PropEntry } from '@cloudatlas/shared'
import { isPostureFinding } from '@cloudatlas/shared'
import { emptyRegionScanData } from '../collectors/types.js'
import { buildRegionGraph } from '../graph/build.js'
import { POSTURE_FACTS } from '../graph/posture-facts.js'
import { applyHealth } from './apply.js'
import {
  detectImdsV1,
  detectPosture,
  detectPublicDatabase,
  detectUnencryptedStorage,
} from './posture.js'

const NOW = 1_700_000_000_000
const prop = (k: string, v: string): PropEntry => ({ k, v, mono: true })

function node(patch: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    arn: null,
    type: 'ec2',
    category: 'compute',
    name: patch.id,
    abbr: 'EC2',
    typeLabel: 'EC2 instance',
    region: 'us-east-1',
    az: 'us-east-1a',
    vpcId: null,
    subnetId: null,
    parentId: null,
    state: 'running',
    tags: [],
    props: [],
    raw: {},
    logGroups: [],
    health: 'unknown',
    securityGroupIds: [],
    monthlyCostUsd: null,
    consoleUrl: null,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// The builder ↔ detector contract
// ---------------------------------------------------------------------------

describe('the vocabulary the builder writes is the one the detectors read', () => {
  /**
   * This is the test that matters most. If the builder's wording drifts, the
   * detectors stop firing — and a detector that finds nothing looks exactly
   * like a clean account. Nothing else would fail.
   */
  function buildOne(patch: Partial<Parameters<typeof buildRegionGraph>[0]>) {
    return buildRegionGraph({ ...emptyRegionScanData('us-east-1'), ...patch }, '111122223333')
  }

  it('an IMDSv1 instance produces the string detectImdsV1 matches', () => {
    const built = buildOne({
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
      instances: [
        {
          InstanceId: 'i-1',
          VpcId: 'vpc-1',
          State: { Name: 'running' },
          MetadataOptions: { HttpTokens: 'optional' },
        },
      ],
    })
    const instance = built.nodes.find((n) => n.id === 'i-1')
    expect(instance?.props.find((p) => p.k === POSTURE_FACTS.imds.key)?.v).toBe(
      POSTURE_FACTS.imds.v1Allowed,
    )
    expect(detectImdsV1(built.nodes, NOW)).toHaveLength(1)
  })

  it('an IMDSv2-required instance produces the string that suppresses it', () => {
    const built = buildOne({
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
      instances: [
        {
          InstanceId: 'i-1',
          VpcId: 'vpc-1',
          State: { Name: 'running' },
          MetadataOptions: { HttpTokens: 'required' },
        },
      ],
    })
    expect(detectImdsV1(built.nodes, NOW)).toEqual([])
  })

  it('a public database produces the string detectPublicDatabase matches', () => {
    const built = buildOne({
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
      dbInstances: [
        {
          DBInstanceIdentifier: 'db-1',
          DBInstanceStatus: 'available',
          PubliclyAccessible: true,
          StorageEncrypted: true,
          DBSubnetGroup: { VpcId: 'vpc-1' },
        },
      ],
    })
    expect(detectPublicDatabase(built.nodes, NOW)).toHaveLength(1)
  })

  it('an unencrypted database produces the string detectUnencryptedStorage matches', () => {
    const built = buildOne({
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
      dbInstances: [
        {
          DBInstanceIdentifier: 'db-1',
          DBInstanceStatus: 'available',
          StorageEncrypted: false,
          DBSubnetGroup: { VpcId: 'vpc-1' },
        },
      ],
    })
    expect(detectUnencryptedStorage(built.nodes, NOW)).toHaveLength(1)
  })

  it('unencrypted EBS volumes produce the string the detector matches', () => {
    const built = buildOne({
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
      instances: [{ InstanceId: 'i-1', VpcId: 'vpc-1', State: { Name: 'running' } }],
      volumes: [
        { VolumeId: 'vol-1', Size: 80, Encrypted: false, Attachments: [{ InstanceId: 'i-1' }] },
        { VolumeId: 'vol-2', Size: 20, Encrypted: true, Attachments: [{ InstanceId: 'i-1' }] },
      ],
    })
    const instance = built.nodes.find((n) => n.id === 'i-1')
    expect(instance?.props.find((p) => p.k === POSTURE_FACTS.ebsEncryption.key)?.v).toBe(
      '1 of 2 volumes not encrypted',
    )
    expect(detectUnencryptedStorage(built.nodes, NOW)).toHaveLength(1)
  })

  it('fully encrypted volumes suppress the finding', () => {
    const built = buildOne({
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
      instances: [{ InstanceId: 'i-1', VpcId: 'vpc-1', State: { Name: 'running' } }],
      volumes: [{ VolumeId: 'vol-1', Encrypted: true, Attachments: [{ InstanceId: 'i-1' }] }],
    })
    expect(detectUnencryptedStorage(built.nodes, NOW)).toEqual([])
  })

  it('omits the EBS prop entirely when no volume was collected', () => {
    // Silence is not the same as "all encrypted": if DescribeVolumes was
    // denied, the detector must not claim the instance is fine.
    const built = buildOne({
      vpcs: [{ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16' }],
      instances: [{ InstanceId: 'i-1', VpcId: 'vpc-1', State: { Name: 'running' } }],
    })
    const instance = built.nodes.find((n) => n.id === 'i-1')
    expect(instance?.props.find((p) => p.k === POSTURE_FACTS.ebsEncryption.key)).toBeUndefined()
    expect(detectUnencryptedStorage(built.nodes, NOW)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Detector behaviour
// ---------------------------------------------------------------------------

describe('detectImdsV1', () => {
  it('only looks at EC2 instances', () => {
    const nodes = [
      node({ id: 'rds-1', type: 'rds', props: [prop(POSTURE_FACTS.imds.key, POSTURE_FACTS.imds.v1Allowed)] }),
    ]
    expect(detectImdsV1(nodes, NOW)).toEqual([])
  })

  it('names the instance and gives a runnable remediation', () => {
    const nodes = [
      node({
        id: 'i-1',
        name: 'legacy-worker',
        props: [prop(POSTURE_FACTS.imds.key, POSTURE_FACTS.imds.v1Allowed)],
      }),
    ]
    const [finding] = detectImdsV1(nodes, NOW)
    expect(finding?.title).toContain('legacy-worker')
    expect(finding?.kind).toBe('imdsv1-allowed')
    expect(finding?.evidence.some((e) => e.includes('modify-instance-metadata-options'))).toBe(true)
  })

  it('is stable: the same node yields the same finding id', () => {
    const nodes = [node({ id: 'i-1', props: [prop(POSTURE_FACTS.imds.key, POSTURE_FACTS.imds.v1Allowed)] })]
    expect(detectImdsV1(nodes, NOW)[0]?.id).toBe(detectImdsV1(nodes, NOW + 5000)[0]?.id)
  })
})

describe('detectPublicDatabase', () => {
  const publicDb = node({
    id: 'db-1',
    type: 'rds',
    name: 'prod-pg',
    props: [
      prop(POSTURE_FACTS.publiclyAccessible.key, POSTURE_FACTS.publiclyAccessible.yes),
      prop('Endpoint', 'host-1.us-east-1.rds.amazonaws.com'),
    ],
  })

  it('fires only on the affirmative value', () => {
    expect(detectPublicDatabase([publicDb], NOW)).toHaveLength(1)
    const privateDb = node({
      id: 'db-2',
      type: 'rds',
      props: [prop(POSTURE_FACTS.publiclyAccessible.key, POSTURE_FACTS.publiclyAccessible.no)],
    })
    expect(detectPublicDatabase([privateDb], NOW)).toEqual([])
  })

  it('points at the security group rather than claiming exposure', () => {
    // The endpoint being public does not mean traffic reaches it; the finding
    // must not overstate what it knows.
    const [finding] = detectPublicDatabase([publicDb], NOW)
    expect(finding?.detail).toMatch(/depends on its security group/)
    expect(finding?.evidence.some((e) => e.includes('host-1'))).toBe(true)
  })
})

describe('detectUnencryptedStorage', () => {
  it('says RDS encryption cannot be enabled in place', () => {
    const nodes = [
      node({
        id: 'db-1',
        type: 'rds',
        props: [prop(POSTURE_FACTS.storageEncryption.key, POSTURE_FACTS.storageEncryption.absent)],
      }),
    ]
    const [finding] = detectUnencryptedStorage(nodes, NOW)
    expect(finding?.detail).toMatch(/cannot enable it in place/)
  })

  it('ignores an encrypted database', () => {
    const nodes = [
      node({ id: 'db-1', type: 'rds', props: [prop(POSTURE_FACTS.storageEncryption.key, 'KMS aws/rds')] }),
    ]
    expect(detectUnencryptedStorage(nodes, NOW)).toEqual([])
  })
})

describe('detectPosture', () => {
  it('reports the internet-facing finding first', () => {
    const nodes = [
      node({ id: 'i-1', props: [prop(POSTURE_FACTS.imds.key, POSTURE_FACTS.imds.v1Allowed)] }),
      node({
        id: 'db-1',
        type: 'rds',
        props: [prop(POSTURE_FACTS.publiclyAccessible.key, POSTURE_FACTS.publiclyAccessible.yes)],
      }),
    ]
    expect(detectPosture(nodes, NOW)[0]?.kind).toBe('public-database')
  })

  it('produces only posture-classified findings', () => {
    const nodes = [
      node({ id: 'i-1', props: [prop(POSTURE_FACTS.imds.key, POSTURE_FACTS.imds.v1Allowed)] }),
      node({
        id: 'db-1',
        type: 'rds',
        props: [
          prop(POSTURE_FACTS.publiclyAccessible.key, POSTURE_FACTS.publiclyAccessible.yes),
          prop(POSTURE_FACTS.storageEncryption.key, POSTURE_FACTS.storageEncryption.absent),
        ],
      }),
    ]
    expect(detectPosture(nodes, NOW).every((f) => isPostureFinding(f.kind))).toBe(true)
  })

  it('returns nothing for a well-configured estate', () => {
    const nodes = [
      node({ id: 'i-1', props: [prop(POSTURE_FACTS.imds.key, POSTURE_FACTS.imds.v2Required)] }),
      node({
        id: 'db-1',
        type: 'rds',
        props: [
          prop(POSTURE_FACTS.publiclyAccessible.key, POSTURE_FACTS.publiclyAccessible.no),
          prop(POSTURE_FACTS.storageEncryption.key, 'KMS aws/rds'),
        ],
      }),
    ]
    expect(detectPosture(nodes, NOW)).toEqual([])
  })
})

describe('applyHealth', () => {
  it('caps a posture finding at warn, however severe', () => {
    // A publicly accessible database is `critical` in the Posture list but must
    // not paint the node red — a red ring means "broken right now".
    const nodes = [node({ id: 'db-1', type: 'rds' })]
    const findings = detectPublicDatabase(
      [
        node({
          id: 'db-1',
          type: 'rds',
          props: [prop(POSTURE_FACTS.publiclyAccessible.key, POSTURE_FACTS.publiclyAccessible.yes)],
        }),
      ],
      NOW,
    )
    expect(findings[0]?.severity).toBe('critical')
    applyHealth(nodes, findings)
    expect(nodes[0]?.health).toBe('warn')
  })

  it('lets a live incident paint a node critical', () => {
    const nodes = [node({ id: 'i-1' })]
    applyHealth(nodes, [
      {
        id: 'f', nodeId: 'i-1', severity: 'critical', kind: 'metric-spike', title: 't', detail: 'd',
        metric: 'CPUUtilization', startedAt: NOW, endedAt: null, evidence: [], sparkline: [], logGroups: [],
      },
    ])
    expect(nodes[0]?.health).toBe('critical')
  })

  it('never badges a container', () => {
    const nodes = [node({ id: 'vpc-1', type: 'vpc' }), node({ id: 'internet', type: 'internet' })]
    applyHealth(nodes, [
      {
        id: 'f', nodeId: 'vpc-1', severity: 'critical', kind: 'metric-spike', title: 't', detail: 'd',
        metric: null, startedAt: NOW, endedAt: null, evidence: [], sparkline: [], logGroups: [],
      },
    ])
    expect(nodes.every((n) => n.health === 'unknown')).toBe(true)
  })

  it('leaves a node we cannot assess as unknown, not ok', () => {
    // A green badge should mean something was actually checked.
    const nodes = [node({ id: 'role-1', type: 'iam-role' })]
    applyHealth(nodes, [])
    expect(nodes[0]?.health).toBe('unknown')
  })
})
