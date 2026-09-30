/**
 * General ways to save on each AWS service.
 *
 * These are standard AWS cost practices, not findings: the drill-down pages
 * show them under their own heading, apart from the savings found in the
 * scan. Figures are only the ones AWS publishes, stated as "up to".
 */

export interface CostTip {
  title: string
  detail: string
}

const TIPS: Record<string, CostTip[]> = {
  'Amazon Elastic Compute Cloud - Compute': [
    { title: 'Right-size from utilisation', detail: 'Instances averaging low CPU and memory can usually drop a size; each size down roughly halves the hourly rate.' },
    { title: 'Commit with Savings Plans', detail: 'For steady workloads, Compute Savings Plans cut on-demand rates by up to 66% in exchange for a one- or three-year hourly commitment.' },
    { title: 'Use Spot for interruptible work', detail: 'Batch, CI and stateless workers can run on Spot at up to 90% off, if they tolerate a two-minute interruption notice.' },
    { title: 'Stop non-production outside working hours', detail: 'An instance stopped nights and weekends bills compute for about a third of the week. AWS Instance Scheduler automates it.' },
  ],
  'EC2 - Other': [
    { title: 'Delete what is attached to nothing', detail: 'Unattached volumes and old snapshots bill every month. Snapshot what might be needed, then delete.' },
    { title: 'Move gp2 volumes to gp3', detail: 'gp3 is about 20% cheaper per GB and changes online, with no downtime.' },
    { title: 'Keep S3 and DynamoDB traffic off the NAT gateway', detail: 'NAT gateways charge per GB processed. Gateway VPC endpoints for S3 and DynamoDB are free and take that traffic off the NAT.' },
    { title: 'Release unused public IPv4 addresses', detail: 'Every public IPv4 address is billed hourly, attached or not.' },
  ],
  'Amazon Relational Database Service': [
    { title: 'Reserve steady databases', detail: 'Reserved Instances cut the instance rate substantially for one- or three-year terms, and production databases rarely change size.' },
    { title: 'Stop non-production databases when idle', detail: 'An RDS instance can be stopped for up to seven days at a time; storage still bills, the instance does not.' },
    { title: 'Use gp3 storage and Graviton classes', detail: 'gp3 storage and Graviton (db.*g) classes both cost less for the same engine.' },
    { title: 'Clear out old manual snapshots', detail: 'Manual snapshots are kept until deleted and bill per GB, long after anyone needs them.' },
  ],
  'Amazon ElastiCache': [
    { title: 'Reserve steady caches', detail: 'Reserved nodes cost less than on-demand for one- or three-year terms.' },
    { title: 'Use Graviton node types', detail: 'cache.*g node types cost less than their x86 equivalents and run the same engines.' },
    { title: 'Consider Serverless for spiky load', detail: 'ElastiCache Serverless bills for data stored and requests, which suits caches that sit idle much of the day.' },
  ],
  'Amazon Elastic Load Balancing': [
    { title: 'Share one ALB across services', detail: 'Host- and path-based rules let one Application Load Balancer serve many low-traffic services; each ALB bills hourly on its own.' },
    { title: 'Remove load balancers with no targets', detail: 'A load balancer bills by the hour whether or not anything is behind it.' },
  ],
  'Amazon Elastic Container Service': [
    { title: 'Run interruptible tasks on Fargate Spot', detail: 'Fargate Spot is up to 70% cheaper for tasks that can be stopped and restarted.' },
    { title: 'Move tasks to ARM64', detail: 'Fargate on Graviton (ARM64) costs about 20% less per vCPU-hour than x86.' },
    { title: 'Right-size task CPU and memory', detail: 'Fargate bills for what the task definition reserves, not what the container uses.' },
    { title: 'Savings Plans cover Fargate', detail: 'Compute Savings Plans apply to Fargate as well as EC2 and Lambda.' },
  ],
  'Amazon Simple Storage Service': [
    { title: 'Tier data by age', detail: 'Lifecycle rules move data nobody reads to Infrequent Access or Glacier classes, which cost a fraction per GB of Standard.' },
    { title: 'Let Intelligent-Tiering decide', detail: 'For unpredictable access, Intelligent-Tiering moves objects between tiers automatically.' },
    { title: 'Expire old versions and incomplete uploads', detail: 'Noncurrent versions and abandoned multipart uploads bill until a lifecycle rule removes them.' },
  ],
  'Amazon CloudFront': [
    { title: 'Raise the cache hit ratio', detail: 'Longer TTLs and compression mean fewer requests to the origin and fewer bytes served.' },
    { title: 'Choose a price class', detail: 'A narrower price class leaves out the most expensive edge regions if your users are not there.' },
  ],
  'AWS Lambda': [
    { title: 'Run on arm64', detail: 'Lambda bills arm64 duration about 20% lower than x86_64.' },
    { title: 'Tune memory', detail: 'Memory sets both price and CPU; the cheapest setting is often not the smallest. AWS Lambda Power Tuning measures it.' },
  ],
  'Amazon CloudWatch': [
    { title: 'Set log retention', detail: 'Log groups keep data forever by default. A retention period caps storage.' },
    { title: 'Use the Infrequent Access log class', detail: 'For logs rarely queried live, Infrequent Access halves the ingestion price.' },
  ],
  'AWS Network Firewall': [
    { title: 'Count endpoints', detail: 'Each firewall endpoint bills per hour per zone. Non-production VPCs rarely need one in every zone.' },
  ],
  'AWS WAF': [
    { title: 'Remove unused web ACLs and rules', detail: 'Each web ACL and each rule bills monthly whether or not it matches anything.' },
  ],
}

export function tipsFor(service: string | null): CostTip[] {
  return (service && TIPS[service]) || []
}
