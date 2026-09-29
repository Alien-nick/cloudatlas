import { spawn } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * Opens the user's own terminal running `aws ssm start-session`.
 *
 * This does not break the read-only guarantee: CloudAtlas makes no AWS call
 * here. The session is started by the user's `aws` CLI, in a window they can
 * see and close, exactly as if they had pasted the command themselves.
 *
 * Every token that reaches a shell is validated against a strict pattern
 * first, so nothing below needs quoting. That matters more than usual because
 * the three platforms quote differently and cmd.exe barely quotes at all.
 */

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
const PROFILE = /^[A-Za-z0-9_.@+-]{1,128}$/

export interface SsmTarget {
  instanceId: string
  profile: string
  region: string
}

export class TerminalLaunchError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_TARGET' | 'NO_TERMINAL' | 'LAUNCH_FAILED',
  ) {
    super(message)
    this.name = 'TerminalLaunchError'
  }
}

export function ssmCommand(target: SsmTarget): string {
  if (!INSTANCE_ID.test(target.instanceId)) {
    throw new TerminalLaunchError(`Not an EC2 instance ID: ${target.instanceId}`, 'INVALID_TARGET')
  }
  if (!REGION.test(target.region)) {
    throw new TerminalLaunchError(`Not an AWS region: ${target.region}`, 'INVALID_TARGET')
  }
  if (!PROFILE.test(target.profile)) {
    throw new TerminalLaunchError(
      `Profile name "${target.profile}" has characters CloudAtlas will not pass to a shell — copy the command instead.`,
      'INVALID_TARGET',
    )
  }
  return `aws ssm start-session --target ${target.instanceId} --profile ${target.profile} --region ${target.region}`
}

export interface LaunchPlan {
  file: string
  args: string[]
  /** A script to write (mode 755) before spawning, for macOS. */
  script?: { path: string; body: string }
  windowsVerbatimArguments?: boolean
}

/** Linux terminals in preference order, with how each takes a command. */
const LINUX_TERMINALS: Array<{ bin: string; args: (script: string) => string[] }> = [
  { bin: 'x-terminal-emulator', args: (s) => ['-e', 'sh', '-c', s] },
  { bin: 'gnome-terminal', args: (s) => ['--', 'sh', '-c', s] },
  { bin: 'konsole', args: (s) => ['-e', 'sh', '-c', s] },
  { bin: 'xfce4-terminal', args: (s) => ['-x', 'sh', '-c', s] },
  { bin: 'kitty', args: (s) => ['sh', '-c', s] },
  { bin: 'alacritty', args: (s) => ['-e', 'sh', '-c', s] },
  { bin: 'wezterm', args: (s) => ['start', '--', 'sh', '-c', s] },
  { bin: 'xterm', args: (s) => ['-e', 'sh', '-c', s] },
]

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      accessSync(join(dir, bin), constants.X_OK)
      return true
    } catch {
      // keep looking
    }
  }
  return false
}

export function planLaunch(
  target: SsmTarget,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  has: (bin: string) => boolean = (bin) => onPath(bin, env),
): LaunchPlan {
  const command = ssmCommand(target)

  if (platform === 'darwin') {
    // A .command file opens in whichever terminal the user has made the
    // default for them (Terminal, iTerm, …), and runs under their login
    // environment, so a Homebrew `aws` is on PATH even though ours may not be.
    const path = join(tmpdir(), 'cloudatlas', `ssm-${target.instanceId}.command`)
    const body = `#!/bin/sh\nclear\necho '$ ${command}'\n${command}\n`
    return { file: 'open', args: [path], script: { path, body } }
  }

  if (platform === 'win32') {
    // `start` opens the user's default console host (Windows Terminal on 11);
    // `/k` keeps the window open so an error stays readable.
    return {
      file: env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', `start "SSM ${target.instanceId}" cmd.exe /k ${command}`],
      windowsVerbatimArguments: true,
    }
  }

  // Hold the window after the session ends so a failure can be read.
  const script = `echo '$ ${command}'; ${command}; printf '\\nSession ended. Press Enter to close.'; read _`
  const preferred = env.TERMINAL
  if (preferred && PROFILE.test(preferred) && has(preferred)) {
    return { file: preferred, args: ['-e', 'sh', '-c', script] }
  }
  const terminal = LINUX_TERMINALS.find((t) => has(t.bin))
  if (!terminal) {
    throw new TerminalLaunchError(
      'No terminal emulator found on PATH. Set $TERMINAL, or copy the command instead.',
      'NO_TERMINAL',
    )
  }
  return { file: terminal.bin, args: terminal.args(script) }
}

export async function launchSsmTerminal(target: SsmTarget): Promise<{ command: string }> {
  const plan = planLaunch(target)

  if (plan.script) {
    await mkdir(join(tmpdir(), 'cloudatlas'), { recursive: true })
    await writeFile(plan.script.path, plan.script.body)
    await chmod(plan.script.path, 0o755)
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    })
    child.once('error', (error) =>
      reject(new TerminalLaunchError(`Could not open a terminal: ${error.message}`, 'LAUNCH_FAILED')),
    )
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

  return { command: ssmCommand(target) }
}
