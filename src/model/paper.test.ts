import { describe, expect, it } from 'vitest'
import { PAPER_PAD_X_EM, PAPER_PAD_Y_EM, heldFixedHeight, innerText, minFixedHeight, paperPad, paperToggle } from './paper.ts'

/** The centre of a box of `w` × `h` whose top-left corner is at (left, top), turned by `angle` about that corner. */
const centre = (left: number, top: number, w: number, h: number, angle: number) => {
  const r = (angle * Math.PI) / 180
  return { x: left + (w / 2) * Math.cos(r) - (h / 2) * Math.sin(r), y: top + (w / 2) * Math.sin(r) + (h / 2) * Math.cos(r) }
}

describe('paper: padding and the words’ own box', () => {
  it('the padding is in em of the base font size, and only on paper', () => {
    expect(paperPad({ fontSize: 20, surface: 'card' })).toEqual({ x: 20 * PAPER_PAD_X_EM, y: 20 * PAPER_PAD_Y_EM })
    expect(paperPad({ fontSize: 20 })).toEqual({ x: 0, y: 0 })
  })

  it('the words’ box is the sheet less the padding; a bare text is returned as it is', () => {
    const bare = { fontSize: 20, width: 300, minHeight: 100, height: 160 }
    expect(innerText(bare)).toBe(bare)
    expect(innerText({ ...bare, surface: 'card' as const })).toEqual({ ...bare, surface: 'card', width: 300 - 40, minHeight: 100 - 30, height: 160 - 30 })
    // Never below nothing; a fixed height below the least one is drawn at it (60 on paper at 20 px: 30 for the words).
    expect(innerText({ fontSize: 20, width: 10, minHeight: 5, height: 8, surface: 'card' as const })).toMatchObject({ width: 0, minHeight: 0, height: 30 })
  })

  it('the padding is rounded as records are, so the words’ box is exact at a fractional font size', () => {
    expect(paperPad({ fontSize: 28.17, surface: 'card' })).toEqual({ x: 28.17, y: 21.13 })
    expect(innerText({ fontSize: 28.17, width: 360.6, height: 162.38, surface: 'card' as const })).toMatchObject({ width: 304.26, height: 120.12 })
  })

  it('a stored fixed height below the least one is drawn at it, bare or on paper, the record left as it is', () => {
    const bare = { fontSize: 64, width: 300, height: 72 }
    expect(innerText(bare)).toEqual({ ...bare, height: 96 })
    expect(bare.height).toBe(72)
    expect(innerText({ ...bare, surface: 'card' as const }).height).toBe(96) // 192 for the sheet, less 2 × 48
  })
})

