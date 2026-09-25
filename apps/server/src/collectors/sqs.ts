import {
  GetQueueAttributesCommand,
  ListQueuesCommand,
  ListQueueTagsCommand,
  type GetQueueAttributesCommandOutput,
  type ListQueuesCommandOutput,
  type ListQueueTagsCommandOutput,
} from '@aws-sdk/client-sqs'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

/**
 * SQS queues.
 *
 * SQS is the odd one out: `ListQueues` returns URLs rather than ARNs or a
 * describe payload, so everything interesting — the ARN, the DLQ wiring, the
 * encryption setting — needs a second call per queue. `All` is requested rather
 * than a named subset because the attribute names differ per queue type and a
 * missing one comes back silently absent rather than as an error.
 */
export async function collectSqs(context: CollectorContext, data: RegionScanData): Promise<void> {
  const { aws, region } = context

  data.queueUrls = await tolerate(context, 'integration', [], () =>
    aws.collect({
      service: 'sqs',
      region,
      operation: 'ListQueues',
      command: (token) => new ListQueuesCommand({ NextToken: token, MaxResults: 1000 }),
      items: (out: ListQueuesCommandOutput) => out.QueueUrls,
      nextToken: (out: ListQueuesCommandOutput) => out.NextToken,
    }),
  )

  for (const url of data.queueUrls) {
    const attributes = await tolerate(context, 'integration', undefined, () =>
      aws.send<GetQueueAttributesCommandOutput>(
        'sqs',
        region,
        'GetQueueAttributes',
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }),
      ),
    )
    if (attributes?.Attributes) data.queueAttributes[url] = attributes.Attributes

    const tags = await tolerate(context, 'integration', undefined, () =>
      aws.send<ListQueueTagsCommandOutput>(
        'sqs',
        region,
        'ListQueueTags',
        new ListQueueTagsCommand({ QueueUrl: url }),
      ),
    )
    if (tags?.Tags) data.queueTags[url] = tags.Tags
  }

  context.onStep?.('sqs')
}
