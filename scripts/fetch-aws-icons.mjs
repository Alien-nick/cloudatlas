#!/usr/bin/env node
/**
 * Pull the official AWS Architecture Icons into apps/web/public/aws-icons/.
 *
 *   node scripts/fetch-aws-icons.mjs                 # download the pinned release
 *   node scripts/fetch-aws-icons.mjs --zip <path>    # use an already-downloaded zip
 *   node scripts/fetch-aws-icons.mjs --url <url>     # a newer quarterly release
 *
 * AWS publishes a new package quarterly (end of January, April and July) at
 * https://aws.amazon.com/architecture/icons/ — when the URL below goes stale,
 * grab the new one from that page and pass it with --url.
 *
 * Only the icons CloudAtlas maps to a node type are copied, so the repo keeps
 * ~30 small SVGs instead of a 14 MB archive.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'apps/web/public/aws-icons')
const GENERATED_TS = join(ROOT, 'apps/web/src/lib/aws-icons.generated.ts')

const DEFAULT_URL =
  'https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip'
const RELEASE = 'Icon-package_07312026'

/**
 * nodeType -> { path, style }
 *
 * `service` icons are the filled, rounded-square product tiles — they carry
 * their own background and drop straight onto the canvas.
 * `resource` icons are single-colour line art, so the UI puts them on a panel
 * tile with a category-coloured border, which is how AWS's own diagrams use
 * them.
 */
const ICONS = {
  // --- compute ---
  ec2: { path: 'Architecture-Service-Icons_R/Arch_Compute/64/Arch_Amazon-EC2_64.svg', style: 'service' },
  lambda: { path: 'Architecture-Service-Icons_R/Arch_Compute/64/Arch_AWS-Lambda_64.svg', style: 'service' },
  'ecs-task': { path: 'Architecture-Service-Icons_R/Arch_Containers/64/Arch_Amazon-Elastic-Container-Service_64.svg', style: 'service' },
  'ecs-service': { path: 'Architecture-Service-Icons_R/Arch_Containers/64/Arch_Amazon-Elastic-Container-Service_64.svg', style: 'service' },

  // --- networking ---
  alb: { path: 'Resource-Icons_R/Res_Networking-Content-Delivery/Res_Elastic-Load-Balancing_Application-Load-Balancer_48.svg', style: 'resource' },
  nlb: { path: 'Resource-Icons_R/Res_Networking-Content-Delivery/Res_Elastic-Load-Balancing_Network-Load-Balancer_48.svg', style: 'resource' },
  'target-group': { path: 'Architecture-Service-Icons_R/Arch_Networking-Content-Delivery/64/Arch_Elastic-Load-Balancing_64.svg', style: 'service' },
  'nat-gateway': { path: 'Resource-Icons_R/Res_Networking-Content-Delivery/Res_Amazon-VPC_NAT-Gateway_48.svg', style: 'resource' },
  'internet-gateway': { path: 'Resource-Icons_R/Res_Networking-Content-Delivery/Res_Amazon-VPC_Internet-Gateway_48.svg', style: 'resource' },
  eni: { path: 'Resource-Icons_R/Res_Networking-Content-Delivery/Res_Amazon-VPC_Elastic-Network-Interface_48.svg', style: 'resource' },
  'vpc-endpoint': { path: 'Resource-Icons_R/Res_Networking-Content-Delivery/Res_Amazon-VPC_Endpoints_48.svg', style: 'resource' },
  cloudfront: { path: 'Architecture-Service-Icons_R/Arch_Networking-Content-Delivery/64/Arch_Amazon-CloudFront_64.svg', style: 'service' },
  'route53-zone': { path: 'Architecture-Service-Icons_R/Arch_Networking-Content-Delivery/64/Arch_Amazon-Route-53_64.svg', style: 'service' },
  vpc: { path: 'Architecture-Service-Icons_R/Arch_Networking-Content-Delivery/64/Arch_Amazon-Virtual-Private-Cloud_64.svg', style: 'service' },

  // --- database ---
  rds: { path: 'Architecture-Service-Icons_R/Arch_Databases/64/Arch_Amazon-RDS_64.svg', style: 'service' },
  'rds-cluster': { path: 'Architecture-Service-Icons_R/Arch_Databases/64/Arch_Amazon-RDS_64.svg', style: 'service' },
  elasticache: { path: 'Architecture-Service-Icons_R/Arch_Databases/64/Arch_Amazon-ElastiCache_64.svg', style: 'service' },

  // --- storage ---
  s3: { path: 'Architecture-Service-Icons_R/Arch_Storage/64/Arch_Amazon-Simple-Storage-Service_64.svg', style: 'service' },
  'ebs-volume': { path: 'Architecture-Service-Icons_R/Arch_Storage/64/Arch_Amazon-Elastic-Block-Store_64.svg', style: 'service' },

  // --- integration ---
  sqs: { path: 'Architecture-Service-Icons_R/Arch_Application-Integration/64/Arch_Amazon-Simple-Queue-Service_64.svg', style: 'service' },
  sns: { path: 'Architecture-Service-Icons_R/Arch_Application-Integration/64/Arch_Amazon-Simple-Notification-Service_64.svg', style: 'service' },
  'eventbridge-rule': { path: 'Architecture-Service-Icons_R/Arch_Application-Integration/64/Arch_Amazon-EventBridge_64.svg', style: 'service' },

  // --- security ---
  'waf-web-acl': { path: 'Architecture-Service-Icons_R/Arch_Security-Identity/64/Arch_AWS-WAF_64.svg', style: 'service' },
  'network-firewall': { path: 'Architecture-Service-Icons_R/Arch_Security-Identity/64/Arch_AWS-Network-Firewall_64.svg', style: 'service' },
  'iam-role': { path: 'Architecture-Service-Icons_R/Arch_Security-Identity/64/Arch_AWS-Identity-and-Access-Management_64.svg', style: 'service' },
}

