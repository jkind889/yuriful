import { describe, expect, it } from 'vitest'
import {
  MIN_CROP_SCENE,
  clampCrop,
  coverBox,
  replaceRecord,
  croppedPlacement,
  displayBox,
  dragCropRect,
  fillRecord,
  fitInsideScale,
  fitRecord,
  hitCropHandle,
  isWholeImage,
  largestCentredCrop,
  minCropSide,
  storedCrop,
  sceneToSource,
  sourceToScene,
  uncroppedPlacement,
} from './crop.ts'
import type { Placement } from './crop.ts'
import type { ImageRecord } from './types.ts'

const SIZE = { width: 400, height: 200 }
const img = (extra: Partial<ImageRecord> = {}): ImageRecord => ({ type: 'image', id: 'i', assetId: 'a', left: 100, top: 50, angle: 0, scaleX: 1, scaleY: 1, ...extra })
const close = (a: { x: number; y: number }, b: { x: number; y: number }, digits = 9) => {
  expect(a.x).toBeCloseTo(b.x, digits)
  expect(a.y).toBeCloseTo(b.y, digits)
}

describe('source pixels and the board', () => {
  const placements: Placement[] = [
    { left: 10, top: 20, angle: 0, scaleX: 1, scaleY: 1 },
    { left: -5, top: 300, angle: 30, scaleX: 0.5, scaleY: 0.5 },
    { left: 77, top: -12, angle: -135, scaleX: 2, scaleY: 0.75 },
  ]
  it.each(placements)('sceneToSource inverts sourceToScene (%o)', (at) => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 400, y: 200 },
      { x: 123.4, y: 56.7 },
    ]) {
      close(sceneToSource(sourceToScene(p, at), at), p)
    }
  })

  it('source (0, 0) is the placement point, and a rotation turns the source axes', () => {
    const at: Placement = { left: 10, top: 20, angle: 90, scaleX: 2, scaleY: 2 }
    close(sourceToScene({ x: 0, y: 0 }, at), { x: 10, y: 20 })
    // Rotated 90° clockwise: the source x axis points down the board.
    close(sourceToScene({ x: 5, y: 0 }, at), { x: 10, y: 30 })
    close(sourceToScene({ x: 0, y: 5 }, at), { x: 0, y: 20 })
  })

  it('opening and applying a crop keep the kept pixels where they are, rotated and scaled', () => {
    const shown: Placement = { left: 200, top: 100, angle: 30, scaleX: 0.5, scaleY: 0.5 }
    const crop = { x: 40, y: 30 }
    const full = uncroppedPlacement(shown, crop)
    // The crop's corner in source pixels lands exactly on the displayed top-left.
    close(sourceToScene(crop, full), { x: shown.left, y: shown.top })
    // Any kept pixel: same scene point through either placement.
    const pixel = { x: 90, y: 70 }
    const viaShown = { x: shown.left, y: shown.top }
    const d = sourceToScene({ x: pixel.x - crop.x, y: pixel.y - crop.y }, { ...shown, left: 0, top: 0 })
    close(sourceToScene(pixel, full), { x: viaShown.x + d.x, y: viaShown.y + d.y })
    // And back.
    const again = croppedPlacement(full, crop)
    close({ x: again.left, y: again.top }, { x: shown.left, y: shown.top })
    expect(again).toMatchObject({ angle: 30, scaleX: 0.5, scaleY: 0.5 })
  })
})

