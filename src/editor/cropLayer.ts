import { CROP_HANDLES, handlePoint, sourceToScene } from '../model/crop.ts'
import type { CropHit, CropRect, Placement } from '../model/crop.ts'
import type { Point, Size } from '../model/viewport.ts'
import { ACCENT } from './objects.ts'

/**
 * What crop mode draws over the canvas, in viewport (CSS) pixels. It is drawn from the same
 * geometry that the editor hits: a handle is a square of `CROP_HANDLE_SIZE` screen pixels
 * centred on a corner or side midpoint of the crop rectangle, rotated with the image, and a
 * press within `CROP_HIT_TOLERANCE` screen pixels of a corner or of the border grabs it (see
 * `hitCropHandle`, which works in the image's source pixels with that tolerance divided by
 * the on-screen scale). The rest of the box moves it.
 */
export const CROP_HANDLE_SIZE = 10
export const CROP_HIT_TOLERANCE = 8

const DIM = 'rgba(17, 20, 28, 0.55)'

export interface CropOverlay {
  /** The whole original, four corners clockwise from its top-left. */
  image: Point[]
  /** The crop rectangle, four corners clockwise from its top-left. */
  box: Point[]
  /** Handle centres. */
  handles: Point[]
  /** Degrees, clockwise: the image's rotation (the handles turn with it). */
  angle: number
}

function corners(rect: CropRect, at: Placement, toScreen: (p: Point) => Point): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((p) => toScreen(sourceToScene(p, at)))
}

/** The overlay of a crop, from where the whole original lies (`full`) and the canvas viewport transform. */
export function cropOverlay(full: Placement, size: Size, rect: CropRect, viewportTransform: readonly number[]): CropOverlay {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = viewportTransform
  const toScreen = (p: Point): Point => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f })
  return {
    image: corners({ x: 0, y: 0, width: size.width, height: size.height }, full, toScreen),
    box: corners(rect, full, toScreen),
    handles: CROP_HANDLES.map((h) => toScreen(sourceToScene(handlePoint(rect, h), full))),
    angle: full.angle,
  }
}

const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const
const HANDLE_DIRECTION: Record<Exclude<CropHit, 'move'>, number> = { r: 0, br: 45, b: 90, bl: 135, l: 180, tl: 225, t: 270, tr: 315 }

/** The cursor over a handle (turned with the image) or the box. */
export function cropCursor(hit: CropHit, angle: number): string {
  if (hit === 'move') return 'move'
  const deg = (((HANDLE_DIRECTION[hit] + angle) % 180) + 180) % 180
  return RESIZE_CURSORS[Math.round(deg / 45) % 4] as string
}

function quad(ctx: CanvasRenderingContext2D, pts: readonly Point[]) {
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
}

/**
 * Dims the original outside the crop rectangle and draws the box and its eight handles.
 * `ctx` must be at the canvas's base transform (CSS pixels), as in `after:render`.
 */
export function drawCropOverlay(ctx: CanvasRenderingContext2D, overlay: CropOverlay, pixelRatio = 1) {
  const ratio = pixelRatio > 0 ? pixelRatio : 1
  const line = Math.max(1, Math.round(ratio)) / ratio
  ctx.save()
  ctx.setLineDash([])
  ctx.beginPath()
  quad(ctx, overlay.image)
  quad(ctx, overlay.box)
  ctx.fillStyle = DIM
  ctx.fill('evenodd')

  ctx.beginPath()
  quad(ctx, overlay.box)
  ctx.lineWidth = line * 3
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.stroke()
  ctx.lineWidth = line * 1.5
  ctx.strokeStyle = ACCENT
  ctx.stroke()

  const r = (overlay.angle * Math.PI) / 180
  const half = CROP_HANDLE_SIZE / 2
  ctx.lineWidth = line * 1.5
  for (const h of overlay.handles) {
    ctx.save()
    ctx.translate(h.x, h.y)
    ctx.rotate(r)
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = ACCENT
    ctx.fillRect(-half, -half, CROP_HANDLE_SIZE, CROP_HANDLE_SIZE)
    ctx.strokeRect(-half, -half, CROP_HANDLE_SIZE, CROP_HANDLE_SIZE)
    ctx.restore()
  }
  ctx.restore()
}
