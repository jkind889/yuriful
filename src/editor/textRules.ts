import { chainCommands, deleteSelection, joinBackward, joinForward, selectAll, splitBlock } from 'prosemirror-commands'
import { closeHistory, isHistoryTransaction, redo, undo } from 'prosemirror-history'
import { Mark as PMMark } from 'prosemirror-model'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { Command, EditorState, Transaction } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep } from 'prosemirror-transform'
import { MARKS, splitGraphemes } from '../model/richText.ts'
import type { HeadingLevel, Mark, MarkState, PendingTextStyle, RangeFormat } from '../model/richText.ts'
import { blockOf, blockTypeFor, fontOf, levelOf, linesOf, marks, marksOfRun, nodes, textOffsetAt } from './textSchema.ts'
import { blocksToLegacy, legacyToBlocks } from '../model/textDoc.ts'
import type { FontId, InlineRun } from '../model/types.ts'

/**
 * The text rules of Milestone 2, re-expressed on ProseMirror (plan Section 8): typing
 * shortcuts and their pinned literal cases, how a line keeps its heading level through an
 * edit, the canonical form of what is shown (a heading never stores bold), marks and a font
 * chosen with only a caret, and the formatting commands and what the controls show.
 *
 * None of ProseMirror's built-in input rules or paste rules is used: the only text that can
 * turn into formatting is a single character a key typed at the caret (see `textSession.ts`).
 */

/** Transaction metadata. */
export const META = {
  /** The transaction sets line levels itself: `lineLevels` leaves them alone. */
  levelsSet: 'yuriful/levelsSet',
  /** The second transaction of a typing shortcut (it keeps the Backspace revert offer). */
  shortcutApplied: 'yuriful/shortcutApplied',
} as const

// ---- typing shortcuts ------------------------------------------------------------------------

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

export interface LineRange {
  start: number
  end: number
}

/** A typing shortcut that fires. Offsets are UTF-16, into the line after the typed character. */
export interface LineShortcut {
  kind: 'heading' | 'bold' | 'italic'
  /** Heading only: the level `#`, `##` or `###` gives. */
  level?: HeadingLevel
  /** The markers to remove, in order: the `#`s with the typed space, or the opening and the closing `*`/`**`. */
  remove: LineRange[]
  /** What gets the formatting: the text between the markers, or for a heading the rest of the line. */
  content: LineRange
}

/**
 * The typing shortcut that `inserted`, just typed into `line` so that the caret is now at
 * `caret`, completes, or null. Only a space or a `*` can complete one:
 * - a space right after `#`, `##` or `###` that start the line: the line becomes a heading
 *   (`####`, a `#` after anything else, or a space that is not straight after the marker do
 *   nothing);
 * - a `*` completing a closing `**` (bold) or `*` (italic) when there is an opening marker of
 *   the same kind earlier on the line, with marked text between them that is not empty, has
 *   no whitespace just inside either marker and contains no `*`. The opening marker must start
 *   a word (start of the line, or after whitespace or an opening bracket or quote) and neither
 *   marker may touch another `*`: so `2 * 3 * 4`, `a ** b`, `snake*case*`, `***x***` stay as
 *   they are, and nothing fires at the first `*` of a closing `**`.
 * Every marker character must be a character of its own (not joined to a following mark).
 * Pure: the same rule as `matchTypingShortcut` in `richText.ts`, on one line (a block).
 */
