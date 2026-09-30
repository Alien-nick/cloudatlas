import {
  catalogEntry,
  type Fix,
  type Graph,
  type GraphNode,
  type SettingValue,
  type SimResource,
  type Simulated,
  type SimulationExport,
} from '@cloudatlas/shared'
import { q, withInputFlag } from '../aws/cli-command.js'
import { openPorts, settingsOf } from './apply.js'

/**
 * Turning a simulation into something that builds it: an AWS CLI script or
 * Terraform. Both are text for the user to review and run — CloudAtlas never
 * does either, and cannot: it holds no write permission.
 *
 * New resources get their ids at creation, so the script captures each one in
 * a shell variable and later commands use it; the Terraform uses references.
 * Existing resources are addressed by their real ids. Values only the user
 * knows — an AMI, a certificate, an IAM role — stay visible `<placeholders>`,
 * and no secret is ever written: databases use RDS-managed master passwords.
 */

type Settings = Record<string, SettingValue>

const bool = (value: SettingValue | undefined): boolean => value === true || value === 'true'
const str = (value: SettingValue | undefined, fallback = ''): string => (value === undefined ? fallback : String(value))
const num = (value: SettingValue | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'resource'
}

interface Context {
  graph: Graph
  base: Graph
  simulated: Simulated
  profile: string
  /** Shell variable (CLI) or Terraform reference for each added resource's id. */
  ids: Map<string, { shell: string; tf: string }>
}

function nodeOf(context: Context, id: string): GraphNode | undefined {
  return context.graph.nodes.find((node) => node.id === id) ?? context.base.nodes.find((node) => node.id === id)
}

/** How a command refers to a resource: `$VAR` for a planned one, its real id otherwise. */
function shellRef(context: Context, id: string | null): string {
  if (!id) return '<none>'
  const planned = context.ids.get(id)
  return planned ? `"$${planned.shell}"` : q(id)
}

function sgShellRef(context: Context, nodeId: string): string {
  const planned = context.ids.get(nodeId)
  if (planned) return `"$${planned.shell}_SG"`
  const sg = nodeOf(context, nodeId)?.securityGroupIds[0]
  return sg ? q(sg) : '<security-group-id>'
}

function cli(context: Context, region: string, command: string): string {
  return `aws ${command} --region ${q(region)} --profile ${q(context.profile)}`
}

