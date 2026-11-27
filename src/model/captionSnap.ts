import { clamp } from './doc.ts'
import { captionGap } from './captions.ts'
import type { CaptionSide } from './types.ts'
import type { Rect } from './viewport.ts'

export const CAPTION_SNAP_DISTANCE_PX = 14
export const CAPTION_SNAP_MIN_OVERLAP = 0.25
const GAP_SNAP_DISTANCE_PX = 6

export type SnapSide = CaptionSide | 'under'
export const storedSnapSide = (side: SnapSide): CaptionSide | undefined => side === 'under' ? undefined : side

export interface SnapImage {
  imageId: string
  bounds: Rect
  locked?: boolean
  moving?: boolean
  captionId?: string
}

export interface SnapCandidate {
  readonly imageId: string
  readonly side: SnapSide
  readonly position: number
}

function spanOverlaps(start: number, end: number, otherStart: number, otherEnd: number) {
  const shorter = Math.min(end - start, otherEnd - otherStart)
  const overlap = Math.min(end, otherEnd) - Math.max(start, otherStart)
  return shorter > 0 && overlap >= shorter * CAPTION_SNAP_MIN_OVERLAP
}

/** Images are supplied front to back, which breaks ties without flickering. */
export function snapCandidate(
  text: { id: string; bounds: Rect; attachedSide?: SnapSide },
  images: readonly SnapImage[],
  zoom: number,
  fontSize: number,
): SnapCandidate | null {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return null
  const { left, right, top, bottom } = text.bounds
  const gap = captionGap(fontSize)
  let best: SnapCandidate | null = null
  let nearest = Infinity
  for (const image of images) {
    const { imageId, bounds, locked, moving, captionId } = image
    if (locked || moving || (captionId !== undefined && captionId !== text.id)) continue
    const horizontal = spanOverlaps(left, right, bounds.left, bounds.right)
    const vertical = spanOverlaps(top, bottom, bounds.top, bounds.bottom)
    const edges: ReadonlyArray<readonly [SnapSide, number, boolean]> = [
      ['under', top - bounds.bottom, horizontal],
      ['top', bounds.top - bottom, horizontal],
      ['left', bounds.left - right, vertical],
      ['right', left - bounds.right, vertical],
    ]
    for (const [side, separation, overlaps] of edges) {
      if (!overlaps) continue
      const distance = Math.abs(separation) * zoom
      const physicalEdge = distance <= CAPTION_SNAP_DISTANCE_PX
      const gapDistance = Math.abs(separation - gap) * zoom
      const gapLimit = captionId === text.id && side === text.attachedSide ? CAPTION_SNAP_DISTANCE_PX : GAP_SNAP_DISTANCE_PX
      if (!physicalEdge && (separation < 0 || gapDistance > gapLimit)) continue
      // Keep physical hits ahead of the gap fallback so an adjacent image's
      // gap cannot take over a drop directly alongside an eligible edge.
      const rank = physicalEdge ? distance : CAPTION_SNAP_DISTANCE_PX + 1 + gapDistance
      if (rank >= nearest) continue
      const alongX = side === 'under' || side === 'top'
      const center = alongX ? (left + right) / 2 : (top + bottom) / 2
      const start = alongX ? bounds.left : bounds.top
      const end = alongX ? bounds.right : bounds.bottom
      best = { imageId, side, position: clamp((center - start) / (end - start), 0, 1) }
      nearest = rank
    }
  }
  return best
}
