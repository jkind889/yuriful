import type { Node as PMNode } from 'prosemirror-model'
import { clampCrop } from '../model/crop.ts'
import { HEADING_SCALE, splitGraphemes } from '../model/richText.ts'
import type { HeadingLevel } from '../model/richText.ts'
import type { CropRect, FontId, FrameRecord, ImageRecord, ObjectRecord, Scene, TextRecord, Viewport } from '../model/types.ts'
import type { Size } from '../model/viewport.ts'
import { FONT_STACKS } from './fonts.ts'
import { docFromText, isListType, nodes, renderStatic, textblocksOf } from './textSchema.ts'

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
// `_renderTextCommon`, `_renderTextLine`, `_renderTextDecoration`), with `lineHeight` 1.25 as
// objects.ts sets it and the constants `_fontSizeMult` 1.13, `_fontSizeFraction` 0.222,
// `offsets` and `textDecorationThickness` 66.667:
//   - a line is `1.25 × 1.13 = 1.4125` times its largest font size tall, except the last line,
//     which is only `1.13` times it: the box is `0.2825` font sizes shorter than its lines;
//   - every line's baseline is `1.13 × (1 − 0.222) = 0.87914` font sizes below the line's top,
//     whatever the font;
//   - an underline's top is 0.1 font sizes below the baseline, a strikethrough's middle 0.28167
//     font sizes above it, both 0.066667 times the box's own font size thick (on a heading line
//     too);
//   - a tab is drawn exactly as wide as a space (the canvas draws it as one).
// CSS gets the line pitch from `line-height: 1.4125`. The last line is trimmed by a negative
// bottom margin on the last block inside a `display: flow-root` body. The baseline is where
// the font puts it (its rounded ascent plus half the leading), so each block is shifted by a
// measured amount (`baselineShift`) through the custom properties `--yp-shift-0..3`. Both
// decorations are CSS underlines (a strikethrough is an underline with a negative offset, which
// CSS places from the baseline for every font), thick `--yp-deco`. A tab is drawn as a
// generated space of the font it sits in, the tab itself taking no room.

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
/** Fabric's decoration thickness, in the box's font sizes. */
export const DECORATION_THICKNESS = 66.667 / 1000

// ---- the layout of rich blocks ---------------------------------------------------------------------
//
// Lengths, in em of the box's base font size, that move a line's words to the right; the same
// values are in `.yuriful-prose` (styles.css), and a browser test measures them there. Because they
// are in em, a corner scale (which folds into the font size) scales them with the text. Changing one
// re-wraps every saved text that uses the block.

/** How far each level of a list (bullet, numbered or check) moves its items in: the marker's gutter. */
export const LIST_INDENT_EM = 1.5
/** How far a quote moves its lines in: its rule and the gap after it. */
export const QUOTE_INDENT_EM = 1
/** A code block's padding on either side. */
export const CODE_PAD_X_EM = 0.75

/** A paragraph (0) and the three heading levels. */
const LEVELS = [0, 1, 2, 3] as const
const levelScale = (level: number): number => (level === 0 ? 1 : HEADING_SCALE[level as HeadingLevel])

/**
 * True when the `.yuriful-prose` rules apply in `el`'s document (an element of that class has
 * them). Nothing measured without them is kept: it would be measured in the wrong font and
 * line height.
 */
function proseRulesApply(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView
  return !!view && view.getComputedStyle(el).display === 'flow-root'
}

/**
 * Where the measuring probes are laid out: hidden, near the origin (rectangles far from it, at
 * x = -100000, lose about 1/64 px of their width), and fixed, so they never add to scrolling.
 */
const PROBE_POSITION = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout style;'

const TYPE_CACHE_LIMIT = 400
const shiftCache = new Map<string, number>()
let typeProbe: HTMLElement | null = null

/** A hidden `.yuriful-prose` probe holding one line: a zero-size mark at the baseline, then "x x". */
function typographyProbe(doc: Document): { probe: HTMLElement; p: HTMLElement; mark: HTMLElement; text: Text } {
  if (!typeProbe || typeProbe.ownerDocument !== doc) {
    typeProbe = doc.createElement('div')
    typeProbe.className = 'yuriful-prose'
    typeProbe.setAttribute('aria-hidden', 'true')
    typeProbe.style.cssText = PROBE_POSITION + 'width:max-content;--yp-shift-0:0px'
    const p = doc.createElement('p')
    const mark = doc.createElement('span')
    mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
    p.append(mark, doc.createTextNode('x x'))
    typeProbe.append(p)
  }
  const p = typeProbe.firstElementChild as HTMLElement
  return { probe: typeProbe, p, mark: p.firstElementChild as HTMLElement, text: p.lastChild as Text }
}

/**
 * How far (CSS px, negative is up) a line of `font` at `px` must move so that its baseline sits
 * where Fabric draws it: `BASELINE_DEPTH × px` below the top of its line box. Measured once per
 * font and size on a hidden probe that uses the real `.yuriful-prose` rules. Zero, and not
 * kept, where nothing is laid out (jsdom) or the stylesheet is not loaded yet.
 */
export function baselineShift(font: FontId, px: number, doc: Document = document): number {
  const key = `${font}|${px}`
  const hit = shiftCache.get(key)
  if (hit !== undefined) return hit
  if (!doc.body) return 0
  const { probe, p, mark } = typographyProbe(doc)
  probe.dataset.font = font
  probe.style.fontSize = `${px}px`
  doc.body.append(probe)
  try {
    const line = p.getBoundingClientRect()
    if (line.height === 0 || !proseRulesApply(probe)) return 0
    const shift = Math.round((BASELINE_DEPTH * px - (mark.getBoundingClientRect().top - line.top)) * 1000) / 1000
    if (shiftCache.size >= TYPE_CACHE_LIMIT) shiftCache.clear()
    shiftCache.set(key, shift)
    return shift
  } finally {
    probe.remove()
  }
}

// ---- words that must not wrap -----------------------------------------------------------------
//
// Fabric wraps a click-created box only between words, and moves a drawn box's word to the next
// line whole. CSS may break inside a word: after a hyphen, dash or slash, between CJK or Hangul
// characters, emoji, full-width forms... Rather than a list of scripts and punctuation (which
// always misses a case), a word counts as breakable when Chromium, laying it out alone with a
// click-created card's own rules a little narrower than the word itself, wraps it: measured once
// per distinct word. (Not its min-content width: for "MM" in a monospace mark followed by "-1",
// Chromium's min-content is the whole word, yet it breaks the word after the hyphen in a line.)
// Only a word that provably cannot break skips the measurement (`PROVABLY_WHOLE`).

