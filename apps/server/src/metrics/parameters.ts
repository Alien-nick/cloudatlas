import { DescribeDBParametersCommand, type DescribeDBParametersCommandOutput } from '@aws-sdk/client-rds'
import type { AwsClient } from '../aws/client.js'
import type { ResourceLimits } from '../health/spike.js'

/**
 * Resolve max_connections for an RDS instance.
 *
 * A connection count on its own says almost nothing — 1,400 connections is
 * unremarkable on a db.r6g.8xlarge and fatal on a db.t3.medium. The denominator
 * is what makes the number a finding.
 *
 * The complication is that RDS usually does not store max_connections as a
 * number. The engine default is a formula evaluated on the host:
 *
 *   LEAST({DBInstanceClassMemory/9531392},5000)
 *
 * `DBInstanceClassMemory` is not exposed by any API, so that formula cannot be
 * evaluated from here. When we hit one we say so. The alternative — mapping
 * instance classes to memory sizes in a lookup table — would be wrong the day
 * AWS launches a new instance family, and wrong silently, since a plausible
 * denominator produces a plausible percentage.
 */

/** Matches an explicit integer setting, and nothing else. */
const INTEGER_RE = /^\d+$/

export function parseMaxConnections(value: string | undefined): ResourceLimits {
  if (value === undefined || value.trim() === '') {
    return { maxConnectionsUnknown: 'the parameter group does not set max_connections' }
  }
  const trimmed = value.trim()
  if (INTEGER_RE.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10)
    if (Number.isSafeInteger(parsed) && parsed > 0) return { maxConnections: parsed }
  }
  return {
    maxConnectionsUnknown:
      `max_connections is the engine default formula "${trimmed}", which depends on ` +
      'DBInstanceClassMemory and cannot be resolved through the API',
  }
}

export interface MaxConnectionsOptions {
  aws: AwsClient
  region: string
  /** Parameter group attached to the instance. */
  parameterGroupName: string
}

/**
 * Read max_connections from a parameter group.
 *
 * Returns a reason rather than throwing when the call is denied, because a
 * missing denominator degrades one evidence line — it must not cost the scan a
 * finding it would otherwise have raised.
 */
export async function fetchMaxConnections(
  options: MaxConnectionsOptions,
): Promise<ResourceLimits> {
  const { aws, region, parameterGroupName } = options
  try {
    const parameters = await aws.collect({
      service: 'rds',
      region,
      operation: 'DescribeDBParameters',
      command: (token) =>
        new DescribeDBParametersCommand({
          DBParameterGroupName: parameterGroupName,
          Marker: token,
        }),
      items: (out: DescribeDBParametersCommandOutput) => out.Parameters,
      nextToken: (out: DescribeDBParametersCommandOutput) => out.Marker,
    })

    const setting = parameters.find((parameter) => parameter.ParameterName === 'max_connections')
    return parseMaxConnections(setting?.ParameterValue)
  } catch (error) {
    return {
      maxConnectionsUnknown: `reading parameter group ${parameterGroupName} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}