describe('the whole image, clamping and rounding', () => {
  it('a crop is the whole image exactly when its edges, rounded to the stored step, are the image edges', () => {
    expect(isWholeImage(undefined, SIZE)).toBe(true)
    expect(isWholeImage({ x: 0, y: 0, width: 400, height: 200 }, SIZE)).toBe(true)
    expect(isWholeImage({ x: 0.004, y: 0, width: 399.996, height: 200.004 }, SIZE)).toBe(true) // rounds to the image edges
    expect(isWholeImage({ x: 0.01, y: 0, width: 399.99, height: 200 }, SIZE)).toBe(false) // one stored step in: a crop
    expect(isWholeImage({ x: 0, y: 0, width: 400, height: 199.99 }, SIZE)).toBe(false)
    expect(isWholeImage({ x: 0.1, y: 0, width: 399.9, height: 200 }, SIZE)).toBe(false)
  })

  it("Astra's case: one stored step off the whole image is kept (10 x 100 source, x 0.01, width 9.98)", () => {
    expect(storedCrop({ x: 0.01, y: 0, width: 9.98, height: 100 }, { width: 10, height: 100 })).toEqual({ x: 0.01, y: 0, width: 9.98, height: 100 })
  })

  it('rounds the edges, not the sides, so a stored crop never reaches outside the image', () => {
    // A 240 px wide image cropped 0.125 px in from the left: the old rounding stored x 0.13, width 239.88 (right edge 240.01).
    const c = storedCrop({ x: 0.125, y: 0, width: 239.875, height: 160 }, { width: 240, height: 160 })!
    expect(c).toEqual({ x: 0.13, y: 0, width: 239.87, height: 160 }) // right edge exactly 240
    expect(storedCrop({ x: 1.23456, y: 0.004, width: 10.005001, height: 50 }, SIZE)).toEqual({ x: 1.23, y: 0, width: 10.01, height: 50 })
    // Narrower than the stored step: keeps its own positive side instead of collapsing to zero.
    expect(storedCrop({ x: 5.001, y: 0, width: 0.003, height: 50 }, SIZE)).toEqual({ x: 5, y: 0, width: 0.003, height: 50 })
  })

  it('over random rectangles inside an image: the stored crop lies inside it, and storing or clamping it again changes nothing', () => {
    const r = rng(21)
    for (let i = 0; i < 5000; i++) {
      const size = { width: Math.max(1, Math.round(Math.exp(r() * Math.log(9000)))), height: Math.max(1, Math.round(Math.exp(r() * Math.log(9000)))) }
      const w = r() * size.width
      const h = r() * size.height
      const rect = { x: r() * (size.width - w), y: r() * (size.height - h), width: w, height: h }
      const c = storedCrop(rect, size)
      if (!c) continue
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.y).toBeGreaterThanOrEqual(0)
      expect(c.width).toBeGreaterThan(0)
      expect(c.height).toBeGreaterThan(0)
      expect(c.x + c.width).toBeLessThanOrEqual(size.width + 1e-9)
      expect(c.y + c.height).toBeLessThanOrEqual(size.height + 1e-9)
      expect(clampCrop(c, size)).toEqual(c)
      expect(storedCrop(c, size)).toEqual(c)
    }
  })

  it('clamps a stored crop to the decoded image; nothing left, or the whole image, is no crop', () => {
    expect(clampCrop(undefined, SIZE)).toBeUndefined()
    expect(clampCrop({ x: 10, y: 10, width: 100, height: 50 }, SIZE)).toEqual({ x: 10, y: 10, width: 100, height: 50 })
    expect(clampCrop({ x: 300, y: 150, width: 500, height: 500 }, SIZE)).toEqual({ x: 300, y: 150, width: 100, height: 50 })
    expect(clampCrop({ x: 400, y: 0, width: 10, height: 10 }, SIZE)).toBeUndefined()
    expect(clampCrop({ x: 900, y: 900, width: 10, height: 10 }, SIZE)).toBeUndefined()
    expect(clampCrop({ x: 0, y: 0, width: 1000, height: 1000 }, SIZE)).toBeUndefined()
  })

})

