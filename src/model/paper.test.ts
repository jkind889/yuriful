import { describe, expect, it } from 'vitest'
import { PAPER_PAD_X_EM, PAPER_PAD_Y_EM, innerText, paperPad, paperToggle } from './paper.ts'

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
    // Never below nothing (a fixed height never below one).
    expect(innerText({ fontSize: 20, width: 10, minHeight: 5, height: 8, surface: 'card' as const })).toMatchObject({ width: 0, minHeight: 0, height: 1 })
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
    expect(paperToggle({ left: 0, top: 0, angle: 0, width: 4, minHeight: 2, height: 3, fontSize: 20 }, false)).toEqual({ left: 20, top: 15, width: 1, minHeight: 0, height: 1 })
  })
})