export function matchShortcut(line: string, caret: number, inserted: string): LineShortcut | null {
  if ((inserted !== ' ' && inserted !== '*') || caret < 1 || caret > line.length || line[caret - 1] !== inserted) return null
  if (inserted === ' ') {
    const hashes = caret - 1
    if (hashes < 1 || hashes > 3) return null
    for (let i = 0; i < hashes; i++) if (line[i] !== '#') return null
    if (!ownCharacter(line, hashes)) return null
    return { kind: 'heading', level: hashes as HeadingLevel, remove: [{ start: 0, end: caret }], content: { start: caret, end: line.length } }
  }
  if (line[caret] === '*') return null // the closing marker would touch another `*`
  const n = line[caret - 2] === '*' ? 2 : 1
  const close = caret - n
  // The opening marker is the nearest `*` before the marked text.
  let j = close - 1
  while (j >= 0 && line[j] !== '*') j--
  if (j < 0) return null
  const content = { start: j + 1, end: close }
  if (content.start >= content.end || isSpace(line[content.start]) || isSpace(line[content.end - 1])) return null
  const open = j - n + 1
  if (open < 0 || (n === 2 && line[open] !== '*')) return null
  const before = open > 0 ? line[open - 1] : undefined
  if (before !== undefined && !isSpace(before) && !OPENERS.includes(before)) return null // inside a word, or touching another `*`
  for (const i of [open, j, close, caret - 1]) if (!ownCharacter(line, i)) return null
  return {
    kind: n === 2 ? 'bold' : 'italic',
    remove: [
      { start: open, end: j + 1 },
      { start: close, end: caret },
    ],
    content,
  }
}

/** Whether inserting `text` at `from` (nothing replaced) would complete a typing shortcut. */
export function completesShortcut(state: EditorState, from: number, text: string): boolean {
  const $from = state.doc.resolve(from)
  if (!$from.parent.isTextblock) return false
  const line = $from.parent.textContent
  const off = $from.parentOffset
  return matchShortcut(line.slice(0, off) + text + line.slice(off), off + text.length, text) !== null
}

/**
 * The second transaction of a typing shortcut, built on the state just after the typed
 * character went in (the caret right after it): the markers go, the text between them is
 * bold or italic (a heading shows bold of itself, so only the markers go there) or the line
 * becomes a heading, the caret moves after the formatted text (or to the start of the
 * heading's text), and what is typed next is plain through a pending "off". It starts a new
 * history event (`closeHistory`), so the literal characters are one undo step away. Null
 * when no shortcut completes at the caret.
 */
export function shortcutTransaction(state: EditorState, inserted: string): Transaction | null {
  const sel = state.selection
  const $c = sel instanceof TextSelection ? sel.$cursor : null
  if (!$c || !$c.parent.isTextblock) return null
  const sc = matchShortcut($c.parent.textContent, $c.parentOffset, inserted)
  if (!sc) return null
  const base = $c.start()
  const tr = state.tr
  for (const r of [...sc.remove].reverse()) tr.delete(base + r.start, base + r.end)
  const pending = pendingOf(state)
  if (sc.kind === 'heading') {
    const { type, attrs } = blockTypeFor(sc.level ?? 1)
    tr.setNodeMarkup($c.before(), type, attrs)
    tr.setSelection(TextSelection.create(tr.doc, base))
    tr.setMeta(pendingKey, pending) // kept; a pending bold is dropped on the heading line
  } else {
    const shift = sc.remove[0]!.end - sc.remove[0]!.start
    const from = base + sc.content.start - shift
    const to = base + sc.content.end - shift
    const mark = sc.kind
    const headingBold = mark === 'bold' && $c.parent.type === nodes.heading
    if (!headingBold) tr.addMark(from, to, marks[mark].create())
    tr.setSelection(TextSelection.create(tr.doc, to))
    // What is typed next is plain again: a pending "off" (none for bold on a heading line,
    // where it cannot change). The character before the caret now has the mark, so typing
    // would otherwise carry it.
    const style: PendingTextStyle = { ...pending }
    if (headingBold) delete style[mark]
    else style[mark] = false
    tr.setMeta(pendingKey, normalPending(style))
  }
  tr.setMeta(META.levelsSet, true).setMeta(META.shortcutApplied, true)
  return closeHistory(tr)
}

// ---- which part of the document a set of transactions changed ---------------------------------

/**
 * The range of the final document that `trs` changed (inserted or replaced content, and with
 * `withMarks` also marks added or removed), or null when they changed nothing. Everything
 * before `from` and after `to` is the same as before, at the same distance from the end.
 */
