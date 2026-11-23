import { chainCommands, deleteSelection, joinBackward, joinForward, splitBlock } from 'prosemirror-commands'
import { closeHistory, isHistoryTransaction, redo, undo } from 'prosemirror-history'
import { Mark as PMMark } from 'prosemirror-model'
import type { Node as PMNode } from 'prosemirror-model'
import { AllSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { Command, EditorState, Transaction } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep } from 'prosemirror-transform'
import { MARKS, canonicalTextFormatting, headingsAfterEdit, isHeadingLevel, markMask, spansFromCharStyles, splitGraphemes, textAfterEdit, withPendingMarks } from '../model/richText.ts'
import type { CharStyle, HeadingLevel, Mark, MarkState, PendingTextStyle, RangeFormat } from '../model/richText.ts'
import { blockOf, blockTypeFor, fontOf, levelOf, marks, marksOfRun, nodes, plainTextOfDoc, textOffsetAt } from './textSchema.ts'
import { blocksToLegacy, legacyToBlocks } from '../model/textDoc.ts'
import type { FontId, InlineRun, TextSpan } from '../model/types.ts'

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

// ---- which part of the document a set of transactions inserted ------------------------------------

/** The ranges of the final document that `trs` inserted (new or replacing content). */
export function insertedRanges(trs: readonly Transaction[]): Array<{ from: number; to: number }> {
  let out: Array<{ from: number; to: number }> = []
  for (const tr of trs) {
    for (const step of tr.steps) {
      const map = step.getMap()
      out = out.map((r) => ({ from: map.map(r.from, 1), to: map.map(r.to, -1) })).filter((r) => r.to > r.from)
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        if (newEnd > newStart) out.push({ from: newStart, to: newEnd })
      })
    }
  }
  return out
}

// ---- line levels through an edit ------------------------------------------------------------

/** The heading level of every top-level block. */
function levelsOf(doc: PMNode): number[] {
  const out: number[] = []
  doc.forEach((block) => {
    out.push(levelOf(block))
  })
  return out
}

/**
 * The heading level of every line of `newDoc` after a change of the text: exactly today's
 * rule, `headingsAfterEdit` in `richText.ts`, the one authority (a heading is a property of a
 * line, carried over by how the text changed, never guessed from it), given the text and
 * levels before, the text after and `caret`, the UTF-16 offset of the end of the selection
 * after the change (what the canvas reads as its caret).
 */
export function levelsAfterEdit(oldDoc: PMNode, newDoc: PMNode, caret: number): number[] {
  const next = headingsAfterEdit(plainTextOfDoc(oldDoc), levelsOf(oldDoc), plainTextOfDoc(newDoc), caret)
  return Array.from({ length: newDoc.childCount }, (_, i) => next?.[i] ?? 0)
}

/** Sets the level of every top-level block `levelAt` gives a level for, where it differs. True when anything changed. */
function applyLevels(tr: Transaction, levelAt: (index: number) => number | undefined): boolean {
  let changed = false
  // Changing a block's type keeps every position, so the offsets of `doc` stay valid.
  const doc = tr.doc
  doc.forEach((block, offset, index) => {
    const want = levelAt(index)
    if (want === undefined || want === levelOf(block)) return
    const { type, attrs } = blockTypeFor(want)
    tr.setNodeMarkup(offset, type, attrs)
    changed = true
  })
  return changed
}

/**
 * After every change of the text that does not set levels itself (typing, Enter, Backspace,
 * Delete, a paste, a drop, a cut, typing over a selection, an IME composition), every line
 * gets the level `levelsAfterEdit` gives, whatever block types ProseMirror's own commands
 * chose. A change that leaves the text as it was keeps every level. Undo and redo restore
 * exact earlier states and are left alone.
 */
