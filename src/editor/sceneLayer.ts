import { clampCrop } from '../model/crop.ts'
import { HEADING_SCALE, splitGraphemes } from '../model/richText.ts'
import type { HeadingLevel } from '../model/richText.ts'
import type { CropRect, FontId, FrameRecord, ImageRecord, ObjectRecord, Scene, TextRecord, Viewport } from '../model/types.ts'
import type { Size } from '../model/viewport.ts'
import { docFromText, renderStatic } from './textSchema.ts'

/**
 * The board drawn as DOM: frame paper, images and text cards, in one layer that sits beneath a
 * transparent Fabric canvas (plan Section 4). Nothing in the app mounts it yet; the editor will
 * drive it through the small API of `SceneLayer` below.
 *
 *   .scene-layer          overflow: clip (never scrolled to follow a caret; Spike 0 S1)
 *   └ .scene-world        the viewport transform
 *     ├ .scene-frames     frame paper, behind all content
 *     └ .scene-objects    images and text cards, in exact `objects[]` order
 *
 * A text card shows the static HTML of `textSchema.ts` (the same `toDOM` the live editor uses)
 * styled by `.yuriful-prose`, whose rules reproduce how Fabric lays out today's text boxes: see
 * "Typography" below.
 */

// ---- typography -----------------------------------------------------------------------------
//
// Fabric 7.4 lays a text box out like this (Text.ts `getHeightOfLineImpl`, `calcTextHeight`,
// `_renderTextCommon`, `_renderTextLine`), with `lineHeight` 1.25 as objects.ts sets it and the
// constants `_fontSizeMult` 1.13 and `_fontSizeFraction` 0.222:
//   - a line is `1.25 × 1.13 = 1.4125` times its largest font size tall, except the last line,
//     which is only `1.13` times it: the box is `0.2825` font sizes shorter than its lines;
//   - every line's baseline is `1.13 × (1 − 0.222) = 0.87914` font sizes below the line's top,
//     whatever the font.
// CSS gets the line pitch from `line-height: 1.4125`. The last line is trimmed by a negative
// bottom margin on the last block inside a `display: flow-root` body. The baseline is where
// the font puts it (its rounded ascent plus half the leading), so each block is shifted by a
// measured amount (`baselineShift`) through the custom properties `--yp-shift-0..3`.

/** `lineHeight` of every text box (objects.ts `createObject`). */
export const FABRIC_LINE_HEIGHT = 1.25
const FONT_SIZE_MULT = 1.13
const FONT_SIZE_FRACTION = 0.222
/** A line's height in font sizes (CSS `line-height` of `.yuriful-prose`). */
export const LINE_PITCH = FABRIC_LINE_HEIGHT * FONT_SIZE_MULT
/** Where Fabric puts a line's baseline, in font sizes below the line's top. */
export const BASELINE_DEPTH = FONT_SIZE_MULT * (1 - FONT_SIZE_FRACTION)
/** How much shorter than its lines a box is, in font sizes of its last line. */
export const LAST_LINE_TRIM = LINE_PITCH - FONT_SIZE_MULT

/** A paragraph (0) and the three heading levels. */
const LEVELS = [0, 1, 2, 3] as const
const levelScale = (level: number): number => (level === 0 ? 1 : HEADING_SCALE[level as HeadingLevel])

const SHIFT_CACHE_LIMIT = 400
const shiftCache = new Map<string, number>()
let shiftProbe: HTMLElement | null = null

/**
 * How far (CSS px, negative is up) a line of `font` at `px` must move so that its baseline sits
 * where Fabric draws it: `BASELINE_DEPTH × px` below the top of its line box. Measured once per
 * font and size on a hidden probe that uses the real `.yuriful-prose` rules (so `styles.css`, or
 * the inlined `PROSE_CSS`, must be in the document). Zero where nothing is laid out (jsdom).
 */
