import { describe, expect, it } from 'vitest'
import { createSseParser } from './api'

interface Event {
  type: string
  text?: string
}

/** Feed a whole stream one character at a time — the worst-case chunking. */
function byCharacter(stream: string): Event[] {
  const parser = createSseParser<Event>()
  const out: Event[] = []
  for (const character of stream) out.push(...parser.push(character))
  return out
}

describe('SSE frame parsing', () => {
  it('reads complete frames from a single chunk', () => {
    const parser = createSseParser<Event>()
    const events = parser.push(
      'data: {"type":"text","text":"a"}\n\ndata: {"type":"text","text":"b"}\n\n',
    )
    expect(events).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])
  })

  it('holds a partial frame until the rest arrives', () => {
    // A network read has no relationship to a frame boundary. Parsing each
    // chunk in isolation silently drops whatever straddles the split.
    const parser = createSseParser<Event>()
    expect(parser.push('data: {"type":"te')).toEqual([])
    expect(parser.push('xt","text":"split"}')).toEqual([])
    expect(parser.push('\n\n')).toEqual([{ type: 'text', text: 'split' }])
  })

  it('survives being fed one character at a time', () => {
    const stream =
      'data: {"type":"tool","text":"one"}\n\n' +
      'data: {"type":"text","text":"two"}\n\n' +
      'data: {"type":"done"}\n\n'
    expect(byCharacter(stream)).toEqual([
      { type: 'tool', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'done' },
    ])
  })

  it('ignores comment and heartbeat lines', () => {
    // The server opens with ": open" and pings with ": ping" to defeat proxy
    // buffering; neither is an event.
    const parser = createSseParser<Event>()
    expect(parser.push(': open\n\n: ping\n\ndata: {"type":"done"}\n\n')).toEqual([
      { type: 'done' },
    ])
  })

  it('drops one malformed frame without losing the stream', () => {
    const parser = createSseParser<Event>()
    const events = parser.push(
      'data: {not json}\n\ndata: {"type":"text","text":"after"}\n\n',
    )
    expect(events).toEqual([{ type: 'text', text: 'after' }])
  })

  it('does not emit a trailing frame that never terminated', () => {
    // A dropped connection mid-frame must not surface half an event as if it
    // were complete.
    const parser = createSseParser<Event>()
    expect(parser.push('data: {"type":"text","text":"incomplete"}')).toEqual([])
  })

  it('handles several frames arriving in one chunk after a pause', () => {
    const parser = createSseParser<Event>()
    parser.push('data: {"type":"a"}\n')
    expect(parser.push('\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n')).toEqual([
      { type: 'a' },
      { type: 'b' },
      { type: 'c' },
    ])
  })
})
