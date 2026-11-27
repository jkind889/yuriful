/**
 * Minimal stand-in for the parts of Fabric.js that Editor/objects use, so the real
 * Editor can be driven deterministically in jsdom (which has no canvas). Only for tests.
 *
 * It models state machines, not geometry: there is no rotation, no group transform
 * and no real event ordering. Anything about hit testing, multi-selection geometry
 * or Fabric's finalization order is only accepted on real-browser (Playwright) evidence.
 */

type Handler = (e: never) => void

/** Scene or viewport point with the one operation the editor uses. */
export class Point {
  constructor(
    public x = 0,
    public y = 0,
  ) {}
  transform(m: readonly number[]) {
    return new Point((m[0] ?? 1) * this.x + (m[2] ?? 0) * this.y + (m[4] ?? 0), (m[1] ?? 0) * this.x + (m[3] ?? 1) * this.y + (m[5] ?? 0))
  }
}
type Origin = 'left' | 'center' | 'right' | 'top' | 'bottom'
const originFactor = (o: Origin) => (o === 'center' ? 0.5 : o === 'right' || o === 'bottom' ? 1 : 0)

export class FakeObject {
  left = 0
  top = 0
  angle = 0
  scaleX = 1
  scaleY = 1
  width = 0
  height = 0
  isEditing = false
  visible = true
  evented = true
  selectable = true
  lockRotation = false
  group: unknown = null
  canvas: Canvas | null = null
  /** Which handles are shown, as last set through setControlsVisibility. */
  controls: Record<string, boolean> = {}
  constructor(opts: Record<string, unknown> = {}) {
    Object.assign(this, opts)
  }
  set(patch: Record<string, unknown>) {
    Object.assign(this, patch)
    return this
  }
  setCoords() {}
  setControlsVisibility(patch: Record<string, boolean> = {}) {
    this.controls = { ...this.controls, ...patch }
  }
  getActiveControl() {
    return undefined
  }
  private box() {
    return { left: this.left, top: this.top, right: this.left + this.width * this.scaleX, bottom: this.top + this.height * this.scaleY }
  }
  getBoundingRect() {
    const { left, top, right, bottom } = this.box()
    return { left, top, width: right - left, height: bottom - top }
  }
  containsPoint(p: { x: number; y: number }) {
    const b = this.box()
    return p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom
  }
  isContainedWithinRect(tl: { x: number; y: number }, br: { x: number; y: number }) {
    const b = this.box()
    return b.left >= tl.x && b.right <= br.x && b.top >= tl.y && b.bottom <= br.y
  }
  intersectsWithRect(tl: { x: number; y: number }, br: { x: number; y: number }) {
    const b = this.box()
    return b.left <= br.x && b.right >= tl.x && b.top <= br.y && b.bottom >= tl.y
  }
  calcTransformMatrix() {
    const sx = this.scaleX
    const sy = this.scaleY
    return [sx, 0, 0, sy, this.left + (this.width * sx) / 2, this.top + (this.height * sy) / 2]
  }
  getCoords() {
    return [
      { x: this.left, y: this.top },
      { x: this.left + this.width * this.scaleX, y: this.top },
      { x: this.left + this.width * this.scaleX, y: this.top + this.height * this.scaleY },
      { x: this.left, y: this.top + this.height * this.scaleY },
    ]
  }
  getCenterPoint() {
    return { x: this.left + (this.width * this.scaleX) / 2, y: this.top + (this.height * this.scaleY) / 2 }
  }
  /** The point of the (unrotated, left/top-origin) box named by an origin pair, given its centre. */
  translateToOriginPoint(center: { x: number; y: number }, originX: Origin, originY: Origin) {
    return {
      x: center.x + (originFactor(originX) - 0.5) * this.width * this.scaleX,
      y: center.y + (originFactor(originY) - 0.5) * this.height * this.scaleY,
    }
  }
  setPositionByOrigin(pos: { x: number; y: number }, originX: Origin, originY: Origin) {
    this.left = pos.x - originFactor(originX) * this.width * this.scaleX
    this.top = pos.y - originFactor(originY) * this.height * this.scaleY
  }
}

