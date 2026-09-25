import {
  GetBucketEncryptionCommand,
  GetBucketNotificationConfigurationCommand,
  type GetBucketNotificationConfigurationCommandOutput,
  GetBucketLocationCommand,
  GetBucketTaggingCommand,
  GetPublicAccessBlockCommand,
  ListBucketsCommand,
  type GetBucketEncryptionCommandOutput,
  type GetBucketLocationCommandOutput,
  type GetBucketTaggingCommandOutput,
  type GetPublicAccessBlockCommandOutput,
  type ListBucketsCommandOutput,
} from '@aws-sdk/client-s3'
import { GLOBAL_REGION } from '../aws/client.js'
import type { CollectorContext, GlobalScanData } from './types.js'
import { tolerate, tolerateAbsent } from './types.js'

/**
 * S3 buckets.
 *
 * Four per-bucket calls, which makes this the most expensive collector here —
 * an account with 300 buckets costs 1,200 calls. Accepted because the answers
 * are the ones people actually ask of S3 (where is it, is it encrypted, is it
 * public), and because it is bounded: buckets are account-wide, so this runs
 * once regardless of how many regions are selected.
 *
 * The loop is sequential on purpose, and that is the real cost. Running the
 * per-bucket calls concurrently would be several times faster, but the capture
 * transcript keys recorded responses by (region, service, operation) and
 * replays them in call order — so concurrent calls would return bucket A's
 * tags for bucket B on replay, nondeterministically. Replay fidelity is worth
 * more than scan speed here, and buying the speed properly means keying the
 * transcript by resource, which is a format change.
 *
 * The practical limit: an account with thousands of buckets will make this the
 * slowest part of a scan. If that shows up in a real capture, the fix is the
 * transcript change above, not quietly truncating the bucket list.
 */

/**
 * `GetBucketLocation` answers with null for us-east-1 and, historically, "EU"
 * for eu-west-1. Both are documented quirks, not errors.
 */
export function normalizeBucketLocation(constraint: string | undefined | null): string {
  if (!constraint) return 'us-east-1'
  if (constraint === 'EU') return 'eu-west-1'
  return constraint
}

/**
 * True only when all four blocks are on. Three of four leaves a way in, and
 * reporting that as "blocked" would be worse than reporting nothing.
 */
export function isFullyBlocked(config: {
  PublicAccessBlockConfiguration?: {
    BlockPublicAcls?: boolean
    IgnorePublicAcls?: boolean
    BlockPublicPolicy?: boolean
    RestrictPublicBuckets?: boolean
  }
}): boolean {
  const block = config.PublicAccessBlockConfiguration
  if (!block) return false
  return (
    block.BlockPublicAcls === true &&
    block.IgnorePublicAcls === true &&
    block.BlockPublicPolicy === true &&
    block.RestrictPublicBuckets === true
  )
}

/** Default encryption algorithm, or null when the bucket has none. */
export function encryptionOf(config: {
  ServerSideEncryptionConfiguration?: {
    Rules?: Array<{ ApplyServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }>
  }
}): string | null {
  const rule = config.ServerSideEncryptionConfiguration?.Rules?.[0]
  return rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? null
}

/**
 * ARNs a bucket sends events to.
 *
 * All three destination types are read. A bucket that fans out to SNS is as
 * much a part of the architecture as one that triggers a Lambda, and omitting
 * a destination type would draw an event edge for some buckets and not others
 * for no reason the diagram explains.
 */
export function notificationTargets(config: {
  LambdaFunctionConfigurations?: Array<{ LambdaFunctionArn?: string }>
  QueueConfigurations?: Array<{ QueueArn?: string }>
  TopicConfigurations?: Array<{ TopicArn?: string }>
}): string[] {
  const arns = [
    ...(config.LambdaFunctionConfigurations ?? []).map((entry) => entry.LambdaFunctionArn),
    ...(config.QueueConfigurations ?? []).map((entry) => entry.QueueArn),
    ...(config.TopicConfigurations ?? []).map((entry) => entry.TopicArn),
  ]
  return [...new Set(arns.filter((arn): arn is string => typeof arn === 'string'))]
}

