import { describe, expect, it } from 'vitest'
import { CANVAS_OWNER, WHEEL_LATCH_MS, WheelLatch, boxHolds, canScroll, pickWheelOwner } from './wheelGesture.ts'
import type { WheelFacts, WheelOwner } from './wheelGesture.ts'

const card = (id: string): WheelOwner => ({ kind: 'card', id })

/** A wheel down over a fixed-height text `c` scrolled to 100 of 400, on a free board. */
const facts = (patch: Partial<WheelFacts> = {}): WheelFacts => ({
  free: true,
  shiftKey: false,
  deltaX: 0,
  deltaY: 100,
  frameOverlay: false,
  front: { id: 'c', scroll: { top: 100, max: 400 } },
  ...patch,
})

describe('pickWheelOwner: who a new wheel gesture belongs to (plan Section 4, the four conditions)', () => {
  it('a fixed-height text with more text in the wheel’s direction owns it', () => {
    expect(pickWheelOwner(facts())).toEqual(card('c'))
    expect(pickWheelOwner(facts({ deltaY: -3 }))).toEqual(card('c'))
  })

  it('(1) the board must be free: loading, the hand tool, Space, a gesture, a pan or a crop give it to the canvas', () => {
    expect(pickWheelOwner(facts({ free: false }))).toEqual(CANVAS_OWNER)
  })

  it('(2) Shift, or a wheel that is mostly sideways, pans', () => {
    expect(pickWheelOwner(facts({ shiftKey: true }))).toEqual(CANVAS_OWNER)
    expect(pickWheelOwner(facts({ deltaX: 101, deltaY: 100 }))).toEqual(CANVAS_OWNER)
    // As much down as sideways still counts as vertical.
    expect(pickWheelOwner(facts({ deltaX: 100, deltaY: 100 }))).toEqual(card('c'))
  })

  it('(3) a frame label or outline under the pointer, or no text in front, pans', () => {
    expect(pickWheelOwner(facts({ frameOverlay: true }))).toEqual(CANVAS_OWNER)
    expect(pickWheelOwner(facts({ front: null }))).toEqual(CANVAS_OWNER)
    // Something else in front (an image, a frame's interior, a text that grows with its words): no scroll.
    expect(pickWheelOwner(facts({ front: { id: 'img', scroll: null } }))).toEqual(CANVAS_OWNER)
  })

  it('(4) a text whose words all fit, or that is at its end in the wheel’s direction, pans', () => {
    expect(pickWheelOwner(facts({ front: { id: 'c', scroll: { top: 0, max: 0 } } }))).toEqual(CANVAS_OWNER)
    expect(pickWheelOwner(facts({ front: { id: 'c', scroll: { top: 400, max: 400 } } }))).toEqual(CANVAS_OWNER)
    expect(pickWheelOwner(facts({ deltaY: -100, front: { id: 'c', scroll: { top: 0, max: 400 } } }))).toEqual(CANVAS_OWNER)
    // At the bottom, a wheel up still scrolls it back; at the top, a wheel down.
    expect(pickWheelOwner(facts({ deltaY: -100, front: { id: 'c', scroll: { top: 400, max: 400 } } }))).toEqual(card('c'))
    expect(pickWheelOwner(facts({ front: { id: 'c', scroll: { top: 0, max: 400 } } }))).toEqual(card('c'))
    // A wheel with no vertical movement has no direction to scroll in.
    expect(pickWheelOwner(facts({ deltaY: 0 }))).toEqual(CANVAS_OWNER)
  })

  it('canScroll: any room at all counts, a fraction or a single pixel included (the fades and the thumb use the same answer)', () => {
    expect(canScroll({ top: 399.6, max: 400 }, 1)).toBe(true)
    expect(canScroll({ top: 400, max: 400 }, 1)).toBe(false)
    expect(canScroll({ top: 0.4, max: 400 }, -1)).toBe(true)
    expect(canScroll({ top: 0, max: 400 }, -1)).toBe(false)
    // 785 px of text in a 784 px box: one pixel to scroll.
    expect(canScroll({ top: 0, max: 1 }, 1)).toBe(true)
    expect(canScroll({ top: 1, max: 1 }, 1)).toBe(false)
    expect(canScroll({ top: 1, max: 1 }, -1)).toBe(true)
    expect(canScroll({ top: 0, max: 0 }, 1)).toBe(false)
    expect(pickWheelOwner(facts({ front: { id: 'c', scroll: { top: 0, max: 1 } } }))).toEqual(card('c'))
  })

  it('boxHolds: a point in a box turned, scaled and moved, in its own coordinates, edges included', () => {
    // A 250 × 140 box turned −45° about its centre at (300, 200), as Fabric's calcTransformMatrix gives it.
    const r = (-45 * Math.PI) / 180
    const m = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 300, 200]
    const at = (lx: number, ly: number) => ({ x: 300 + lx * Math.cos(r) - ly * Math.sin(r), y: 200 + lx * Math.sin(r) + ly * Math.cos(r) })
    expect(boxHolds(m, 250, 140, at(0, 0))).toBe(true)
    expect(boxHolds(m, 250, 140, at(-125, -70))).toBe(true) // the top-left corner itself
    expect(boxHolds(m, 250, 140, at(125, 70))).toBe(true)
    expect(boxHolds(m, 250, 140, at(-125.01, 0))).toBe(false)
    expect(boxHolds(m, 250, 140, at(0, 70.01))).toBe(false)
    // The screen row through the top-left corner, just inside: the case the canvas library's corner crossing test missed.
    const corner = at(-125, -70)
    expect(boxHolds(m, 250, 140, { x: corner.x + 5, y: corner.y })).toBe(true)
    expect(boxHolds(m, 250, 140, { x: corner.x - 5, y: corner.y })).toBe(false)
    // Scaled (an image at scale 2): its untransformed size and the matrix's scale together.
    expect(boxHolds([2, 0, 0, 2, 0, 0], 10, 10, { x: 10, y: -10 })).toBe(true)
    expect(boxHolds([2, 0, 0, 2, 0, 0], 10, 10, { x: 10.1, y: 0 })).toBe(false)
    // A degenerate matrix holds nothing.
    expect(boxHolds([0, 0, 0, 0, 0, 0], 10, 10, { x: 0, y: 0 })).toBe(false)
  })
})