describe('handles', () => {
  const rect = { x: 100, y: 50, width: 200, height: 100 }
  it('finds corners first, then sides along the border, then the inside', () => {
    expect(hitCropHandle({ x: 103, y: 47 }, rect, 8, 8)).toBe('tl')
    expect(hitCropHandle({ x: 300, y: 150 }, rect, 8, 8)).toBe('br')
    expect(hitCropHandle({ x: 297, y: 55 }, rect, 8, 8)).toBe('tr')
    expect(hitCropHandle({ x: 100, y: 150 }, rect, 8, 8)).toBe('bl')
    expect(hitCropHandle({ x: 200, y: 52 }, rect, 8, 8)).toBe('t')
    expect(hitCropHandle({ x: 150, y: 146 }, rect, 8, 8)).toBe('b')
    expect(hitCropHandle({ x: 94, y: 100 }, rect, 8, 8)).toBe('l')
    expect(hitCropHandle({ x: 306, y: 120 }, rect, 8, 8)).toBe('r')
    expect(hitCropHandle({ x: 200, y: 100 }, rect, 8, 8)).toBe('move')
    expect(hitCropHandle({ x: 50, y: 100 }, rect, 8, 8)).toBeNull()
    expect(hitCropHandle({ x: 200, y: 170 }, rect, 8, 8)).toBeNull()
    // Beyond the border band along an axis: not a side.
    expect(hitCropHandle({ x: 320, y: 100 }, rect, 8, 8)).toBeNull()
  })

  it('uses a separate tolerance per axis (a fixed screen distance at a non-uniform scale)', () => {
    expect(hitCropHandle({ x: 100 - 15, y: 100 }, rect, 20, 2)).toBe('l')
    expect(hitCropHandle({ x: 200, y: 50 - 15 }, rect, 20, 2)).toBeNull()
  })

  it('a box smaller than the tolerance still gives the nearer edge', () => {
    const tiny = { x: 10, y: 10, width: 4, height: 4 }
    expect(hitCropHandle({ x: 10.5, y: 10.5 }, tiny, 8, 8)).toBe('tl')
    expect(hitCropHandle({ x: 13.5, y: 13.5 }, tiny, 8, 8)).toBe('br')
  })
})

