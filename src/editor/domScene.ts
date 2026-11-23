import { ActiveSelection } from 'fabric'
import type { FabricImage, FabricObject, Transform } from 'fabric'
import { roundPositive } from '../model/doc.ts'
import type { FrameRecord, ImageRecord, ObjectRecord, Scene, TextRecord } from '../model/types.ts'
import type { AssetSource } from './assets.ts'
import type { FrameCanvas } from './FrameCanvas.ts'
import { SceneLayer } from './sceneLayer.ts'
import type { CardMeasurer } from './sceneLayer.ts'
import { canAnimate, stillFrame } from './stillImage.ts'
import { ProxyRect, frameNameOf, idOf, imageCropOf, imageDataOf, isFrame, setTextData, textDataOf, toRecord } from './objects.ts'
import type { TextData } from './objects.ts'

/** Which point of a text's box stays where it is when its width changes: its alignment edge. */
export type WidthAnchor = 'left' | 'center' | 'right'

/** How `syncCard` brings a text proxy to its card's size. */
export interface CardSync {
  /**
   * The text or its formatting changed: a wrap width narrower than its widest word (grapheme, on
   * a drawn box) widens to it, keeping this edge of the box where it is, as a text box does.
   */
  widen?: WidthAnchor
  /**
   * This point of the box (Fabric origins) stays where it is while the height changes: a side
   * handle's anchor, which Fabric keeps fixed while a text box re-wraps inside `changeWidth`.
   */
  hold?: { x: Transform['originX']; y: Transform['originY'] }
  /**
   * Leave the stored wrap width alone even when the card is drawn wider than it (a late font
   * load: Fabric never lays a text box out again then, so its record keeps the width it had).
   */
  keepWidth?: boolean
}

export interface DomSceneOptions {
  measurer?: CardMeasurer
  /** A pointer gesture is unsettled: late font loads wait for it (they never change a gesture). */
  gestureActive: () => boolean
}

/**
 * The DOM renderer's drawing (plan Sections 4, 6 and 9): the scene layer under a transparent
 * Fabric canvas whose objects are proxies (`objects.ts` `createProxy`). Fabric stays the source
 * of truth for where things are; the layer only follows it.
 *
 *  - Every Fabric render (`before:render`, on the main context) brings the layer up to date in the
 *    same animation frame as the canvas chrome: what each item shows (only items whose data
 *    object changed, or the whole scene when objects were added, removed or reordered), the
 *    viewport, then each item's matrix from its proxy's `calcTransformMatrix()` and untransformed
 *    size (standalone or inside a multi-selection), then culling.
 *  - A text proxy's width and height come from the layer: its effective width and measured
 *    height (`syncCard`), at the flush points the editor calls synchronously and whenever a text
 *    proxy is added to the canvas. Like a Fabric text box, its wrap width holds the effective
 *    width once it has been laid out (a stored width narrower than the widest word widens, the
 *    left edge kept), so a save writes what a Fabric save writes.
 *  - A late font load lays the cards out again and re-sizes the proxies, both only once no
 *    gesture is unsettled; it never touches ownership, history or the save state.
 *
 * Only built for `renderer: 'dom'`; the default Fabric renderer never constructs one.
 */
export class DomScene {
  readonly layer: SceneLayer
  /** Per id, what the layer was last given: a data object (texts, images) or a frame's size. */
  private readonly shown = new Map<string, unknown>()
  /** Per id, the matrix and size an item was last placed with. */
  private readonly placed = new Map<string, string>()
  private order: string | null = null
  private view = ''
  private readonly moving = new Set<string>()
  private fontsPending = false
  /** Something was placed or re-sized since the last cull. */
  private cullPending = false
  private mounted = false
  private disposed = false
  /** Stills of images that can animate, by asset id (null: none, or still being made). */
  private readonly stills = new Map<string, string | null>()
  private readonly urls: string[] = []
  private readonly cleanups: Array<() => void> = []

