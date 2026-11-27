import type { FabricObject } from 'fabric'
import { LABEL_HEIGHT, LABEL_MAX_TEXT_WIDTH, LABEL_PAD_X, labelBox, overlayHit } from '../model/frames.ts'
import type { Box } from '../model/frames.ts'
import type { Point } from '../model/viewport.ts'
import { ACCENT, frameNameOf } from './objects.ts'

/**
 * What is drawn for a frame over the canvas, and what grabs it: its outline and its
 * label, both in viewport (CSS) pixels. Drawing and hit testing use this one geometry,
 * so what the user sees is exactly what the pointer hits, at any pan and zoom.
 */
export interface FrameOverlay {
  outline: Box
  label: Box
  /** The name as drawn (shortened with an ellipsis when it is too long). */
  text: string
}

export const LABEL_FONT = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const OUTLINE_COLOR = '#c2c8d6'
const LABEL_COLOR = '#667086'
const ELLIPSIS = '…'

// ---- measuring (module-owned context, cached per name) ----------------------------------

let measureCtx: CanvasRenderingContext2D | null | undefined
const measured = new Map<string, { text: string; width: number }>()
const CACHE_LIMIT = 500
const MAX_MEASURED_CHARS = 200

function textWidth(text: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
    } catch {
      measureCtx = null
    }
  }
  if (!measureCtx) return text.length * 7 // no canvas (tests): a stable estimate
  measureCtx.font = LABEL_FONT
  return measureCtx.measureText(text).width
}

/** The label text that fits the maximum label width, and its width in CSS pixels. */
export function fitLabel(fullName: string): { text: string; width: number } {
  const hit = measured.get(fullName)
  if (hit) return hit
  // A stored name has no length limit; nothing beyond this could ever fit the label.
  const name = fullName.length > MAX_MEASURED_CHARS ? `${Array.from(fullName.slice(0, MAX_MEASURED_CHARS * 2)).slice(0, MAX_MEASURED_CHARS).join('')}${ELLIPSIS}` : fullName
  let text = name
  let width = textWidth(text)
  if (width > LABEL_MAX_TEXT_WIDTH) {
    const chars = Array.from(name)
    while (chars.length > 1 && width > LABEL_MAX_TEXT_WIDTH) {
      chars.pop()
      text = `${chars.join('').trimEnd()}${ELLIPSIS}`
      width = textWidth(text)
    }
  }
  const fitted = { text, width: Math.ceil(width) }
  if (measured.size >= CACHE_LIMIT) measured.clear()
  measured.set(fullName, fitted)
  return fitted
}

// ---- geometry ------------------------------------------------------------------------------

/**
 * Outline and label of a frame in viewport pixels, from its scene-space corners (so a
 * frame inside a multi-selection is placed correctly) and the canvas viewport transform.
 */
export function frameOverlay(frame: FabricObject, viewportTransform: readonly number[]): FrameOverlay {
  const zoom = viewportTransform[0] ?? 1
  const panX = viewportTransform[4] ?? 0
  const panY = viewportTransform[5] ?? 0
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const p of frame.getCoords()) {
    left = Math.min(left, p.x)
    top = Math.min(top, p.y)
    right = Math.max(right, p.x)
    bottom = Math.max(bottom, p.y)
  }
  const outline: Box = { left: left * zoom + panX, top: top * zoom + panY, width: (right - left) * zoom, height: (bottom - top) * zoom }
  const { text, width } = fitLabel(frameNameOf(frame) ?? '')
  return { outline, label: labelBox(outline, width), text }
}

/** `viewportPoint` is in the same viewport pixels as the overlay. */
export function hitsFrameOverlay(overlay: FrameOverlay, viewportPoint: Point): boolean {
  return overlayHit(viewportPoint, overlay.outline, overlay.label)
}

// ---- drawing --------------------------------------------------------------------------------

export interface DrawnFrame {
  overlay: FrameOverlay
  selected: boolean
}

/**
 * Draws outlines and labels (and the dashed rectangle of a frame being drawn) in CSS
 * pixels. `ctx` must be at the canvas's base transform, i.e. not the viewport transform.
 * `pixelRatio` is the number of device pixels per CSS pixel on that context.
 */
export function drawFrameOverlays(ctx: CanvasRenderingContext2D, frames: readonly DrawnFrame[], draft: Box | null, pixelRatio = 1) {
  const ratio = pixelRatio > 0 ? pixelRatio : 1
  // A line a whole number of device pixels wide, centred on device pixels, is crisp at any
  // ratio (1, 1.25, 1.5, 2 ...). Both corners are snapped, never a corner plus a rounded
  // size, so an edge cannot wobble against the paper by a pixel while zooming.
  const devicePixels = Math.max(1, Math.round(ratio))
  const snap = (v: number) => (Math.round(v * ratio) + (devicePixels % 2) / 2) / ratio
  const strokeBox = (box: Box) => {
    const x0 = snap(box.left)
    const y0 = snap(box.top)
    ctx.strokeRect(x0, y0, snap(box.left + box.width) - x0, snap(box.top + box.height) - y0)
  }
  ctx.save()
  ctx.font = LABEL_FONT
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineWidth = devicePixels / ratio
  ctx.setLineDash([])
  for (const { overlay, selected } of frames) {
    const { outline, label, text } = overlay
    ctx.strokeStyle = selected ? ACCENT : OUTLINE_COLOR
    strokeBox(outline)
    if (text !== '') {
      ctx.fillStyle = selected ? ACCENT : LABEL_COLOR
      ctx.fillText(text, label.left + LABEL_PAD_X, label.top + LABEL_HEIGHT / 2)
    }
  }
  if (draft) {
    ctx.strokeStyle = ACCENT
    ctx.setLineDash([6, 4])
    strokeBox(draft)
  }
  ctx.restore()
}