export function changedRange(trs: readonly Transaction[], withMarks = false): { from: number; to: number } | null {
  let from = -1
  let to = -1
  for (const tr of trs) {
    for (const step of tr.steps) {
      const map = step.getMap()
      if (from >= 0) {
        from = map.map(from, -1)
        to = map.map(to, 1)
      }
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        from = from < 0 ? newStart : Math.min(from, newStart)
        to = Math.max(to, newEnd)
      })
      if (withMarks && (step instanceof AddMarkStep || step instanceof RemoveMarkStep)) {
        from = from < 0 ? step.from : Math.min(from, step.from)
        to = Math.max(to, step.to)
      }
    }
  }
  return from < 0 ? null : { from, to }
}

// ---- line levels through an edit ------------------------------------------------------------

function lineStarts(lines: readonly string[]): number[] {
  const out: number[] = []
  let at = 0
  for (const l of lines) {
    out.push(at)
    at += l.length + 1
  }
  return out
}

/** The line an offset is on; an offset at a line's end (before its break) is on that line. */
function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] as number) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The heading level each line of `newDoc` should have after an edit changed `range` (of
 * `newDoc`, see `changedRange`) of `oldDoc`: the rule of `textAfterEdit` in `richText.ts`
 * (a heading is a property of a line, carried over by how the text changed), with the
 * change taken from the transaction rather than guessed from the two texts. Returns the
 * levels of the lines the change touched, by line index, or null when the text did not
 * change (a change of marks or of block types alone).
 * - lines the change did not touch keep their level;
 * - when the change leaves the number of lines of the block it touches unchanged, each line
 *   of the block keeps its level by position (an emptied heading line stays a heading);
 * - otherwise the line the change starts in keeps its level, lines the change creates are
 *   normal, and the last line keeps the level of the line its remaining text came from
 *   (Enter at the end of a heading starts a normal line; in the middle or at the start it
 *   leaves two headings; a multi-line paste joins its first line to the line it went into);
 * - joining lines: the joined line keeps the level of the line the change starts in, unless
 *   nothing of that line is left before the change and text of a later line follows it, in
 *   which case it takes that later line's level (a heading joined onto an empty line stays a
 *   heading).
 */
export function levelsAfterEdit(oldDoc: PMNode, newDoc: PMNode, range: { from: number; to: number }): Map<number, number> | null {
  const oldLines = linesOf(oldDoc)
  const newLines = linesOf(newDoc)
  const oldText = oldLines.join('\n')
  const newText = newLines.join('\n')
  const oldTo = range.to - (newDoc.content.size - oldDoc.content.size)
  const rawStart = textOffsetAt(newDoc, range.from, -1)
  const rawNextEnd = Math.max(rawStart, textOffsetAt(newDoc, range.to, 1))
  let start = rawStart
  let prevEnd = Math.max(start, textOffsetAt(oldDoc, oldTo, 1))
  let nextEnd = rawNextEnd
  // The smallest change that explains it: common text at either end of the range is not part of it.
  while (start < prevEnd && start < nextEnd && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++
  while (prevEnd > start && nextEnd > start && oldText.charCodeAt(prevEnd - 1) === newText.charCodeAt(nextEnd - 1)) {
    prevEnd--
    nextEnd--
  }
  if (start === prevEnd && start === nextEnd) return null
  const oldStarts = lineStarts(oldLines)
  const newStarts = lineStarts(newLines)
  const level = (i: number) => levelOf(oldDoc.child(i))
  const ls = lineAt(oldStarts, start)
  const le = lineAt(oldStarts, prevEnd)
  const ne = lineAt(newStarts, nextEnd)
  const out = new Map<number, number>()
  // Lines inside the range that the text change itself does not reach keep their level
  // (ProseMirror may have changed their block type as a side effect, e.g. `splitBlock`).
  const first = lineAt(newStarts, rawStart)
  const last = lineAt(newStarts, rawNextEnd)
  for (let i = first; i < ls; i++) out.set(i, level(i))
  for (let i = ne + 1; i <= last; i++) out.set(i, level(i - ne + le))
  if (le - ls === ne - ls) {
    for (let i = ls; i <= le; i++) out.set(i, level(i))
  } else {
    const restOfLast = (oldStarts[le] as number) + (oldLines[le] as string).length > prevEnd // text of line `le` follows the change
    if (ne === ls) {
      const fromStart = start === oldStarts[ls]
      out.set(ls, fromStart && le > ls && restOfLast ? level(le) : level(ls))
    } else {
      out.set(ls, level(ls))
      for (let i = ls + 1; i < ne; i++) out.set(i, 0) // lines strictly between are new: normal
      out.set(ne, restOfLast ? level(le) : 0)
    }
  }
  return out
}

/** Sets the levels of the given top-level blocks where they differ. True when anything changed. */
function applyLevels(tr: Transaction, levels: ReadonlyMap<number, number>): boolean {
  let changed = false
  // Changing a block's type keeps every position, so the offsets of `doc` stay valid.
  const doc = tr.doc
  doc.forEach((block, offset, index) => {
    const want = levels.get(index)
    if (want === undefined || want === levelOf(block)) return
    const { type, attrs } = blockTypeFor(want)
    tr.setNodeMarkup(offset, type, attrs)
    changed = true
  })
  return changed
}

/**
 * After every change of the text that does not set levels itself (typing, Enter, Backspace,
 * Delete, a paste, a drop, a cut, typing over a selection, an IME composition), the lines it
 * touched get the levels `levelsAfterEdit` gives, whatever block types ProseMirror's own
 * commands chose. Undo and redo restore exact earlier states and are left alone.
 */
export function lineLevels(): Plugin {
  return new Plugin({
    key: new PluginKey('yuriful-line-levels'),
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((t) => t.docChanged)) return null
      if (trs.some((t) => t.getMeta(META.levelsSet) === true || isHistoryTransaction(t))) return null
      const range = changedRange(trs)
      if (!range) return null
      const levels = levelsAfterEdit(oldState.doc, newState.doc, range)
      if (!levels) return null
      const tr = newState.tr
      return applyLevels(tr, levels) ? tr.setMeta(META.levelsSet, true) : null
    },
  })
}

