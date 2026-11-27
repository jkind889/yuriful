import { FabricImage, Rect, Textbox, util } from 'fabric'
import type { FabricObject, TextStyle, TextStyleDeclaration } from 'fabric'
import { clampCrop, storedCrop } from '../model/crop.ts'
import { round, roundPositive } from '../model/doc.ts'
import { DEFAULT_TEXT_COLOR, canonicalHeadings, canonicalTextFormatting, headingFontSize, isHeadingLevel, markMask, spansFromCharStyles, textAfterEdit, withPendingMarks } from '../model/richText.ts'
import type { CharStyle, PendingTextStyle, TextChange, TextFormatting } from '../model/richText.ts'
import type { CropRect, FrameRecord, ImageRecord, ObjectRecord, TextRecord } from '../model/types.ts'
import type { Point, Size } from '../model/viewport.ts'
import { DrawnTextbox } from './DrawnTextbox.ts'
import { FONT_STACKS, fontIdOf } from './fonts.ts'

export const ACCENT = '#6c7bf2'
export const TEXT_COLOR = DEFAULT_TEXT_COLOR
export const FRAME_FILL = '#ffffff'
export const FONT_FAMILY = FONT_STACKS.sans

interface Meta {
  id: string
  kind: 'image' | 'text' | 'frame'
  assetId?: string
  /** Content only: the frame that owns it. */
  frameId?: string
  /** Frames only. */
  name?: string
  /** Locked (content and frames). Absent means unlocked. */
  locked?: true
}

/** Fabric objects are plain; our identity lives beside them, not on them. */
const meta = new WeakMap<FabricObject, Meta>()

export const idOf = (obj: FabricObject): string | undefined => meta.get(obj)?.id
export const isFrame = (obj: FabricObject): boolean => meta.get(obj)?.kind === 'frame'
export const ownerOf = (obj: FabricObject): string | undefined => meta.get(obj)?.frameId
export const frameNameOf = (obj: FabricObject): string | undefined => meta.get(obj)?.name

/** Sets or clears the owner of a piece of content. Frames have no owner. */
export function setOwner(obj: FabricObject, frameId: string | undefined) {
  const m = meta.get(obj)
  if (!m || m.kind === 'frame') return
  if (frameId === undefined) delete m.frameId
  else m.frameId = frameId
}

export function setFrameName(obj: FabricObject, name: string) {
  const m = meta.get(obj)
  if (m?.kind === 'frame') m.name = name
}

export const isLocked = (obj: FabricObject): boolean => meta.get(obj)?.locked === true

/**
 * The Fabric flags of a locked or an unlocked object of the given kind: the only place
 * they are decided, used when an object is created and when it is locked or unlocked, so
 * that unlocking restores exactly what creation set (a frame keeps `lockRotation`).
 *
 * A locked object is not a target (`evented`: presses, hovering, Alt-presses and
 * double-clicks fall through to what is beneath), is not taken by a marquee or Shift-click
 * (`selectable`), shows no handles, and cannot be moved, scaled, rotated or text-edited.
 */
function applyLockFlags(obj: FabricObject, kind: Meta['kind'], locked: boolean) {
  obj.set({
    evented: !locked,
    selectable: !locked,
    hasControls: !locked,
    lockMovementX: locked,
    lockMovementY: locked,
    lockScalingX: locked,
    lockScalingY: locked,
    lockRotation: locked || kind === 'frame',
  })
  if (obj instanceof Textbox) obj.set({ editable: !locked })
}

/** Locks or unlocks an object or frame (identity and flags). Changes nothing else: not its place, size, order or owner. */
export function setLocked(obj: FabricObject, locked: boolean) {
  const m = meta.get(obj)
  if (!m) return
  if (locked) m.locked = true
  else delete m.locked
  applyLockFlags(obj, m.kind, locked)
  obj.setCoords()
}

export { newId } from '../model/id.ts'

