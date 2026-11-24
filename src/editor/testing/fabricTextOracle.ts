import { Textbox } from 'fabric'
import type { TextStyle, TextStyleDeclaration } from 'fabric'
import type { FontId, TextSpan } from '../../model/types.ts'

/**
 * FROZEN. Never modernize, refactor or "fix" this file, and never import it from the app.
 *
 * The oracle of `e2e/text-engine-parity.spec.ts`: how the canvas edited text before the DOM
 * renderer replaced it. A real Fabric `Textbox` (fabric 7.4.0, still a dependency) is built from
 * a record, fed the input a key gives through Fabric's own `onInput`, and its per-character
 * styles are reconciled and read back as a record exactly as the Fabric renderer did.
 *
 * Copied from the app source as of commit 9e73b09, which commit 03fa4c2 leaves unchanged. 03fa4c2
 * is the last commit in which the Fabric renderer exists and the only one in which
 * `FABRIC_REFERENCE=check` and `FABRIC_REFERENCE=record` work. The copy leaves out only what this oracle never reaches (selection styling, ids, captions, locks, drawn boxes,
 * the `seen` callback) and comments: from `src/editor/objects.ts` the text half of
 * `createObject` (a plain `Textbox`: the spec builds no drawn boxes), `linesOf`, `stylesFor`,
 * `hasStyles`, `levelOf`, `marksOf`, the remembered canonical state, `caretOffset`,
 * `graphemeToOffset`, `readTextFormatting`, `writeTextFormatting`, `sameStyles`,
 * `reconcileTextFormatting` and what `toRecord` reads from a text box's formatting; from
 * `src/model/richText.ts` everything those call (`canonicalTextFormatting` and the canonical
 * form behind it, `spansFromCharStyles`, `markMask`, `withPendingMarks`, `textAfterEdit` and
 * its diff); from `src/editor/fonts.ts` the font chains. It uses nothing of the app, so the
 * engine it is compared with cannot change it. Before the Fabric renderer was deleted the spec
 * ran this copy and the live code side by side on every one of its cases
 * (`FABRIC_REFERENCE=check`) and they agreed on all of them. If Fabric itself is ever upgraded,
 * treat any new difference in the spec as a change of the oracle, not of the engine.
 */

// ---- src/editor/fonts.ts ------------------------------------------------------------------------

const FONT_STACKS: Readonly<Record<FontId, string>> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'Consolas, "Cascadia Mono", Menlo, Monaco, "Courier New", monospace',
  hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive',
  display: 'Impact, Haettenschweiler, "Arial Black", "Franklin Gothic Bold", sans-serif',
}

function fontIdOf(family: string): FontId {
  for (const [id, stack] of Object.entries(FONT_STACKS) as Array<[FontId, string]>) if (stack === family) return id
  return 'sans'
}

// ---- src/model/richText.ts ----------------------------------------------------------------------

const FONT_IDS: readonly FontId[] = ['sans', 'serif', 'mono', 'hand', 'display']
const DEFAULT_FONT: FontId = 'sans'
const isFont = (value: unknown): value is FontId => FONT_IDS.includes(value as FontId)
const DEFAULT_TEXT_COLOR = '#1d2230'
type Mark = 'bold' | 'italic' | 'underline' | 'strike'
const MARKS: readonly Mark[] = ['bold', 'italic', 'underline', 'strike']
type HeadingLevel = 1 | 2 | 3
const HEADING_SCALE: Readonly<Record<HeadingLevel, number>> = { 1: 2, 2: 1.5, 3: 1.25 }
const isHeadingLevel = (v: unknown): v is HeadingLevel => v === 1 || v === 2 || v === 3
function headingFontSize(base: number, level: HeadingLevel): number {
  return base * HEADING_SCALE[level]
}