/** Fabric's word joiners (Textbox `_wordJoiners`): the only places a click-created box wraps. */
const JOINERS = /[ \t\r\n]+/g
/** A word Unicode line breaking never breaks inside: ASCII letters, digits and apostrophes only. */
const PROVABLY_WHOLE = /^[A-Za-z0-9'’]+$/
/** How much narrower than a word it is laid out to see whether it wraps (any piece before a break is at least a grapheme narrower). */
const BREAK_MARGIN = 0.5

/** True when a word must be measured to know whether CSS could break inside it. */
const isCandidate = (token: string): boolean => !PROVABLY_WHOLE.test(token) && splitGraphemes(token).length > 1

/** The space-separated words of a line (Fabric's words). */
function wordRanges(line: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  for (const m of line.matchAll(JOINERS)) {
    if (m.index > start) out.push({ start, end: m.index })
    start = m.index + m[0].length
  }
  if (line.length > start) out.push({ start, end: line.length })
  return out
}

/**
 * The UTF-16 ranges `[start, end)` of the space-separated words of one line that CSS might break
 * inside: every word but those of ASCII letters, digits and apostrophes only, and of one
 * grapheme. Which of them really are breakable is measured (`noWrapRanges`).
 */
export function candidateTokenRanges(line: string): Array<{ start: number; end: number }> {
  return wordRanges(line).filter(({ start, end }) => isCandidate(line.slice(start, end)))
}

/** A no-wrap range of a line. `cut`: the first piece of a word wider than its drawn box, which starts a line of its own. */
export interface NoWrapRange {
  start: number
  end: number
  cut?: true
}

/**
 * Wraps each given text range of `block` in one `<span class="yp-nowrap">` that holds the whole
 * token, splitting any mark element the token starts or ends inside. One span per token matters:
 * Chromium decides a break at an element boundary by the `white-space` of the nearest common
 * ancestor of the two characters, so a token cut into several no-wrap pieces by its marks could
 * still wrap where two pieces meet (measured: `日本` bold, `語` italic, then `のテキストです`).
 * A `cut` piece is also `yp-cut`: an inline block as wide as the line, so it can follow nothing
 * on a line. An underline or strikethrough around it is repeated inside it (an inline block is
 * not decorated by its ancestors).
 */
function wrapRanges(block: Element, ranges: readonly NoWrapRange[]) {
  if (ranges.length === 0) return
  const doc = block.ownerDocument
  const { at } = textIndex(block)
  const range = doc.createRange()
  // From the last token back: wrapping one only splits nodes after the earlier tokens' positions.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { start, end, cut } = ranges[i]!
    const a = at(start, 1)
    const b = at(end, -1)
    if (!a || !b) continue
    range.setStart(a.node, a.offset)
    range.setEnd(b.node, b.offset)
    const span = doc.createElement('span')
    span.className = cut ? 'yp-nowrap yp-cut' : 'yp-nowrap'
    span.append(range.extractContents())
    range.insertNode(span)
    if (!cut) continue
    for (let up = span.parentElement; up && up !== block; up = up.parentElement) {
      if (up.localName !== 'u' && up.localName !== 's') continue
      const again = doc.createElement(up.localName)
      again.append(...Array.from(span.childNodes))
      span.append(again)
    }
  }
  range.detach()
  // A mark the token began or ended at the edge of is left empty in front of or behind it.
  for (const el of Array.from(block.querySelectorAll('*'))) {
    if (el.localName !== 'br' && el.textContent === '' && !el.querySelector('br')) el.remove()
  }
}

/**
 * Puts every tab of `block` in its own `<span class="yp-tab">`, drawn as Fabric draws a tab: a
 * space of the font it sits in (generated before it), the tab itself taking no room, so it wraps,
 * hangs at a line's end and fits as a space does. CSS would jump to the next tab stop. The live
 * editor's decoration (a later slice) must give every "\t" of a line the same class.
 */
function wrapTabs(block: Element) {
  const doc = block.ownerDocument
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.includes('\t')) texts.push(n as Text)
  for (const node of texts) {
    const frag = doc.createDocumentFragment()
    node.data.split(/(\t)/).forEach((part) => {
      if (part === '') return
      if (part !== '\t') {
        frag.append(doc.createTextNode(part))
        return
      }
      const tab = doc.createElement('span')
      tab.className = 'yp-tab'
      tab.textContent = '\t'
      frag.append(tab)
    })
    node.replaceWith(frag)
  }
}

// ---- measuring words and graphemes --------------------------------------------------------------
//
// Every width here is measured on an unwrapped, untransformed, hidden copy of the card's lines
// (`white-space: pre`), each as the sum of the rectangles of the text it covers, text node by
// text node: a word that bidi reordering splits into separate runs is not widened by what lies
// between them. Results are cached per line (an edit measures only the lines it changed) and
// per word (a repeated word is measured once), and only when measured with the stylesheet in
// place. `resetTypography()` drops every cache.

/**
 * A word of one line as laid out: its width and, once it has been needed (a word wider than a
 * drawn box), each grapheme as Fabric measures it: its own width and its width after the
 * grapheme before it (kerning included), as the Fabric renderer's drawn box (`DrawnTextbox`, deleted with it) filled a line.
 */
export interface MeasuredToken {
  start: number
  end: number
  width: number
  /** False when CSS cannot break inside it (measured); absent counts as breakable. */
  breakable?: boolean
  graphemes?: Array<{ end: number; width: number; kerned: number }>
}

interface LineMeasure {
  /** Every space-separated word. */
  words: MeasuredToken[]
  /** The words CSS could break inside (the same objects). */
  tokens: MeasuredToken[]
  widestWord: number
  /** Measured on demand (drawn boxes). */
  widestGrapheme?: number
}

interface WordEntry {
  width: number
  /** Whether CSS could break inside it; absent until measured. */
  breakable?: boolean
  /** Relative to the word's start. */
  graphemes?: Array<{ end: number; width: number; kerned: number }>
}