export function baselineShift(font: FontId, px: number, doc: Document = document): number {
  const key = `${font}|${px}`
  const hit = shiftCache.get(key)
  if (hit !== undefined) return hit
  if (!doc.body) return 0
  if (!shiftProbe || shiftProbe.ownerDocument !== doc) {
    shiftProbe = doc.createElement('div')
    shiftProbe.className = 'yuriful-prose'
    shiftProbe.setAttribute('aria-hidden', 'true')
    shiftProbe.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;width:200px;contain:layout style;--yp-shift-0:0px'
    const p = doc.createElement('p')
    const mark = doc.createElement('span')
    mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
    p.append(mark, doc.createTextNode('x'))
    shiftProbe.append(p)
  }
  shiftProbe.dataset.font = font
  shiftProbe.style.fontSize = `${px}px`
  doc.body.append(shiftProbe)
  const p = shiftProbe.firstElementChild as HTMLElement
  const mark = p.firstElementChild as HTMLElement
  const line = p.getBoundingClientRect()
  const depth = mark.getBoundingClientRect().top - line.top
  shiftProbe.remove()
  if (line.height === 0) return 0 // no layout: nothing to correct
  const shift = Math.round((BASELINE_DEPTH * px - depth) * 1000) / 1000
  if (shiftCache.size >= SHIFT_CACHE_LIMIT) shiftCache.clear()
  shiftCache.set(key, shift)
  return shift
}

// ---- words that must not wrap -----------------------------------------------------------------

/** Fabric's word joiners (Textbox `_wordJoiners`): the only places a click-created box wraps. */
const JOINERS = /[ \t\r\n]+/g
/** A token CSS cannot break inside: only letters, digits and apostrophes... */
const PLAIN_TOKEN = /^[\p{L}\p{N}'’]+$/u
/** ...and no letter of a script that CSS breaks between characters. */
const BREAKS_BETWEEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Yi}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

/**
 * The UTF-16 ranges `[start, end)` of the space-separated tokens of one line that CSS could
 * wrap inside (after a hyphen, dash or slash, between CJK characters or emoji...), where Fabric
 * wraps a click-created box only between words. A token of one grapheme cannot be wrapped
 * inside and is never listed. The static HTML wraps these ranges in `white-space: nowrap`; the
 * live editor's decoration (a later slice) must use exactly the same ranges.
 */
export function breakableTokenRanges(line: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  const push = (end: number) => {
    if (end > start) {
      const token = line.slice(start, end)
      if ((!PLAIN_TOKEN.test(token) || BREAKS_BETWEEN.test(token)) && splitGraphemes(token).length > 1) out.push({ start, end })
    }
  }
  for (const m of line.matchAll(JOINERS)) {
    push(m.index)
    start = m.index + m[0].length
  }
  push(line.length)
  return out
}

/**
 * Wraps each given text range of `block` in one `<span class="yp-nowrap">` that holds the whole
 * token, splitting any mark element the token starts or ends inside. One span per token matters:
 * Chromium decides a break at an element boundary by the `white-space` of the nearest common
 * ancestor of the two characters, so a token cut into several no-wrap pieces by its marks could
 * still wrap where two pieces meet (measured: `日本` bold, `語` italic, then `のテキストです`).
 */
function wrapRanges(block: Element, ranges: ReadonlyArray<{ start: number; end: number }>) {
  if (ranges.length === 0) return
  const doc = block.ownerDocument
  const { at } = textIndex(block)
  const range = doc.createRange()
  // From the last token back: wrapping one only splits nodes after the earlier tokens' positions.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { start, end } = ranges[i]!
    const a = at(start, 1)
    const b = at(end, -1)
    if (!a || !b) continue
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    const span = doc.createElement('span')
    span.className = 'yp-nowrap'
    span.append(range.extractContents())
    range.insertNode(span)
  }
  range.detach()
  // A mark the token began or ended at the edge of is left empty in front of or behind it.
  for (const el of Array.from(block.querySelectorAll('*'))) {
    if (el.localName !== 'br' && el.textContent === '' && !el.querySelector('br')) el.remove()
  }
}

// ---- a text card's body ---------------------------------------------------------------------

/** The fields of a text record that decide how its card looks. */
export type CardSource = Pick<TextRecord, 'text' | 'fontSize' | 'width' | 'minHeight' | 'font' | 'align' | 'color' | 'spans' | 'headings' | 'blocks' | 'captionBackground'>

/** A drawn box (`minHeight` set) wraps inside overlong words; a click-created one only between words. */
const isDrawn = (rec: Pick<TextRecord, 'minHeight'>): boolean => rec.minHeight !== undefined

