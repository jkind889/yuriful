import { describe, expect, it } from 'vitest'
import { overlapsFrame } from './renderFrameBitmap.ts'

/** The corners of a box at (left, top), `width` × `height`, turned by `angle` degrees about its top-left. */
const box = (left: number, top: number, width: number, height: number, angle = 0) => {
  const r = (angle * Math.PI) / 180
  return [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => ({ x: left + x! * Math.cos(r) - y! * Math.sin(r), y: top + x! * Math.sin(r) + y! * Math.cos(r) }))
}
const frame = { left: 100, top: 100, width: 200, height: 100 }

describe('overlapsFrame: what a frame preview draws', () => {
  it('draws a box inside, across an edge, around the frame or touching it; not one beside it', () => {
    expect(overlapsFrame(box(150, 120, 20, 20), frame)).toBe(true)
    expect(overlapsFrame(box(280, 190, 50, 50), frame)).toBe(true)
    expect(overlapsFrame(box(0, 0, 500, 500), frame)).toBe(true) // contains the frame: no corner inside it
    expect(overlapsFrame(box(300, 150, 10, 10), frame)).toBe(true) // touching the right edge
    expect(overlapsFrame(box(301, 150, 10, 10), frame)).toBe(false)
    expect(overlapsFrame(box(150, 10, 20, 80), frame)).toBe(false)
    expect(overlapsFrame(box(2000, 2000, 20, 20), frame)).toBe(false)
  })

  it('a turned box is judged by its own sides, not its bounding box', () => {
    // Turned 45° just beyond the frame's top-right corner: its bounding box overlaps the frame, the box does not.
    const near = box(330, 27.6, 60, 60, 45)
    const xs = near.map((p) => p.x)
    const ys = near.map((p) => p.y)
    expect(Math.min(...xs) < 300 && Math.max(...ys) > 100).toBe(true)
    expect(overlapsFrame(near, frame)).toBe(false)
    expect(overlapsFrame(box(310, 27.6, 60, 60, 45), frame)).toBe(true)
  })
})
