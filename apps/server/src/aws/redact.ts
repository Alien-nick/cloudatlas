/**
 * Deterministic pseudonymisation for captured AWS responses.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE ADDING A PATTERN
 *
 * A pattern that matches a SHAPE rather than a POSITION will eventually collide
 * with a different format that shares that shape. When it does, validating the
 * match harder will not save you, because the colliding text is usually
 * *genuinely valid* in its own format. Only context — what precedes and follows
 * the match — can tell the two apart.
 *
 * This is not hypothetical. The IPv6 matcher here once rewrote
 * `arn:aws:sts::482177301192:` into `arn:aws:sts2001:db8::122223333:`, because
 * an ARN with an empty region field contains a literal `::`, and `::1111` is a
 * perfectly valid IPv6 address. Every stricter validator still said yes — the
 * text really was a well-formed address. What fixed it was a negative lookbehind:
 * a real address is not preceded by an alphanumeric or another colon.
 *
 * The failure mode is what makes this worth a comment block. Replay
 * verification still passed (node and edge counts were unchanged), the deny
 * gate still passed (the account id *had* been replaced), and the corruption
 * was only visible by reading the strings. A shape-collision bug does not
 * announce itself.
 *
 * So: when you add a pattern, write down what could legitimately share its
 * shape, then anchor on context rather than reaching for a tighter validator.
 * ---------------------------------------------------------------------------
 *
 * Design rules, in priority order:
 *
 *  1. **Fakes are never derived from the real value.** A hash would be stable
 *     across captures, which is convenient for diffing — and brute-forceable
 *     for low-entropy inputs like a 12-digit account id. Replacements are
 *     assigned sequentially in first-encounter order instead.
 *  2. **The mapping never leaves memory.** Nothing writes it to disk.
 *  3. **Two passes, because substitution alone is a blocklist.** Pass one
 *     *learns* every identifying name from the keys that carry one. Pass two
 *     replaces those literals everywhere, including inside ARNs and free text
 *     where no pattern would have matched them. Without this, redacting
 *     `LoadBalancerName: "api-alb"` still leaves `api-alb` sitting in
 *     `arn:...:loadbalancer/app/api-alb/50dc6c49`.
 *  4. **Referential integrity survives.** Substitution is component-wise, so a
 *     value seen in two places maps to the same fake and the relationship
 *     builders still resolve.
 *  5. **Topology-bearing values are preserved.** Private CIDRs, ports, states,
 *     instance types, engine versions, AZ and region names all stay.
 *  6. **`0.0.0.0/0` and `::/0` are preserved exactly.** Rewriting them would
 *     silently destroy the risky-rule findings the capture exists to exercise.
 *
 * Even with all of that, this is still a blocklist. `capture/deny.ts` is the
 * postcondition that checks the result, and it is the thing that actually
 * decides whether a fixture may be written.
 */

export type RedactionClass =
  | 'accountId'
  | 'resourceId'
  | 'publicIp'
  | 'publicIpv6'
  | 'hostname'
  | 'tagValue'
  | 'resourceName'
  | 'logGroup'
  | 'description'
  | 'token'
  | 'envName'
  | 'envValue'
  | 'principal'
  | 'arnResource'

/**
 * Keys whose values are identifying names. Their values are *learned* in pass
 * one and then replaced everywhere in pass two.
 */
const NAME_KEYS = new Set([
  // RDS
  'DBInstanceIdentifier',
  'DBClusterIdentifier',
  'DbiResourceId',
  'DBName',
  'MasterUsername',
  'DBSubnetGroupName',
  'DBParameterGroupName',
  'OptionGroupName',
  'DBSnapshotIdentifier',
  'SnapshotIdentifier',
  'ReplicationGroupDescription',
  // ElastiCache
  'CacheClusterId',
  'ReplicationGroupId',
  'CacheSubnetGroupName',
  'CacheParameterGroupName',
  // ELB
  'LoadBalancerName',
  'TargetGroupName',
  // ECS
  'ClusterName',
  'ServiceName',
  'family',
  'taskDefinitionFamily',
  'TaskRoleArn',
  'ExecutionRoleArn',
  'taskRoleArn',
  'executionRoleArn',
  // EC2 / IAM / KMS
  'KeyName',
  'RoleName',
  'InstanceProfileArn',
  'KmsKeyId',
  'KeyArn',
  'AliasName',
  'TargetKeyId',
  // S3 / CloudFront
  'BucketName',
  'bucketName',
  'DomainName',
  'OriginPath',
  // CloudWatch Logs
  'logGroupName',
  'LogGroupName',
  'awslogs-group',
  'awslogs-stream-prefix',
])