function tags(name: string, type: string, settings: Settings): string {
  const env = settings.environment ? `,{Key=Environment,Value=${settings.environment}}` : ''
  return `--tag-specifications ${q(`ResourceType=${type},Tags=[{Key=Name,Value=${name}}${env}]`)}`
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function createCommands(context: Context, resource: SimResource, s: Settings): Omit<Fix, 'needsInput'> {
  const region = resource.region
  const id = context.ids.get(resource.id)!.shell
  const run = (command: string) => cli(context, region, command)
  const capture = (variable: string, command: string, query: string) => `${variable}=$(${run(`${command} --query ${q(query)} --output text`)})`
  const vpc = shellRef(context, resource.vpcId)
  const subnet = shellRef(context, resource.subnetId)
  const commands: string[] = []
  let caution: string | null = null

  const securityGroup = (): void => {
    commands.push(
      capture(`${id}_SG`, `ec2 create-security-group --group-name ${q(`${resource.name}-sg`)} --description ${q(`${resource.name} (planned in CloudAtlas)`)} --vpc-id ${vpc}`, 'GroupId'),
    )
    const world = resource.type === 'alb' && s.scheme === 'internet-facing' ? [443, 80] : openPorts(s)
    for (const port of world) {
      commands.push(run(`ec2 authorize-security-group-ingress --group-id "$${id}_SG" --protocol tcp --port ${port} --cidr 0.0.0.0/0`))
    }
  }

  switch (resource.type) {
    case 'vpc':
      commands.push(capture(id, `ec2 create-vpc --cidr-block ${q(str(s.cidr))} ${tags(resource.name, 'vpc', s)}`, 'Vpc.VpcId'))
      if (bool(s.flowLogs)) {
        commands.push(run(`ec2 create-flow-logs --resource-type VPC --resource-ids "$${id}" --traffic-type ALL --log-destination-type s3 --log-destination arn:aws:s3:::<log-bucket-name>`))
      }
      break
    case 'subnet': {
      const az = `${region}${str(s.az, 'a')}`
      commands.push(capture(id, `ec2 create-subnet --vpc-id ${vpc} --cidr-block ${q(str(s.cidr))} --availability-zone ${q(az)} ${tags(resource.name, 'subnet', s)}`, 'Subnet.SubnetId'))
      if (bool(s.autoPublicIp)) commands.push(run(`ec2 modify-subnet-attribute --subnet-id "$${id}" --map-public-ip-on-launch`))
      if (bool(s.public)) {
        commands.push(run(`ec2 associate-route-table --route-table-id <public-route-table-id> --subnet-id "$${id}"`))
        caution = 'A public subnet needs a route table with 0.0.0.0/0 to an internet gateway; use the VPC’s existing public route table.'
      }
      break
    }
    case 'ec2': {
      securityGroup()
      const disk = JSON.stringify([
        { DeviceName: '/dev/xvda', Ebs: { VolumeSize: num(s.volumeGiB, 30), VolumeType: str(s.volumeType, 'gp3'), Encrypted: bool(s.encrypted) } },
      ])
      commands.push(
        capture(
          id,
          `ec2 run-instances --image-id <ami-id> --instance-type ${q(str(s.instanceType))} --subnet-id ${subnet} --security-group-ids "$${id}_SG" ` +
            `--metadata-options ${bool(s.imdsv2) ? 'HttpTokens=required' : 'HttpTokens=optional'},HttpEndpoint=enabled ` +
            `--block-device-mappings ${q(disk)} ${bool(s.publicIp) ? '--associate-public-ip-address' : '--no-associate-public-ip-address'} ${tags(resource.name, 'instance', s)}`,
          'Instances[0].InstanceId',
        ),
      )
      caution = 'Choose an AMI for the architecture of the instance type (arm64 for Graviton types such as t4g and m7g).'
      break
    }
    case 'rds': {
      securityGroup()
      const logs = { postgres: '["postgresql","upgrade"]', mysql: '["error","general","slowquery"]', mariadb: '["error","general","slowquery"]' }[str(s.engine, 'postgres')] ?? '["error"]'
      commands.push(
        run(`rds create-db-subnet-group --db-subnet-group-name ${q(`${resource.name}-subnets`)} --db-subnet-group-description ${q(`${resource.name} subnets`)} --subnet-ids ${subnet} <second-private-subnet-id-in-another-az>`),
        run(
          `rds create-db-instance --db-instance-identifier ${q(resource.name)} --engine ${q(str(s.engine, 'postgres'))} --db-instance-class ${q(str(s.instanceClass))} ` +
            `--allocated-storage ${num(s.storageGiB, 100)} --storage-type ${q(str(s.storageType, 'gp3'))} ` +
            `${bool(s.multiAz) ? '--multi-az' : '--no-multi-az'} ${bool(s.encrypted) ? '--storage-encrypted' : '--no-storage-encrypted'} ` +
            `${bool(s.publiclyAccessible) ? '--publicly-accessible' : '--no-publicly-accessible'} --backup-retention-period ${num(s.backupDays, 7)} ` +
            `${bool(s.deletionProtection) ? '--deletion-protection' : '--no-deletion-protection'} ` +
            `${bool(s.logExports) ? `--enable-cloudwatch-logs-exports ${q(logs)} ` : ''}` +
            `--master-username dbadmin --manage-master-user-password --vpc-security-group-ids "$${id}_SG" --db-subnet-group-name ${q(`${resource.name}-subnets`)}`,
        ),
      )
      caution = 'RDS needs subnets in two zones even for Single-AZ. The master password is generated and kept in Secrets Manager; none is written here.'
      break
    }
    case 'elasticache':
      securityGroup()
      commands.push(
        run(`elasticache create-cache-subnet-group --cache-subnet-group-name ${q(`${resource.name}-subnets`)} --cache-subnet-group-description ${q(resource.name)} --subnet-ids ${subnet}`),
        run(
          `elasticache create-replication-group --replication-group-id ${q(resource.name)} --replication-group-description ${q(resource.name)} --engine redis ` +
            `--cache-node-type ${q(str(s.nodeType))} --num-cache-clusters ${num(s.nodes, 1)} ` +
            `${bool(s.encryptionAtRest) ? '--at-rest-encryption-enabled' : ''} ${bool(s.encryptionInTransit) ? '--transit-encryption-enabled' : ''} ` +
            `--security-group-ids "$${id}_SG" --cache-subnet-group-name ${q(`${resource.name}-subnets`)}`.replace(/ {2,}/g, ' '),
        ),
      )
      break
    case 'alb':
      securityGroup()
      commands.push(
        capture(
          id,
          `elbv2 create-load-balancer --name ${q(resource.name)} --type application --scheme ${q(str(s.scheme, 'internet-facing'))} --subnets ${subnet} <second-subnet-id-in-another-az> --security-groups "$${id}_SG"`,
          'LoadBalancers[0].LoadBalancerArn',
        ),
        capture(`${id}_TG`, `elbv2 create-target-group --name ${q(`${resource.name}-tg`.slice(0, 32))} --protocol HTTP --port 80 --vpc-id ${vpc} --target-type ip`, 'TargetGroups[0].TargetGroupArn'),
      )
      if (bool(s.httpsOnly)) {
        commands.push(
          run(`elbv2 create-listener --load-balancer-arn "$${id}" --protocol HTTPS --port 443 --certificates CertificateArn=<acm-certificate-arn> --default-actions Type=forward,TargetGroupArn="$${id}_TG"`),
          run(`elbv2 create-listener --load-balancer-arn "$${id}" --protocol HTTP --port 80 --default-actions ${q(JSON.stringify([{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }]))}`),
        )
      } else {
        commands.push(run(`elbv2 create-listener --load-balancer-arn "$${id}" --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn="$${id}_TG"`))
      }
      if (bool(s.waf)) commands.push(run(`wafv2 associate-web-acl --web-acl-arn <regional-web-acl-arn> --resource-arn "$${id}"`))
      caution = 'A load balancer needs subnets in at least two zones. Register targets in the target group once they exist.'
      break
    case 'nat-gateway':
      commands.push(
        capture(`${id}_EIP`, 'ec2 allocate-address --domain vpc', 'AllocationId'),
        capture(id, `ec2 create-nat-gateway --subnet-id ${subnet} --allocation-id "$${id}_EIP" ${tags(resource.name, 'natgateway', s)}`, 'NatGateway.NatGatewayId'),
      )
      caution = 'Point the private subnets’ route tables at the new gateway (0.0.0.0/0) once it is available.'
      break
    case 'ecs-task': {
      securityGroup()
      const network = `awsvpcConfiguration={subnets=[${subnet.replace(/"/g, '')}],securityGroups=[$${id}_SG],assignPublicIp=DISABLED}`
      commands.push(
        run(
          `ecs create-service --cluster <cluster-name> --service-name ${q(resource.name)} --task-definition <task-definition:revision> --launch-type FARGATE --desired-count 1 --network-configuration "${network}"`,
        ),
      )
      caution = `Register a task definition with cpu ${Math.round(num(s.vcpu, 0.5) * 1024)} and memory ${Math.round(num(s.memoryGB, 1) * 1024)} first.`
      break
    }
    case 'lambda':
      commands.push(
        run(
          `lambda create-function --function-name ${q(resource.name)} --runtime ${q(str(s.runtime))} --architectures ${q(str(s.architecture, 'arm64'))} ` +
            `--memory-size ${num(s.memoryMB, 512)} --role <execution-role-arn> --handler <handler> --zip-file fileb://<package.zip>`,
        ),
      )
      break
    case 's3':
      commands.push(
        run(`s3api create-bucket --bucket ${q(resource.name)}${region === 'us-east-1' ? '' : ` --create-bucket-configuration LocationConstraint=${region}`}`),
        run(
          `s3api put-bucket-encryption --bucket ${q(resource.name)} --server-side-encryption-configuration ${q(JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: str(s.encryption, 'aws:kms') } }] }))}`,
        ),
      )
      if (bool(s.blockPublic)) {
        commands.push(
          run(`s3api put-public-access-block --bucket ${q(resource.name)} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`),
        )
      }
      caution = 'Bucket names are global: if this one is taken, pick another and update later references.'
      break
    case 'sqs':
      commands.push(run(`sqs create-queue --queue-name ${q(resource.name)}${bool(s.encrypted) ? ' --attributes SqsManagedSseEnabled=true' : ''}`))
      break
  }
  return { commands, caution }
}

/** Commands that move an existing resource from its snapshot settings to the simulated ones. */
function updateCommands(context: Context, node: GraphNode, before: Settings, after: Settings): Omit<Fix, 'needsInput'> | null {
  const changed = (key: string): boolean => before[key] !== after[key] && after[key] !== undefined
  const run = (command: string) => cli(context, node.region === 'global' ? 'us-east-1' : node.region, command)
  const commands: string[] = []
  let caution: string | null = null

  if (node.type === 'rds') {
    const flags: string[] = []
    if (changed('instanceClass')) flags.push(`--db-instance-class ${q(str(after.instanceClass))}`)
    if (changed('multiAz')) flags.push(bool(after.multiAz) ? '--multi-az' : '--no-multi-az')
    if (changed('storageType')) flags.push(`--storage-type ${q(str(after.storageType))}`)
    if (changed('storageGiB')) flags.push(`--allocated-storage ${num(after.storageGiB, 100)}`)
    if (changed('publiclyAccessible')) flags.push(bool(after.publiclyAccessible) ? '--publicly-accessible' : '--no-publicly-accessible')
    if (changed('backupDays')) flags.push(`--backup-retention-period ${num(after.backupDays, 7)}`)
    if (changed('deletionProtection')) flags.push(bool(after.deletionProtection) ? '--deletion-protection' : '--no-deletion-protection')
    if (flags.length) commands.push(run(`rds modify-db-instance --db-instance-identifier ${q(node.name)} ${flags.join(' ')}`))
    if (changed('encrypted')) caution = 'Encryption cannot be changed in place: it needs a snapshot, an encrypted copy and a restore.'
    else if (flags.length) caution = 'Applied in the next maintenance window; add --apply-immediately to apply now (with a restart for class changes).'
  } else if (node.type === 'ec2') {
    const id = node.props.find((p) => p.k === 'Instance ID')?.v ?? node.id
    if (changed('imdsv2')) commands.push(run(`ec2 modify-instance-metadata-options --instance-id ${q(id)} --http-tokens ${bool(after.imdsv2) ? 'required' : 'optional'}`))
    if (changed('instanceType')) {
      commands.push(
        run(`ec2 stop-instances --instance-ids ${q(id)}`),
        run(`ec2 wait instance-stopped --instance-ids ${q(id)}`),
        run(`ec2 modify-instance-attribute --instance-id ${q(id)} --instance-type ${q(JSON.stringify({ Value: str(after.instanceType) }))}`),
        run(`ec2 start-instances --instance-ids ${q(id)}`),
      )
      caution = 'Changing the type stops the instance briefly.'
    }
  } else if (node.type === 'subnet') {
    if (changed('autoPublicIp')) commands.push(run(`ec2 modify-subnet-attribute --subnet-id ${q(node.id)} ${bool(after.autoPublicIp) ? '--map-public-ip-on-launch' : '--no-map-public-ip-on-launch'}`))
  } else if (node.type === 's3') {
    if (changed('blockPublic') && bool(after.blockPublic)) {
      commands.push(run(`s3api put-public-access-block --bucket ${q(node.name)} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`))
    }
  } else if (node.type === 'sqs') {
    if (changed('encrypted') && bool(after.encrypted)) commands.push(run(`sqs set-queue-attributes --queue-url "$(${run(`sqs get-queue-url --queue-name ${q(node.name)} --query QueueUrl --output text`)})" --attributes SqsManagedSseEnabled=true`))
  } else if (node.type === 'alb') {
    if (changed('waf') && bool(after.waf)) commands.push(run(`wafv2 associate-web-acl --web-acl-arn <regional-web-acl-arn> --resource-arn ${q(node.arn ?? node.id)}`))
  } else if (node.type === 'elasticache') {
    const group = node.props.find((p) => p.k === 'Replication group')?.v ?? '<replication-group-id>'
    if (changed('nodeType')) commands.push(run(`elasticache modify-replication-group --replication-group-id ${q(group)} --cache-node-type ${q(str(after.nodeType))}`))
    if (changed('encryptionInTransit') && bool(after.encryptionInTransit)) {
      commands.push(run(`elasticache modify-replication-group --replication-group-id ${q(group)} --transit-encryption-enabled --transit-encryption-mode preferred`))
    }
  }
  return commands.length ? { commands, caution } : null
}

const REMOVE: Partial<Record<string, (node: GraphNode) => string>> = {
  ec2: (node) => `ec2 terminate-instances --instance-ids ${q(node.props.find((p) => p.k === 'Instance ID')?.v ?? node.id)}`,
  rds: (node) => `rds delete-db-instance --db-instance-identifier ${q(node.name)} --final-db-snapshot-identifier ${q(`${node.name}-final`)}`,
  'ebs-volume': (node) => `ec2 delete-volume --volume-id ${q(node.id)}`,
  'nat-gateway': (node) => `ec2 delete-nat-gateway --nat-gateway-id ${q(node.id)}`,
  alb: (node) => `elbv2 delete-load-balancer --load-balancer-arn ${q(node.arn ?? node.id)}`,
  sqs: (node) => `sqs delete-queue --queue-url <queue-url-of-${node.name}>`,
  lambda: (node) => `lambda delete-function --function-name ${q(node.name)}`,
}

export function exportCli(base: Graph, simulated: Simulated): SimulationExport {
  const context = makeContext(base, simulated)
  const steps: SimulationExport['steps'] = []
  const notes: string[] = []
  const settings = simulated.settings

  for (const change of simulated.simulation.changes) {
    if (change.op === 'add') {
      if (!simulated.graph.nodes.some((node) => node.id === change.resource.id)) continue
      const resource = change.resource
      steps.push({
        title: `Create ${catalogEntry(resource.type)?.label ?? resource.type} ${resource.name}`,
        fix: withInputFlag(createCommands(context, resource, settings[resource.id] ?? resource.settings)),
      })
    }
  }

  for (const [nodeId, status] of Object.entries(simulated.status)) {
    if (status !== 'changed') continue
    const node = simulated.graph.nodes.find((candidate) => candidate.id === nodeId)
    const original = base.nodes.find((candidate) => candidate.id === nodeId)
    if (!node || !original) continue
    const before = settingsOf(original, base)
    const after = settings[nodeId]
    if (!before || !after) continue
    const fix = updateCommands(context, node, before, after)
    if (fix) steps.push({ title: `Change ${node.name}`, fix: withInputFlag(fix) })
  }

  for (const change of simulated.simulation.changes) {
    if (change.op !== 'connect') continue
    const source = nodeOf(context, change.source)
    const target = nodeOf(context, change.target)
    if (!source || !target || !simulated.graph.edges.some((edge) => edge.meta.connectionId === change.id)) continue
    if (change.port === null || target.securityGroupIds.length === 0) {
      notes.push(`${source.name} → ${target.name}: grant access in ${source.name}'s IAM role (for example s3:GetObject or sqs:SendMessage); there is no network rule to add.`)
      continue
    }
    const region = target.region === 'global' ? 'us-east-1' : target.region
    steps.push({
      title: `Let ${source.name} reach ${target.name} on port ${change.port}`,
      fix: withInputFlag({
        commands: [
          cli(context, region, `ec2 authorize-security-group-ingress --group-id ${sgShellRef(context, target.id)} --protocol tcp --port ${change.port} --source-group ${sgShellRef(context, source.id)}`),
        ],
        caution: null,
      }),
    })
  }

  for (const gone of simulated.removed) {
    const node = base.nodes.find((candidate) => candidate.id === gone.id)
    const command = node ? REMOVE[node.type] : undefined
    if (!node || !command) {
      notes.push(`Remove ${gone.name} (${gone.typeLabel}) by hand; there is no single safe command for it.`)
      continue
    }
    steps.push({
      title: `Remove ${node.name}`,
      fix: withInputFlag({
        // Commented out: deleting is irreversible, so it has to be a decision, not a paste.
        commands: [`# ${cli(context, node.region === 'global' ? 'us-east-1' : node.region, command(node))}`],
        caution: 'Deleting is permanent. The command is commented out so it cannot run with the rest; remove the # only when you mean it.',
      }),
    })
  }

  const header = [
    '#!/usr/bin/env bash',
    `# ${simulated.simulation.name} — generated by CloudAtlas from a simulation.`,
    '# Review every command before running it. CloudAtlas does not run this, and it creates billable resources.',
    '# Replace every <placeholder> first. Run it top to bottom: later commands use ids captured by earlier ones.',
    'set -euo pipefail',
    '',
  ]
  const body = steps.flatMap((step) => [
    `# --- ${step.title}`,
    ...(step.fix.caution ? [`# Caution: ${step.fix.caution}`] : []),
    ...step.fix.commands,
    '',
  ])
  const trailer = notes.length ? ['# Notes', ...notes.map((note) => `# - ${note}`)] : []
  return { format: 'cli', text: [...header, ...body, ...trailer].join('\n') + '\n', steps, notes }
}

// ---------------------------------------------------------------------------
// Terraform
// ---------------------------------------------------------------------------

function tfRef(context: Context, id: string | null, attribute = 'id'): string {
  if (!id) return 'null'
  const planned = context.ids.get(id)
  return planned ? `${planned.tf}.${attribute}` : JSON.stringify(id)
}

function tfSg(context: Context, nodeId: string): string {
  const planned = context.ids.get(nodeId)
  if (planned) return `aws_security_group.${planned.tf.split('.')[1]}_sg.id`
  const sg = nodeOf(context, nodeId)?.securityGroupIds[0]
  return sg ? JSON.stringify(sg) : '"<security-group-id>"'
}

function tfTags(name: string, s: Settings): string {
  const env = s.environment ? `, Environment = ${JSON.stringify(String(s.environment))}` : ''
  return `  tags = { Name = ${JSON.stringify(name)}${env} }`
}

function tfResource(context: Context, resource: SimResource, s: Settings): string[] {
  const ref = context.ids.get(resource.id)!.tf
  const [kind, name] = ref.split('.') as [string, string]
  const provider = resource.region === context.base.regions[0]?.id ? [] : [`  provider = aws.${slug(resource.region)}`]
  const block = (type: string, label: string, body: string[]) => [`resource "${type}" "${label}" {`, ...provider, ...body, '}', '']
  const sgBlock = (): string[] => {
    const world = resource.type === 'alb' && s.scheme === 'internet-facing' ? [443, 80] : openPorts(s)
    return block('aws_security_group', `${name}_sg`, [
      `  name   = ${JSON.stringify(`${resource.name}-sg`)}`,
      `  vpc_id = ${tfRef(context, resource.vpcId)}`,
      ...world.flatMap((port) => [`  ingress {`, `    from_port   = ${port}`, `    to_port     = ${port}`, `    protocol    = "tcp"`, `    cidr_blocks = ["0.0.0.0/0"]`, `  }`]),
      '  egress {', '    from_port   = 0', '    to_port     = 0', '    protocol    = "-1"', '    cidr_blocks = ["0.0.0.0/0"]', '  }',
    ])
  }

  switch (resource.type) {
    case 'vpc':
      return block(kind, name, [`  cidr_block = ${JSON.stringify(str(s.cidr))}`, tfTags(resource.name, s)])
    case 'subnet':
      return block(kind, name, [
        `  vpc_id                  = ${tfRef(context, resource.vpcId)}`,
        `  cidr_block              = ${JSON.stringify(str(s.cidr))}`,
        `  availability_zone       = ${JSON.stringify(`${resource.region}${str(s.az, 'a')}`)}`,
        `  map_public_ip_on_launch = ${bool(s.autoPublicIp)}`,
        tfTags(resource.name, s),
      ])
    case 'ec2':
      return [
        ...sgBlock(),
        ...block(kind, name, [
          '  ami                    = "<ami-id>"',
          `  instance_type          = ${JSON.stringify(str(s.instanceType))}`,
          `  subnet_id              = ${tfRef(context, resource.subnetId)}`,
          `  vpc_security_group_ids = [aws_security_group.${name}_sg.id]`,
          `  associate_public_ip_address = ${bool(s.publicIp)}`,
          `  metadata_options {`, `    http_tokens = ${bool(s.imdsv2) ? '"required"' : '"optional"'}`, `  }`,
          `  root_block_device {`, `    volume_size = ${num(s.volumeGiB, 30)}`, `    volume_type = ${JSON.stringify(str(s.volumeType, 'gp3'))}`, `    encrypted   = ${bool(s.encrypted)}`, `  }`,
          tfTags(resource.name, s),
        ]),
      ]
    case 'rds':
      return [
        ...sgBlock(),
        ...block('aws_db_subnet_group', `${name}_subnets`, [`  name       = ${JSON.stringify(`${resource.name}-subnets`)}`, `  subnet_ids = [${tfRef(context, resource.subnetId)}, "<second-private-subnet-id-in-another-az>"]`]),
        ...block(kind, name, [
          `  identifier                  = ${JSON.stringify(resource.name)}`,
          `  engine                      = ${JSON.stringify(str(s.engine, 'postgres'))}`,
          `  instance_class              = ${JSON.stringify(str(s.instanceClass))}`,
          `  allocated_storage           = ${num(s.storageGiB, 100)}`,
          `  storage_type                = ${JSON.stringify(str(s.storageType, 'gp3'))}`,
          `  multi_az                    = ${bool(s.multiAz)}`,
          `  storage_encrypted           = ${bool(s.encrypted)}`,
          `  publicly_accessible         = ${bool(s.publiclyAccessible)}`,
          `  backup_retention_period     = ${num(s.backupDays, 7)}`,
          `  deletion_protection         = ${bool(s.deletionProtection)}`,
          '  username                    = "dbadmin"',
          '  manage_master_user_password = true',
          `  db_subnet_group_name        = aws_db_subnet_group.${name}_subnets.name`,
          `  vpc_security_group_ids      = [aws_security_group.${name}_sg.id]`,
          tfTags(resource.name, s),
        ]),
      ]
    case 'elasticache':
      return [
        ...sgBlock(),
        ...block('aws_elasticache_subnet_group', `${name}_subnets`, [`  name       = ${JSON.stringify(`${resource.name}-subnets`)}`, `  subnet_ids = [${tfRef(context, resource.subnetId)}]`]),
        ...block(kind, name, [
          `  replication_group_id       = ${JSON.stringify(resource.name)}`,
          `  description                = ${JSON.stringify(resource.name)}`,
          `  node_type                  = ${JSON.stringify(str(s.nodeType))}`,
          `  num_cache_clusters         = ${num(s.nodes, 1)}`,
          `  at_rest_encryption_enabled = ${bool(s.encryptionAtRest)}`,
          `  transit_encryption_enabled = ${bool(s.encryptionInTransit)}`,
          `  subnet_group_name          = aws_elasticache_subnet_group.${name}_subnets.name`,
          `  security_group_ids         = [aws_security_group.${name}_sg.id]`,
        ]),
      ]
    case 'alb':
      return [
        ...sgBlock(),
        ...block(kind, name, [
          `  name               = ${JSON.stringify(resource.name)}`,
          '  load_balancer_type = "application"',
          `  internal           = ${s.scheme === 'internal'}`,
          `  subnets            = [${tfRef(context, resource.subnetId)}, "<second-subnet-id-in-another-az>"]`,
          `  security_groups    = [aws_security_group.${name}_sg.id]`,
          tfTags(resource.name, s),
        ]),
        ...(bool(s.waf) ? block('aws_wafv2_web_acl_association', `${name}_waf`, ['  web_acl_arn  = "<regional-web-acl-arn>"', `  resource_arn = ${kind}.${name}.arn`]) : []),
      ]
    case 'nat-gateway':
      return [
        ...block('aws_eip', `${name}_eip`, ['  domain = "vpc"']),
        ...block(kind, name, [`  subnet_id     = ${tfRef(context, resource.subnetId)}`, `  allocation_id = aws_eip.${name}_eip.id`, tfTags(resource.name, s)]),
      ]
    case 'ecs-task':
      return [
        ...sgBlock(),
        `# ${resource.name}: an ECS service needs a cluster and a task definition (cpu ${Math.round(num(s.vcpu, 0.5) * 1024)}, memory ${Math.round(num(s.memoryGB, 1) * 1024)}).`,
        ...block(kind, name, [
          `  name            = ${JSON.stringify(resource.name)}`,
          '  cluster         = "<cluster-arn>"',
          '  task_definition = "<task-definition-arn>"',
          '  launch_type     = "FARGATE"',
          '  desired_count   = 1',
          '  network_configuration {',
          `    subnets         = [${tfRef(context, resource.subnetId)}]`,
          `    security_groups = [aws_security_group.${name}_sg.id]`,
          '  }',
        ]),
      ]
    case 'lambda':
      return block(kind, name, [
        `  function_name = ${JSON.stringify(resource.name)}`,
        `  runtime       = ${JSON.stringify(str(s.runtime))}`,
        `  architectures = [${JSON.stringify(str(s.architecture, 'arm64'))}]`,
        `  memory_size   = ${num(s.memoryMB, 512)}`,
        '  role          = "<execution-role-arn>"',
        '  handler       = "<handler>"',
        '  filename      = "<package.zip>"',
      ])
    case 's3':
      return [
        ...block(kind, name, [`  bucket = ${JSON.stringify(resource.name)}`, tfTags(resource.name, s)]),
        ...block('aws_s3_bucket_server_side_encryption_configuration', name, [
          `  bucket = aws_s3_bucket.${name}.id`,
          '  rule {', '    apply_server_side_encryption_by_default {', `      sse_algorithm = ${JSON.stringify(str(s.encryption, 'aws:kms'))}`, '    }', '  }',
        ]),
        ...(bool(s.blockPublic)
          ? block('aws_s3_bucket_public_access_block', name, [
              `  bucket                  = aws_s3_bucket.${name}.id`,
              '  block_public_acls       = true', '  ignore_public_acls      = true', '  block_public_policy     = true', '  restrict_public_buckets = true',
            ])
          : []),
      ]
    case 'sqs':
      return block(kind, name, [`  name                    = ${JSON.stringify(resource.name)}`, `  sqs_managed_sse_enabled = ${bool(s.encrypted)}`])
  }
}

const TF_TYPE: Record<SimResource['type'], string> = {
  vpc: 'aws_vpc',
  subnet: 'aws_subnet',
  ec2: 'aws_instance',
  rds: 'aws_db_instance',
  elasticache: 'aws_elasticache_replication_group',
  alb: 'aws_lb',
  'nat-gateway': 'aws_nat_gateway',
  'ecs-task': 'aws_ecs_service',
  lambda: 'aws_lambda_function',
  s3: 'aws_s3_bucket',
  sqs: 'aws_sqs_queue',
}

function makeContext(base: Graph, simulated: Simulated): Context {
  const ids = new Map<string, { shell: string; tf: string }>()
  const used = new Set<string>()
  for (const change of simulated.simulation.changes) {
    if (change.op !== 'add') continue
    let label = slug(change.resource.name)
    while (used.has(label)) label = `${label}_${change.resource.id.slice(-4).replace(/-/g, '')}`
    used.add(label)
    ids.set(change.resource.id, { shell: label.toUpperCase(), tf: `${TF_TYPE[change.resource.type]}.${label}` })
  }
  return { graph: simulated.graph, base, simulated, profile: base.profile, ids }
}

export function exportTerraform(base: Graph, simulated: Simulated): SimulationExport {
  const context = makeContext(base, simulated)
  const notes: string[] = []
  const regions = [...new Set(simulated.simulation.changes.flatMap((change) => (change.op === 'add' ? [change.resource.region] : [])))]
  const primary = base.regions[0]?.id ?? regions[0] ?? 'us-east-1'

  const out: string[] = [
    `# ${simulated.simulation.name} — generated by CloudAtlas from a simulation.`,
    '# Review before applying. CloudAtlas does not run Terraform. Replace every <placeholder> first.',
    '# Existing resources are referenced by their real ids; resources created here reference each other.',
    '',
    'terraform {',
    '  required_providers {',
    '    aws = { source = "hashicorp/aws", version = ">= 5.0" }',
    '  }',
    '}',
    '',
    `provider "aws" {`,
    `  region  = ${JSON.stringify(primary)}`,
    `  profile = ${JSON.stringify(base.profile)}`,
    '}',
    '',
    ...regions
      .filter((region) => region !== primary)
      .flatMap((region) => [`provider "aws" {`, `  alias   = ${JSON.stringify(slug(region))}`, `  region  = ${JSON.stringify(region)}`, `  profile = ${JSON.stringify(base.profile)}`, '}', '']),
  ]

  for (const change of simulated.simulation.changes) {
    if (change.op !== 'add' || !simulated.graph.nodes.some((node) => node.id === change.resource.id)) continue
    out.push(`# ${catalogEntry(change.resource.type)?.label ?? change.resource.type}: ${change.resource.name}`)
    out.push(...tfResource(context, change.resource, simulated.settings[change.resource.id] ?? change.resource.settings))
  }

  for (const change of simulated.simulation.changes) {
    if (change.op !== 'connect' || change.port === null) continue
    if (!simulated.graph.edges.some((edge) => edge.meta.connectionId === change.id)) continue
    const target = nodeOf(context, change.target)
    const source = nodeOf(context, change.source)
    if (!target?.securityGroupIds.length || !source?.securityGroupIds.length) continue
    out.push(
      `# ${source.name} → ${target.name} on ${change.port}`,
      `resource "aws_vpc_security_group_ingress_rule" "${slug(`${source.name}_to_${target.name}_${change.port}`)}" {`,
      `  security_group_id            = ${tfSg(context, target.id)}`,
      `  referenced_security_group_id = ${tfSg(context, source.id)}`,
      '  ip_protocol                  = "tcp"',
      `  from_port                    = ${change.port}`,
      `  to_port                      = ${change.port}`,
      '}',
      '',
    )
  }

  const edited = Object.entries(simulated.status).filter(([, status]) => status === 'changed')
  for (const [nodeId] of edited) {
    const node = simulated.graph.nodes.find((candidate) => candidate.id === nodeId)
    if (node) notes.push(`${node.name} is changed in the simulation. Terraform can only change what it manages: import it first (terraform import), then edit its block — or use the CLI export.`)
  }
  for (const gone of simulated.removed) notes.push(`${gone.name} is removed in the simulation. If Terraform manages it, delete its block; otherwise remove it by hand.`)
  if (notes.length) out.push('# Notes', ...notes.map((note) => `# - ${note}`), '')

  return { format: 'terraform', text: out.join('\n'), steps: [], notes }
}
