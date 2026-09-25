/**
 * A call the read-only guard refused. This is a programming error, not a
 * runtime condition — it means someone wired up an operation that is not in the
 * registry, or one whose name does not read as read-only.
 */
export class ReadOnlyViolationError extends Error {
  readonly statusCode = 500
  constructor(
    readonly service: string,
    readonly operation: string,
    reason: string,
  ) {
    super(
      `Refusing to call ${service}:${operation} — ${reason}. ` +
        `CloudAtlas only calls operations registered in apps/server/src/aws/operations.ts.`,
    )
    this.name = 'ReadOnlyViolationError'
  }
}

/**
 * The account is missing a permission. Never fatal: the collector records it,
 * the scan continues, and the UI shows a notice against the affected section.
 */
export class MissingPermissionError extends Error {
  readonly statusCode = 403
  override readonly name = 'AccessDeniedException'
  constructor(
    /** IAM action, e.g. "ec2:DescribeInstances". */
    readonly action: string,
    readonly region: string,
    cause: string,
  ) {
    super(`Missing permission ${action} in ${region}: ${cause}`)
  }
}

/**
 * An AWS call failed in a way no classifier recognised.
 *
 * This exists so the unknown case is *loud data* rather than either a swallowed
 * error or a dead region. The prose shapes AWS uses for AccessDenied are not a
 * closed set, so rather than chasing the next variant, an unrecognised failure
 * is recorded with its service, operation, code and name, surfaced in the
 * capture's meta.json, and the collector continues with an empty result.
 *
 * Programming errors are deliberately *not* wrapped in this — they stay
 * unwrapped so they still fail the region loudly instead of being filed away as
 * an interesting AWS quirk.
 */
export class UnclassifiedAwsError extends Error {
  readonly statusCode = 502
  constructor(
    readonly service: string,
    readonly operation: string,
    readonly region: string,
    readonly errorName: string,
    readonly errorCode: string | null,
    readonly originalMessage: string,
  ) {
    super(`${service}:${operation} failed in ${region} (${errorName}): ${originalMessage}`)
    this.name = 'UnclassifiedAwsError'
  }
}

/** Replay mode ran out of recorded responses for an operation. */
export class TranscriptExhaustedError extends Error {
  readonly statusCode = 500
  constructor(service: string, operation: string, region: string) {
    super(
      `No recorded response left for ${service}:${operation} in ${region}. ` +
        `The collector made more calls than the capture contains — re-record with "npm run capture", ` +
        `or check whether the collector's call sequence changed.`,
    )
    this.name = 'TranscriptExhaustedError'
  }
}

/**
 * Every spelling AWS uses for "you lack the permission". Services are not
 * consistent: EC2 raises `UnauthorizedOperation`, ECS raises
 * `AccessDeniedException`, the older Query-protocol services (ElastiCache, RDS,
 * ELB) raise `AccessDenied`, and some append `Fault`. Being lenient here is
 * deliberate — a missed match turns a recoverable "missing permission" notice
 * into a failed scan.
 */
const ACCESS_DENIED_CODES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'AccessDeniedFault',
  'AccessDeniedError',
  'UnauthorizedOperation',
  'UnauthorizedException',
  'AuthorizationError',
  'AuthorizationErrorException',
  'AuthFailure',
  'NotAuthorized',
  'NotAuthorizedException',
  'Client.UnauthorizedOperation',
])

/** Message shapes for services that only signal the denial in prose. */
const ACCESS_DENIED_MESSAGE =
  /\b(?:is|are)\s+not\s+authorized\s+to\s+(?:perform|access)\b|\baccess\s*denied\b|\bunauthorized\s*operation\b|\bno\s+identity-based\s+policy\b|\bexplicit\s+deny\b/i

export function isAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name = error.name
  const code = (error as { Code?: string; code?: string }).Code ?? (error as { code?: string }).code
  if (ACCESS_DENIED_CODES.has(name)) return true
  if (code && ACCESS_DENIED_CODES.has(code)) return true
  return ACCESS_DENIED_MESSAGE.test(error.message)
}

const THROTTLE_CODES = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'RequestThrottled',
  'RequestThrottledException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'SlowDown',
  'ProvisionedThroughputExceededException',
])

export function isThrottle(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { Code?: string }).Code ?? error.name
  return THROTTLE_CODES.has(code)
}

/** Services that are simply not enabled in a region answer with these. */
const OPT_IN_CODES = new Set([
  'OptInRequired',
  'SubscriptionRequiredException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
])

export function isRegionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { Code?: string }).Code ?? error.name
  return OPT_IN_CODES.has(code)
}

/** The service-supplied error code, wherever the SDK happened to put it. */
export function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const withCode = error as { Code?: string; code?: string }
  return withCode.Code ?? withCode.code ?? null
}

/**
 * True when the error came from AWS rather than from our own code. Used to
 * decide whether a failure is worth filing as `unclassified` or should be
 * allowed to fail the scan.
 */
export function isAwsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ('$metadata' in error) return true
  if ('$fault' in error) return true
  if (errorCodeOf(error) !== null) return true
  return /Exception$|Fault$|Error$/.test(error.name) && error.name !== 'Error'
}


/**
 * The call succeeded in the sense that matters: the resource exists and simply
 * has no such configuration.
 *
 * Several AWS APIs signal an absent optional configuration by throwing. S3 is
 * the worst: a bucket with no tags raises `NoSuchTagSet`, one with no public
 * access block raises `NoSuchPublicAccessBlockConfiguration`, and one with no
 * default encryption raises `ServerSideEncryptionConfigurationNotFoundError`.
 * Most buckets are in at least one of those states.
 *
 * Classifying these as unclassified failures did two kinds of damage. It
 * flooded the unclassified bucket, which is exactly how that signal stops
 * meaning anything. And it discarded a security-relevant fact: a bucket that
 * raises `NoSuchPublicAccessBlockConfiguration` is definitively *not* blocked,
 * which is the bucket most worth flagging — and it was being recorded as
 * unknown.
 */
export class AbsentConfigurationError extends Error {
  readonly service: string
  readonly operation: string
  readonly errorName: string

  constructor(service: string, operation: string, errorName: string, message: string) {
    super(message)
    this.name = 'AbsentConfigurationError'
    this.service = service
    this.operation = operation
    this.errorName = errorName
  }
}

/**
 * Error names that mean "not configured".
 *
 * Listed explicitly rather than matched by pattern: "NoSuch*" would also
 * swallow `NoSuchBucket`, which is a real failure that means the bucket is
 * gone. The distinction is between a missing sub-resource and a missing
 * resource, and only an explicit list keeps it.
 */
export const ABSENT_CONFIGURATION_ERRORS = new Set([
  'NoSuchTagSet',
  'NoSuchTagSetError',
  'NoSuchPublicAccessBlockConfiguration',
  'ServerSideEncryptionConfigurationNotFoundError',
  'NoSuchLifecycleConfiguration',
  'NoSuchCORSConfiguration',
  'WAFNonexistentItemException',
])

export function isAbsentConfiguration(error: unknown): boolean {
  const err = error as { name?: string; Code?: string; code?: string } | null
  if (!err) return false
  for (const key of [err.name, err.Code, err.code]) {
    if (typeof key === 'string' && ABSENT_CONFIGURATION_ERRORS.has(key)) return true
  }
  return false
}