// ---- canonical form of what is shown ----------------------------------------------------------

const runKey = (run: Partial<Record<Mark, true | undefined>> & { font?: FontId }) => `${MARKS.map((m) => (run[m] ? 1 : 0)).join('')}|${run.font ?? ''}`

/**
 * Makes a block's runs canonical, like loading a record does: a heading stores no bold, a
 * font override equal to the box font is dropped, and a character (grapheme cluster) is
 * never half marked (a half-marked character counts as marked). Only marks change, so no
 * position moves. True when anything changed.
 */
function canonicalizeBlock(tr: Transaction, block: PMNode, contentStart: number, baseFont: FontId): boolean {
  const own = blockOf(block)
  const compact = blocksToLegacy([own], baseFont)
  if (!compact) return false
  const canonical = legacyToBlocks(compact.text, compact, baseFont)[0]
  const runs: readonly InlineRun[] = canonical && (canonical.type === 'paragraph' || canonical.type === 'heading') ? (canonical.content ?? []) : []
  const ownRuns = own.type === 'paragraph' || own.type === 'heading' ? (own.content ?? []) : []
  if (runs.length === ownRuns.length && runs.every((r, i) => r.text === ownRuns[i]!.text && runKey(r) === runKey(ownRuns[i]!))) return false
  let at = contentStart
  for (const run of runs) {
    const end = at + run.text.length
    tr.removeMark(at, end)
    for (const m of marksOfRun(run)) tr.addMark(at, end, m)
    at = end
  }
  return true
}

/**
 * Keeps what is shown in canonical form after every change (plan Section 7's heading-bold
 * guard, plus the rest of the canonical run form of Section 5): the blocks a change touched
 * are made canonical (`canonicalizeBlock`), and stored marks never carry bold while the caret
 * is on a heading line. Skipped while an IME composition is in progress (rewriting marks
 * under it would break it); the change that ends the composition is made canonical.
 */
