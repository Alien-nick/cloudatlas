/**
 * The vocabulary the posture detectors read.
 *
 * `graph/build.ts` writes these exact strings into node props and
 * `health/posture.ts` matches on them. They live here, in one place, because
 * the alternative failure is silent: reword "not encrypted" in the builder and
 * the detector stops firing, with nothing failing and no finding to notice the
 * absence of. `posture-facts.test.ts` pins the contract from both ends.
 *
 * Reading structured facts out of display strings is not ideal. It is the
 * trade for detectors that run over a `Graph` — which means they work
 * identically against a live scan, a replayed fixture and the demo provider,
 * rather than needing the typed AWS objects that only exist mid-collection.
 */
export const POSTURE_FACTS = {
  imds: {
    key: 'IMDS',
    v1Allowed: 'v1 and v2 allowed',
    v2Required: 'v2 required',
  },
  publiclyAccessible: {
    key: 'Publicly accessible',
    yes: 'YES',
    no: 'no',
  },
  /** RDS storage-at-rest encryption. */
  storageEncryption: {
    key: 'Encryption',
    absent: 'not encrypted',
  },
  /** Aggregated across every volume attached to an instance. */
  ebsEncryption: {
    key: 'EBS encryption',
    allEncrypted: 'all volumes encrypted',
    /** Rendered as `${count} of ${total} volumes not encrypted`. */
    unencrypted: (count: number, total: number): string =>
      `${count} of ${total} volume${total === 1 ? '' : 's'} not encrypted`,
  },

  // --- Read by the compliance checks (compliance/checks.ts) ----------------

  /** Any other value names where the records go. */
  flowLogs: {
    key: 'Flow logs',
    absent: 'not enabled',
  },
  defaultVpc: {
    key: 'Default VPC',
    yes: 'yes',
    no: 'no',
  },
  autoPublicIp: {
    key: 'Auto-assign public IP',
    enabled: 'enabled',
    disabled: 'disabled',
  },
  /** Anything other than a value starting with "—" is an address. */
  publicIpv4: {
    key: 'Public IPv4',
    none: '— (none)',
  },
  /** Enabled values carry the standby zone, so they are matched by prefix. */
  multiAz: {
    key: 'Multi-AZ',
    enabledPrefix: 'enabled',
    disabled: 'disabled',
  },
  /** Present only on read replicas, whose backups and failover are the source's. */
  replicaOf: {
    key: 'Replica of',
  },
  logExports: {
    key: 'Log exports',
    none: 'none',
  },
  backupRetention: {
    key: 'Backup retention',
    disabled: 'disabled',
    days: (days: number): string => `${days} day${days === 1 ? '' : 's'}`,
  },
  deletionProtection: {
    key: 'Deletion protection',
    on: 'on',
    off: 'off',
  },
  /** ElastiCache reports the two separately, and they fail separately. */
  cacheEncryptionAtRest: {
    key: 'Encryption at rest',
    enabled: 'enabled',
    disabled: 'disabled',
  },
  cacheEncryptionInTransit: {
    key: 'Encryption in transit',
    enabled: 'enabled',
    disabled: 'disabled',
  },
  /**
   * ALB listeners that accept plain HTTP and do not redirect it to HTTPS.
   * An HTTP:80 listener whose default action redirects is not listed — that is
   * the standard way to serve TLS, not a gap.
   */
  plaintextListeners: {
    key: 'Plaintext listeners',
    none: 'none',
  },
  loadBalancerScheme: {
    key: 'Scheme',
    internetFacing: 'internet-facing',
  },
  s3PublicAccess: {
    key: 'Public access',
    blocked: 'blocked (all four settings)',
    notBlocked: 'NOT fully blocked',
  },
  viewerProtocol: {
    key: 'Viewer protocol',
    allowAll: 'allow-all',
  },
  wafLogging: {
    key: 'Logging',
    absent: 'not configured',
  },
} as const

/** True when the value marks an unencrypted-volume state. */
export function isUnencryptedVolumeValue(value: string): boolean {
  return /\bnot encrypted\b/.test(value)
}
