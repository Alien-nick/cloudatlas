import type { FastifyServerOptions } from 'fastify'

/**
 * Keys whose values must never reach the log. AWS responses and config objects
 * pass close enough to the logger that an explicit redaction list is cheap
 * insurance.
 */
const REDACT_PATHS = [
  'anthropicApiKey',
  '*.anthropicApiKey',
  'ANTHROPIC_API_KEY',
  'accessKeyId',
  '*.accessKeyId',
  'secretAccessKey',
  '*.secretAccessKey',
  'sessionToken',
  '*.sessionToken',
  'password',
  '*.password',
  'req.headers.authorization',
  'req.headers.cookie',
]

/**
 * Pino options handed to Fastify. Letting Fastify construct the logger keeps
 * the instance's generic parameters at their defaults, which matters because
 * route modules take a plain `FastifyInstance`.
 */
export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  const pretty = process.env.NODE_ENV !== 'production'
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  }
}
