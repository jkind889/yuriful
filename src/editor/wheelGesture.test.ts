import { describe, expect, it } from 'vitest'
import { CANVAS_OWNER, WHEEL_LATCH_MS, WheelLatch, hasRoom, pickWheelOwner } from './wheelGesture.ts'
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

  it('hasRoom: within half a unit of an end counts as at it', () => {
    expect(hasRoom({ top: 399.6, max: 400 }, 1)).toBe(false)
    expect(hasRoom({ top: 399.4, max: 400 }, 1)).toBe(true)
    expect(hasRoom({ top: 0.4, max: 400 }, -1)).toBe(false)
    expect(hasRoom({ top: 0.6, max: 400 }, -1)).toBe(true)
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