/**
 * Fills `body` (a `.scene-text-body`, or any element) with the static HTML of a text and gives
 * it the classes and styles of its card: font, size, alignment, colour, caption background,
 * drawn minimum height, wrapping kind and the baseline shifts. The live editor is later mounted
 * into the same element and inherits all of it.
 */
export function renderCardBody(body: HTMLElement, rec: CardSource) {
  const doc = body.ownerDocument
  const read = docFromText(rec)
  const font: FontId = read?.box.font ?? 'sans'
  body.classList.add('yuriful-prose')
  body.classList.toggle('is-drawn', isDrawn(rec))
  body.classList.toggle('is-center', rec.align === 'center')
  body.classList.toggle('is-right', rec.align === 'right')
  body.dataset.font = font
  const s = body.style
  s.fontSize = `${rec.fontSize}px`
  s.minHeight = rec.minHeight !== undefined ? `${rec.minHeight}px` : ''
  s.color = read?.box.color ?? ''
  s.backgroundColor = rec.captionBackground ?? ''
  for (const level of LEVELS) s.setProperty(`--yp-shift-${level}`, `${baselineShift(font, rec.fontSize * levelScale(level), doc)}px`)
  if (!read) {
    // Not readable by this build's schema (rich blocks arrive in a later slice): its plain text.
    body.replaceChildren(
      ...rec.text.split(/\r?\n/).map((line) => {
        const p = doc.createElement('p')
        p.append(line === '' ? doc.createElement('br') : doc.createTextNode(line))
        return p
      }),
    )
    return
  }
  const frag = renderStatic(read.doc, doc)
  if (!isDrawn(rec)) {
    for (const block of Array.from(frag.children)) wrapRanges(block, breakableTokenRanges(block.textContent ?? ''))
  }
  body.replaceChildren(frag)
}

// ---- measuring ------------------------------------------------------------------------------

/** What sizes a text card: the editor's one size authority (plan Section 6). */
export interface CardMeasurer {
  /** The card's height in scene units: its fixed height, or the laid-out height of its text (at least `minHeight`). */
  measureHeight(el: HTMLElement, rec: TextRecord): number
  /**
   * The narrowest width the text allows, in scene units, rounded up to 0.01: the widest
   * grapheme on a drawn box, the widest space-separated word on a click-created one.
   */
  measureMinWidth(el: HTMLElement, rec: TextRecord): number
}

/**
 * Measures cards laid out in the document. `el` is the card's `.scene-text-body`.
 *
 * Height comes from `getComputedStyle`, which is the untransformed layout height whatever the
 * zoom or rotation (Spike 0 S3); never `getBoundingClientRect` (the transformed bounding box)
 * or `scrollHeight` (rounded to whole pixels). The minimum width is measured on a reused,
 * untransformed, unwrapped copy of the card (`white-space: pre`): each word, or each grapheme,
 * as the width of a `Range` over it, so marks, fonts and heading sizes count as they are shown.
 */
export class DomCardMeasurer implements CardMeasurer {
  private probe: HTMLElement | null = null

  measureHeight(el: HTMLElement, rec: TextRecord): number {
    if (rec.height !== undefined) return rec.height
    const laid = parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).height ?? '') || el.offsetHeight
    return Math.max(rec.minHeight ?? 0, laid)
  }

  measureMinWidth(el: HTMLElement, rec: TextRecord): number {
    const doc = el.ownerDocument
    if (!this.probe || this.probe.ownerDocument !== doc) {
      this.probe = doc.createElement('div')
      this.probe.setAttribute('aria-hidden', 'true')
    }
    const probe = this.probe
    probe.className = el.className
    probe.removeAttribute('data-font')
    if (el.dataset.font) probe.dataset.font = el.dataset.font
    probe.style.cssText = el.style.cssText
    probe.style.position = 'absolute'
    probe.style.left = '-100000px'
    probe.style.top = '0'
    probe.style.width = 'auto'
    probe.style.minHeight = '0'
    probe.style.visibility = 'hidden'
    probe.style.whiteSpace = 'pre'
    probe.style.transform = 'none'
    probe.replaceChildren(...Array.from(el.cloneNode(true).childNodes))
    doc.body.append(probe)
    const range = doc.createRange()
    let widest = 0
    try {
      for (const block of Array.from(probe.children)) {
        const { text, at } = textIndex(block)
        const pieces = isDrawn(rec) ? graphemeRanges(text) : wordRanges(text)
        for (const { start, end } of pieces) {
          const a = at(start, 1)
          const b = at(end, -1)
          if (!a || !b) continue
          range.setStart(a.node, a.offset)
          range.setEnd(b.node, b.offset)
          widest = Math.max(widest, range.getBoundingClientRect().width)
        }
      }
    } finally {
      probe.replaceChildren()
      probe.remove()
    }
    return Math.ceil(widest * 100 - 1e-6) / 100
  }
}