export function canonicalGuard(opts: { baseFont: () => FontId; composing?: () => boolean }): Plugin {
  return new Plugin({
    key: new PluginKey('yuriful-canonical'),
    appendTransaction(trs, _oldState, state) {
      if (opts.composing?.()) return null
      const tr = state.tr
      let changed = false
      const range = trs.some((t) => t.docChanged) ? changedRange(trs, true) : null
      if (range) {
        const baseFont = opts.baseFont()
        state.doc.forEach((block, offset) => {
          if (offset + block.nodeSize < range.from || offset > range.to) return
          if (canonicalizeBlock(tr, block, offset + 1, baseFont)) changed = true
        })
      }
      const sel = state.selection
      const $c = sel instanceof TextSelection ? sel.$cursor : null
      if (!changed && $c && $c.parent.type === nodes.heading && state.storedMarks && marks.bold.isInSet(state.storedMarks)) {
        tr.setStoredMarks(marks.bold.removeFromSet(state.storedMarks))
        changed = true
      }
      return changed ? tr : null
    },
  })
}

// ---- marks and a font chosen with only a caret (pending) ----------------------------------------

export type Pending = PendingTextStyle

export const pendingKey = new PluginKey<Pending | null>('yuriful-pending')

/** The pending marks and font of a state (null: none). */
export function pendingOf(state: EditorState): Pending | null {
  return pendingKey.getState(state) ?? null
}

/** `pending` with no choice in it is no pending at all. */
export function normalPending(p: Pending | null | undefined): Pending | null {
  if (!p) return null
  const out: Pending = {}
  for (const m of MARKS) if (p[m] !== undefined) out[m] = p[m]
  if (p.font !== undefined) out.font = p.font
  return Object.keys(out).length > 0 ? out : null
}

const caretOf = (state: EditorState) => {
  const sel = state.selection
  return sel instanceof TextSelection ? sel.$cursor : null
}

const caretOnHeading = (state: EditorState) => caretOf(state)?.parent.type === nodes.heading

/** The marks a character typed now would get: the neighbouring marks with the pending choices applied. */
export function applyPending(natural: readonly PMMark[], p: Pending | null, baseFont: FontId): readonly PMMark[] {
  if (!p) return natural
  let set = natural
  for (const m of MARKS) {
    if (p[m] === true) set = marks[m].create().addToSet(set)
    else if (p[m] === false) set = marks[m].removeFromSet(set)
  }
  if (p.font !== undefined) {
    set = marks.font.removeFromSet(set)
    if (p.font !== baseFont) set = marks.font.create({ font: p.font }).addToSet(set)
  }
  return set
}

const sameMarks = (a: readonly PMMark[] | null, b: readonly PMMark[] | null) => (a === null || b === null ? a === b : PMMark.sameSet(a, b))

/**
 * Marks and a font chosen with only a caret, as today: kept through typing, deleting, Enter,
 * a paste and every step of an IME composition (any change of the text), dropped when the
 * caret or selection moves for any other reason, by in-edit undo and redo, and when the
 * session ends. A pending bold is dropped whenever the caret's line is or becomes a heading
 * (a heading is bold of itself); every other choice stays. Set with `pendingKey` metadata.
 *
 * ProseMirror's stored marks are kept equal to what a typed character would get (the
 * neighbouring marks with the pending choices applied), so typing uses them; they are null
 * when that is just the neighbouring marks.
 */
export function pendingMarks(opts: { baseFont: () => FontId }): Plugin<Pending | null> {
  return new Plugin<Pending | null>({
    key: pendingKey,
    state: {
      init: () => null,
      apply(tr, value, _old, newState) {
        const meta = tr.getMeta(pendingKey) as Pending | null | undefined
        let next = value
        if (meta !== undefined) next = normalPending(meta)
        else if (isHistoryTransaction(tr)) next = null
        else if (tr.selectionSet && !tr.docChanged) next = null
        if (next && next.bold !== undefined && caretOnHeading(newState)) {
          const { bold: _dropped, ...rest } = next
          void _dropped
          next = normalPending(rest)
        }
        if (next && !caretOf(newState)) next = null // a choice belongs to a caret
        return next
      },
    },
    appendTransaction(_trs, _old, state) {
      const $c = caretOf(state)
      let want: readonly PMMark[] | null = null
      if ($c) {
        const natural = $c.marks()
        let set = applyPending(natural, pendingOf(state), opts.baseFont())
        if ($c.parent.type === nodes.heading) set = marks.bold.removeFromSet(set)
        want = PMMark.sameSet(set, natural) ? null : set
      }
      return sameMarks(state.storedMarks, want) ? null : state.tr.setStoredMarks(want)
    },
  })
}

