import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { EC2Client } from '@aws-sdk/client-ec2'
import { ECSClient } from '@aws-sdk/client-ecs'
import { ElastiCacheClient } from '@aws-sdk/client-elasticache'
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2'
import { IAMClient } from '@aws-sdk/client-iam'
import { RDSClient } from '@aws-sdk/client-rds'
import { STSClient } from '@aws-sdk/client-sts'
import { fromIni } from '@aws-sdk/credential-providers'
import pLimit from 'p-limit'
import {
  MissingPermissionError,
  ReadOnlyViolationError,
  UnclassifiedAwsError,
  errorCodeOf,
  isAccessDenied,
  isAwsError,
  isThrottle,
  AbsentConfigurationError,
  isAbsentConfiguration,
} from './errors.js'
import { CloudFrontClient } from '@aws-sdk/client-cloudfront'
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail'
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer'
import { PIClient } from '@aws-sdk/client-pi'
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs'
import { WAFV2Client } from '@aws-sdk/client-wafv2'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { NetworkFirewallClient } from '@aws-sdk/client-network-firewall'
import { Route53Client } from '@aws-sdk/client-route-53'
import { S3Client } from '@aws-sdk/client-s3'
import { SQSClient } from '@aws-sdk/client-sqs'
import { actionOf, findOperation, hasReadOnlyShape } from './operations.js'
import type { TranscriptReader, TranscriptWriter } from './transcript.js'

export type AwsMode = 'live' | 'capture' | 'replay'

export type ServiceKey =
  | 'ec2'
  | 'elasticloadbalancing'
  | 'rds'
  | 'elasticache'
  | 'ecs'
  | 'cloudwatch'
  | 'sts'
  | 'iam'
  | 's3'
  | 'lambda'
  | 'cloudfront'
  | 'route53'
  | 'sqs'
  | 'network-firewall'
  | 'logs'
  | 'wafv2'
  | 'cloudtrail'
  | 'ce'
  | 'pi'

interface SdkClient {
  send(command: object): Promise<unknown>
  destroy(): void
}

interface ClientConfig {
  region: string
  credentials: ReturnType<typeof fromIni>
  maxAttempts: number
  retryMode: string
}

const FACTORIES: Record<ServiceKey, (config: ClientConfig) => SdkClient> = {
  ec2: (config) => new EC2Client(config) as unknown as SdkClient,
  elasticloadbalancing: (config) =>
    new ElasticLoadBalancingV2Client(config) as unknown as SdkClient,
  rds: (config) => new RDSClient(config) as unknown as SdkClient,
  elasticache: (config) => new ElastiCacheClient(config) as unknown as SdkClient,
  ecs: (config) => new ECSClient(config) as unknown as SdkClient,
  cloudwatch: (config) => new CloudWatchClient(config) as unknown as SdkClient,
  sts: (config) => new STSClient(config) as unknown as SdkClient,
  iam: (config) => new IAMClient(config) as unknown as SdkClient,
  s3: (config) => new S3Client(config) as unknown as SdkClient,
  lambda: (config) => new LambdaClient(config) as unknown as SdkClient,
  cloudfront: (config) => new CloudFrontClient(config) as unknown as SdkClient,
  route53: (config) => new Route53Client(config) as unknown as SdkClient,
  sqs: (config) => new SQSClient(config) as unknown as SdkClient,
  'network-firewall': (config) => new NetworkFirewallClient(config) as unknown as SdkClient,
  logs: (config) => new CloudWatchLogsClient(config) as unknown as SdkClient,
  wafv2: (config) => new WAFV2Client(config) as unknown as SdkClient,
  cloudtrail: (config) => new CloudTrailClient(config) as unknown as SdkClient,
  ce: (config) => new CostExplorerClient(config) as unknown as SdkClient,
  pi: (config) => new PIClient(config) as unknown as SdkClient,
}

/**
 * Services with a single global endpoint, pinned so we do not open one client
 * per selected region for an API that ignores the region anyway.
 *
 * S3 is deliberately absent. `ListBuckets` is global, but every other bucket
 * call must go to the bucket's own region or it fails with a redirect, so the
 * S3 collector passes the region explicitly.
 */