/** The formatting fields of a text record, each present only when it is not the default. */
export interface TextFormatting {
  font?: FontId
  align?: 'left' | 'center' | 'right'
  color?: string
  spans?: TextSpan[]
  headings?: number[]
}
type PendingMarks = Partial<Record<Mark, boolean>>
export type PendingTextStyle = PendingMarks & { font?: FontId }

interface Segmenter {
  segment(s: string): Iterable<{ segment: string }>
}
let segmenter: Segmenter | null | undefined
function splitGraphemes(s: string): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  }
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s)
}

interface Paragraph {
  start: number
  end: number
  chars: number[]
}
function paragraphsOf(text: string): Paragraph[] {
  const out: Paragraph[] = []
  let start = 0
  for (const part of text.split('\n')) {
    const len = part.endsWith('\r') && start + part.length < text.length ? part.length - 1 : part.length
    const chars: number[] = []
    let o = start
    for (const g of splitGraphemes(part.slice(0, len))) {
      chars.push(o)
      o += g.length
    }
    out.push({ start, end: start + len, chars })
    start += part.length + 1
  }
  return out
}
const paragraphCount = (text: string): number => text.split('\n').length

const BIT: Readonly<Record<Mark, number>> = { bold: 1, italic: 2, underline: 4, strike: 8 }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function canonicalHeadings(text: string, raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const n = Math.min(raw.length, paragraphCount(text))
  const out = Array.from({ length: n }, (_, i): number => (isHeadingLevel(raw[i]) ? raw[i] : 0))
  while (out.length > 0 && out[out.length - 1] === 0) out.pop()
  return out.length > 0 ? out : undefined
}

function canonicalSpans(text: string, raw: unknown, headings?: readonly number[], baseFont = DEFAULT_FONT): TextSpan[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || text === '') return undefined
  if (raw.length > text.length) return undefined
  const cover = MARKS.map(() => new Int32Array(text.length + 1))
  const fontCover = new Map<FontId, Int32Array>()
  let any = false
  for (let i = 0; i < raw.length; i++) {
    const s: unknown = raw[i]
    if (!isObj(s) || !Number.isInteger(s.start) || !Number.isInteger(s.end)) continue
    const a = Math.max(0, s.start as number)
    const b = Math.min(text.length, s.end as number)
    if (a >= b) continue
    MARKS.forEach((m, i) => {
      if (s[m] !== true) return
      const c = cover[i] as Int32Array
      c[a] = (c[a] ?? 0) + 1
      c[b] = (c[b] ?? 0) - 1
      any = true
    })
    if (isFont(s.font)) {
      let counts = fontCover.get(s.font)
      if (!counts) fontCover.set(s.font, (counts = new Int32Array(text.length + 1)))
      counts[a] = (counts[a] ?? 0) + 1
      counts[b] = (counts[b] ?? 0) - 1
      any = true
    }
  }
  if (!any) return undefined
  const unitMask = new Uint8Array(text.length)
  cover.forEach((c, i) => {
    let n = 0
    for (let k = 0; k < text.length; k++) {
      n += c[k] ?? 0
      if (n > 0) unitMask[k] = (unitMask[k] ?? 0) | (1 << i)
    }
  })
  const unitFont: Array<FontId | undefined> = []
  for (const font of FONT_IDS) {
    const counts = fontCover.get(font)
    if (!counts) continue
    let active = 0
    for (let k = 0; k < text.length; k++) {
      active += counts[k] ?? 0
      if (active > 0) unitFont[k] ??= font
    }
  }
  return spansFromCharStyles(text, headings, (a, b) => {
    let mask = 0
    let font: FontId | undefined
    for (let k = a; k < b; k++) {
      mask |= unitMask[k] ?? 0
      font ??= unitFont[k]
    }
    return { mask, font: font === baseFont ? undefined : font }
  })
}

interface CharStyle {
  mask: number
  font?: FontId
}