export class Textbox extends FakeObject {
  text: string
  fontSize = 24
  /** Like Fabric: a text that is not editable never enters editing. */
  editable = true
  fontFamily = 'Times New Roman'
  textAlign = 'left'
  fill: unknown = 'rgb(0,0,0)'
  /** Fabric's per-character styles: paragraph index -> grapheme index -> style. Never shifted by the fake. */
  styles: Record<number, Record<number, Record<string, unknown>>> = {}
  constructor(text: string, opts: Record<string, unknown> = {}) {
    super(opts)
    Object.assign(this, opts) // field initializers above ran after super(): apply the options again
    this.text = text
    this.initDimensions()
  }
  initDimensions() {
    this.height = this.fontSize * 1.25
  }
  /** Same splitter as Fabric's (an Intl.Segmenter by grapheme). */
  graphemeSplit(value: string): string[] {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (s) => s.segment)
  }
  /** The point named by an origin pair (the fake has no rotation). */
  getPositionByOrigin(originX: Origin, originY: Origin) {
    return this.translateToOriginPoint(this.getCenterPoint(), originX, originY)
  }
  private textBeforeEdit = ''
  enterEditing() {
    if (this.isEditing || !this.editable) return
    this.isEditing = true
    this.textBeforeEdit = this.text
    this.canvas?.fire('text:editing:entered', { target: this })
  }
  /** Same order as Fabric: the exit event first, then `object:modified` if the text changed. */
  exitEditing() {
    if (!this.isEditing) return
    this.isEditing = false
    const changed = this.textBeforeEdit !== this.text
    this.canvas?.fire('text:editing:exited', { target: this })
    if (changed) this.canvas?.fire('object:modified', { target: this })
  }
  /** Fabric's caret, in graphemes with one per line break; absent unless a test sets it. */
  selectionStart?: number
  selectionEnd?: number
  /** Fabric's hidden editing textarea; null unless a test installs one. */
  hiddenTextarea: HTMLTextAreaElement | null = null
  /** True between Fabric's compositionstart and compositionend (a test sets it). */
  inCompositionMode = false
  /** Like Fabric: copies the grapheme selection onto the hidden textarea as UTF-16 offsets (unless composing). */
  _updateTextarea() {
    const ta = this.hiddenTextarea
    if (!ta || this.inCompositionMode) return
    const graphemes = this.text.split('\n').flatMap((line, i) => (i === 0 ? this.graphemeSplit(line) : ['\n', ...this.graphemeSplit(line)]))
    const at = (g: number | undefined) => graphemes.slice(0, g ?? 0).join('').length
    ta.selectionStart = at(this.selectionStart)
    ta.selectionEnd = at(this.selectionEnd)
  }
  /** Test helper: what typing does (optionally leaving the caret at grapheme `caret`). */
  type(text: string, caret?: number) {
    this.text = text
    if (caret !== undefined) this.selectionStart = this.selectionEnd = caret
    this.canvas?.fire('text:changed', { target: this })
  }
}

export class FabricImage extends FakeObject {
  cropX = 0
  cropY = 0
  hasControls = true
  hasBorders = true
  private natural: { width: number; height: number }
  /** Like Fabric: a new element, shown at its own size. */
  setElement(el: { naturalWidth?: number; naturalHeight?: number }) {
    this.natural = { width: el.naturalWidth ?? 100, height: el.naturalHeight ?? 100 }
    this.width = this.natural.width
    this.height = this.natural.height
  }
  constructor(el: { naturalWidth?: number; naturalHeight?: number }, opts: Record<string, unknown> = {}) {
    super(opts)
    Object.assign(this, opts) // field initializers above ran after super(): apply the options again
    this.natural = { width: el.naturalWidth ?? 100, height: el.naturalHeight ?? 100 }
    // Like Fabric: an explicit width/height (a crop) wins over the element's size.
    this.width = (opts.width as number | undefined) || this.natural.width
    this.height = (opts.height as number | undefined) || this.natural.height
  }
  getOriginalSize() {
    return { ...this.natural }
  }
}

export class Rect extends FakeObject {}

export class ActiveSelection extends FakeObject {
  private members: FakeObject[]
  constructor(members: FakeObject[]) {
    super()
    this.members = members
    // Like Fabric: the selection box is the bounding box of its members.
    if (members.length > 0) {
      const boxes = members.map((m) => m.getCoords())
      const xs = boxes.flatMap((b) => b.map((p) => p.x))
      const ys = boxes.flatMap((b) => b.map((p) => p.y))
      this.left = Math.min(...xs)
      this.top = Math.min(...ys)
      this.width = Math.max(...xs) - this.left
      this.height = Math.max(...ys) - this.top
    }
  }
  getObjects() {
    return this.members
  }
}

/** The fields of Fabric's transform record that the editor reads. */
export interface FakeTransform {
  target: FakeObject
  action: string
  actionPerformed: boolean
  corner: string
  originX: Origin
  originY: Origin
  original: { scaleX: number; scaleY: number; left: number; top: number }
}

export class Canvas {
  objects: FakeObject[] = []
  active: FakeObject | null = null
  viewportTransform = [1, 0, 0, 1, 0, 0]
  wrapperEl = document.createElement('div')
  upperCanvasEl = document.createElement('canvas')
  selection = false
  skipTargetFind = false
  defaultCursor = ''
  hoverCursor = ''
  uniformScaling = true
  /** Set by FrameCanvas (the rectangle of a frame being drawn); declared here so tests can read it. */
  draft: { left: number; top: number; width: number; height: number } | null = null
  _currentTransform: FakeTransform | null = null
  /** Every option the editor passed, so tests can assert on canvas configuration. */
  readonly options: Record<string, unknown>
  /** Names of Fabric calls made, for tests that must prove something was NOT called. */
  readonly calls: string[] = []
  /** The context `getContext()` returns (tests may install a recording stand-in). */
  mainContext: unknown = null
  /** Every call that reached the base multi-selection routine (i.e. what Fabric would toggle). */
  readonly multiSelectionCalls: Array<{ target?: FakeObject }> = []
  private width: number
  private height: number
  private handlers = new Map<string, Handler[]>()

