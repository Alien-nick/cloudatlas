import type { Fix, GraphNode } from '@cloudatlas/shared'

/**
 * Building AWS CLI commands for the user to copy and run.
 *
 * Shared by compliance fixes and cost savings, so both quote the same way.
 * Nothing here executes anything: these are strings for a human to review.
 */

const SAFE = /^[\w.\-/:@=,+]+$/

/** Single-quote for a POSIX shell unless the value is plainly safe. */
export function q(value: string): string {
  return SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** Global resources are managed through us-east-1. */
export function regionOf(node: GraphNode): string {
  return node.region === 'global' ? 'us-east-1' : node.region
}

export interface CliContext {
  profile: string
}

/** `aws <command> --region <r> --profile <p>`, quoted. */
export function awsCli(node: GraphNode, context: CliContext, command: string, region = regionOf(node)): string {
  return `aws ${command} --region ${q(region)} --profile ${q(context.profile)}`
}

export function fact(node: GraphNode, key: string): string | undefined {
  return node.props.find((prop) => prop.k === key)?.v
}

/** RDS is addressed by identifier, which the builder uses as the node name. */
export function rdsTarget(node: GraphNode): string {
  return node.type === 'rds-cluster'
    ? `modify-db-cluster --db-cluster-identifier ${q(node.name)}`
    : `modify-db-instance --db-instance-identifier ${q(node.name)}`
}

export const instanceId = (node: GraphNode): string => fact(node, 'Instance ID') ?? node.id

/** Mark a fix as needing input when any command still holds a `<placeholder>`. */
export function withInputFlag(fix: Omit<Fix, 'needsInput'>): Fix {
  return { ...fix, needsInput: fix.commands.some((command) => /<[a-z][a-z0-9-]*>/.test(command)) }
}
