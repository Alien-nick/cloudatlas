import { describe, expect, it } from 'vitest'
import type { AlarmHistoryItem as AwsAlarmHistoryItem } from '@aws-sdk/client-cloudwatch'
import { toHistoryItem } from './alarm-history.js'

const REASON =
  'Threshold Crossed: 1 datapoint [93.4 (20/09/26 01:15:00)] was greater than the threshold (80.0).'

function stateUpdate(overrides: Partial<AwsAlarmHistoryItem> = {}): AwsAlarmHistoryItem {
  return {
    AlarmName: 'prod-pg-primary-cpu',
    Timestamp: new Date('2026-09-20T01:16:00Z'),
    HistoryItemType: 'StateUpdate',
    HistorySummary: 'Alarm updated from OK to ALARM',
    HistoryData: JSON.stringify({
      version: '1.0',
      oldState: { stateValue: 'OK' },
      newState: { stateValue: 'ALARM', stateReason: REASON },
    }),
    ...overrides,
  }
}

describe('alarm history entries', () => {
  it('keeps the reason, which is the part that says what actually crossed', () => {
    const item = toHistoryItem(stateUpdate())
    expect(item?.state).toBe('ALARM')
    expect(item?.summary).toContain('Alarm updated from OK to ALARM')
    expect(item?.summary).toContain('93.4')
    expect(item?.summary).toContain('threshold (80.0)')
  })

  it('survives history data that is not the JSON we expect', () => {
    // A malformed blob must cost that row its reason, not the whole timeline.
    const broken = toHistoryItem(stateUpdate({ HistoryData: '{not json' }))
    expect(broken).not.toBeNull()
    expect(broken?.summary).toBe('Alarm updated from OK to ALARM')
    expect(broken?.state).toBeNull()

    const empty = toHistoryItem(stateUpdate({ HistoryData: undefined }))
    expect(empty?.summary).toBe('Alarm updated from OK to ALARM')
  })

  it('keeps configuration changes, with no state attached', () => {
    // An alarm whose threshold moved shortly before it fired is a different
    // story from one that fired on its own.
    const config = toHistoryItem({
      Timestamp: new Date('2026-09-20T00:56:00Z'),
      HistoryItemType: 'ConfigurationUpdate',
      HistorySummary: 'Alarm "prod-pg-primary-cpu" updated',
      HistoryData: JSON.stringify({ type: 'Update' }),
    })
    expect(config).not.toBeNull()
    expect(config?.state).toBeNull()
    expect(config?.summary).toContain('updated')
  })

  it('drops an entry with no timestamp rather than dating it to now', () => {
    expect(toHistoryItem(stateUpdate({ Timestamp: undefined }))).toBeNull()
  })

  it('falls back to the item type when AWS sends no summary', () => {
    const item = toHistoryItem(stateUpdate({ HistorySummary: undefined, HistoryData: undefined }))
    expect(item?.summary).toBe('StateUpdate')
  })
})