function spansFromCharStyles(text: string, headings: readonly number[] | undefined, styleOf: (start: number, end: number) => CharStyle | undefined): TextSpan[] | undefined {
  interface Unit extends CharStyle {
    start: number
    end: number
    isBreak: boolean
  }
  const units: Unit[] = []
  const paras = paragraphsOf(text)
  paras.forEach((p, pi) => {
    const keep = (headings?.[pi] ?? 0) > 0 ? ~BIT.bold : ~0
    p.chars.forEach((a, k) => {
      const b = p.chars[k + 1] ?? p.end
      const style = styleOf(a, b)
      units.push({ start: a, end: b, mask: (style?.mask ?? 0) & keep & 15, font: style?.font, isBreak: false })
    })
    const next = paras[pi + 1]
    if (next) units.push({ start: p.end, end: next.start, mask: 0, isBreak: true })
  })
  const after: Array<Unit | undefined> = []
  let next: Unit | undefined
  for (let i = units.length - 1; i >= 0; i--) {
    after[i] = next
    const u = units[i] as Unit
    if (!u.isBreak) next = u
  }
  let before: Unit | undefined
  units.forEach((u, i) => {
    if (u.isBreak) {
      u.mask = (before?.mask ?? 0) & (after[i]?.mask ?? 0)
      u.font = before?.font === after[i]?.font ? before?.font : undefined
    } else before = u
  })
  const out: TextSpan[] = []
  let lastMask = 0
  for (const u of units) {
    if (u.mask === 0 && !u.font) continue
    const last = out[out.length - 1]
    if (last && last.end === u.start && lastMask === u.mask && last.font === u.font) {
      last.end = u.end
      continue
    }
    const span: TextSpan = { start: u.start, end: u.end }
    for (const m of MARKS) if (u.mask & BIT[m]) span[m] = true
    if (u.font) span.font = u.font
    out.push(span)
    lastMask = u.mask
  }
  return out.length > 0 ? out : undefined
}

function markMask(marks: Partial<Record<Mark, unknown>>): number {
  let mask = 0
  for (const m of MARKS) if (marks[m] === true) mask |= BIT[m]
  return mask
}

const COLOR = /^#[0-9a-f]{6}$/i

function canonicalTextFormatting(text: string, raw: Record<string, unknown>): TextFormatting {
  const out: TextFormatting = {}
  const { font, align, color } = raw
  if (isFont(font) && font !== DEFAULT_FONT) out.font = font
  if (align === 'center' || align === 'right') out.align = align
  if (typeof color === 'string' && COLOR.test(color) && color.toLowerCase() !== DEFAULT_TEXT_COLOR) out.color = color.toLowerCase()
  const headings = canonicalHeadings(text, raw.headings)
  const spans = canonicalSpans(text, raw.spans, headings, out.font)
  if (spans) out.spans = spans
  if (headings) out.headings = headings
  return out
}

