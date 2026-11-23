import { describe, expect, it } from 'vitest'
import { snapCandidate } from './captionSnap.ts'
import type { SnapImage, SnapSide } from './captionSnap.ts'
import type { Rect } from './viewport.ts'

const bounds = { left: 100, right: 220, top: 100, bottom: 180 }
const cover: SnapImage = { imageId: 'cover', bounds }
const run = (text: Rect, images: readonly SnapImage[] = [cover], zoom = 1) => snapCandidate({ id: 'text', bounds: text }, images, zoom, 24)

describe('caption snapping', () => {
  const sideCases: Array<[SnapSide, Rect]> = [
    ['under', { left: 120, right: 200, top: 190, bottom: 230 }],
    ['top', { left: 120, right: 200, top: 50, bottom: 90 }],
    ['left', { left: 40, right: 90, top: 120, bottom: 160 }],
    ['right', { left: 230, right: 280, top: 120, bottom: 160 }],
  ]
  it.each(sideCases)('finds the %s edge', (side, text) => expect(run(text)).toEqual({ imageId: 'cover', side, position: 0.5 }))

  it('keeps off-center positions and includes the endpoints', () => {
    const below = (left: number) => ({ left, right: left + 40, top: 190, bottom: 220 })
    expect(run(below(80))?.position).toBe(0)
    expect(run(below(110))?.position).toBe(0.25)
    expect(run(below(200))?.position).toBe(1)
  })

  it('uses a 14-screen-pixel physical edge limit independently of zoom', () => {
    for (const zoom of [0.5, 1, 2, 4]) {
      const acrossEdge = (distance: number) => ({ left: 120, right: 200, top: 180 - distance / zoom, bottom: 230 })
      expect(run(acrossEdge(13.99), [cover], zoom)?.side).toBe('under')
      expect(run(acrossEdge(14), [cover], zoom)?.side).toBe('under')
      expect(run(acrossEdge(14.01), [cover], zoom)).toBeNull()
    }
  })

  it('allows a bounded gap hit outside the physical tolerance on all four edges', () => {
    for (const zoom of [1.15, 2, 4]) {
      for (const [side, text] of sideCases) expect(run(text, [cover], zoom)?.side).toBe(side)
    }
    const below = (distance: number) => ({ left: 120, right: 200, top: 180 + distance, bottom: 230 })
    expect(run(below(13), [cover], 2)?.side).toBe('under')
    expect(run(below(13.01), [cover], 2)).toBeNull()
    expect(run(below(-10), [cover], 2)).toBeNull()
  })

  it('keeps a physical hit when another image is exactly at its normal gap', () => {
    const text = { left: 120, right: 200, top: 190, bottom: 230 }
    const physical: SnapImage = { imageId: 'physical', bounds: { ...bounds, bottom: 188 } }
    expect(run(text, [cover, physical], 2)?.imageId).toBe('physical')
    expect(run(text, [physical, cover], 2)?.imageId).toBe('physical')
    expect(run(text, [cover, { ...physical, captionId: 'other' }], 2)?.imageId).toBe('cover')
    expect(run(text, [cover, { ...physical, locked: true }], 2)?.imageId).toBe('cover')
  })

  it('ranks gap fallback candidates by the adjustment needed to land', () => {
    const text = { left: 120, right: 200, top: 190, bottom: 230 }
    const fartherFromGap: SnapImage = { imageId: 'nearer edge', bounds: { ...bounds, bottom: 181 } }
    expect(run(text, [fartherFromGap, cover], 2)?.imageId).toBe('cover')
  })

  it('requires a quarter of the shorter facing edge to overlap', () => {
    const below = (left: number) => ({ left, right: left + 40, top: 190, bottom: 220 })
    expect(run(below(209.99))?.side).toBe('under')
    expect(run(below(210))?.side).toBe('under')
    expect(run(below(210.01))).toBeNull()
  })

  it('picks the nearest eligible edge and keeps input order for ties', () => {
    const text = { left: 120, right: 200, top: 192, bottom: 222 }
    const nearer: SnapImage = { imageId: 'nearer', bounds: { ...bounds, bottom: 186 } }
    expect(run(text, [cover, nearer])).toEqual({ imageId: 'nearer', side: 'under', position: 0.5 })
    expect(run(text, [{ ...cover, imageId: 'front' }, cover])?.imageId).toBe('front')
  })

  it('ignores locked, moving and already-captioned images and permits the texts own image', () => {
    const text = { left: 120, right: 200, top: 192, bottom: 222 }
    expect(run(text, [{ ...cover, locked: true }, { ...cover, moving: true }, { ...cover, captionId: 'other' }])).toBeNull()
    expect(run(text, [{ ...cover, captionId: 'text' }])?.side).toBe('under')
  })

  it('lets a large caption nudge around its own canonical gap', () => {
    const text = { id: 'text', attachedSide: 'under' as const, bounds: { left: 120, right: 200, top: 224, bottom: 320 } }
    expect(snapCandidate(text, [{ ...cover, captionId: 'text' }], 2, 100)).toEqual({ imageId: 'cover', side: 'under', position: 0.5 })
    expect(snapCandidate(text, [cover], 2, 100)).toBeNull()
  })
})
