import type { FontId, TextRecord, TextSpan } from './types.ts'

/**
 * Formatting on a text box, as the document stores it. Pure: no Fabric, no DOM.
 *
 * Every span list and heading list the app holds is in one canonical form, so that two
 * texts that look the same are stored the same, and "a commit that changes nothing
 * records nothing" stays exact:
 * - spans: integer offsets with 0 <= start < end <= text.length, sorted, non-overlapping,
 *   adjacent spans with identical formatting merged, every span carrying marks (only
 *   ever `true`) or a font different from the box font;
 * - a span never starts or ends inside a character (a surrogate pair or any other
 *   grapheme cluster, the unit the canvas styles): a half-marked character counts as
 *   marked, so the span grows outwards to cover it whole;
 * - a line break is not a character of its own: it carries exactly the marks that the
 *   nearest characters on both sides of it share, so a bold run continues across a break
 *   only when both lines are bold there. The same applies to font overrides;
 * - a heading line is always bold, so `bold` is never stored inside one;
 * - headings: levels 0 to 3, one per paragraph at most, trailing zeros trimmed.
 * Absent (undefined) means none.
 */

export const FONT_IDS: readonly FontId[] = ['sans', 'serif', 'mono', 'hand', 'display']
export const FONT_LABELS: Readonly<Record<FontId, string>> = {
  sans: 'Sans',
  serif: 'Serif',
  mono: 'Mono',
  hand: 'Handwritten',
  display: 'Display',
}
export const DEFAULT_FONT: FontId = 'sans'
const isFont = (value: unknown): value is FontId => FONT_IDS.includes(value as FontId)

/** The default ink of a text. Never stored: a text in this colour has no `color`. */
export const DEFAULT_TEXT_COLOR = '#1d2230'

export type Mark = 'bold' | 'italic' | 'underline' | 'strike'
export const MARKS: readonly Mark[] = ['bold', 'italic', 'underline', 'strike']

export type HeadingLevel = 1 | 2 | 3
/** A heading is drawn at this multiple of its box's font size. */
export const HEADING_SCALE: Readonly<Record<HeadingLevel, number>> = { 1: 2, 2: 1.5, 3: 1.25 }

export const isHeadingLevel = (v: unknown): v is HeadingLevel => v === 1 || v === 2 || v === 3

export function headingFontSize(base: number, level: HeadingLevel): number {
  return base * HEADING_SCALE[level]
}

/** The formatting fields of a text record, each present only when it is not the default. */
export type TextFormatting = Pick<TextRecord, 'font' | 'align' | 'color' | 'spans' | 'headings'>

// ---- characters and paragraphs ----------------------------------------------------------

interface Segmenter {
  segment(s: string): Iterable<{ segment: string }>
}
let segmenter: Segmenter | null | undefined

/**
 * Splits a line into user-perceived characters exactly as Fabric does (fabric 7.4.0,
 * util/lang_string.mjs: an `Intl.Segmenter` with granularity "grapheme" and the default
 * locale, or code points where there is none).
 */
export function splitGraphemes(s: string): string[] {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  }
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s)
}

export interface Paragraph {
  /** UTF-16 offset of the paragraph's first character. */
  start: number
  /** UTF-16 offset just past its last character (before its line break). */
  end: number
  /** The UTF-16 offset at which each of its characters starts. */
  chars: number[]
}

/**
 * The paragraphs of a text (`text.split('\n')`) with their characters. Like Fabric, a
 * "\r" directly before a "\n" belongs to the line break, not to the line.
 *
 * Known limit: a lone "\r" (not followed by "\n") is an ordinary character here and on the
 * canvas, but the editing textarea turns it into a line break on the first keystroke, so
 * the marks after it shift by a line. The app never writes such a text; only a hand-made
 * stored board can hold one.
 */
