import { clampCrop } from '../model/crop.ts'
import { isBlankTextDoc } from '../model/textDoc.ts'
import type { BlockNode, FrameRecord, ImageRecord, ObjectRecord, Scene, TextRecord } from '../model/types.ts'
import type { Size } from '../model/viewport.ts'
import { FRAME_FILL } from './objects.ts'
import { DomCardMeasurer, effectiveCardWidth, renderCardBody } from './sceneLayer.ts'
import type { CardMeasurer } from './sceneLayer.ts'

/**
 * A frame's composition drawn into a bitmap, from the same DOM the scene layer shows (plan
 * Section 10): frame paper, then every object in `objects[]` order, images drawn directly
 * (with their crop) and text cards rasterized through an SVG `<foreignObject>`. The frame tour's
 * previews use it (`Editor.startFrameTour`).
 *
 * Supported in desktop Chromium. A browser that refuses to decode the SVG, or taints the
 * canvas with it, makes `renderFrameToCanvas` reject (or `toDataURL` throw a `SecurityError`):
 * callers fall back, they never get a canvas with the text silently missing.
 */

/**
 * The `.yuriful-prose` rules of `src/styles.css` (between `prose:start` and `prose:end`),
 * inlined into each card's SVG, which cannot see the page's stylesheets. A test keeps the two
 * identical.
 */
