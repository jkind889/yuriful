import { clampCrop } from '../model/crop.ts'
import type { FrameRecord, ImageRecord, Scene, TextRecord } from '../model/types.ts'
import type { Size } from '../model/viewport.ts'
import { FRAME_FILL } from './objects.ts'
import { DomCardMeasurer, renderCardBody } from './sceneLayer.ts'
import type { CardMeasurer } from './sceneLayer.ts'

/**
 * A frame's composition drawn into a bitmap, from the same DOM the scene layer shows (plan
 * Section 10): frame paper, then every object in `objects[]` order, images drawn directly
 * (with their crop) and text cards rasterized through an SVG `<foreignObject>`. Nothing in the
 * app uses it yet; the frame preview will.
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
.yuriful-prose > p,
.yuriful-prose > h1,
.yuriful-prose > h2,
.yuriful-prose > h3 {
  position: relative;
  margin: 0;
  padding: 0;
}
.yuriful-prose > p {
  font-size: 1em;
  top: var(--yp-shift-0, 0px);
}
.yuriful-prose > h1 {
  font-size: 2em;
  font-weight: 700;
  top: var(--yp-shift-1, 0px);
}
.yuriful-prose > h2 {
  font-size: 1.5em;
  font-weight: 700;
  top: var(--yp-shift-2, 0px);
}
.yuriful-prose > h3 {
  font-size: 1.25em;
  font-weight: 700;
  top: var(--yp-shift-3, 0px);
}
.yuriful-prose > :last-child {
  margin-bottom: -0.2825em;
}
.yuriful-prose strong {
  font-weight: 700;
}
.yuriful-prose em {
  font-style: italic;
}
.yuriful-prose u {
  text-decoration: underline;
}
.yuriful-prose s {
  text-decoration: line-through;
}
.yuriful-prose span[data-font] {
  line-height: 0;
}
.yuriful-prose .yp-nowrap {
  white-space: nowrap;
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
 * A text card's body (laid out by `renderCardBody`) as a self-contained SVG document: the
 * body's XHTML serialized with `XMLSerializer` (an `innerHTML` string is not well-formed XML:
 * a lone `<br>` fails to decode, Spike 0 S5) under the inlined prose rules, with `bleed` scene
 * units of room on every side. `size` is the card's box in scene units; the SVG is `scale`
 * times larger in pixels, so its text is rasterized at the bitmap's resolution.
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
const isBlank = (rec: TextRecord) => rec.text.trim() === '' && !rec.captionBackground

export interface FrameBitmapOptions {
  /** The decoded image of an asset; a missing one is left out (a read-only board may lack image bytes). */
  getImage(assetId: string): HTMLImageElement | undefined
  /** Pixel size of the bitmap; by default `frameBitmapSize(frame)`. */
  size?: Size
  /** Sizes the text cards; by default a `DomCardMeasurer`. */
  measurer?: CardMeasurer
}

interface DecodedCard {
  img: HTMLImageElement
  bleed: number
  size: Size
}

/**
 * Draws the frame's visible composition: frame paper over the whole bitmap, then every object
 * in `scene.objects` order, clipped at the bitmap's edges. Text cards are laid out in the
 * document (off screen) with the scene layer's own rules, so a card wraps and sits exactly as
 * it does on the board.
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
  const pending: Array<Promise<[string, DecodedCard]>> = []
  try {
    for (const rec of scene.objects) {
      if (rec.type !== 'text' || isBlank(rec)) continue
      const body = doc.createElement('div')
      body.className = 'scene-text-body'
      body.style.width = `${rec.width}px`
      host.append(body)
      renderCardBody(body, rec)
      const size = { width: rec.width, height: measurer.measureHeight(body, rec) }
      // A word wider than the box (a board saved before its box was widened) overflows it, as on the canvas.
      const bleed = Math.max(cardBleed(rec), Math.ceil(body.scrollWidth - rec.width) + 2)
      const svg = cardSvg(body, size, bleed, Math.max(scaleX, scaleY))
      pending.push(decodeSvg(svg, doc).then((img): [string, DecodedCard] => [rec.id, { img, bleed, size }]))
    }
  } finally {
    host.remove()
  }
  const cards = new Map(await Promise.all(pending))

  const canvas = doc.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The frame cannot be rendered: no 2D canvas.')
  ctx.fillStyle = FRAME_FILL
  ctx.fillRect(0, 0, width, height)
  ctx.setTransform(scaleX, 0, 0, scaleY, -frame.left * scaleX, -frame.top * scaleY)
  for (const rec of scene.objects) {
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
