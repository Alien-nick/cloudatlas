import { describe, expect, it } from 'vitest'
import { money } from './cost'

describe('money', () => {
  it('keeps cents below $100 and drops them above', () => {
    expect(money(1.6)).toBe('$1.60')
    expect(money(1548.06)).toBe('$1,548')
    expect(money(null)).toBe('—')
    expect(money(-12.5)).toBe('-$12.50')
  })
})