/**
 * The text of an element and a way back from a UTF-16 offset in it to a text node and offset. An
 * offset where one text node ends and the next begins is in the next one with `bias` 1 (where a
 * range starts) and in the previous one with `bias` -1 (where it ends).
 */
function textIndex(root: Element): { text: string; at: (offset: number, bias?: 1 | -1) => { node: Text; offset: number } | null } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Array<{ node: Text; start: number }> = []
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length })
    text += (n as Text).data
  }
  const at = (offset: number, bias: 1 | -1 = 1) => {
    for (let i = 0; i < nodes.length; i++) {
      const { node, start } = nodes[i]!
      const end = start + node.data.length
      if (offset < end || (offset === end && (bias < 0 || i === nodes.length - 1))) return offset >= start ? { node, offset: offset - start } : null
    }
    return null
  }
  return { text, at }
}

function wordRanges(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  for (const m of text.matchAll(JOINERS)) {
    if (m.index > start) out.push({ start, end: m.index })
    start = m.index + m[0].length
  }
  if (text.length > start) out.push({ start, end: text.length })
  return out
}

function graphemeRanges(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  for (const g of splitGraphemes(text)) {
    out.push({ start, end: start + g.length })
    start += g.length
  }
  return out
}

// ---- transforms -------------------------------------------------------------------------------

/** A 2D affine matrix `[a, b, c, d, e, f]`, as Fabric's `calcTransformMatrix()` and CSS `matrix()`. */
export type Matrix = readonly [number, number, number, number, number, number]

/**
 * Fabric's centre-origin matrix of an object of untransformed size `w` × `h` (`calcTransformMatrix()`,
 * scene units; inside a multi-selection it already includes the selection's own transform) as
 * the matrix of a DOM element of that CSS size placed at `left: 0; top: 0` with
 * `transform-origin: 0 0` (plan Section 9).
 */
export function projectMatrix(m: readonly number[], w: number, h: number): Matrix {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m
  return [a, b, c, d, e - (a * w) / 2 - (c * h) / 2, f - (b * w) / 2 - (d * h) / 2]
}

/** The top-left-origin matrix of a record: its top-left corner at `left`/`top`, turned by `angle` (degrees, clockwise) about it, then scaled. */
export function recordMatrix(left: number, top: number, angle: number, scaleX = 1, scaleY = 1): Matrix {
  const r = (angle * Math.PI) / 180
  const cos = angle === 0 ? 1 : Math.cos(r)
  const sin = angle === 0 ? 0 : Math.sin(r)
  return [cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, left, top]
}

export const matrixCss = (m: Matrix): string => `matrix(${m.join(', ')})`