export const PROSE_CSS = `
.yuriful-prose {
  position: relative;
  display: flow-root;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-style: normal;
  font-weight: 400;
  line-height: 1.4125;
  letter-spacing: normal;
  word-spacing: normal;
  text-align: left;
  text-indent: 0;
  text-transform: none;
  color: #1d2230;
  white-space: pre-wrap;
  overflow-wrap: normal;
  word-break: normal;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0;
  outline: none;
}
.yuriful-prose.is-drawn {
  /* a drawn box keeps its trailing spaces in the line (they must fit), and splits an overlong word */
  white-space: break-spaces;
  overflow-wrap: anywhere;
}
.yuriful-prose.is-center {
  text-align: center;
}
.yuriful-prose.is-right {
  text-align: right;
}
/* Lines at any depth (in a list item or a quote too) are laid out alike: every length below is in
   em of the box's base size, so a corner scale scales the blocks with the text */
.yuriful-prose p,
.yuriful-prose h1,
.yuriful-prose h2,
.yuriful-prose h3 {
  position: relative;
  margin: 0;
  padding: 0;
}
.yuriful-prose p {
  font-size: 1em;
  top: var(--yp-shift-0, 0px);
}
.yuriful-prose h1 {
  font-size: 2em;
  font-weight: 700;
  top: var(--yp-shift-1, 0px);
}
.yuriful-prose h2 {
  font-size: 1.5em;
  font-weight: 700;
  top: var(--yp-shift-2, 0px);
}
.yuriful-prose h3 {
  font-size: 1.25em;
  font-weight: 700;
  top: var(--yp-shift-3, 0px);
}
/* Lists: each level moves its items in by one gutter (LIST_INDENT_EM), where the marker sits.
   Markers are a little lighter than the words, so the words lead */
.yuriful-prose ul,
.yuriful-prose ol {
  margin: 0;
  padding: 0 0 0 1.5em;
  list-style: none;
}
.yuriful-prose li {
  position: relative;
  margin: 0;
  padding: 0;
}
.yuriful-prose ol {
  counter-reset: yp-item;
}
.yuriful-prose ol > li {
  counter-increment: yp-item;
}
/* A bullet is a dot on the first line, centred on its lower-case letters (the baseline is 0.879em
   below the line's top); a list inside a list has rings, and a third level small squares */
.yuriful-prose ul:not(.yp-tasks) > li::before {
  content: "";
  position: absolute;
  left: -0.95em;
  top: 0.47em;
  width: 0.3em;
  height: 0.3em;
  border-radius: 50%;
  background: color-mix(in srgb, currentColor 62%, transparent);
}
.yuriful-prose ul:not(.yp-tasks) ul:not(.yp-tasks) > li::before {
  background: transparent;
  box-shadow: inset 0 0 0 0.075em color-mix(in srgb, currentColor 62%, transparent);
}
.yuriful-prose ul:not(.yp-tasks) ul:not(.yp-tasks) ul:not(.yp-tasks) > li::before {
  left: -0.92em;
  top: 0.5em;
  width: 0.24em;
  height: 0.24em;
  border-radius: 0.03em;
  background: color-mix(in srgb, currentColor 62%, transparent);
  box-shadow: none;
}
/* A number sits in the gutter, ending a little before the words, on the first line's baseline */
.yuriful-prose ol > li::before {
  content: counter(yp-item) ".";
  position: absolute;
  right: 100%;
  top: var(--yp-shift-0, 0px);
  margin-right: 0.35em;
  font-size: 1em;
  font-style: normal;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: color-mix(in srgb, currentColor 62%, transparent);
}
/* A checkbox: a rounded square in the gutter; ticked, it holds a tick and its words step back */
.yuriful-prose .yp-check {
  position: absolute;
  left: -1.35em;
  top: 0.14em;
  box-sizing: border-box;
  width: 0.9em;
  height: 0.9em;
  border: 0.085em solid color-mix(in srgb, currentColor 62%, transparent);
  border-radius: 0.2em;
  user-select: none;
}
.yuriful-prose .yp-task[data-checked="true"] > .yp-check {
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.yuriful-prose .yp-task[data-checked="true"] > .yp-check::after {
  content: "";
  position: absolute;
  left: 0.235em;
  top: 0.07em;
  box-sizing: border-box;
  width: 0.27em;
  height: 0.47em;
  border: solid currentColor;
  border-width: 0 0.1em 0.1em 0;
  transform: rotate(45deg);
}
.yuriful-prose .yp-task[data-checked="true"] > .yp-task-body {
  opacity: 0.55;
}
/* A quote: a quiet rule, its lines moved in by QUOTE_INDENT_EM; a little room above and below.
   Its own formatting context keeps the trim of a last line (below) inside its rule */
.yuriful-prose blockquote {
  display: flow-root;
  margin: 0.4em 0;
  padding: 0 0 0 0.875em;
  border-left: 0.125em solid color-mix(in srgb, currentColor 28%, transparent);
}
/* A code block: a soft tinted panel, padded by CODE_PAD_X_EM at the sides; its lines wrap anywhere,
   in every box. The panel keeps the box font as its line strut and the code itself is monospace,
   as a font mark is, so its lines sit where a paragraph's do */
.yuriful-prose pre {
  position: relative;
  top: var(--yp-shift-0, 0px);
  margin: 0.4em 0;
  padding: 0.5em 0.75em;
  border-radius: 0.3em;
  background: color-mix(in srgb, currentColor 7%, transparent);
  font: inherit;
  white-space: inherit;
  overflow-wrap: anywhere;
}
.yuriful-prose :is(blockquote, pre):first-child {
  margin-top: 0;
}
.yuriful-prose :is(blockquote, pre):last-child {
  margin-bottom: 0;
}
/* Inline code: monospace on a tint that reaches a little past the letters without moving them */
.yuriful-prose code {
  font-family: Consolas, "Cascadia Mono", Menlo, Monaco, "Courier New", monospace;
  line-height: 0;
  border-radius: 0.2em;
  background: color-mix(in srgb, currentColor 9%, transparent);
  box-shadow: 0 0 0 0.12em color-mix(in srgb, currentColor 9%, transparent);
}
.yuriful-prose pre > code {
  border-radius: 0;
  background: none;
  box-shadow: none;
}
/* A divider takes one line, a quiet rule across its middle */
.yuriful-prose hr {
  position: relative;
  height: 1.4125em;
  margin: 0;
  border: 0;
  overflow: visible;
  color: inherit;
}
.yuriful-prose hr::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: calc(50% - 0.035em);
  border-top: 0.07em solid color-mix(in srgb, currentColor 32%, transparent);
}
.yuriful-prose > :last-child {
  margin-bottom: -0.2825em;
}
/* A text that ends with a quote trims the quote's last line instead, so its rule ends with the box;
   one that ends with a code block keeps the panel's padding whole */
.yuriful-prose > blockquote:last-child > :last-child {
  margin-bottom: -0.2825em;
}
.yuriful-prose strong {
  font-weight: 700;
}
.yuriful-prose em {
  font-style: italic;
}
/* Both decorations as Fabric draws them: underlines placed from the baseline (the same for every
   font), --yp-deco thick; a strikethrough is an underline 0.28167 font sizes above the baseline */
.yuriful-prose u,
.yuriful-prose s {
  text-decoration-line: underline;
  text-decoration-thickness: var(--yp-deco, 0.0667em);
  text-decoration-skip-ink: none;
}
.yuriful-prose u {
  text-underline-offset: 0.1em;
}
.yuriful-prose s {
  text-underline-offset: calc(-0.28167em - var(--yp-deco, 0.0667em) / 2);
}
.yuriful-prose span[data-font] {
  line-height: 0;
}
.yuriful-prose .yp-nowrap {
  white-space: nowrap;
}
/* A tab is drawn as a space of the font it sits in, as on the canvas: the tab itself takes no
   room, and a space before it (generated) wraps, hangs and fits as any space does */
.yuriful-prose .yp-tab {
  tab-size: 0;
}
.yuriful-prose .yp-tab::before {
  content: " ";
}
/* The first piece of a word wider than its drawn box: a line of its own, as on the canvas */
.yuriful-prose .yp-cut {
  display: inline-block;
  width: 100%;
}
.yuriful-prose[data-font="sans"],
.yuriful-prose [data-font="sans"] {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.yuriful-prose[data-font="serif"],
.yuriful-prose [data-font="serif"] {
  font-family: Georgia, Cambria, "Times New Roman", Times, serif;
}
.yuriful-prose[data-font="mono"],
.yuriful-prose [data-font="mono"] {
  font-family: Consolas, "Cascadia Mono", Menlo, Monaco, "Courier New", monospace;
}
.yuriful-prose[data-font="hand"],
.yuriful-prose [data-font="hand"] {
  font-family: "Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive;
}
.yuriful-prose[data-font="display"],
.yuriful-prose [data-font="display"] {
  font-family: Impact, Haettenschweiler, "Arial Black", "Franklin Gothic Bold", sans-serif;
}
`

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** The pixel size of a frame's bitmap: at most 2 pixels per scene unit and 1600 pixels on the longer side (the frame preview's rule today). */
export function frameBitmapSize(frame: Pick<FrameRecord, 'width' | 'height'>, maxSide = 1600, maxScale = 2): Size {
  const scale = Math.min(maxScale, maxSide / Math.max(frame.width, frame.height))
  return { width: Math.max(1, Math.round(frame.width * scale)), height: Math.max(1, Math.round(frame.height * scale)) }
}

