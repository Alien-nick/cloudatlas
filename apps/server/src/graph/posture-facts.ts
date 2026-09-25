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
} as const

/** True when the value marks an unencrypted-volume state. */
export function isUnencryptedVolumeValue(value: string): boolean {
  return /\bnot encrypted\b/.test(value)
}
