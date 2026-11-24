import { Textbox } from 'fabric'
import type { FabricObject } from 'fabric'
import { captionImageBounds, captionPlacement } from '../model/captions.ts'
import { snapCandidate, storedSnapSide } from '../model/captionSnap.ts'
import type { SnapCandidate, SnapImage } from '../model/captionSnap.ts'
import type { CaptionSide } from '../model/types.ts'
import type { Point, Rect } from '../model/viewport.ts'
import { ACCENT, captionOf, captionSideOf, createObject, idOf, imageSizeOf, isImage, isLocked, toRecord } from './objects.ts'

export interface CaptionSnapPreview extends SnapCandidate {
  readonly textId: string
  readonly frameId?: string
  readonly bounds: Readonly<Rect>
  readonly box: Readonly<Rect>
  readonly size: Readonly<{ width: number; height: number; fontSize: number }>
}

/** Use the same drawn box and wrapping that will appear once the text is a caption. */
export function makeSnapCaption(text: Textbox): Textbox | null {
  const rec = toRecord(text)
  if (rec?.type !== 'text') return null
  const box = createObject({ ...rec, minHeight: rec.minHeight ?? 0 }, () => undefined)
  return box instanceof Textbox ? box : null
}

/**
 * What caption snapping reads from a dragged text, whichever renderer draws it: a Fabric text box
 * (`findCaptionSnap`) or a DOM text proxy (`textAdapter.ts`). `center`, `width` and `height` are
 * the live position and scaled size (Fabric fires object:moving before refreshing aCoords).
 */
export interface SnapText {
  id: string | undefined
  editing: boolean
  locked: boolean
  angle: number
  blank: boolean
  fontSize: number
  center: Point
  width: number
  height: number
  side: CaptionSide | undefined
}

/**
 * Where a dragged text would land as a caption, or null. `probe` gives the size the text will
 * have once it is a caption (a drawn box); it is asked at most once per drag.
 */
export function snapPreview(
  text: SnapText,
  objects: readonly FabricObject[],
  zoom: number,
  previous: CaptionSnapPreview | null,
  probe: () => CaptionSnapPreview['size'] | null,
): CaptionSnapPreview | null {
  const textId = text.id
  if (!textId || text.editing || text.locked || text.angle % 360 !== 0 || text.blank) return null
  const attached = new Map<string, string>()
  for (const obj of objects) {
    const imageId = captionOf(obj)
    const id = idOf(obj)
    if (imageId && id && !attached.has(imageId)) attached.set(imageId, id)
  }
  const images: Array<SnapImage & { frameId?: string }> = []
  for (let i = objects.length - 1; i >= 0; i--) {
    const image = objects[i]
    if (!isImage(image)) continue
    const rec = toRecord(image)
    if (rec?.type !== 'image') continue
    images.push({
      imageId: rec.id, bounds: captionImageBounds(rec, imageSizeOf(image)), frameId: rec.frameId,
      locked: isLocked(image), captionId: attached.get(rec.id),
    })
  }
  const { x, y } = text.center
  const { width, height } = text
  const result = snapCandidate({
    id: textId,
    bounds: { left: x - width / 2, top: y - height / 2, right: x + width / 2, bottom: y + height / 2 },
    attachedSide: text.side ?? 'under',
  }, images, zoom, text.fontSize)
  if (!result) return null

  const image = images.find((item) => item.imageId === result.imageId)
  if (!image) return null
  // The text's measurements are constant for the lifetime of this drag.
  const measured = previous?.textId === textId ? previous.size : probe()
  if (!measured) return null
  const size = { width: measured.width, height: measured.height, fontSize: measured.fontSize }
  const pos = captionPlacement(image.bounds, storedSnapSide(result.side), size, result.position)
  return {
    ...result, textId, frameId: image.frameId, bounds: image.bounds, size,
    box: { left: pos.left, top: pos.top, right: pos.left + size.width, bottom: pos.top + size.height },
  }
}

export function findCaptionSnap(text: Textbox, objects: readonly FabricObject[], zoom: number, previous: CaptionSnapPreview | null): CaptionSnapPreview | null {
  return snapPreview({
    id: idOf(text),
    editing: text.isEditing,
    locked: isLocked(text),
    angle: text.angle,
    blank: text.text.trim() === '',
    fontSize: text.fontSize,
    center: text.getCenterPoint(),
    width: text.getScaledWidth(),
    height: text.getScaledHeight(),
    side: captionSideOf(text),
  }, objects, zoom, previous, () => makeSnapCaption(text))
}

export function drawCaptionSnap(ctx: CanvasRenderingContext2D, preview: CaptionSnapPreview, screen: (p: Point) => Point) {
  const rect = preview.bounds
  const min = screen({ x: rect.left, y: rect.top })
  const max = screen({ x: rect.right, y: rect.bottom })
  const horizontal = preview.side === 'top' || preview.side === 'under'
  const edgeX = preview.side === 'left' ? min.x : max.x
  const edgeY = preview.side === 'top' ? min.y : max.y
  ctx.strokeStyle = ACCENT
  ctx.setLineDash([])
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(horizontal ? min.x : edgeX, horizontal ? edgeY : min.y)
  ctx.lineTo(horizontal ? max.x : edgeX, horizontal ? edgeY : max.y)
  ctx.stroke()

  const a = screen({ x: preview.box.left, y: preview.box.top })
  const b = screen({ x: preview.box.right, y: preview.box.bottom })
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 3])
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
}