export function paragraphsOf(text: string): Paragraph[] {
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

export const paragraphCount = (text: string): number => text.split('\n').length

// ---- canonical form -----------------------------------------------------------------------

const BIT: Readonly<Record<Mark, number>> = { bold: 1, italic: 2, underline: 4, strike: 8 }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Heading levels per paragraph in canonical form; invalid levels count as 0. */
export function canonicalHeadings(text: string, raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const n = Math.min(raw.length, paragraphCount(text))
  const out = Array.from({ length: n }, (_, i): number => (isHeadingLevel(raw[i]) ? raw[i] : 0))
  while (out.length > 0 && out[out.length - 1] === 0) out.pop()
  return out.length > 0 ? out : undefined
}

/**
 * Spans in canonical form for `text`, given its canonical `headings`. Entries that are not
 * spans (non-integer offsets, nothing marked, empty after trimming to the text) are dropped;
 * overlapping spans combine their marks.
 */
export function canonicalSpans(text: string, raw: unknown, headings?: readonly number[], baseFont = DEFAULT_FONT): TextSpan[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || text === '') return undefined
  // A canonical list has at most one span per code unit. A longer one was not written by
  // the app, and could be a huge sparse array that would take minutes to walk: drop it.
  if (raw.length > text.length) return undefined
  // How many valid spans cover each code unit, per mark (a difference array, summed below).
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
  // Mask of the marks on each code unit.
  const unitMask = new Uint8Array(text.length)
  cover.forEach((c, i) => {
    let n = 0
    for (let k = 0; k < text.length; k++) {
      n += c[k] ?? 0
      if (n > 0) unitMask[k] = (unitMask[k] ?? 0) | (1 << i)
    }
  })
  // Conflicting fonts in malformed records use FONT_IDS order at each code unit.
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

export interface CharStyle {
  mask: number
  /** An override of the box font. */
  font?: FontId
}

/**
 * Builds canonical spans from the marks of each character (given as its UTF-16 range).
 * Shared by loading and by reading a text back from the canvas, so both agree exactly.
 */
export function spansFromCharStyles(text: string, headings: readonly number[] | undefined, styleOf: (start: number, end: number) => CharStyle | undefined): TextSpan[] | undefined {
  interface Unit extends CharStyle {
    start: number
    end: number
    isBreak: boolean
  }
  const units: Unit[] = []
  const paras = paragraphsOf(text)
  paras.forEach((p, pi) => {
    const keep = (headings?.[pi] ?? 0) > 0 ? ~BIT.bold : ~0 // a heading is bold already
    p.chars.forEach((a, k) => {
      const b = p.chars[k + 1] ?? p.end
      const style = styleOf(a, b)
      units.push({ start: a, end: b, mask: (style?.mask ?? 0) & keep & 15, font: style?.font, isBreak: false })
    })
    const next = paras[pi + 1]
    if (next) units.push({ start: p.end, end: next.start, mask: 0, isBreak: true })
  })
  // A line break carries the marks shared by the nearest characters on either side of it.
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

/** The marks of a span as a bit mask (see `spansFromCharStyles`). */
export function markMask(marks: Partial<Record<Mark, unknown>>): number {
  let mask = 0
  for (const m of MARKS) if (marks[m] === true) mask |= BIT[m]
  return mask
}

const COLOR = /^#[0-9a-f]{6}$/i

/**
 * The formatting of a text in canonical form, from untrusted values (a stored record, or
 * what the canvas holds). Anything malformed is dropped or trimmed, never fatal; defaults
 * are absent. Keys come in a fixed order: font, align, color, spans, headings.
 */
export function canonicalTextFormatting(text: string, raw: Record<string, unknown>): TextFormatting {
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

// ---- carrying headings across an edit -------------------------------------------------------
//
// A heading is a property of a line. When the text changes while it is edited (typing, a
// paste, a drop, Backspace across a line break), each line's level is carried over from the
// levels the lines had before and how the text changed, never guessed from the font size of
// whatever characters the canvas inserted (a paste brings the source's sizes with it).

/** Where two versions of a text differ: old = A + X + C and new = A + Y + C (UTF-16 offsets). */
export interface TextChange {
  /** Length of A: where the two versions start to differ. */
  start: number
  /** End of X in the old text. */
  prevEnd: number
  /** End of Y in the new text. */
  nextEnd: number
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff
/** True when offset `i` falls inside a surrogate pair or between the "\r" and "\n" of a line break. */
function splitsUnit(s: string, i: number): boolean {
  if (i <= 0 || i >= s.length) return false
  const a = s.charCodeAt(i - 1)
  const b = s.charCodeAt(i)
  return (isHigh(a) && isLow(b)) || (a === 13 && b === 10)
}

/**
 * The changed region between two versions of a text. Among repeated characters (several
 * empty lines in a row, a doubled letter) more than one region explains the change; when the
 * caret position after the change is given and fits, the region that ends at the caret is
 * chosen (typing, pasting and dropping leave the caret after what they inserted, deleting
 * leaves it where the deletion was). Otherwise: the longest common prefix, then the longest
 * common suffix of what is left. Never splits a surrogate pair or a "\r\n".
 */
export function diffText(prev: string, next: string, caret?: number): TextChange {
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
  /** Just past its last character, before its line break ("\r\n" counts as the break). */
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
/** Index of the line an offset falls in; an offset at a line's end (before its break) is on that line. */
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

export interface EditOutcome {
  /** The new text's heading levels, in canonical form. */
  headings: number[] | undefined
  /**
   * The level of the line that the character at [start, end) of the new text was on before
   * the edit, or undefined when the edit inserted (or replaced) that character.
   */
  levelBefore(start: number, end: number): number | undefined
  /** Where the two versions differ (empty at the end of the text when they are the same). */
  change: TextChange
}

/**
 * The heading levels of `nextText` after an edit turned `prevText` (with `prevHeadings`)
 * into it. In terms of the person typing:
 * - lines the change did not touch keep their level (shifted when lines are added or
 *   removed above them);
 * - when the change leaves the number of lines of the block it touches unchanged (typing in
 *   a line, replacing a line's text, moving a word within the text), each line of the block
 *   keeps its level by position; so an emptied heading line stays a heading;
 * - otherwise the line the change starts in keeps its level, lines the change creates are
 *   normal, and the last line keeps the level of the line its remaining text came from
 *   (Enter at the end of a heading starts a normal line; Enter in the middle leaves two
 *   headings; a multi-line paste joins its first line to the line it was pasted into);
 * - joining lines: the joined line keeps the level of the line the change starts in, unless
 *   nothing of that line is left before the change and text of a later line follows it,
 *   in which case it takes that later line's level.
 * `caret` is the caret's UTF-16 offset in `nextText` after the change, when known.
 */
export function textAfterEdit(prevText: string, prevHeadings: readonly number[] | undefined, nextText: string, caret?: number): EditOutcome {
  // The editing textarea turns "\r\n" into "\n". Line by line the two are the same, so a
  // stored "\r\n" text compares line for line with what typing leaves of it.
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
    const restOfLast = (prevLines[le] as LineBounds).end > prevEnd // text of line `le` follows the change
    if (ne === ls) {
      const fromStart = start === (prevLines[ls] as LineBounds).start
      out[ls] = fromStart && le > ls && restOfLast ? level(le) : level(ls)
    } else {
      out[ls] = level(ls)
      out[ne] = restOfLast ? level(le) : 0 // lines strictly between are new: normal
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

/** The heading levels of `nextText` after an edit; see `textAfterEdit`. */
export function headingsAfterEdit(prevText: string, prevHeadings: readonly number[] | undefined, nextText: string, caret?: number): number[] | undefined {
  return textAfterEdit(prevText, prevHeadings, nextText, caret).headings
}

// ---- applying formatting ------------------------------------------------------------------
//
// What the formatting controls do to a text's canonical formatting. Ranges are UTF-16 offsets
// into the text, [start, end). A "character" is a grapheme (the unit the canvas styles); a
// line break is not a character, so a range that covers only line breaks has no characters.

export type MarkState = 'on' | 'off' | 'mixed'
/** Marks chosen with only a caret, for what is typed next: true is on, false is off, absent is "as typed". */
export type PendingMarks = Partial<Record<Mark, boolean>>
export type PendingTextStyle = PendingMarks & { font?: FontId }
export type TextAlign = 'left' | 'center' | 'right'

/** The fixed colour choices, legible on a white frame or on an image. The first is the default ink (stored as nothing). */
export const TEXT_PALETTE: ReadonlyArray<{ color: string; name: string }> = [
  { color: DEFAULT_TEXT_COLOR, name: 'Ink' },
  { color: '#ffffff', name: 'White' },
  { color: '#6b7280', name: 'Grey' },
  { color: '#d92d20', name: 'Red' },
  { color: '#e8590c', name: 'Orange' },
  { color: '#2b8a3e', name: 'Green' },
  { color: '#1c6fd1', name: 'Blue' },
  { color: '#7048e8', name: 'Purple' },
]

interface StyledCharacter extends CharStyle {
  start: number
  end: number
  /** Paragraph index. */
  line: number
}

/** Every character of the text with its paragraph and its canonical span formatting. */
function styledCharacters(text: string, spans: readonly TextSpan[] | undefined): StyledCharacter[] {
  const out: StyledCharacter[] = []
  const list = spans ?? []
  let si = 0
  paragraphsOf(text).forEach((p, line) => {
    p.chars.forEach((a, k) => {
      const b = p.chars[k + 1] ?? p.end
      while (si < list.length && list[si]!.end <= a) si++
      const span = list[si]
      const style = span && span.start < b ? span : undefined
      out.push({ start: a, end: b, line, mask: style ? markMask(style) : 0, font: style?.font })
    })
  })
  return out
}

const overlaps = (c: StyledCharacter, start: number, end: number) => c.end > start && c.start < end
const isHeadingLine = (headings: readonly number[] | undefined, line: number) => (headings?.[line] ?? 0) > 0

/** A text's formatting with the given character styles and headings, in canonical form. */
function withStyles(text: string, fmt: TextFormatting, headings: readonly number[] | undefined, chars: readonly StyledCharacter[]): TextFormatting {
  const byStart = new Map(chars.map((c) => [c.start, c] as const))
  const spans = spansFromCharStyles(text, headings, (a) => byStart.get(a))
  return canonicalTextFormatting(text, { ...fmt, spans, headings })
}

/** Changes only the characters in the range, or the base and every character for a box selection. */
export function setRangeFont(text: string, fmt: TextFormatting, font: FontId, range?: TextRange): TextFormatting {
  const chars = styledCharacters(text, fmt.spans)
  const base = (range ? fmt.font : font) ?? DEFAULT_FONT
  for (const c of chars) {
    if (!range || overlaps(c, range.start, range.end)) c.font = font === base ? undefined : font
  }
  return withStyles(text, { ...fmt, font: base }, fmt.headings, chars)
}

/** The effective font of a range or the whole box. Line breaks do not have a font of their own. */
export function fontOfRange(text: string, fmt: TextFormatting, start: number, end: number): FontId | 'mixed' {
  const base = fmt.font ?? DEFAULT_FONT
  if (!fmt.spans?.some((span) => span.font)) return base
  const chars = styledCharacters(text, fmt.spans).filter((c) => overlaps(c, start, end))
  const font = chars[0]?.font ?? base
  return chars.every((c) => (c.font ?? base) === font) ? font : 'mixed'
}

/**
 * Toggles a mark on the characters of a range: removed if every one of them already has it,
 * otherwise added to all of them. A character on a heading line counts as bold, and bold is
 * never stored there; so bold over a range that lies entirely in heading lines changes
 * nothing, and over a mixed range it changes the characters on normal lines. A range with no
 * characters changes nothing.
 */
export function toggleMark(text: string, fmt: TextFormatting, mark: Mark, start: number, end: number): TextFormatting {
  const chars = styledCharacters(text, fmt.spans)
  const bit = BIT[mark]
  const has = (c: StyledCharacter) => (c.mask & bit) !== 0 || (mark === 'bold' && isHeadingLine(fmt.headings, c.line))
  const hit = chars.filter((c) => overlaps(c, start, end))
  if (hit.length === 0) return fmt
  const on = !hit.every(has)
  for (const c of hit) c.mask = on ? c.mask | bit : c.mask & ~bit
  return withStyles(text, fmt, fmt.headings, chars)
}

/**
 * The paragraphs a range touches (for an empty range, the caret's). A range that ends exactly
 * at the start of a line, just after a line break, does not touch that line.
 */
export function linesOfRange(text: string, start: number, end: number): { first: number; last: number } {
  const lines = lineBounds(text)
  const first = lineAt(lines, Math.min(start, end))
  let last = lineAt(lines, Math.max(start, end))
  if (end > start && last > first && end === (lines[last] as LineBounds).start) last--
  return { first, last }
}

/**
 * Sets the heading level (0: body text) of every line a range touches (see `linesOfRange`).
 * A heading line is bold of itself, so bold marks inside it are dropped; a line set back to
 * body text is therefore not bold.
 */
export function setHeading(text: string, fmt: TextFormatting, level: number, start: number, end: number): TextFormatting {
  const { first, last } = linesOfRange(text, start, end)
  return setHeadingOfLines(text, fmt, level, first, last)
}

/**
 * Sets the heading level of every line of the box (see `lastBoxLine`): a heading level leaves
 * an empty last line as it is, while body text (0) also clears it, so that no box control
 * leaves behind a tall empty line that none of them can remove.
 */
export function setHeadingEverywhere(text: string, fmt: TextFormatting, level: number): TextFormatting {
  return setHeadingOfLines(text, fmt, level, 0, level === 0 ? paragraphCount(text) - 1 : lastBoxLine(text))
}

/**
 * The index of the last line that counts for a whole-box heading (what the controls show for
 * the box, and what a heading set on the box changes): every line except an empty last one,
 * which is only where the caret goes after a final line break. A text without a single
 * character keeps all its lines.
 */
export function lastBoxLine(text: string): number {
  const lines = lineBounds(text)
  const last = lines.length - 1
  const lastLine = lines[last] as LineBounds
  if (last > 0 && lastLine.start === lastLine.end && lines.some((l) => l.end > l.start)) return last - 1
  return last
}

function setHeadingOfLines(text: string, fmt: TextFormatting, level: number, first: number, last: number): TextFormatting {
  const headings = Array.from({ length: paragraphCount(text) }, (_, i) => (i >= first && i <= last ? level : (fmt.headings?.[i] ?? 0)))
  return withStyles(text, fmt, canonicalHeadings(text, headings), styledCharacters(text, fmt.spans))
}

/** What the formatting controls show for a range, a caret or a whole box. */
export interface RangeFormat {
  marks: Record<Mark, MarkState>
  /** The heading level (0: body text) of every line concerned, or 'mixed'. */
  heading: number | 'mixed'
  /** Every character concerned is on a heading line (for a caret: its line is a heading), so bold is the heading's own and cannot be changed. */
  boldFromHeading: boolean
}

const markStates = (state: (m: Mark) => MarkState): Record<Mark, MarkState> => ({ bold: state('bold'), italic: state('italic'), underline: state('underline'), strike: state('strike') })

/** The state of a non-empty range: each mark on, off or mixed over its characters (off when it has none), and the level of the lines it touches. */
export function formatOfRange(text: string, fmt: TextFormatting, start: number, end: number): RangeFormat {
  const { first, last } = linesOfRange(text, start, end)
  return formatOf(text, fmt, start, end, first, last)
}

/** The state of the whole text: all of its characters, and every line but an empty last one (see `lastBoxLine`). */
export function formatOfText(text: string, fmt: TextFormatting): RangeFormat {
  return formatOf(text, fmt, 0, text.length, 0, lastBoxLine(text))
}

function formatOf(text: string, fmt: TextFormatting, start: number, end: number, first: number, last: number): RangeFormat {
  const hit = styledCharacters(text, fmt.spans).filter((c) => overlaps(c, start, end))
  const onHeading = (c: StyledCharacter) => isHeadingLine(fmt.headings, c.line)
  const marks = markStates((m) => {
    const n = hit.filter((c) => (c.mask & BIT[m]) !== 0 || (m === 'bold' && onHeading(c))).length
    return n === 0 ? 'off' : n === hit.length ? 'on' : 'mixed'
  })
  const levels = new Set<number>()
  for (let i = first; i <= last; i++) levels.add(fmt.headings?.[i] ?? 0)
  return { marks, heading: levels.size === 1 ? ([...levels][0] as number) : 'mixed', boldFromHeading: hit.length > 0 && hit.every(onHeading) }
}

/** The neighbouring character whose style Fabric normally copies (ITextBehavior.mjs `insertCharStyleObject`). */
function characterAtCaret(text: string, fmt: TextFormatting, caret: number): StyledCharacter | undefined {
  const line = lineAt(lineBounds(text), caret)
  const chars = styledCharacters(text, fmt.spans).filter((c) => c.line === line)
  return chars.find((c) => c.end === caret) ?? chars.find((c) => c.start === caret)
}

export function fontAtCaret(text: string, fmt: TextFormatting, caret: number): FontId {
  if (!fmt.spans?.some((span) => span.font)) return fmt.font ?? DEFAULT_FONT
  return characterAtCaret(text, fmt, caret)?.font ?? fmt.font ?? DEFAULT_FONT
}

/** The neighbouring character's marks, with bold implied on a heading line. */
export function marksAtCaret(text: string, fmt: TextFormatting, caret: number): Record<Mark, boolean> {
  const mask = characterAtCaret(text, fmt, caret)?.mask ?? 0
  return {
    bold: caretOnHeading(text, fmt, caret) || (mask & BIT.bold) !== 0,
    italic: (mask & BIT.italic) !== 0,
    underline: (mask & BIT.underline) !== 0,
    strike: (mask & BIT.strike) !== 0,
  }
}

/** What the controls show for a caret: the marks the next typed character will have, pending choices included. */
export function formatAtCaret(text: string, fmt: TextFormatting, caret: number, pending: PendingMarks = {}): RangeFormat {
  const natural = marksAtCaret(text, fmt, caret)
  const heading = fmt.headings?.[lineAt(lineBounds(text), caret)] ?? 0
  const marks = markStates((m) => ((m === 'bold' && heading > 0) || (pending[m] ?? natural[m]) ? 'on' : 'off'))
  return { marks, heading, boldFromHeading: heading > 0 }
}

/**
 * Toggles a pending mark at a caret: the next typed character gets the opposite of what the
 * controls show now. A choice that matches what typing would give anyway is dropped, and bold
 * on a heading line cannot be changed. Returns the new pending marks ({}: none).
 */
export function togglePendingMark(text: string, fmt: TextFormatting, caret: number, pending: PendingTextStyle, mark: Mark): PendingTextStyle {
  if (mark === 'bold' && caretOnHeading(text, fmt, caret)) return pending
  const natural = marksAtCaret(text, fmt, caret)
  const want = !(pending[mark] ?? natural[mark])
  const next = { ...pending }
  if (want === natural[mark]) delete next[mark]
  else next[mark] = want
  return next
}

/** The caret's line is a heading line, where bold is the heading's own and cannot be chosen. */
const caretOnHeading = (text: string, fmt: TextFormatting, caret: number) => isHeadingLine(fmt.headings, lineAt(lineBounds(text), caret))

/**
 * The pending marks that may stand at a caret: on a heading line a pending bold (on or off) is
 * dropped, because a heading line is always bold; every other pending mark is kept as it is.
 * Returns `pending` itself when nothing is dropped.
 */
export function pendingMarksAt(text: string, fmt: TextFormatting, caret: number, pending: PendingTextStyle): PendingTextStyle {
  if (pending.bold === undefined || !caretOnHeading(text, fmt, caret)) return pending
  const { bold: _dropped, ...rest } = pending
  void _dropped
  return rest
}

/** A typed character's marks (a mask, see `markMask`) with the pending choices applied. */
export function withPendingMarks(mask: number, pending: PendingMarks): number {
  let out = mask
  for (const m of MARKS) {
    if (pending[m] === true) out |= BIT[m]
    else if (pending[m] === false) out &= ~BIT[m]
  }
  return out
}

// ---- typing shortcuts ---------------------------------------------------------------------
//
// While a text is typed into, `# `, `## `, `### ` at the very start of a line make it a
// heading, and a closing `**` or `*` makes the text since the opening marker bold or italic.
// The markers are removed: they are a faster way to press the same buttons, never stored.
// Whether a character was typed (rather than pasted, dropped or composed) is the editor's to
// decide; this only looks at the text, and only at the caret's line.

/** Characters, besides whitespace, after which an opening `*` or `**` starts a word. */
const OPENERS = '([{"\'“‘«'
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)

/** True when the character at `i` is a whole user-perceived character (a mark or emoji modifier after it would join it). */
function ownCharacter(text: string, i: number): boolean {
  const from = Math.max(0, i - 2)
  let o = from
  for (const g of splitGraphemes(text.slice(from, i + 3))) {
    if (o === i) return g.length === 1
    if (o > i) return false
    o += g.length
  }
  return false
}

export interface TextRange {
  start: number
  end: number
}

/** A typing shortcut that fires. Offsets are UTF-16, into the text after the typed character. */
export interface TypingShortcut {
  kind: 'heading' | 'bold' | 'italic'
  /** The caret's line (its break excluded). */
  line: TextRange
  /** Heading only: the level `#`, `##` or `###` gives. */
  level?: HeadingLevel
  /** The markers to remove, in order: the `#`s with the typed space, or the opening and the closing `*`/`**`. */
  remove: TextRange[]
  /** What gets the formatting: the text between the markers, or for a heading the rest of the line. */
  content: TextRange
}

/**
 * The typing shortcut that `inserted`, just typed so that the caret is now at `caret`,
 * completes in `text`, or null. Only a space or a `*` can complete one:
 * - a space right after `#`, `##` or `###` that start a line: that line becomes a heading
 *   (`####`, a `#` after anything else, or a space that is not straight after the marker
 *   do nothing);
 * - a `*` completing a closing `**` (bold) or `*` (italic) when there is an opening marker of
 *   the same kind earlier on the line, with marked text between them that is not empty, has
 *   no whitespace just inside either marker and contains no `*`. The opening marker must start
 *   a word (start of the line, or after whitespace or an opening bracket or quote) and neither
 *   marker may touch another `*`: so `2 * 3 * 4`, `a ** b`, `snake*case*`, `***x***` stay as
 *   they are, and nothing fires at the first `*` of a closing `**`.
 * Every marker character must be a character of its own (not joined to a following mark).
 * Looks at the caret's line only.
 */
export function matchTypingShortcut(text: string, caret: number, inserted: string): TypingShortcut | null {
  if ((inserted !== ' ' && inserted !== '*') || caret < 1 || caret > text.length || text[caret - 1] !== inserted) return null
  const lineEndFrom = (from: number) => {
    let end = text.indexOf('\n', from)
    if (end < 0) return text.length
    if (end > from && text[end - 1] === '\r') end--
    return end
  }
  if (inserted === ' ') {
    const space = caret - 1
    const start = space === 0 ? 0 : text.lastIndexOf('\n', space - 1) + 1
    const hashes = space - start
    if (hashes < 1 || hashes > 3) return null
    for (let i = start; i < space; i++) if (text[i] !== '#') return null
    if (!ownCharacter(text, space)) return null
    const end = lineEndFrom(caret)
    return { kind: 'heading', line: { start, end }, level: hashes as HeadingLevel, remove: [{ start, end: caret }], content: { start: caret, end } }
  }
  if (text[caret] === '*') return null // the closing marker would touch another `*`
  const n = text[caret - 2] === '*' ? 2 : 1
  const close = caret - n
  // The opening marker is the nearest `*` before the marked text, on the same line.
  let j = close - 1
  while (j >= 0 && text[j] !== '*' && text[j] !== '\n') j--
  if (j < 0 || text[j] !== '*') return null
  const content = { start: j + 1, end: close }
  if (content.start >= content.end || isSpace(text[content.start]) || isSpace(text[content.end - 1])) return null
  const open = j - n + 1
  if (open < 0 || (n === 2 && text[open] !== '*')) return null
  const before = open > 0 ? text[open - 1] : undefined
  if (before !== undefined && !isSpace(before) && !OPENERS.includes(before)) return null // inside a word, or touching another `*`
  for (const i of [open, j, close, caret - 1]) if (!ownCharacter(text, i)) return null
  const start = open === 0 ? 0 : text.lastIndexOf('\n', open - 1) + 1
  return {
    kind: n === 2 ? 'bold' : 'italic',
    line: { start, end: lineEndFrom(caret) },
    remove: [
      { start: open, end: j + 1 },
      { start: close, end: caret },
    ],
    content,
  }
}

/**
 * What a typing shortcut leaves: the text without its markers, the formatting in canonical
 * form (marks and levels of everything else carried over to the shorter text; the marked text
 * bold or italic, which a heading line shows of itself for bold; or the line a heading of the
 * given level, which drops bold marks in it like the Heading control), the caret (after the
 * formatted text, or at the start of the heading's text) and where the formatted text now is.
 */
export function applyTypingShortcut(text: string, fmt: TextFormatting, sc: TypingShortcut): { text: string; fmt: TextFormatting; caret: number; content: TextRange } {
  const removed = sc.remove
  const shift = (o: number) => {
    let out = o
    for (const r of removed) if (r.end <= o) out -= r.end - r.start
    return out
  }
  let next = ''
  let from = 0
  for (const r of removed) {
    next += text.slice(from, r.start)
    from = r.end
  }
  next += text.slice(from)
  const lines = paragraphCount(text)
  const headings = Array.from({ length: lines }, (_, i) => fmt.headings?.[i] ?? 0)
  if (sc.kind === 'heading') headings[paragraphCount(text.slice(0, sc.line.start)) - 1] = sc.level ?? 0
  const bit = sc.kind === 'bold' ? BIT.bold : sc.kind === 'italic' ? BIT.italic : 0
  const styles = new Map<number, CharStyle>() // start of a kept character in the new text -> its style
  for (const c of styledCharacters(text, fmt.spans)) {
    if (removed.some((r) => c.start < r.end && c.end > r.start)) continue
    const inContent = c.start >= sc.content.start && c.end <= sc.content.end
    styles.set(shift(c.start), { mask: inContent ? c.mask | bit : c.mask, font: c.font })
  }
  const canonical = canonicalHeadings(next, headings)
  const spans = spansFromCharStyles(next, canonical, (a) => styles.get(a))
  const out = canonicalTextFormatting(next, { ...fmt, spans, headings: canonical })
  const content = { start: shift(sc.content.start), end: shift(sc.content.end) }
  return { text: next, fmt: out, caret: sc.kind === 'heading' ? sc.line.start : content.end, content }
}