function parseArgs(argv) {
  const args = { url: DEFAULT_URL, zip: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i]
    else if (argv[i] === '--zip') args.zip = argv[++i]
  }
  return args
}

function requireUnzip() {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
  } catch {
    console.error('This script needs the `unzip` command on PATH.')
    process.exit(1)
  }
}

async function download(url, dest) {
  process.stdout.write(`Downloading ${url}\n`)
  const response = await fetch(url)
  if (!response.ok) {
    console.error(
      `Download failed: ${response.status} ${response.statusText}\n` +
        'The quarterly URL may have rotated — grab the current one from\n' +
        'https://aws.amazon.com/architecture/icons/ and pass it with --url.',
    )
    process.exit(1)
  }
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()))
}

/** The release date is baked into every top-level directory name. */
function resolveRelease(extractDir) {
  const listing = execFileSync('ls', [extractDir], { encoding: 'utf8' }).split('\n')
  const serviceDir = listing.find((d) => d.startsWith('Architecture-Service-Icons_'))
  if (!serviceDir) {
    console.error(`Could not find Architecture-Service-Icons_* inside ${extractDir}`)
    process.exit(1)
  }
  return serviceDir.replace('Architecture-Service-Icons_', '')
}

async function main() {
  const { url, zip } = parseArgs(process.argv.slice(2))
  requireUnzip()

  const work = mkdtempSync(join(tmpdir(), 'cloudatlas-icons-'))
  const archive = zip ? resolve(zip) : join(work, 'icons.zip')

  try {
    if (!zip) await download(url, archive)
    else if (!existsSync(archive)) {
      console.error(`No such file: ${archive}`)
      process.exit(1)
    }

    const extractDir = join(work, 'extracted')
    execFileSync('unzip', ['-q', '-o', archive, '-d', extractDir])
    const stamp = resolveRelease(extractDir)

    mkdirSync(OUT_DIR, { recursive: true })

    const manifest = {}
    const missing = []

    for (const [nodeType, spec] of Object.entries(ICONS)) {
      const source = join(extractDir, spec.path.replaceAll('_R/', `_${stamp}/`))
      if (!existsSync(source)) {
        missing.push(`${nodeType}: ${spec.path}`)
        continue
      }
      const file = `${nodeType}.svg`
      copyFileSync(source, join(OUT_DIR, file))
      manifest[nodeType] = { file, style: spec.style }
    }

    if (missing.length > 0) {
      console.warn(`\nNot found in ${stamp} (AWS renamed or dropped them):`)
      for (const entry of missing) console.warn(`  - ${entry}`)
      console.warn('Update the ICONS map in scripts/fetch-aws-icons.mjs.\n')
    }

    writeFileSync(
      join(OUT_DIR, 'manifest.json'),
      `${JSON.stringify({ release: stamp, source: url, icons: manifest }, null, 2)}\n`,
    )

    writeFileSync(
      GENERATED_TS,
      `// Generated by scripts/fetch-aws-icons.mjs — do not edit by hand.\n` +
        `// AWS Architecture Icons release: ${stamp}\n` +
        `import type { NodeType } from '@cloudatlas/shared'\n\n` +
        `export type AwsIconStyle = 'service' | 'resource'\n\n` +
        `export interface AwsIcon {\n  /** Path under apps/web/public. */\n  src: string\n  style: AwsIconStyle\n}\n\n` +
        `export const AWS_ICON_RELEASE = '${stamp}'\n\n` +
        `export const AWS_ICONS: Partial<Record<NodeType, AwsIcon>> = {\n` +
        Object.entries(manifest)
          .map(
            ([nodeType, entry]) =>
              `  ${/^[a-z][a-z0-9]*$/.test(nodeType) ? nodeType : `'${nodeType}'`}: { src: '/aws-icons/${entry.file}', style: '${entry.style}' },`,
          )
          .join('\n') +
        `\n}\n`,
    )

    writeFileSync(
      join(OUT_DIR, 'ATTRIBUTION.md'),
      `# AWS Architecture Icons\n\n` +
        `Release: \`${stamp}\`\n\n` +
        `Source: <https://aws.amazon.com/architecture/icons/>\n\n` +
        `These icons are published by Amazon Web Services for use in architecture\n` +
        `diagrams and related material. They are AWS trademarks and remain the\n` +
        `property of Amazon Web Services, Inc. They are redistributed here unmodified\n` +
        `so CloudAtlas can render accurate diagrams offline.\n\n` +
        `Do not alter the icons, and do not use them to imply AWS endorsement.\n\n` +
        `Regenerate with:\n\n\`\`\`bash\nnpm run icons\n\`\`\`\n`,
    )

    console.log(`\n${Object.keys(manifest).length} icons written to apps/web/public/aws-icons/`)
    console.log(`Release ${stamp}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

await main()
