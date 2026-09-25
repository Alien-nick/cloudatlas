import type { FastifyReply, FastifyRequest } from 'fastify'

export interface SseChannel {
  send(event: unknown): void
  comment(text: string): void
  close(): void
  readonly closed: boolean
  /** Aborts when the client disconnects. */
  readonly signal: AbortSignal
}

/**
 * Open a Server-Sent Events stream on a Fastify reply. Used for scan progress,
 * log tailing and agent streaming — all three are one-way server pushes, which
 * SSE handles with far less machinery than a WebSocket.
 */
export function openSse(request: FastifyRequest, reply: FastifyReply): SseChannel {
  const controller = new AbortController()
  let closed = false

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeat proxy buffering so progress actually streams.
    'X-Accel-Buffering': 'no',
  })
  reply.raw.write(': open\n\n')

  // Keep intermediaries and the browser from idling the connection out.
  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': ping\n\n')
  }, 15_000)

  const finish = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    controller.abort()
    reply.raw.end()
  }

  request.raw.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    controller.abort()
  })

  return {
    send(event: unknown) {
      if (closed) return
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    },
    comment(text: string) {
      if (closed) return
      reply.raw.write(`: ${text}\n\n`)
    },
    close: finish,
    get closed() {
      return closed
    },
    signal: controller.signal,
  }
}