/**
 * `Name` is far too common to redact unconditionally — `State.Name` is
 * "running". These are the parents where a `Name` really is an identifier.
 */
const CONTEXT_NAME_KEYS = new Set([
  'HostedZones.Name',
  'ResourceRecordSets.Name',
  'Buckets.Name',
  'Images.Name',
  'Aliases.Items',
  'IamInstanceProfile.Arn',
  'AliasTarget.DNSName',
])

/** Keys holding a DNS name. */
const HOSTNAME_KEYS = new Set([
  'PublicDnsName',
  'PrivateDnsName',
  'DNSName',
  'Address',
  'ReaderEndpoint',
  'CanonicalHostedZoneName',
  'ConfigurationEndpoint',
  'PrimaryEndpoint',
  'HostedZoneName',
  'Endpoint',
])

/** Free text. The single highest-risk field class in a capture. */
const DESCRIPTION_KEYS = new Set(['Description', 'description', 'Comment', 'Purpose'])

/** Opaque continuation tokens. Rewritten so replay still chains correctly. */
const TOKEN_KEYS = new Set(['NextToken', 'nextToken', 'Marker', 'NextMarker', 'ContinuationToken'])

const PAIR_VALUE_KEYS = new Set(['Value', 'value'])
const PAIR_NAME_KEYS = new Set(['Name', 'name', 'Key', 'key'])

const ENV_PARENTS = /^(environment|secrets|environmentFiles|Environment|Variables)$/
const TAG_PARENTS = /^(Tags|TagList|tags|TagSet|TagDescriptions)$/

const RESOURCE_ID_PREFIXES = [
  'i', 'vpc', 'subnet', 'sg', 'eni', 'nat', 'igw', 'vgw', 'rtb', 'acl', 'vol',
  'snap', 'ami', 'eipalloc', 'eipassoc', 'vpce', 'pl', 'tgw', 'fl', 'dopt', 'cgw', 'lt',
]

const RESOURCE_ID_RE = new RegExp(`\\b(${RESOURCE_ID_PREFIXES.join('|')})-[0-9a-f]{8,17}\\b`, 'g')
const ACCOUNT_ID_RE = /\b\d{12}\b/g
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g
const HOSTNAME_RE = /\b[A-Za-z0-9][A-Za-z0-9.-]*\.amazonaws\.com\b/g
/**
 * Candidate IPv6 tokens. Deliberately loose, then filtered — a tight IPv6
 * regex is unreadable, and a loose one alone would eat the `14:02:33` in every
 * timestamp. `looksLikeIpv6` applies the real test.
 */
/**
 * Candidate IPv6 tokens, guarded on both sides.
 *
 * `arn:aws:sts::482177301192:` contains `::1111` once the account id is
 * replaced, and `::1111` is perfectly valid IPv6 in isolation — so validation
 * alone cannot reject it. Context can: a real address is not preceded by an
 * alphanumeric or another colon, and is not followed by more hex digits.
 */
const IPV6_CANDIDATE_RE =
  /(?<![A-Za-z0-9:.])(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4}(?![A-Za-z0-9])/g

/**
 * IAM principal paths. The type prefix is kept — knowing a denial involved a
 * role rather than a user is useful, and the name is the sensitive part.
 */
