import { ActiveSelection, Shadow } from 'fabric'
import type { FabricObject, Transform } from 'fabric'
import { sceneEqual } from '../model/doc.ts'
import { captionWillDetach, previewOwnership } from '../model/feedback.ts'
import type { OwnershipFeedback } from '../model/feedback.ts'
import { ownerAfterManipulation } from '../model/frames.ts'
import type { FrameRecord, Scene } from '../model/types.ts'
import type { Point } from '../model/viewport.ts'
import type { EdgePan } from './edgePan.ts'
import { drawCaptionSnap } from './captionSnapLayer.ts'
import type { CaptionSnapPreview } from './captionSnapLayer.ts'
import { feedbackScale } from './feedbackScale.ts'
import { frameOverlay } from './frameLayer.ts'
import { ACCENT, captionOf, centerOf, idOf, isFrame, ownerOf, toFrameRecord, toRecord } from './objects.ts'

interface DropMarker {
  readonly point: Readonly<Point>
  readonly frameId: string | undefined
}

export interface FeedbackSnapshot extends OwnershipFeedback {
  readonly carried: readonly string[]
  readonly lifted: readonly string[]
  readonly drop: DropMarker | null
  readonly snap: CaptionSnapPreview | null
}

const EMPTY: readonly string[] = Object.freeze([])
const NO_OUTCOME = { gaining: EMPTY, losing: EMPTY }
const NO_FRAMES: ReadonlySet<string> = new Set()
const bounds = (point: Point, [zoom = 1, , , , panX = 0, panY = 0]: readonly number[]): Point =>
  ({ x: point.x * zoom + panX, y: point.y * zoom + panY })

/** One editor's live preview. Its objects and effects never enter scene records. */
export class FeedbackLayer {
  private outcome: OwnershipFeedback = NO_OUTCOME
  private carried: readonly string[] = EMPTY
  private readonly raised = new Map<FabricObject, FabricObject['shadow']>()
  private drop: DropMarker | null = null
  captionSnap: CaptionSnapPreview | null = null

  constructor(readonly edgePan: EdgePan) {}

  snapshot(): FeedbackSnapshot {
    return {
      gaining: [...this.outcome.gaining],
      losing: [...this.outcome.losing],
      carried: [...this.carried],
      lifted: [...this.raised.keys()].flatMap((obj) => idOf(obj) ?? []),
      drop: this.drop && { frameId: this.drop.frameId, point: { ...this.drop.point } },
      snap: this.captionSnap && { ...this.captionSnap, bounds: { ...this.captionSnap.bounds }, box: { ...this.captionSnap.box } },
    }
  }

  updateTransform(
    base: Scene,
    transform: Transform,
    objects: readonly FabricObject[],
    followers: readonly { obj: FabricObject }[],
    unchanged: () => boolean,
  ) {
    const target = transform.target
    const members = target instanceof ActiveSelection ? target.getObjects() : [target]
    const changedFrames = members.filter(isFrame)
    const co = new Set(changedFrames.flatMap((obj) => idOf(obj) ?? []))
    const moving = transform.action === 'drag'
    if (moving && this.raised.size === 0) {
      for (const obj of members) {
        if (isFrame(obj)) continue
        this.raised.set(obj, obj.shadow)
        obj.set({ shadow: new Shadow({ blur: 11, color: 'rgba(28, 36, 61, 0.24)', offsetY: 4, nonScaling: true }) })
      }
    }
    this.carried = followers.flatMap(({ obj }) => co.has(ownerOf(obj) ?? '') ? idOf(obj) ?? [] : [])
    if (base.frames.length === 0) return

    const scale = feedbackScale(base, transform, members)
    const projectedFrames = new Map(changedFrames.flatMap((obj) => {
      const frame = (scale?.frame ?? toFrameRecord)(obj)
      return frame ? [[frame.id, frame] as const] : []
    }))
    const frames = base.frames.map((frame) => projectedFrames.get(frame.id) ?? frame)
    const transformed = new Map<string, Point>()
    const direct = new Set(members.flatMap((obj) => idOf(obj) ?? []))
    const detached = new Set<string>()
    const records = new Map<string, () => Scene['objects'][number] | null>()
    for (const obj of members) {
      const id = idOf(obj)
      if (id === undefined || co.has(id)) continue
      const projected = scale?.content(obj)
      transformed.set(id, projected?.centre ?? centerOf(obj))
      if (projected) records.set(id, projected.record)
      if (captionOf(obj)) {
        const before = base.objects.find((item) => item.id === id)
        const after = projected ? projected.record() : toRecord(obj)
        if (before?.type === 'text' && after?.type === 'text' && captionWillDetach(before, after, direct)) detached.add(id)
      }
    }
    const stationary = new Map<string, Point>()
    if (scale && co.size > 0) {
      for (const obj of objects) {
        const id = idOf(obj)
        if (id !== undefined && co.has(ownerOf(obj) ?? '') && !transformed.has(id)) stationary.set(id, centerOf(obj))
      }
    }
    const outcome = previewOwnership(base, transformed, frames, co, stationary, detached, this.captionSnap ?? undefined)
    this.outcome = NO_OUTCOME
    if (!outcome.gaining.length && !outcome.losing.length) return
    const same = scale
      ? sceneEqual({ frames, objects: base.objects.map((o) => records.get(o.id)?.() ?? o) }, base)
      : !this.captionSnap && unchanged()
    if (!same) this.outcome = outcome
  }