const SELECTION_STYLE = {
  originX: 'left',
  originY: 'top',
  borderColor: ACCENT,
  cornerColor: '#ffffff',
  cornerStrokeColor: ACCENT,
  cornerStyle: 'rect',
  cornerSize: 9,
  transparentCorners: false,
  borderScaleFactor: 1.5,
  lockScalingFlip: true,
  padding: 2,
  // Fabric's default stroke width of 1 is part of an object's transformed size,
  // which would make center<->top-left conversion drift by half a pixel per round trip.
  strokeWidth: 0,
} as const

/** `{ locked: true }` when set, else nothing: never an explicit `false` or `undefined`. */
const lockMeta = (rec: { locked?: true }): { locked?: true } => (rec.locked === true ? { locked: true } : {})

export function createObject(rec: ObjectRecord, getImage: (assetId: string) => HTMLImageElement | undefined): FabricObject | null {
  if (rec.type === 'image') {
    const el = getImage(rec.assetId)
    if (!el) return null
    // A stored crop that reaches outside the decoded image is clamped to it; if nothing is
    // left, the image is shown whole (at the same top-left and scale).
    const crop = clampCrop(rec.crop, { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height })
    const img = new FabricImage(el, {
      ...SELECTION_STYLE,
      left: rec.left,
      top: rec.top,
      angle: rec.angle,
      scaleX: rec.scaleX,
      scaleY: rec.scaleY,
      ...(crop && { cropX: crop.x, cropY: crop.y, width: crop.width, height: crop.height }),
    })
    // Images keep their aspect ratio: corner handles only.
    img.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false })
    meta.set(img, { id: rec.id, kind: 'image', assetId: rec.assetId, ...(rec.frameId !== undefined && { frameId: rec.frameId }), ...lockMeta(rec) })
    applyLockFlags(img, 'image', rec.locked === true)
    return img
  }
  const textOptions = {
    ...SELECTION_STYLE,
    left: rec.left,
    top: rec.top,
    angle: rec.angle,
    width: rec.width,
    fontSize: rec.fontSize,
    fontFamily: FONT_FAMILY,
    fill: TEXT_COLOR,
    lineHeight: 1.25,
  }
  const tb = rec.minHeight === undefined ? new Textbox(rec.text, textOptions) : new DrawnTextbox('', textOptions, rec.minHeight)
  // A drawn box's first text measurement must see its stored fonts and heading sizes.
  // Measuring the words with defaults first could enlarge the saved width on load.
  tb.text = rec.text
  writeTextFormatting(tb, rec)
  tb.setControlsVisibility({ mt: false, mb: false })
  meta.set(tb, { id: rec.id, kind: 'text', ...(rec.frameId !== undefined && { frameId: rec.frameId }), ...lockMeta(rec) })
  applyLockFlags(tb, 'text', rec.locked === true)
  return tb
}

// ---- text formatting on the canvas ----------------------------------------------------------
//
// Fabric keeps per-character styles in `styles[line][char]`, where `line` is a paragraph of
// the text (split on line breaks, NOT the wrapped line the box draws) and `char` is the index
// of a grapheme within it (fabric 7.4.0: Text.mjs `_splitTextIntoLines`, Textbox.mjs
// `_generateStyleMap` / `_getStyleDeclaration`). A record's spans use UTF-16 offsets into the
// whole text; the two are converted here, using Fabric's own grapheme splitting.

interface Line {
  /** UTF-16 offset of the paragraph's first character. */
  start: number
  graphemes: string[]
}

/**
 * The text's paragraphs exactly as Fabric splits them for styles (on /\r?\n/). Known limit
 * (see `paragraphsOf`): a lone "\r" is a character here, but the editing textarea turns it
 * into a line break on the first keystroke, so the marks after it move down a line. Only a
 * hand-made stored board can hold one.
 */
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

