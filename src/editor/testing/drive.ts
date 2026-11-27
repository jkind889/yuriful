/**
 * Drives the fake Fabric canvas the way real Fabric drives the editor: the same events,
 * with the same payload fields, in the same order as Fabric 7.4's mouse handlers. Only for tests.
 */
import type { Editor } from '../Editor.ts'
import { ActiveSelection } from './fakeFabric.ts'
import type { Canvas, FakeObject, FakeTransform } from './fakeFabric.ts'

export const canvasOf = (editor: Editor): Canvas => (editor as unknown as { canvas: Canvas }).canvas

export const mouse = (button = 0, x = 0, y = 0) => ({ button, clientX: x, clientY: y })

/** Lets queued microtasks (settlement, idle) run. */
export async function tick() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

export interface PressOptions {
  action?: string
  corner?: string
  originX?: FakeTransform['originX']
  originY?: FakeTransform['originY']
}

/** Primary press on an object: Fabric sets up its transform and fires `before:transform`. */
export function press(canvas: Canvas, target: FakeObject, opts: PressOptions = {}): FakeTransform {
  const transform: FakeTransform = {
    target,
    action: opts.action ?? 'drag',
    actionPerformed: false,
    corner: opts.corner ?? '',
    originX: opts.originX ?? 'left',
    originY: opts.originY ?? 'top',
    original: { scaleX: target.scaleX, scaleY: target.scaleY, left: target.left, top: target.top },
  }
  canvas._currentTransform = transform
  canvas.fire('before:transform', { e: mouse(0), transform })
  canvas.fire('mouse:down', { e: mouse(0), target })
  return transform
}

/**
 * Pointer movement during a drag. The fake has no group transform, so a multi-selection
 * is modelled by its end result: its members move with it (their coordinates stay absolute).
 */
export function dragBy(canvas: Canvas, transform: FakeTransform, dx: number, dy: number) {
  const target = transform.target
  for (const o of target instanceof ActiveSelection ? [target, ...target.getObjects()] : [target]) {
    o.left += dx
    o.top += dy
  }
  transform.actionPerformed = true
  canvas.fire('object:moving', { e: mouse(0), target, transform })
}

/**
 * Pointer movement on a corner handle: scales about the transform's anchor, as Fabric
 * does. `factor` is relative to the start of the gesture. For a multi-selection the
 * members are scaled and repositioned about the same anchor (their absolute result).
 */
export function scaleBy(canvas: Canvas, transform: FakeTransform, factor: number, factorY = factor) {
  const t = transform.target
  const anchor = t.translateToOriginPoint(t.getCenterPoint(), transform.originX, transform.originY)
  const stepX = (transform.original.scaleX * factor) / t.scaleX
  const stepY = (transform.original.scaleY * factorY) / t.scaleY
  if (t instanceof ActiveSelection) {
    for (const m of t.getObjects()) {
      m.left = anchor.x + (m.left - anchor.x) * stepX
      m.top = anchor.y + (m.top - anchor.y) * stepY
      m.scaleX *= stepX
      m.scaleY *= stepY
    }
  }
  t.scaleX = transform.original.scaleX * factor
  t.scaleY = transform.original.scaleY * factorY
  t.setPositionByOrigin(anchor, transform.originX, transform.originY)
  transform.actionPerformed = true
  canvas.fire('object:scaling', { e: mouse(0), target: t, transform })
}

/**
 * Button release. For the primary button this is Fabric's `__onMouseUp`: finalize the
 * transform (`object:modified` only if it did anything), fire `mouse:up`, then forget
 * the transform. Any other button only fires `mouse:up` (which Fabric itself would not
 * even do with fireRightClick/fireMiddleClick off; the editor must cope anyway).
 */
export function release(canvas: Canvas, transform: FakeTransform | null, button = 0) {
  if (button !== 0) {
    canvas.fire('mouse:up', { e: mouse(button), isClick: false })
    return
  }
  const current = transform !== null && canvas._currentTransform === transform ? transform : null
  if (current?.actionPerformed) {
    canvas.fire('object:modified', { e: mouse(0), target: current.target, transform: current, action: current.action })
  }
  canvas.fire('mouse:up', { e: mouse(0), isClick: !transform?.actionPerformed, target: transform?.target })
  canvas._currentTransform = null
}

// ---- the Frame tool: presses on the canvas itself, with no target ---------------------------

/** Press with the Frame tool (or any press that hits nothing). Scene coordinates. */
export function pressCanvas(canvas: Canvas, x: number, y: number, button = 0) {
  canvas.fire('mouse:down', { e: mouse(button, x, y) })
}
export function moveCanvas(canvas: Canvas, x: number, y: number) {
  canvas.fire('mouse:move', { e: mouse(0, x, y) })
}
export function releaseCanvas(canvas: Canvas, x: number, y: number, button = 0) {
  canvas.fire('mouse:up', { e: mouse(button, x, y), isClick: false })
}
