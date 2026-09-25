import { describe, expect, it } from 'vitest'
import { automaticDenyWords, formatDenyFailure, scanForDenyWords } from './deny.js'

function files(entries: Record<string, unknown>): Map<string, string> {
  return new Map(
    Object.entries(entries).map(([name, value]) => [name, JSON.stringify(value, null, 2)]),
  )
}

describe('automaticDenyWords', () => {
  it('adds the account id in both raw and dash-grouped form', () => {
    const words = automaticDenyWords('482177301192', [])
    expect(words).toContain('482177301192')
    expect(words).toContain('4821-7730-1192')
  })

  it('adds every profile name used', () => {
    expect(automaticDenyWords('482177301192', ['cortex-prod'])).toContain('cortex-prod')
  })

  it('ignores an unknown account and very short profile names', () => {
    const words = automaticDenyWords('unknown', ['ci'])
    expect(words).toEqual([])
  })
})

describe('scanForDenyWords', () => {
  it('passes a clean fixture', () => {
    const result = scanForDenyWords({
      files: files({ 'a.json': [{ InstanceId: 'i-0000000000000001' }] }),
      deny: ['acme-corp'],
      allow: [],
    })
    expect(result.hits).toEqual([])
  })

  it('catches a value that survived redaction, with its JSON path', () => {
    const result = scanForDenyWords({
      files: files({
        'us-east-1/rds.DescribeDBInstances.json': [
          { output: { DBInstances: [{ Endpoint: { Address: 'db.acme-corp.internal' } }] } },
        ],
      }),
      deny: ['acme-corp'],
      allow: [],
    })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.file).toBe('us-east-1/rds.DescribeDBInstances.json')
    expect(result.hits[0]?.path).toBe('[0].output.DBInstances[0].Endpoint.Address')
  })

  it('matches case-insensitively', () => {
    const result = scanForDenyWords({
      files: files({ 'a.json': { note: 'ACME-CORP runs this' } }),
      deny: ['acme-corp'],
      allow: [],
    })
    expect(result.hits).toHaveLength(1)
  })

  it('matches a substring, not just a whole token', () => {
    // An account id embedded in an ARN is the motivating case.
    const result = scanForDenyWords({
      files: files({ 'a.json': { arn: 'arn:aws:rds:us-east-1:482177301192:db:x' } }),
      deny: ['482177301192'],
      allow: [],
    })
    expect(result.hits).toHaveLength(1)
  })

  it('checks object keys, not only values', () => {
    const result = scanForDenyWords({
      files: files({ 'a.json': { 'acme-corp-bucket': { size: 1 } } }),
      deny: ['acme-corp'],
      allow: [],
    })
    expect(result.hits).toHaveLength(1)
  })

  it('checks numbers, since an account id can arrive unquoted', () => {
    const result = scanForDenyWords({
      files: files({ 'a.json': { OwnerId: 482177301192 } }),
      deny: ['482177301192'],
      allow: [],
    })
    expect(result.hits).toHaveLength(1)
  })

  it('never puts the matched value in the excerpt', () => {
    const result = scanForDenyWords({
      files: files({ 'a.json': { host: 'db.acme-corp.internal' } }),
      deny: ['acme-corp'],
      allow: [],
    })
    const excerpt = result.hits[0]?.excerpt ?? ''
    expect(excerpt).not.toContain('acme-corp')
    expect(excerpt).toContain('***REDACTED(9)***')
    // Surrounding context is preserved so the leak is locatable.
    expect(excerpt).toContain('db.')
    expect(excerpt).toContain('.internal')
  })

  it('suppresses an allowed word and reports the suppression', () => {
    const result = scanForDenyWords({
      files: files({ 'a.json': { region: 'us-east-1' } }),
      deny: ['us-east-1'],
      allow: ['us-east-1'],
    })
    expect(result.hits).toEqual([])
    expect(result.suppressed).toEqual(['us-east-1'])
    expect(result.checked).not.toContain('us-east-1')
  })

  it('reports every occurrence across files', () => {
    const result = scanForDenyWords({
      files: files({
        'a.json': { x: 'acme-corp' },
        'b.json': { y: ['acme-corp', 'fine'] },
      }),
      deny: ['acme-corp'],
      allow: [],
    })
    expect(result.hits).toHaveLength(2)
    expect(new Set(result.hits.map((h) => h.file))).toEqual(new Set(['a.json', 'b.json']))
  })

  it('does nothing when there are no deny words', () => {
    const result = scanForDenyWords({ files: files({ 'a.json': { x: 'anything' } }), deny: [], allow: [] })
    expect(result.hits).toEqual([])
    expect(result.checked).toEqual([])
  })

  it('still flags a file that will not parse', () => {
    const result = scanForDenyWords({
      files: new Map([['broken.json', '{not json acme-corp']]),
      deny: ['acme-corp'],
      allow: [],
    })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.path).toBe('(unparsed)')
  })
})

describe('formatDenyFailure', () => {
  it('leads with DO NOT COMMIT and omits the secret', () => {
    const result = scanForDenyWords({
      files: files({ 'a.json': { host: 'db.acme-corp.internal' } }),
      deny: ['acme-corp'],
      allow: [],
    })
    const message = formatDenyFailure(result)
    expect(message).toContain('DO NOT COMMIT')
    expect(message).toContain('Nothing was written to disk')
    expect(message).toContain('a.json')
    expect(message).not.toContain('db.acme-corp.internal')
  })
})