  constructor(
    private readonly canvas: FrameCanvas,
    private readonly host: HTMLElement,
    private readonly assets: AssetSource,
    private readonly opts: DomSceneOptions,
  ) {
    // The layer does not follow font loads by itself: they wait for a gesture to settle (see `onFontsLoaded`).
    this.layer = new SceneLayer({ getImage: (id) => assets.get(id), getStill: (id) => this.still(id), measurer: opts.measurer, followFonts: false })
    // The canvas, transparent, lies over the layer, so handles, frame outlines and labels are
    // drawn crisp over every item. The host keeps both stacked inside it, under the overlays.
    host.style.isolation = 'isolate'
    canvas.wrapperEl.style.zIndex = '2'
    canvas.on('before:render', ({ ctx }) => {
      if (ctx === canvas.getContext()) this.render()
    })
    // A side handle changes a text's wrap width: the card wraps again and the proxy takes its
    // height, keeping the handle's anchor where Fabric keeps it (flush point 5).
    canvas.on('object:resizing', ({ transform }) => {
      const target = transform.target
      const td = textDataOf(target)
      if (!td) return
      setTextData(target, { ...td, width: target.width })
      this.syncCard(target, { hold: { x: transform.originX, y: transform.originY } })
    })
    // Whatever adds a text proxy (a rebuild, Make caption, ...), it is sized from its card before
    // anything selects it, decides its owner or commits.
    canvas.on('object:added', ({ target }) => {
      if (textDataOf(target)) this.syncCard(target)
    })
  }

