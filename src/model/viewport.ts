import { MAX_ZOOM, MIN_ZOOM, clamp } from './doc.ts'
import type { Viewport } from './types.ts'

export interface Point {
  x: number
  y: number
}
export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}
export interface Size {
  width: number
  height: number
}

export const clampZoom = (z: number) => clamp(z, MIN_ZOOM, MAX_ZOOM)

/** Zoom to `zoom` keeping the scene point under `screen` fixed. */
export function zoomAround(vp: Viewport, screen: Point, zoom: number): Viewport {
  const next = clampZoom(zoom)
  const sceneX = (screen.x - vp.panX) / vp.zoom
  const sceneY = (screen.y - vp.panY) / vp.zoom
  return { zoom: next, panX: screen.x - sceneX * next, panY: screen.y - sceneY * next }
}

/** Viewport that fits `bounds` inside `size` with padding; never zooms in past 100%. */
export function fitViewport(bounds: Rect | null, size: Size, padding = 80): Viewport {
  if (!bounds || size.width <= 0 || size.height <= 0) return { zoom: 1, panX: 0, panY: 0 }
  const w = Math.max(1, bounds.right - bounds.left)
  const h = Math.max(1, bounds.bottom - bounds.top)
  const availW = Math.max(1, size.width - padding * 2)
  const availH = Math.max(1, size.height - padding * 2)
  const zoom = clampZoom(Math.min(1, availW / w, availH / h))
  const cx = (bounds.left + bounds.right) / 2
  const cy = (bounds.top + bounds.bottom) / 2
  return { zoom, panX: size.width / 2 - cx * zoom, panY: size.height / 2 - cy * zoom }
}

export function screenToScene(vp: Viewport, screen: Point): Point {
  return { x: (screen.x - vp.panX) / vp.zoom, y: (screen.y - vp.panY) / vp.zoom }
}

/** Scale an image so its longest side fits `max` (never upscales). */
export function fitImageScale(width: number, height: number, max = 480): number {
  const longest = Math.max(width, height)
  return longest > max ? max / longest : 1
}