/**
 * Values standing for "this configuration is not set".
 *
 * Named constants rather than inline literals so the call sites read as what
 * they mean, and so the difference from `undefined` — which means the call
 * failed — stays visible.
 */
const NO_METADATA = { $metadata: {} }
const EMPTY_TAGGING: GetBucketTaggingCommandOutput = { ...NO_METADATA, TagSet: [] }
const EMPTY_ENCRYPTION: GetBucketEncryptionCommandOutput = { ...NO_METADATA }
const NO_ACCESS_BLOCK: GetPublicAccessBlockCommandOutput = { ...NO_METADATA }
const EMPTY_NOTIFICATIONS: GetBucketNotificationConfigurationCommandOutput = { ...NO_METADATA }

export async function collectS3(context: CollectorContext, data: GlobalScanData): Promise<void> {
  const { aws } = context

  const listed = await tolerate(context, 'storage', undefined, () =>
    aws.send<ListBucketsCommandOutput>(
      's3',
      GLOBAL_REGION,
      'ListBuckets',
      new ListBucketsCommand({}),
    ),
  )
  data.buckets = listed?.Buckets ?? []

  for (const bucket of data.buckets) {
    const name = bucket.Name
    if (!name) continue

    const location = await tolerate(context, 'storage', undefined, () =>
      aws.send<GetBucketLocationCommandOutput>(
        's3',
        GLOBAL_REGION,
        'GetBucketLocation',
        new GetBucketLocationCommand({ Bucket: name }),
      ),
    )
    // No location means the call failed, not that the bucket is in us-east-1 —
    // those are different facts, and only the successful one is recorded.
    if (location) {
      data.bucketRegions[name] = normalizeBucketLocation(location.LocationConstraint)
    }
    const region = data.bucketRegions[name] ?? 'us-east-1'

    // A bucket with no tags raises NoSuchTagSet rather than returning an empty
    // set, so "no tags" arrives here as an absent configuration.
    const tagging = await tolerateAbsent(context, 'storage', undefined, EMPTY_TAGGING, () =>
      aws.send<GetBucketTaggingCommandOutput>(
        's3',
        region,
        'GetBucketTagging',
        new GetBucketTaggingCommand({ Bucket: name }),
      ),
    )
    if (tagging?.TagSet) {
      data.bucketTags[name] = Object.fromEntries(
        tagging.TagSet.filter((tag) => tag.Key).map((tag) => [tag.Key as string, tag.Value ?? '']),
      )
    }

    // Likewise, a bucket with no default encryption raises rather than
    // returning an empty configuration — and "not encrypted" is the answer the
    // posture detector needs, not a failure.
    const encryption = await tolerateAbsent(context, 'storage', undefined, EMPTY_ENCRYPTION, () =>
      aws.send<GetBucketEncryptionCommandOutput>(
        's3',
        region,
        'GetBucketEncryption',
        new GetBucketEncryptionCommand({ Bucket: name }),
      ),
    )
    if (encryption) data.bucketEncryption[name] = encryptionOf(encryption)

    // The important one. A bucket with no public access block configuration
    // raises NoSuchPublicAccessBlockConfiguration — and that bucket is
    // definitively NOT blocked, which is exactly the bucket worth flagging.
    // Recording it as a failure discarded the finding.
    const publicAccess = await tolerateAbsent(context, 'storage', undefined, NO_ACCESS_BLOCK, () =>
      aws.send<GetPublicAccessBlockCommandOutput>(
        's3',
        region,
        'GetPublicAccessBlock',
        new GetPublicAccessBlockCommand({ Bucket: name }),
      ),
    )
    if (publicAccess) data.bucketPublicAccessBlocked[name] = isFullyBlocked(publicAccess)

    const notifications = await tolerateAbsent(context, 'storage', undefined, EMPTY_NOTIFICATIONS, () =>
      aws.send<GetBucketNotificationConfigurationCommandOutput>(
        's3',
        region,
        'GetBucketNotificationConfiguration',
        new GetBucketNotificationConfigurationCommand({ Bucket: name }),
      ),
    )
    if (notifications) data.bucketNotifications[name] = notificationTargets(notifications)
  }

  context.onStep?.('s3')
}