// ---- what the formatting controls show, and the formatting commands --------------------------------

/** What the controls show for a range, a caret or a whole box. */
export interface FormatReadout extends RangeFormat {
  font: FontId | 'mixed'
}

interface Segment {
  from: number
  to: number
  marks: readonly PMMark[]
  heading: boolean
}

/** A range grown to whole characters (grapheme clusters, the unit marks apply to). */
function wholeCharacters(doc: PMNode, from: number, to: number): { from: number; to: number } {
  if (from >= to) return { from, to }
  const grow = (pos: number, dir: -1 | 1) => {
    const $p = doc.resolve(pos)
    if (!$p.parent.isTextblock) return pos
    const off = $p.parentOffset
    let at = 0
    for (const g of splitGraphemes($p.parent.textContent)) {
      const end = at + g.length
      if (off > at && off < end) return dir < 0 ? pos - (off - at) : pos + (end - off)
      if (end > off) break
      at = end
    }
    return pos
  }
  return { from: grow(from, -1), to: grow(to, 1) }
}

/** The text in a range, as pieces of text nodes with their marks and whether they are on a heading line. */
function segments(doc: PMNode, from: number, to: number): Segment[] {
  const r = wholeCharacters(doc, from, to)
  const out: Segment[] = []
  if (r.from >= r.to) return out
  doc.nodesBetween(r.from, r.to, (node, pos, parent) => {
    if (!node.isText) return true
    const a = Math.max(r.from, pos)
    const b = Math.min(r.to, pos + node.nodeSize)
    if (a < b) out.push({ from: a, to: b, marks: node.marks, heading: parent?.type === nodes.heading })
    return false
  })
  return out
}

/** The index of the top-level block a position is in; a position between blocks counts as the next block, or for `end` the one before. */
function blockIndexAt(doc: PMNode, pos: number, end: boolean): number {
  const $p = doc.resolve(pos)
  const index = $p.index(0)
  if ($p.depth > 0) return index
  return Math.max(0, Math.min(doc.childCount - 1, end ? index - 1 : index))
}

/**
 * The lines (top-level blocks) a selection touches, for a caret its line. A range that ends
 * exactly at the start of a line, just after a line break, does not touch that line.
 */
export function linesOfSelection(doc: PMNode, from: number, to: number): { first: number; last: number } {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const first = blockIndexAt(doc, lo, false)
  let last = blockIndexAt(doc, hi, hi > lo)
  const $hi = doc.resolve(hi)
  if (hi > lo && last > first && $hi.depth > 0 && $hi.parentOffset === 0) last--
  return { first, last: Math.max(first, last) }
}

/** The last line a whole-box heading counts: every line but an empty last one, unless the text has no character at all. */
export function lastBoxLine(doc: PMNode): number {
  const last = doc.childCount - 1
  let any = false
  doc.forEach((b) => {
    if (b.content.size > 0) any = true
  })
  return last > 0 && doc.child(last).content.size === 0 && any ? last - 1 : last
}

function formatOf(doc: PMNode, from: number, to: number, first: number, last: number, baseFont: FontId): FormatReadout {
  const hit = segments(doc, from, to)
  const state = (m: Mark): MarkState => {
    const n = hit.filter((s) => marks[m].isInSet(s.marks) || (m === 'bold' && s.heading)).length
    return n === 0 ? 'off' : n === hit.length ? 'on' : 'mixed'
  }
  const levels = new Set<number>()
  for (let i = first; i <= last; i++) levels.add(levelOf(doc.child(i)))
  const fonts = new Set(hit.map((s) => fontOf(s.marks) ?? baseFont))
  return {
    marks: { bold: state('bold'), italic: state('italic'), underline: state('underline'), strike: state('strike') },
    heading: levels.size === 1 ? ([...levels][0] as number) : 'mixed',
    boldFromHeading: hit.length > 0 && hit.every((s) => s.heading),
    font: fonts.size === 0 ? baseFont : fonts.size === 1 ? ([...fonts][0] as FontId) : 'mixed',
  }
}