const LINE_CACHE_LIMIT = 4000
const lineCache = new Map<string, LineMeasure>()
/** A word's or grapheme's measurements by its text, marks, line level, box font and size. */
const WORD_CACHE_LIMIT = 20000
const wordCache = new Map<string, WordEntry>()
/** The word-cache key of a measured word, when it lies in one run of the same marks. */
const wordKeys = new WeakMap<MeasuredToken, string>()

/** Drops every measurement taken (baseline shifts, words): call when fonts or the stylesheet change. */
export function resetTypography() {
  shiftCache.clear()
  lineCache.clear()
  wordCache.clear()
  glyphCache.clear()
  lastLines = null
}

interface CardLines {
  font: FontId
  fontSize: number
  /** The lines: every textblock (paragraph, heading, code block) in order. */
  blocks: PMNode[]
  /** Per line: what its widths depend on (the line itself, the box font and size). */
  keys: string[]
  /** Per line: how far its blocks move its words in, in scene units (`lineIndent`). */
  indents: number[]
  /** Per line: it is a code block, which wraps anywhere and keeps no word whole. */
  code: boolean[]
}
let lastLines: { key: string; lines: CardLines | null } | null = null

/**
 * How far the blocks around the textblock at `pos` move its words in, in em of the base size: each
 * list it is in, each quote, and a code block's own padding.
 */
export function lineIndent(doc: PMNode, pos: number): number {
  const $p = doc.resolve(pos + 1)
  let em = $p.parent.type === nodes.codeBlock ? 2 * CODE_PAD_X_EM : 0
  for (let d = $p.depth - 1; d > 0; d--) {
    const t = $p.node(d).type
    if (isListType(t)) em += LIST_INDENT_EM
    else if (t === nodes.blockquote) em += QUOTE_INDENT_EM
  }
  return em
}

/** The lines (textblocks) of a text and their cache keys; the last text's are kept, so a resize does not read it again. */
function cardLines(rec: CardSource): CardLines | null {
  const key = JSON.stringify([rec.text, rec.spans, rec.headings, rec.blocks, rec.font, rec.fontSize])
  if (lastLines?.key === key) return lastLines.lines
  const read = docFromText(rec)
  let lines: CardLines | null = null
  if (read) {
    const font = read.box.font ?? 'sans'
    const tbs = textblocksOf(read.doc)
    const blocks = tbs.map((t) => t.node)
    lines = {
      font,
      fontSize: rec.fontSize,
      blocks,
      keys: blocks.map((b) => JSON.stringify([b.toJSON(), font, rec.fontSize])),
      indents: tbs.map((t) => lineIndent(read.doc, t.pos) * rec.fontSize),
      code: blocks.map((b) => b.type === nodes.codeBlock),
    }
  }
  lastLines = { key, lines }
  return lines
}

/** The word-cache key of `[start, end)` of a line, or undefined when it crosses a change of marks. */
function wordKey(block: PMNode, start: number, end: number, font: FontId, fontSize: number): string | undefined {
  let key: string | undefined
  block.forEach((child, offset) => {
    if (key === undefined && offset <= start && offset + child.nodeSize >= end) {
      key = JSON.stringify([font, fontSize, block.type.name, block.attrs.level ?? 0, child.marks.map((m) => m.toJSON()), child.text?.slice(start - offset, end - offset)])
    }
  })
  return key
}

function remember(key: string, value: WordEntry) {
  if (wordCache.size >= WORD_CACHE_LIMIT) wordCache.clear()
  wordCache.set(key, { ...wordCache.get(key), ...value })
}

/**
 * Lays the given lines out on an unwrapped, untransformed, hidden copy of a card in `doc` and
 * calls `fn` with each line's element (in the same order), a range and the probe itself. False,
 * and nothing called, where nothing can be laid out (jsdom) or the stylesheet is missing.
 */
function withProbe(blocks: readonly PMNode[], font: FontId, fontSize: number, doc: Document, fn: (lines: Element[], range: Range, probe: HTMLElement) => void): boolean {
  if (!doc.body || blocks.length === 0) return false
  const probe = doc.createElement('div')
  probe.className = 'yuriful-prose'
  probe.dataset.font = font
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = `${PROBE_POSITION}white-space:pre;font-size:${fontSize}px`
  const frag = renderStatic(nodes.doc.create(null, blocks), doc)
  for (const block of Array.from(frag.children)) wrapTabs(block)
  probe.append(frag)
  doc.body.append(probe)
  try {
    const range = doc.createRange()
    if (typeof range.getClientRects !== 'function' || probe.getBoundingClientRect().height === 0 || !proseRulesApply(probe)) return false
    fn(Array.from(probe.children), range, probe)
    return true
  } finally {
    probe.remove()
  }
}

/** The width of `[start, end)` of a laid-out line: the sum of its text's rectangles, text node by text node. */
function textWidth(index: TextIndex, range: Range, start: number, end: number): number {
  let width = 0
  for (const seg of index.segments(start, end)) {
    range.setStart(seg.node, seg.from)
    range.setEnd(seg.node, seg.to)
    for (const r of Array.from(range.getClientRects())) width += r.width
  }
  return width
}

/**
 * Every word of every line of a text, with widths as the card shows them (marks, fonts and
 * heading sizes included) and whether CSS could break inside each, measured on a hidden copy in
 * `doc`. Cached per line and per word. In a document without layout (or without the stylesheet)
 * every width is 0, every candidate word counts as breakable (a no-wrap span is harmless), and
 * nothing is kept.
 */
