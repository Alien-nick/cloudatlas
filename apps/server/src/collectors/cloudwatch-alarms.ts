import {
  DescribeAlarmsCommand,
  type DescribeAlarmsOutput,
} from '@aws-sdk/client-cloudwatch'
import type { CollectorContext, RegionScanData } from './types.js'
import { tolerate } from './types.js'

export async function collectAlarms(
  context: CollectorContext,
  data: RegionScanData,
): Promise<void> {
  const { aws, region } = context

  data.alarms = await tolerate(context, 'health', [], () =>
    aws.collect({
      service: 'cloudwatch',
      region,
      operation: 'DescribeAlarms',
      command: (token) =>
        new DescribeAlarmsCommand({ NextToken: token, AlarmTypes: ['MetricAlarm'] }),
      items: (out: DescribeAlarmsOutput) => out.MetricAlarms,
      nextToken: (out: DescribeAlarmsOutput) => out.NextToken,
    }),
  )

  context.onStep?.('cloudwatch-alarms')
}