  constructor(el: unknown, opts: { width: number; height: number } & Record<string, unknown>) {
    this.options = opts
    this.width = opts.width
    this.height = opts.height
    // Like Fabric: the wrapper takes the element's place and holds the interactive canvas.
    const parent = (el as HTMLElement | null)?.parentNode
    if (parent) parent.appendChild(this.wrapperEl)
    this.wrapperEl.appendChild(this.upperCanvasEl)
  }
  on(name: string, fn: Handler) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn])
  }
  /** Fires a canvas event at the editor's handlers, as Fabric would. */
  fire(name: string, payload: unknown = {}) {
    for (const fn of this.handlers.get(name) ?? []) (fn as (e: unknown) => void)(payload)
  }
  getObjects() {
    return [...this.objects]
  }
  getActiveObject() {
    return this.active
  }
  getActiveObjects() {
    if (!this.active) return []
    return this.active instanceof ActiveSelection ? this.active.getObjects() : [this.active]
  }
  setActiveObject(o: FakeObject) {
    this.calls.push('setActiveObject')
    const had = this.active !== null
    this.active = o
    this.fire(had ? 'selection:updated' : 'selection:created', {})
  }
  discardActiveObject() {
    this.calls.push('discardActiveObject')
    const had = this.active
    if (had instanceof Textbox && had.isEditing) had.exitEditing()
    this.active = null
    if (had) this.fire('selection:cleared', {})
    return true
  }
  add(...objs: FakeObject[]) {
    this.calls.push('add')
    for (const o of objs) o.canvas = this
    this.objects.push(...objs)
  }
  insertAt(index: number, ...objs: FakeObject[]) {
    this.calls.push('insertAt')
    for (const o of objs) o.canvas = this
    this.objects.splice(index, 0, ...objs)
  }
  remove(...objs: FakeObject[]) {
    this.calls.push('remove')
    this.objects = this.objects.filter((o) => !objs.includes(o))
    if (this.active && objs.includes(this.active)) this.active = null
  }
  moveObjectTo(o: FakeObject, index: number) {
    this.objects = this.objects.filter((x) => x !== o)
    this.objects.splice(index, 0, o)
  }
  /** Like Fabric: finalizes the transform (firing `object:modified` if it did anything) and forgets it. */
  endCurrentTransform() {
    this.calls.push('endCurrentTransform')
    const transform = this._currentTransform
    if (transform?.actionPerformed) this.fire('object:modified', { target: transform.target, transform, action: transform.action })
    this._currentTransform = null
  }
  requestRenderAll() {}
  setDimensions(d: { width: number; height: number }) {
    this.width = d.width
    this.height = d.height
  }
  getWidth() {
    return this.width
  }
  getHeight() {
    return this.height
  }
  getZoom() {
    return this.viewportTransform[0] ?? 1
  }
  getContext() {
    return this.mainContext
  }
  /** Device pixels per CSS pixel (tests may change it). */
  retinaScaling = 1
  getRetinaScaling() {
    return this.retinaScaling
  }
  get _objects() {
    return this.objects
  }

  // ---- plain base implementations of what FrameCanvas overrides ---------------------------

  /** Like Fabric: is the scene point inside the object's selection area? */
  _checkTarget(obj: FakeObject, pointer: { x: number; y: number }) {
    return obj.visible && obj.evented && obj.containsPoint(pointer)
  }
  /** Like Fabric: the top-most of `objects` under the pointer. Dispatches to the (overridable) _checkTarget. */
  searchPossibleTargets(objects: FakeObject[], pointer: { x: number; y: number }) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const target = objects[i] as FakeObject
      if (this._checkTarget(target, pointer)) return { target, subTargets: [], container: target }
    }
    return { subTargets: [] }
  }
  /** Records what Fabric would have toggled. */
  handleMultiSelection(_e: unknown, target?: FakeObject) {
    this.multiSelectionCalls.push({ target })
    return true
  }
  /** Like Fabric with `includeIntersecting`: everything the rectangle touches, top to bottom. */
  collectObjects(bbox: { left: number; top: number; width: number; height: number }) {
    const tl = { x: bbox.left, y: bbox.top }
    const br = { x: bbox.left + bbox.width, y: bbox.top + bbox.height }
    return [...this.objects].reverse().filter((o) => o.selectable && o.visible && o.intersectsWithRect(tl, br))
  }
  _isSelectionKeyPressed(e: { shiftKey?: boolean }) {
    return e.shiftKey === true
  }
  setViewportTransform(v: number[]) {
    this.viewportTransform = v
  }
  /** Scene point of a mouse event: tests put scene coordinates straight into clientX/clientY. */
  getScenePoint(e?: { clientX?: number; clientY?: number }) {
    return new Point(e?.clientX ?? 0, e?.clientY ?? 0)
  }
  async dispose() {
    return true
  }
}

export const util = {
  qrDecompose(m: number[]) {
    return { angle: 0, scaleX: m[0] ?? 1, scaleY: m[3] ?? 1, translateX: m[4] ?? 0, translateY: m[5] ?? 0 }
  },
}