function measureLines(rec: CardSource, doc: Document): LineMeasure[] | null {
  const lines = cardLines(rec)
  if (!lines) return null
  const out = lines.keys.map((key) => lineCache.get(key))
  const fresh: number[] = []
  const unmeasured = new Set<MeasuredToken>()
  /** Candidate words whose breakability is not known yet: until measured, they count as breakable. */
  const undecided = new Set<MeasuredToken>()
  out.forEach((hit, i) => {
    if (hit) return
    const block = lines.blocks[i]!
    const text = block.textContent
    const words = wordRanges(text).map(({ start, end }) => {
      const t: MeasuredToken = { start, end, width: 0, breakable: false }
      const key = wordKey(block, start, end, lines.font, rec.fontSize)
      const known = key === undefined ? undefined : wordCache.get(key)
      if (key !== undefined) wordKeys.set(t, key)
      if (known) t.width = known.width
      else unmeasured.add(t)
      if (isCandidate(text.slice(start, end))) {
        t.breakable = known?.breakable ?? true
        if (known?.breakable === undefined) undecided.add(t)
      }
      return t
    })
    out[i] = { words, tokens: [], widestWord: 0 }
    fresh.push(i)
  })
  const probed = fresh.filter((i) => out[i]!.words.some((t) => unmeasured.has(t) || undecided.has(t)))
  const measured = withProbe(probed.map((i) => lines.blocks[i]!), lines.font, rec.fontSize, doc, (els, range, probe) => {
    const alone: Array<{ t: MeasuredToken; el: HTMLElement }> = []
    /** The words laid out alone in this batch, by cache key: a repeated word is laid out once. */
    const queued = new Map<string, { t: MeasuredToken; el: HTMLElement }>()
    const repeats: Array<{ t: MeasuredToken; of: MeasuredToken }> = []
    els.forEach((el, k) => {
      const index = textIndex(el)
      for (const t of out[probed[k]!]!.words) {
        const key = wordKeys.get(t)
        if (unmeasured.has(t)) {
          // Measured already in this batch (the same word earlier on): its width.
          const known = key === undefined ? undefined : wordCache.get(key)
          t.width = known ? known.width : textWidth(index, range, t.start, t.end)
          if (key !== undefined && !known) remember(key, { width: t.width })
        }
        if (!undecided.has(t)) continue
        const first = key === undefined ? undefined : queued.get(key)
        if (first) {
          repeats.push({ t, of: first.t })
          continue
        }
        // The word alone, with every mark around it (a font changes how it can break) and in a
        // block of its line's kind (so a heading's size), laid out with a click-created card's
        // own rules a little narrower than itself: it wraps exactly when it can break inside.
        const a = index.at(t.start, 1)
        const b = index.at(t.end, -1)
        if (!a || !b) continue
        range.setStart(a.node, a.offset)
        range.setEnd(b.node, b.offset)
        let content: Node = range.cloneContents()
        for (let up: Node | null = range.commonAncestorContainer; up && up !== el; up = up.parentNode) {
          if (up.nodeType !== Node.ELEMENT_NODE) continue
          const shell = up.cloneNode(false)
          shell.appendChild(content)
          content = shell
        }
        const block = doc.createElement(el.localName)
        block.className = 'yp-alone'
        block.style.cssText = `width:${Math.max(0, t.width - BREAK_MARGIN)}px;white-space:pre-wrap;top:0`
        block.append(content)
        const entry = { t, el: block }
        alone.push(entry)
        if (key !== undefined) queued.set(key, entry)
      }
    })
    for (const { el } of alone) probe.append(el)
    const view = doc.defaultView
    for (const { t, el } of alone) {
      // Wrapped: taller than one line of its kind.
      const line = parseFloat(view?.getComputedStyle(el).lineHeight ?? '') || Infinity
      t.breakable = el.getBoundingClientRect().height > line * 1.5
      const key = wordKeys.get(t)
      if (key !== undefined) remember(key, { width: t.width, breakable: t.breakable })
    }
    for (const { t, of } of repeats) t.breakable = of.breakable
  })
  for (const i of fresh) {
    const m = out[i]!
    m.tokens = lines.code[i] ? [] : m.words.filter((t) => t.breakable)
    m.widestWord = Math.max(0, ...m.words.map((t) => t.width))
  }
  if (measured || probed.length === 0) {
    if (lineCache.size + fresh.length > LINE_CACHE_LIMIT) lineCache.clear()
    for (const i of fresh) lineCache.set(lines.keys[i]!, out[i]!)
  }
  return out as LineMeasure[]
}

/** The widest grapheme of each line, measured once per line (and once per distinct grapheme). */
function measureGraphemes(rec: CardSource, measures: LineMeasure[], doc: Document, only: (i: number) => boolean = () => true) {
  const lines = cardLines(rec)
  if (!lines) return
  const which = measures.flatMap((m, i) => (m.widestGrapheme === undefined && only(i) ? [i] : []))
  if (which.length === 0) return
  withProbe(which.map((i) => lines.blocks[i]!), lines.font, rec.fontSize, doc, (els, range) => {
    els.forEach((el, k) => {
      const i = which[k]!
      const block = lines.blocks[i]!
      const index = textIndex(el)
      let widest = 0
      let offset = 0
      for (const g of splitGraphemes(index.text)) {
        const start = offset
        offset += g.length
        if (/^[ \t\r\n]$/.test(g)) continue
        const key = wordKey(block, start, offset, lines.font, rec.fontSize)
        let width = key === undefined ? undefined : wordCache.get(key)?.width
        if (width === undefined) {
          width = textWidth(index, range, start, offset)
          if (key !== undefined) remember(key, { width })
        }
        widest = Math.max(widest, width)
      }
      measures[i]!.widestGrapheme = widest
    })
  })
}

const roundUp = (n: number): number => Math.ceil(n * 100 - 1e-6) / 100

/**
 * The narrowest width a text allows, in scene units, rounded up to 0.01: the widest grapheme on
 * a drawn box (`DrawnTextbox`), the widest space-separated word on a click-created one (Fabric's
 * `dynamicMinWidth`). 0 where nothing can be measured.
 */
export function minCardWidth(rec: CardSource, doc: Document = document): number {
  const measures = measureLines(rec, doc)
  const lines = cardLines(rec)
  if (!measures || !lines) return 0
  // A line's floor is its widest word (grapheme, on a drawn box or in a code block, which wraps
  // anywhere) plus how far its blocks move it in.
  const drawn = isDrawn(rec)
  measureGraphemes(rec, measures, doc, (i) => drawn || lines.code[i] === true)
  const floor = (m: LineMeasure, i: number) => (drawn || lines.code[i] ? (m.widestGrapheme ?? 0) : m.widestWord) + (lines.indents[i] ?? 0)
  return roundUp(Math.max(0, ...measures.map(floor)))
}

/**
 * The width a box that already exists is drawn at, after any change to it (a side handle, a
 * text, format or size change): its wrap width, or its widest word (grapheme, on a drawn box) as
 * formatted when that is wider. This is Fabric's live floor (Textbox `initDimensions` and
 * `dynamicMinWidth`); unlike `effectiveCardWidth`, the plain-sans layout of a box being built
 * from a record does not count.
 */