/**
 * The per-character styles that draw `fmt` on this text at base size `base`. A heading line
 * gives every character its heading size and bold; an EMPTY heading line keeps one
 * placeholder entry at character 0, because Fabric takes an empty line's height from it
 * (Text.mjs `getHeightOfLineImpl`) and gives it to the first character typed there
 * (ITextBehavior.mjs `insertCharStyleObject`).
 */
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

/**
 * A paragraph's heading level from the font size of its first character (or placeholder).
 * Exact: every heading size on the canvas was written by `stylesFor` as
 * `headingFontSize(tb.fontSize, level)` from the same base it is read against (anything that
 * changes the base goes through `setTextFontSize`, which redraws the headings), and sizes
 * that arrive with a paste or a drop are never read here: they are judged by the carried
 * levels instead (see `readTextFormatting`).
 */
function levelOf(size: unknown, base: number): number {
  for (const level of [1, 2, 3] as const) if (size === headingFontSize(base, level)) return level
  return 0 // a size that matches no heading is not a heading
}

const BOLD = markMask({ bold: true })
const marksOf = (st: TextStyleDeclaration): number =>
  markMask({ bold: st.fontWeight === 'bold' || st.fontWeight === 700, italic: st.fontStyle === 'italic', underline: st.underline === true, strike: st.linethrough === true })

/**
 * The last canonical state of each text: what the editor last wrote onto the canvas object,
 * or read back from it while its text was unchanged. A text change is judged against it
 * (the levels of the lines are carried over from it, see `readTextFormatting`), and the
 * rewrite after a change restores the wrap width it records (see `reconcileTextFormatting`).
 *
 * Refreshed by every write (`createObject` through `writeTextFormatting`, `setTextFontSize`
 * and so scale folding and the font size field, `reconcileTextFormatting` after every text
 * change) and by every `toRecord` of a text whose text has not changed since. The last one
 * is how a width set with a side handle is picked up: every transform ends in a commit that
 * reads the whole scene, and a cancelled one rebuilds the objects from records.
 */
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

/**
 * The caret (the end of the selection) as a UTF-16 offset into the text, or undefined when
 * the object has none. Fabric counts graphemes, with one per line break (ITextBehavior.mjs
 * `fromStringToGraphemeSelection`; Text.mjs `_splitTextIntoLines` joins the lines' graphemes
 * with one "\n").
 */
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
/** The inverse of `graphemeToOffset`: Fabric's grapheme index of a UTF-16 offset (an offset inside a character counts as before it). */
function offsetToGrapheme(tb: Textbox, offset: number): number {
  let g = 0
  for (const line of linesOf(tb)) {
    let o = line.start
    for (const ch of line.graphemes) {
      if (o + ch.length > offset) return g
      o += ch.length
      g++
    }
    if (o >= offset) return g
    g++ // the line break
  }
  return Math.max(0, g - 1)
}

/**
 * The selected characters of a text as UTF-16 offsets [start, end) into its text (equal for
 * a caret), or undefined when the object has no selection. Converted from Fabric's grapheme
 * indices like the caret (see `caretOffset`).
 */
