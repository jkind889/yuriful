import type { FrameDestination } from './frameDestinations.ts'
import type { Viewport } from './types.ts'
import { screenToScene } from './viewport.ts'
import type { Rect } from './viewport.ts'

export function frameTourPath(
  frames: readonly FrameDestination[],
  selectedIds: ReadonlySet<string>,
  viewport: Viewport,
  visibleCanvas: Rect,
) {
  const start = screenToScene(viewport, { x: visibleCanvas.left, y: visibleCanvas.top })
  const end = screenToScene(viewport, { x: visibleCanvas.right, y: visibleCanvas.bottom })
  const visible = ({ bounds }: FrameDestination) =>
    bounds.left < end.x && bounds.right > start.x && bounds.top < end.y && bounds.bottom > start.y

  return frames.filter((frame) => selectedIds.size > 0 ? selectedIds.has(frame.id) : visible(frame))
    .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left)
}