/** Room around a card's box for ink drawn outside it (tall glyphs, italics, an overlong word): the canvas never clips text to its box. */
export const cardBleed = (rec: Pick<TextRecord, 'fontSize'>): number => Math.ceil(rec.fontSize * 2)

/**
 * A bound, from the record alone, on how far a card's list numbers can reach left of its box: each
 * numbered list's last number, its digits and the full stop at most 0.7 of the font size each (no
 * font has wider figures), less nothing for the gutter. Used to decide, before laying a card out,
 * whether its ink can reach a frame (`numberOverhang` measures it once laid out).
 */
export function numberReach(rec: Pick<TextRecord, 'fontSize' | 'blocks'>): number {
  let digits = 0
  const walk = (blocks: readonly BlockNode[]) => {
    for (const b of blocks) {
      if (b.type === 'orderedList') digits = Math.max(digits, String((b.start ?? 1) + b.items.length - 1).length)
      if (b.type === 'blockquote') walk(b.blocks)
      if (b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'taskList') for (const i of b.items) walk(i.blocks)
    }
  }
  walk(rec.blocks ?? [])
  return digits === 0 ? 0 : Math.ceil(rec.fontSize * 0.7 * (digits + 1))
}

/**
 * How far, in scene units, the numbers of a card's numbered lists reach left of its box (0 when none
 * does): a number sits in its item's gutter, ending a little before the words, and a long one (`100.`,
 * `123456789.`) runs out past the box's left edge, where the board shows it too. Measured on the laid
 * out card: each list's longest number, as its marker draws it, set where the marker sits.
 */