export function selectedRange(tb: Textbox): { start: number; end: number } | undefined {
  const a = graphemeToOffset(tb, tb.selectionStart)
  const b = graphemeToOffset(tb, tb.selectionEnd)
  if (a === undefined || b === undefined) return undefined
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/**
 * The text's formatting, already in canonical form, read from the canvas object.
 *
 * Outside a text change, while its text is the one last made canonical, everything comes
 * from the Fabric object alone (Fabric is the live source of truth while a text is edited):
 * marks from the characters' styles, a line's level from the size of its first character
 * or placeholder.
 *
 * After a text change whose styles have not been rewritten yet (`change`, from
 * `text:changed`; or a text that differs from the last canonical one, as in a scene read
 * that Fabric triggers in the middle of a drop), the character styles may be whatever the
 * change brought: a paste or a drop carries the source's complete styles, sizes included,
 * even when the text it leaves is the same as before (a word pasted over the same word).
 * Then only the marks are read from the styles, and each line's level is carried over from
 * the last canonical state (`textAfterEdit`; an unchanged text keeps its levels by position).
 * A text with no remembered state has nothing to carry over: its levels are read from the sizes.
 * The bold of a heading is never a mark of its own: it is dropped from a character that
 * was on a heading line and is now on a normal one, and from an inserted character on a
 * normal line whose style is a copy of a heading character's (Fabric copies the
 * neighbouring character's style onto what is typed or pasted without styles of its own;
 * styles brought by a paste or drop are complete declarations, including fill). Only
 * local font overrides are read from character styles, so pasted or dropped text still
 * takes its font from the destination. `change.caret` (UTF-16, after the change) picks the
 * alignment among repeated characters. Inserted characters get any pending marks and font.
 */
export function readTextFormatting(tb: Textbox, change?: { caret: number | undefined; pending?: PendingTextStyle; seen?: (edit: TextEdit) => void }): TextFormatting {
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
    change?.seen?.({ text, change: edit.change })
    const headings = edit.headings
    const pending = change?.pending && Object.keys(change.pending).length > 0 ? change.pending : undefined
    for (const [li, line] of linesOf(tb).entries()) {
      const row = tb.styles[li]
      if (!row && !pending) continue // a pending mark can fall on characters without any style
      let start = line.start
      line.graphemes.forEach((g, k) => {
        const end = start + g.length
        const st = row?.[k]
        let mask = st ? marksOf(st) : 0
        const complete = st?.fill !== undefined
        let font = !complete && st?.fontFamily !== undefined ? fontIdOf(st.fontFamily) : undefined
        if (st && mask & BOLD && (headings?.[li] ?? 0) === 0) {
          // A character that was on a heading line, or one whose style is a copy of a heading
          // character's (a size and no fill). The second also covers a character the
          // diff counts as untouched although Fabric replaced its style: the line break after
          // a heading replaced by Enter leaves the same text, with the heading style copied
          // onto the first character of the next line. Safe, because the canonical styles never
          // give a character on a normal line a size of its own.
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

/** A text change as `reconcileTextFormatting` worked it out: the text after it, and where it differs from the last canonical text. */
export interface TextEdit {
  text: string
  change: TextChange
}

/** Writes a text's formatting (font, alignment, colour, marks, headings) onto its canvas object. */
export function writeTextFormatting(tb: Textbox, fmt: TextFormatting) {
  tb.set({
    fontFamily: FONT_STACKS[fmt.font ?? 'sans'],
    textAlign: fmt.align ?? 'left',
    fill: fmt.color ?? TEXT_COLOR,
    styles: stylesFor(tb, fmt, tb.fontSize),
  })
  remember(tb, canonicalHeadings(tb.text, fmt.headings))
}

/** The point of a box that stays put when it changes size: its alignment edge (Fabric's typing keeps it the same way). */
const alignAnchor = (tb: Textbox) => (tb.textAlign === 'center' ? 'center' : tb.textAlign === 'right' ? 'right' : 'left')

/**
 * The one path by which a formatting command changes a text: its canonical formatting is
 * read, changed by `change` (a pure function of `src/model/richText.ts`), made canonical and
 * written back with `writeTextFormatting`, which also refreshes the remembered canonical
 * state. Returns false, touching nothing, when the formatting stays the same.
 *
 * The text, the caret and the selected range are not touched, so an edit goes on as before.
 * If the box changes size (a wider font, a heading whose longest word does not fit), its
 * alignment edge stays where it is, as when typing; a change of alignment keeps the box
 * where it is and moves the text inside it.
 */
export function applyTextFormatting(tb: Textbox, change: (fmt: TextFormatting, text: string) => TextFormatting): boolean {
  const before = readTextFormatting(tb)
  const after = canonicalTextFormatting(tb.text, { ...change(before, tb.text) })
  if (JSON.stringify(after) === JSON.stringify(before)) return false // both canonical: keys and spans in a fixed order
  const anchorX = alignAnchor(tb)
  const pos = tb.getPositionByOrigin(anchorX, 'top')
  writeTextFormatting(tb, after)
  tb.setPositionByOrigin(pos, anchorX, 'top')
  tb.setCoords()
  return true
}

/**
 * Replaces the text of a text being edited and its formatting in one step (a typing shortcut
 * removing its markers, or putting them back), and puts the caret at `caret` (UTF-16). The
 * formatting goes through `writeTextFormatting`, so the remembered canonical state is the new
 * one, and the box keeps its alignment edge in place, as when typing.
 *
 * Fabric's own state is kept in agreement, because its next keystroke compares its hidden
 * textarea with the object (fabric 7.4.0, ITextKeyBehavior.mjs `onInput` diffs the
 * textarea's value and selection against `_text` and `selectionStart`/`selectionEnd`, and
 * `updateFromTextArea` then takes the textarea's value as the text): the text is laid out
 * again (`initDimensions`, through the styles that `writeTextFormatting` sets, splits it into
 * `_text`), the grapheme selection is set directly (its setters would fire
 * `text:selection:changed`), and the textarea gets the same value and, through Fabric's
 * `_updateTextarea`, the same selection. Nothing is changed during an IME composition: the
 * caller never calls this then.
 */
export function replaceEditedText(tb: Textbox, text: string, fmt: TextFormatting, caret: number) {
  const anchorX = alignAnchor(tb)
  const pos = tb.getPositionByOrigin(anchorX, 'top')
  tb.text = text
  writeTextFormatting(tb, fmt) // `styles` is a layout property: Fabric lays the new text out here
  const g = offsetToGrapheme(tb, caret)
  tb.selectionStart = g
  tb.selectionEnd = g
  const textarea = tb.hiddenTextarea
  if (textarea) {
    textarea.value = text
    tb._updateTextarea()
  }
  tb.setPositionByOrigin(pos, anchorX, 'top')
  tb.setCoords()
}

/** Changes a text's base size; its headings keep their ratio to it. No limit of its own. */
export function setTextFontSize(tb: Textbox, fontSize: number, patch: { width?: number; scaleX?: number; scaleY?: number } = {}) {
  const fmt = readTextFormatting(tb)
  tb.set({ ...patch, fontSize, styles: stylesFor(tb, fmt, fontSize) })
  remember(tb, fmt.headings)
}

/** Plain value equality of two style tables, ignoring empty rows and entries. */
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

/**
 * After the text changed while being edited, Fabric has shifted and copied character styles
 * itself (typing after a bold character stays bold; Enter copies the style onto the new
 * line; Backspace over a line break can leave one paragraph with two sizes; a paste brings
 * the source's sizes, colour and font). This works out the canonical formatting (marks from
 * the styles, levels carried over from before the change, see `readTextFormatting`) and
 * redraws the text from it whenever the two differ, so what the canvas shows is always what
 * its record says, and remembers the result as the text's canonical state. The text and
 * the caret are not touched; like Fabric's own typing, the box keeps its alignment edge in
 * place if its size changes. `pending`: marks chosen with only a caret, given to what the
 * change inserted (see `readTextFormatting`). `seen` is told how the text changed (the one
 * diff this works out), when there is a remembered state to compare with.
 */
export function reconcileTextFormatting(tb: Textbox, pending?: PendingTextStyle, seen?: (edit: TextEdit) => void): boolean {
  const known = lastCanonical.get(tb)
  const fmt = readTextFormatting(tb, { caret: caretOffset(tb), pending, seen })
  const want = stylesFor(tb, fmt, tb.fontSize)
  let changed = false
  if (!sameStyles(tb.styles, want)) {
    const anchorX = tb.textAlign === 'center' ? 'center' : tb.textAlign === 'right' ? 'right' : 'left'
    const pos = tb.getPositionByOrigin(anchorX, 'top')
    // Fabric laid the changed text out with the styles it had before this rewrite (heading
    // characters joined onto a normal line, a pasted 48 px word) and widened the box if a
    // word did not fit; a text box never narrows by itself (Textbox.mjs `initDimensions`).
    // Start again from the width the text had before the change and let Fabric widen it
    // only as far as the canonical text needs. A remembered width that is larger than the
    // box, or taken at another base size, is not from before this change: it is not used.
    const width = known && known.fontSize === tb.fontSize && known.width < tb.width ? known.width : tb.width
    tb.set({ styles: want, width })
    tb.setPositionByOrigin(pos, anchorX, 'top')
    tb.setCoords()
    changed = true
  }
  remember(tb, fmt.headings)
  return changed
}

/**
 * A frame is an unrotated white rectangle that sits behind all content. Its outline
 * and label are drawn over the canvas separately (in screen pixels), so the rectangle
 * itself has no stroke and its size is exactly the frame's size.
 */
export function createFrame(rec: FrameRecord): FabricObject {
  const rect = new Rect({
    ...SELECTION_STYLE,
    padding: 0,
    left: rec.left,
    top: rec.top,
    width: rec.width,
    height: rec.height,
    fill: FRAME_FILL,
    lockRotation: true,
    lockSkewingX: true,
    lockSkewingY: true,
    objectCaching: false,
  })
  rect.setControlsVisibility({ mtr: false })
  meta.set(rect, { id: rec.id, kind: 'frame', name: rec.name, ...lockMeta(rec) })
  applyLockFlags(rect, 'frame', rec.locked === true)
  return rect
}

function rotate(x: number, y: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [x * c - y * s, x * s + y * c]
}

/**
 * The object's centre in scene coordinates, whether or not it is inside a multi-selection.
 * This is the point the ownership rules test against a frame, and it is the centre of the
 * object's box for every kind of object: for a text, the centre of its wrap box (its
 * width is the wrapping width, not the width of what is typed).
 */
export function centerOf(obj: FabricObject): Point {
  const d = util.qrDecompose(obj.calcTransformMatrix())
  return { x: d.translateX, y: d.translateY }
}

/**
 * Reads a content object's absolute state. Goes through the full transform matrix so
 * objects that are members of a multi-selection (whose own left/top are
 * relative to the selection) serialize to scene coordinates. Returns null for frames.
 *
 * Nothing is clamped here: a value is whatever the canvas shows. Quantities that must
 * be positive are rounded so that they can never become zero.
 */
export function toRecord(obj: FabricObject): ObjectRecord | null {
  const m = meta.get(obj)
  if (!m || m.kind === 'frame') return null
  const d = util.qrDecompose(obj.calcTransformMatrix())
  const sx = Math.abs(d.scaleX)
  const sy = Math.abs(d.scaleY)
  // translateX/Y is the object's centre; convert to its (unrotated) top-left.
  const [ox, oy] = rotate((obj.width * sx) / 2, (obj.height * sy) / 2, d.angle)
  const base = { id: m.id, left: round(d.translateX - ox), top: round(d.translateY - oy), angle: round(d.angle) }
  const owner = { ...(m.frameId !== undefined && { frameId: m.frameId }), ...lockMeta(m) }
  if (obj instanceof Textbox) {
    const s = (sx + sy) / 2
    const fmt = readTextFormatting(obj)
    // Observed while its text is unchanged: picks up a width set by a side handle since the last write.
    if (lastCanonical.get(obj)?.text === obj.text) remember(obj, fmt.headings)
    const rec: TextRecord = {
      ...base,
      type: 'text',
      text: obj.text,
      fontSize: roundPositive(obj.fontSize * s, 2),
      width: roundPositive(obj.width * sx),
      ...(obj instanceof DrawnTextbox && { minHeight: round(obj.minHeight * sy) }),
      ...fmt,
      ...owner,
    }
    return rec
  }
  if (m.assetId === undefined) return null
  // A fresh object every time: snapshots never share a crop.
  const crop = obj instanceof FabricImage ? imageCropOf(obj) : undefined
  const rec: ImageRecord = {
    ...base,
    type: 'image',
    assetId: m.assetId,
    scaleX: roundPositive(sx, 5),
    scaleY: roundPositive(sy, 5),
    ...(crop && { crop }),
    ...owner,
  }
  return rec
}

export const isImage = (obj: FabricObject | undefined | null): obj is FabricImage => obj instanceof FabricImage

/** The original image's size in source pixels. */
export function imageSizeOf(img: FabricImage): Size {
  return img.getOriginalSize()
}

/**
 * The visible part of the original as it is stored (`storedCrop`: rounded, inside the image),
 * or undefined when that is the whole image. A fresh object.
 */
export function imageCropOf(img: FabricImage): CropRect | undefined {
  return storedCrop({ x: img.cropX, y: img.cropY, width: img.width, height: img.height }, imageSizeOf(img))
}

/**
 * Replace image: the same object (identity, owner, lock, stacking) now shows another decoded
 * picture, whole and uncropped. The caller then crops and places it (see `replaceRecord`).
 */
export function setImageElement(img: FabricImage, assetId: string, el: HTMLImageElement) {
  const m = meta.get(img)
  if (!m || m.kind !== 'image') return
  m.assetId = assetId
  img.setElement(el)
  img.set({ cropX: 0, cropY: 0, dirty: true })
  img.setCoords()
}

/**
 * Shows only `crop` of the original (undefined: all of it). Changes nothing else: the caller
 * places the image (see `model/crop.ts`) so that the kept pixels do not move.
 */
export function setImageCrop(img: FabricImage, crop: CropRect | undefined) {
  const size = imageSizeOf(img)
  const c = crop ?? { x: 0, y: 0, width: size.width, height: size.height }
  img.set({ cropX: c.x, cropY: c.y, width: c.width, height: c.height, dirty: true })
  img.setCoords()
}

/** Reads a frame's absolute rectangle (any scale is folded into its size). Returns null for content. */
export function toFrameRecord(obj: FabricObject): FrameRecord | null {
  const m = meta.get(obj)
  if (!m || m.kind !== 'frame') return null
  const d = util.qrDecompose(obj.calcTransformMatrix())
  const width = obj.width * Math.abs(d.scaleX)
  const height = obj.height * Math.abs(d.scaleY)
  return {
    id: m.id,
    name: m.name ?? '',
    left: round(d.translateX - width / 2),
    top: round(d.translateY - height / 2),
    width: roundPositive(width),
    height: roundPositive(height),
    ...lockMeta(m),
  }
}

/** True when the object's absolute scale (its own times its selection's) is not 1. */
export function hasResidualScale(obj: FabricObject): boolean {
  const d = util.qrDecompose(obj.calcTransformMatrix())
  return Math.abs(Math.abs(d.scaleX) - 1) > 0.001 || Math.abs(Math.abs(d.scaleY) - 1) > 0.001
}

/**
 * Folds any residual scale on a text object into its size, with no limit of its
 * own: limits are decided once per gesture, before this runs. Headings are redrawn at
 * their ratio to the new size.
 */
export function normalizeTextScale(tb: Textbox): boolean {
  const sx = Math.abs(tb.scaleX)
  const sy = Math.abs(tb.scaleY)
  if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return false
  const s = (sx + sy) / 2
  if (tb instanceof DrawnTextbox) tb.minHeight = round(tb.minHeight * sy)
  setTextFontSize(tb, roundPositive(tb.fontSize * s, 2), { width: roundPositive(tb.width * sx, 2), scaleX: 1, scaleY: 1 })
  tb.setCoords()
  return true
}