  /**
   * Puts the layer under the canvas once the app's stylesheet applies (a card measured without
   * it would be measured in the wrong font and line height): at once when it does, or when the
   * page has finished loading.
   */
  mount() {
    const attach = () => {
      if (this.disposed || this.mounted) return
      this.layer.mount(this.host)
      this.mounted = true
      // After the layer's own listener, which lays every card out again first.
      document.fonts?.addEventListener('loadingdone', this.onFontsLoaded)
      this.cleanups.push(() => document.fonts?.removeEventListener('loadingdone', this.onFontsLoaded))
      // The layer laid every card out again on mounting: the board's first real layout.
      this.typographyChanged({})
    }
    this.layer.mount(this.host)
    const styled = getComputedStyle(this.layer.root).position === 'absolute'
    this.layer.unmount()
    if (styled || document.readyState === 'complete') {
      attach()
      return
    }
    window.addEventListener('load', attach, { once: true })
    this.cleanups.push(() => window.removeEventListener('load', attach))
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const c of this.cleanups.splice(0)) c()
    this.layer.dispose()
    for (const url of this.urls.splice(0)) URL.revokeObjectURL(url)
    this.stills.clear()
    this.host.style.isolation = ''
  }

  // ---- the editor's flush points ----------------------------------------------------------------

  /**
   * After the canvas was rebuilt from records (load, undo, redo, a cancelled gesture): the whole
   * scene, and every text proxy sized from its card, before a selection is formed (flush point 1).
   */
  rebuild() {
    if (this.disposed) return
    const objs = this.canvas.getObjects()
    this.order = null
    this.syncContent(objs)
    for (const o of objs) if (textDataOf(o)) this.sizeFromLayer(o)
    this.placeAll(objs)
  }

  /**
   * Lays a text's card out from its data now and sizes the proxy from it: the effective width and
   * the measured height (see `CardSync` for which point stays put and whether the wrap width
   * holds the effective width).
   */
  syncCard(obj: FabricObject, sync: CardSync = {}) {
    const id = idOf(obj)
    let td = textDataOf(obj)
    if (this.disposed || !id || !td) return
    if (!this.layer.elementOf(id)) this.syncContent(this.canvas.getObjects())
    if (!this.layer.elementOf(id)) return
    const { widen } = sync
    const origin = sync.hold ?? (widen ? { x: widen, y: 'top' as const } : undefined)
    const anchor = origin ? obj.translateToOriginPoint(obj.getCenterPoint(), origin.x, origin.y) : undefined
    this.layer.updateItem(this.textRecord(id, td))
    this.shown.set(id, td)
    if (widen) {
      const min = this.minWidthOf(obj)
      if (min > td.width) {
        td = { ...td, width: roundPositive(min) }
        setTextData(obj, td)
        this.layer.updateItem(this.textRecord(id, td))
        this.shown.set(id, td)
      }
    }
    this.sizeFromLayer(obj, !sync.keepWidth)
    if (anchor && origin) obj.setPositionByOrigin(anchor, origin.x, origin.y)
    obj.setCoords()
    this.placed.delete(id)
    this.place(obj)
  }

  /** Every text proxy sized from its card (`fit`, and after fonts load). */
  syncAllCards(sync: CardSync = {}) {
    if (this.disposed) return
    for (const o of this.canvas.getObjects()) if (textDataOf(o)) this.syncCard(o, sync)
    const active = this.canvas.getActiveObject()
    if (active instanceof ActiveSelection) active.triggerLayout?.()
    this.canvas.requestRenderAll()
  }

  /** The narrowest width a text allows (scene units): its widest word, or grapheme on a drawn box. */
  minWidthOf(obj: FabricObject): number {
    const id = idOf(obj)
    const body = id ? this.layer.bodyOf(id) : undefined
    const td = textDataOf(obj)
    return body && id && td ? this.layer.measurer.measureMinWidth(body, this.textRecord(id, td)) : 0
  }

  // ---- following Fabric --------------------------------------------------------------------------

  /** Runs on every Fabric render of the main canvas, before anything is drawn on it. */
  private render() {
    if (this.disposed) return
    const objs = this.canvas.getObjects()
    if (this.fontsPending && !this.opts.gestureActive()) {
      this.fontsPending = false
      this.applyFonts()
    }
    let changed = this.syncContent(objs)
    const vpt = this.canvas.viewportTransform
    const size = { width: this.canvas.getWidth(), height: this.canvas.getHeight() }
    const view = `${vpt.join(',')}|${size.width}|${size.height}`
    if (view !== this.view) {
      this.view = view
      this.layer.setViewportTransform(vpt)
      changed = true
    }
    if (this.placeAll(objs)) changed = true
    if (this.syncMoving()) changed = true
    // Idle items wholly outside the view skip layout and paint; moving ones stay drawn. Whatever
    // moved or re-sized an item since the last render (also outside a render) counts.
    if (changed || this.cullPending) {
      this.cullPending = false
      this.layer.cull(size)
    }
  }

  /** Gives the layer what changed since it was last given the scene. True when anything did. */
  private syncContent(objs: readonly FabricObject[]): boolean {
    const order = objs.map((o) => idOf(o) ?? '').join('\n')
    if (order !== this.order) {
      this.order = order
      const scene: Scene = { frames: [], objects: [] }
      for (const o of objs) {
        const rec = this.layerRecord(o)
        if (!rec) continue
        if ('type' in rec) scene.objects.push(rec)
        else scene.frames.push(rec)
      }
      this.layer.setRecords(scene)
      this.shown.clear()
      for (const o of objs) this.shown.set(idOf(o) ?? '', this.shownKey(o))
      this.placed.clear()
      return true
    }
    let changed = false
    for (const o of objs) {
      const id = idOf(o)
      const key = this.shownKey(o)
      if (!id || this.shown.get(id) === key) continue
      const rec = this.layerRecord(o)
      if (!rec) continue
      this.layer.updateItem(rec)
      this.shown.set(id, key)
      this.placed.delete(id)
      changed = true
    }
    return changed
  }

  /** What tells whether an item must be drawn again: a text's or image's data object (replaced on every change), a frame's size. */
  private shownKey(o: FabricObject): unknown {
    return textDataOf(o) ?? imageDataOf(o) ?? `${o.width}|${o.height}`
  }

  /**
   * The record the layer draws an item from. Geometry is left out (each item is placed from its
   * proxy's matrix instead), so moving an item never draws it again; a frame's untransformed
   * size and a text's unscaled card are kept.
   */
  private layerRecord(o: FabricObject): FrameRecord | ObjectRecord | null {
    const id = idOf(o)
    if (!id) return null
    if (isFrame(o)) return { id, name: frameNameOf(o) ?? '', left: 0, top: 0, width: o.width, height: o.height }
    const td = textDataOf(o)
    if (td) return this.textRecord(id, td)
    const rec = toRecord(o)
    if (rec?.type !== 'image') return null
    const crop = imageCropOf(o as FabricImage)
    const image: ImageRecord = { id, type: 'image', assetId: rec.assetId, left: 0, top: 0, angle: 0, scaleX: 1, scaleY: 1, ...(crop && { crop }) }
    return image
  }

  private textRecord(id: string, td: TextData): TextRecord {
    return { id, type: 'text', left: 0, top: 0, angle: 0, ...td }
  }

  /**
   * A text proxy takes its card's effective width and measured height, and its narrowest width for
   * side handles. `holdWidth`: a card drawn wider than its stored wrap width (its widest word is
   * wider) makes that its wrap width, as a Fabric text box widens itself when it lays its text out.
   */
  private sizeFromLayer(o: FabricObject, holdWidth = true) {
    const id = idOf(o)
    if (!id) return
    const width = this.layer.widthOf(id)
    const height = this.layer.heightOf(id)
    if (width === undefined || height === undefined) return
    const td = textDataOf(o)
    if (holdWidth && td && width > td.width) {
      const held = { ...td, width }
      setTextData(o, held)
      this.layer.updateItem(this.textRecord(id, held))
      this.shown.set(id, held)
    }
    if (o instanceof ProxyRect) o.minTextWidth = Math.min(this.minWidthOf(o), width)
    o.set({ width, height })
    o.setCoords()
  }

  /** Places every item whose proxy moved, turned, scaled or changed size. True when any did. */
  private placeAll(objs: readonly FabricObject[]): boolean {
    let any = false
    for (const o of objs) if (this.place(o)) any = true
    return any
  }

  private place(o: FabricObject): boolean {
    const id = idOf(o)
    if (!id) return false
    const m = o.calcTransformMatrix()
    const key = `${m.join(',')}|${o.width}|${o.height}`
    if (this.placed.get(id) === key) return false
    this.layer.setItemMatrix(id, m, { width: o.width, height: o.height })
    this.placed.set(id, key)
    this.cullPending = true
    return true
  }

  /** The items Fabric is transforming right now are composited on their own layer and never culled. */
  private syncMoving(): boolean {
    const t = this.canvas._currentTransform
    const targets = t ? (t.target instanceof ActiveSelection ? t.target.getObjects() : [t.target]) : []
    const now = new Set(targets.map((o) => idOf(o)).filter((id): id is string => id !== undefined))
    let changed = false
    for (const id of this.moving) {
      if (now.has(id)) continue
      this.layer.setMoving(id, false)
      this.moving.delete(id)
      changed = true
    }
    for (const id of now) {
      if (this.moving.has(id)) continue
      this.layer.setMoving(id, true)
      this.moving.add(id)
      changed = true
    }
    return changed
  }

  // ---- fonts and stills ----------------------------------------------------------------------------

  /**
   * A font finished loading. Cards and proxies change together, never in the middle of a gesture:
   * until it settles, the layer keeps every card as it was laid out (the next render after it
   * applies the font, see `render`).
   */
  private readonly onFontsLoaded = () => {
    if (this.disposed) return
    if (this.opts.gestureActive()) {
      this.fontsPending = true
      return
    }
    this.applyFonts()
  }

  private applyFonts() {
    this.layer.refreshTypography()
    this.typographyChanged({ keepWidth: true })
  }

  /** The layer has laid every card out again (it was mounted, or a font loaded): proxies follow at once. */
  private typographyChanged(sync: CardSync) {
    if (this.disposed) return
    // Laying a card out again puts it back at the layer's origin: place everything again at once.
    this.placed.clear()
    this.placeAll(this.canvas.getObjects())
    this.syncAllCards(sync)
    this.canvas.requestRenderAll()
  }

  /**
   * A still (first frame) of an image that can animate, so it stays still as on the canvas
   * (`stillImage.ts`), made once per asset from the bytes the asset cache keeps. Until it is
   * ready, and for an image that cannot animate, the decoded image is shown.
   */
  private still(assetId: string): string | undefined {
    const known = this.stills.get(assetId)
    if (known !== undefined) return known ?? undefined
    this.stills.set(assetId, null)
    const asset = this.assets.bytes(assetId)
    const el = this.assets.get(assetId)
    if (!asset || !el || !canAnimate(asset.type)) return undefined
    void stillFrame(asset, el)
      .then((blob) => {
        if (!blob || this.disposed) return
        const url = URL.createObjectURL(blob)
        this.urls.push(url)
        this.stills.set(assetId, url)
        for (const o of this.canvas.getObjects()) {
          const id = idOf(o)
          const rec = toRecord(o)
          if (!id || !imageDataOf(o) || rec?.type !== 'image' || rec.assetId !== assetId) continue
          const shown = this.layerRecord(o)
          if (shown) this.layer.updateItem(shown, true)
          this.placed.delete(id)
          this.place(o)
        }
        this.canvas.requestRenderAll()
      })
      .catch(() => {
        /* the decoded image stays shown */
      })
    return undefined
  }
}