interface TextChange {
  start: number
  prevEnd: number
  nextEnd: number
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
function splitsUnit(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false
  const a = s.charCodeAt(i - 1)
  const b = s.charCodeAt(i)
  return (isHigh(a) && isLow(b)) || (a === 13 && b === 10)
}

function diffText(prev: string, next: string, caret?: number): TextChange {
  let p = 0
  let s = 0
  const fits = caret !== undefined && Number.isInteger(caret) && caret >= 0 && caret <= next.length && next.length - caret <= prev.length && prev.endsWith(next.slice(caret))
  if (fits) {
    s = next.length - caret
    const limit = Math.min(caret, prev.length - s)
    while (p < limit && prev.charCodeAt(p) === next.charCodeAt(p)) p++
  } else {
    const common = Math.min(prev.length, next.length)
    while (p < common && prev.charCodeAt(p) === next.charCodeAt(p)) p++
    while (s < common - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++
  }
  while (p > 0 && (splitsUnit(prev, p) || splitsUnit(next, p))) p--
  while (s > 0 && (splitsUnit(prev, prev.length - s) || splitsUnit(next, next.length - s))) s--
  return { start: p, prevEnd: prev.length - s, nextEnd: next.length - s }
}

interface LineBounds {
  start: number
  end: number
}
function lineBounds(text: string): LineBounds[] {
  const out: LineBounds[] = []
  let start = 0
  for (const part of text.split('\n')) {
    const len = part.endsWith('\r') && start + part.length < text.length ? part.length - 1 : part.length
    out.push({ start, end: start + len })
    start += part.length + 1
  }
  return out
}
function lineAt(lines: readonly LineBounds[], offset: number): number {
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((lines[mid] as LineBounds).start <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

interface EditOutcome {
  headings: number[] | undefined
  levelBefore(start: number, end: number): number | undefined
  change: TextChange
}

function textAfterEdit(prevText: string, prevHeadings: readonly number[] | undefined, nextText: string, caret?: number): EditOutcome {
  const prev = nextText.includes('\r') ? prevText : prevText.replace(/\r\n/g, '\n')
  const level = (i: number): number => {
    const v = prevHeadings?.[i]
    return isHeadingLevel(v) ? v : 0
  }
  const prevLines = lineBounds(prev)
  const nextLines = lineBounds(nextText)
  const change = prev === nextText ? { start: nextText.length, prevEnd: nextText.length, nextEnd: nextText.length } : diffText(prev, nextText, caret)
  const { start, prevEnd, nextEnd } = change
  const ls = lineAt(prevLines, start)
  const le = lineAt(prevLines, prevEnd)
  const ne = lineAt(nextLines, nextEnd)
  const out = new Array<number>(nextLines.length).fill(0)
  for (let i = 0; i < ls; i++) out[i] = level(i)
  if (le - ls === ne - ls) {
    for (let i = ls; i <= le; i++) out[i] = level(i)
  } else {
    const restOfLast = (prevLines[le] as LineBounds).end > prevEnd
    if (ne === ls) {
      const fromStart = start === (prevLines[ls] as LineBounds).start
      out[ls] = fromStart && le > ls && restOfLast ? level(le) : level(ls)
    } else {
      out[ls] = level(ls)
      out[ne] = restOfLast ? level(le) : 0
    }
  }
  for (let i = le + 1; i < prevLines.length; i++) out[ne + i - le] = level(i)
  return {
    headings: canonicalHeadings(nextText, out),
    levelBefore(a, b) {
      if (b <= start) return level(lineAt(prevLines, a))
      if (a >= nextEnd) return level(lineAt(prevLines, a - nextEnd + prevEnd))
      return undefined
    },
    change,
  }
}

function withPendingMarks(mask: number, pending: PendingMarks): number {
  let out = mask
  for (const m of MARKS) {
    if (pending[m] === true) out |= BIT[m]
    else if (pending[m] === false) out &= ~BIT[m]
  }
  return out
}

// ---- src/editor/objects.ts ----------------------------------------------------------------------

interface Line {
  start: number
  graphemes: string[]
}

function linesOf(tb: Textbox): Line[] {
  const text = tb.text
  const lines: Line[] = []
  let start = 0
  for (const part of text.split('\n')) {
    const body = part.endsWith('\r') && start + part.length < text.length ? part.slice(0, -1) : part
    lines.push({ start, graphemes: tb.graphemeSplit(body) })
    start += part.length + 1
  }
  return lines
}

function stylesFor(tb: Textbox, fmt: TextFormatting, base: number): TextStyle {
  const styles: TextStyle = {}
  const spans = fmt.spans ?? []
  let si = 0
  linesOf(tb).forEach((line, li) => {
    const level = fmt.headings?.[li]
    const heading: TextStyleDeclaration = isHeadingLevel(level) ? { fontSize: headingFontSize(base, level), fontWeight: 'bold' } : {}
    const row: Record<number, TextStyleDeclaration> = {}
    let end = line.start
    line.graphemes.forEach((g, k) => {
      const start = end
      end += g.length
      while (si < spans.length && (spans[si]?.end ?? 0) <= start) si++
      const span = spans[si]
      const on = span && span.start < end ? span : undefined
      const style: TextStyleDeclaration = { ...heading }
      if (on?.bold) style.fontWeight = 'bold'
      if (on?.italic) style.fontStyle = 'italic'
      if (on?.underline) style.underline = true
      if (on?.strike) style.linethrough = true
      if (on?.font) style.fontFamily = FONT_STACKS[on.font]
      if (Object.keys(style).length > 0) row[k] = style
    })
    if (line.graphemes.length === 0 && heading.fontSize !== undefined) row[0] = heading
    if (Object.keys(row).length > 0) styles[li] = row
  })
  return styles
}

const hasStyles = (tb: Textbox): boolean => Object.values(tb.styles ?? {}).some((row) => Object.keys(row).length > 0)

function levelOf(size: unknown, base: number): number {
  for (const level of [1, 2, 3] as const) if (size === headingFontSize(base, level)) return level
  return 0
}

const BOLD = markMask({ bold: true })
const marksOf = (st: TextStyleDeclaration): number =>
  markMask({ bold: st.fontWeight === 'bold' || st.fontWeight === 700, italic: st.fontStyle === 'italic', underline: st.underline === true, strike: st.linethrough === true })

interface TextState {
  text: string
  headings: readonly number[] | undefined
  width: number
  fontSize: number
}
const lastCanonical = new WeakMap<Textbox, TextState>()
function remember(tb: Textbox, headings: readonly number[] | undefined) {
  lastCanonical.set(tb, { text: tb.text, headings, width: tb.width, fontSize: tb.fontSize })
}

function caretOffset(tb: Textbox): number | undefined {
  return graphemeToOffset(tb, tb.selectionEnd)
}
function graphemeToOffset(tb: Textbox, g: unknown): number | undefined {
  if (typeof g !== 'number' || !Number.isInteger(g) || g < 0) return undefined
  let left = g
  for (const line of linesOf(tb)) {
    if (left <= line.graphemes.length) return line.start + line.graphemes.slice(0, left).join('').length
    left -= line.graphemes.length + 1
  }
  return undefined
}

function readTextFormatting(tb: Textbox, change?: { caret: number | undefined; pending?: PendingTextStyle }): TextFormatting {
  const raw: Record<string, unknown> = {
    font: fontIdOf(tb.fontFamily),
    align: tb.textAlign,
    color: typeof tb.fill === 'string' ? tb.fill : undefined,
  }
  const text = tb.text
  const known = lastCanonical.get(tb)
  const chars = new Map<number, CharStyle>()
  if (known && (change !== undefined || known.text !== text)) {
    const edit = textAfterEdit(known.text, known.headings, text, change?.caret)
    const headings = edit.headings
    const pending = change?.pending && Object.keys(change.pending).length > 0 ? change.pending : undefined
    for (const [li, line] of linesOf(tb).entries()) {
      const row = tb.styles[li]
      if (!row && !pending) continue
      let start = line.start
      line.graphemes.forEach((g, k) => {
        const end = start + g.length
        const st = row?.[k]
        let mask = st ? marksOf(st) : 0
        const complete = st?.fill !== undefined
        let font = !complete && st?.fontFamily !== undefined ? fontIdOf(st.fontFamily) : undefined
        if (st && mask & BOLD && (headings?.[li] ?? 0) === 0) {
          const before = edit.levelBefore(start, end)
          const headingBold = (before !== undefined && before > 0) || (st.fontSize !== undefined && !complete)
          if (headingBold) mask &= ~BOLD
        }
        if (pending && edit.levelBefore(start, end) === undefined) {
          mask = withPendingMarks(mask, pending)
          font = pending.font ?? font
        }
        if (mask || font) chars.set(start, { mask, font })
        start = end
      })
    }
    raw.headings = headings
  } else if (hasStyles(tb)) {
    const headings: number[] = []
    for (const [li, line] of linesOf(tb).entries()) {
      const row = tb.styles[li]
      headings.push(levelOf(row?.[0]?.fontSize, tb.fontSize))
      if (!row) continue
      let start = line.start
      line.graphemes.forEach((g, k) => {
        const st = row[k]
        const mask = st ? marksOf(st) : 0
        const font = st?.fontFamily !== undefined ? fontIdOf(st.fontFamily) : undefined
        if (mask || font) chars.set(start, { mask, font })
        start += g.length
      })
    }
    raw.headings = canonicalHeadings(text, headings)
  }
  if (chars.size > 0) raw.spans = spansFromCharStyles(text, raw.headings as number[] | undefined, (a) => chars.get(a))
  return canonicalTextFormatting(text, raw)
}

function writeTextFormatting(tb: Textbox, fmt: TextFormatting) {
  tb.set({
    fontFamily: FONT_STACKS[fmt.font ?? 'sans'],
    textAlign: fmt.align ?? 'left',
    fill: fmt.color ?? DEFAULT_TEXT_COLOR,
    styles: stylesFor(tb, fmt, tb.fontSize),
  })
  remember(tb, canonicalHeadings(tb.text, fmt.headings))
}

function sameStyles(a: TextStyle | undefined, b: TextStyle): boolean {
  const flat = (s: TextStyle | undefined) => {
    const out: string[] = []
    for (const [li, row] of Object.entries(s ?? {})) {
      for (const [ci, st] of Object.entries(row)) {
        const keys = Object.keys(st).sort()
        if (keys.length > 0) out.push(`${li}:${ci}:${keys.map((k) => `${k}=${String((st as Record<string, unknown>)[k])}`).join(',')}`)
      }
    }
    return out.sort().join('|')
  }
  return flat(a) === flat(b)
}

/** The text half of `createObject`: a plain (click-created) text box with the record's text and formatting. */
export function createFabricText(rec: TextFormatting & { text: string; left: number; top: number; angle: number; width: number; fontSize: number }): Textbox {
  const tb = new Textbox(rec.text, {
    originX: 'left',
    originY: 'top',
    padding: 2,
    strokeWidth: 0,
    left: rec.left,
    top: rec.top,
    angle: rec.angle,
    width: rec.width,
    fontSize: rec.fontSize,
    fontFamily: FONT_STACKS.sans,
    fill: DEFAULT_TEXT_COLOR,
    lineHeight: 1.25,
  })
  tb.text = rec.text
  writeTextFormatting(tb, rec)
  return tb
}

/** `reconcileTextFormatting`: after Fabric changed the text, its styles made canonical again (`pending`: marks chosen at a caret, given to what was inserted). */
export function reconcileFabricText(tb: Textbox, pending?: PendingTextStyle): boolean {
  const known = lastCanonical.get(tb)
  const fmt = readTextFormatting(tb, { caret: caretOffset(tb), pending })
  const want = stylesFor(tb, fmt, tb.fontSize)
  let changed = false
  if (!sameStyles(tb.styles, want)) {
    const anchorX = tb.textAlign === 'center' ? 'center' : tb.textAlign === 'right' ? 'right' : 'left'
    const pos = tb.getPositionByOrigin(anchorX, 'top')
    const width = known && known.fontSize === tb.fontSize && known.width < tb.width ? known.width : tb.width
    tb.set({ styles: want, width })
    tb.setPositionByOrigin(pos, anchorX, 'top')
    tb.setCoords()
    changed = true
  }
  remember(tb, fmt.headings)
  return changed
}

/** What `toRecord` reads of a text box's content: its text and its canonical formatting. */
export function fabricTextContent(tb: Textbox): TextFormatting & { text: string } {
  const fmt = readTextFormatting(tb)
  if (lastCanonical.get(tb)?.text === tb.text) remember(tb, fmt.headings)
  return { text: tb.text, ...fmt }
}
