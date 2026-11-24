import { chainCommands, createParagraphNear, deleteSelection, joinBackward, joinForward, liftEmptyBlock, newlineInCode, splitBlock } from 'prosemirror-commands'
import { closeHistory, isHistoryTransaction, redo, undo, undoDepth } from 'prosemirror-history'
import { Mark as PMMark } from 'prosemirror-model'
import type { Node as PMNode, NodeType, ResolvedPos } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { AllSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { Command, EditorState, Transaction } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep, canJoin, findWrapping, liftTarget } from 'prosemirror-transform'
import { MARKS, canonicalTextFormatting, headingsAfterEdit, isHeadingLevel, markMask, spansFromCharStyles, splitGraphemes, textAfterEdit, withPendingMarks } from '../model/richText.ts'
import type { CharStyle, HeadingLevel, Mark, MarkState, PendingTextStyle, RangeFormat } from '../model/richText.ts'
import { RUN_MARKS, blockOf, blockTypeFor, fontOf, isItemType, isListType, levelOf, marks, marksOfRun, nodes, posAtTextOffset, runKey, textOffsetAt, textSchema, textblocksOf } from './textSchema.ts'
import { blocksToLegacy, legacyToBlocks, parseBlocks } from '../model/textDoc.ts'
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
  /**
   * The transaction replaced a selection with typed text, Enter or nothing (a deletion):
   * `{ text, from, to }` in UTF-16 offsets of the text before it. The session styles the
   * result as today's canvas does (`plainPasteContent`).
   */
  replaced: 'yuriful/replaced',
} as const

/** A selection about to be replaced by `text`, for `META.replaced`. */
export function replacedRange(state: EditorState, text: string): { text: string; from: number; to: number } {
  const { from, to } = state.selection
  return { text, from: textOffsetAt(state.doc, from, -1), to: textOffsetAt(state.doc, to, 1) }
}

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
  kind: 'heading' | 'bold' | 'italic' | 'code'
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
 * Pure: the same rule as the Fabric renderer's `matchTypingShortcut` (deleted; its answers are a
 * frozen reference in `textRules.test.ts`), on one line (a block).
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

/**
 * The inline code shortcut that `inserted`, just typed into `line` with the caret now at `caret`,
 * completes, or null: a closing backtick with an opening one earlier on the line, by the same rules
 * as `*italic*` (marked text not empty, no whitespace just inside either marker, no backtick in it,
 * the opener starting a word, neither marker touching another backtick). So `` a`b` `` and ``` `` ```
 * stay as typed. Pure.
 */
export function matchCodeShortcut(line: string, caret: number, inserted: string): LineShortcut | null {
  if (inserted !== '`' || caret < 1 || caret > line.length || line[caret - 1] !== '`') return null
  if (line[caret] === '`') return null
  const close = caret - 1
  let j = close - 1
  while (j >= 0 && line[j] !== '`') j--
  if (j < 0) return null
  const content = { start: j + 1, end: close }
  if (content.start >= content.end || isSpace(line[content.start]) || isSpace(line[content.end - 1])) return null
  const before = j > 0 ? line[j - 1] : undefined
  if (before !== undefined && !isSpace(before) && !OPENERS.includes(before)) return null // inside a word, or touching another backtick
  for (const i of [j, close]) if (!ownCharacter(line, i)) return null
  return { kind: 'code', remove: [{ start: j, end: j + 1 }, { start: close, end: caret }], content }
}

/** A block shortcut: what the line becomes, and the marker at its start (`[0, end)`) that goes. */
export interface BlockShortcut {
  kind: 'bulletList' | 'orderedList' | 'taskList' | 'blockquote' | 'divider' | 'codeBlock'
  /** A numbered list: the number it starts at. */
  start?: number
  /** A checklist item: ticked or not. */
  checked?: boolean
  end: number
}

/**
 * The block shortcut `inserted`, just typed so that the caret is at `caret` of `line`, completes,
 * or null, wherever the line is (`shortcutTransaction` decides where each may fire):
 * - a space after `-` (bullet list), `>` (quote), a number from 1 and `.` (numbered list starting
 *   at it), `[]` or `[ ]` (unticked checklist item) or `[x]` (ticked) at the very start of the line;
 * - the third `-` of a line that is exactly `---` (divider);
 * - the third backtick of ```` ``` ```` at the start of a line (code block; the rest of the line
 *   becomes its text).
 * `* ` is no bullet: it stays as typed (owner decision 7). The typed character must be a
 * character of its own (not joined to a following mark). Pure.
 */
export function matchBlockShortcut(line: string, caret: number, inserted: string): BlockShortcut | null {
  if (caret < 1 || caret > line.length || line[caret - 1] !== inserted || !ownCharacter(line, caret - 1)) return null
  const head = line.slice(0, caret)
  if (inserted === ' ') {
    if (head === '- ') return { kind: 'bulletList', end: caret }
    if (head === '> ') return { kind: 'blockquote', end: caret }
    if (head === '[] ' || head === '[ ] ') return { kind: 'taskList', checked: false, end: caret }
    if (head === '[x] ') return { kind: 'taskList', checked: true, end: caret }
    const n = /^(\d{1,9})\. $/.exec(head)
    if (n && Number(n[1]) >= 1) return { kind: 'orderedList', start: Number(n[1]), end: caret }
    return null
  }
  if (inserted === '-' && line === '---' && caret === 3) return { kind: 'divider', end: 3 }
  if (inserted === '`' && head === '```') return { kind: 'codeBlock', end: 3 }
  return null
}

/** Where a textblock sits, for the block shortcuts: a plain paragraph (top level or in a quote), the first paragraph of a bullet list item, or anything else. */
function lineContext($at: ResolvedPos): 'plain' | 'bulletItem' | 'other' {
  const parent = $at.parent
  if (parent.type !== nodes.paragraph || $at.depth < 1) return 'other'
  const holder = $at.node($at.depth - 1)
  if (holder.type === nodes.doc || holder.type === nodes.blockquote) return 'plain'
  if (holder.type === nodes.listItem && $at.index($at.depth - 1) === 0 && $at.depth >= 2 && $at.node($at.depth - 2).type === nodes.bulletList) return 'bulletItem'
  return 'other'
}

/** A block shortcut allowed where it would fire: every one in a plain paragraph (a ticked box only from a bullet), and only the checkbox in a bullet item. */
function blockShortcutAllowed(sc: BlockShortcut, where: 'plain' | 'bulletItem' | 'other'): boolean {
  if (where === 'plain') return !(sc.kind === 'taskList' && sc.checked)
  return where === 'bulletItem' && sc.kind === 'taskList'
}

type AnyShortcut = { line: LineShortcut } | { block: BlockShortcut }

/**
 * The shortcut that typing `inserted` completes on the textblock at `$at` whose text is now `line`
 * with the caret at `caret`; `inCode`: the typed character is inline code. Nothing fires in a code
 * block; heading, bold, italic and code do not fire inside inline code (bold and italic) or in a
 * code block; block shortcuts fire only where `blockShortcutAllowed` says.
 */
