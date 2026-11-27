import { round, roundPositive } from './doc.ts'
import type { CropRect, ImageRecord } from './types.ts'
import type { Point, Size } from './viewport.ts'

export type { CropRect } from './types.ts'

/**
 * Pure geometry of image crops, Fit and Fill. No Fabric, no DOM.
 *
 * Coordinates:
 *  - "source pixels": the original image, (0, 0) at its top-left, (W, H) at its bottom-right.
 *  - a `Placement` puts source pixels on the board: source point (u, v) is at
 *    `(left, top) + R(angle) * (u * scaleX, v * scaleY)` in scene coordinates. That is how
 *    Fabric draws an image with a left/top origin, so `(left, top)` is the scene position of
 *    source pixel (0, 0), whatever the rotation.
 */
export interface Placement {
  left: number
  top: number
  /** Degrees, clockwise. */
  angle: number
  scaleX: number
  scaleY: number
}

/** Each side of a crop stays at least this many scene units long as displayed. */
export const MIN_CROP_SCENE = 8

function rotate(x: number, y: number, deg: number): Point {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: x * c - y * s, y: x * s + y * c }
}

/** Scene point of a source-pixel point. */
export function sourceToScene(p: Point, at: Placement): Point {
  const d = rotate(p.x * at.scaleX, p.y * at.scaleY, at.angle)
  return { x: at.left + d.x, y: at.top + d.y }
}

/** Source-pixel point of a scene point (the inverse of `sourceToScene`). Rotation-independent. */
export function sceneToSource(p: Point, at: Placement): Point {
  const d = rotate(p.x - at.left, p.y - at.top, -at.angle)
  return { x: d.x / at.scaleX, y: d.y / at.scaleY }
}

/**
 * Where the whole original lies when the displayed (cropped) box is at `shown`: the kept
 * pixels stay exactly where they are, so the original's top-left is the displayed top-left
 * moved back by the rotated, scaled offset of the crop's corner.
 */
export function uncroppedPlacement(shown: Placement, crop: Pick<CropRect, 'x' | 'y'>): Placement {
  const d = rotate(-crop.x * shown.scaleX, -crop.y * shown.scaleY, shown.angle)
  return { ...shown, left: shown.left + d.x, top: shown.top + d.y }
}

/** The displayed top-left of `crop` when the whole original lies at `full` (the inverse of `uncroppedPlacement`). */
export function croppedPlacement(full: Placement, crop: Pick<CropRect, 'x' | 'y'>): Placement {
  const p = sourceToScene({ x: crop.x, y: crop.y }, full)
  return { ...full, left: p.x, top: p.y }
}

export const wholeRect = (size: Size): CropRect => ({ x: 0, y: 0, width: size.width, height: size.height })

/** The crop shows the whole image (within a small tolerance), so it is not a crop at all. */
export function isWholeImage(crop: CropRect | undefined, size: Size): boolean {
  return storedCrop(crop, size) === undefined
}

/**
 * One axis of `storedCrop`: the interval [start, start + side] clamped to [0, full], its edges
 * rounded to 0.01 source pixels (never past the image), its side taken from the rounded edges.
 * Null when nothing of it lies inside. An interval narrower than the stored step keeps its own
 * (positive, `roundPositive`) side rather than collapsing to zero.
 */
function storedAxis(start: number, side: number, full: number): { at: number; side: number; whole: boolean } | null {
  const lo = Math.min(Math.max(start, 0), full)
  const hi = Math.min(Math.max(start + side, 0), full)
  if (!(hi - lo > 0)) return null
  const end = Math.min(round(full), full)
  const a = Math.min(round(lo), full)
  const b = Math.min(round(hi), full)
  if (b - a > 0) return { at: a, side: roundPositive(b - a), whole: a === 0 && b === end }
  const s = roundPositive(hi - lo)
  return { at: Math.max(0, Math.min(a, full - s)), side: s, whole: false }
}

