/**
 * Who a plain wheel event belongs to (plan Section 4, "Wheel ownership", Owner Decision 9, Option B:
 * "a scroll belongs to whatever it started on"). Pure: no Fabric, no DOM. The editor gathers the
 * facts about the pointer and the board, and moves the board or scrolls the card itself.
 *
 *  - Plain wheel events less than `WHEEL_LATCH_MS` apart are one gesture, so a trackpad flick and its
 *    inertial tail stay together. The first event picks the owner (`pickWheelOwner`); every later
 *    event of the gesture goes to that owner, whatever is under the pointer by then.
 *  - A Ctrl/Cmd wheel event zooms the board and ends the gesture.
 */

/**
 * How long (ms) after one plain wheel event the next still belongs to the same gesture. A trackpad
 * flick sends its inertial tail at short intervals; if a flick ever splits in two on a real
 * trackpad (the second half panning the board after a card reached its end), this is the number to
 * raise. One constant, so it can be tuned on the owner's own trackpad.
 */
export const WHEEL_LATCH_MS = 180

export type WheelOwner = { kind: 'canvas' } | { kind: 'card'; id: string }

export const CANVAS_OWNER: WheelOwner = { kind: 'canvas' }

/** What the editor knows about the board and the pointer when a gesture starts. */
export interface WheelFacts {
  /**
   * The board is loaded, the hand tool and Space are not in effect, and nothing is pressed and held
   * on the board: no gesture, marquee, pan, draft, crop, layer-row drag or thumb drag.
   */
  free: boolean
  shiftKey: boolean
  deltaX: number
  deltaY: number
  /** A frame's label or outline is under the pointer. */
  frameOverlay: boolean
  /**
   * The front-most object whose box holds the pointer (locked objects count), or null. For a text
   * with a fixed height: how far it is scrolled and how far it can be (`max`, scene units).
   */
  front: { id: string; scroll: { top: number; max: number } | null } | null
}

/** Rounding noise (scene px): a card this close to an end is at it. */
const END_SLACK = 1e-6

/**
 * True when a card scrolled exactly to `top` of `max` can still move in the direction of `deltaY`
 * (down when positive, up when negative). The one answer the wheel, the fades and the thumb share:
 * a card that can scroll by a single pixel shows its fade and its thumb, and takes the wheel.
 */
export function canScroll(scroll: { top: number; max: number }, deltaY: number): boolean {
  if (deltaY > 0) return scroll.top < scroll.max - END_SLACK
  if (deltaY < 0) return scroll.top > END_SLACK
  return false
}

/**
 * True when a box of `width` × `height` (scene units, before its transform) whose centre-origin
 * matrix is `m` (Fabric's `calcTransformMatrix()`: turned, scaled, moved) holds the scene point `p`,
 * its edges included: the point is taken into the box's own coordinates, so a turned box is tested
 * as the rectangle it is, not by its corners' crossings.
 */
export function boxHolds(m: readonly number[], width: number, height: number, p: { x: number; y: number }): boolean {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m
  const det = a * d - b * c
  if (!det || !(width >= 0) || !(height >= 0)) return false
  const x = p.x - e
  const y = p.y - f
  const lx = (d * x - c * y) / det
  const ly = (a * y - b * x) / det
  const slack = 1e-9 * Math.max(1, width, height)
  return Math.abs(lx) <= width / 2 + slack && Math.abs(ly) <= height / 2 + slack
}

/**
 * The owner of a new wheel gesture: the card under the pointer when all four conditions hold, the
 * canvas otherwise. (1) the board is free; (2) Shift is not held and the wheel is mostly vertical;
 * (3) no frame label or outline is under the pointer (a locked frame's too), and the front-most object
 * there is the card (`boxHolds`);
 * (4) the card has a fixed height, more text than fits, and room left in the wheel's direction.
 */
export function pickWheelOwner(f: WheelFacts): WheelOwner {
  if (!f.free) return CANVAS_OWNER
  if (f.shiftKey || Math.abs(f.deltaY) < Math.abs(f.deltaX)) return CANVAS_OWNER
  if (f.frameOverlay || !f.front?.scroll) return CANVAS_OWNER
  if (!canScroll(f.front.scroll, f.deltaY)) return CANVAS_OWNER
  return { kind: 'card', id: f.front.id }
}

/** The gesture latch: which owner each wheel event goes to, or `'zoom'` for a Ctrl/Cmd wheel event. */
export class WheelLatch {
  private owner: WheelOwner | null = null
  private last = -Infinity

  constructor(private readonly latchMs = WHEEL_LATCH_MS) {}

  /**
   * Routes one wheel event that arrived at `time` (ms, any monotonic clock). `pick` is asked only for
   * the first event of a gesture.
   */
  route(time: number, zoom: boolean, pick: () => WheelOwner): WheelOwner | 'zoom' {
    if (zoom) {
      this.owner = null
      this.last = -Infinity
      return 'zoom'
    }
    if (!this.owner || !(time - this.last < this.latchMs) || time < this.last) this.owner = pick()
    this.last = time
    return this.owner
  }

  /** Ends the gesture in progress, if any: the next event picks again. */
  reset() {
    this.owner = null
    this.last = -Infinity
  }
}