/** Pseudo-region for calls that have none. See `client()`. */
export const GLOBAL_REGION = 'global'

const GLOBAL_SERVICES: Partial<Record<ServiceKey, string>> = {
  iam: 'us-east-1',
  cloudfront: 'us-east-1',
  ce: 'us-east-1',
  route53: 'us-east-1',
}

/**
 * An AWS failure that matched no classifier. Recorded rather than guessed at,
 * so a capture reports which error shapes we do not yet recognise instead of a
 * panel silently rendering nothing.
 */
export interface UnclassifiedFailure {
  service: string
  operation: string
  region: string
  errorName: string
  errorCode: string | null
  /** Scrubbed like everything else before it reaches meta.json. */
  message: string
}

export interface RegionStats {
  calls: number
  callsByAction: Record<string, number>
  retries: number
  throttles: number
  accessDenied: string[]
  unclassified: UnclassifiedFailure[]
  /** Summed time inside API calls. Not wall clock — calls run concurrently. */
  apiMs: number
}

export interface AwsStats {
  totalCalls: number
  callsByAction: Record<string, number>
  /** Extra HTTP attempts beyond the first, summed from `$metadata.attempts`. */
  retries: number
  throttles: number
  accessDenied: string[]
  unclassified: UnclassifiedFailure[]
  byRegion: Record<string, RegionStats>
}

function emptyRegionStats(): RegionStats {
  return {
    calls: 0,
    callsByAction: {},
    retries: 0,
    throttles: 0,
    accessDenied: [],
    unclassified: [],
    apiMs: 0,
  }
}

export interface AwsClientOptions {
  profile: string
  /**
   * Keys to use instead of the profile. Only for verifying access keys the
   * user just entered, before they are saved — every other client resolves
   * credentials from a profile through the SDK's own chain.
   */
  staticCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  mode: AwsMode
  /** Required in capture mode. */
  writer?: TranscriptWriter
  /** Required in replay mode. */
  reader?: TranscriptReader
  /** Called once per distinct missing permission. */
  onMissingPermission?: (action: string, region: string, message: string) => void
  /** Called for every AWS failure no classifier recognised. */
  onUnclassified?: (failure: UnclassifiedFailure) => void
  /** In-flight requests per region. */
  concurrencyPerRegion?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export interface PaginateOptions<TOut, TItem> {
  service: ServiceKey
  region: string
  operation: string
  /** Build the command for a page; `token` is undefined on the first call. */
  command: (token: string | undefined) => object
  /** Pull the page's items out of the response. */
  items: (output: TOut) => TItem[] | undefined
  /** Pull the continuation token; return undefined when done. */
  nextToken: (output: TOut) => string | undefined
  /** Safety valve against a pagination bug spinning forever. */
  maxPages?: number
}

/**
 * The single seam between CloudAtlas and the AWS SDK.
 *
 * Every call passes the read-only guard: the operation must be registered in
 * `operations.ts` with status `active`, and its name must read as read-only.
 * Both conditions, not either — the prefix list alone would allow a Describe
 * on a service we never meant to touch, and the registry alone would allow a
 * typo'd mutating name to slip through review.
 *
 * The same wrapper records a transcript in capture mode and serves one back in
 * replay mode, which is what lets collectors and relationship builders be
 * developed and regression-tested with no credentials present.
 */
export class AwsClient {
  private readonly clients = new Map<string, SdkClient>()
  private readonly limiters = new Map<string, ReturnType<typeof pLimit>>()
  private readonly credentials: ReturnType<typeof fromIni> | null
  private readonly seenMissing = new Set<string>()

  readonly stats: AwsStats = {
    totalCalls: 0,
    callsByAction: {},
    retries: 0,
    throttles: 0,
    accessDenied: [],
    unclassified: [],
    byRegion: {},
  }

  private region(region: string): RegionStats {
    const existing = this.stats.byRegion[region]
    if (existing) return existing
    const created = emptyRegionStats()
    this.stats.byRegion[region] = created
    return created
  }

