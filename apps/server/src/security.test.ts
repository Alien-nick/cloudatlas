import { describe, expect, it } from 'vitest'
import { __testing } from './security.js'

const { isLocalHostHeader, isLocalOrigin } = __testing

describe('Host header guard', () => {
  it('accepts loopback hosts with and without a port', () => {
    for (const host of ['127.0.0.1:5174', '127.0.0.1', 'localhost:5173', '[::1]:5174']) {
      expect(isLocalHostHeader(host)).toBe(true)
    }
  })

  it('rejects a rebinding host that resolves to loopback', () => {
    for (const host of ['evil.example.com', 'evil.example.com:5174', '127.0.0.1.evil.com']) {
      expect(isLocalHostHeader(host)).toBe(false)
    }
  })

  it('rejects a missing Host header', () => {
    expect(isLocalHostHeader(undefined)).toBe(false)
  })
})

describe('Origin guard', () => {
  it('allows a missing Origin, which curl and same-origin navigations send', () => {
    expect(isLocalOrigin(undefined)).toBe(true)
  })

  it('allows the Vite dev origin', () => {
    expect(isLocalOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isLocalOrigin('http://localhost:5173')).toBe(true)
  })

  it('rejects remote and opaque origins', () => {
    for (const origin of ['https://evil.example.com', 'null', 'file://', 'not a url']) {
      expect(isLocalOrigin(origin)).toBe(false)
    }
  })

  it('rejects a non-http scheme even on localhost', () => {
    expect(isLocalOrigin('chrome-extension://localhost')).toBe(false)
  })
})
