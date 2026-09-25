import type { FastifyInstance } from 'fastify'

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostnameOf(value: string): string | null {
  // Strip a port, tolerating bracketed IPv6.
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    return close === -1 ? null : value.slice(0, close + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false
  const name = hostnameOf(host)
  return name !== null && LOCAL_HOSTNAMES.has(name)
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true // same-origin navigations and curl send no Origin
  if (origin === 'null') return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return LOCAL_HOSTNAMES.has(url.hostname)
}

/**
 * DNS-rebinding protection. The server binds to 127.0.0.1, but a page on a
 * malicious origin can still resolve its own hostname to 127.0.0.1 and reach
 * us. Pinning Host and Origin to localhost closes that path. There is no auth
 * because there are no secrets in the API surface itself — the credentials
 * stay in the process.
 */
export function registerLocalOnlyGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host
    if (!isLocalHostHeader(host)) {
      await reply.code(403).send({
        error: `Refusing request with non-local Host header: ${host ?? '(missing)'}`,
        missingPermission: null,
        code: 'NON_LOCAL_HOST',
      })
      return reply
    }

    const origin = request.headers.origin
    if (!isLocalOrigin(origin)) {
      await reply.code(403).send({
        error: `Refusing request from non-local Origin: ${origin}`,
        missingPermission: null,
        code: 'NON_LOCAL_ORIGIN',
      })
      return reply
    }
    return undefined
  })
}

export const __testing = { isLocalHostHeader, isLocalOrigin, hostnameOf }