/**
 * THE crop as it is stored, and the one decision of what counts as the whole image, used by
 * geometry (Fill, Fit, replace, closing crop mode), by the Fabric conversion (creating an
 * object, reading it back) and therefore by everything that is saved.
 *
 * Edges are clamped to the image and rounded to the stored step (0.01 source pixels); the
 * sides come from the rounded edges, so a stored crop never reaches outside the image and
 * clamping it again changes nothing. It is the whole image exactly when its rounded edges are
 * the image's own edges: a crop that differs from the whole image at stored precision is never
 * dropped, and one that does not is never stored. Undefined: the whole image (also when
 * nothing of the crop lies inside the image, which then is shown whole).
 */
export function storedCrop(crop: CropRect | undefined, size: Size): CropRect | undefined {
  if (!crop || !(size.width > 0) || !(size.height > 0)) return undefined
  const x = storedAxis(crop.x, crop.width, size.width)
  const y = storedAxis(crop.y, crop.height, size.height)
  if (!x || !y || (x.whole && y.whole)) return undefined
  return { x: x.at, y: y.at, width: x.side, height: y.side }
}

/**
 * A stored crop checked against the real image (only known once it has been decoded): the
 * canonical `storedCrop`, which clamps it to the image. A crop the app wrote is unchanged.
 */
export function clampCrop(crop: CropRect | undefined, size: Size): CropRect | undefined {
  return storedCrop(crop, size)
}

// ---- handles ------------------------------------------------------------------------------

export type CropHandle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l'
export type CropHit = CropHandle | 'move'

/** The eight handles, each with its position as a fraction of the crop rectangle. */
export const CROP_HANDLES: ReadonlyArray<{ handle: CropHandle; fx: number; fy: number }> = [
  { handle: 'tl', fx: 0, fy: 0 },
  { handle: 't', fx: 0.5, fy: 0 },
  { handle: 'tr', fx: 1, fy: 0 },
  { handle: 'r', fx: 1, fy: 0.5 },
  { handle: 'br', fx: 1, fy: 1 },
  { handle: 'b', fx: 0.5, fy: 1 },
  { handle: 'bl', fx: 0, fy: 1 },
  { handle: 'l', fx: 0, fy: 0.5 },
]

/** Centre of a handle in source pixels. */
export function handlePoint(rect: CropRect, h: { fx: number; fy: number }): Point {
  return { x: rect.x + rect.width * h.fx, y: rect.y + rect.height * h.fy }
}

/**
 * What a press at `p` (source pixels) grabs. `tolX`/`tolY` are the hit tolerance in source
 * pixels along each axis (a fixed number of screen pixels, divided by the on-screen scale).
 * Corners first, then the sides (anywhere along the drawn border), then the inside of the
 * box. Null: outside the box.
 */
export function hitCropHandle(p: Point, rect: CropRect, tolX: number, tolY: number): CropHit | null {
  const left = rect.x
  const right = rect.x + rect.width
  const top = rect.y
  const bottom = rect.y + rect.height
  const nearL = Math.abs(p.x - left) <= tolX
  const nearR = Math.abs(p.x - right) <= tolX
  const nearT = Math.abs(p.y - top) <= tolY
  const nearB = Math.abs(p.y - bottom) <= tolY
  // When the box is smaller than the tolerance, the nearer edge wins.
  const pickX = nearL && nearR ? (Math.abs(p.x - left) <= Math.abs(p.x - right) ? 'l' : 'r') : nearL ? 'l' : nearR ? 'r' : null
  const pickY = nearT && nearB ? (Math.abs(p.y - top) <= Math.abs(p.y - bottom) ? 't' : 'b') : nearT ? 't' : nearB ? 'b' : null
  const withinX = p.x >= left - tolX && p.x <= right + tolX
  const withinY = p.y >= top - tolY && p.y <= bottom + tolY
  if (pickX && pickY) return `${pickY}${pickX}` as CropHandle
  if (pickX && withinY) return pickX
  if (pickY && withinX) return pickY
  if (p.x > left && p.x < right && p.y > top && p.y < bottom) return 'move'
  return null
}

