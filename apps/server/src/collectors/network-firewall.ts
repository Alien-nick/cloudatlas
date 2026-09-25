import {
  DescribeFirewallCommand,
  DescribeLoggingConfigurationCommand,
  ListFirewallsCommand,
  type DescribeFirewallResponse,
  type DescribeLoggingConfigurationResponse,
  type ListFirewallsResponse,
} from '@aws-sdk/client-network-firewall'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

/**
 * AWS Network Firewall.
 *
 * Rare enough that most accounts have none, which is why the listing runs first
 * and the per-firewall calls only follow if something came back — an account
 * without Network Firewall should cost exactly one call, not three.
 */
export async function collectNetworkFirewall(
  context: CollectorContext,
  data: RegionScanData,
): Promise<void> {
  const { aws, region } = context
  const nfw = { service: 'network-firewall' as const, region }

  data.firewallMetadata = await tolerate(context, 'security', [], () =>
    aws.collect({
      ...nfw,
      operation: 'ListFirewalls',
      command: (token) => new ListFirewallsCommand({ NextToken: token }),
      items: (out: ListFirewallsResponse) => out.Firewalls,
      nextToken: (out: ListFirewallsResponse) => out.NextToken,
    }),
  )

  for (const meta of data.firewallMetadata) {
    const arn = meta.FirewallArn
    if (!arn) continue

    const described = await tolerate(context, 'security', undefined, () =>
      aws.send<DescribeFirewallResponse>(
        'network-firewall',
        region,
        'DescribeFirewall',
        new DescribeFirewallCommand({ FirewallArn: arn }),
      ),
    )
    if (described?.Firewall) data.firewalls[arn] = described.Firewall

    const logging = await tolerate(context, 'security', undefined, () =>
      aws.send<DescribeLoggingConfigurationResponse>(
        'network-firewall',
        region,
        'DescribeLoggingConfiguration',
        new DescribeLoggingConfigurationCommand({ FirewallArn: arn }),
      ),
    )
    if (logging?.LoggingConfiguration) data.firewallLogging[arn] = logging.LoggingConfiguration
  }

  context.onStep?.('network-firewall')
}