export function lineLevels(): Plugin {
  return new Plugin({
    key: new PluginKey('yuriful-line-levels'),
    appendTransaction(trs, oldState, newState) {
      if (!trs.some((t) => t.docChanged)) return null
      if (trs.some((t) => t.getMeta(META.levelsSet) === true || isHistoryTransaction(t))) return null
      const levels = levelsAfterEdit(oldState.doc, newState.doc, textOffsetAt(newState.doc, newState.selection.to, 1))
      const tr = newState.tr
      return applyLevels(tr, (i) => levels[i]) ? tr.setMeta(META.levelsSet, true) : null
    },
  })
}

// ---- canonical form of what is shown ----------------------------------------------------------

const runKey = (run: Partial<Record<Mark, true | undefined>> & { font?: FontId }) => `${MARKS.map((m) => (run[m] ? 1 : 0)).join('')}|${run.font ?? ''}`

/** The runs of a list of code-unit mark sets over `text`. */
function runsOfUnits(text: string, units: ReadonlyArray<readonly PMMark[]>): InlineRun[] {
  const out: InlineRun[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && PMMark.sameSet(units[i]!, units[start]!)) continue
    const run: InlineRun = { text: text.slice(start, i) }
    for (const m of MARKS) if (marks[m].isInSet(units[start]!)) run[m] = true
    const font = fontOf(units[start]!)
    if (font) run.font = font
    out.push(run)
    start = i
  }
  return out
}

/** Replaces the marks of a block's text with `runs` (same text) where they differ. True when anything changed. */
export function imposeRuns(tr: Transaction, block: PMNode, contentStart: number, runs: readonly InlineRun[]): boolean {
  const current = blockOf(block)
  const ownRuns = current.type === 'paragraph' || current.type === 'heading' ? (current.content ?? []) : []
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
 * Makes a block's runs canonical, like loading a record does: a heading stores no bold, a
 * font override equal to the box font is dropped, and a character (grapheme cluster) is
 * never half marked. A cluster that text was just inserted into (an accent composed onto a
 * letter, a skin tone typed after an emoji) takes the marks of what was inserted, as the
 * canvas gives the whole character the typed character's style and the pending choices;
 * any other half-marked cluster counts as marked. Only marks change, so no position moves.
 * True when anything changed.
 */
function canonicalizeBlock(tr: Transaction, block: PMNode, contentStart: number, baseFont: FontId, inserted: ReadonlyArray<{ from: number; to: number }>): boolean {
  const text = block.textContent
  const units: Array<readonly PMMark[]> = []
  block.forEach((child) => {
    for (let i = 0; i < (child.text ?? '').length; i++) units.push(child.marks)
  })
  let at = 0
  for (const g of splitGraphemes(text)) {
    const end = at + g.length
    if (g.length > 1 && !units.slice(at, end).every((u) => PMMark.sameSet(u, units[at]!))) {
      for (let i = end - 1; i >= at; i--) {
        const pos = contentStart + i
        if (!inserted.some((r) => pos >= r.from && pos < r.to)) continue
        const pick = units[i]!
        for (let k = at; k < end; k++) units[k] = pick
        break
      }
    }
    at = end
  }
  const own = runsOfUnits(text, units)
  const level = levelOf(block)
  const compact = blocksToLegacy([isHeadingLevel(level) ? { type: 'heading', level, content: own } : { type: 'paragraph', content: own }], baseFont)
  if (!compact) return false
  const canonical = legacyToBlocks(compact.text, compact, baseFont)[0]
  const runs: readonly InlineRun[] = canonical && (canonical.type === 'paragraph' || canonical.type === 'heading') ? (canonical.content ?? []) : []
  return imposeRuns(tr, block, contentStart, runs)
}

interface GuardState {
  /** Text inserted during an IME composition, made canonical once the composition has ended. */
  owed: Array<{ from: number; to: number }>
}
const guardKey = new PluginKey<GuardState>('yuriful-canonical')
/** Metadata on an otherwise empty transaction that makes text owed since a composition canonical. */
export const SETTLE = 'yuriful/settle'

/** True when a composition left text that is not canonical yet. */
export function owesCanonical(state: EditorState): boolean {
  return (guardKey.getState(state)?.owed.length ?? 0) > 0
}

/**
 * Keeps what is shown in canonical form after every change (plan Section 7's heading-bold
 * guard, plus the rest of the canonical run form of Section 5): the blocks a change touched
 * are made canonical (`canonicalizeBlock`), and stored marks never carry bold while the caret
 * is on a heading line. While an IME composition is in progress nothing is rewritten under
 * it; what it inserted is remembered and made canonical by the first transaction after it
 * has ended (the session sends one, `SETTLE`), so the live document always equals the record
 * once the composition is over.
 */
export function canonicalGuard(opts: { baseFont: () => FontId; composing?: () => boolean }): Plugin<GuardState> {
  return new Plugin<GuardState>({
    key: guardKey,
    state: {
      init: () => ({ owed: [] }),
      apply(tr, value) {
        if (tr.getMeta(guardKey) === 'clear') return { owed: [] }
        let owed = value.owed
        if (tr.docChanged) owed = owed.map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })).filter((r) => r.to > r.from)
        if (tr.docChanged && opts.composing?.()) owed = [...owed, ...insertedRanges([tr])]
        return owed === value.owed ? value : { owed }
      },
    },
    appendTransaction(trs, _oldState, state) {
      if (opts.composing?.()) return null
      const tr = state.tr
      let changed = false
      const owed = guardKey.getState(state)?.owed ?? []
      const inserted = [...insertedRanges(trs), ...owed]
      let range = trs.some((t) => t.docChanged) ? changedRange(trs, true) : null
      for (const r of owed) range = range ? { from: Math.min(range.from, r.from), to: Math.max(range.to, r.to) } : { ...r }
      if (range) {
        const baseFont = opts.baseFont()
        const { from, to } = range
        state.doc.forEach((block, offset) => {
          if (offset + block.nodeSize < from || offset > to) return
          if (canonicalizeBlock(tr, block, offset + 1, baseFont, inserted)) changed = true
        })
      }
      if (owed.length > 0) {
        tr.setMeta(guardKey, 'clear')
        changed = true
      }
      const sel = state.selection
      const $c = sel instanceof TextSelection ? sel.$cursor : null
      if (!tr.docChanged && $c && $c.parent.type === nodes.heading && state.storedMarks && marks.bold.isInSet(state.storedMarks)) {
        tr.setStoredMarks(marks.bold.removeFromSet(state.storedMarks))
        changed = true
      }
      return changed ? tr : null
    },
  })
}