export function numberOverhang(body: HTMLElement): number {
  const doc = body.ownerDocument
  const left = body.getBoundingClientRect().left
  let reach = 0
  for (const ol of Array.from(body.querySelectorAll('ol'))) {
    const li = ol.querySelector(':scope > li')
    if (!li) continue
    const start = Number(ol.getAttribute('start') ?? '1') || 1
    const probe = doc.createElement('span')
    // The marker's own style (`.yuriful-prose ol > li::before`): its number, at its size and spacing.
    probe.style.cssText = 'position:absolute;right:100%;top:0;margin-right:0.35em;font-size:1em;font-style:normal;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap;visibility:hidden'
    probe.textContent = `${start + ol.children.length - 1}.`
    li.append(probe)
    reach = Math.max(reach, left - probe.getBoundingClientRect().left)
    probe.remove()
  }
  return Math.max(0, reach)
}

/**
 * Characters XML 1.0 cannot hold (controls other than tab, line feed and carriage return; U+FFFE,
 * U+FFFF) and lone surrogates, which would make a card's SVG fail to decode (or its data URL
 * fail to encode). The bitmap shows U+FFFD in their place; the record is never changed.
 */
export function xmlSafe(text: string): string {
  let out = ''
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const control = c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d
    const high = c >= 0xd800 && c <= 0xdbff
    const low = c >= 0xdc00 && c <= 0xdfff
    const next = text.charCodeAt(i + 1)
    if (high && next >= 0xdc00 && next <= 0xdfff) {
      i++ // a whole surrogate pair
      continue
    }
    if (control || high || low || c === 0xfffe || c === 0xffff) {
      out += `${text.slice(from, i)}\uFFFD`
      from = i + 1
    }
  }
  return from === 0 ? text : out + text.slice(from)
}

/**
 * A text card's body (laid out by `renderCardBody`) as a self-contained SVG document: the
 * body's XHTML serialized with `XMLSerializer` (an `innerHTML` string is not well-formed XML:
 * a lone `<br>` fails to decode, Spike 0 S5) under the inlined prose rules, with `bleed` scene
 * units of room on every side. `size` is the card's box in scene units; the SVG is `scale`
 * times larger in pixels, so its text is rasterized at the bitmap's resolution. Characters XML
 * cannot hold are shown as U+FFFD (`xmlSafe`).
 */
export function cardSvg(body: HTMLElement, size: Size, bleed: number, scale = 1): string {
  const doc = body.ownerDocument
  const w = size.width + 2 * bleed
  const h = size.height + 2 * bleed
  const root = doc.createElementNS(XHTML_NS, 'div')
  root.setAttribute('style', `margin:0;padding:${bleed}px;box-sizing:border-box;width:${w}px;height:${h}px`)
  const style = doc.createElementNS(XHTML_NS, 'style')
  style.textContent = PROSE_CSS
  const card = body.cloneNode(true) as HTMLElement
  card.style.width = `${size.width}px`
  const walker = doc.createTreeWalker(card, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    const safe = xmlSafe(t.data)
    if (safe !== t.data) t.data = safe
  }
  root.append(style, card)
  const xhtml = new XMLSerializer().serializeToString(root)
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(w * scale))
  svg.setAttribute('height', String(h * scale))
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  const fo = doc.createElementNS(SVG_NS, 'foreignObject')
  for (const [name, value] of [['x', '0'], ['y', '0'], ['width', String(w)], ['height', String(h)]]) fo.setAttribute(name!, value!)
  svg.append(fo)
  const shell = new XMLSerializer().serializeToString(svg)
  // The XHTML goes in already serialized, so it is escaped exactly once.
  return shell.replace(/<foreignObject([^>]*)\/>/, (_, attrs: string) => `<foreignObject${attrs}>${xhtml}</foreignObject>`)
}

