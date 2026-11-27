import { ActiveSelection, Canvas, Point } from 'fabric'
import type { FabricObject, TPointerEvent } from 'fabric'
import type { Box } from '../model/frames.ts'
import { drawFrameOverlays, frameOverlay, hitsFrameOverlay } from './frameLayer.ts'
import type { DrawnFrame } from './frameLayer.ts'
import { isFrame, isLocked } from './objects.ts'

type TargetsInfo = ReturnType<Canvas['searchPossibleTargets']>

/**
 * A Fabric canvas that knows what a frame is.
 *
 * A frame is a white rectangle behind all content, but it is grabbed only by its
 * label or by a band along its outline; its interior is click-through, so content
 * inside it (and the board beneath it, for a marquee) stays reachable. The outline and
 * label are drawn over the scene in screen pixels, from the same geometry that is hit.
 *
 * The five overrides reach into Fabric internals. They use the `override` keyword, so
 * a rename in Fabric is a compile error rather than a silent loss of behaviour.
 */
export class FrameCanvas extends Canvas {
  /** Rectangle (scene units) of a frame that is being drawn; rendered dashed, following the view. */
  draft: Box | null = null

  constructor(...args: ConstructorParameters<typeof Canvas>) {
    super(...args)
    this.on('after:render', ({ ctx }) => {
      // Only the main scene: exports and other contexts get no editing chrome.
      if (ctx !== this.getContext()) return
      const selected = new Set<FabricObject>(this.getActiveObjects())
      const frames: DrawnFrame[] = []
      for (const obj of this.getObjects()) {
        if (isFrame(obj) && obj.visible) frames.push({ overlay: frameOverlay(obj, this.viewportTransform), selected: selected.has(obj) })
      }
      if (frames.length === 0 && !this.draft) return
      const [zoom, , , , panX, panY] = this.viewportTransform
      const d = this.draft
      const draft = d ? { left: d.left * zoom + panX, top: d.top * zoom + panY, width: d.width * zoom, height: d.height * zoom } : null
      drawFrameOverlays(ctx, frames, draft, this.getRetinaScaling())
    })
  }

  /** The front-most frame among `objects` whose label or outline is under the scene-space pointer. */
  frameOverlayAt(objects: readonly FabricObject[], pointer: Point): FabricObject | undefined {
    const viewportPoint = pointer.transform(this.viewportTransform)
    for (let i = objects.length - 1; i >= 0; i--) {
      const obj = objects[i] as FabricObject
      if (isFrame(obj) && obj.visible && obj.evented && hitsFrameOverlay(frameOverlay(obj, this.viewportTransform), viewportPoint)) return obj
    }
    return undefined
  }

  /**
   * A frame's label or outline wins over content beneath it, although the frame itself
   * is behind all content. Anything else is found the ordinary way (where a frame's
   * interior is not a target, see `_checkTarget`).
   */
  override searchPossibleTargets(objects: FabricObject[], pointer: Point): TargetsInfo {
    const frame = this.frameOverlayAt(objects, pointer)
    if (frame) {
      // The label (and the outer half of the outline band) of a frame that is part of the
      // current multi-selection lies outside the selection's box, so Fabric would not see
      // the press as "on the selection" and would collapse it to that one frame. Pressing
      // any part of a selected member acts on the whole selection. Only for the full-stack
      // search: when Fabric looks among the members themselves (Shift-click) it needs the
      // member, and `handleMultiSelection` below asks for the frame directly.
      const selection = this.getActiveObject()
      if (objects === this._objects && selection instanceof ActiveSelection && frame.group === selection) {
        return { target: selection, subTargets: [], container: selection }
      }
      return { target: frame, subTargets: [], container: frame }
    }
    return super.searchPossibleTargets(objects, pointer)
  }

  /** A frame is only ever hit through its overlay, so its interior is never a target. */
  override _checkTarget(obj: FabricObject, pointer: Point): boolean {
    if (isFrame(obj)) return this.frameOverlayAt([obj], pointer) !== undefined
    return super._checkTarget(obj, pointer)
  }

  /**
   * With Alt held (`altSelectionKey`), Fabric gives a press to the selected object when it is
   * under the pointer, even beneath other content: that is how a covered object selected
   * from the layer list is dragged. A frame's label or outline still wins over content,
   * as without Alt, so where one is under the pointer the press is resolved as usual (the
   * selected object's own handles are still found first).
   */
  override findTarget(e: TPointerEvent): ReturnType<Canvas['findTarget']> {
    const key = this.altSelectionKey
    if (!this._targetInfo && key && (e as MouseEvent)[key] && this.frameOverlayAt(this._objects, this.getScenePoint(e))) {
      this.altSelectionKey = null
      try {
        return super.findTarget(e)
      } finally {
        this.altSelectionKey = key
      }
    }
    return super.findTarget(e)
  }

  /**
   * Shift-click inside a multi-selection: Fabric looks among the selected members first,
   * so a frame's label lying over a selected image would toggle the image. A visible
   * label or outline is what the user clicked, so the frame is toggled instead.
   *
   * A selection that contains a locked object contains nothing else: Shift-clicking
   * something while a locked object (selected from the layer list) is selected does not
   * add to it, and the press is handled as a plain one (it selects what was clicked).
   * Fabric itself already refuses to add a locked object, which is not `selectable`.
   */
  protected override handleMultiSelection(e: TPointerEvent, target?: FabricObject): boolean {
    const active = this.getActiveObject()
    if (active && !(active instanceof ActiveSelection) && isLocked(active)) return false
    if (active instanceof ActiveSelection && this.selection && this._isSelectionKeyPressed(e) && !active.getActiveControl()) {
      const frame = this.frameOverlayAt(this.getObjects(), this.getScenePoint(e))
      if (frame && frame.selectable) return super.handleMultiSelection(e, frame)
    }
    return super.handleMultiSelection(e, target)
  }

  /** A marquee takes a frame only when it encloses the whole frame; touching it is not enough. */
  override collectObjects(bbox: Parameters<Canvas['collectObjects']>[0], options?: Parameters<Canvas['collectObjects']>[1]) {
    const tl = new Point(bbox.left, bbox.top)
    const br = new Point(bbox.left + bbox.width, bbox.top + bbox.height)
    return super.collectObjects(bbox, options).filter((obj) => !isFrame(obj as FabricObject) || obj.isContainedWithinRect(tl, br))
  }
}
