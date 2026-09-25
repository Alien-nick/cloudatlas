import { ListRolesCommand, type ListRolesCommandOutput } from '@aws-sdk/client-iam'
import { GLOBAL_REGION } from '../aws/client.js'
import type { CollectorContext, GlobalScanData } from './types.js'
import { tolerate } from './types.js'

/**
 * IAM roles.
 *
 * Only the roles referenced by something else on the diagram end up as nodes —
 * an account has hundreds of service-linked roles, and drawing them all would
 * bury the handful that an instance or task actually assumes. The filtering
 * happens in the graph builder, which is the only place that knows what
 * references what; this collector's job is just to fetch.
 *
 * No policy documents are read. `ListRoles` returns the trust policy inline,
 * and the attached permission policies are a much larger surface for no benefit
 * the diagram can show.
 */
export async function collectIam(context: CollectorContext, data: GlobalScanData): Promise<void> {
  const { aws } = context

  data.roles = await tolerate(context, 'security', [], () =>
    aws.collect({
      service: 'iam',
      region: GLOBAL_REGION,
      operation: 'ListRoles',
      command: (token) => new ListRolesCommand({ Marker: token }),
      items: (out: ListRolesCommandOutput) => out.Roles,
      nextToken: (out: ListRolesCommandOutput) => (out.IsTruncated ? out.Marker : undefined),
    }),
  )

  context.onStep?.('iam')
}