export function liveCardWidth(rec: CardSource, doc: Document = document): number {
  return Math.max(rec.width, minCardWidth(rec, doc))
}

/**
 * The width a card built from a record is drawn at: its stored width, or more when a word (a
 * grapheme, on a drawn box) is wider. Fabric widens such a box the same way when it builds it
 * (Textbox `initDimensions`), keeping its left edge: so does the layer. A click-created box is
 * first laid out in plain sans at its base size, before its formatting (objects.ts
 * `createObject`), and a text box never narrows: so its widest word in plain sans counts too (a
 * word in a narrower font mark keeps the plain word's width). Only building counts it: once the
 * box exists, its floor is `liveCardWidth`. The record is never changed.
 */
export function effectiveCardWidth(rec: CardSource, doc: Document = document): number {
  const width = Math.max(rec.width, minCardWidth(rec, doc))
  // The plain-sans first layout is the earlier canvas's, which never drew a rich text.
  if (isDrawn(rec) || rec.blocks) return width
  return Math.max(width, minCardWidth({ text: rec.text, fontSize: rec.fontSize, width: rec.width }, doc))
}

// ---- graphemes as Fabric measures them ----------------------------------------------------------
//
// To cut a word wider than a drawn box exactly where Fabric does, its graphemes are measured as
// Fabric measures them (Text `_measureChar`): on a 2D canvas, at 400 px, then scaled; a
// grapheme's kerned width is the pair with the grapheme before it minus that one, when both
// have the same font declaration.

const CACHE_FONT_SIZE = 400
let glyphContext: CanvasRenderingContext2D | null | undefined
const glyphCache = new Map<string, Map<string, number>>()

function glyphWidth(font400: string, text: string, doc: Document): number | undefined {
  if (glyphContext === undefined) glyphContext = doc.createElement('canvas').getContext('2d')
  if (!glyphContext) return undefined
  let widths = glyphCache.get(font400)
  if (!widths) {
    widths = new Map()
    glyphCache.set(font400, widths)
  }
  let w = widths.get(text)
  if (w === undefined) {
    glyphContext.font = font400
    w = glyphContext.measureText(text).width
    widths.set(text, w)
  }
  return w
}

/** The font of the character at `offset` of a line, as Fabric declares it: measured at 400 px, and at its own size. */
function fabricFont(block: PMNode, offset: number, font: FontId, fontSize: number): { measure: string; decl: string; size: number } {
  const level = (block.attrs.level as number | undefined) ?? 0
  let marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[] = []
  block.forEach((child, at) => {
    if (at <= offset && offset < at + child.nodeSize) marks = child.marks
  })
  const has = (name: string) => marks.some((m) => m.type.name === name)
  const family = FONT_STACKS[(marks.find((m) => m.type.name === 'font')?.attrs.font as FontId | undefined) ?? font]
  const weight = level > 0 || has('bold') ? 'bold' : 'normal'
  const style = has('italic') ? 'italic' : 'normal'
  const size = fontSize * levelScale(level)
  return { measure: `${style} ${weight} ${CACHE_FONT_SIZE}px ${family}`, decl: `${style} ${weight} ${size}px ${family}`, size }
}

/** The graphemes of `[start, end)` of a line as the Fabric renderer's drawn box measured them; undefined without a 2D canvas. */
function fabricGraphemes(block: PMNode, start: number, end: number, font: FontId, fontSize: number, doc: Document): MeasuredToken['graphemes'] {
  const text = block.textContent
  const out: NonNullable<MeasuredToken['graphemes']> = []
  let offset = start
  let prev: { g: string; decl: string } | undefined
  for (const g of splitGraphemes(text.slice(start, end))) {
    const { measure, decl, size } = fabricFont(block, offset, font, fontSize)
    const mult = size / CACHE_FONT_SIZE
    const own = glyphWidth(measure, g, doc)
    if (own === undefined) return undefined
    let kerned = own
    if (prev && prev.decl === decl) {
      const pair = glyphWidth(measure, prev.g + g, doc)
      const before = glyphWidth(measure, prev.g, doc)
      if (pair !== undefined && before !== undefined) kerned = pair - before
    }
    offset += g.length
    out.push({ end: offset, width: own * mult, kerned: kerned * mult })
    prev = { g, decl }
  }
  return out
}

// ---- drawn boxes: breakable words kept whole -------------------------------------------------
//
// A drawn box wraps as the Fabric renderer's `DrawnTextbox` (`_wrapText`) did: it fills a line grapheme by grapheme while the
// line, its spaces included, is no wider than the box. A line that must end there goes back to
// its last space; only a line with no space in it is cut at a grapheme. So a word moves whole to
// the next line unless it is wider than the box on its own; such a word always starts a line of
// its own (whatever came before it on the line moves back behind the last space), then is cut
// where the box is full, line after line, and the text after its last piece follows on that
// piece's line. A word stays at the end of a line only if the space after it fits too (that is
// `white-space: break-spaces` on `.is-drawn`).
//
// CSS `overflow-wrap: anywhere` breaks a word only where nothing else fits, but a breakable word
// (one CSS could break inside, measured) would break at its own break points. So on a drawn box:
//  - a breakable word no wider than the box is one no-wrap span, and moves whole;
//  - a wider word (breakable or not) is cut into no-wrap pieces where Fabric cuts it, measuring
//    its graphemes as Fabric does; CSS can then break it only where two pieces meet (an emergency
//    break of `anywhere`). Its first piece is a line-wide inline block (`cut`), so it always
//    starts a line, as in Fabric, whatever the widths of its graphemes.
// Both depend on the box width, so the ranges are worked out again for every width, from word
// widths measured once (`measureDrawnTokens`, cached).

/**
 * Slack (scene px) in "no wider than the box": Chromium lays words out in 1/64 px, and its
 * widths run up to 0.04 px wider than Fabric's (measured). Within it a word stays whole and
 * overflows by an invisible fraction rather than being cut.
 */
export const FIT_SLACK = 0.05

/**
 * The no-wrap ranges of one line of a drawn box `width` wide, from its measured words: each
 * breakable word that fits the box whole, and the pieces of each word that does not (cut as
 * `DrawnTextbox` cuts it; the first piece marked `cut`, a later piece of one grapheme needs no
 * span). A wider word whose graphemes are not measured gets nothing. Pure: the live editor's
 * decoration can use it with the same measured words (`measureDrawnTokens`, `measureWideTokens`).
 */