describe('dragging the crop rectangle', () => {
  const start = { x: 100, y: 50, width: 200, height: 100 }
  it('moves the whole box, clamped inside the image', () => {
    expect(dragCropRect(start, 'move', 30, -20, SIZE, 8, 8)).toEqual({ x: 130, y: 30, width: 200, height: 100 })
    expect(dragCropRect(start, 'move', 1000, 1000, SIZE, 8, 8)).toEqual({ x: 200, y: 100, width: 200, height: 100 })
    expect(dragCropRect(start, 'move', -1000, -1000, SIZE, 8, 8)).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('a side moves only its own edge; a corner moves two; free aspect', () => {
    expect(dragCropRect(start, 'l', 20, 999, SIZE, 8, 8)).toEqual({ x: 120, y: 50, width: 180, height: 100 })
    expect(dragCropRect(start, 'r', 40, 0, SIZE, 8, 8)).toEqual({ x: 100, y: 50, width: 240, height: 100 })
    expect(dragCropRect(start, 't', 0, -30, SIZE, 8, 8)).toEqual({ x: 100, y: 20, width: 200, height: 130 })
    expect(dragCropRect(start, 'b', 0, 10, SIZE, 8, 8)).toEqual({ x: 100, y: 50, width: 200, height: 110 })
    expect(dragCropRect(start, 'tl', -10, 20, SIZE, 8, 8)).toEqual({ x: 90, y: 70, width: 210, height: 80 })
    expect(dragCropRect(start, 'br', -50, 30, SIZE, 8, 8)).toEqual({ x: 100, y: 50, width: 150, height: 130 })
  })

  it('never leaves the image', () => {
    expect(dragCropRect(start, 'tl', -500, -500, SIZE, 8, 8)).toEqual({ x: 0, y: 0, width: 300, height: 150 })
    expect(dragCropRect(start, 'br', 500, 500, SIZE, 8, 8)).toEqual({ x: 100, y: 50, width: 300, height: 150 })
  })

  it('never flips and keeps the minimum size, whichever way a handle is dragged past its anchor', () => {
    expect(dragCropRect(start, 'l', 500, 0, SIZE, 8, 6)).toEqual({ x: 292, y: 50, width: 8, height: 100 })
    expect(dragCropRect(start, 'r', -500, 0, SIZE, 8, 6)).toEqual({ x: 100, y: 50, width: 8, height: 100 })
    expect(dragCropRect(start, 't', 0, 500, SIZE, 8, 6)).toEqual({ x: 100, y: 144, width: 200, height: 6 })
    expect(dragCropRect(start, 'b', 0, -500, SIZE, 8, 6)).toEqual({ x: 100, y: 50, width: 200, height: 6 })
    expect(dragCropRect(start, 'br', -999, -999, SIZE, 8, 6)).toEqual({ x: 100, y: 50, width: 8, height: 6 })
  })

  it('the minimum side is 8 scene units as displayed, at least one source pixel, capped by the image and the starting side', () => {
    expect(minCropSide(1, 400, 200)).toBe(MIN_CROP_SCENE)
    expect(minCropSide(0.5, 400, 200)).toBe(16) // a half-size image: 16 source pixels show as 8 units
    expect(minCropSide(4, 400, 200)).toBe(2)
    expect(minCropSide(100, 400, 200)).toBe(1)
    expect(minCropSide(0.01, 400, 200)).toBe(200) // never more than the side was
    expect(minCropSide(0.01, 300, 400)).toBe(300) // nor more than the image
    expect(minCropSide(-0.5, 400, 200)).toBe(16)
  })
})

describe('Fit and Fill maths', () => {
  it('largest centred crop for an aspect ratio', () => {
    expect(largestCentredCrop(SIZE, 1)).toEqual({ x: 100, y: 0, width: 200, height: 200 })
    expect(largestCentredCrop(SIZE, 4)).toEqual({ x: 0, y: 50, width: 400, height: 100 })
    expect(largestCentredCrop(SIZE, 2)).toEqual({ x: 0, y: 0, width: 400, height: 200 })
    expect(largestCentredCrop(SIZE, 0)).toEqual({ x: 0, y: 0, width: 400, height: 200 })
  })

  it('fit-inside scale', () => {
    expect(fitInsideScale(SIZE, { width: 200, height: 200 })).toBe(0.5)
    expect(fitInsideScale(SIZE, { width: 800, height: 100 })).toBe(0.5)
  })

  it('the displayed box of a record, cropped and rotated', () => {
    expect(displayBox(img(), SIZE)).toEqual({ centre: { x: 300, y: 150 }, width: 400, height: 200, angle: 0 })
    const b = displayBox(img({ crop: { x: 10, y: 10, width: 100, height: 60 }, scaleX: 2, scaleY: 2 }), SIZE)
    expect(b).toMatchObject({ width: 200, height: 120 })
    expect(b.centre).toEqual({ x: 200, y: 110 })
    const r = displayBox(img({ angle: 90 }), SIZE)
    close(r.centre, { x: 0, y: 250 })
  })

  it('Fill keeps the box exactly and covers it with the largest centred crop at one scale', () => {
    // An off-centre square crop of a 400x200 image, shown at 0.5: a 50x50 box.
    const rec = img({ crop: { x: 0, y: 0, width: 100, height: 100 }, scaleX: 0.5, scaleY: 0.5 })
    const out = fillRecord(rec, SIZE)
    expect(out.crop).toEqual({ x: 100, y: 0, width: 200, height: 200 })
    expect(out.scaleX).toBe(0.25)
    expect(out.scaleY).toBe(0.25)
    expect(displayBox(out, SIZE)).toEqual(displayBox(rec, SIZE))
    expect(out).toMatchObject({ id: 'i', assetId: 'a', angle: 0 })
  })

  it('Fill makes a non-uniform scale uniform and keeps a rotated box exactly', () => {
    const rec = img({ angle: 30, scaleX: 1, scaleY: 0.5 }) // shown 400x100
    const out = fillRecord(rec, SIZE)
    expect(out.crop).toEqual({ x: 0, y: 50, width: 400, height: 100 })
    expect(out.scaleX).toBe(1)
    expect(out.scaleY).toBe(1)
    const a = displayBox(rec, SIZE)
    const b = displayBox(out, SIZE)
    close(b.centre, a.centre, 2)
    expect(b.width).toBeCloseTo(a.width, 6)
    expect(b.height).toBeCloseTo(a.height, 6)
  })

  it('Fill of an uncropped image at a uniform scale changes nothing (no crop key)', () => {
    const rec = img({ scaleX: 0.3, scaleY: 0.3 })
    const out = fillRecord(rec, SIZE)
    expect(out).toEqual(rec)
    expect(out).not.toHaveProperty('crop')
  })

  it('Fit shows the whole image inside the box, centred, same angle, and removes the crop', () => {
    const rec = img({ crop: { x: 100, y: 0, width: 200, height: 200 }, scaleX: 1, scaleY: 1 }) // a 200x200 box
    const out = fitRecord(rec, SIZE)
    expect(out).not.toHaveProperty('crop')
    expect(out.scaleX).toBe(0.5)
    expect(out.scaleY).toBe(0.5)
    const before = displayBox(rec, SIZE)
    const after = displayBox(out, SIZE)
    expect(after.centre).toEqual(before.centre)
    expect(after).toMatchObject({ width: 200, height: 100, angle: 0 })
    expect(out.left).toBe(100)
    expect(out.top).toBe(100)
  })

  it('Fit keeps a rotated box centred', () => {
    const rec = img({ angle: 30, crop: { x: 100, y: 0, width: 200, height: 200 } })
    const out = fitRecord(rec, SIZE)
    close(displayBox(out, SIZE).centre, displayBox(rec, SIZE).centre, 2)
    expect(out.angle).toBe(30)
  })

  it('Fit of an uncropped image at a uniform scale changes nothing', () => {
    expect(fitRecord(img({ scaleX: 0.3, scaleY: 0.3 }), SIZE)).toEqual(img({ scaleX: 0.3, scaleY: 0.3 }))
  })

  it('does not change the record it is given', () => {
    const rec = img({ crop: { x: 0, y: 0, width: 100, height: 100 } })
    const copy = structuredClone(rec)
    fillRecord(rec, SIZE)
    fitRecord(rec, SIZE)
    expect(rec).toEqual(copy)
  })
})

// ---- seeded sweeps --------------------------------------------------------------------------
/** A small seeded generator (mulberry32), so a failure can be reproduced. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** Records as they can be stored: positions to 2 decimals, scales to 5, a valid rounded crop or none. */
function sample(seed: number, n: number): Array<{ rec: ImageRecord; size: { width: number; height: number } }> {
  const r = rng(seed)
  const between = (lo: number, hi: number) => lo + (hi - lo) * r()
  const logBetween = (lo: number, hi: number) => Math.exp(between(Math.log(lo), Math.log(hi)))
  const out = []
  for (let i = 0; i < n; i++) {
    const kind = i % 4
    // Ordinary, tiny, huge, and extreme aspect ratios.
    const size =
      kind === 0
        ? { width: Math.round(between(50, 1200)), height: Math.round(between(50, 1200)) }
        : kind === 1
          ? { width: Math.round(between(1, 12)), height: Math.round(between(1, 12)) }
          : kind === 2
            ? { width: Math.round(between(2000, 9000)), height: Math.round(between(2000, 9000)) }
            : r() < 0.5
              ? { width: Math.round(between(1, 40)), height: Math.round(between(2000, 6000)) }
              : { width: Math.round(between(2000, 6000)), height: Math.round(between(1, 40)) }
    const s = roundPositiveLike(logBetween(0.002, 25))
    const uniform = r() < 0.6
    const rec = img({
      left: Math.round(between(-5000, 5000) * 100) / 100,
      top: Math.round(between(-5000, 5000) * 100) / 100,
      angle: r() < 0.5 ? 0 : Math.round(between(-180, 180) * 100) / 100,
      scaleX: s,
      scaleY: uniform ? s : roundPositiveLike(s * logBetween(0.2, 5)),
    })
    if (r() < 0.6) {
      const w = Math.max(0.01, Math.round(between(0.01, size.width) * 100) / 100)
      const h = Math.max(0.01, Math.round(between(0.01, size.height) * 100) / 100)
      const crop = { x: Math.round(between(0, size.width - w) * 100) / 100, y: Math.round(between(0, size.height - h) * 100) / 100, width: w, height: h }
      if (!isWholeImage(crop, size)) rec.crop = crop
    }
    out.push({ rec, size })
  }
  return out
}
const roundPositiveLike = (n: number) => Math.max(0.00001, Math.round(n * 1e5) / 1e5)

describe('Fit and Fill are idempotent and Fill keeps the box (seeded sweep)', () => {
  it('Fill applied twice equals Fill applied once (4000 records)', () => {
    const failures = sample(1, 4000).filter(({ rec, size }) => JSON.stringify(fillRecord(fillRecord(rec, size), size)) !== JSON.stringify(fillRecord(rec, size)))
    expect(failures.slice(0, 3)).toEqual([])
  })

  it('Fit applied twice equals Fit applied once (4000 records)', () => {
    const failures = sample(2, 4000).filter(({ rec, size }) => JSON.stringify(fitRecord(fitRecord(rec, size), size)) !== JSON.stringify(fitRecord(rec, size)))
    expect(failures.slice(0, 3)).toEqual([])
  })

  it('Fill keeps the displayed box to stored precision: centre within 0.01, each side within 0.015 x scale + 0.000005 x the side in source pixels', () => {
    for (const { rec, size } of sample(3, 4000)) {
      const before = displayBox(rec, size)
      const out = fillRecord(rec, size)
      const after = displayBox(out, size)
      const shown = out.crop ?? { width: size.width, height: size.height }
      const tolerance = (side: number) => 0.015 * out.scaleX + 0.000005 * side + 1e-6
      expect(Math.hypot(after.centre.x - before.centre.x, after.centre.y - before.centre.y)).toBeLessThanOrEqual(0.01)
      expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(tolerance(shown.width))
      expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(tolerance(shown.height))
      expect(out.scaleX).toBe(out.scaleY)
      expect(out.angle).toBe(rec.angle)
      if (out.crop) {
        // A valid stored crop: inside the image, rounded as stored, centred to 0.01.
        expect(out.crop.x).toBeGreaterThanOrEqual(0)
        expect(out.crop.y).toBeGreaterThanOrEqual(0)
        expect(out.crop.x + out.crop.width).toBeLessThanOrEqual(size.width + 1e-9)
        expect(out.crop.y + out.crop.height).toBeLessThanOrEqual(size.height + 1e-9)
        expect(storedCrop(out.crop, size)).toEqual(out.crop)
        expect(Math.abs(out.crop.x - (size.width - out.crop.width - out.crop.x))).toBeLessThanOrEqual(0.0100001)
        expect(Math.abs(out.crop.y - (size.height - out.crop.height - out.crop.y))).toBeLessThanOrEqual(0.0100001)
      }
    }
  })

  it("the reviewer's case: 240 x 160 at scale 1, crop {0, 0, 20, 62}: a second Fill changes nothing", () => {
    const size = { width: 240, height: 160 }
    const once = fillRecord(img({ crop: { x: 0, y: 0, width: 20, height: 62 } }), size)
    expect(once.crop).toMatchObject({ y: 0, height: 160 })
    expect(fillRecord(once, size)).toEqual(once)
  })

  it('coverBox centres the crop from its rounded sides and picks the scale that keeps the box closest', () => {
    const { crop, scale } = coverBox({ width: 240, height: 160 }, { width: 20, height: 62 })
    expect(crop).toEqual({ x: 94.2, y: 0, width: 51.61, height: 160 }) // (240 - 51.61) / 2 = 94.195
    // 51.61 x 160 at 0.3875 (from the height) is 19.999 x 62; at 0.38752 (from the width) 20 x 62.003.
    expect(scale).toBe(0.3875)
    expect(coverBox({ width: 400, height: 200 }, { width: 800, height: 400 })).toEqual({ crop: undefined, scale: 2 })
  })
})

describe('replaceRecord: a different picture in the same box', () => {
  const OLD = { width: 400, height: 300 }
  const expectSameBox = (before: ImageRecord, oldSize: { width: number; height: number }, after: ImageRecord, newSize: { width: number; height: number }) => {
    const a = displayBox(before, oldSize)
    const z = displayBox(after, newSize)
    const shown = after.crop ?? newSize
    const tolerance = (side: number) => 0.015 * after.scaleX + 0.000005 * side + 1e-6
    expect(Math.hypot(z.centre.x - a.centre.x, z.centre.y - a.centre.y)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(z.width - a.width)).toBeLessThanOrEqual(tolerance(shown.width))
    expect(Math.abs(z.height - a.height)).toBeLessThanOrEqual(tolerance(shown.height))
    expect(z.angle).toBe(a.angle)
  }

  it('same aspect, different resolution: no crop key, only the scale changes', () => {
    const rec = img({ assetId: 'old', scaleX: 0.5, scaleY: 0.5 }) // 200 x 150 on the board
    const out = replaceRecord(rec, OLD, 'new', { width: 800, height: 600 })
    expect(out).toEqual(img({ assetId: 'new', scaleX: 0.25, scaleY: 0.25 }))
    expect(out).not.toHaveProperty('crop')
  })

  it('a wider picture is cropped at the sides, a taller one at top and bottom, centred, in the same box', () => {
    const rec = img({ assetId: 'old' }) // 400 x 300 box at (100, 50)
    const wide = replaceRecord(rec, OLD, 'w', { width: 800, height: 300 })
    expect(wide).toEqual(img({ assetId: 'w', crop: { x: 200, y: 0, width: 400, height: 300 } }))
    const tall = replaceRecord(rec, OLD, 't', { width: 200, height: 600 })
    expect(tall).toEqual(img({ assetId: 't', crop: { x: 0, y: 225, width: 200, height: 150 }, scaleX: 2, scaleY: 2 }))
    expectSameBox(rec, OLD, wide, { width: 800, height: 300 })
    expectSameBox(rec, OLD, tall, { width: 200, height: 600 })
  })

  it('discards the old crop (it referred to the old pixels), keeps id, owner, lock and angle', () => {
    const rec = img({ assetId: 'old', crop: { x: 10, y: 20, width: 100, height: 100 }, frameId: 'F', locked: true, angle: 30 })
    const out = replaceRecord(rec, OLD, 'new', { width: 640, height: 640 }) // square box, square picture
    expect(out).not.toHaveProperty('crop')
    expect(out).toMatchObject({ id: 'i', assetId: 'new', frameId: 'F', locked: true, angle: 30, scaleX: 0.15625, scaleY: 0.15625 })
    expectSameBox(rec, OLD, out, { width: 640, height: 640 })
  })

  it('a non-uniform legacy scale becomes uniform; tiny and huge pictures keep the box', () => {
    const rec = img({ assetId: 'old', scaleX: 1, scaleY: 0.5, angle: -45 })
    for (const size of [
      { width: 1, height: 1 },
      { width: 3, height: 2000 },
      { width: 9000, height: 7000 },
      { width: 401, height: 299 },
    ]) {
      const out = replaceRecord(rec, OLD, 'new', size)
      expect(out.scaleX).toBe(out.scaleY)
      expectSameBox(rec, OLD, out, size)
    }
  })

  it('keeps the box to stored precision over a seeded sweep, rotated and cropped targets included', () => {
    const r = rng(11)
    for (const { rec, size } of sample(4, 4000)) {
      const newSize = { width: Math.max(1, Math.round(Math.exp(r() * Math.log(9000)))), height: Math.max(1, Math.round(Math.exp(r() * Math.log(9000)))) }
      const out = replaceRecord(rec, size, 'new', newSize)
      expectSameBox(rec, size, out, newSize)
      expect(out.assetId).toBe('new')
      expect(out.scaleX).toBe(out.scaleY)
      if (out.crop) expect(isWholeImage(out.crop, newSize)).toBe(false)
      // What it shows is a Fill of the new picture: Fill straight afterwards changes nothing.
      expect(fillRecord(out, newSize)).toEqual(out)
    }
  })

  it('Fit straight after a replace shows the whole new picture inside the box, centred, with no crop', () => {
    const rec = img({ assetId: 'old' }) // 400 x 300 box, centre (300, 200)
    const out = fitRecord(replaceRecord(rec, OLD, 'w', { width: 800, height: 300 }), { width: 800, height: 300 })
    expect(out).toEqual(img({ assetId: 'w', left: 100, top: 125, scaleX: 0.5, scaleY: 0.5 })) // 400 x 150, centred
  })
})