async function decodeSvg(svg: string, doc: Document): Promise<HTMLImageElement> {
  const img = doc.createElement('img')
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  return img
}

/** Nothing to draw: no visible character and no caption background. */
const isBlank = (rec: TextRecord) => isBlankTextDoc(rec) && !rec.captionBackground

export interface FrameBitmapOptions {
  /** The decoded image of an asset; a missing one is left out (a read-only board may lack image bytes). */
  getImage(assetId: string): HTMLImageElement | undefined
  /** Pixel size of the bitmap; by default `frameBitmapSize(frame)`. */
  size?: Size
  /** Sizes the text cards; by default a `DomCardMeasurer`. */
  measurer?: CardMeasurer
  /**
   * A bound on the box this compositor builds for a text record, if known without laying it out
   * (the scene layer's `builtCardBound`): its exact width and a height at least its own. A card
   * outside the frame even by that bound is not laid out; otherwise, or when unknown, it is laid
   * out and its exact box checked.
   */
  cardSize?(rec: TextRecord): Size | undefined
}

interface Point2 {
  x: number
  y: number
}

/** The corners of a record's box (`size` before rotation, turned by its angle about its top-left), grown by `margin` on every side. */
function boxCorners(rec: Pick<ObjectRecord, 'left' | 'top' | 'angle'>, size: Size, margin = 0): Point2[] {
  const r = (rec.angle * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [
    [-margin, -margin],
    [size.width + margin, -margin],
    [size.width + margin, size.height + margin],
    [-margin, size.height + margin],
  ].map(([x, y]) => ({ x: rec.left + x! * cos - y! * sin, y: rec.top + x! * sin + y! * cos }))
}

/**
 * Whether a box (its four corners, a rectangle at any angle) overlaps the frame's rectangle,
 * touching included: separating axes, the frame's two and the box's two. This is what Fabric's
 * own drawing asks before it draws an object on a canvas showing just the frame (`isOnScreen`),
 * so what lies outside a frame never reaches its bitmap.
 */
export function overlapsFrame(corners: readonly Point2[], frame: Pick<FrameRecord, 'left' | 'top' | 'width' | 'height'>): boolean {
  const rect = [
    { x: frame.left, y: frame.top },
    { x: frame.left + frame.width, y: frame.top },
    { x: frame.left + frame.width, y: frame.top + frame.height },
    { x: frame.left, y: frame.top + frame.height },
  ]
  const [a, b, , d] = corners
  if (!a || !b || !d) return false
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: b.x - a.x, y: b.y - a.y }, { x: d.x - a.x, y: d.y - a.y }]
  for (const axis of axes) {
    const project = (pts: readonly Point2[]) => pts.map((p) => p.x * axis.x + p.y * axis.y)
    const box = project(corners)
    const frm = project(rect)
    if (Math.max(...box) < Math.min(...frm) || Math.max(...frm) < Math.min(...box)) return false
  }
  return true
}

/** An image's displayed box before rotation (its crop, clamped to the decoded picture, at its scale), or null when it cannot be drawn. */
function imageSize(rec: ImageRecord, el: HTMLImageElement | undefined): Size | null {
  if (!el) return null
  const natural = { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height }
  const crop = clampCrop(rec.crop, natural) ?? natural
  return { width: crop.width * rec.scaleX, height: crop.height * rec.scaleY }
}

interface DecodedCard {
  img: HTMLImageElement
  bleed: number
  size: Size
}

/**
 * Draws the frame's visible composition: frame paper over the whole bitmap, then every object
 * in `scene.objects` order, clipped at the bitmap's edges. Only what overlaps the frame is drawn
 * (`overlapsFrame`: an image by its turned box, a text card by its turned box grown by the bleed
 * its ink may need), so nothing outside a frame can change its bitmap or cost anything. Text
 * cards are laid out in the document (off screen) with the scene layer's own rules, at its
 * effective width (a word wider than its box widens it, as on the canvas), so a card wraps and
 * sits exactly as it does on the board. A card that still cannot be rasterized is left out; the
 * rest of the frame is drawn.
 */