export function drawnNoWrapRanges(tokens: readonly MeasuredToken[], width: number): NoWrapRange[] {
  const out: NoWrapRange[] = []
  for (const t of tokens) {
    if (t.width <= width + FIT_SLACK) {
      if (t.breakable !== false) out.push({ start: t.start, end: t.end })
      continue
    }
    const gs = t.graphemes
    if (!gs || gs.length === 0) continue
    // Fabric's limit: the box, or its widest grapheme when that is wider.
    const limit = Math.max(width, ...gs.map((g) => g.width))
    const pieces: Array<{ start: number; end: number; count: number }> = []
    let start = t.start
    let filled = 0
    let count = 0
    let end = t.start
    for (const g of gs) {
      if (count > 0 && filled + g.kerned > limit) {
        pieces.push({ start, end, count })
        start = end
        count = 0
      }
      filled = count === 0 ? g.width : filled + g.kerned
      count++
      end = g.end
    }
    pieces.push({ start, end, count })
    // Fabric fits it on one line after all: kept whole.
    if (pieces.length === 1) {
      out.push({ start: t.start, end: t.end })
      continue
    }
    pieces.forEach((p, i) => {
      if (i === 0) out.push({ start: p.start, end: p.end, cut: true })
      else if (p.count > 1) out.push({ start: p.start, end: p.end })
    })
  }
  return out
}

/**
 * The words of each line of a text that a drawn box must keep from breaking at CSS's own break
 * points: the breakable ones (measured) and any word that may turn out wider than the box (all
 * of them, `breakable` telling which is which). Cached per line and word, so a resize only
 * compares widths and an edit measures only the lines it changed. Without layout every width is
 * 0 (every word fits).
 */
export function measureDrawnTokens(rec: CardSource, doc: Document = document): MeasuredToken[][] {
  return (measureLines(rec, doc) ?? []).map((m) => m.words)
}

/**
 * Measures, once, the graphemes of every word of `tokens` (from `measureDrawnTokens(rec)`) that
 * is wider than `width`, as Fabric measures them. Words that fit are left alone, so this costs
 * nothing unless a word is wider than the box, and only once per word.
 */
export function measureWideTokens(rec: CardSource, tokens: MeasuredToken[][], width: number | ((line: number) => number), doc: Document = document) {
  const lines = cardLines(rec)
  if (!lines) return
  tokens.forEach((line, i) => {
    const block = lines.blocks[i]
    if (!block || lines.code[i]) return
    const w = typeof width === 'number' ? width : width(i)
    for (const t of line) {
      if (t.graphemes || t.width <= w + FIT_SLACK) continue
      // A repeated word measured before: its graphemes, moved to where this one starts.
      const key = wordKeys.get(t)
      const known = key === undefined ? undefined : wordCache.get(key)?.graphemes
      if (known) {
        t.graphemes = known.map((g) => ({ ...g, end: t.start + g.end }))
        continue
      }
      const graphemes = fabricGraphemes(block, t.start, t.end, lines.font, rec.fontSize, doc)
      if (!graphemes) continue
      t.graphemes = graphemes
      if (key !== undefined) remember(key, { width: t.width, graphemes: graphemes.map((g) => ({ ...g, end: g.end - t.start })) })
    }
  })
}

/**
 * The no-wrap ranges of every line of a card (UTF-16 offsets into each line): on a
 * click-created box every word CSS could break inside (measured); on a drawn box those that fit
 * its effective width whole, and the pieces of every word that does not. What the live editor's
 * decoration must apply (a `cut` piece as a line-wide inline block, `yp-cut`).
 */
export function noWrapRanges(rec: CardSource, doc: Document = document): NoWrapRange[][] {
  if (isDrawn(rec)) {
    const width = effectiveCardWidth(rec, doc)
    const lines = cardLines(rec)
    // A line inside blocks has the box's width less how far they move it in; a code block keeps no word whole.
    const lineWidth = (i: number) => width - (lines?.indents[i] ?? 0)
    const tokens = measureDrawnTokens(rec, doc)
    measureWideTokens(rec, tokens, lineWidth, doc)
    return tokens.map((line, i) => (lines?.code[i] ? [] : drawnNoWrapRanges(line, lineWidth(i))))
  }
  return (measureLines(rec, doc) ?? []).map((m) => m.tokens.map(({ start, end }) => ({ start, end })))
}

// ---- a text card's body ---------------------------------------------------------------------

/** The fields of a text record that decide how its card looks. */
export type CardSource = Pick<TextRecord, 'text' | 'fontSize' | 'width' | 'minHeight' | 'font' | 'align' | 'color' | 'spans' | 'headings' | 'blocks' | 'captionBackground'>

/** A drawn box (`minHeight` set) wraps inside overlong words; a click-created one only between words. */
const isDrawn = (rec: Pick<TextRecord, 'minHeight'>): boolean => rec.minHeight !== undefined

/** Only the fields of a record that decide how its card looks, the width left out. */
function cardLook(rec: CardSource): Omit<CardSource, 'width'> {
  const { text, fontSize, minHeight, font, align, color, spans, headings, blocks, captionBackground } = rec
  return { text, fontSize, minHeight, font, align, color, spans, headings, blocks, captionBackground }
}

/**
 * Gives `body` the classes and styles of its card, leaving its children alone: font, size,
 * alignment, colour, caption background, drawn minimum height, wrapping kind, baseline shifts
 * and decoration thickness. Safe on a card whose live editor is mounted.
 */
export function applyCardStyle(body: HTMLElement, rec: CardSource) {
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
  s.setProperty('--yp-deco', `${Math.round(rec.fontSize * DECORATION_THICKNESS * 1000) / 1000}px`)
}

/**
 * Fills `body` (a `.scene-text-body`, or any element) with the static HTML of a text and gives
 * it the classes and styles of its card (`applyCardStyle`), no-wrap spans (`noWrapRanges`, which
 * may be passed in when already worked out) and tab spans. The live editor is later mounted into
 * the same element and inherits all of it.
 */