const IAM_PRINCIPAL_RE =
  /\b(assumed-role|role|user|instance-profile|group|federated-user|oidc-provider|saml-provider)\/([^\s"',\\)\]}]+)/g
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
/** AROA/AIDA/AKIA/ASIA-style unique ids, which identify a principal. */
const PRINCIPAL_ID_RE = /\b(?:AROA|AIDA|AKIA|ASIA|AGPA|AIPA|ANPA|ANVA)[A-Z0-9]{8,}\b/g
/** `arn:aws:<svc>:<region>:<account>:` followed by the resource part. */
const ARN_TAIL_RE = /(arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:[0-9]*:)([^\s"',\\)\]}]+)/g
/** A tail an earlier pass already replaced; re-redacting it only loses detail. */
const ALREADY_FAKE_RE = /^(?:principal|resource|res|tok|host)-\d+$/
/** Principal path prefixes worth keeping: role-vs-user is useful in a notice. */
const PRINCIPAL_PATH_RE =
  /^((?:assumed-role|user|role|instance-profile|group|federated-user)\/)(.*)$/

/** Names too generic to replace as literals without mangling the fixture. */
const LITERAL_STOPLIST = new Set([
  'default', 'defaults', 'main', 'primary', 'replica', 'public', 'private',
  'active', 'available', 'running', 'stopped', 'pending', 'enabled', 'disabled',
  'true', 'false', 'null', 'none', 'aws/rds', 'aws/s3', 'aws/ebs',
  'application', 'network', 'gateway', 'internet-facing', 'internal',
])

/** Literals shorter than this are too likely to appear inside other words. */
const LITERAL_MIN_LENGTH = 5

function isPreservedIp(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n > 255)) return true
  if (a === 0) return true // 0.0.0.0/0 must survive verbatim
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true
  // Documentation ranges: leave alone so re-redaction is idempotent.
  if (a === 192 && b === 0 && c === 2) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  return false
}

/**
 * Validate a candidate as a real IPv6 address.
 *
 * Two false positives to reject, both of which bit in practice:
 *   - `14:02:33` inside an ISO timestamp, and
 *   - `::482177301192` — the empty region field of `arn:aws:sts::<account>:…`,
 *     which contains a literal `::` and would otherwise be rewritten, silently
 *     corrupting every STS ARN in the capture.
 *
 * The group-length rule is what catches the second: a 12-digit account id is
 * not a 4-hex-digit group.
 */
function looksLikeIpv6(token: string): boolean {
  const doubleColons = token.split('::').length - 1
  if (doubleColons > 1) return false

  const groups = token.split(doubleColons === 1 ? '::' : ':').flatMap((half) =>
    doubleColons === 1 ? half.split(':') : [half],
  )
  const present = groups.filter((group) => group.length > 0)
  if (present.length === 0) return token === '::'
  if (present.length > 8) return false
  if (!present.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return false

  // Without a `::` an address must be fully spelled out, which also rules out
  // the two-colon timestamp case.
  return doubleColons === 1 || present.length === 8
}

function isPreservedIpv6(token: string): boolean {
  const lower = token.toLowerCase()
  if (lower === '::' || lower === '::1' || lower === '::0') return true
  if (lower.startsWith('fe80:')) return true // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true // unique local
  if (lower.startsWith('ff')) return true // multicast
  if (lower.startsWith('2001:db8')) return true // documentation; idempotent
  return false
}

export interface RedactionSummary {
  replaced: Record<string, number>
  /** Tag keys whose values were deliberately left intact. */
  keptTagKeys: string[]
}

export interface RedactorOptions {
  /**
   * Tag keys whose values pass through unredacted. Defaults to `['Name']` so a
   * replayed fixture stays readable. Pass `keepNoTags` for a client account
   * where no tag value should survive.
   */
  keepTagKeys?: string[]
  keepNoTags?: boolean
}

export const DEFAULT_KEEP_TAG_KEYS = ['Name']

export class Redactor {
  private readonly maps = new Map<RedactionClass, Map<string, string>>()
  private readonly counters = new Map<RedactionClass, number>()
  private readonly keepTagKeys: Set<string>
  private readonly keptTagKeyList: string[]
  /** Learned identifying names, longest first. Rebuilt when the map grows. */
  private literals: Array<[string, string]> = []
  private literalsDirty = true

  constructor(options: RedactorOptions = {}) {
    this.keptTagKeyList = options.keepNoTags
      ? []
      : [...new Set([...DEFAULT_KEEP_TAG_KEYS, ...(options.keepTagKeys ?? [])])]
    this.keepTagKeys = new Set(this.keptTagKeyList.map((key) => key.toLowerCase()))
  }

  // --- replacement assignment -------------------------------------------

  private assign(cls: RedactionClass, original: string, make: (n: number) => string): string {
    let map = this.maps.get(cls)
    if (!map) {
      map = new Map()
      this.maps.set(cls, map)
    }
    const existing = map.get(original)
    if (existing !== undefined) return existing

    const n = (this.counters.get(cls) ?? 0) + 1
    this.counters.set(cls, n)
    const replacement = make(n)
    map.set(original, replacement)
    if (cls === 'resourceName' || cls === 'logGroup') this.literalsDirty = true
    return replacement
  }

  private fakeAccountId(original: string): string {
    const pool = ['111122223333', '222233334444', '333344445555', '444455556666']
    return this.assign('accountId', original, (n) => pool[n - 1] ?? String(n).padStart(12, '9'))
  }

  private fakeResourceId(original: string): string {
    const dash = original.indexOf('-')
    const prefix = original.slice(0, dash)
    const bodyLength = original.length - dash - 1
    return this.assign('resourceId', original, (n) =>
      `${prefix}-${n.toString(16).padStart(bodyLength, '0')}`,
    )
  }

  private fakePublicIp(original: string): string {
    return this.assign('publicIp', original, (n) => {
      const block = n <= 254 ? '203.0.113' : '198.51.100'
      return `${block}.${((n - 1) % 254) + 1}`
    })
  }

  private fakePublicIpv6(original: string): string {
    return this.assign('publicIpv6', original, (n) => `2001:db8::${n.toString(16)}`)
  }

  private fakeHostname(original: string): string {
    return this.assign('hostname', original, (n) => {
      const labels = original.split('.')
      // Keep the trailing service/region labels for AWS-owned names so the
      // fixture stays readable; a custom domain keeps only its TLD.
      const tail = original.endsWith('amazonaws.com')
        ? labels.slice(-4).join('.')
        : `example.${labels[labels.length - 1] ?? 'com'}`
      return `host-${n}.${tail}`
    })
  }

  private fakeName(original: string): string {
    return this.assign('resourceName', original, (n) => `res-${n}`)
  }

  private fakeLogGroup(original: string): string {
    return this.assign('logGroup', original, (n) => `/redacted/lg-${n}`)
  }

  private fakeDescription(original: string): string {
    return this.assign('description', original, (n) => `description-${n}`)
  }

  private fakeTagValue(original: string): string {
    return this.assign('tagValue', original, (n) => `tagval-${n}`)
  }

  private fakeToken(original: string): string {
    return this.assign('token', original, (n) => `tok-${n}`)
  }

  private fakeEnvName(original: string): string {
    return this.assign('envName', original, (n) => `ENV_VAR_${n}`)
  }

  private fakeEnvValue(original: string): string {
    return this.assign('envValue', original, () => 'REDACTED')
  }

  private fakePrincipal(original: string): string {
    return this.assign('principal', original, (n) => `principal-${n}`)
  }

  private fakeArnResource(original: string): string {
    return this.assign('arnResource', original, (n) => `resource-${n}`)
  }

  /**
   * Error messages get the aggressive treatment: AWS phrases an AccessDenied as
   * "User: <full principal ARN> is not authorized to perform: <action> on
   * resource: <full resource ARN>", so the string carries both the caller's
   * identity and the target's name. Nothing reads these as identifiers, so
   * flattening every ARN tail is safe here in a way it would not be elsewhere.
   */
  private scrubErrorMessage(input: string): string {
    return this.scrubString(input).replace(ARN_TAIL_RE, (match, prefix: string, tail: string) => {
      // scrubString has already dealt with principal paths; keep the type
      // marker it preserved rather than flattening it away here.
      const principal = PRINCIPAL_PATH_RE.exec(tail)
      if (principal) {
        const type = principal[1] ?? ''
        const rest = principal[2] ?? ''
        return `${prefix}${type}${ALREADY_FAKE_RE.test(rest) ? rest : this.fakeArnResource(rest)}`
      }
      if (ALREADY_FAKE_RE.test(tail)) return match
      return `${prefix}${this.fakeArnResource(tail)}`
    })
  }

  // --- learned literals --------------------------------------------------

  private literalList(): Array<[string, string]> {
    if (!this.literalsDirty) return this.literals
    const entries: Array<[string, string]> = []
    for (const cls of ['resourceName', 'logGroup'] as const) {
      for (const [original, replacement] of this.maps.get(cls) ?? []) {
        if (original.length < LITERAL_MIN_LENGTH) continue
        if (LITERAL_STOPLIST.has(original.toLowerCase())) continue
        entries.push([original, replacement])
      }
    }
    // Longest first, so "prod-pg-primary" is replaced before "prod-pg".
    entries.sort((a, b) => b[0].length - a[0].length)
    this.literals = entries
    this.literalsDirty = false
    return entries
  }

  private replaceLiterals(input: string): string {
    let out = input
    for (const [original, replacement] of this.literalList()) {
      if (!out.includes(original)) continue
      out = out.split(original).join(replacement)
    }
    return out
  }

  // --- string scrubbing --------------------------------------------------

  private scrubString(input: string): string {
    // Learned names first: they are the ones hiding inside ARNs and free text.
    let out = this.replaceLiterals(input)
    // Principals before anything else: an assumed-role path can contain an
    // email as its session name, and one replacement should take both.
    out = out.replace(
      IAM_PRINCIPAL_RE,
      (_match, type: string, name: string) => `${type}/${this.fakePrincipal(name)}`,
    )
    out = out.replace(EMAIL_RE, (match) => this.fakePrincipal(match))
    out = out.replace(PRINCIPAL_ID_RE, (match) => this.fakePrincipal(match))
    out = out.replace(ACCOUNT_ID_RE, (match) => this.fakeAccountId(match))
    out = out.replace(RESOURCE_ID_RE, (match) => this.fakeResourceId(match))
    out = out.replace(IPV6_CANDIDATE_RE, (match) => {
      if (!looksLikeIpv6(match) || isPreservedIpv6(match)) return match
      return this.fakePublicIpv6(match)
    })
    out = out.replace(IPV4_RE, (match, a: string, b: string, c: string, d: string) =>
      isPreservedIp(Number(a), Number(b), Number(c), Number(d)) ? match : this.fakePublicIp(match),
    )
    out = out.replace(HOSTNAME_RE, (match) => this.fakeHostname(match))
    return out
  }

  // --- pass one: learn ---------------------------------------------------

  /**
   * Walk a value and register every identifying name, without transforming
   * anything. Run this over the whole transcript before redacting any of it.
   */
  prepare(value: unknown, keyPath: string[] = []): void {
    if (typeof value === 'string') {
      const key = keyPath[keyPath.length - 1] ?? ''
      const parent = keyPath[keyPath.length - 2] ?? ''
      if (value.length === 0) return
      if (NAME_KEYS.has(key)) {
        if (key === 'logGroupName' || key === 'LogGroupName' || key === 'awslogs-group') {
          this.fakeLogGroup(value)
        } else {
          this.fakeName(value)
        }
      } else if (CONTEXT_NAME_KEYS.has(`${parent}.${key}`)) {
        this.fakeName(value)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) this.prepare(item, keyPath)
      return
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        this.prepare(child, [...keyPath, key])
      }
    }
  }

  // --- pass two: redact --------------------------------------------------

  redact(value: unknown, keyPath: string[] = [], siblingKey?: string): unknown {
    if (value === null || value === undefined) return value
    if (typeof value === 'number' || typeof value === 'boolean') return value

    if (typeof value === 'string') {
      const key = keyPath[keyPath.length - 1] ?? ''
      const parent = keyPath[keyPath.length - 2] ?? ''

      if (value.length === 0) return value
      if (TOKEN_KEYS.has(key)) return this.fakeToken(value)

      if (ENV_PARENTS.test(parent)) {
        if (PAIR_NAME_KEYS.has(key)) return this.fakeEnvName(value)
        if (PAIR_VALUE_KEYS.has(key)) return this.fakeEnvValue(value)
      }

      if (PAIR_VALUE_KEYS.has(key) && TAG_PARENTS.test(parent)) {
        if (siblingKey && this.keepTagKeys.has(siblingKey.toLowerCase())) return value
        return this.fakeTagValue(value)
      }

      // A recorded AccessDenied carries the caller's principal ARN and the
      // target resource's name. This is the payload the deny gate exists for,
      // so it is scrubbed hardest.
      if (key === 'message' && parent === 'error') return this.scrubErrorMessage(value)

      if (DESCRIPTION_KEYS.has(key)) return this.fakeDescription(value)
      if (HOSTNAME_KEYS.has(key)) return this.fakeHostname(value)
      if (key === 'logGroupName' || key === 'LogGroupName' || key === 'awslogs-group') {
        return this.fakeLogGroup(value)
      }
      if (NAME_KEYS.has(key) || CONTEXT_NAME_KEYS.has(`${parent}.${key}`)) {
        return this.fakeName(value)
      }
      return this.scrubString(value)
    }

    if (Array.isArray(value)) return value.map((item) => this.redact(item, keyPath))
    if (value instanceof Date) return value.toISOString()

    if (typeof value === 'object') {
      const entries = value as Record<string, unknown>
      // A tag is a {Key, Value} pair; how Value is handled depends on Key.
      const sibling =
        typeof entries.Key === 'string'
          ? entries.Key
          : typeof entries.key === 'string'
            ? entries.key
            : undefined

      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(entries)) {
        out[key] = this.redact(child, [...keyPath, key], sibling)
      }
      return out
    }

    return value
  }

  /** Learn from everything, then redact everything. The order matters. */
  redactAll<T>(values: readonly T[]): T[] {
    for (const value of values) this.prepare(value)
    return values.map((value) => this.redact(value) as T)
  }

  summary(): RedactionSummary {
    const replaced: Record<string, number> = {}
    for (const [cls, map] of this.maps) replaced[cls] = map.size
    return { replaced, keptTagKeys: this.keptTagKeyList }
  }
}

export const __testing = { isPreservedIp, isPreservedIpv6, looksLikeIpv6 }