  constructor(private readonly options: AwsClientOptions) {
    // Replay must never resolve credentials — that is the guarantee that lets
    // this run in CI and on a machine with no AWS config at all.
    //
    // ignoreCache: the SDK otherwise caches the credentials file for the life
    // of the process, so a profile saved from the UI would not resolve until
    // a restart.
    const fixed = options.staticCredentials
    this.credentials =
      options.mode === 'replay'
        ? null
        : fixed
          ? async () => ({ ...fixed })
          : fromIni({ profile: options.profile, ignoreCache: true })
  }

  get mode(): AwsMode {
    return this.options.mode
  }

  private limiter(region: string): ReturnType<typeof pLimit> {
    let limit = this.limiters.get(region)
    if (!limit) {
      limit = pLimit(this.options.concurrencyPerRegion ?? 8)
      this.limiters.set(region, limit)
    }
    return limit
  }

  private client(service: ServiceKey, region: string): SdkClient {
    // 'global' is not an AWS region. It is the region an account-wide call is
    // recorded under, so a capture groups those calls separately instead of
    // attributing them to whichever region the user happened to select first.
    // It has to resolve to a real endpoint before a client can be built.
    const effectiveRegion =
      GLOBAL_SERVICES[service] ?? (region === GLOBAL_REGION ? 'us-east-1' : region)
    const key = `${service}:${effectiveRegion}`
    let client = this.clients.get(key)
    if (client) return client

    if (!this.credentials) {
      throw new Error(`Cannot construct an AWS client in ${this.options.mode} mode`)
    }
    const factory = FACTORIES[service]
    client = factory({
      region: effectiveRegion,
      credentials: this.credentials,
      // Adaptive backs off automatically when a service starts throttling,
      // which matters when scanning several regions at once.
      maxAttempts: 5,
      retryMode: 'adaptive',
    })
    this.clients.set(key, client)
    return client
  }

  /** Throws unless the operation is registered, active and read-only shaped. */
  private guard(service: ServiceKey, operation: string): string {
    if (!hasReadOnlyShape(operation)) {
      throw new ReadOnlyViolationError(service, operation, 'the name is not read-only shaped')
    }
    const spec = findOperation(service, operation)
    if (!spec) {
      throw new ReadOnlyViolationError(service, operation, 'it is not in the operation registry')
    }
    if (spec.status !== 'active') {
      throw new ReadOnlyViolationError(
        service,
        operation,
        `it is registered as "${spec.status}" for ${spec.milestone}, not active`,
      )
    }
    return actionOf(spec)
  }

  /**
   * Execute one operation. `operation` is passed explicitly rather than read
   * off the command's constructor name, so the guard never depends on runtime
   * reflection surviving a bundler.
   */
  async send<TOut>(
    service: ServiceKey,
    region: string,
    operation: string,
    command: object,
  ): Promise<TOut> {
    const action = this.guard(service, operation)

    this.stats.totalCalls++
    this.stats.callsByAction[action] = (this.stats.callsByAction[action] ?? 0) + 1
    const regionStats = this.region(region)
    regionStats.calls++
    regionStats.callsByAction[action] = (regionStats.callsByAction[action] ?? 0) + 1

    if (this.options.mode === 'replay') {
      const reader = this.options.reader
      if (!reader) throw new Error('Replay mode requires a transcript reader')
      try {
        return reader.next(region, service, operation) as TOut
      } catch (error) {
        // A recorded failure must classify exactly as the live one did, or a
        // replayed fixture would not reproduce the warnings it was captured for.
        if (error instanceof Error && error.name === 'TranscriptExhaustedError') throw error
        throw this.classify(error, service, operation, region, action, regionStats)
      }
    }

    const input = (command as { input?: unknown }).input ?? {}
    const started = Date.now()
    const limit = this.limiter(region)

    return limit(async () => {
      try {
        const output = (await this.client(service, region).send(command)) as TOut
        const durationMs = Date.now() - started
        this.recordDuration(region, durationMs)

        const attempts = (output as { $metadata?: { attempts?: number } })?.$metadata?.attempts ?? 1
        if (attempts > 1) {
          this.stats.retries += attempts - 1
          regionStats.retries += attempts - 1
        }

        this.options.writer?.record({
          service,
          operation,
          region,
          input,
          output,
          durationMs,
        })
        return output
      } catch (error) {
        const durationMs = Date.now() - started
        this.recordDuration(region, durationMs)

        // Every failure is recorded, not just denials: replay has to be able to
        // reproduce the same error at the same point in the sequence.
        this.options.writer?.record({
          service,
          operation,
          region,
          input,
          output: null,
          durationMs,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
            ...(errorCodeOf(error) ? { code: errorCodeOf(error) as string } : {}),
          },
        })

        throw this.classify(error, service, operation, region, action, regionStats)
      }
    })
  }