export function renderCardBody(body: HTMLElement, rec: CardSource, ranges: NoWrapRange[][] = noWrapRanges(rec, body.ownerDocument)) {
  const doc = body.ownerDocument
  applyCardStyle(body, rec)
  const read = docFromText(rec)
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
  // Each line's element, in document order (the same order as the textblocks, and so as `ranges`).
  Array.from(frag.querySelectorAll('p, h1, h2, h3, pre')).forEach((block, i) => {
    wrapRanges(block, ranges[i] ?? [])
    wrapTabs(block)
  })
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
 * or `scrollHeight` (rounded to whole pixels). The minimum width is `minCardWidth`: each word,
 * or each grapheme, measured on an unwrapped, untransformed copy of the card, so marks, fonts
 * and heading sizes count as they are shown and bidi reordering cannot widen a word.
 */
export class DomCardMeasurer implements CardMeasurer {
  measureHeight(el: HTMLElement, rec: TextRecord): number {
    if (rec.height !== undefined) return rec.height
    const laid = parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).height ?? '') || el.offsetHeight
    return Math.max(rec.minHeight ?? 0, laid)
  }

  measureMinWidth(el: HTMLElement, rec: TextRecord): number {
    return minCardWidth(rec, el.ownerDocument)
  }
}

interface TextIndex {
  text: string
  /** A UTF-16 offset as a text node and offset. At a node boundary: the next node with `bias` 1 (a range's start), the previous with -1 (its end). */
  at(offset: number, bias?: 1 | -1): { node: Text; offset: number } | null
  /** The text nodes `[start, end)` covers, each with the part of it inside. */
  segments(start: number, end: number): Array<{ node: Text; from: number; to: number }>
}

/** The text of an element, with ways back from UTF-16 offsets in it to its text nodes. */
function textIndex(root: Element): TextIndex {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Array<{ node: Text; start: number }> = []
  let text = ''
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length })
    text += (n as Text).data
  }
  /** The first node that ends after the offset (or at it, with bias -1); the last node at the very end. */
  const find = (offset: number, bias: 1 | -1): number => {
    let lo = 0
    let hi = nodes.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const end = nodes[mid]!.start + nodes[mid]!.node.data.length
      if (offset < end || (offset === end && bias < 0)) hi = mid
      else lo = mid + 1
    }
    return lo
  }
  const at = (offset: number, bias: 1 | -1 = 1) => {
    if (nodes.length === 0 || offset < 0 || offset > text.length) return null
    const { node, start } = nodes[find(offset, bias)]!
    return { node, offset: Math.min(Math.max(offset - start, 0), node.data.length) }
  }
  const segments = (start: number, end: number) => {
    const out: Array<{ node: Text; from: number; to: number }> = []
    if (nodes.length === 0 || end <= start) return out
    for (let i = find(start, 1); i < nodes.length && nodes[i]!.start < end; i++) {
      const { node, start: s } = nodes[i]!
      const from = Math.max(start - s, 0)
      const to = Math.min(end - s, node.data.length)
      if (to > from) out.push({ node, from, to })
    }
    return out
  }
  return { text, at, segments }
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
  /**
   * A still (first frame) of an asset that can animate, as a URL (see `stillImage.ts`). When
   * given, the layer shows it instead of the decoded image, so an animated GIF stays still as on
   * the canvas today. Undefined: the decoded image is shown.
   */
  getStill?(assetId: string): string | undefined
  measurer?: CardMeasurer
  document?: Document
  /**
   * Lay every card out again by itself when a font finishes loading (default true). The editor
   * turns it off to choose the moment (`refreshTypography`): never in the middle of a gesture.
   */
  followFonts?: boolean
  /**
   * The width a text card is drawn at, from its record (default `effectiveCardWidth`: as a box
   * built from that record). The editor passes `liveCardWidth`: its records already hold the
   * width the box was built with, and from then on only the formatted text widens it.
   */
  cardWidth?: (rec: CardSource, doc: Document) => number
}

interface ItemState {
  kind: 'frame' | 'image' | 'text'
  el: HTMLElement
  /** The record last rendered, as JSON: an unchanged record is not rendered again. */
  key: string
  rec: FrameRecord | ObjectRecord
  /** Untransformed box size (scene units): a frame's size, an image's shown crop, a text's effective width and measured height. */
  w: number
  h: number
  matrix: Matrix
  culled: boolean
  editing: boolean
  moving: boolean
  /** Images: the decoded picture's own size. */
  natural?: Size
  /** Texts: what the body shows (the look without the width, and the no-wrap ranges). */
  shown?: string
}

/**
 * The DOM scene. Build it, `mount` it under the canvas, give it the board with `setRecords`,
 * keep it in step with `updateItem` (a changed record), `setItemMatrix` (an object moving with
 * Fabric during a gesture) and `setViewport`, then `cull` after the view changes.
 *
 * While a card is the edited one (`setEditing`), the layer never touches its body's children:
 * only its geometry and box-level styles follow its record. When editing ends (call the edit
 * session's `finish()` first, then `setEditing(null)`), the card is rendered again from its record.
 */
export class SceneLayer {
  readonly root: HTMLElement
  readonly world: HTMLElement
  readonly frames: HTMLElement
  readonly objects: HTMLElement
  readonly measurer: CardMeasurer
  private readonly doc: Document
  private readonly getImage: (assetId: string) => HTMLImageElement | undefined
  private readonly getStill: ((assetId: string) => string | undefined) | undefined
  private readonly items = new Map<string, ItemState>()
  private view: Viewport = { zoom: 1, panX: 0, panY: 0 }
  private disposed = false
  private readonly onFontsLoaded = () => this.refreshTypography()
  private readonly followFonts: boolean
  private readonly cardWidth: (rec: CardSource, doc: Document) => number

  constructor(opts: SceneLayerOptions) {
    this.doc = opts.document ?? document
    this.getImage = opts.getImage
    this.getStill = opts.getStill
    this.measurer = opts.measurer ?? new DomCardMeasurer()
    this.followFonts = opts.followFonts ?? true
    this.cardWidth = opts.cardWidth ?? effectiveCardWidth
    const div = (cls: string) => {
      const el = this.doc.createElement('div')
      el.className = cls
      return el
    }
    this.root = div('scene-layer')
    // What the board shows is not read out item by item (the layer list names every item, as on the
    // canvas, which exposes none): each item is hidden from assistive technology, never the layer
    // itself, so that the text being edited, which has focus, can be exposed (`setEditing`).
    this.world = div('scene-world')
    this.frames = div('scene-frames')
    this.objects = div('scene-objects')
    this.world.append(this.frames, this.objects)
    this.root.append(this.world)
  }

