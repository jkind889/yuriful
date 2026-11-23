import { captionDetaches } from './captions.ts'
import { containsPoint, ownerAfterManipulation } from './frames.ts'
import type { FrameRecord, Scene, TextRecord } from './types.ts'
import type { Point } from './viewport.ts'

export interface OwnershipFeedback {
  readonly gaining: readonly string[]
  readonly losing: readonly string[]
}

/** Selection includes direct transforms only. Followers never detach through this path. */
export function captionWillDetach(before: TextRecord, after: TextRecord, transformed: ReadonlySet<string>): boolean {
  if (before.captionOf === undefined) return false
  const rotated = after.angle !== before.angle
  const touched = rotated || after.left !== before.left || after.top !== before.top || after.width !== before.width
    || after.fontSize !== before.fontSize || after.minHeight !== before.minHeight
  return touched && captionDetaches(before.captionOf, transformed, rotated)
}

const NO_DETACHMENTS: ReadonlySet<string> = new Set()

/** The same centres, rounded frame rectangles and back-to-front order used by settlement. */
export function previewOwnership(
  before: Scene,
  transformed: ReadonlyMap<string, Point>,
  frames: readonly FrameRecord[],
  coTransformedFrames: ReadonlySet<string>,
  stationary: ReadonlyMap<string, Point> = new Map(),
  detachedCaptions: ReadonlySet<string> = NO_DETACHMENTS,
  snap?: { textId: string; frameId?: string },
): OwnershipFeedback {
  const gaining = new Set<string>()
  const losing = new Set<string>()
  const resized = new Map(frames.filter((f) => {
    if (!coTransformedFrames.has(f.id)) return false
    const previous = before.frames.find((b) => b.id === f.id)
    return previous && (previous.width !== f.width || previous.height !== f.height)
  }).map((f) => [f.id, f]))

  for (const item of before.objects) {
    const snapping = snap?.textId === item.id
    // A retained caption shares its image's outcome, including release by a resized frame.
    if (!snapping && item.type === 'text' && item.captionOf && !detachedCaptions.has(item.id)) continue
    const owner = item.frameId
    const centre = transformed.get(item.id)
    if (centre) {
      const next = snapping ? snap.frameId : ownerAfterManipulation(owner, centre, frames, coTransformedFrames)
      if (next === owner) continue
      if (owner !== undefined) losing.add(owner)
      if (next !== undefined) gaining.add(next)
    } else if (owner !== undefined) {
      const frame = resized.get(owner)
      const point = stationary.get(item.id)
      if (frame && point && !containsPoint(frame, point)) losing.add(owner)
    }
  }
  return { gaining: [...gaining], losing: [...losing] }
}
