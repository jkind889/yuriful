import { describe, expect, it } from 'vitest'
import { layoutOffsets } from './layout.ts'
import type { Layout } from './layout.ts'

const boxes = [
  { left: 10, right: 30, top: 80, bottom: 100 },
  { left: 60, right: 100, top: 40, bottom: 90 },
  { left: 130, right: 160, top: 0, bottom: 10 },
]

describe('layout offsets', () => {
  it.each([
    ['left', 'x', [0, -50, -120]],
    ['center-x', 'x', [65, 5, -60]],
    ['right', 'x', [130, 60, 0]],
    ['top', 'y', [-80, -40, 0]],
    ['center-y', 'y', [-40, -15, 45]],
    ['bottom', 'y', [0, 10, 90]],
    ['space-x', 'x', [0, 0, 0]],
    ['space-y', 'y', [0, -20, 0]],
  ] as const)('computes %s from displayed boxes', (op, axis, amounts) => {
    expect(layoutOffsets(boxes, op)).toEqual({ axis, amounts })
  })

  it('keeps unequal end items fixed and spaces the gaps, regardless of input order', () => {
    const right = { ...boxes[2]!, left: 170, right: 200 }
    expect(layoutOffsets([right, boxes[0]!, boxes[1]!], 'space-x')).toEqual({ axis: 'x', amounts: [0, 0, 20] })
  })

  it('requires enough items and room without moving the outer items', () => {
    expect(layoutOffsets(boxes.slice(0, 1), 'left')).toBeNull()
    expect(layoutOffsets(boxes.slice(0, 2), 'space-y')).toBeNull()
    const same = boxes.map((b) => ({ ...b, left: 0, right: 40 }))
    for (const op of ['space-x', 'space-y'] satisfies Layout[]) {
      expect(layoutOffsets(same.map((b) => ({ ...b, top: 0, bottom: 40 })), op)).toBeNull()
    }
  })
})
