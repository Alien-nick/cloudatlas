import { describe, expect, it } from 'vitest'
import { diagramBounds, exportFilename } from './export'

describe('diagram bounds', () => {
  it('covers every node plus padding, not just what is on screen', () => {
    // Measured from node positions rather than the viewport, which only knows
    // what is currently visible at the current zoom.
    const bounds = diagramBounds([
      { position: { x: 0, y: 0 }, dimensions: { width: 100, height: 50 } },
      { position: { x: 400, y: 200 }, dimensions: { width: 100, height: 50 } },
    ])
    expect(bounds).toEqual({ x: -40, y: -40, width: 580, height: 330 })
  })

  it('handles negative coordinates, which layout produces routinely', () => {
    const bounds = diagramBounds([
      { position: { x: -200, y: -100 }, dimensions: { width: 50, height: 50 } },
    ])
    expect(bounds?.x).toBe(-240)
    expect(bounds?.y).toBe(-140)
  })

  it('returns null when there is nothing to export', () => {
    expect(diagramBounds([])).toBeNull()
  })

  it('tolerates a node that has not been measured yet', () => {
    const bounds = diagramBounds([{ position: { x: 10, y: 10 } }])
    expect(bounds).not.toBeNull()
    expect(Number.isFinite(bounds!.width)).toBe(true)
  })
})

describe('export filename', () => {
  const now = new Date(Date.UTC(2026, 8, 23, 12, 0, 0))

  it('names the account, scope and date', () => {
    expect(exportFilename('cortex-prod', ['us-east-1'], 'png', now)).toBe(
      'cortex-prod-us-east-1-2026-09-23.png',
    )
  })

  it('summarises when several regions are in scope', () => {
    expect(exportFilename('cortex-prod', ['us-east-1', 'us-west-2'], 'svg', now)).toBe(
      'cortex-prod-2-regions-2026-09-23.svg',
    )
  })

  it('strips characters that are not safe in a filename', () => {
    // An account alias is free text and can contain anything.
    expect(exportFilename('acme/prod team', ['eu-west-1'], 'png', now)).toBe(
      'acme-prod-team-eu-west-1-2026-09-23.png',
    )
  })
})
