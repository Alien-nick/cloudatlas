import { DescribeRegionsCommand, type DescribeRegionsResult } from '@aws-sdk/client-ec2'
import { ListAccountAliasesCommand, type ListAccountAliasesResponse } from '@aws-sdk/client-iam'
import { GetCallerIdentityCommand, type GetCallerIdentityResponse } from '@aws-sdk/client-sts'
import type { Identity } from '@cloudatlas/shared'
import type { AwsClient } from './client.js'

/** Region used purely to reach the global STS and IAM endpoints. */
const BOOTSTRAP_REGION = 'us-east-1'

export async function getIdentity(
  aws: AwsClient,
  profile: string,
  region = BOOTSTRAP_REGION,
): Promise<Identity> {
  const caller = await aws.send<GetCallerIdentityResponse>(
    'sts',
    region,
    'GetCallerIdentity',
    new GetCallerIdentityCommand({}),
  )

  // The alias is cosmetic, and listing it is a separate permission, so a
  // failure here must not stop the app from connecting.
  let accountAlias: string | null = null
  try {
    const aliases = await aws.send<ListAccountAliasesResponse>(
      'iam',
      region,
      'ListAccountAliases',
      new ListAccountAliasesCommand({}),
    )
    accountAlias = aliases.AccountAliases?.[0] ?? null
  } catch {
    accountAlias = null
  }

  return {
    accountId: caller.Account ?? 'unknown',
    accountAlias,
    arn: caller.Arn ?? '',
    userId: caller.UserId ?? '',
    profile,
  }
}

/** Regions the account has enabled, newest API shape first. */
export async function listRegions(aws: AwsClient, region = BOOTSTRAP_REGION): Promise<string[]> {
  const result = await aws.send<DescribeRegionsResult>(
    'ec2',
    region,
    'DescribeRegions',
    // Opted-out regions would fail every subsequent call, so exclude them.
    new DescribeRegionsCommand({ AllRegions: false }),
  )
  return (result.Regions ?? [])
    .map((entry) => entry.RegionName)
    .filter((name): name is string => typeof name === 'string')
    .sort()
}