/**
 * Smallest allowed side, in source pixels: `MIN_CROP_SCENE` scene units as displayed, at
 * least one source pixel, never more than the image's own side, and never more than the
 * side was when the drag began (a crop that is already smaller may grow, and is never
 * snapped up).
 */
export function minCropSide(scale: number, imageSide: number, startSide: number): number {
  const s = Math.abs(scale)
  const fromScene = s > 0 ? MIN_CROP_SCENE / s : imageSide
  return Math.min(Math.max(1, fromScene), imageSide, startSide)
}

/**
 * The crop rectangle after dragging `hit` by `(dx, dy)` source pixels from `start`. Free
 * aspect. The result always lies inside the image, never flips, and keeps each side at
 * least `minW` by `minH`.
 */
export function dragCropRect(start: CropRect, hit: CropHit, dx: number, dy: number, size: Size, minW: number, minH: number): CropRect {
  if (hit === 'move') {
    const x = Math.min(Math.max(start.x + dx, 0), Math.max(0, size.width - start.width))
    const y = Math.min(Math.max(start.y + dy, 0), Math.max(0, size.height - start.height))
    return { x, y, width: start.width, height: start.height }
  }
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (hit.includes('l')) left = Math.min(Math.max(left + dx, 0), right - minW)
  if (hit.includes('r')) right = Math.max(Math.min(right + dx, size.width), left + minW)
  if (hit.includes('t')) top = Math.min(Math.max(top + dy, 0), bottom - minH)
  if (hit.includes('b')) bottom = Math.max(Math.min(bottom + dy, size.height), top + minH)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// ---- Fit and Fill ------------------------------------------------------------------------

/** The largest rectangle of `size` with the aspect ratio `aspect` (width / height), centred. */
export function largestCentredCrop(size: Size, aspect: number): CropRect {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return wholeRect(size)
  let width = size.width
  let height = width / aspect
  if (height > size.height) {
    height = size.height
    width = height * aspect
  }
  width = Math.min(width, size.width)
  height = Math.min(height, size.height)
  return { x: (size.width - width) / 2, y: (size.height - height) / 2, width, height }
}

/** The largest uniform scale at which `size` fits inside `box`. */
export function fitInsideScale(size: Size, box: Size): number {
  return Math.min(box.width / size.width, box.height / size.height)
}

/** An image's displayed box: centre, displayed size and angle. */
export interface DisplayBox {
  centre: Point
  width: number
  height: number
  angle: number
}

/** The displayed box of an image record (`size` is the original's size in source pixels). */
export function displayBox(rec: Pick<ImageRecord, 'left' | 'top' | 'angle' | 'scaleX' | 'scaleY' | 'crop'>, size: Size): DisplayBox {
  const crop = rec.crop ?? wholeRect(size)
  const width = crop.width * Math.abs(rec.scaleX)
  const height = crop.height * Math.abs(rec.scaleY)
  const d = rotate(width / 2, height / 2, rec.angle)
  return { centre: { x: rec.left + d.x, y: rec.top + d.y }, width, height, angle: rec.angle }
}

/** The record placed so that its displayed box (of `width` x `height`) is centred on `centre`. */
function placeCentred<T extends ImageRecord>(rec: T, centre: Point, width: number, height: number, scale: number, crop: CropRect | undefined): T {
  const d = rotate(width / 2, height / 2, rec.angle)
  const out: T = { ...rec, left: round(centre.x - d.x), top: round(centre.y - d.y), scaleX: roundPositive(scale, 5), scaleY: roundPositive(scale, 5) }
  if (crop) out.crop = crop
  else delete out.crop
  return out
}

/** Rounds down to 2 decimals (a side that must not grow past the image). */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100

/**
 * How an image of `size` covers a box of `box.width` x `box.height` displayed units: what Fill
 * does, and what keeping an image's box when its picture changes needs.
 *
 * The crop is the largest centred rectangle of the original with the box's aspect ratio,
 * rounded as stored: its sides first (the side the image limits is the image's own side; the
 * other follows the box's aspect ratio, to 0.01 source pixels), then its position, centred
 * from those rounded sides. The scale is one uniform scale, rounded as stored (5 decimals),
 * chosen from two candidates (box width / crop width, box height / crop height) as the one
 * that keeps both sides of the box closest. Undefined crop: the whole image.
 *
 * Idempotent: covering the box this produces gives exactly the same crop and scale. The box
 * is kept to stored precision: a side moves by at most about 0.005 source pixels times the
 * scale, plus the scale's rounding (0.000005) times that side in source pixels.
 */
export function coverBox(size: Size, box: Size): { crop: CropRect | undefined; scale: number } {
  const aspect = box.width / box.height
  if (!(aspect > 0) || !Number.isFinite(aspect)) return { crop: undefined, scale: roundPositive(box.width / size.width, 5) }
  let width: number
  let height: number
  if (size.height * aspect <= size.width) {
    height = floor2(size.height)
    width = Math.min(roundPositive(height * aspect), floor2(size.width))
  } else {
    width = floor2(size.width)
    height = Math.min(roundPositive(width / aspect), floor2(size.height))
  }
  // Centred from the rounded sides, then the one stored-crop decision (after centring, never
  // before: a crop one stored step off the whole image is still a crop).
  const crop = storedCrop(
    {
      x: Math.max(0, Math.min(round((size.width - width) / 2), size.width - width)),
      y: Math.max(0, Math.min(round((size.height - height) / 2), size.height - height)),
      width,
      height,
    },
    size,
  )
  const shown = crop ?? wholeRect(size)
  const drift = (s: number) => Math.max(Math.abs(shown.width * s - box.width), Math.abs(shown.height * s - box.height))
  const byWidth = roundPositive(box.width / shown.width, 5)
  const byHeight = roundPositive(box.height / shown.height, 5)
  return { crop, scale: drift(byHeight) < drift(byWidth) ? byHeight : byWidth }
}

/**
 * Fill: the displayed box stays as it is (centre, size and angle, to stored precision; see
 * `coverBox`) and the image covers it, with the largest centred crop of the original that has
 * the box's aspect ratio and one uniform scale. Idempotent: a second Fill changes nothing.
 */
export function fillRecord<T extends ImageRecord>(rec: T, size: Size): T {
  return coverRecord(rec, displayBox(rec, size), size)
}

/** The record showing an image of `size` that covers `box` (see `coverBox`), centred on the box. */
function coverRecord<T extends ImageRecord>(rec: T, box: DisplayBox, size: Size): T {
  const { crop, scale } = coverBox(size, box)
  const shown = crop ?? wholeRect(size)
  return placeCentred(rec, box.centre, shown.width * scale, shown.height * scale, scale, crop)
}

/**
 * Replace image: the record showing a different picture (`newAssetId`, `newSize` source
 * pixels) in the same box (centre, displayed size and angle, to stored precision), covering it
 * like Fill. The old crop referred to the old picture's pixels and is discarded; when the new
 * picture has the box's aspect ratio there is no crop at all. Id, owner, lock and angle are
 * unchanged.
 */
export function replaceRecord<T extends ImageRecord>(rec: T, oldSize: Size, newAssetId: string, newSize: Size): T {
  return coverRecord({ ...rec, assetId: newAssetId }, displayBox(rec, oldSize), newSize)
}

/**
 * Fit: the whole original (no crop) at the largest uniform scale at which it fits inside the
 * displayed box (to stored precision), centred on the box's centre, same angle. The box
 * shrinks to the image's aspect ratio. Rounded as stored. Idempotent.
 */
export function fitRecord<T extends ImageRecord>(rec: T, size: Size): T {
  const box = displayBox(rec, size)
  const scale = roundPositive(fitInsideScale(size, box), 5)
  return placeCentred(rec, box.centre, size.width * scale, size.height * scale, scale, undefined)
}
