import { describe, expect, it } from 'vitest'
import { Redactor, __testing } from './redact.js'

const ACCOUNT = '482177301192'

/** Assert a raw value is nowhere in the output, at any depth or key. */
function absent(output: unknown, raw: string): void {
  expect(JSON.stringify(output).toLowerCase()).not.toContain(raw.toLowerCase())
}

function roundTrip<T>(value: T, options?: ConstructorParameters<typeof Redactor>[0]): T {
  const redactor = new Redactor(options)
  return redactor.redactAll([value])[0] as T
}

// ---------------------------------------------------------------------------
// The invariant the whole fixture depends on
// ---------------------------------------------------------------------------

describe('world CIDRs are preserved exactly', () => {
  it('keeps 0.0.0.0/0 byte for byte', () => {
    const out = roundTrip({
      IpPermissions: [
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      ],
    })
    expect(JSON.stringify(out)).toContain('"0.0.0.0/0"')
  })

  it('keeps ::/0 byte for byte', () => {
    const out = roundTrip({ Ipv6Ranges: [{ CidrIpv6: '::/0' }] })
    expect(JSON.stringify(out)).toContain('"::/0"')
  })

  it('keeps them even alongside real public addresses that do get replaced', () => {
    const out = roundTrip({
      rules: [{ CidrIp: '0.0.0.0/0' }, { CidrIp: '52.14.88.201/32' }],
      v6: [{ CidrIpv6: '::/0' }, { CidrIpv6: '2600:1f18:abcd:1234::1' }],
    }) as { rules: Array<{ CidrIp: string }>; v6: Array<{ CidrIpv6: string }> }

    expect(out.rules[0]?.CidrIp).toBe('0.0.0.0/0')
    expect(out.rules[1]?.CidrIp).not.toContain('52.14.88.201')
    expect(out.v6[0]?.CidrIpv6).toBe('::/0')
    expect(out.v6[1]?.CidrIpv6).not.toContain('2600:1f18')
  })

  it('preserves ::1, link-local and unique-local IPv6', () => {
    for (const address of ['::1', 'fe80::1', 'fd00::abcd', 'ff02::1']) {
      expect(__testing.isPreservedIpv6(address)).toBe(true)
    }
  })

  it('does not mistake a timestamp for an IPv6 address', () => {
    const out = roundTrip({ LaunchTime: '2026-09-20T14:02:33.000Z' }) as { LaunchTime: string }
    expect(out.LaunchTime).toBe('2026-09-20T14:02:33.000Z')
    expect(__testing.looksLikeIpv6('14:02:33')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Field classes that pattern matching cannot catch
// ---------------------------------------------------------------------------

describe('names, not IDs', () => {
  it('redacts an S3 bucket name and its appearance inside an ARN', () => {
    const out = roundTrip({
      Buckets: [{ Name: 'acmecorp-prod-patient-uploads' }],
      policy: 'arn:aws:s3:::acmecorp-prod-patient-uploads/*',
    })
    absent(out, 'acmecorp-prod-patient-uploads')
  })

  it('redacts Route 53 hosted zone and record names', () => {
    const out = roundTrip({
      HostedZones: [{ Name: 'cortex.health.gov.gy.' }],
      ResourceRecordSets: [{ Name: 'api.cortex.health.gov.gy.' }],
    })
    absent(out, 'cortex.health.gov.gy')
  })

  it('redacts endpoint DNS names for RDS, ElastiCache, ALB and CloudFront', () => {
    const out = roundTrip({
      rds: { Endpoint: { Address: 'prod-pg.c9xk2.us-east-1.rds.amazonaws.com', Port: 5432 } },
      cache: { ConfigurationEndpoint: { Address: 'cortex-cache.9xk2.use1.cache.amazonaws.com' } },
      alb: { DNSName: 'api-alb-1932741.us-east-1.elb.amazonaws.com' },
      cf: { DomainName: 'd2f9k1x.cloudfront.net' },
    })
    absent(out, 'prod-pg.c9xk2')
    absent(out, 'cortex-cache.9xk2')
    absent(out, 'api-alb-1932741')
    absent(out, 'd2f9k1x')
    // The port is topology-bearing and must survive.
    expect(JSON.stringify(out)).toContain('5432')
  })

  it('redacts security group rule descriptions, the highest-risk free text', () => {
    const out = roundTrip({
      SecurityGroups: [
        {
          GroupId: 'sg-0e91aa30',
          Description: 'Legacy jump box for Dr Singh, ticket OPS-4412',
          IpPermissions: [
            {
              IpRanges: [
                { CidrIp: '0.0.0.0/0', Description: 'opened for vendor NetScope on 2024-03-02' },
              ],
            },
          ],
        },
      ],
    })
    absent(out, 'Dr Singh')
    absent(out, 'OPS-4412')
    absent(out, 'NetScope')
    // ...while the rule itself still reads as world-open.
    expect(JSON.stringify(out)).toContain('"0.0.0.0/0"')
  })

  it('redacts IAM role, instance profile and KMS alias names', () => {
    const out = roundTrip({
      instance: {
        IamInstanceProfile: {
          Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/acmecorp-legacy-worker`,
        },
      },
      task: {
        taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/acmecorp-api-task`,
        executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/ecsTaskExecutionRole`,
      },
      kms: { AliasName: 'alias/acmecorp-patient-data' },
    })
    absent(out, 'acmecorp-legacy-worker')
    absent(out, 'acmecorp-api-task')
    absent(out, 'acmecorp-patient-data')
  })

  it('redacts CloudWatch log group names, including the awslogs driver option', () => {
    const out = roundTrip({
      containerDefinitions: [
        {
          logConfiguration: {
            logDriver: 'awslogs',
            options: { 'awslogs-group': '/ecs/acmecorp-api', 'awslogs-region': 'us-east-1' },
          },
        },
      ],
      logGroupName: '/aws/lambda/acmecorp-intake',
    })
    absent(out, 'acmecorp-api')
    absent(out, 'acmecorp-intake')
    // The region is not sensitive and drives placement.
    expect(JSON.stringify(out)).toContain('us-east-1')
  })

  it('redacts env var names as well as values', () => {
    const out = roundTrip({
      containerDefinitions: [
        {
          environment: [
            { name: 'ACMECORP_DB_PASSWORD', value: 'hunter2' },
            { name: 'LOG_LEVEL', value: 'info' },
          ],
          secrets: [{ name: 'API_KEY', valueFrom: 'arn:aws:secretsmanager:...' }],
        },
      ],
    }) as {
      containerDefinitions: Array<{ environment: Array<{ name: string; value: string }> }>
    }

    absent(out, 'ACMECORP_DB_PASSWORD')
    absent(out, 'hunter2')
    const env = out.containerDefinitions[0]?.environment ?? []
    expect(env.every((e) => e.value === 'REDACTED')).toBe(true)
    expect(env.every((e) => /^ENV_VAR_\d+$/.test(e.name))).toBe(true)
  })

  it('redacts AMI names and descriptions, DB names and cluster identifiers', () => {
    const out = roundTrip({
      Images: [{ Name: 'acmecorp-hardened-al2023', Description: 'CIS baseline, built by infra' }],
      db: { DBName: 'patients', DBClusterIdentifier: 'acmecorp-prod-cluster' },
      ecs: { ClusterName: 'acmecorp-prod' },
    })
    absent(out, 'acmecorp-hardened-al2023')
    absent(out, 'CIS baseline')
    absent(out, 'acmecorp-prod-cluster')
  })

  it('redacts public IPv4, IPv6 and elastic IPs', () => {
    const out = roundTrip({
      PublicIp: '52.14.88.201',
      Ipv6Address: '2600:1f18:abcd:1234::1',
      NatGatewayAddresses: [{ PublicIp: '52.14.90.77', PrivateIp: '10.0.2.9' }],
    }) as { NatGatewayAddresses: Array<{ PublicIp: string; PrivateIp: string }> }

    absent(out, '52.14.88.201')
    absent(out, '2600:1f18')
    absent(out, '52.14.90.77')
    // Private addresses carry topology and stay.
    expect(out.NatGatewayAddresses[0]?.PrivateIp).toBe('10.0.2.9')
  })
})

// ---------------------------------------------------------------------------
// Recorded AccessDenied errors — the payload the deny gate exists to catch
// ---------------------------------------------------------------------------

describe('AccessDenied error messages', () => {
  const message = (svc: string, resource: string) =>
    `User: arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_PlatformEng_9f2c/nseetaram@health.gov.gy` +
    ` is not authorized to perform: ${svc} on resource: ${resource}`

  it('strips the principal role name, session name and email', () => {
    const out = roundTrip({
      error: {
        name: 'AccessDenied',
        message: message(
          'elasticache:DescribeCacheClusters',
          `arn:aws:elasticache:us-east-1:${ACCOUNT}:cluster:cortex-cache-001`,
        ),
      },
    })
    absent(out, 'AWSReservedSSO_PlatformEng_9f2c')
    absent(out, 'nseetaram')
    absent(out, 'health.gov.gy')
    absent(out, ACCOUNT)
  })

  it('strips the target resource name from the ARN tail', () => {
    const out = roundTrip({
      error: {
        name: 'AccessDenied',
        message: message(
          'elasticloadbalancing:DescribeTargetHealth',
          `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:targetgroup/tg-cortex-api/9d2c4f1a`,
        ),
      },
    })
    absent(out, 'tg-cortex-api')
  })

  it('keeps the action name, which is what the UI notice needs', () => {
    const out = roundTrip({
      error: { name: 'AccessDenied', message: message('elasticache:DescribeCacheClusters', 'x') },
    }) as { error: { message: string } }
    expect(out.error.message).toContain('elasticache:DescribeCacheClusters')
    expect(out.error.message).toContain('is not authorized to perform')
  })

  it('keeps the principal type so a role is still distinguishable from a user', () => {
    const out = roundTrip({
      error: { name: 'AccessDenied', message: `User: arn:aws:iam::${ACCOUNT}:user/ops-nseetaram x` },
    }) as { error: { message: string } }
    expect(out.error.message).toContain('user/')
    absent(out, 'ops-nseetaram')
  })

  it('redacts a standalone email anywhere, not only inside a principal path', () => {
    const out = roundTrip({ Owner: 'someone@health.gov.gy' })
    absent(out, 'someone@health.gov.gy')
  })

  it('redacts AROA-style principal ids', () => {
    const out = roundTrip({ UserId: 'AROA4EXAMPLEID12345:session-name' })
    absent(out, 'AROA4EXAMPLEID12345')
  })
})

describe('ARNs with an empty region or account field', () => {
  // Every ARN shape that contains a `::` and could therefore collide with the
  // IPv6 matcher. The original bug was only ever exercised against `sts::`.

  it('survives an empty account field: arn:aws:sts::<account>:', () => {
    const out = roundTrip({ Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/R/s` }) as { Arn: string }
    expect(out.Arn.startsWith('arn:aws:sts::')).toBe(true)
    expect(out.Arn).not.toContain('2001:db8')
  })

  it('survives three consecutive colons: arn:aws:s3:::bucket-name', () => {
    const out = roundTrip({ policy: 'arn:aws:s3:::bucket-name/*' }) as { policy: string }
    expect(out.policy.startsWith('arn:aws:s3:::')).toBe(true)
    expect(out.policy).not.toContain('2001:db8')
    expect(out.policy.endsWith('/*')).toBe(true)
  })

  it('survives an empty region: arn:aws:iam::123456789012:role/x', () => {
    const out = roundTrip({ a: `arn:aws:iam::${ACCOUNT}:role/cortex-api-task` }) as { a: string }
    expect(out.a.startsWith('arn:aws:iam::')).toBe(true)
    expect(out.a).toContain(':role/')
    expect(out.a).not.toContain('2001:db8')
    absent(out, 'cortex-api-task')
  })

  it('control: a fully populated ARN is unaffected', () => {
    const out = roundTrip({ a: `arn:aws:sns:us-east-1:${ACCOUNT}:alerts-topic` }) as { a: string }
    expect(out.a.startsWith('arn:aws:sns:us-east-1:')).toBe(true)
    expect(out.a).not.toContain('2001:db8')
    expect(out.a).not.toContain(ACCOUNT)
  })

  it('leaves a global-service ARN with an empty region intact', () => {
    const out = roundTrip({ a: 'arn:aws:ec2:us-east-1::image/ami-0c94b1d2ab' }) as { a: string }
    expect(out.a.startsWith('arn:aws:ec2:us-east-1::image/ami-')).toBe(true)
  })

  it('still replaces a genuine IPv6 address in the same payload', () => {
    const out = roundTrip({
      Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/R/s`,
      Ipv6Address: '2600:1f18:abcd:1234::1',
    }) as { Arn: string; Ipv6Address: string }
    expect(out.Arn.startsWith('arn:aws:sts::')).toBe(true)
    expect(out.Ipv6Address).not.toContain('2600:1f18')
  })

  it('replaces a fully spelled out IPv6 address', () => {
    const out = roundTrip({ a: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' }) as { a: string }
    expect(out.a).not.toContain('8a2e')
  })
})

// ---------------------------------------------------------------------------
// The two-pass property: names hidden inside other strings
// ---------------------------------------------------------------------------

describe('learned literals', () => {
  it('replaces a load balancer name inside its own ARN', () => {
    // Single-pass component substitution misses this: "api-alb" matches no
    // resource-id or hostname pattern, so it would survive inside the ARN.
    const out = roundTrip({
      LoadBalancers: [
        {
          LoadBalancerName: 'acmecorp-api-alb',
          LoadBalancerArn: `arn:aws:elasticloadbalancing:us-east-1:${ACCOUNT}:loadbalancer/app/acmecorp-api-alb/50dc6c49`,
        },
      ],
    })
    absent(out, 'acmecorp-api-alb')
  })

  it('keeps the name and its embedded form consistent', () => {
    const out = roundTrip({
      LoadBalancerName: 'acmecorp-api-alb',
      arn: 'arn:aws:elb:us-east-1:1:loadbalancer/app/acmecorp-api-alb/50dc',
    }) as { LoadBalancerName: string; arn: string }
    expect(out.arn).toContain(out.LoadBalancerName)
  })

  it('replaces a database identifier wherever it appears', () => {
    const out = roundTrip({
      DBInstanceIdentifier: 'acmecorp-pg-primary',
      replica: { ReadReplicaSourceDBInstanceIdentifier: 'acmecorp-pg-primary' },
      note: 'failover target for acmecorp-pg-primary',
    }) as { DBInstanceIdentifier: string; replica: { ReadReplicaSourceDBInstanceIdentifier: string } }

    absent(out, 'acmecorp-pg-primary')
    // Cross-reference still resolves, which is what the replay check depends on.
    expect(out.replica.ReadReplicaSourceDBInstanceIdentifier).toBe(out.DBInstanceIdentifier)
  })

  it('replaces the longest match first so prefixes are not mangled', () => {
    const out = roundTrip({
      a: { DBInstanceIdentifier: 'acmecorp-pg' },
      b: { DBInstanceIdentifier: 'acmecorp-pg-primary' },
    }) as { a: { DBInstanceIdentifier: string }; b: { DBInstanceIdentifier: string } }

    expect(out.a.DBInstanceIdentifier).not.toBe(out.b.DBInstanceIdentifier)
    absent(out, 'acmecorp-pg-primary')
  })

  it('leaves generic AWS words alone', () => {
    const out = roundTrip({
      SecurityGroups: [{ GroupName: 'default' }],
      state: 'available',
      scheme: 'internet-facing',
    })
    const text = JSON.stringify(out)
    expect(text).toContain('available')
    expect(text).toContain('internet-facing')
  })
})

// ---------------------------------------------------------------------------
// Identifiers and referential integrity (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('identifiers', () => {
  it('replaces the account id everywhere, consistently', () => {
    const out = roundTrip({
      arn: `arn:aws:rds:us-east-1:${ACCOUNT}:db:x`,
      owner: ACCOUNT,
    }) as { arn: string; owner: string }
    absent(out, ACCOUNT)
    expect(out.arn).toContain(out.owner)
  })

  it('maps a resource id to the same fake standalone and inside an ARN', () => {
    const out = roundTrip({
      VpcId: 'vpc-0a91c2ff',
      arn: `arn:aws:ec2:us-east-1:${ACCOUNT}:vpc/vpc-0a91c2ff`,
    }) as { VpcId: string; arn: string }
    expect(out.VpcId).toMatch(/^vpc-[0-9a-f]+$/)
    expect(out.arn).toContain(out.VpcId)
  })

  it('preserves resource-id prefixes so type detection still works', () => {
    const out = roundTrip({
      a: 'i-0af22c9e13b7d4410',
      b: 'sg-0e91aa30',
      c: 'subnet-0c11aabb',
    }) as Record<string, string>
    expect(out.a?.startsWith('i-')).toBe(true)
    expect(out.b?.startsWith('sg-')).toBe(true)
    expect(out.c?.startsWith('subnet-')).toBe(true)
  })

  it('rewrites pagination tokens consistently so replay still chains', () => {
    const r = new Redactor()
    const [a, b] = r.redactAll([{ NextToken: 'AAAAB3Nz' }, { NextToken: 'AAAAB3Nz' }]) as Array<{
      NextToken: string
    }>
    expect(a?.NextToken).toBe(b?.NextToken)
    expect(a?.NextToken).not.toContain('AAAAB3')
  })

  it('does not derive the fake from the original value', () => {
    const c = new Redactor()
    c.redactAll([{ first: '8.8.8.8' }])
    const out = c.redactAll([{ x: '52.14.88.201' }])[0] as { x: string }
    // Encounter-ordered, so this gets slot 2 — a hash would be position-independent.
    expect(out.x).toBe('203.0.113.2')
  })
})

// ---------------------------------------------------------------------------
// Tag policy
// ---------------------------------------------------------------------------

describe('tag policy', () => {
  const tagged = {
    Tags: [
      { Key: 'Name', Value: 'legacy-worker' },
      { Key: 'Environment', Value: 'prod' },
      { Key: 'Owner', Value: 'dr.singh@health.gov.gy' },
    ],
  }

  it('keeps the Name tag by default so fixtures stay readable', () => {
    const out = roundTrip(tagged) as typeof tagged
    expect(out.Tags[0]?.Value).toBe('legacy-worker')
  })

  it('redacts every other tag value by default', () => {
    const out = roundTrip(tagged) as typeof tagged
    expect(out.Tags[1]?.Value).not.toBe('prod')
    absent({ t: out.Tags[2] }, 'dr.singh@health.gov.gy')
  })

  it('keeps additional keys passed with --keep-tag', () => {
    const out = roundTrip(tagged, { keepTagKeys: ['Environment'] }) as typeof tagged
    expect(out.Tags[1]?.Value).toBe('prod')
  })

  it('redacts everything including Name under --keep-no-tags', () => {
    const out = roundTrip(tagged, { keepNoTags: true }) as typeof tagged
    expect(out.Tags[0]?.Value).not.toBe('legacy-worker')
    expect(out.Tags[1]?.Value).not.toBe('prod')
  })

  it('always keeps tag keys, which the filters depend on', () => {
    const out = roundTrip(tagged, { keepNoTags: true }) as typeof tagged
    expect(out.Tags.map((t) => t.Key)).toEqual(['Name', 'Environment', 'Owner'])
  })

  it('reports which tag keys were kept', () => {
    const r = new Redactor({ keepTagKeys: ['Environment'] })
    r.redactAll([tagged])
    expect(r.summary().keptTagKeys.sort()).toEqual(['Environment', 'Name'])

    const strict = new Redactor({ keepNoTags: true })
    strict.redactAll([tagged])
    expect(strict.summary().keptTagKeys).toEqual([])
  })
})

describe('non-identifying values survive', () => {
  it('keeps the fields relationship builders and detection rely on', () => {
    const input = {
      InstanceType: 'm6i.xlarge',
      State: { Name: 'running', Code: 16 },
      Engine: 'postgres',
      EngineVersion: '15.4',
      AvailabilityZone: 'us-east-1a',
      FromPort: 22,
      ToPort: 22,
      IpProtocol: 'tcp',
      MultiAZ: true,
      StorageEncrypted: true,
      PubliclyAccessible: false,
      CidrBlock: '10.0.0.0/16',
    }
    expect(roundTrip(input)).toEqual(input)
  })

  it('reports what it replaced, by class', () => {
    const r = new Redactor()
    r.redactAll([
      { owner: ACCOUNT, VpcId: 'vpc-0a91c2ff', PublicIp: '52.14.88.201', Description: 'x y z' },
    ])
    const summary = r.summary().replaced
    expect(summary.accountId).toBe(1)
    expect(summary.resourceId).toBe(1)
    expect(summary.publicIp).toBe(1)
    expect(summary.description).toBe(1)
  })
})
