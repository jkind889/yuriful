import { ActiveSelection, Point, Textbox, util } from 'fabric'
import type { FabricObject, Transform } from 'fabric'
import { round, roundPositive } from '../model/doc.ts'
import { allowedScaleFactor, minFrameSide } from '../model/frames.ts'
import type { FrameRecord, ObjectRecord, Scene, TextRecord } from '../model/types.ts'
import { DrawnTextbox } from './DrawnTextbox.ts'
import { captionOf, captionSideOf, centerOf, createObject, idOf, isFrame, normalizeTextScale, ownerOf, readTextFormatting, toFrameRecord, toRecord } from './objects.ts'

const originFraction = (origin: string | number) =>
  typeof origin === 'number' ? origin : origin === 'center' ? 0.5 : origin === 'right' || origin === 'bottom' ? 1 : 0

interface ContentProjection {
  centre: Point
  record: () => ObjectRecord | null
}

const currentContent = (obj: FabricObject): ContentProjection => ({ centre: new Point(centerOf(obj)), record: () => toRecord(obj) })

/** Project the scale that will be kept on release, without folding anything on the live canvas. */
export function feedbackScale(base: Scene, transform: Transform, members: readonly FabricObject[]) {
  if (transform.action !== 'scale' && transform.action !== 'scaleX' && transform.action !== 'scaleY') return null
  const { target, original, originX, originY } = transform
  const anchor = target.translateToOriginPoint(target.getCenterPoint(), originX, originY)
  if (isFrame(target)) {
    const record = toFrameRecord(target)
    const before = base.frames.find((f) => f.id === idOf(target))
    if (!record || !before) return null
    const width = roundPositive(Math.max(target.width * Math.abs(target.scaleX), minFrameSide(before.width)))
    const height = roundPositive(Math.max(target.height * Math.abs(target.scaleY), minFrameSide(before.height)))
    const frame = { ...record, width, height, left: round(anchor.x - originFraction(originX) * width), top: round(anchor.y - originFraction(originY) * height) }
    return { content: currentContent, frame: () => frame }
  }

  const ids = new Set(members.map(idOf))
  const requested = target.scaleX / original.scaleX
  const allowed = allowedScaleFactor(
    requested,
    base.frames.filter((f) => ids.has(f.id)),
    base.objects.filter((o): o is TextRecord => o.type === 'text' && ids.has(o.id)),
  )
  const limited = Math.abs(allowed - requested) > 1e-9
  const ratioX = limited ? original.scaleX * allowed / target.scaleX : 1
  const ratioY = limited ? original.scaleY * allowed / target.scaleY : 1
  const radians = util.degreesToRadians(target.angle)
  const project = (obj: FabricObject) => {
    const { x, y } = centerOf(obj)
    if (!limited) return new Point(x, y)
    const local = new Point(x - anchor.x, y - anchor.y).rotate(-radians)
    return new Point(local.x * ratioX, local.y * ratioY).rotate(radians).add(anchor)
  }
  const frame = (obj: FabricObject): FrameRecord | null => {
    const record = toFrameRecord(obj)
    if (!record) return null
    const centre = project(obj)
    const absolute = util.qrDecompose(obj.calcTransformMatrix())
    const width = obj.width * Math.abs(absolute.scaleX) * ratioX
    const height = obj.height * Math.abs(absolute.scaleY) * ratioY
    return { ...record, left: round(centre.x - width / 2), top: round(centre.y - height / 2), width: roundPositive(width), height: roundPositive(height) }
  }
  const content = (obj: FabricObject): ContentProjection => {
    const centre = project(obj)
    const absolute = util.qrDecompose(obj.calcTransformMatrix())
    const sx = Math.abs(absolute.scaleX) * ratioX
    const sy = Math.abs(absolute.scaleY) * ratioY
    const angle = absolute.angle
    const offset = new Point(obj.width * sx / 2, obj.height * sy / 2).rotate(util.degreesToRadians(angle))
    const left = centre.x - offset.x
    const top = centre.y - offset.y
    if (!(obj instanceof Textbox)) {
      if (!limited) return currentContent(obj)
      return { centre, record: () => {
        const record = toRecord(obj)
        return record?.type === 'image' ? { ...record, left: round(left), top: round(top), scaleX: roundPositive(sx, 5), scaleY: roundPositive(sy, 5) } : record
      } }
    }
    if (!limited && Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return currentContent(obj)
    // Folding can change wrap and hence the centre. Run the same text layout on a detached
    // copy at the projected world top-left. The live text and its selection stay untouched.
    const frameId = ownerOf(obj)
    const copy = createObject({
      ...readTextFormatting(obj),
      id: idOf(obj) ?? '',
      type: 'text',
      text: obj.text,
      left,
      top,
      angle,
      width: obj.width,
      fontSize: obj.fontSize,
      captionOf: captionOf(obj),
      captionSide: captionSideOf(obj),
      ...(frameId !== undefined && { frameId }),
      ...(obj instanceof DrawnTextbox && { minHeight: obj.minHeight }),
    }, () => undefined)
    if (!(copy instanceof Textbox)) return currentContent(obj)
    copy.set({ width: obj.width, scaleX: sx, scaleY: sy })
    normalizeTextScale(copy)
    return currentContent(copy)
  }
  return { content, frame: target instanceof ActiveSelection ? frame : toFrameRecord }
}