/** The state of a non-empty range: each mark on, off or mixed over its characters (off when it has none), the level of the lines it touches, its font. */
export function rangeFormat(doc: PMNode, from: number, to: number, baseFont: FontId): FormatReadout {
  const { first, last } = linesOfSelection(doc, from, to)
  return formatOf(doc, from, to, first, last, baseFont)
}

/** The state of the whole box: all of its characters, and every line but an empty last one (see `lastBoxLine`). */
export function boxFormat(doc: PMNode, baseFont: FontId): FormatReadout {
  return formatOf(doc, 0, doc.content.size, 0, lastBoxLine(doc), baseFont)
}

/** The marks the next character typed at the caret would have without pending choices, with bold implied on a heading line. */
function naturalAtCaret(state: EditorState): Record<Mark, boolean> {
  const $c = caretOf(state)
  const set = $c ? $c.marks() : []
  const heading = $c?.parent.type === nodes.heading
  return {
    bold: heading || marks.bold.isInSet(set) !== undefined,
    italic: marks.italic.isInSet(set) !== undefined,
    underline: marks.underline.isInSet(set) !== undefined,
    strike: marks.strike.isInSet(set) !== undefined,
  }
}

/** What the controls show for a caret: the marks and font the next typed character will have, pending choices included. */
export function caretFormat(state: EditorState, baseFont: FontId): FormatReadout {
  const $c = caretOf(state)
  const pending = pendingOf(state) ?? {}
  const natural = naturalAtCaret(state)
  const heading = $c ? levelOf($c.parent) : 0
  const on = (m: Mark): MarkState => ((m === 'bold' && heading > 0) || (pending[m] ?? natural[m]) ? 'on' : 'off')
  return {
    marks: { bold: on('bold'), italic: on('italic'), underline: on('underline'), strike: on('strike') },
    heading,
    boldFromHeading: heading > 0,
    font: pending.font ?? ($c ? fontOf($c.marks()) : undefined) ?? baseFont,
  }
}

/** What the controls show while editing: a caret's next character, or the selected range. */
export function selectionFormat(state: EditorState, baseFont: FontId): FormatReadout {
  if (caretOf(state)) return caretFormat(state, baseFont)
  const { from, to } = state.selection
  return rangeFormat(state.doc, from, to, baseFont)
}

/**
 * Toggles a pending mark at the caret: the next typed character gets the opposite of what the
 * controls show now. A choice that matches what typing would give anyway is dropped, and bold
 * on a heading line cannot be changed. Returns the new pending choices.
 */
export function togglePendingMark(state: EditorState, mark: Mark): Pending | null {
  const pending = pendingOf(state)
  if (mark === 'bold' && caretOnHeading(state)) return pending
  const natural = naturalAtCaret(state)
  const want = !(pending?.[mark] ?? natural[mark])
  const next: Pending = { ...pending }
  if (want === natural[mark]) delete next[mark]
  else next[mark] = want
  return normalPending(next)
}

/**
 * Toggles a mark on the characters of a range: removed if every one of them already has it,
 * otherwise added to all of them. A character on a heading line counts as bold, and bold is
 * never stored there; so bold over a range that lies entirely in heading lines changes
 * nothing, and over a mixed range it changes the characters on normal lines. A range with no
 * characters changes nothing. True when anything changed.
 */
export function toggleRangeMark(tr: Transaction, from: number, to: number, mark: Mark): boolean {
  const hit = segments(tr.doc, from, to)
  if (hit.length === 0) return false
  const type = marks[mark]
  const has = (s: Segment) => type.isInSet(s.marks) !== undefined || (mark === 'bold' && s.heading)
  const on = !hit.every(has)
  let changed = false
  for (const s of hit) {
    if (mark === 'bold' && s.heading) continue
    const present = type.isInSet(s.marks) !== undefined
    if (on && !present) tr.addMark(s.from, s.to, type.create())
    else if (!on && present) tr.removeMark(s.from, s.to, type)
    else continue
    changed = true
  }
  return changed
}