  private recordDuration(region: string, durationMs: number): void {
    this.region(region).apiMs += durationMs
  }

  /**
   * Sort one failure into exactly one bucket: throttle, missing permission, an
   * AWS error we do not recognise, or a bug in our own code.
   *
   * The fourth case is deliberately left unwrapped so it keeps propagating and
   * fails loudly. The third is wrapped and recorded — AWS's prose for a denial
   * is not a closed set, and a capture that reports "we saw this shape and did
   * not understand it" is far more useful than one that guesses.
   */
  private classify(
    error: unknown,
    service: ServiceKey,
    operation: string,
    region: string,
    action: string,
    regionStats: RegionStats,
  ): unknown {
    if (isThrottle(error)) {
      this.stats.throttles++
      regionStats.throttles++
    }

    const message = error instanceof Error ? error.message : String(error)

    if (isAccessDenied(error)) {
      const key = `${action}|${region}`
      if (!this.seenMissing.has(key)) {
        this.seenMissing.add(key)
        this.stats.accessDenied.push(action)
        regionStats.accessDenied.push(action)
        this.options.onMissingPermission?.(action, region, message)
      }
      return new MissingPermissionError(action, region, message)
    }

    // Checked before the unclassified bucket: an absent optional configuration
    // is a normal state, and counting it as an unrecognised failure is how that
    // bucket stops being a signal worth reading.
    if (isAbsentConfiguration(error)) {
      const errorName = error instanceof Error ? error.name : (errorCodeOf(error) ?? 'Error')
      return new AbsentConfigurationError(service, operation, errorName, message)
    }

    if (isAwsError(error)) {
      const failure: UnclassifiedFailure = {
        service,
        operation,
        region,
        errorName: error instanceof Error ? error.name : 'Error',
        errorCode: errorCodeOf(error),
        message,
      }
      this.stats.unclassified.push(failure)
      regionStats.unclassified.push(failure)
      this.options.onUnclassified?.(failure)
      return new UnclassifiedAwsError(
        service,
        operation,
        region,
        failure.errorName,
        failure.errorCode,
        message,
      )
    }

    this.options.log?.(`${action} failed in ${region}`, { error: message })
    return error
  }

  /** Walk every page of a paginated operation, yielding items as they arrive. */
  async *paginate<TOut, TItem>(options: PaginateOptions<TOut, TItem>): AsyncGenerator<TItem> {
    const maxPages = options.maxPages ?? 200
    let token: string | undefined
    let page = 0

    do {
      const output = await this.send<TOut>(
        options.service,
        options.region,
        options.operation,
        options.command(token),
      )
      for (const item of options.items(output) ?? []) yield item
      token = options.nextToken(output)
      page++
      if (page >= maxPages && token) {
        this.options.log?.(
          `${options.service}:${options.operation} hit the ${maxPages}-page cap in ${options.region}`,
        )
        break
      }
    } while (token)
  }

  /** Collect a paginated operation into an array. */
  async collect<TOut, TItem>(options: PaginateOptions<TOut, TItem>): Promise<TItem[]> {
    const out: TItem[] = []
    for await (const item of this.paginate(options)) out.push(item)
    return out
  }

  async destroy(): Promise<void> {
    for (const client of this.clients.values()) client.destroy()
    this.clients.clear()
  }
}