describe('WheelLatch: a scroll belongs to whatever it started on (fake clock)', () => {
  it('the latch is 180 ms, one named constant', () => {
    expect(WHEEL_LATCH_MS).toBe(180)
  })

  it('events less than the latch apart are one gesture: only the first picks, the rest follow it wherever the pointer is', () => {
    const latch = new WheelLatch()
    const picks: number[] = []
    let under: WheelOwner = card('c')
    const pick = () => {
      picks.push(1)
      return under
    }
    expect(latch.route(1000, false, pick)).toEqual(card('c'))
    under = CANVAS_OWNER // the pointer has left the text, or the text reached its end
    for (let t = 1016; t < 1600; t += 179) expect(latch.route(t, false, pick)).toEqual(card('c'))
    expect(picks).toHaveLength(1)
  })

  it('a gap of the latch or more starts a new gesture, which picks again', () => {
    const latch = new WheelLatch()
    let under: WheelOwner = CANVAS_OWNER
    const pick = () => under
    expect(latch.route(0, false, pick)).toEqual(CANVAS_OWNER)
    under = card('c')
    expect(latch.route(100, false, pick)).toEqual(CANVAS_OWNER) // same gesture: still the board's
    expect(latch.route(100 + WHEEL_LATCH_MS - 1, false, pick)).toEqual(CANVAS_OWNER)
    expect(latch.route(100 + WHEEL_LATCH_MS - 1 + WHEEL_LATCH_MS, false, pick)).toEqual(card('c'))
  })

  it('a Ctrl/Cmd wheel event zooms and ends the gesture: the next plain event picks again', () => {
    const latch = new WheelLatch()
    let under: WheelOwner = card('c')
    const pick = () => under
    expect(latch.route(0, false, pick)).toEqual(card('c'))
    expect(latch.route(10, true, pick)).toBe('zoom')
    under = CANVAS_OWNER
    expect(latch.route(20, false, pick)).toEqual(CANVAS_OWNER)
  })

  it('a clock that goes back starts a new gesture; reset ends one', () => {
    const latch = new WheelLatch()
    let under: WheelOwner = card('c')
    const pick = () => under
    latch.route(500, false, pick)
    under = CANVAS_OWNER
    expect(latch.route(400, false, pick)).toEqual(CANVAS_OWNER)
    under = card('c')
    latch.reset()
    expect(latch.route(401, false, pick)).toEqual(card('c'))
  })
})
