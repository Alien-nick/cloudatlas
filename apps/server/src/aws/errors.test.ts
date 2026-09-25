import { describe, expect, it } from 'vitest'
import { isAccessDenied, isRegionUnavailable, isThrottle } from './errors.js'

function awsError(name: string, message = 'boom', code?: string): Error {
  const error = new Error(message)
  error.name = name
  if (code) Object.assign(error, { Code: code })
  return error
}

describe('isAccessDenied', () => {
  /**
   * Services do not agree on how to phrase this, and a missed match turns a
   * recoverable "missing permission" notice into a failed scan. These are the
   * shapes the M2 collectors can actually encounter.
   */
  it('recognises the error code each service uses', () => {
    expect(isAccessDenied(awsError('UnauthorizedOperation'))).toBe(true) // EC2
    expect(isAccessDenied(awsError('AccessDeniedException'))).toBe(true) // ECS
    expect(isAccessDenied(awsError('AccessDenied'))).toBe(true) // ELB, RDS, CW
    expect(isAccessDenied(awsError('AccessDeniedFault'))).toBe(true) // ElastiCache
    expect(isAccessDenied(awsError('AuthFailure'))).toBe(true)
    expect(isAccessDenied(awsError('NotAuthorizedException'))).toBe(true)
  })

  it('recognises a code carried on the Code property rather than the name', () => {
    expect(isAccessDenied(awsError('ElastiCacheServiceException', 'x', 'AccessDenied'))).toBe(true)
  })

  it('recognises the prose when the code is unhelpful', () => {
    const cases = [
      'User: arn:aws:iam::1:user/x is not authorized to perform: rds:DescribeDBInstances',
      'You are not authorized to perform this operation.',
      'Access Denied',
      'AccessDenied',
      'User is not authorized to access this resource',
      'because no identity-based policy allows the action',
      'with an explicit deny in a service control policy',
    ]
    for (const message of cases) {
      expect(isAccessDenied(awsError('SomeServiceException', message)), message).toBe(true)
    }
  })

  it('does not fire on unrelated failures', () => {
    for (const message of [
      'Rate exceeded',
      'The instance ID i-123 does not exist',
      'Could not connect to the endpoint URL',
      'The security token included in the request is invalid',
    ]) {
      expect(isAccessDenied(awsError('SomeServiceException', message)), message).toBe(false)
    }
  })

  it('ignores non-Error values', () => {
    expect(isAccessDenied('AccessDenied')).toBe(false)
    expect(isAccessDenied(null)).toBe(false)
  })
})

describe('isThrottle', () => {
  it('recognises the throttling codes across services', () => {
    for (const name of [
      'Throttling',
      'ThrottlingException',
      'RequestLimitExceeded',
      'TooManyRequestsException',
      'SlowDown',
    ]) {
      expect(isThrottle(awsError(name)), name).toBe(true)
    }
  })

  it('does not confuse a throttle with a denial', () => {
    expect(isThrottle(awsError('AccessDenied'))).toBe(false)
    expect(isAccessDenied(awsError('ThrottlingException'))).toBe(false)
  })
})

describe('isRegionUnavailable', () => {
  it('recognises a region the account has not opted into', () => {
    expect(isRegionUnavailable(awsError('OptInRequired'))).toBe(true)
    expect(isRegionUnavailable(awsError('UnrecognizedClientException'))).toBe(true)
  })
})