export async function renderFrameToCanvas(scene: Scene, frameId: string, opts: FrameBitmapOptions): Promise<HTMLCanvasElement> {
  const frame = scene.frames.find(({ id }) => id === frameId)
  if (!frame) throw new Error('The frame is unavailable.')
  const { width, height } = opts.size ?? frameBitmapSize(frame)
  const scaleX = width / frame.width
  const scaleY = height / frame.height
  if (![scaleX, scaleY, frame.left, frame.top].every(Number.isFinite)) throw new Error('The frame cannot be rendered at this size.')
  const doc = document
  const measurer = opts.measurer ?? new DomCardMeasurer()

  // Lay every card out first, in one hidden host, then decode their SVGs together.
  const host = doc.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;contain:layout style'
  doc.body.append(host)
  const pending: Array<Promise<[string, DecodedCard] | null>> = []
  const images = new Set<string>()
  try {
    for (const rec of scene.objects) {
      if (rec.type === 'image') {
        const size = imageSize(rec, opts.getImage(rec.assetId))
        if (size && overlapsFrame(boxCorners(rec, size), frame)) images.add(rec.id)
        continue
      }
      if (isBlank(rec)) continue
      const known = opts.cardSize?.(rec)
      if (known && !overlapsFrame(boxCorners(rec, known, Math.max(cardBleed(rec), numberReach(rec))), frame)) continue
      try {
        const body = doc.createElement('div')
        body.className = 'scene-text-body'
        const cardWidth = effectiveCardWidth(rec, doc)
        body.style.width = `${cardWidth}px`
        host.append(body)
        renderCardBody(body, rec)
        const size = { width: cardWidth, height: measurer.measureHeight(body, rec) }
        const bleed = Math.max(cardBleed(rec), Math.ceil(body.scrollWidth - cardWidth) + 2, Math.ceil(numberOverhang(body)) + 2)
        if (!overlapsFrame(boxCorners(rec, size, bleed), frame)) {
          body.remove()
          continue
        }
        const svg = cardSvg(body, size, bleed, Math.max(scaleX, scaleY))
        pending.push(decodeSvg(svg, doc).then((img): [string, DecodedCard] => [rec.id, { img, bleed, size }], () => null))
      } catch {
        // This card alone is left out.
      }
    }
  } finally {
    host.remove()
  }
  const cards = new Map((await Promise.all(pending)).filter((c): c is [string, DecodedCard] => c !== null))

  const canvas = doc.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The frame cannot be rendered: no 2D canvas.')
  ctx.fillStyle = FRAME_FILL
  ctx.fillRect(0, 0, width, height)
  ctx.setTransform(scaleX, 0, 0, scaleY, -frame.left * scaleX, -frame.top * scaleY)
  for (const rec of scene.objects) {
    if (rec.type === 'image' ? !images.has(rec.id) : !cards.has(rec.id)) continue
    ctx.save()
    ctx.translate(rec.left, rec.top)
    if (rec.angle) ctx.rotate((rec.angle * Math.PI) / 180)
    if (rec.type === 'image') drawImage(ctx, rec, opts.getImage(rec.assetId))
    else {
      const card = cards.get(rec.id)
      if (card) ctx.drawImage(card.img, -card.bleed, -card.bleed, card.size.width + 2 * card.bleed, card.size.height + 2 * card.bleed)
    }
    ctx.restore()
  }
  return canvas
}

/** An image at its scale, showing only its crop (clamped to the decoded picture, as on the canvas). */
function drawImage(ctx: CanvasRenderingContext2D, rec: ImageRecord, el: HTMLImageElement | undefined) {
  if (!el) return
  const natural = { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height }
  const crop = clampCrop(rec.crop, natural) ?? { x: 0, y: 0, width: natural.width, height: natural.height }
  ctx.scale(rec.scaleX, rec.scaleY)
  ctx.drawImage(el, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
}