/** Gives the characters of a range a font (no override where it is the box font). True when anything changed. */
export function setRangeFont(tr: Transaction, from: number, to: number, font: FontId, baseFont: FontId): boolean {
  let changed = false
  for (const s of segments(tr.doc, from, to)) {
    if ((fontOf(s.marks) ?? baseFont) === font) continue
    tr.removeMark(s.from, s.to, marks.font)
    if (font !== baseFont) tr.addMark(s.from, s.to, marks.font.create({ font }))
    changed = true
  }
  return changed
}

/** Sets the level (0: body text) of the lines `first` to `last`. A heading stores no bold, so bold marks in them go (`canonicalGuard`). True when anything changed. */
export function setLinesLevel(tr: Transaction, first: number, last: number, level: number): boolean {
  const levels = new Map<number, number>()
  for (let i = first; i <= last; i++) levels.set(i, level)
  const changed = applyLevels(tr, levels)
  if (changed) tr.setMeta(META.levelsSet, true)
  return changed
}

/**
 * A whole-box heading (a box selected, not being edited): every line but an empty last one
 * (`lastBoxLine`), while body text (0) also clears an empty last line, so that no box control
 * leaves behind a tall empty line that none of them can remove.
 */
export function setBoxLevel(tr: Transaction, level: number): boolean {
  return setLinesLevel(tr, 0, level === 0 ? tr.doc.childCount - 1 : lastBoxLine(tr.doc), level)
}

/** A whole-box mark: on unless every character already has it (bold never changes in heading lines). */
export function toggleBoxMark(tr: Transaction, mark: Mark): boolean {
  return toggleRangeMark(tr, 0, tr.doc.content.size, mark)
}

/** A whole-box font: the box font changes, so every font override goes. True when anything changed. */
export function clearRangeFonts(tr: Transaction): boolean {
  let changed = false
  tr.doc.descendants((node, pos) => {
    if (node.isText && marks.font.isInSet(node.marks)) {
      tr.removeMark(pos, pos + node.nodeSize, marks.font)
      changed = true
    }
  })
  return changed
}

// ---- keys ---------------------------------------------------------------------------------------

/** Backspace inside a line: deletes the whole character (grapheme cluster) before the caret, as the canvas does. */
export const deleteCharBackward: Command = (state, dispatch) => {
  const $c = caretOf(state)
  if (!$c || $c.parentOffset === 0) return false
  const chars = splitGraphemes($c.parent.textBetween(0, $c.parentOffset))
  const last = chars[chars.length - 1] ?? ''
  dispatch?.(state.tr.delete($c.pos - last.length, $c.pos).scrollIntoView())
  return true
}

/** Delete inside a line: deletes the whole character after the caret. */
export const deleteCharForward: Command = (state, dispatch) => {
  const $c = caretOf(state)
  if (!$c || $c.parentOffset === $c.parent.content.size) return false
  const first = splitGraphemes($c.parent.textBetween($c.parentOffset, $c.parent.content.size))[0] ?? ''
  dispatch?.(state.tr.delete($c.pos, $c.pos + first.length).scrollIntoView())
  return true
}

/**
 * The editing keys. Line levels after Enter, Backspace and Delete come from `lineLevels`, not
 * from the block types these commands choose. `Mod-Backspace` and `Mod-Delete` leave word
 * deletion to the browser. Esc, Tab, Ctrl/Cmd+B/I/U and the Backspace revert are handled by
 * the session before these.
 */
export const editKeys: Readonly<Record<string, Command>> = {
  Enter: splitBlock,
  'Shift-Enter': splitBlock,
  Backspace: chainCommands(deleteSelection, joinBackward, deleteCharBackward),
  'Shift-Backspace': chainCommands(deleteSelection, joinBackward, deleteCharBackward),
  Delete: chainCommands(deleteSelection, joinForward, deleteCharForward),
  'Mod-Backspace': chainCommands(deleteSelection, joinBackward),
  'Mod-Delete': chainCommands(deleteSelection, joinForward),
  'Mod-a': selectAll,
  'Mod-z': undo,
  'Shift-Mod-z': redo,
  'Mod-y': redo,
}