function shortcutAt($at: ResolvedPos, line: string, caret: number, inserted: string, inCode: boolean): AnyShortcut | null {
  if (!$at.parent.isTextblock || $at.parent.type.spec.code) return null
  const block = matchBlockShortcut(line, caret, inserted)
  if (block) return blockShortcutAllowed(block, lineContext($at)) ? { block } : null
  const sc = matchShortcut(line, caret, inserted) ?? matchCodeShortcut(line, caret, inserted)
  if (!sc || (inCode && sc.kind !== 'heading')) return null
  return { line: sc }
}

/** Whether inserting `text` at `from` (nothing replaced) would complete a typing shortcut. */
export function completesShortcut(state: EditorState, from: number, text: string): boolean {
  const $from = state.doc.resolve(from)
  if (!$from.parent.isTextblock) return false
  const line = $from.parent.textContent
  const off = $from.parentOffset
  const pending = pendingOf(state)
  const inCode = pending?.code ?? marks.code.isInSet($from.marks()) !== undefined
  return shortcutAt($from, line.slice(0, off) + text + line.slice(off), off + text.length, text, inCode) !== null
}

/**
 * The second transaction of a typing shortcut, built on the state just after the typed
 * character went in (the caret right after it): the markers go, and the text between them is
 * bold, italic or inline code (a heading shows bold of itself, so only the markers go there), the
 * line becomes a heading, or the line becomes a list item, a checklist item, a quote, a divider or
 * a code block (`blockShortcut`). The caret moves after the formatted text (or to the start of the
 * line's text), and after bold or italic what is typed next is plain through a pending "off"
 * (inline code does not carry on of itself). It starts a new history event (`closeHistory`), so
 * the literal characters are one undo step away. Null when no shortcut completes at the caret.
 */
export function shortcutTransaction(state: EditorState, inserted: string): Transaction | null {
  const sel = state.selection
  const $c = sel instanceof TextSelection ? sel.$cursor : null
  if (!$c || !$c.parent.isTextblock) return null
  const typed = $c.nodeBefore
  const found = shortcutAt($c, $c.parent.textContent, $c.parentOffset, inserted, typed ? marks.code.isInSet(typed.marks) !== undefined : false)
  if (!found) return null
  const pending = pendingOf(state)
  if ('block' in found) {
    const tr = blockShortcut(state, $c, found.block)
    tr.setMeta(pendingKey, pending)
    tr.setMeta(META.levelsSet, true).setMeta(META.shortcutApplied, true)
    return closeHistory(tr)
  }
  const sc = found.line
  const base = $c.start()
  const tr = state.tr
  for (const r of [...sc.remove].reverse()) tr.delete(base + r.start, base + r.end)
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
    if (mark === 'code') tr.setMeta(pendingKey, pending)
    else {
      // What is typed next is plain again: a pending "off" (none for bold on a heading line,
      // where it cannot change). The character before the caret now has the mark, so typing
      // would otherwise carry it.
      const style: Pending = { ...pending }
      if (headingBold) delete style[mark]
      else style[mark] = false
      tr.setMeta(pendingKey, normalPending(style))
    }
  }
  tr.setMeta(META.levelsSet, true).setMeta(META.shortcutApplied, true)
  return closeHistory(tr)
}

/** Joins the block at `pos` (the position before it) with the sibling after it and the one before it, where `withNext` and `withPrev` allow. */
function joinSiblings(tr: Transaction, pos: number, withPrev: (prev: PMNode, node: PMNode) => boolean, withNext: (node: PMNode, next: PMNode) => boolean) {
  const node = tr.doc.nodeAt(pos)
  if (!node) return
  const after = pos + node.nodeSize
  const next = tr.doc.nodeAt(after)
  if (next && withNext(node, next) && canJoin(tr.doc, after)) tr.join(after)
  const prev = tr.doc.resolve(pos).nodeBefore
  const cur = tr.doc.nodeAt(pos)
  if (prev && cur && withPrev(prev, cur) && canJoin(tr.doc, pos)) tr.join(pos)
}

/** Two lists of one kind (not numbered), or two quotes, side by side become one. */
const sameKind = (a: PMNode, b: PMNode) => a.type === b.type && a.type !== nodes.orderedList && (isListType(a.type) || a.type === nodes.blockquote)

/** A numbered list typed right after another continues it when its number follows on. */
const continuesNumbering = (prev: PMNode, next: PMNode) => prev.type === nodes.orderedList && next.type === nodes.orderedList && (prev.attrs.start as number) + prev.childCount === (next.attrs.start as number)

/**
 * A block shortcut applied to the paragraph holding the caret `$c` (just after the typed character):
 * its marker goes and the paragraph becomes a list item (joining a list of the same kind beside it;
 * a numbered list joins the one just before it only when its number follows on), a checklist item
 * (in a bullet list, that item alone becomes one), a quote (joining a quote beside it), a divider
 * followed by an empty paragraph, or a code block holding the rest of the line. None of these
 * changes the plain text beyond the marker, so the caret is put back at the start of the line's text
 * by its offset.
 */
