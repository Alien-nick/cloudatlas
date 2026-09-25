import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import {
  CATEGORY_COLORS,
  INACTIVE_COLOR,
  isActiveState,
  type GraphNode,
  type NodeCategory,
} from '@cloudatlas/shared'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function categoryColor(category: NodeCategory): string {
  return CATEGORY_COLORS[category]
}

/** Tile colour for a node, greyed out when the resource is not running. */
export function nodeColor(node: Pick<GraphNode, 'category' | 'state'>): string {
  return isActiveState(node.state) ? CATEGORY_COLORS[node.category] : INACTIVE_COLOR
}

export function stateTone(state: string): 'ok' | 'warn' | 'faint' {
  if (state === 'stopped' || state === 'terminated' || state === '—') return 'faint'
  return isActiveState(state) ? 'ok' : 'warn'
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function relativeTime(timestamp: number, now = Date.now()): string {
  const delta = timestamp - now
  const abs = Math.abs(delta)
  if (abs < 60_000) return relativeFormatter.format(Math.round(delta / 1000), 'second')
  if (abs < 3_600_000) return relativeFormatter.format(Math.round(delta / 60_000), 'minute')
  if (abs < 86_400_000) return relativeFormatter.format(Math.round(delta / 3_600_000), 'hour')
  return relativeFormatter.format(Math.round(delta / 86_400_000), 'day')
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatCurrency(value: number | null): string {
  if (value === null) return '—'
  return `$${Math.round(value).toLocaleString()}`
}

/** Copy to clipboard with a fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}
