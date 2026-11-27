import { ActiveSelection } from 'fabric'
import { describe, expect, it } from 'vitest'
import { minFixedHeight } from '../model/paper.ts'
import type { FrameRecord, ImageRecord, TextRecord } from '../model/types.ts'
import { createFrameProxy, createProxy, toFrameRecord, toRecord } from './objects.ts'

/**
 * Reading an object that nothing changed gives back its record exactly, at any angle (real Fabric:
 * a turned object's matrix decomposes to a scale a hair off 1, which must never count as a scale).
 * A seeded sweep over angles and sizes, for texts (bare and paper, fixed heights below and above
 * their least one, drawn minimum heights), images and frames, alone and inside a selection.
 */

/** A small deterministic generator (mulberry32), so a failure names the same case every run. */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const r2 = (n: number) => Math.round(n * 100) / 100
/** An angle as the board stores one (Fabric's decomposition gives (−180°, 180°]; a stored angle outside it is read as its equivalent there). */
const anyAngle = (next: () => number) => r2(179.99 - next() * 359.98)

const picture = { naturalWidth: 640, naturalHeight: 480, width: 640, height: 480 } as unknown as HTMLImageElement

function texts(n: number, seed: number): TextRecord[] {
  const next = random(seed)
  const out: TextRecord[] = []
  for (let i = 0; i < n; i++) {
    const fontSize = [8, 12.5, 18, 24, 27.35, 64, 133.33][i % 7]!
    const angle = i < 12 ? [3, 70, -70, 45, 90, 135, 179.99, -179.5, 0.01, 180, 33.33, -3][i]! : anyAngle(next)
    const rec: TextRecord = { type: 'text', id: `t${i}`, left: r2(next() * 4000 - 2000), top: r2(next() * 4000 - 2000), angle, text: 'I', fontSize, width: r2(40 + next() * 900) }
    if (i % 2 === 0) rec.surface = 'card'
    // Half have a fixed height, and of those some below their least one (as an older build stored them).
    if (i % 4 < 2) rec.height = i % 8 < 4 ? 72 : r2(fontSize * 4 + next() * 400)
    if (i % 3 === 0) rec.minHeight = r2(next() * 300)
    out.push(rec)
  }
  return out
}

function images(n: number, seed: number): ImageRecord[] {
  const next = random(seed)
  return Array.from({ length: n }, (_, i) => ({
    type: 'image' as const,
    id: `i${i}`,
    assetId: 'a',
    left: r2(next() * 4000 - 2000),
    top: r2(next() * 4000 - 2000),
    angle: i < 3 ? [3, 70, -70][i]! : anyAngle(next),
    scaleX: Math.round((0.05 + next() * 3) * 1e5) / 1e5,
    scaleY: Math.round((0.05 + next() * 3) * 1e5) / 1e5,
  }))
}

describe('reading an unchanged object gives back its record exactly, at any angle', () => {
  it('texts, alone: 300 angles and sizes', () => {
    for (const rec of texts(300, 1)) {
      const obj = createProxy(rec, () => undefined)!
      expect(toRecord(obj), JSON.stringify(rec)).toEqual(rec)
      expect(toRecord(obj), 'read twice').toEqual(rec)
    }
  })

  it('images, alone: 200 angles and scales', () => {
    for (const rec of images(200, 2)) {
      const obj = createProxy(rec, () => picture)!
      expect(toRecord(obj), JSON.stringify(rec)).toEqual(rec)
    }
  })

  it('frames (never turned): 100 places and sizes', () => {
    const next = random(3)
    for (let i = 0; i < 100; i++) {
      const rec: FrameRecord = { id: `f${i}`, name: 'Spread', left: r2(next() * 4000 - 2000), top: r2(next() * 4000 - 2000), width: r2(1 + next() * 3000), height: r2(1 + next() * 3000) }
      expect(toFrameRecord(createFrameProxy(rec)), JSON.stringify(rec)).toEqual(rec)
    }
  })

  it('texts and images inside an unscaled selection, turned or not', () => {
    const recs = [...texts(60, 4), ...images(20, 5)]
    for (let i = 0; i < recs.length; i += 2) {
      const pair = recs.slice(i, i + 2)
      const objs = pair.map((r) => createProxy(r, () => picture)!)
      const selection = new ActiveSelection(objs)
      pair.forEach((r, k) => expect(toRecord(objs[k]!), JSON.stringify(r)).toEqual(r))
      selection.removeAll()
    }
  })
})

describe('a selection being scaled', () => {
  it('reads each text with its fixed height held to the least one for its scaled size (mid-gesture, before the texts are settled)', () => {
    const bare: TextRecord = { type: 'text', id: 'bare', left: 100, top: 100, angle: 0, text: 'one', fontSize: 24, width: 200, height: 36 }
    const paper: TextRecord = { ...bare, id: 'paper', left: 360, height: 72, surface: 'card' }
    const objs = [bare, paper].map((r) => createProxy(r, () => undefined)!)
    const selection = new ActiveSelection(objs)
    // About 1.9% larger: the heights scaled alone fall just under the least ones for the scaled size.
    selection.set({ scaleX: 1.019, scaleY: 1.019 })
    for (const obj of objs) {
      const rec = toRecord(obj) as TextRecord
      expect(rec.fontSize).toBeCloseTo(24 * 1.019, 2)
      expect(rec.height, rec.id).toBe(minFixedHeight(rec.fontSize, rec.surface))
    }
    selection.removeAll()
  })
})
