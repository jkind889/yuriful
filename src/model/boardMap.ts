import type { FrameDestination } from './frameDestinations.ts'
import type { Viewport } from './types.ts'
import { screenToScene } from './viewport.ts'
import type { Rect, Size } from './viewport.ts'

export const BOARD_MAP_SIZE = { width: 188, height: 112 }

export function fitBoardMap(frames: readonly FrameDestination[]) {
  if (!frames.length) return null
  const bounds = frames.reduce<Rect>((area, { bounds }) => ({
    left: Math.min(area.left, bounds.left),
    top: Math.min(area.top, bounds.top),
    right: Math.max(area.right, bounds.right),
    bottom: Math.max(area.bottom, bounds.bottom),
  }), frames[0]!.bounds)
  const width = bounds.right - bounds.left
  const height = bounds.bottom - bounds.top
  const scale = Math.min((BOARD_MAP_SIZE.width - 16) / width, (BOARD_MAP_SIZE.height - 16) / height)
  if (!Number.isFinite(scale) || scale <= 0) return null
  return {
    scale, left: bounds.left, top: bounds.top,
    x: (BOARD_MAP_SIZE.width - width * scale) / 2,
    y: (BOARD_MAP_SIZE.height - height * scale) / 2,
  }
}

type Projection = NonNullable<ReturnType<typeof fitBoardMap>>

export function projectMapRect(rect: Rect, map: Projection): Rect {
  return {
    left: map.x + (rect.left - map.left) * map.scale,
    top: map.y + (rect.top - map.top) * map.scale,
    right: map.x + (rect.right - map.left) * map.scale,
    bottom: map.y + (rect.bottom - map.top) * map.scale,
  }
}

export function mapViewportRect(view: Viewport, canvas: Size, map: Projection): Rect | null {
  const start = screenToScene(view, { x: 0, y: 0 })
  const end = screenToScene(view, { x: canvas.width, y: canvas.height })
  const projected = projectMapRect({ left: start.x, top: start.y, right: end.x, bottom: end.y }, map)
  const left = Math.max(0, projected.left)
  const top = Math.max(0, projected.top)
  const right = Math.min(BOARD_MAP_SIZE.width, projected.right)
  const bottom = Math.min(BOARD_MAP_SIZE.height, projected.bottom)
  return right > left && bottom > top ? { left, top, right, bottom } : null
}
