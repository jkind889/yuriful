import type { Scene } from './types.ts'
import type { Rect } from './viewport.ts'

export interface FrameDestination {
  readonly id: string
  readonly name: string
  readonly bounds: Rect
  readonly itemCount: number
  readonly locked?: true
}

export function collectFrameDestinations(scene: Scene): FrameDestination[] {
  const counts = new Map<string, number>()
  for (const object of scene.objects) {
    if (object.frameId !== undefined) counts.set(object.frameId, (counts.get(object.frameId) ?? 0) + 1)
  }
  return scene.frames.slice().reverse().map(({ id, name, left, top, width, height, locked }) => ({
    id, name, bounds: { left, top, right: left + width, bottom: top + height },
    itemCount: counts.get(id) ?? 0, ...(locked && { locked }),
  }))
}
