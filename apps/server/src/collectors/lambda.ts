import {
  ListEventSourceMappingsCommand,
  ListFunctionsCommand,
  ListTagsCommand,
  type ListEventSourceMappingsCommandOutput,
  type ListFunctionsCommandOutput,
  type ListTagsCommandOutput,
} from '@aws-sdk/client-lambda'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

/**
 * Lambda functions and their event sources.
 *
 * `ListFunctions` already returns the full configuration — runtime, memory, VPC
 * config, role — so `GetFunctionConfiguration` is not called per function. That
 * matters: an account with 400 functions would otherwise cost 400 extra calls
 * for data we already have.
 */
export async function collectLambda(
  context: CollectorContext,
  data: RegionScanData,
): Promise<void> {
  const { aws, region } = context
  const lambda = { service: 'lambda' as const, region }

  data.functions = await tolerate(context, 'compute', [], () =>
    aws.collect({
      ...lambda,
      operation: 'ListFunctions',
      command: (token) => new ListFunctionsCommand({ Marker: token }),
      items: (out: ListFunctionsCommandOutput) => out.Functions,
      nextToken: (out: ListFunctionsCommandOutput) => out.NextMarker,
    }),
  )

  data.eventSourceMappings = await tolerate(context, 'integration', [], () =>
    aws.collect({
      ...lambda,
      operation: 'ListEventSourceMappings',
      command: (token) => new ListEventSourceMappingsCommand({ Marker: token }),
      items: (out: ListEventSourceMappingsCommandOutput) => out.EventSourceMappings,
      nextToken: (out: ListEventSourceMappingsCommandOutput) => out.NextMarker,
    }),
  )

  // One call per function, like ElastiCache. Lambda has no batch tag API.
  for (const fn of data.functions) {
    const arn = fn.FunctionArn
    if (!arn) continue
    const tags = await tolerate(context, 'compute', undefined, () =>
      aws.send<ListTagsCommandOutput>(
        'lambda',
        region,
        'ListTags',
        new ListTagsCommand({ Resource: arn }),
      ),
    )
    if (tags?.Tags) data.functionTags[arn] = tags.Tags
  }

  context.onStep?.('lambda')
}
