import { expect, it } from 'vitest'
import { captionDetaches, captionPlacement, followsDrag } from './captions.ts'
import type { CaptionSide } from './types.ts'

const bounds = { left: 10.234, top: 20.111, right: 100.878, bottom: 50.995 }
const caption = { width: 81.87, height: 34.561, fontSize: 24.24 }

it.each([
  [undefined, { left: 10.23, top: 61, width: 90.64 }],
  ['top', { left: 10.23, top: -24.45, width: 90.64 }],
  ['left', { left: -81.64, top: 20.11, width: 81.87 }],
  ['right', { left: 110.88, top: 20.11, width: 81.87 }],
] satisfies [CaptionSide | undefined, { left: number; top: number; width: number }][])('places on side %s at stored precision, repeatedly', (side, expected) => {
  const placed = captionPlacement(bounds, side, caption)
  expect(placed).toEqual(expected)
  expect(captionPlacement(bounds, side, { ...caption, ...placed })).toEqual(placed)
})

it('keeps a sub-cent width positive in storage', () => {
  expect(captionPlacement({ left: 0, right: 0.004, top: 0, bottom: 10 }, undefined, caption).width).toBe(0.004)
})

it('detaches a directly transformed caption when its image is absent or both rotated', () => {
  expect(captionDetaches('image', new Set(['caption']), false)).toBe(true)
  expect(captionDetaches('image', new Set(['caption', 'image']), false)).toBe(false)
  expect(captionDetaches('image', new Set(['caption', 'image']), true)).toBe(true)
})

it('follows when its image or frame moves, except through an explicit selection', () => {
  const moving = { direct: new Set(['frame', 'image']), frames: new Set(['frame']), images: new Set(['image']) }
  expect(followsDrag({ id: 'caption', frameId: 'frame', captionOf: 'image' }, moving)).toBe(true)
  expect(followsDrag({ id: 'caption', captionOf: 'image' }, moving)).toBe(true)
  expect(followsDrag({ id: 'caption', frameId: 'frame' }, moving)).toBe(true)
  expect(followsDrag({ id: 'image', frameId: 'frame' }, moving)).toBe(false)
  expect(followsDrag({ id: 'loose' }, moving)).toBe(false)
})
