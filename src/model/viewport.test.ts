import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM } from './doc.ts'
import { clampZoom, fitImageScale, fitViewport, screenToScene, zoomAround } from './viewport.ts'

describe('viewport math', () => {
  it('keeps the scene point under the cursor fixed while zooming', () => {
    const vp = { zoom: 1, panX: 30, panY: -20 }
    const cursor = { x: 400, y: 300 }
    const before = screenToScene(vp, cursor)
    const next = zoomAround(vp, cursor, 2.5)
    const after = screenToScene(next, cursor)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(next.zoom).toBe(2.5)
  })

  it('clamps zoom to the supported range', () => {
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
    expect(zoomAround({ zoom: 1, panX: 0, panY: 0 }, { x: 0, y: 0 }, 99).zoom).toBe(MAX_ZOOM)
  })

  it('fit resets to 100% centred-origin when there is no content', () => {
    expect(fitViewport(null, { width: 800, height: 600 })).toEqual({ zoom: 1, panX: 0, panY: 0 })
  })

  it('fit centres content and shrinks to fit, but never magnifies', () => {
    const size = { width: 1000, height: 800 }
    const small = fitViewport({ left: 0, top: 0, right: 100, bottom: 100 }, size)
    expect(small.zoom).toBe(1)
    const big = fitViewport({ left: 0, top: 0, right: 4000, bottom: 1000 }, size)
    expect(big.zoom).toBeCloseTo(840 / 4000)
    // the content's centre lands on the viewport's centre
    const c = { x: 2000 * big.zoom + big.panX, y: 500 * big.zoom + big.panY }
    expect(c.x).toBeCloseTo(500)
    expect(c.y).toBeCloseTo(400)
  })

  it('scales large images down to the max side and never upscales', () => {
    expect(fitImageScale(960, 480, 480)).toBe(0.5)
    expect(fitImageScale(100, 50, 480)).toBe(1)
  })
})