function blockShortcut(state: EditorState, $c: ResolvedPos, sc: BlockShortcut): Transaction {
  const tr = state.tr
  const paraPos = $c.before()
  tr.delete($c.start(), $c.start() + sc.end)
  const lineStart = textOffsetAt(tr.doc, paraPos + 1, 1)
  const para = tr.doc.nodeAt(paraPos)!
  if (sc.kind === 'divider') tr.replaceWith(paraPos, paraPos + para.nodeSize, [nodes.divider.create(), nodes.paragraph.create()])
  else if (sc.kind === 'codeBlock') tr.setBlockType(paraPos + 1, paraPos + 1, nodes.codeBlock)
  else if (sc.kind === 'taskList' && lineContext($c) === 'bulletItem') {
    const listDepth = $c.depth - 2
    const listPos = $c.before(listDepth)
    const list = tr.doc.nodeAt(listPos)!
    const index = $c.index(listDepth)
    const slice = (from: number, to: number) => {
      const out: PMNode[] = []
      for (let i = from; i < to; i++) out.push(list.child(i))
      return out
    }
    const replacement: PMNode[] = []
    if (index > 0) replacement.push(nodes.bulletList.create(null, slice(0, index)))
    replacement.push(nodes.taskList.create(null, nodes.taskItem.create({ checked: sc.checked === true }, list.child(index).content)))
    if (index < list.childCount - 1) replacement.push(nodes.bulletList.create(null, slice(index + 1, list.childCount)))
    tr.replaceWith(listPos, listPos + list.nodeSize, replacement)
    joinSiblings(tr, listPos + (index > 0 ? replacement[0]!.nodeSize : 0), sameKind, sameKind)
  } else {
    const range = tr.doc.resolve(paraPos + 1).blockRange()
    const type = sc.kind === 'bulletList' ? nodes.bulletList : sc.kind === 'orderedList' ? nodes.orderedList : sc.kind === 'taskList' ? nodes.taskList : nodes.blockquote
    const wrapping = range && findWrapping(range, type, sc.kind === 'orderedList' ? { start: sc.start ?? 1 } : null)
    if (range && wrapping) {
      if (sc.kind === 'taskList') wrapping[1] = { type: nodes.taskItem, attrs: { checked: sc.checked === true } }
      tr.wrap(range, wrapping)
      if (type === nodes.orderedList) joinSiblings(tr, paraPos, continuesNumbering, () => false)
      else joinSiblings(tr, paraPos, sameKind, sameKind)
    }
  }
  return tr.setSelection(TextSelection.create(tr.doc, posAtTextOffset(tr.doc, lineStart)))
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

/** The heading level of every line (textblock). */
function levelsOf(doc: PMNode): number[] {
  return textblocksOf(doc).map((t) => levelOf(t.node))
}

/**
 * The text of a document with one line per textblock, for the level rule: a code block's own
 * line breaks are stood in for by another character of the same length, so that the lines of
 * the text are exactly the textblocks. For a compact text this is its plain text.
 */
function levelText(doc: PMNode): string {
  return textblocksOf(doc)
    .map((t) => (t.node.type.spec.code ? t.node.textContent.replace(/\n/g, ' ') : t.node.textContent))
    .join('\n')
}

/**
 * The heading level of every line of `newDoc` after a change of the text: exactly today's
 * rule, `headingsAfterEdit` in `richText.ts`, the one authority (a heading is a property of a
 * line, carried over by how the text changed, never guessed from it), given the text and
 * levels before, the text after and `caret`, the UTF-16 offset of the end of the selection
 * after the change (what the canvas reads as its caret). Lines are textblocks, wherever they sit
 * (in a list item or a quote too); a code block is a line that is never a heading.
 */
export function levelsAfterEdit(oldDoc: PMNode, newDoc: PMNode, caret: number): number[] {
  const next = headingsAfterEdit(levelText(oldDoc), levelsOf(oldDoc), levelText(newDoc), caret)
  return Array.from({ length: textblocksOf(newDoc).length }, (_, i) => next?.[i] ?? 0)
}

/** Sets the level of every paragraph or heading line `levelAt` gives a level for, where it differs (a code block keeps its kind). True when anything changed. */
function applyLevels(tr: Transaction, levelAt: (index: number) => number | undefined): boolean {
  let changed = false
  // Changing a block's type keeps every position, so the positions of `doc` stay valid.
  textblocksOf(tr.doc).forEach(({ node, pos }, index) => {
    const want = levelAt(index)
    if (want === undefined || want === levelOf(node) || node.type.spec.code) return
    const { type, attrs } = blockTypeFor(want)
    tr.setNodeMarkup(pos, type, attrs)
    changed = true
  })
  return changed
}

/**
 * After every change of the text that does not set levels itself (typing, Enter, Backspace,
 * Delete, a paste, a drop, a cut, typing over a selection, an IME composition), every line
 * gets the level `levelsAfterEdit` gives, whatever block types ProseMirror's own commands
 * chose. A change that leaves the text as it was keeps every level. Undo and redo restore
 * exact earlier states and are left alone. While `busy` (an IME composition is open) nothing
 * is done: a composition runs at a caret (a selection is deleted, as an ordinary edit, before
 * it starts) and stays within its line, so it changes no line's level.
 */
export function lineLevels(opts: { busy?: () => boolean } = {}): Plugin {
  return new Plugin({
    key: new PluginKey('yuriful-line-levels'),
    appendTransaction(trs, oldState, newState) {
      if (opts.busy?.() || !trs.some((t) => t.docChanged)) return null
      if (trs.some((t) => t.getMeta(META.levelsSet) === true || isHistoryTransaction(t))) return null
      const levels = levelsAfterEdit(oldState.doc, newState.doc, textOffsetAt(newState.doc, newState.selection.to, 1))
      const tr = newState.tr
      return applyLevels(tr, (i) => levels[i]) ? tr.setMeta(META.levelsSet, true) : null
    },
  })
}

// ---- canonical form of what is shown ----------------------------------------------------------

/** The runs of a list of code-unit mark sets over `text`. */
function runsOfUnits(text: string, units: ReadonlyArray<readonly PMMark[]>): InlineRun[] {
  const out: InlineRun[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && PMMark.sameSet(units[i]!, units[start]!)) continue
    const run: InlineRun = { text: text.slice(start, i) }
    for (const m of RUN_MARKS) if (marks[m].isInSet(units[start]!)) run[m] = true
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
 * Runs without inline code go through the compact form's canonicalization, exactly as before rich
 * blocks; runs with it through the rich form's (`parseBlocks`). A code block holds no marks.
 * True when anything changed.
 */
function canonicalizeBlock(tr: Transaction, block: PMNode, contentStart: number, baseFont: FontId, inserted: ReadonlyArray<{ from: number; to: number }>): boolean {
  if (block.type.spec.code) return false
  const text = block.textContent
  const units: Array<readonly PMMark[]> = []
  block.forEach((child) => {
    for (let i = 0; i < (child.text ?? '').length; i++) units.push(child.marks)
  })
  let at = 0
  for (const g of splitGraphemes(text)) {
    const end = at + g.length
    if (g.length > 1 && !units.slice(at, end).every((u) => PMMark.sameSet(u, units[at]!))) {
      let picked = false
      for (let i = end - 1; i >= at; i--) {
        const pos = contentStart + i
        if (!inserted.some((r) => pos >= r.from && pos < r.to)) continue
        const pick = units[i]!
        for (let k = at; k < end; k++) units[k] = pick
        picked = true
        break
      }
      // Not just inserted: the whole character has every mark any part of it has, and the first
      // font, as the compact form's canonical spans give it (`canonicalSpans`).
      if (!picked) {
        let set: readonly PMMark[] = []
        let font: PMMark | undefined
        for (let k = at; k < end; k++) {
          for (const m of units[k]!) {
            if (m.type === marks.font) font ??= m
            else set = m.addToSet(set)
          }
        }
        if (font) set = font.addToSet(set)
        for (let k = at; k < end; k++) units[k] = set
      }
    }
    at = end
  }
  const own = runsOfUnits(text, units)
  const level = levelOf(block)
  const raw = isHeadingLevel(level) ? { type: 'heading' as const, level, content: own } : { type: 'paragraph' as const, content: own }
  let runs: readonly InlineRun[]
  if (own.some((r) => r.code)) {
    const parsed = parseBlocks([raw], baseFont)?.[0]
    runs = parsed && (parsed.type === 'paragraph' || parsed.type === 'heading') ? (parsed.content ?? []) : own
  } else {
    const compact = blocksToLegacy([raw], baseFont)
    if (!compact) return false
    const canonical = legacyToBlocks(compact.text, compact, baseFont)[0]
    runs = canonical && (canonical.type === 'paragraph' || canonical.type === 'heading') ? (canonical.content ?? []) : []
  }
  return imposeRuns(tr, block, contentStart, runs)
}

/** Makes the textblocks a range touches canonical, with `inserted` the text just inserted. True when anything changed. */
function canonicalizeRange(tr: Transaction, doc: PMNode, range: { from: number; to: number }, inserted: ReadonlyArray<{ from: number; to: number }>, baseFont: FontId): boolean {
  let changed = false
  for (const { node, pos } of textblocksOf(doc)) {
    if (pos + node.nodeSize < range.from || pos > range.to) continue
    if (canonicalizeBlock(tr, node, pos + 1, baseFont, inserted)) changed = true
  }
  return changed
}

/** Makes the blocks of `tr.doc` that `range` touches (default: all) canonical (`canonicalizeBlock`), with `inserted` the text just inserted. True when anything changed. */
export function canonicalizeDoc(tr: Transaction, baseFont: FontId, inserted: ReadonlyArray<{ from: number; to: number }>, range: { from: number; to: number } = { from: 0, to: tr.doc.content.size }): boolean {
  return canonicalizeRange(tr, tr.doc, range, inserted, baseFont)
}

/**
 * Keeps what is shown in canonical form after every change (plan Section 7's heading-bold
 * guard, plus the rest of the canonical run form of Section 5): the blocks a change touched
 * are made canonical (`canonicalizeBlock`), and stored marks never carry bold while the caret
 * is on a heading line. While `busy` (an IME composition is open) nothing is
 * rewritten: the browser and ProseMirror own the text, and the session's follow-up makes it
 * canonical once the composition is over.
 */
export function canonicalGuard(opts: { baseFont: () => FontId; busy?: () => boolean }): Plugin {
  return new Plugin({
    key: new PluginKey('yuriful-canonical'),
    appendTransaction(trs, _oldState, state) {
      if (opts.busy?.()) return null
      const tr = state.tr
      let changed = false
      const range = trs.some((t) => t.docChanged) ? changedRange(trs, true) : null
      if (range && canonicalizeRange(tr, state.doc, range, insertedRanges(trs), opts.baseFont())) changed = true
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

/** The position at the edge of the character (grapheme cluster) `pos` falls inside: its start for `dir` -1, its end for 1; `pos` itself on a boundary. */
function characterEdge(doc: PMNode, pos: number, dir: -1 | 1): number {
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

/** All the text: from the start of the first line to the end of the last (never ProseMirror's `AllSelection`); null with no line at all. */
export function allText(doc: PMNode): TextSelection | null {
  const tbs = textblocksOf(doc)
  const first = tbs[0]
  const last = tbs[tbs.length - 1]
  return first && last ? TextSelection.create(doc, first.pos + 1, last.pos + 1 + last.node.content.size) : null
}

/**
 * Keeps every selection on whole characters, whatever made it (a command, in-edit undo or
 * redo, the browser): a whole-document selection (`AllSelection`) becomes the selection of
 * all the text, as the canvas's select-all is; a caret inside a character (as a redo can
 * restore it, inside a skin-toned emoji or an accented letter) moves to the end of the
 * character, where the edit that made it left the caret; a range grows to whole characters.
 * Nothing while `busy` (an IME composition is open): the next transaction after it is
 * snapped, the composition's follow-up at the latest. The pending choices are kept.
 */
export function selectionOnCharacters(opts: { busy?: () => boolean } = {}): Plugin {
  return new Plugin({
    key: new PluginKey('yuriful-selection-on-characters'),
    appendTransaction(_trs, _old, state) {
      if (opts.busy?.()) return null
      const sel = state.selection
      const doc = state.doc
      let next: TextSelection | null = null
      if (sel instanceof AllSelection) next = allText(doc)
      else if (sel instanceof TextSelection) {
        if (sel.empty) {
          const at = characterEdge(doc, sel.head, 1)
          if (at !== sel.head) next = TextSelection.create(doc, at)
        } else {
          const back = sel.anchor > sel.head
          const anchor = characterEdge(doc, sel.anchor, back ? 1 : -1)
          const head = characterEdge(doc, sel.head, back ? -1 : 1)
          if (anchor !== sel.anchor || head !== sel.head) next = TextSelection.create(doc, anchor, head)
        }
      }
      return next ? state.tr.setSelection(next).setMeta(pendingKey, pendingOf(state)) : null
    },
  })
}

// ---- marks and a font chosen with only a caret (pending) ----------------------------------------

/** Marks and a font chosen with only a caret; inline code too (`code`), which only a rich text holds. */
export type Pending = PendingTextStyle & { code?: boolean }

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
  if (p.code !== undefined) out.code = p.code
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
  if (p.code === true) set = marks.code.create().addToSet(set)
  else if (p.code === false) set = marks.code.removeFromSet(set)
  return set
}

/**
 * Marks and a font chosen with only a caret, as today: kept through typing, deleting, Enter,
 * a paste and every step of an IME composition (any change of the text), dropped when the
 * caret or selection moves for any other reason and when the session ends. In-edit undo
 * drops them, except that redoing a typing shortcut's own history step brings back the
 * choices it left (`afterHistory`, given whether it was a redo and the undo depth after it:
 * "plain after the shortcut"). A pending bold is dropped once the caret's
 * line is or becomes a heading, judged on the final state of a change (after its lines have
 * their levels); every other choice stays. Set with `pendingKey` metadata.
 *
 * The choices are not mirrored into ProseMirror's stored marks: stored marks at the start of
 * an IME composition make ProseMirror wrap the caret in mark elements, which a fast IME can
 * break. A typed character gets them from the session (`typedMarks`), a paste from its own
 * rules, a composition's text from its follow-up.
 */
export function pendingMarks(opts: { baseFont: () => FontId; afterHistory?: (redo: boolean, depth: number) => Pending | null; busy?: () => boolean }): Plugin<Pending | null> {
  return new Plugin<Pending | null>({
    key: pendingKey,
    state: {
      init: () => null,
      apply(tr, value, oldState, newState) {
        const meta = tr.getMeta(pendingKey) as Pending | null | undefined
        let next = value
        if (meta !== undefined) next = normalPending(meta)
        else if (isHistoryTransaction(tr)) {
          // Needs the history plugin before this one, so that `newState` already holds its new depth.
          const depth = undoDepth(newState) as number
          next = normalPending(opts.afterHistory?.(depth > (undoDepth(oldState) as number), depth))
        }
        else if (opts.busy?.()) return next // kept through an IME composition, whatever it does to the selection
        else if (tr.selectionSet && !tr.docChanged) next = null
        if (next && !caretOf(newState)) next = null // a choice belongs to a caret
        return next
      },
    },
    appendTransaction(_trs, _old, state) {
      if (opts.busy?.()) return null
      const pending = pendingOf(state)
      if (!pending || pending.bold === undefined || !caretOnHeading(state)) return null
      const { bold: _dropped, ...rest } = pending
      void _dropped
      return state.tr.setMeta(pendingKey, normalPending(rest))
    },
  })
}

/**
 * The marks a character typed at the caret gets when they are not just the neighbouring marks
 * (pending choices made with only a caret; never bold on a heading line); null otherwise.
 */
export function typedMarks(state: EditorState, baseFont: FontId): readonly PMMark[] | null {
  const $c = caretOf(state)
  const pending = pendingOf(state)
  if (!$c || !pending) return null
  const natural = $c.marks()
  let set = applyPending(natural, pending, baseFont)
  if ($c.parent.type === nodes.heading) set = marks.bold.removeFromSet(set)
  return PMMark.sameSet(set, natural) ? null : set
}

// ---- what the formatting controls show, and the formatting commands --------------------------------

/** The kinds of block the controls turn on and off. */
export type BlockKind = 'bulletList' | 'orderedList' | 'taskList' | 'blockquote' | 'codeBlock'
export const BLOCK_KINDS: readonly BlockKind[] = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock']

/** What the controls show for a range, a caret or a whole box. */
export interface FormatReadout extends RangeFormat {
  font: FontId | 'mixed'
}

/** What the block controls show for a range, a caret or a whole box. */
export interface BlockReadout {
  /** Inline code over the characters concerned (a caret: the next typed character). */
  code: MarkState
  /** Each kind of block over the lines concerned: a line is in a list when its nearest list is of that kind. */
  blocks: Record<BlockKind, MarkState>
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

/**
 * The text in a range that marks apply to, as pieces of text nodes with their marks and whether
 * they are on a heading line. A code block's text is left out: it holds no marks.
 */
function segments(doc: PMNode, from: number, to: number): Segment[] {
  const r = wholeCharacters(doc, from, to)
  const out: Segment[] = []
  if (r.from >= r.to) return out
  doc.nodesBetween(r.from, r.to, (node, pos, parent) => {
    if (node.type.spec.code) return false
    if (!node.isText) return true
    const a = Math.max(r.from, pos)
    const b = Math.min(r.to, pos + node.nodeSize)
    if (a < b) out.push({ from: a, to: b, marks: node.marks, heading: parent?.type === nodes.heading })
    return false
  })
  return out
}

/** The index of the line (textblock) a position is in; a position between lines counts as the next line, or for `end` the one before. */
function blockIndexAt(doc: PMNode, pos: number, end: boolean): number {
  const tbs = textblocksOf(doc)
  for (let i = 0; i < tbs.length; i++) {
    const { node, pos: at } = tbs[i]!
    if (pos < at + 1) return Math.max(0, end ? i - 1 : i)
    if (pos <= at + 1 + node.content.size) return i
  }
  return Math.max(0, tbs.length - 1)
}

/**
 * The lines (textblocks) a selection touches, for a caret its line. A range that ends exactly at
 * the start of a line, just after a line break, does not touch that line.
 */
export function linesOfSelection(doc: PMNode, from: number, to: number): { first: number; last: number } {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const first = blockIndexAt(doc, lo, false)
  let last = blockIndexAt(doc, hi, hi > lo)
  const $hi = doc.resolve(hi)
  if (hi > lo && last > first && $hi.parent.isTextblock && $hi.parentOffset === 0) last--
  return { first, last: Math.max(first, last) }
}

/** The last line a whole-box heading counts: every line but an empty last one, unless the text has no character at all. */
export function lastBoxLine(doc: PMNode): number {
  const tbs = textblocksOf(doc)
  const last = tbs.length - 1
  const any = tbs.some((t) => t.node.content.size > 0)
  return last > 0 && tbs[last]!.node.content.size === 0 && any ? last - 1 : Math.max(0, last)
}

/** The kind of block a line (the textblock just after `pos`) is in, for each of `BLOCK_KINDS`. */
function kindsOfLine(doc: PMNode, pos: number): Record<BlockKind, boolean> {
  const $p = doc.resolve(pos + 1)
  let list: NodeType | null = null
  let quote = false
  for (let d = $p.depth - 1; d > 0; d--) {
    const t = $p.node(d).type
    if (list === null && isListType(t)) list = t
    if (t === nodes.blockquote) quote = true
  }
  return {
    bulletList: list === nodes.bulletList,
    orderedList: list === nodes.orderedList,
    taskList: list === nodes.taskList,
    blockquote: quote,
    codeBlock: $p.parent.type === nodes.codeBlock,
  }
}

/** Each kind of block over the lines `first` to `last`. */
function blocksOf(doc: PMNode, first: number, last: number): Record<BlockKind, MarkState> {
  const lines = textblocksOf(doc).slice(first, last + 1)
  const kinds = lines.map((t) => kindsOfLine(doc, t.pos))
  const out = {} as Record<BlockKind, MarkState>
  for (const k of BLOCK_KINDS) {
    const n = kinds.filter((x) => x[k]).length
    out[k] = n === 0 ? 'off' : n === kinds.length ? 'on' : 'mixed'
  }
  return out
}

function formatOf(doc: PMNode, from: number, to: number, first: number, last: number, baseFont: FontId): FormatReadout {
  const hit = segments(doc, from, to)
  const state = (m: Mark): MarkState => {
    const n = hit.filter((s) => marks[m].isInSet(s.marks) || (m === 'bold' && s.heading)).length
    return n === 0 ? 'off' : n === hit.length ? 'on' : 'mixed'
  }
  const levels = new Set<number>()
  const tbs = textblocksOf(doc)
  for (let i = first; i <= last; i++) {
    const t = tbs[i]
    if (t) levels.add(levelOf(t.node))
  }
  const fonts = new Set(hit.map((s) => fontOf(s.marks) ?? baseFont))
  return {
    marks: { bold: state('bold'), italic: state('italic'), underline: state('underline'), strike: state('strike') },
    heading: levels.size === 1 ? ([...levels][0] as number) : 'mixed',
    boldFromHeading: hit.length > 0 && hit.every((s) => s.heading),
    font: fonts.size === 0 ? baseFont : fonts.size === 1 ? ([...fonts][0] as FontId) : 'mixed',
  }
}

/** Inline code over the characters of a range. */
function codeOf(doc: PMNode, from: number, to: number): MarkState {
  const hit = segments(doc, from, to)
  const n = hit.filter((s) => marks.code.isInSet(s.marks)).length
  return n === 0 ? 'off' : n === hit.length ? 'on' : 'mixed'
}

/** The state of a non-empty range: each mark on, off or mixed over its characters (off when it has none), the level and blocks of the lines it touches, its font. */
export function rangeFormat(doc: PMNode, from: number, to: number, baseFont: FontId): FormatReadout {
  const { first, last } = linesOfSelection(doc, from, to)
  return formatOf(doc, from, to, first, last, baseFont)
}

/** The state of the whole box: all of its characters, and every line but an empty last one (see `lastBoxLine`). */
export function boxFormat(doc: PMNode, baseFont: FontId): FormatReadout {
  return formatOf(doc, 0, doc.content.size, 0, lastBoxLine(doc), baseFont)
}

/** The block controls for the whole box: inline code over all its characters, each block over every line. */
export function boxBlocks(doc: PMNode): BlockReadout {
  return { code: codeOf(doc, 0, doc.content.size), blocks: blocksOf(doc, 0, textblocksOf(doc).length - 1) }
}

/** The block controls while editing: for a caret, what the next typed character gets and the caret's line; for a range, its characters and the lines it touches. */
export function selectionBlocks(state: EditorState): BlockReadout {
  const $c = caretOf(state)
  if ($c) {
    const pending = pendingOf(state)
    const line = blockIndexAt(state.doc, $c.pos, false)
    const on = !$c.parent.type.spec.code && (pending?.code ?? naturalAtCaret(state).code)
    return { code: on ? 'on' : 'off', blocks: blocksOf(state.doc, line, line) }
  }
  const { from, to } = state.selection
  const { first, last } = linesOfSelection(state.doc, from, to)
  return { code: codeOf(state.doc, from, to), blocks: blocksOf(state.doc, first, last) }
}

/** The marks the next character typed at the caret would have without pending choices, with bold implied on a heading line. */
function naturalAtCaret(state: EditorState): Record<Mark | 'code', boolean> {
  const $c = caretOf(state)
  const set = $c ? $c.marks() : []
  const heading = $c?.parent.type === nodes.heading
  return {
    bold: heading || marks.bold.isInSet(set) !== undefined,
    italic: marks.italic.isInSet(set) !== undefined,
    underline: marks.underline.isInSet(set) !== undefined,
    strike: marks.strike.isInSet(set) !== undefined,
    code: marks.code.isInSet(set) !== undefined,
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
 * on a heading line cannot be changed (nor anything in a code block). Returns the new pending choices.
 */
export function togglePendingMark(state: EditorState, mark: Mark | 'code'): Pending | null {
  const pending = pendingOf(state)
  if ((mark === 'bold' && caretOnHeading(state)) || caretOf(state)?.parent.type.spec.code) return pending
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
 * characters (or only a code block's) changes nothing. True when anything changed.
 */
export function toggleRangeMark(tr: Transaction, from: number, to: number, mark: Mark | 'code'): boolean {
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

/** Sets the level (0: body text) of the lines `first` to `last` (a code block keeps its kind). A heading stores no bold, so bold marks in them go (`canonicalGuard`). True when anything changed. */
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
  return setLinesLevel(tr, 0, level === 0 ? textblocksOf(tr.doc).length - 1 : lastBoxLine(tr.doc), level)
}

/** A whole-box mark: on unless every character already has it (bold never changes in heading lines). */
export function toggleBoxMark(tr: Transaction, mark: Mark | 'code'): boolean {
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

// ---- blocks: lists, checklists, quotes, code blocks, dividers ---------------------------------------

/** The nearest list item around a position, as its type and depth; null outside every list. */
function itemAround($p: ResolvedPos): { type: NodeType; depth: number } | null {
  for (let d = $p.depth; d > 0; d--) if (isItemType($p.node(d).type)) return { type: $p.node(d).type, depth: d }
  return null
}

/** The selection's plain-text offsets, to put it back after a change that keeps the text (a structure change). */
function keepSelection(state: EditorState): (tr: Transaction) => Transaction {
  const { anchor, head } = state.selection
  const a = textOffsetAt(state.doc, anchor, anchor <= head ? 1 : -1)
  const h = textOffsetAt(state.doc, head, head < anchor ? 1 : -1)
  return (tr) => {
    const doc = tr.doc
    if (textblocksOf(doc).length === 0) return tr
    return tr.setSelection(TextSelection.create(doc, posAtTextOffset(doc, a), posAtTextOffset(doc, h)))
  }
}

/** The lines (textblocks) a selection touches, with their positions. */
function touchedLines(state: EditorState) {
  const { first, last } = linesOfSelection(state.doc, state.selection.from, state.selection.to)
  return textblocksOf(state.doc).slice(first, last + 1)
}

/** A code block as one paragraph per line of its text (the plain text does not change). */
function codeAsParagraphs(code: PMNode): PMNode[] {
  return code.textContent.split('\n').map((line) => nodes.paragraph.create(null, line ? textSchema.text(line) : null))
}

/** Every code block among `lines` (in `tr.doc` as it was when they were read) becomes paragraphs, from the last back. */
function codeToParagraphs(tr: Transaction, lines: ReadonlyArray<{ node: PMNode; pos: number }>) {
  for (const { node, pos } of [...lines].reverse()) {
    if (node.type !== nodes.codeBlock) continue
    tr.replaceWith(pos, pos + node.nodeSize, codeAsParagraphs(node))
  }
}

/**
 * Bullet list, numbered list or checklist on the lines the selection touches (outside an edit,
 * every line): off when every one of them is already in a list of that kind (each lifted one level
 * out of it); otherwise the lists they are in become that kind, or, when not every line is in a
 * list, the lines are put in a new list, one item each. The words stay as they are.
 */
export function toggleList(kind: 'bulletList' | 'orderedList' | 'taskList'): Command {
  return (state, dispatch) => {
    const listType = nodes[kind]
    const itemType = kind === 'taskList' ? nodes.taskItem : nodes.listItem
    const lines = touchedLines(state)
    if (lines.length === 0) return false
    const kinds = lines.map((t) => kindsOfLine(state.doc, t.pos))
    if (kinds.every((k) => k[kind])) return liftListItem(itemType)(state, dispatch)
    const inSomeList = kinds.every((k) => k.bulletList || k.orderedList || k.taskList)
    if (inSomeList) {
      // The nearest list of each line changes kind; the items too when checklist and list swap.
      const lists = new Map<number, PMNode>()
      for (const t of lines) {
        const $p = state.doc.resolve(t.pos + 1)
        for (let d = $p.depth - 1; d > 0; d--) {
          if (!isListType($p.node(d).type)) continue
          lists.set($p.before(d), $p.node(d))
          break
        }
      }
      const tr = state.tr
      for (const [pos, list] of [...lists].sort((a, b) => b[0] - a[0])) {
        if (list.type === listType) continue
        const items: PMNode[] = []
        list.forEach((item) => {
          items.push(item.type === itemType ? item : itemType.create(kind === 'taskList' ? { checked: false } : null, item.content))
        })
        tr.replaceWith(pos, pos + list.nodeSize, listType.create(kind === 'orderedList' ? { start: 1 } : null, items))
      }
      if (!tr.docChanged) return false
      dispatch?.(keepSelection(state)(tr))
      return true
    }
    return wrapInList(listType, kind === 'orderedList' ? { start: 1 } : null)(state, dispatch && ((tr) => dispatch(keepSelection(state)(tr))))
  }
}

/** Quote on the lines the selection touches: off when every one of them is in a quote (they leave the innermost one), otherwise they go into a new quote. */
export const toggleQuote: Command = (state, dispatch) => {
  const lines = touchedLines(state)
  if (lines.length === 0) return false
  const { $from, $to } = state.selection
  const keep = keepSelection(state)
  if (lines.every((t) => kindsOfLine(state.doc, t.pos).blockquote)) {
    const range = $from.blockRange($to, (n) => n.type === nodes.blockquote)
    const target = range && liftTarget(range)
    if (!range || target === null || target === undefined) return false
    dispatch?.(keep(state.tr.lift(range, target)))
    return true
  }
  const range = $from.blockRange($to)
  const wrapping = range && findWrapping(range, nodes.blockquote)
  if (!range || !wrapping) return false
  dispatch?.(keep(state.tr.wrap(range, wrapping)))
  return true
}

/**
 * Code block on the lines the selection touches: off when every one of them is a code block (each
 * line of their text becomes a paragraph); otherwise each of them becomes code, losing its marks and
 * heading, and code blocks side by side are joined into one, a line each. The plain text, and so
 * the selection, stays as it was.
 */
export const toggleCodeBlock: Command = (state, dispatch) => {
  const lines = touchedLines(state)
  if (lines.length === 0) return false
  const keep = keepSelection(state)
  const tr = state.tr
  if (lines.every((t) => t.node.type === nodes.codeBlock)) codeToParagraphs(tr, lines)
  else {
    for (const { node, pos } of [...lines].reverse()) {
      if (node.type !== nodes.codeBlock) tr.setBlockType(pos + 1, pos + 1, nodes.codeBlock)
    }
    // Neighbouring code blocks among the touched lines join into one, a line break between two,
    // from the last back (a join changes nothing before the earlier block of the pair).
    const first = lines[0]!.pos
    const last = lines[lines.length - 1]!.pos
    const blocks = textblocksOf(tr.doc).filter((t) => t.pos >= first && t.pos <= last)
    for (let i = blocks.length - 1; i > 0; i--) {
      const a = blocks[i - 1]!
      const b = blocks[i]!
      const aEnd = a.pos + a.node.nodeSize
      if (a.node.type !== nodes.codeBlock || b.node.type !== nodes.codeBlock || aEnd !== b.pos) continue
      tr.insertText('\n', aEnd - 1)
      tr.join(aEnd + 1)
    }
  }
  if (!tr.docChanged) return false
  dispatch?.(keep(tr).setMeta(META.levelsSet, true))
  return true
}

/**
 * A divider at the selection (replacing it): before the line when the caret is at its start, after
 * it at its end, splitting it in the middle, in place of an empty line. A line always follows it
 * (an empty paragraph when nothing else would), and the caret goes to the start of that line. Not
 * in a code block.
 */
export const insertDivider: Command = (state, dispatch) => {
  if (state.selection.$from.parent.type.spec.code || state.selection.$to.parent.type.spec.code) return false
  const tr = state.tr
  if (!state.selection.empty) tr.deleteSelection()
  const $c = tr.doc.resolve(tr.selection.from)
  if (!$c.parent.isTextblock || $c.depth === 0) return false
  const block = $c.parent
  const before = $c.before()
  let caret: number
  if (block.content.size === 0) {
    tr.replaceWith(before, before + block.nodeSize, [nodes.divider.create(), nodes.paragraph.create()])
    caret = before + 2
  } else if ($c.parentOffset === 0) {
    tr.insert(before, nodes.divider.create())
    caret = $c.pos + 1
  } else if ($c.parentOffset === block.content.size) {
    const after = $c.after()
    const next = tr.doc.resolve(after).nodeAfter
    tr.insert(after, next?.isTextblock ? [nodes.divider.create()] : [nodes.divider.create(), nodes.paragraph.create()])
    caret = after + 2
  } else {
    tr.split($c.pos)
    tr.insert($c.pos + 1, nodes.divider.create())
    caret = $c.pos + 3
  }
  dispatch?.(tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView())
  return true
}

/** Checks or unchecks the checklist item that starts at `pos` (the position before it). */
export function toggleTaskAt(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos)
    if (!node || node.type !== nodes.taskItem) return false
    dispatch?.(state.tr.setNodeMarkup(pos, undefined, { checked: node.attrs.checked !== true }))
    return true
  }
}

/** Tab in a list or checklist item: the items the selection touches go one level deeper. False when they cannot (the first item of a list) or the caret is not in an item. */
export const indentItem: Command = (state, dispatch) => {
  const item = itemAround(state.selection.$from)
  return item ? sinkListItem(item.type)(state, dispatch) : false
}

/** Shift+Tab in a list or checklist item: the items the selection touches go one level out (out of the list from the top level). */
export const outdentItem: Command = (state, dispatch) => {
  const item = itemAround(state.selection.$from)
  return item ? liftListItem(item.type)(state, dispatch) : false
}

/** The caret or selection is in a list or checklist item, where Tab and Shift+Tab indent and outdent. */
export function inListItem(state: EditorState): boolean {
  return itemAround(state.selection.$from) !== null
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
  const all = allText(state.doc)
  if (all) dispatch?.(state.tr.setSelection(all))
  return true
}

/**
 * The editing keys. Line levels after Enter, Backspace and Delete come from `lineLevels`, not
 * from the block types these commands choose. `Mod-Backspace` and `Mod-Delete` leave word
 * deletion to the browser. Esc, Tab, Ctrl/Cmd+B/I/U and the Backspace revert are handled by
 * the session before these.
 */
/** `cmd`, marking a transaction that replaces a non-empty selection with `text` (`META.replaced`). */
function replacing(cmd: Command, text: string): Command {
  return (state, dispatch, view) => {
    const meta = state.selection.empty ? null : replacedRange(state, text)
    return cmd(state, dispatch && ((tr) => dispatch(meta ? tr.setMeta(META.replaced, meta) : tr)), view)
  }
}

/** Enter: a line break; over a selection, styled as today (`META.replaced`). */
export const enterKey: Command = replacing(splitBlock, '\n')
/** Deleting a selection, styled as today (`META.replaced`). */
export const deleteSelected: Command = replacing(deleteSelection, '')

/** Enter on a line straight inside a list or checklist item: a new item after it (unticked); on an empty last line of an item, that item goes one level out (out of the list from the top level). */
const listEnter: Command = (state, dispatch, view) => {
  const { $from } = state.selection
  const item = itemAround($from)
  if (!item || $from.depth !== item.depth + 1 || !$from.parent.isTextblock) return false
  return chainCommands(splitListItem(item.type, item.type === nodes.taskItem ? { checked: false } : undefined), liftListItem(item.type))(state, dispatch, view)
}

/** Enter in a code block: a line break in the code; on its empty last line (Enter twice at the end), that line goes and a paragraph follows the block, with the caret. */
const codeEnter: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return false
  const code = $from.parent
  if (state.selection.empty && $from.parentOffset === code.content.size && code.textContent.endsWith('\n')) {
    const after = $from.after()
    const tr = state.tr.delete($from.pos - 1, $from.pos)
    const at = tr.mapping.map(after)
    tr.insert(at, nodes.paragraph.create())
    dispatch?.(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView())
    return true
  }
  return newlineInCode(state, dispatch)
}

/** Enter on an empty line straight inside a quote: the line leaves the quote. */
const quoteEnter: Command = (state, dispatch, view) => {
  const $c = caretOf(state)
  if (!$c || $c.parent.content.size > 0 || $c.depth < 2 || $c.node($c.depth - 1).type !== nodes.blockquote) return false
  return liftEmptyBlock(state, dispatch, view)
}

/**
 * Backspace at the very start of a line, where the line is a block of its own kind: the first line
 * of a list or checklist item goes one level out (out of the list from the top level); a code block
 * becomes paragraphs; the first line of a quote leaves it; a line just after a divider deletes the
 * divider. False anywhere else (then lines join as before).
 */
const blockStartBackspace: Command = (state, dispatch) => {
  const $c = caretOf(state)
  if (!$c || $c.parentOffset !== 0 || $c.depth === 0) return false
  const item = itemAround($c)
  if (item && $c.depth === item.depth + 1 && $c.index(item.depth) === 0) return liftListItem(item.type)(state, dispatch)
  if ($c.parent.type === nodes.codeBlock) {
    const tr = state.tr
    codeToParagraphs(tr, [{ node: $c.parent, pos: $c.before() }])
    dispatch?.(keepSelection(state)(tr).setMeta(META.levelsSet, true))
    return true
  }
  if ($c.node($c.depth - 1).type === nodes.blockquote && $c.index($c.depth - 1) === 0) {
    const range = $c.blockRange($c, (n) => n.type === nodes.blockquote)
    const target = range && liftTarget(range)
    if (!range || target === null || target === undefined) return false
    dispatch?.(state.tr.lift(range, target))
    return true
  }
  const before = $c.before()
  if (state.doc.resolve(before).nodeBefore?.type === nodes.divider) {
    dispatch?.(state.tr.delete(before - 1, before).scrollIntoView())
    return true
  }
  return false
}

/** Delete at the very end of a line just before a divider: the divider goes. */
const deleteDividerAfter: Command = (state, dispatch) => {
  const $c = caretOf(state)
  if (!$c || $c.depth === 0 || $c.parentOffset !== $c.parent.content.size) return false
  const after = $c.after()
  if (state.doc.resolve(after).nodeAfter?.type !== nodes.divider) return false
  dispatch?.(state.tr.delete(after, after + 1).scrollIntoView())
  return true
}

/**
 * Enter. On a selected divider: a paragraph after it (`createParagraphNear`). In a list item, a
 * code block or an empty line of a quote, as those blocks do (`listEnter`, `codeEnter`,
 * `quoteEnter`); everywhere else a line break as before.
 */
const enterAnywhere: Command = chainCommands(createParagraphNear, listEnter, codeEnter, quoteEnter, enterKey)
const backspace: Command = chainCommands(deleteSelected, blockStartBackspace, joinBackward, deleteCharBackward)

export const editKeys: Readonly<Record<string, Command>> = {
  Enter: enterAnywhere,
  'Shift-Enter': enterAnywhere,
  Backspace: backspace,
  'Shift-Backspace': backspace,
  Delete: chainCommands(deleteSelected, deleteDividerAfter, joinForward, deleteCharForward),
  'Mod-Backspace': chainCommands(deleteSelected, blockStartBackspace, joinBackward),
  'Mod-Delete': chainCommands(deleteSelected, deleteDividerAfter, joinForward),
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
  return textareaInputContent(old, baseFont, from, to, old.text.slice(0, from) + pasted + old.text.slice(to), from + pasted.length, pending)
}

/**
 * One input of today's canvas: its textarea, whose text was `old` with the selection
 * [selFrom, selTo) (UTF-16), now holds `nextText` with the caret at `caret`. The content it
 * leaves, styled exactly as Fabric's `onInput` and the editor's reading of it style it. An
 * IME composition is a sequence of these, one per update of the composed text, with the
 * selection collapsed at the end of the previous one (Fabric's `updateFromTextArea` in
 * composition mode).
 */
export function textareaInputContent(old: CompactContent, baseFont: FontId, selFrom: number, selTo: number, nextText: string, caret: number, pending: Pending | null): CompactContent {
  const from = selFrom
  const to = selTo
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

  // `onInput`: the textarea now holds the new text, its caret at `caret`.
  if (nextText === '') {
    // Fabric clears every style of an emptied text; the editor still carries the line's level.
    const headings = textAfterEdit(old.text, old.headings, '', caret).headings
    return { text: '', ...(headings && { headings }) }
  }
  const globalOf = (ls: string[][]) => ls.flatMap((gs, i) => (i === 0 ? gs : ['\n', ...gs]))
  const oldGlobal = globalOf(lines)
  const nextGlobal = globalOf(nextText.split('\n').map((l) => splitGraphemes(l)))
  const selStart = graphemeAt(from)
  const selEnd = graphemeAt(to)
  const caretG = splitGraphemes(nextText.slice(0, caret)).length
  let charDiff = nextGlobal.length - oldGlobal.length
  const selection = selStart !== selEnd
  const backDelete = selStart > caretG
  let removed: string[] | undefined
  if (selection) {
    removed = oldGlobal.slice(selStart, selEnd)
    charDiff += selEnd - selStart
  } else if (nextGlobal.length < oldGlobal.length) {
    removed = backDelete ? oldGlobal.slice(selEnd + charDiff, selEnd) : oldGlobal.slice(selStart, selStart - charDiff)
  }
  const inserted = nextGlobal.slice(caretG - charDiff, caretG)
  let copied: FabricStyle[] | undefined
  if (removed && removed.length > 0) {
    if (inserted.length > 0) {
      const { lineIndex, charIndex } = loc(selStart)
      const first = styles[lineIndex]?.[charIndex] ?? {}
      copied = inserted.map(() => first)
    }
    if (selection) removeStyleFromTo(selStart, selEnd)
    else if (backDelete) removeStyleFromTo(selEnd - removed.length, selEnd)
    else removeStyleFromTo(selEnd, selEnd + removed.length)
  }
  if (inserted.length > 0) insertNewStyleBlock(inserted, selStart, copied)

  // `readTextFormatting`: levels carried over, marks read from the styles.
  const edit = textAfterEdit(old.text, old.headings, nextText, caret)
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