  /** Puts the layer first in `parent`. A font that finishes loading from then on lays every card out again (`refreshTypography`), unless `followFonts` is off. */
  mount(parent: HTMLElement) {
    if (this.disposed) throw new Error('a disposed scene layer cannot be mounted')
    parent.prepend(this.root)
    if (this.followFonts) this.doc.fonts?.addEventListener('loadingdone', this.onFontsLoaded)
    // Cards rendered while detached were measured without layout.
    this.refreshTypography()
  }

  unmount() {
    this.doc.fonts?.removeEventListener('loadingdone', this.onFontsLoaded)
    this.root.remove()
  }

  dispose() {
    this.unmount()
    this.items.clear()
    this.frames.replaceChildren()
    this.objects.replaceChildren()
    this.disposed = true
  }

  /**
   * Drops every typography measurement (`resetTypography`) and lays every card out again from
   * its record: after fonts or the stylesheet change. The edited card keeps its children; only
   * its box-level styles and size follow.
   */
  refreshTypography() {
    resetTypography()
    for (const item of this.items.values()) {
      if (item.kind !== 'text') continue
      delete item.shown
      this.renderText(item, item.rec as TextRecord)
    }
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

  /** A text card's drawn width (scene units): its stored width, or its widest word when that is wider (the `cardWidth` option). */
  widthOf(id: string): number | undefined {
    const item = this.items.get(id)
    return item?.kind === 'text' ? item.w : undefined
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
   * rendered again unless `force`.
   */
  updateItem(rec: FrameRecord | ObjectRecord, force = false) {
    const kind = 'type' in rec ? rec.type : 'frame'
    const item = this.items.get(rec.id)
    if (!item) throw new Error(`no scene item ${rec.id}: use setRecords to add one`)
    if (force) {
      item.key = ''
      delete item.shown
    }
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

  /**
   * The edited text card (at most one): outlined, never culled, and its body's children left to
   * the live editor. A card that stops being the edited one is rendered again from its record,
   * so finish the edit session before.
   */
  setEditing(id: string | null) {
    for (const [itemId, item] of this.items) {
      const on = itemId === id
      if (item.editing === on) continue
      item.editing = on
      item.el.classList.toggle('is-editing', on)
      if (on) item.el.removeAttribute('aria-hidden')
      else item.el.setAttribute('aria-hidden', 'true')
      if (on) this.setCulled(item, false)
      else if (item.kind === 'text') {
        delete item.shown
        this.renderText(item, item.rec as TextRecord)
      }
    }
  }

  /** An item moved or scaled by a gesture right now: never culled. Cleared when it settles. */
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
   * size in CSS pixels, by default the layer's own. Uses each card's last measured size.
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
   * A text card's height, minimum width and effective width, laid out now; the layer keeps them
   * (culling uses them). A culled card is brought back for the measurement and culled again after it.
   */
  measureCard(id: string): { height: number; minWidth: number; width: number } | undefined {
    const item = this.items.get(id)
    if (item?.kind !== 'text') return undefined
    const culled = item.culled
    if (culled) this.setCulled(item, false)
    try {
      const body = item.el.firstElementChild as HTMLElement
      const rec = item.rec as TextRecord
      const minWidth = this.measurer.measureMinWidth(body, rec)
      item.h = this.measurer.measureHeight(body, rec)
      return { height: item.h, minWidth, width: item.w }
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
      el.setAttribute('aria-hidden', 'true')
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
    this.place(item, recordMatrix(rec.left, rec.top, rec.angle, rec.scaleX, rec.scaleY))
    if (!source) {
      // As on the canvas: an image whose bytes are missing is not drawn.
      el.replaceChildren()
      el.hidden = true
      item.w = 0
      item.h = 0
      return
    }
    el.hidden = false
    let img = el.firstElementChild as HTMLImageElement | null
    if (!img) {
      img = this.doc.createElement('img')
      img.alt = ''
      img.draggable = false
      img.decoding = 'sync'
      el.append(img)
    }
    const src = this.getStill?.(rec.assetId) ?? (source.currentSrc || source.src)
    if (img.getAttribute('src') !== src) img.src = src
    const natural = { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height }
    if (!(natural.width > 0 && natural.height > 0)) {
      // Not decoded yet: drawn nowhere for now, and sized once it is (or when the record comes again).
      item.key = ''
      item.w = 0
      item.h = 0
      el.style.width = '0px'
      el.style.height = '0px'
      const retry = () => {
        if (this.items.get(rec.id) === item && item.key === '' && !this.disposed) this.upsert(item.rec, 'image')
      }
      source.addEventListener('load', retry, { once: true })
      return
    }
    // A stored crop reaching outside the decoded image is clamped to it (objects.ts `createObject`).
    const crop: CropRect = clampCrop(rec.crop, natural) ?? { x: 0, y: 0, width: natural.width, height: natural.height }
    img.style.width = `${natural.width}px`
    img.style.height = `${natural.height}px`
    img.style.transform = crop.x === 0 && crop.y === 0 ? '' : `translate(${-crop.x}px, ${-crop.y}px)`
    el.style.width = `${crop.width}px`
    el.style.height = `${crop.height}px`
    item.natural = natural
    item.w = crop.width
    item.h = crop.height
  }

  private renderText(item: ItemState, rec: TextRecord) {
    const el = item.el
    let body = el.firstElementChild as HTMLElement | null
    if (!body) {
      body = this.doc.createElement('div')
      body.className = 'scene-text-body'
      el.append(body)
    }
    const width = this.cardWidth(rec, this.doc)
    el.style.width = `${width}px`
    if (item.editing) {
      // The live editor owns the children: only box-level styles follow the record.
      applyCardStyle(body, rec)
      delete item.shown
    } else {
      // A new width alone (a side-handle resize) renders the body again only when it changes a
      // drawn box's no-wrap ranges.
      const ranges = noWrapRanges(rec, this.doc)
      const shown = JSON.stringify([cardLook(rec), ranges])
      if (item.shown !== shown) {
        renderCardBody(body, rec, ranges)
        item.shown = shown
      }
    }
    item.w = width
    this.place(item, recordMatrix(rec.left, rec.top, rec.angle))
    this.remeasure(item)
  }

  private remeasure(item: ItemState) {
    if (item.kind !== 'text') return
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