/** Turns a whole-document selection (`AllSelection`) into the selection of all the text, as the canvas's select-all is. */
export function wholeTextSelection(): Plugin {
  return new Plugin({
    key: new PluginKey('yuriful-whole-text-selection'),
    appendTransaction(_trs, _old, state) {
      if (!(state.selection instanceof AllSelection)) return null
      return state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1))
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
 * caret or selection moves for any other reason and when the session ends. In-edit undo
 * drops them, except that redoing a typing shortcut brings back the choices it left
 * (`afterHistory`: "plain after the shortcut"). A pending bold is dropped once the caret's
 * line is or becomes a heading, judged on the final state of a change (after its lines have
 * their levels); every other choice stays. Set with `pendingKey` metadata.
 *
 * ProseMirror's stored marks are kept equal to what a typed character would get (the
 * neighbouring marks with the pending choices applied), so typing uses them; they are null
 * when that is just the neighbouring marks.
 */
export function pendingMarks(opts: { baseFont: () => FontId; afterHistory?: (doc: PMNode) => Pending | null }): Plugin<Pending | null> {
  return new Plugin<Pending | null>({
    key: pendingKey,
    state: {
      init: () => null,
      apply(tr, value, _old, newState) {
        const meta = tr.getMeta(pendingKey) as Pending | null | undefined
        let next = value
        if (meta !== undefined) next = normalPending(meta)
        else if (isHistoryTransaction(tr)) next = normalPending(opts.afterHistory?.(newState.doc))
        else if (tr.selectionSet && !tr.docChanged) next = null
        if (next && !caretOf(newState)) next = null // a choice belongs to a caret
        return next
      },
    },
    appendTransaction(_trs, _old, state) {
      let pending = pendingOf(state)
      let tr: Transaction | null = null
      if (pending && pending.bold !== undefined && caretOnHeading(state)) {
        const { bold: _dropped, ...rest } = pending
        void _dropped
        pending = normalPending(rest)
        tr = state.tr.setMeta(pendingKey, pending)
      }
      const $c = caretOf(state)
      let want: readonly PMMark[] | null = null
      if ($c) {
        const natural = $c.marks()
        let set = applyPending(natural, pending, opts.baseFont())
        if ($c.parent.type === nodes.heading) set = marks.bold.removeFromSet(set)
        want = PMMark.sameSet(set, natural) ? null : set
      }
      if (!sameMarks(state.storedMarks, want)) tr = (tr ?? state.tr).setStoredMarks(want)
      return tr
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
  const changed = applyLevels(tr, (i) => (i >= first && i <= last ? level : undefined))
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

/** A code point that makes Backspace take the whole emoji sequence it ends (Blink's backspace rule). */
function isEmojiTail(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0
  return (
    /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(ch) ||
    (c >= 0x1f3fb && c <= 0x1f3ff) || // skin tones
    (c >= 0xfe00 && c <= 0xfe0f) || // variation selectors
    c === 0x20e3 || // keycap
    (c >= 0xe0020 && c <= 0xe007f) || // tags
    (c >= 0xe0100 && c <= 0xe01ef) // variation selectors supplement
  )
}

/**
 * How many UTF-16 code units Backspace deletes at the end of `before`, as the canvas does
 * today: its editing textarea takes the key (Chromium's backspace), which deletes one code
 * point (a combining accent, a vowel sign, a Hangul jamo on its own) except that an emoji
 * sequence goes whole (a ZWJ sequence, a skin tone, a flag, a keycap, a variation selector,
 * a tag sequence). Forward Delete takes the whole character instead (`deleteCharForward`).
 */
export function backspaceLength(before: string): number {
  const chars = splitGraphemes(before)
  const last = chars[chars.length - 1] ?? ''
  const points = Array.from(last)
  const tail = points[points.length - 1] ?? ''
  return isEmojiTail(tail) ? last.length : tail.length
}

/** Backspace inside a line, as the canvas does it (`backspaceLength`). */
export const deleteCharBackward: Command = (state, dispatch) => {
  const $c = caretOf(state)
  if (!$c || $c.parentOffset === 0) return false
  const n = backspaceLength($c.parent.textBetween(0, $c.parentOffset))
  dispatch?.(state.tr.delete($c.pos - n, $c.pos).scrollIntoView())
  return true
}

/** Delete inside a line: deletes the whole character (grapheme cluster) after the caret. */
export const deleteCharForward: Command = (state, dispatch) => {
  const $c = caretOf(state)
  if (!$c || $c.parentOffset === $c.parent.content.size) return false
  const first = splitGraphemes($c.parent.textBetween($c.parentOffset, $c.parent.content.size))[0] ?? ''
  dispatch?.(state.tr.delete($c.pos, $c.pos + first.length).scrollIntoView())
  return true
}

/** Ctrl/Cmd+A: all the text, from the start of the first line to the end of the last (never ProseMirror's `AllSelection`). */
export const selectAllText: Command = (state, dispatch) => {
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)))
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
  'Mod-a': selectAllText,
  'Mod-z': undo,
  'Shift-Mod-z': redo,
  'Mod-y': redo,
}

// ---- pasted plain text, styled as the canvas styles it today -------------------------------------
//
// Plain text pasted into a text gets its marks exactly as today's canvas gives them: the
// steps below are Fabric 7.4.0's own (ITextKeyBehavior `onInput`, ITextBehavior
// `removeStyleFromTo`, `shiftLineStyles`, `insertNewlineStyleObject`, `insertCharStyleObject`,
// `insertNewStyleBlock`) on a model of its per-character styles, followed by the editor's
// reading of them (`readTextFormatting` in objects.ts: heading bold never carried onto a
// normal line, the pending choices on what was inserted). Their quirks are kept on purpose:
// several characters pasted at the start of a line take no style, text over a selection takes
// the first selected character's style, and a multi-line paste can restyle the first
// character after it.

interface FabricStyle {
  fontWeight?: 'bold'
  fontStyle?: 'italic'
  underline?: true
  linethrough?: true
  fontFamily?: FontId
  /** A heading line's size, as its level. */
  fontSize?: number
}
type FabricStyles = Record<number, Record<number, FabricStyle>>

/** The compact content of a text (its text with "\n" line breaks, spans and levels). */
export interface CompactContent {
  text: string
  spans?: TextSpan[]
  headings?: number[]
}

/**
 * The compact content after plain text `pasted` ("\n" line breaks) replaced the UTF-16 range
 * [from, to) of `old`, styled exactly as today's canvas styles it (see above), with `pending`
 * the choices made with only a caret. `baseFont` is the box font.
 */
export function plainPasteContent(old: CompactContent, baseFont: FontId, from: number, to: number, pasted: string, pending: Pending | null): CompactContent {
  const rawLines = old.text.split('\n')
  const lines = rawLines.map((l) => splitGraphemes(l)) // Fabric's `_unwrappedTextLines`, before the change
  const styles: FabricStyles = {}
  // The canonical styles of the text before the paste (`stylesFor` in objects.ts).
  const spans = old.spans ?? []
  let si = 0
  let lineStart = 0
  lines.forEach((gs, li) => {
    const level = old.headings?.[li]
    const heading: FabricStyle = isHeadingLevel(level) ? { fontSize: level, fontWeight: 'bold' } : {}
    const row: Record<number, FabricStyle> = {}
    let end = lineStart
    gs.forEach((g, k) => {
      const start = end
      end += g.length
      while (si < spans.length && spans[si]!.end <= start) si++
      const span = spans[si]
      const on = span && span.start < end ? span : undefined
      const st: FabricStyle = { ...heading }
      if (on?.bold) st.fontWeight = 'bold'
      if (on?.italic) st.fontStyle = 'italic'
      if (on?.underline) st.underline = true
      if (on?.strike) st.linethrough = true
      if (on?.font) st.fontFamily = on.font
      if (Object.keys(st).length > 0) row[k] = st
    })
    if (gs.length === 0 && heading.fontSize !== undefined) row[0] = heading
    if (Object.keys(row).length > 0) styles[li] = row
    lineStart += rawLines[li]!.length + 1
  })

  const loc = (position: number) => {
    let p = position
    let i = 0
    for (; i < lines.length; i++) {
      if (p <= lines[i]!.length) return { lineIndex: i, charIndex: p }
      p -= lines[i]!.length + 1
    }
    return { lineIndex: i - 1, charIndex: lines[i - 1]!.length < p ? lines[i - 1]!.length : p }
  }
  /** Fabric's grapheme index of a UTF-16 offset (an offset inside a character counts as before it). */
  const graphemeAt = (offset: number) => {
    let g = 0
    let o = 0
    for (let li = 0; li < lines.length; li++) {
      for (const ch of lines[li]!) {
        if (o + ch.length > offset) return g
        o += ch.length
        g++
      }
      if (o >= offset) return g
      o++
      g++
    }
    return Math.max(0, g - 1)
  }
  const shiftLineStyles = (lineIndex: number, offset: number) => {
    const cloned = { ...styles }
    for (const line in styles) {
      const n = parseInt(line, 10)
      if (n > lineIndex) {
        styles[n + offset] = cloned[n]!
        if (!cloned[n - offset]) delete styles[n]
      }
    }
  }
  const removeStyleFromTo = (start: number, end: number) => {
    const { lineIndex: lineStart, charIndex: charStart } = loc(start)
    const { lineIndex: lineEnd, charIndex: charEnd } = loc(end)
    if (lineStart !== lineEnd) {
      if (styles[lineStart]) for (let i = charStart; i < lines[lineStart]!.length; i++) delete styles[lineStart]![i]
      if (styles[lineEnd]) {
        for (let i = charEnd; i < lines[lineEnd]!.length; i++) {
          const st = styles[lineEnd]![i]
          if (st) {
            styles[lineStart] ??= {}
            styles[lineStart]![charStart + i - charEnd] = st
          }
        }
      }
      for (let i = lineStart + 1; i <= lineEnd; i++) delete styles[i]
      shiftLineStyles(lineEnd, lineStart - lineEnd)
    } else if (styles[lineStart]) {
      const row = styles[lineStart]!
      const diff = charEnd - charStart
      for (let i = charStart; i < charEnd; i++) delete row[i]
      for (const ch in row) {
        const n = parseInt(ch, 10)
        if (n >= charEnd) {
          row[n - diff] = row[n]!
          delete row[n]
        }
      }
    }
  }
  const insertNewlineStyleObject = (lineIndex: number, charIndex: number, qtyIn: number) => {
    const newLineStyles: Record<number, FabricStyle> = {}
    const originalLineLength = lines[lineIndex]!.length
    const isEndOfLine = originalLineLength === charIndex
    let someStyleIsCarryingOver = false
    let qty = qtyIn || 1
    shiftLineStyles(lineIndex, qty)
    const currentCharStyle = styles[lineIndex] ? styles[lineIndex]![charIndex === 0 ? charIndex : charIndex - 1] : undefined
    for (const index in styles[lineIndex]) {
      const n = parseInt(index, 10)
      if (n >= charIndex) {
        someStyleIsCarryingOver = true
        newLineStyles[n - charIndex] = styles[lineIndex]![n]!
        if (!(isEndOfLine && charIndex === 0)) delete styles[lineIndex]![n]
      }
    }
    let styleCarriedOver = false
    if (someStyleIsCarryingOver && !isEndOfLine) {
      styles[lineIndex + qty] = newLineStyles
      styleCarriedOver = true
    }
    if (styleCarriedOver || originalLineLength > charIndex) qty--
    while (qty > 0) {
      if (currentCharStyle) styles[lineIndex + qty] = { 0: { ...currentCharStyle } }
      else delete styles[lineIndex + qty]
      qty--
    }
  }
  const insertCharStyleObject = (lineIndex: number, charIndex: number, quantityIn: number, copiedStyle?: FabricStyle[]) => {
    const current = styles[lineIndex]
    const cloned = current ? { ...current } : {}
    let quantity = quantityIn || 1
    for (const index in cloned) {
      const n = parseInt(index, 10)
      if (n >= charIndex) {
        current![n + quantity] = cloned[n]!
        if (!cloned[n - quantity]) delete current![n]
      }
    }
    if (copiedStyle) {
      while (quantity--) {
        if (!Object.keys(copiedStyle[quantity]!).length) continue
        styles[lineIndex] ??= {}
        styles[lineIndex]![charIndex + quantity] = { ...copiedStyle[quantity] }
      }
      return
    }
    if (!current) return
    const newStyle = current[charIndex ? charIndex - 1 : 1]
    while (newStyle && quantity--) styles[lineIndex]![charIndex + quantity] = { ...newStyle }
  }
  const insertNewStyleBlock = (insertedText: string[], start: number, copiedIn?: FabricStyle[]) => {
    let copiedStyle = copiedIn
    const cursorLoc = loc(start)
    const addedLines = [0]
    let linesLength = 0
    for (const ch of insertedText) {
      if (ch === '\n') {
        linesLength++
        addedLines[linesLength] = 0
      } else addedLines[linesLength]!++
    }
    if (addedLines[0]! > 0) {
      insertCharStyleObject(cursorLoc.lineIndex, cursorLoc.charIndex, addedLines[0]!, copiedStyle)
      copiedStyle = copiedStyle && copiedStyle.slice(addedLines[0]! + 1)
    }
    if (linesLength) insertNewlineStyleObject(cursorLoc.lineIndex, cursorLoc.charIndex + addedLines[0]!, linesLength)
    let i = 1
    for (; i < linesLength; i++) {
      if (addedLines[i]! > 0) insertCharStyleObject(cursorLoc.lineIndex + i, 0, addedLines[i]!, copiedStyle)
      else if (copiedStyle && styles[cursorLoc.lineIndex + i] && copiedStyle[0]) styles[cursorLoc.lineIndex + i]![0] = copiedStyle[0]
      copiedStyle = copiedStyle && copiedStyle.slice(addedLines[i]! + 1)
    }
    if (addedLines[i]! > 0) insertCharStyleObject(cursorLoc.lineIndex + i, 0, addedLines[i]!, copiedStyle)
  }

  // `onInput`: the textarea now holds the new text, its caret after what was pasted.
  const nextText = old.text.slice(0, from) + pasted + old.text.slice(to)
  const globalOf = (ls: string[][]) => ls.flatMap((gs, i) => (i === 0 ? gs : ['\n', ...gs]))
  const oldGlobal = globalOf(lines)
  const nextGlobal = globalOf(nextText.split('\n').map((l) => splitGraphemes(l)))
  const selStart = graphemeAt(from)
  const selEnd = graphemeAt(to)
  const caretG = splitGraphemes(nextText.slice(0, from + pasted.length)).length
  let charDiff = nextGlobal.length - oldGlobal.length
  let removed: string[] | undefined
  if (selStart !== selEnd) {
    removed = oldGlobal.slice(selStart, selEnd)
    charDiff += selEnd - selStart
  }
  const inserted = nextGlobal.slice(caretG - charDiff, caretG)
  let copied: FabricStyle[] | undefined
  if (removed && removed.length > 0) {
    if (inserted.length > 0) {
      const { lineIndex, charIndex } = loc(selStart)
      const first = styles[lineIndex]?.[charIndex] ?? {}
      copied = inserted.map(() => first)
    }
    removeStyleFromTo(selStart, selEnd)
  }
  if (inserted.length > 0) insertNewStyleBlock(inserted, selStart, copied)

  // `readTextFormatting`: levels carried over, marks read from the styles.
  const edit = textAfterEdit(old.text, old.headings, nextText, from + pasted.length)
  const headings = edit.headings
  const withChoices = pending && Object.keys(pending).length > 0 ? pending : null
  const chars = new Map<number, CharStyle>()
  let at = 0
  nextText.split('\n').forEach((raw, li) => {
    const row = styles[li]
    let start = at
    at += raw.length + 1
    if (!row && !withChoices) return
    splitGraphemes(raw).forEach((g, k) => {
      const end = start + g.length
      const st = row?.[k]
      let mask = st ? markMask({ bold: st.fontWeight === 'bold', italic: st.fontStyle === 'italic', underline: st.underline === true, strike: st.linethrough === true }) : 0
      let font = st?.fontFamily
      if (st && mask & BOLD_BIT && (headings?.[li] ?? 0) === 0) {
        const before = edit.levelBefore(start, end)
        if ((before !== undefined && before > 0) || st.fontSize !== undefined) mask &= ~BOLD_BIT
      }
      if (withChoices && edit.levelBefore(start, end) === undefined) {
        mask = withPendingMarks(mask, withChoices)
        font = withChoices.font ?? font
      }
      if (mask || font) chars.set(start, { mask, font })
      start = end
    })
  })
  const fmt = canonicalTextFormatting(nextText, { font: baseFont, spans: spansFromCharStyles(nextText, headings, (a) => chars.get(a)), headings })
  return { text: nextText, ...(fmt.spans && { spans: fmt.spans }), ...(fmt.headings && { headings: fmt.headings }) }
}

const BOLD_BIT = markMask({ bold: true })