  showDrop(point: Point, frames: readonly FrameRecord[]) {
    this.drop = { point, frameId: ownerAfterManipulation(undefined, point, frames, NO_FRAMES) }
  }

  clearDrop(): boolean {
    if (!this.drop) return false
    this.drop = null
    return true
  }

  clearCaptionSnap(): boolean {
    if (!this.captionSnap) return false
    this.captionSnap = null
    this.outcome = NO_OUTCOME
    return true
  }

  clearInteraction(): boolean {
    this.edgePan.pause()
    const visible = this.clearDrop() || this.raised.size > 0 || this.carried.length > 0 || this.outcome.gaining.length > 0 || this.outcome.losing.length > 0
    for (const [obj, shadow] of this.raised) obj.set({ shadow })
    this.raised.clear()
    this.outcome = NO_OUTCOME
    this.carried = EMPTY
    return visible
  }

  clear(): boolean {
    this.edgePan.stop()
    const interactionCleared = this.clearInteraction()
    return this.clearCaptionSnap() || interactionCleared
  }

  draw(ctx: CanvasRenderingContext2D, objects: readonly FabricObject[], viewport: readonly number[]) {
    const { gaining, losing } = this.outcome
    if (!gaining.length && !losing.length && !this.carried.length && !this.drop && !this.captionSnap) return
    ctx.save()
    ctx.strokeStyle = ACCENT
    for (const obj of objects) {
      const id = idOf(obj)
      if (id === undefined) continue
      const gain = gaining.includes(id) || this.drop?.frameId === id
      const lose = losing.includes(id)
      if (gain || lose) {
        const { left, top, width, height } = frameOverlay(obj, viewport).outline
        ctx.lineWidth = 2
        if (gain) {
          ctx.setLineDash([])
          ctx.strokeRect(left, top, width, height)
        }
        if (lose) {
          ctx.setLineDash([6, 4])
          const gap = gain ? 4 : 0
          ctx.strokeRect(left - gap, top - gap, width + gap * 2, height + gap * 2)
        }
      }
      if (this.carried.includes(id)) {
        ctx.setLineDash([])
        ctx.lineWidth = 1
        ctx.beginPath()
        for (const [index, p] of obj.getCoords().entries()) {
          const { x, y } = bounds(p, viewport)
          if (index === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.closePath()
        ctx.stroke()
      }
    }
    if (this.drop) {
      const { x, y } = bounds(this.drop.point, viewport)
      ctx.setLineDash([])
      ctx.lineWidth = 2
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(x, y, 8, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(x, y, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = ACCENT
      ctx.fill()
    }
    if (this.captionSnap) drawCaptionSnap(ctx, this.captionSnap, (point) => bounds(point, viewport))
    ctx.restore()
  }
}