describe('paperToggle: the pure Paper button', () => {
  for (const angle of [0, 30, -45, 90, 173]) {
    it(`keeps the box's centre and grows it by the padding on every side, and back (${angle}°)`, () => {
      const box = { left: 120, top: 80, angle, width: 300, fontSize: 18 }
      const h = 140 // the height the words give it
      const on = paperToggle(box, true)
      expect(on.width).toBe(300 + 2 * 18 * PAPER_PAD_X_EM)
      const c0 = centre(box.left, box.top, 300, h, angle)
      const c1 = centre(on.left, on.top, on.width, h + 2 * 18 * PAPER_PAD_Y_EM, angle)
      expect(Math.abs(c1.x - c0.x)).toBeLessThan(0.006)
      expect(Math.abs(c1.y - c0.y)).toBeLessThan(0.006)
      const off = paperToggle({ ...box, ...on }, false)
      expect(Math.abs(off.left - box.left)).toBeLessThanOrEqual(0.01)
      expect(Math.abs(off.top - box.top)).toBeLessThanOrEqual(0.01)
      expect(off.width).toBe(300)
    })
  }

  it('a drawn minimum height and a fixed height follow; absent ones stay absent', () => {
    const on = paperToggle({ left: 0, top: 0, angle: 0, width: 200, minHeight: 60, height: 120, fontSize: 20 }, true)
    expect(on).toEqual({ left: -20, top: -15, width: 240, minHeight: 90, height: 150 })
    expect(paperToggle({ left: 0, top: 0, angle: 0, width: 200, fontSize: 20 }, true)).not.toHaveProperty('minHeight')
    expect(paperToggle({ left: 0, top: 0, angle: 0, width: 200, fontSize: 20 }, true)).not.toHaveProperty('height')
  })

  it('sizes stay positive and are rounded as records are (a scaled font size)', () => {
    const on = paperToggle({ left: 10, top: 10, angle: 0, width: 211.37, fontSize: 27.35 }, true)
    expect(on.width).toBe(Math.round((211.37 + 2 * 27.35) * 100) / 100)
    // A fixed height already below the least one ends at the least one for the new surface.
    expect(paperToggle({ left: 0, top: 0, angle: 0, width: 4, minHeight: 2, height: 3, fontSize: 20 }, false)).toEqual({ left: 20, top: 15, width: 1, minHeight: 0, height: 30 })
    expect(paperToggle({ left: 0, top: 0, angle: 0, width: 300, height: 10, fontSize: 20 }, true).height).toBe(60)
  })

  // The reviewer's case (a corner-scaled box: 28.17 px) and others: fractional sizes, turned boxes;
  // each a box a person can have either way (a fixed height not below the least one on paper, a drawn
  // minimum height not shallower than the margins).
  const BOXES = [
    { left: 140.37, top: 90.11, angle: 0, width: 360.6, minHeight: 77.02, height: 162.38, fontSize: 28.17 },
    { left: -12.5, top: 300.07, angle: 33.3, width: 211.37, height: 99.99, fontSize: 27.35 },
    { left: 401.01, top: -77.77, angle: -137, width: 288.88, minHeight: 40.4, fontSize: 13.33 },
    { left: 5.55, top: 6.66, angle: 179.9, width: 120.01, height: 61.17, fontSize: 17.07 },
    { left: 1000.03, top: 2000.97, angle: 90, width: 640.49, minHeight: 333.33, height: 401.4, fontSize: 63.99 },
  ]
  for (const box of BOXES) {
    it(`ten offs and ons, or ons and offs, give back the box exactly (${box.fontSize} px, ${box.angle}°)`, () => {
      const { fontSize, angle } = box
      const keep = ({ left, top, width, minHeight, height }: typeof box) => JSON.stringify({ left, top, width, minHeight, height })
      let on = { ...box }
      let off = { ...box }
      for (let i = 0; i < 10; i++) {
        on = { ...on, ...paperToggle(on, true) }
        on = { ...on, ...paperToggle(on, false) }
        off = { ...off, ...paperToggle(off, false) }
        off = { ...off, ...paperToggle(off, true) }
      }
      expect(keep(on)).toBe(keep(box))
      expect(keep(off)).toBe(keep(box))
      expect({ fontSize, angle }).toEqual({ fontSize: box.fontSize, angle: box.angle })
    })
  }
})

describe('the words’ viewport across a toggle', () => {
  // The scene layer keeps a fixed-height text where it was scrolled only while this number is exactly
  // the same (a changed fixed height starts at the top); these sizes are ones where H − 2 × margin is
  // not exact in floating point, so only rounding as records are keeps it the same.
  for (const [fontSize, height] of [[10, 32.13], [10, 33.26], [10, 42.3], [28.17, 162.38], [17.07, 61.17]] as const) {
    it(`is the same number before and after, both ways (${fontSize} px, ${height})`, () => {
      const paper = { fontSize, width: 300, height, surface: 'card' as const }
      const off = paperToggle({ left: 0, top: 0, angle: 0, ...paper }, false)
      expect(Object.is(innerText({ fontSize, width: off.width, height: off.height }).height, innerText(paper).height)).toBe(true)
      const bare = { fontSize, width: 300, height: Math.round((height - 20) * 100) / 100 }
      const on = paperToggle({ left: 0, top: 0, angle: 0, ...bare }, true)
      expect(Object.is(innerText({ ...bare, ...on, surface: 'card' as const }).height, innerText(bare).height)).toBe(true)
    })
  }
})

describe('the least fixed height', () => {
  it('on paper it is the bare one plus the two stored margins, so the words keep the same least viewport', () => {
    for (const fs of [6, 17, 20, 24, 25.3, 28.17, 64]) {
      expect(minFixedHeight(fs, 'card')).toBe(Math.round((minFixedHeight(fs) + 2 * paperPad({ fontSize: fs, surface: 'card' }).y) * 100) / 100)
    }
    expect(minFixedHeight(24)).toBe(36)
    expect(minFixedHeight(24, 'card')).toBe(72)
    expect(minFixedHeight(64, 'card')).toBe(192)
  })

  it('a height is held to it and never lowered by it', () => {
    expect(heldFixedHeight(72, 64)).toBe(96)
    expect(heldFixedHeight(72, 64, 'card')).toBe(192)
    expect(heldFixedHeight(500, 64, 'card')).toBe(500)
  })
})
