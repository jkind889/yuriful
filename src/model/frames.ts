import { MAX_FONT_SIZE, MIN_FONT_SIZE, clamp } from './doc.ts'
import type { FrameRecord } from './types.ts'
import type { Point } from './viewport.ts'

/** Smallest side, in scene units, of a newly drawn frame or of one shrunk from above it. */
export const MIN_FRAME_SIZE = 24

/** Size in screen pixels of the frame a plain click with the Frame tool creates. */
export const DEFAULT_FRAME_SCREEN = { width: 640, height: 480 } as const

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** `inside` as the ownership rules use it: the point lies within the rectangle, edges included. */
export function containsPoint(box: Box, p: Point): boolean {
  return p.x >= box.left && p.x <= box.left + box.width && p.y >= box.top && p.y <= box.top + box.height
}

// ---- ownership ---------------------------------------------------------------------------

/**
 * Owner of a piece of content the user has just moved, resized, rotated or created
 * (rule O1). `frames` is in z-order, back to front. The first rule that applies decides:
 *
 *  1. Its owner was transformed in the same gesture: kept, with no containment test,
 *     because their relationship did not change.
 *  2. Its owner was not transformed and still contains its centre: kept.
 *  3. Otherwise the front-most frame that contains its centre and was NOT transformed
 *     in the same gesture, or none.
 *
 * A co-transformed frame is never a candidate in step 3, so a frame can never newly
 * adopt something merely because it was moved, resized or drawn.
 */
export function ownerAfterManipulation(
  current: string | undefined,
  centre: Point,
  frames: readonly FrameRecord[],
  coTransformedFrameIds: ReadonlySet<string>,
): string | undefined {
  if (current !== undefined) {
    const owner = frames.find((f) => f.id === current)
    if (owner) {
      if (coTransformedFrameIds.has(current)) return current
      if (containsPoint(owner, centre)) return current
    }
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i] as FrameRecord
    if (!coTransformedFrameIds.has(f.id) && containsPoint(f, centre)) return f.id
  }
  return undefined
}

/**
 * Members a resized frame no longer contains (rule O3). They become loose; this never
 * says where else they might belong.
 */
export function membersToRelease(frameRect: Box, members: ReadonlyArray<{ id: string; centre: Point }>): string[] {
  return members.filter((m) => !containsPoint(frameRect, m.centre)).map((m) => m.id)
}

// ---- scale limits ------------------------------------------------------------------------

/**
 * The one factor a proportional scale gesture may apply to everything it transforms.
 * Limits come from the pre-gesture values and each member's allowed range always
 * includes its own starting value, so a member that is already out of range can move
 * toward the range but is never snapped into it; it only blocks moving further out.
 * Images impose no limit.
 */
export function allowedScaleFactor(
  requested: number,
  baseFrames: ReadonlyArray<Pick<FrameRecord, 'width' | 'height'>>,
  baseTexts: ReadonlyArray<{ fontSize: number }>,
): number {
  if (!Number.isFinite(requested) || requested <= 0) return 1
  let lower = 0
  let upper = Number.POSITIVE_INFINITY
  for (const t of baseTexts) {
    if (!(t.fontSize > 0)) continue
    lower = Math.max(lower, Math.min(1, MIN_FONT_SIZE / t.fontSize))
    upper = Math.min(upper, Math.max(1, MAX_FONT_SIZE / t.fontSize))
  }
  for (const f of baseFrames) {
    const smaller = Math.min(f.width, f.height)
    if (!(smaller > 0)) continue
    lower = Math.max(lower, Math.min(1, MIN_FRAME_SIZE / smaller))
  }
  return clamp(requested, lower, upper)
}

/**
 * Lower bound for one side of a frame that is resized on its own: the minimum, or the
 * side's own pre-gesture length when it was already below the minimum (it may grow,
 * and is never snapped up).
 */
export function minFrameSide(before: number): number {
  return Math.min(MIN_FRAME_SIZE, before)
}

// ---- drawing a frame ---------------------------------------------------------------------

export function rectFromDrag(a: Point, b: Point): Box {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** "Frame 1", "Frame 2", ...: one past the highest number already used. */
export function nextFrameName(existing: readonly string[]): string {
  let max = 0
  for (const name of existing) {
    const m = /^Frame (\d{1,15})$/.exec(name) // bounded, so the number stays an exact integer
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `Frame ${max + 1}`
}

// ---- overlay geometry (screen pixels) ------------------------------------------------------

/** A frame is grabbed by its label or by a band this many CSS pixels either side of its outline. */
export const FRAME_HIT_TOLERANCE = 6
export const LABEL_HEIGHT = 20
export const LABEL_GAP = 4
export const LABEL_PAD_X = 6
export const LABEL_MAX_TEXT_WIDTH = 220

/** The label sits above the outline's top-left corner. All values are screen pixels. */
export function labelBox(outline: Box, textWidth: number): Box {
  return {
    left: outline.left,
    top: outline.top - LABEL_GAP - LABEL_HEIGHT,
    width: Math.min(textWidth, LABEL_MAX_TEXT_WIDTH) + LABEL_PAD_X * 2,
    height: LABEL_HEIGHT,
  }
}

/** Within `tolerance` of the rectangle's outline (not its interior). */
export function nearOutline(p: Point, outline: Box, tolerance = FRAME_HIT_TOLERANCE): boolean {
  const right = outline.left + outline.width
  const bottom = outline.top + outline.height
  const inOuter = p.x >= outline.left - tolerance && p.x <= right + tolerance && p.y >= outline.top - tolerance && p.y <= bottom + tolerance
  if (!inOuter) return false
  const inInner = p.x > outline.left + tolerance && p.x < right - tolerance && p.y > outline.top + tolerance && p.y < bottom - tolerance
  return !inInner
}

/** What grabs a frame: its label, or its outline. Its interior is click-through. */
export function overlayHit(p: Point, outline: Box, label: Box, tolerance = FRAME_HIT_TOLERANCE): boolean {
  return containsPoint(label, p) || nearOutline(p, outline, tolerance)
}
