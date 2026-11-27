import { round, roundPositive } from './doc.ts'
import { sourceToScene } from './crop.ts'
import type { CaptionSide, ImageRecord } from './types.ts'
import type { Rect, Size } from './viewport.ts'

/** The displayed upright bounds, measured from the geometry that survives a save or undo. */
export function captionImageBounds(image: ImageRecord, original: Size): Rect {
  const { width, height } = image.crop ?? original
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: 0, y: height }, { x: width, y: height }]
    .map((point) => sourceToScene(point, image))
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

export const captionGap = (fontSize: number): number => Math.round(0.4 * fontSize)

export function captionPlacement(
  bounds: Rect,
  side: CaptionSide | undefined,
  caption: { width: number; height: number; fontSize: number },
  position?: number,
): { left: number; top: number; width: number } {
  const gap = captionGap(caption.fontSize)
  if (side === 'left' || side === 'right') {
    const left = side === 'left' ? bounds.left - gap - caption.width : bounds.right + gap
    const top = position === undefined ? bounds.top : bounds.top + position * (bounds.bottom - bounds.top) - caption.height / 2
    return { left: round(left), top: round(top), width: roundPositive(caption.width) }
  }
  const top = side === 'top' ? bounds.top - gap - caption.height : bounds.bottom + gap
  const edgeWidth = bounds.right - bounds.left
  const left = position === undefined ? bounds.left : bounds.left + position * edgeWidth - caption.width / 2
  return { left: round(left), top: round(top), width: roundPositive(position === undefined ? edgeWidth : caption.width) }
}

/** A directly transformed caption stays attached only if its image took part and it stayed upright. */
export function captionDetaches(imageId: string, transformed: ReadonlySet<string>, rotated: boolean): boolean {
  return rotated || !transformed.has(imageId)
}

/** The union of frame members and captions of moving images, excluding direct moves. */
export function followsDrag(
  item: { id: string; frameId?: string; captionOf?: string },
  moved: { direct: ReadonlySet<string>; frames: ReadonlySet<string>; images: ReadonlySet<string> },
): boolean {
  if (moved.direct.has(item.id)) return false
  return (item.frameId !== undefined && moved.frames.has(item.frameId))
    || (item.captionOf !== undefined && moved.images.has(item.captionOf))
}