/** A scene-space rectangle. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** The axis-aligned bounds of an element of size `w` × `h` under the top-left matrix `m`. */
export function boundsOf(m: Matrix, w: number, h: number): Bounds {
  const [a, b, c, d, e, f] = m
  const xs = [e, a * w + e, c * h + e, a * w + c * h + e]
  const ys = [f, b * w + f, d * h + f, b * w + d * h + f]
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

// ---- culling --------------------------------------------------------------------------------

/** Items this far (screen px) outside the view are still drawn. */
export const CULL_MARGIN = 256

/** The part of the scene the view shows, grown by `margin` screen pixels on every side. */
export function visibleScene(view: Viewport, size: Size, margin = CULL_MARGIN): Bounds {
  const z = view.zoom > 0 ? view.zoom : 1
  return {
    left: (-margin - view.panX) / z,
    top: (-margin - view.panY) / z,
    right: (size.width + margin - view.panX) / z,
    bottom: (size.height + margin - view.panY) / z,
  }
}

/** True when an item with these bounds is wholly outside `visible` (touching an edge counts as inside). */
export function isOffscreen(item: Bounds, visible: Bounds): boolean {
  return item.right < visible.left || item.left > visible.right || item.bottom < visible.top || item.top > visible.bottom
}

// ---- the layer ----------------------------------------------------------------------------

export interface SceneLayerOptions {
  /** The decoded image of an asset (the editor's `AssetSource.get`). Missing: the image is not drawn, as on the canvas today. */
  getImage(assetId: string): HTMLImageElement | undefined
  measurer?: CardMeasurer
  document?: Document
}

interface ItemState {
  kind: 'frame' | 'image' | 'text'
  el: HTMLElement
  /** The record last rendered, as JSON: an unchanged record is not rendered again. */
  key: string
  rec: FrameRecord | ObjectRecord
  /** Untransformed box size (scene units): a frame's size, an image's shown crop, a text's width and measured height. */
  w: number
  h: number
  matrix: Matrix
  culled: boolean
  editing: boolean
  moving: boolean
  /** Images: the decoded picture's own size. */
  natural?: Size
}

/**
 * The DOM scene. Build it, `mount` it under the canvas, give it the board with `setRecords`,
 * keep it in step with `updateItem` (a changed record), `setItemMatrix` (an object moving with
 * Fabric during a gesture) and `setViewport`, then `cull` after the view changes.
 */
export class SceneLayer {
  readonly root: HTMLElement
  readonly world: HTMLElement
  readonly frames: HTMLElement
  readonly objects: HTMLElement
  readonly measurer: CardMeasurer
  private readonly doc: Document
  private readonly getImage: (assetId: string) => HTMLImageElement | undefined
  private readonly items = new Map<string, ItemState>()
  private view: Viewport = { zoom: 1, panX: 0, panY: 0 }
  private disposed = false

  constructor(opts: SceneLayerOptions) {
    this.doc = opts.document ?? document
    this.getImage = opts.getImage
    this.measurer = opts.measurer ?? new DomCardMeasurer()
    const div = (cls: string) => {
      const el = this.doc.createElement('div')
      el.className = cls
      return el
    }
    this.root = div('scene-layer')
    this.root.setAttribute('aria-hidden', 'true')
    this.world = div('scene-world')
    this.frames = div('scene-frames')
    this.objects = div('scene-objects')
    this.world.append(this.frames, this.objects)
    this.root.append(this.world)
  }

  mount(parent: HTMLElement) {
    if (this.disposed) throw new Error('a disposed scene layer cannot be mounted')
    parent.prepend(this.root)
    // Cards rendered while detached were measured without layout.
    for (const [id, item] of this.items) if (item.kind === 'text') this.remeasure(id)
  }

  unmount() {
    this.root.remove()
  }

  dispose() {
    this.unmount()
    this.items.clear()
    this.frames.replaceChildren()
    this.objects.replaceChildren()
    this.disposed = true
  }

  /** The element drawn for an id (frame, image or text card). */
  elementOf(id: string): HTMLElement | undefined {
    return this.items.get(id)?.el
  }

  /** A text card's body: where the live editor mounts. */
  bodyOf(id: string): HTMLElement | undefined {
    const item = this.items.get(id)
    return item?.kind === 'text' ? (item.el.firstElementChild as HTMLElement) : undefined
  }

  /** A text card's measured height (scene units), as last laid out. */
  heightOf(id: string): number | undefined {
    const item = this.items.get(id)
    return item?.kind === 'text' ? item.h : undefined
  }

  /** The whole board: elements are reused by id, unchanged records are not rendered again, and order follows the scene. */
  setRecords(scene: Scene) {
    const seen = new Set<string>()
    for (const rec of scene.frames) {
      seen.add(rec.id)
      this.upsert(rec, 'frame')
    }
    for (const rec of scene.objects) {
      seen.add(rec.id)
      this.upsert(rec, rec.type)
    }
    for (const [id, item] of this.items) {
      if (seen.has(id)) continue
      item.el.remove()
      this.items.delete(id)
    }
    this.order(this.frames, scene.frames)
    this.order(this.objects, scene.objects)
  }

  /**
   * One changed record (same id, same place in the stacking order). An unchanged record is not
   * rendered again unless `force`: after an edit session, whose `finish()` leaves its own static
   * HTML in the card (without the no-wrap spans), render the card again with `force`.
   */
  updateItem(rec: FrameRecord | ObjectRecord, force = false) {
    const kind = 'type' in rec ? rec.type : 'frame'
    const item = this.items.get(rec.id)
    if (!item) throw new Error(`no scene item ${rec.id}: use setRecords to add one`)
    if (force) item.key = ''
    this.upsert(rec, kind)
  }

  /** The viewport, as the editor stores it. */
  setViewport(view: Viewport) {
    this.view = { ...view }
    this.world.style.transform = matrixCss([view.zoom, 0, 0, view.zoom, view.panX, view.panY])
  }

  /** The viewport as Fabric's `viewportTransform` (`[zoom, 0, 0, zoom, panX, panY]`). */
  setViewportTransform(vpt: readonly number[]) {
    this.setViewport({ zoom: vpt[0] ?? 1, panX: vpt[4] ?? 0, panY: vpt[5] ?? 0 })
  }

  /**
   * Places an item from its Fabric object's `calcTransformMatrix()` (centre origin). `size` is the
   * object's untransformed `width` × `height`; by default the item's own box. While an image is
   * revealed for crop mode it keeps its cropped box: pass the matrix of the cropped placement.
   */
  setItemMatrix(id: string, m: readonly number[], size?: Size) {
    const item = this.items.get(id)
    if (!item) return
    const w = size?.width ?? item.w
    const h = size?.height ?? item.h
    this.place(item, projectMatrix(m, w, h))
  }

  /**
   * Crop mode: the whole original image is shown where it lies (`on`), the crop clips again
   * (`!on`). The item keeps its cropped box and transform; only the clip is lifted.
   */
  revealUncropped(id: string, on: boolean) {
    const item = this.items.get(id)
    if (item?.kind !== 'image') return
    item.el.classList.toggle('is-revealed', on)
    if (on) this.setCulled(item, false)
  }

  /** The edited text card: outlined, never culled. At most one. */
  setEditing(id: string | null) {
    for (const [itemId, item] of this.items) {
      const on = itemId === id
      if (item.editing === on) continue
      item.editing = on
      item.el.classList.toggle('is-editing', on)
      if (on) this.setCulled(item, false)
    }
  }

  /** An item moved or scaled by a gesture right now: composited on its own layer, never culled. Cleared when it settles. */
  setMoving(id: string, on: boolean) {
    const item = this.items.get(id)
    if (!item || item.moving === on) return
    item.moving = on
    item.el.classList.toggle('is-moving', on)
    if (on) this.setCulled(item, false)
  }

  /**
   * Skips layout and paint of idle items wholly outside the view (plus `CULL_MARGIN` screen
   * pixels) with `content-visibility: hidden`; brings back the others. `size` is the view's
   * size in CSS pixels, by default the layer's own.
   */
  cull(size?: Size) {
    const view = size ?? { width: this.root.clientWidth, height: this.root.clientHeight }
    if (!(view.width > 0 && view.height > 0)) return
    const visible = visibleScene(this.view, view)
    for (const item of this.items.values()) {
      if (item.kind === 'frame') continue
      const pinned = item.editing || item.moving || item.el.classList.contains('is-revealed')
      this.setCulled(item, !pinned && isOffscreen(boundsOf(item.matrix, item.w, item.h), visible))
    }
  }

  /** Every item drawn again (no culling). */
  uncullAll() {
    for (const item of this.items.values()) this.setCulled(item, false)
  }

  isCulled(id: string): boolean {
    return this.items.get(id)?.culled ?? false
  }

  /**
   * A text card's height and minimum width from the measurer, laid out now. A culled card is
   * brought back for the measurement and culled again after it.
   */
  measureCard(id: string): { height: number; minWidth: number } | undefined {
    const item = this.items.get(id)
    if (item?.kind !== 'text') return undefined
    const culled = item.culled
    if (culled) this.setCulled(item, false)
    try {
      const body = item.el.firstElementChild as HTMLElement
      const rec = item.rec as TextRecord
      return { height: this.measurer.measureHeight(body, rec), minWidth: this.measurer.measureMinWidth(body, rec) }
    } finally {
      if (culled) this.setCulled(item, true)
    }
  }

  // ---- internals ----------------------------------------------------------------------------

  private setCulled(item: ItemState, on: boolean) {
    if (item.culled === on) return
    item.culled = on
    item.el.classList.toggle('is-culled', on)
  }

  private place(item: ItemState, m: Matrix) {
    item.matrix = m
    item.el.style.transform = matrixCss(m)
  }

  private order(container: HTMLElement, recs: ReadonlyArray<{ id: string }>) {
    let at: ChildNode | null = container.firstChild
    for (const rec of recs) {
      const el = this.items.get(rec.id)?.el
      if (!el) continue
      if (el !== at) container.insertBefore(el, at)
      else at = at.nextSibling
    }
  }

  private upsert(rec: FrameRecord | ObjectRecord, kind: ItemState['kind']) {
    const key = JSON.stringify(rec)
    let item = this.items.get(rec.id)
    if (item && item.kind !== kind) {
      item.el.remove()
      this.items.delete(rec.id)
      item = undefined
    }
    if (item && item.key === key) return
    if (!item) {
      const el = this.doc.createElement('div')
      el.dataset.id = rec.id
      el.className = kind === 'frame' ? 'scene-frame' : `scene-item scene-${kind}`
      item = { kind, el, key: '', rec, w: 0, h: 0, matrix: [1, 0, 0, 1, 0, 0], culled: false, editing: false, moving: false }
      this.items.set(rec.id, item)
      ;(kind === 'frame' ? this.frames : this.objects).append(el)
    }
    item.key = key
    item.rec = rec
    if (kind === 'frame') this.renderFrame(item, rec as FrameRecord)
    else if (kind === 'image') this.renderImage(item, rec as ImageRecord)
    else this.renderText(item, rec as TextRecord)
  }

  private renderFrame(item: ItemState, rec: FrameRecord) {
    item.w = rec.width
    item.h = rec.height
    item.el.style.width = `${rec.width}px`
    item.el.style.height = `${rec.height}px`
    this.place(item, recordMatrix(rec.left, rec.top, 0))
  }

  private renderImage(item: ItemState, rec: ImageRecord) {
    const source = this.getImage(rec.assetId)
    const el = item.el
    if (!source) {
      // As on the canvas: an image whose bytes are missing is not drawn.
      el.replaceChildren()
      el.hidden = true
      item.w = 0
      item.h = 0
      this.place(item, recordMatrix(rec.left, rec.top, rec.angle, rec.scaleX, rec.scaleY))
      return
    }
    el.hidden = false
    const natural = { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height }
    // A stored crop reaching outside the decoded image is clamped to it (objects.ts `createObject`).
    const crop: CropRect = clampCrop(rec.crop, natural) ?? { x: 0, y: 0, width: natural.width, height: natural.height }
    let img = el.firstElementChild as HTMLImageElement | null
    if (!img) {
      img = this.doc.createElement('img')
      img.alt = ''
      img.draggable = false
      img.decoding = 'sync'
      el.append(img)
    }
    const src = source.currentSrc || source.src
    if (img.getAttribute('src') !== src) img.src = src
    img.style.width = `${natural.width}px`
    img.style.height = `${natural.height}px`
    img.style.transform = crop.x === 0 && crop.y === 0 ? '' : `translate(${-crop.x}px, ${-crop.y}px)`
    el.style.width = `${crop.width}px`
    el.style.height = `${crop.height}px`
    item.natural = natural
    item.w = crop.width
    item.h = crop.height
    this.place(item, recordMatrix(rec.left, rec.top, rec.angle, rec.scaleX, rec.scaleY))
  }

  private renderText(item: ItemState, rec: TextRecord) {
    const el = item.el
    let body = el.firstElementChild as HTMLElement | null
    if (!body) {
      body = this.doc.createElement('div')
      body.className = 'scene-text-body'
      el.append(body)
    }
    el.style.width = `${rec.width}px`
    renderCardBody(body, rec)
    item.w = rec.width
    this.place(item, recordMatrix(rec.left, rec.top, rec.angle))
    this.remeasure(rec.id)
  }

  private remeasure(id: string) {
    const item = this.items.get(id)
    if (item?.kind !== 'text') return
    if (!this.root.isConnected) {
      item.h = (item.rec as TextRecord).minHeight ?? 0
      return
    }
    const culled = item.culled
    if (culled) this.setCulled(item, false)
    item.h = this.measurer.measureHeight(item.el.firstElementChild as HTMLElement, item.rec as TextRecord)
    if (culled) this.setCulled(item, true)
  }
}
