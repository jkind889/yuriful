import { chainCommands, createParagraphNear, deleteSelection, joinBackward, joinForward, liftEmptyBlock, newlineInCode, splitBlock } from 'prosemirror-commands'
import { closeHistory, isHistoryTransaction, redo, undo, undoDepth } from 'prosemirror-history'
import { Fragment, Mark as PMMark } from 'prosemirror-model'
import type { Node as PMNode, NodeType, ResolvedPos, Slice } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import { AllSelection, EditorState, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state'
import type { Command, Transaction } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep, Transform, canJoin, findWrapping, liftTarget } from 'prosemirror-transform'
import { DEFAULT_FONT, MARKS, canonicalTextFormatting, headingsAfterEdit, isHeadingLevel, markMask, spansFromCharStyles, splitGraphemes, textAfterEdit, withPendingMarks } from '../model/richText.ts'
import type { CharStyle, HeadingLevel, Mark, MarkState, PendingTextStyle, RangeFormat, TextFormatting } from '../model/richText.ts'
import { RUN_MARKS, blockOf, blockTypeFor, boxOf, contentFromDoc, docFromText, exceedsBounds, fontOf, isCompactDoc, isItemType, isListType, levelOf, marks, marksOfRun, nodes, plainTextOfDoc, posAtTextOffset, runKey, textOffsetAt, textSchema, textblocksOf } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import type { TextContent } from '../model/textDoc.ts'
import { blocksToLegacy, isListStart, legacyToBlocks, parseBlocks } from '../model/textDoc.ts'
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
  /**
   * The characters an input over a selection put in, as `{ from, to }` positions in the transaction's
   * document (`settleReplacement`): what a paste's formatting is given to, and nothing else.
   */
  inputRange: 'yuriful/inputRange',
  /** The transaction changes the blocks around the text but never a character of it (a block button): the text was not typed into. */
  keepsText: 'yuriful/keepsText',
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
 *   at it; up to the largest exactly representable whole number, as storage allows), `[]` or `[ ]` (unticked checklist item) or `[x]` (ticked) at the very start of the line;
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
    // Exactly the starts a stored numbered list accepts (`isListStart`); any other number stays as typed.
    const n = /^(\d+)\. $/.exec(head)
    if (n && isListStart(Number(n[1]))) return { kind: 'orderedList', start: Number(n[1]), end: caret }
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
 * with the caret at `caret`; `inCode`: the typed character is inline code; `isCode(i)`: the line's
 * UTF-16 unit `i` is inline code (asked only for the markers of a shortcut that otherwise matched,
 * so a keystroke that completes nothing never looks at the line's marks). Nothing fires in a code
 * block or for a character typed inside inline code; block shortcuts fire only where
 * `blockShortcutAllowed` says.
 */
function shortcutAt($at: ResolvedPos, line: string, caret: number, inserted: string, inCode: boolean, isCode: (unit: number) => boolean): AnyShortcut | null {
  // Nothing fires in a code block, nor for a character typed inside inline code: code is literal.
  if (!$at.parent.isTextblock || $at.parent.type.spec.code || inCode) return null
  // Nor when any of its marker characters is inline code: code characters never count as a marker.
  const anyCode = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (isCode(i)) return true
    return false
  }
  const block = matchBlockShortcut(line, caret, inserted)
  if (block) return blockShortcutAllowed(block, lineContext($at)) && !anyCode(0, block.end) ? { block } : null
  const sc = matchShortcut(line, caret, inserted) ?? matchCodeShortcut(line, caret, inserted)
  return sc && !sc.remove.some((r) => anyCode(r.start, r.end)) ? { line: sc } : null
}

/** Whether the UTF-16 unit `unit` of a textblock's text is inline code. */
function codeUnitAt(block: PMNode, unit: number): boolean {
  if (unit < 0 || unit >= block.content.size) return false
  const child = block.childAfter(unit).node
  return child !== null && marks.code.isInSet(child.marks) !== undefined
}

/** Whether inserting `text` at `from` (nothing replaced) would complete a typing shortcut. */
export function completesShortcut(state: EditorState, from: number, text: string): boolean {
  const $from = state.doc.resolve(from)
  if (!$from.parent.isTextblock) return false
  const line = $from.parent.textContent
  const off = $from.parentOffset
  const pending = pendingOf(state)
  const inCode = pending?.code ?? marks.code.isInSet($from.marks()) !== undefined
  const block = $from.parent
  const isCode = (i: number) => (i < off ? codeUnitAt(block, i) : i < off + text.length ? inCode : codeUnitAt(block, i - text.length))
  return shortcutAt($from, line.slice(0, off) + text + line.slice(off), off + text.length, text, inCode, isCode) !== null
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
  const found = shortcutAt($c, $c.parent.textContent, $c.parentOffset, inserted, typed ? marks.code.isInSet(typed.marks) !== undefined : false, (i) => codeUnitAt($c.parent, i))
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

/**
 * The lines a block button acts on while editing: those the selection touches (`linesOfSelection`);
 * none (null) when the selection holds no line at all, as when only a divider is selected.
 */
export function linesOfState(state: EditorState): { first: number; last: number } | null {
  const sel = state.selection
  if (sel instanceof NodeSelection && !sel.node.isTextblock) {
    let any = false
    sel.node.descendants((n) => {
      if (n.isTextblock) any = true
      return !any
    })
    if (!any) return null
  }
  return linesOfSelection(state.doc, sel.from, sel.to)
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
  const lines = linesOfState(state)
  if (!lines) return { code: 'off', blocks: Object.fromEntries(BLOCK_KINDS.map((k) => [k, 'off'])) as Record<BlockKind, MarkState> }
  return { code: codeOf(state.doc, from, to), blocks: blocksOf(state.doc, lines.first, lines.last) }
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

// ---- the block buttons: one rule for lists, quotes and code blocks ---------------------------------
//
// The rule: after a list, quote or code-block button, every selected line has that block (it was
// turned on) or none of them has it (it was turned off), so the button reads on or off, never mixed;
// and every line outside the selection keeps exactly the blocks it had (the same kinds of list,
// quote and code block around it, the same ticked state, the same text and marks). A line "has" a
// kind of list when its nearest list is of that kind, a quote when any quote is around it, a code
// block when it is one (`kindsOfLine`, what the controls read).
//
// To meet it whatever the shape, the document is read as a flat sequence of leaves (lines, and the
// dividers between them), each with the blocks around it, outermost first (`flatten`); a button
// changes only the selected lines' blocks; and the document is built again from the leaves
// (`rebuild`), consecutive leaves in the same quote, list and item sharing them as before. A line
// that leaves a list item an unselected line also belongs to leaves that item behind: the unselected
// line keeps its blocks, so the item may then start with a list.

type ContainerKind = 'bulletList' | 'orderedList' | 'taskList' | 'blockquote'

/** One level of blocks around a leaf: a quote, or a list together with the item the leaf is in. */
interface Frame {
  kind: ContainerKind
  /** The container (a list or a quote): leaves with the same id are in the same one. */
  id: number
  /** A list: the item the leaf is in (0 for a quote). */
  item: number
  checked: boolean
  start: number
  /** A numbered list's item as the text had it: the number it was painted with (null otherwise, or for an item a button made). */
  number: number | null
}

/** A leaf of the document (a line, or a divider) with the blocks around it, outermost first. */
interface Leaf {
  node: PMNode
  frames: Frame[]
  /** Its line index (textblocks only). */
  line: number | null
  /** It is a line the button acts on. */
  selected: boolean
  /** A divider that goes with the lines the button acts on (`toggleBlockKind`). */
  carried?: boolean
}

const frameKey = (f: Frame) => `${f.kind}:${f.id}:${f.item}`
const lastListIndex = (frames: readonly Frame[]) => {
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i]!.kind !== 'blockquote') return i
  return -1
}

/** Every leaf of a document, in order, with the blocks around it. */
function flatten(doc: PMNode, next: () => number): Leaf[] {
  const out: Leaf[] = []
  let line = 0
  const walk = (node: PMNode, frames: Frame[]) => {
    node.forEach((child) => {
      const t = child.type
      if (t === nodes.blockquote) walk(child, [...frames, { kind: 'blockquote', id: next(), item: 0, checked: false, start: 1, number: null }])
      else if (isListType(t)) {
        const id = next()
        const start = (child.attrs.start as number | undefined) ?? 1
        const numbered = t === nodes.orderedList
        child.forEach((item, _offset, index) =>
          walk(item, [...frames, { kind: t.name as ContainerKind, id, item: next(), checked: item.attrs.checked === true, start, number: numbered ? start + index : null }]),
        )
      } else out.push({ node: child, frames, line: child.isTextblock ? line++ : null, selected: false })
    })
  }
  walk(doc, [])
  return out
}

/** A numbered list would have to start at a number that cannot be stored (`isListStart`): the button changes nothing. */
class UnstorableStart extends Error {}

/**
 * The blocks of a sequence of leaves: consecutive leaves in the same container share it (and in a
 * list, consecutive leaves in the same item share the item). Every item of a numbered list keeps the
 * number it was painted with while its first line here is one the button does not act on: a part of
 * a list cut in two starts at its first item's number, and a list is cut where counting on would
 * paint such an item with another number. Other items count on from the item before (a new list from
 * 1). A start that cannot be stored throws `UnstorableStart`.
 */
function rebuild(leaves: readonly Leaf[], pinned?: ReadonlySet<number>): PMNode[] {
  /** For each numbered list, the number its next item would be painted with. */
  const counted = new Map<number, number>()
  const build = (group: readonly Leaf[], depth: number): PMNode[] => {
    const out: PMNode[] = []
    let i = 0
    while (i < group.length) {
      const f = group[i]!.frames[depth]
      if (!f) {
        out.push(group[i]!.node)
        i++
        continue
      }
      let j = i + 1
      while (j < group.length && group[j]!.frames[depth]?.id === f.id) j++
      const run = group.slice(i, j)
      if (f.kind === 'blockquote') out.push(nodes.blockquote.create(null, build(run, depth + 1)))
      else {
        const items: Array<{ node: PMNode; frame: Frame; kept: boolean }> = []
        let k = 0
        while (k < run.length) {
          const itemFrame = run[k]!.frames[depth]!
          let m = k + 1
          while (m < run.length && run[m]!.frames[depth]!.item === itemFrame.item) m++
          const content = build(run.slice(k, m), depth + 1)
          const node = f.kind === 'taskList' ? nodes.taskItem.create({ checked: itemFrame.checked }, content) : nodes.listItem.create(null, content)
          // Pinned by the item's first line (a divider at its start does not count), or for an item of
          // dividers only, by the divider staying where it is.
          const firstLine = run.slice(k, m).find((x) => x.line !== null)
          // (`pinned`: the lists whose items keep their numbers, whatever was acted on.)
          const kept = pinned ? pinned.has(f.id) : firstLine ? !firstLine.selected : !(run[k]!.selected || run[k]!.carried)
          items.push({ node, frame: itemFrame, kept: itemFrame.number !== null && kept })
          k = m
        }
        if (f.kind !== 'orderedList') out.push(nodes[f.kind].create(null, items.map((it) => it.node)))
        else {
          let start = items[0]!.frame.number ?? counted.get(f.id) ?? f.start
          let part: PMNode[] = []
          const close = () => {
            if (!isListStart(start)) throw new UnstorableStart()
            out.push(nodes.orderedList.create({ start }, part))
          }
          items.forEach((it, n) => {
            const painted = start + part.length
            if (n > 0 && it.kept && it.frame.number !== painted) {
              close()
              start = it.frame.number!
              part = []
            }
            part.push(it.node)
          })
          close()
          counted.set(f.id, start + part.length)
        }
      }
      i = j
    }
    return out
  }
  return build(leaves, 0)
}

/**
 * Marks the dividers that go with the lines a list or quote button acts on (`Leaf.carried`): one
 * inside the selected range, or one inside a list item (a quote, for Quote) whose lines are all
 * selected. A list button moves a divider only with its list item: one in no list stays where it is.
 */
function carryDividers(leaves: Leaf[], kind: BlockKind, span: { fromLine: number; toLine: number } | 'all') {
  // The range in leaves: after the line the selection starts in, before the line it ends in (the line
  // its end is at the start of included, so a divider just before it is inside the range).
  const leafOf = new Map<number, number>()
  leaves.forEach((l, i) => {
    if (l.line !== null) leafOf.set(l.line, i)
  })
  const lo = span === 'all' ? -1 : (leafOf.get(span.fromLine) ?? -1)
  const hi = span === 'all' ? leaves.length : (leafOf.get(span.toLine) ?? leaves.length)
  // For every container (by its depth and frame), how many lines it holds and how many are selected: one pass.
  const counts = new Map<string, { all: number; chosen: number }>()
  for (const m of leaves) {
    if (m.line === null) continue
    m.frames.forEach((f, d) => {
      const key = `${d}|${frameKey(f)}`
      const c = counts.get(key) ?? { all: 0, chosen: 0 }
      c.all++
      if (m.selected) c.chosen++
      counts.set(key, c)
    })
  }
  leaves.forEach((l, idx) => {
    if (l.line !== null || l.node.isTextblock) return
    // Its container: for a list button its list item; for Quote the innermost block around it (a list item or a quote).
    const depth = kind === 'blockquote' ? l.frames.length - 1 : lastListIndex(l.frames)
    if (kind !== 'blockquote' && depth < 0) return
    const inRange = idx > lo && idx < hi
    if (depth < 0) {
      l.carried = inRange
      return
    }
    // Inside the range it goes with the selected lines, unless its container is a list item that has
    // lines and none of them is selected (a divider that begins an unselected item stays with it).
    // Outside the range it goes only when every line of its container is selected.
    const c = counts.get(`${depth}|${frameKey(l.frames[depth]!)}`)
    const isItem = l.frames[depth]!.kind !== 'blockquote'
    l.carried = inRange ? !(isItem && c !== undefined && c.chosen === 0) : c !== undefined && c.all > 0 && c.chosen === c.all
  })
}

/** Whether a leaf has a kind of block, as the controls read it (`kindsOfLine`). */
function leafHas(l: Leaf, kind: BlockKind): boolean {
  if (kind === 'codeBlock') return l.node.type === nodes.codeBlock
  if (kind === 'blockquote') return l.frames.some((f) => f.kind === 'blockquote')
  const i = lastListIndex(l.frames)
  return i >= 0 && l.frames[i]!.kind === kind
}

const copyLeaf = (l: Leaf): Leaf => ({ ...l, frames: [...l.frames] })

/**
 * A list kind on: each selected line whose nearest list is of another kind gets a list of this kind
 * in that list's place (its item a new item of it), and each selected line in no list gets one around
 * it; selected lines next to each other in the same place share one list (an existing list of this
 * kind just before them included). "Next to each other" is at their own level in the same parent: a
 * line follows the last selected line in the same place when nothing comes between them but what is
 * nested in that line's item (a nested list, quote or code block), so `Album`, a nested `Track`, then
 * `Cover` stay one list. A selected line inside a converted item (a nested line) goes with it; an
 * unselected one stays where it was.
 */
function listOn(leaves: readonly Leaf[], selected: (l: Leaf) => boolean, kind: ContainerKind, next: () => number): Leaf[] {
  const out = leaves.map(copyLeaf)
  /** A list frame some selected line is nearest to (by its list and item) and what replaces it. */
  const replaced = new Map<string, Frame>()
  /** Lists of this kind that a selected line just before them joins, and the list they join. */
  const joined = new Map<number, number>()
  const target = (id: number): number => {
    let t = id
    while (joined.has(t)) t = joined.get(t)!
    return t
  }
  /** For each place (the blocks around a line's nearest list), the last selected line there: its index, its list now, and the item it was in. */
  const lastAt = new Map<string, { idx: number; list: number; item: string | null }>()
  out.forEach((l, idx) => {
    if (!selected(l) && !l.carried) return
    const i = lastListIndex(l.frames)
    const depth = i >= 0 ? i : l.frames.length
    const key = l.frames.slice(0, depth).map(frameKey).join('/')
    const item = i >= 0 ? frameKey(leaves[idx]!.frames[i]!) : null
    const last = lastAt.get(key)
    // Only what is nested in that line's item comes between (a line in no list has nothing nested).
    const joins = last !== undefined && (last.idx === idx - 1 || (last.item !== null && leaves.slice(last.idx + 1, idx).every((m) => m.frames[depth] !== undefined && frameKey(m.frames[depth]!) === last.item)))
    let list: number
    if (leafHas(l, kind)) {
      // Already in a list of this kind: a selected line before it in the same place, in another
      // list, makes them one list.
      list = target(l.frames[i]!.id)
      if (joins && target(last.list) !== list) joined.set(list, target(last.list))
      list = target(list)
    } else {
      const into = joins ? target(last.list) : next()
      if (i >= 0) {
        const k = frameKey(l.frames[i]!)
        if (!replaced.has(k)) replaced.set(k, { kind, id: into, item: next(), checked: false, start: 1, number: null })
        list = replaced.get(k)!.id
      } else {
        l.frames.push({ kind, id: into, item: next(), checked: false, start: 1, number: null })
        list = into
      }
    }
    lastAt.set(key, { idx, list, item })
  })
  const kept = out.map((l) => (selected(l) || l.carried ? { ...l, frames: l.frames.map((f) => (f.kind !== 'blockquote' && replaced.get(frameKey(f))) || f) } : l))
  if (joined.size === 0) return kept
  return kept.map((l) => ({ ...l, frames: l.frames.map((f) => (f.kind === kind && joined.has(f.id) ? { ...f, id: target(f.id) } : f)) }))
}

/** A list kind off: each selected line leaves every list of this kind it is nearest to, one after another outward. */
function listOff(leaves: readonly Leaf[], selected: (l: Leaf) => boolean, kind: ContainerKind): Leaf[] {
  return leaves.map((l) => {
    if (!selected(l) && !l.carried) return l
    const frames = [...l.frames]
    for (let i = lastListIndex(frames); i >= 0 && frames[i]!.kind === kind; i = lastListIndex(frames)) frames.splice(i, 1)
    return { ...l, frames }
  })
}

/**
 * A quote on: each run of selected lines next to each other that are in no quote goes into one new
 * quote, placed around the blocks those lines share (inside the innermost list item or quote they are
 * all in).
 */
function quoteOn(leaves: readonly Leaf[], selected: (l: Leaf) => boolean, next: () => number): Leaf[] {
  const out = leaves.map(copyLeaf)
  let i = 0
  while (i < out.length) {
    if (!(selected(out[i]!) || out[i]!.carried) || leafHas(out[i]!, 'blockquote')) {
      i++
      continue
    }
    let j = i + 1
    while (j < out.length && (selected(out[j]!) || out[j]!.carried) && !leafHas(out[j]!, 'blockquote')) j++
    const run = out.slice(i, j)
    let common = run[0]!.frames.length
    for (const l of run) {
      let k = 0
      while (k < common && k < l.frames.length && frameKey(l.frames[k]!) === frameKey(run[0]!.frames[k]!)) k++
      common = k
    }
    const quote: Frame = { kind: 'blockquote', id: next(), item: 0, checked: false, start: 1, number: null }
    for (const l of run) l.frames.splice(common, 0, quote)
    i = j
  }
  return out
}

/** A code block on: each selected line becomes one (losing its marks and heading); selected neighbours in the same place join into one, a line each. */
function codeOn(leaves: readonly Leaf[], selected: (l: Leaf) => boolean): Leaf[] {
  const out: Leaf[] = []
  let last: { leaf: Leaf; idx: number } | null = null
  leaves.forEach((l, idx) => {
    if (!selected(l)) {
      out.push(l)
      return
    }
    const text = l.node.textContent
    const same = last !== null && last.idx === idx - 1 && last.leaf.frames.map(frameKey).join('/') === l.frames.map(frameKey).join('/')
    if (same) {
      const joined = `${last!.leaf.node.textContent}\n${text}`
      last!.leaf.node = nodes.codeBlock.create(null, textSchema.text(joined))
      last = { leaf: last!.leaf, idx }
      return
    }
    const leaf: Leaf = { ...l, node: nodes.codeBlock.create(null, text ? textSchema.text(text) : null) }
    out.push(leaf)
    last = { leaf, idx }
  })
  return out
}

/** A code block off: each selected code block becomes one paragraph per line of its text, in the same place. */
function codeOff(leaves: readonly Leaf[], selected: (l: Leaf) => boolean): Leaf[] {
  return leaves.flatMap((l) => (selected(l) && l.node.type === nodes.codeBlock ? codeAsParagraphs(l.node).map((node) => ({ ...l, node })) : [l]))
}

/**
 * The document changed to `content` by replacing only the part that differs (from the first to the
 * last block that changes, or less), so that what is keyed to positions outside it is untouched; the
 * whole content only if ProseMirror could not fit that part exactly.
 */
function replaceChanged(state: EditorState, content: Fragment): Transaction {
  return replaceChangedIn(state.tr, content)
}

/** The document of `tr` made `content`, by replacing only the part that differs (`replaceChanged`). */
export function replaceDocument(tr: Transaction, content: Fragment): Transaction {
  return replaceChangedIn(tr, content)
}

/** `replaceChanged` on a transaction under way: its document becomes `content`, by steps added to it. */
function replaceChangedIn(tr: Transaction, content: Fragment): Transaction {
  const doc = tr.doc
  const old = doc.content
  const whole = () => new Transform(doc).replaceWith(0, old.size, content)
  let t: Transform
  const start = old.findDiffStart(content)
  const end = old.findDiffEnd(content)
  if (start === null || !end) t = whole()
  else {
    let { a: endA, b: endB } = end
    const overlap = start - Math.min(endA, endB)
    if (overlap > 0) {
      endA += overlap
      endB += overlap
    }
    const want = doc.copy(content)
    t = new Transform(doc).replace(start, endA, want.slice(start, endB))
    if (!t.doc.eq(want)) t = whole()
  }
  for (const step of t.steps) tr.step(step)
  return tr
}

/** Some line other than a code block holds a line break (ProseMirror's join of a code block's text into it): its lines are no longer its blocks. */
function breakOutsideCode(doc: PMNode): boolean {
  return textblocksOf(doc).some(({ node }) => !node.type.spec.code && node.textContent.includes('\n'))
}

/** What replaces a selection: typed (or composed) text, Enter, a pasted slice, or nothing (a deletion). */
export type ReplacementInput = { kind: 'text'; text: string } | { kind: 'enter' } | { kind: 'slice'; slice: Slice } | { kind: 'delete' }

/**
 * The selection `from` to `to` (positions in `tr.doc`, each in a line) deleted, its two ends joined
 * into one line of the first end's kind, in its place, whatever blocks they are in: the second end's
 * text after it goes onto the first line (as plain text into a code block, or out of one; a code
 * block's lines after its first stay a code block), the lines and dividers between go, and lines in
 * the second end's list item after it stay where they are, with their numbers. False when that could
 * not be built (nothing changed).
 */
function deleteAcrossLines(tr: Transaction, from: number, to: number): boolean {
  const doc = tr.doc
  const $from = doc.resolve(from)
  const $to = doc.resolve(to)
  if (!$from.parent.isTextblock || !$to.parent.isTextblock) return false
  if ($from.parent === $to.parent) {
    tr.delete(from, to)
    return true
  }
  let ids = 0
  const next = () => ++ids
  const leaves = flatten(doc, next)
  const tbs = textblocksOf(doc)
  const la = tbs.findIndex((t) => t.pos === $from.before())
  const lb = tbs.findIndex((t) => t.pos === $to.before())
  const ai = leaves.findIndex((l) => l.line === la)
  const bi = leaves.findIndex((l) => l.line === lb)
  if (ai < 0 || bi <= ai) return false
  const A = leaves[ai]!.node
  const B = leaves[bi]!.node
  const head = A.content.cut(0, $from.parentOffset)
  const tail = B.content.cut($to.parentOffset)
  const plain = (text: string) => (text ? Fragment.from(textSchema.text(text)) : Fragment.empty)
  let joined: PMNode
  let rest: PMNode | null = null
  try {
    if (A.type.spec.code) joined = A.type.createChecked(A.attrs, plain(head.textBetween(0, head.size) + tail.textBetween(0, tail.size)))
    else if (B.type.spec.code) {
      const [first = '', ...more] = tail.textBetween(0, tail.size).split('\n')
      joined = A.type.createChecked(A.attrs, head.append(plain(first)))
      if (more.length > 0) rest = B.type.create(B.attrs, plain(more.join('\n')))
    } else joined = A.type.createChecked(A.attrs, head.append(tail))
  } catch {
    return false
  }
  // Items keep the numbers they were painted with only in a list the second end is in and the first is
  // not (what is left of it stays a list of its own); the list the first end is in numbers on.
  const firstLists = new Set(leaves[ai]!.frames.filter((f) => f.kind !== 'blockquote').map((f) => f.id))
  const kept = new Set(leaves[bi]!.frames.filter((f) => f.kind !== 'blockquote' && !firstLists.has(f.id)).map((f) => f.id))
  const free = (l: Leaf): Leaf => ({ ...l, selected: !l.frames.some((f) => kept.has(f.id)) })
  const out: Leaf[] = [...leaves.slice(0, ai).map(free), { ...leaves[ai]!, node: joined, selected: true }]
  if (rest) out.push(free({ ...leaves[bi]!, node: rest }))
  out.push(...leaves.slice(bi + 1).map(free))
  let content: Fragment
  try {
    content = Fragment.fromArray(rebuild(out, kept))
  } catch (e) {
    if (e instanceof UnstorableStart) return false
    throw e
  }
  replaceChangedIn(tr, content)
  return true
}

/** A divider (or any block that is not a line) selected on its own. */
function selectedDivider(state: EditorState): NodeSelection | null {
  const sel = state.selection
  return sel instanceof NodeSelection && !sel.node.isTextblock ? sel : null
}

/**
 * An input over a selected divider: Backspace or Delete removes it and leaves the caret where it was
 * (at the start of the line after it, or the end of the one before); anything else puts a line in its
 * place holding the input (Enter, or the start of a composition: an empty line), with the caret after
 * it. Null when the result could not be stored.
 */
function replaceDivider(state: EditorState, sel: NodeSelection, input: ReplacementInput, valid: (doc: PMNode) => boolean): Transaction | null {
  const tr = state.tr
  if (input.kind === 'delete' && !dividerAlone(state, sel)) {
    tr.deleteRange(sel.from, sel.to)
    const at = Math.min(tr.mapping.map(sel.from), tr.doc.content.size)
    const $at = tr.doc.resolve(at)
    // A caret in a line (never the next divider): the start of the line after, or the end of the one before.
    const caret = Selection.findFrom($at, 1, true) ?? Selection.findFrom($at, -1, true)
    if (caret) tr.setSelection(caret)
  } else {
    tr.replaceWith(sel.from, sel.to, nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, sel.from + 1))
    if (input.kind === 'text' && input.text) tr.insertText(input.text)
    else if (input.kind === 'slice') tr.replaceSelection(input.slice)
  }
  return valid(tr.doc) && !breakOutsideCode(tr.doc) ? tr : null
}

/**
 * A selected divider with no line beside it to put the caret in once it goes: a divider on both
 * sides, or first or last with a divider next to it. Backspace or Delete then leave an empty line in
 * its place, with the caret (`replaceDivider`), so that what is typed next lands there.
 */
function dividerAlone(state: EditorState, sel: NodeSelection): boolean {
  const $d = state.doc.resolve(sel.from)
  const parent = $d.parent
  const i = $d.index()
  const before = i > 0 ? parent.child(i - 1) : null
  const after = i + 1 < parent.childCount ? parent.child(i + 1) : null
  const isDivider = (n: PMNode | null) => n !== null && n.type === nodes.divider
  return (before === null || isDivider(before)) && (after === null || isDivider(after)) && (isDivider(before) || isDivider(after))
}

/**
 * Shift+Left or Shift+Right with the selection's moving end at the edge of a line, a divider next to
 * that line: the selection reaches past the divider to the next place in a line (the browser's own
 * keys stop there; Shift+Up or Down and the mouse already cross it). With a divider itself selected
 * (clicked), the selection extends from it in that direction: from the line on its other side to the
 * next place past it (from the place just past it to the next character, when there is no line on its
 * other side). False otherwise: the browser moves it.
 */
function extendPastDivider(dir: 1 | -1): Command {
  return (state, dispatch) => {
    const sel = state.selection
    if (sel instanceof NodeSelection && sel.node.type === nodes.divider) {
      const behind = Selection.findFrom(state.doc.resolve(dir > 0 ? sel.from : sel.to), -dir, true)
      const beyond = Selection.findFrom(state.doc.resolve(dir > 0 ? sel.to : sel.from), dir, true)
      if (!beyond) return true // nothing in a line that way: the divider stays selected
      let anchor = behind ? behind.head : beyond.head
      let head = beyond.head
      if (!behind) {
        // No line on the divider's other side: the selection starts just past it and takes one character.
        const $b = state.doc.resolve(head)
        const room = dir > 0 ? $b.parent.content.size - $b.parentOffset : $b.parentOffset
        if (room === 0) return true
        anchor = head
        head += dir
      }
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)))
      return true
    }
    if (!(sel instanceof TextSelection)) return false
    const $head = sel.$head
    if (!$head.parent.isTextblock || $head.parentOffset !== (dir > 0 ? $head.parent.content.size : 0)) return false
    const edge = dir > 0 ? $head.after() : $head.before()
    const $edge = state.doc.resolve(edge)
    const next = dir > 0 ? $edge.nodeAfter : $edge.nodeBefore
    if (!next || next.type !== nodes.divider) return false
    const found = Selection.findFrom(state.doc.resolve(dir > 0 ? edge + next.nodeSize : edge - next.nodeSize), dir, true)
    if (!found) return false
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, sel.anchor, found.head)))
    return true
  }
}

/** Enter with a divider selected: an empty line in its place, with the caret (`replaceDivider`). */
const enterOverDivider: Command = (state, dispatch) => {
  const sel = selectedDivider(state)
  if (!sel) return false
  const tr = replaceDivider(state, sel, { kind: 'enter' }, (doc) => !exceedsBounds(doc, DEFAULT_FONT))
  if (tr && dispatch) dispatch(tr.scrollIntoView())
  return true
}

/**
 * A transaction that replaced the selection of `state` with `input` (typing, Enter, a paste, a
 * deletion), settled so that, whatever blocks the selection started in, ended in and crossed, the
 * text is the text before the selection, then the input, then the text after it, the record is one
 * that can be stored (`valid`), and the caret is collapsed right after the input. ProseMirror's own
 * replacement does that except across blocks that cannot hold each other's content: across a code
 * block and a line with marks it left two lines, the line break still there, and `insertText` then
 * left a selection over the typed text and that break (so each next key replaced the one before);
 * from a heading into a code block it put the code's line break inside the heading, a record that
 * cannot be stored, so the bounds refused the keystroke and the text typed was lost. Then the
 * replacement is made again from `state`: the selection deleted across its lines
 * (`deleteAcrossLines`), then the input at the caret. Returns `tr` when it was right (with its caret
 * collapsed), otherwise the new transaction, without the metadata `tr` carried (the caller adds it).
 */
export function settleReplacement(state: EditorState, tr: Transaction, input: ReplacementInput, valid: (doc: PMNode) => boolean): Transaction | null {
  const sel = state.selection
  // A text without blocks (paragraphs and headings, no inline code) is left exactly as ProseMirror
  // and the earlier canvas's rules leave it: transaction, selection and history.
  if (sel.empty || !tr.docChanged || isCompactDoc(state.doc)) return tr
  const divider = selectedDivider(state)
  if (divider) return replaceDivider(state, divider, input, valid)
  const range = replacedRange(state, '')
  // Where the selection started: its line's kind (a code block or not: a heading's level follows the
  // line-level rule, `lineLevels`) and the blocks around it, with a checklist item's tick and a
  // numbered item's painted number: the line the two ends become keeps them all.
  const kindAt = ($p: ResolvedPos, numbers = true) => {
    const parts = [$p.parent.type.spec.code ? 'code' : 'line']
    for (let d = 1; d < $p.depth; d++) {
      const n = $p.node(d)
      let part = n.type.name
      if (n.type === nodes.taskItem) part += n.attrs.checked ? ':ticked' : ':unticked'
      if (numbers && n.type === nodes.listItem && $p.node(d - 1).type === nodes.orderedList) part += `:${($p.node(d - 1).attrs.start as number) + $p.index(d - 1)}`
      parts.push(part)
    }
    return parts.join('/')
  }
  /** The position of the nearest list around a line (null in none): which list it is in. */
  const listOf = ($p: ResolvedPos): number | null => {
    for (let d = $p.depth - 1; d > 0; d--) if (isListType($p.node(d).type)) return $p.before(d)
    return null
  }
  /** The number of the item a line is in, in its nearest list when that list is numbered (null otherwise). */
  const numberOf = ($p: ResolvedPos): number | null => {
    for (let d = $p.depth - 1; d > 0; d--) {
      if (!isListType($p.node(d).type)) continue
      return $p.node(d).type === nodes.orderedList ? ($p.node(d).attrs.start as number) + $p.index(d) : null
    }
    return null
  }
  /** The positions of every list around a line. */
  const listsOf = ($p: ResolvedPos): Set<number> => {
    const out = new Set<number>()
    for (let d = $p.depth - 1; d > 0; d--) if (isListType($p.node(d).type)) out.add($p.before(d))
    return out
  }
  const startKind = kindAt(sel.$from)
  // Every line after the selection, which no input touches: its kind, blocks and tick; whether it is
  // in a list the line the selection started on is in (then it stays in it and is numbered as that
  // list goes on; otherwise it stays out of it and keeps the number it was painted with).
  const startLists = listsOf(sel.$from)
  const linesAfter = (doc: PMNode, from: number) =>
    textblocksOf(doc)
      .slice(from)
      .map(({ pos }) => {
        const $l = doc.resolve(pos + 1)
        return { kind: kindAt($l, false), number: numberOf($l), list: listOf($l) }
      })
  const tbsBefore = textblocksOf(state.doc)
  const endLine = tbsBefore.findIndex((t) => t.pos === sel.$to.before())
  const after = (endLine >= 0 ? linesAfter(state.doc, endLine + 1) : []).map((l) => ({ ...l, inStart: l.list === null ? startLists.size === 0 : startLists.has(l.list) }))
  const old = plainTextOfDoc(state.doc)
  const inserted = input.kind === 'text' ? input.text : input.kind === 'enter' ? '\n' : input.kind === 'slice' ? input.slice.content.textBetween(0, input.slice.content.size, '\n') : ''
  const meant = input.kind === 'enter' ? ['\n', ''] : [inserted]
  const settle = (t: Transaction) => {
    const now = plainTextOfDoc(t.doc)
    const which = meant.find((m) => now === old.slice(0, range.from) + m + old.slice(range.to))
    if (which === undefined || !valid(t.doc) || breakOutsideCode(t.doc)) return false
    // The line the two ends became is of the kind the selection started in, in its place (and is still
    // there). Enter is judged on its deletion (`enterOverItems`): after it, Enter's own rules at the
    // caret (an emptied item taken out a level) decide where that line sits.
    if (input.kind !== 'enter' && (textblocksOf(t.doc).length === 0 || kindAt(t.doc.resolve(posAtTextOffset(t.doc, range.from))) !== startKind)) return false
    // The lines after the selection keep their blocks and ticks, and stay in the list they were in:
    // in the joined line's list (numbered on from it), or out of it with their numbers (Enter: its own
    // rules may renumber them).
    if (input.kind !== 'enter') {
      const now2 = textblocksOf(t.doc)
      if (now2.length < after.length) return false
      const joinedLists = listsOf(t.doc.resolve(posAtTextOffset(t.doc, range.from)))
      const tail = linesAfter(t.doc, now2.length - after.length)
      const moved = tail.some((l, i) => {
        const was = after[i]!
        if (l.kind !== was.kind) return true
        const inJoined = l.list === null ? joinedLists.size === 0 : joinedLists.has(l.list)
        return was.inStart ? !inJoined : inJoined || l.number !== was.number
      })
      if (moved) return false
    }
    const caret = range.from + which.length
    if (!(t.selection.empty && textOffsetAt(t.doc, t.selection.head, -1) === caret) && textblocksOf(t.doc).length > 0) t.setSelection(TextSelection.create(t.doc, posAtTextOffset(t.doc, caret)))
    // The input's own characters, so that formatting given to them reaches nothing else (a rebuild replaces whole lines).
    if (textblocksOf(t.doc).length > 0) t.setMeta(META.inputRange, { from: posAtTextOffset(t.doc, range.from), to: posAtTextOffset(t.doc, caret) })
    return true
  }
  if (settle(tr)) return tr
  // From here on `tr` is known to be wrong: the replacement is made again, or refused whole (null).
  if (!(sel instanceof TextSelection)) return null
  const fresh = state.tr
  const marks = sel.$from.marksAcross(sel.$to) ?? []
  if (!deleteAcrossLines(fresh, sel.from, sel.to)) return null
  const at = posAtTextOffset(fresh.doc, range.from)
  fresh.setSelection(TextSelection.create(fresh.doc, at))
  if (input.kind === 'text' && input.text) {
    const $at = fresh.doc.resolve(at)
    fresh.insert(at, textSchema.text(input.text, $at.parent.type.spec.code ? [] : marks))
  } else if (input.kind === 'slice') fresh.replaceSelection(input.slice)
  else if (input.kind === 'enter') {
    enterAnywhere(EditorState.create({ doc: fresh.doc, selection: fresh.selection }), (t) => {
      for (const step of t.steps) fresh.step(step)
      fresh.setSelection(TextSelection.create(fresh.doc, t.selection.anchor, t.selection.head))
    })
  }
  return settle(fresh) ? fresh : null
}

/**
 * A list, quote or code-block button, by the rule above: off when every line concerned already has
 * the block, on otherwise. The lines concerned are those the selection touches (no line when only a
 * divider is selected: nothing changes); with `wholeBox`, every line of the text, empty ones and the
 * last included (a selected box). One transaction that keeps the text and the selection and changes
 * only the blocks that change. False when nothing would change, or when a numbered list would need a
 * start that cannot be stored.
 */
export function toggleBlockKind(kind: BlockKind, opts: { wholeBox?: boolean } = {}): Command {
  return (state, dispatch) => {
    const range = opts.wholeBox ? { first: 0, last: textblocksOf(state.doc).length - 1 } : linesOfState(state)
    if (!range || range.last < range.first) return false
    let ids = 0
    const next = () => ++ids
    const leaves = flatten(state.doc, next)
    for (const l of leaves) l.selected = l.line !== null && l.line >= range.first && l.line <= range.last
    if (kind !== 'codeBlock') carryDividers(leaves, kind, opts.wholeBox ? 'all' : { fromLine: range.first, toLine: blockIndexAt(state.doc, state.selection.to, false) })
    const selected = (l: Leaf) => l.selected
    const lines = leaves.filter(selected)
    if (lines.length === 0) return false
    const on = !lines.every((l) => leafHas(l, kind))
    let result: Leaf[]
    if (kind === 'codeBlock') result = on ? codeOn(leaves, selected) : codeOff(leaves, selected)
    else if (kind === 'blockquote') result = on ? quoteOn(leaves, selected, next) : leaves.map((l) => (selected(l) || l.carried ? { ...l, frames: l.frames.filter((f) => f.kind !== 'blockquote') } : l))
    else result = on ? listOn(leaves, selected, kind, next) : listOff(leaves, selected, kind)
    let content: Fragment
    try {
      content = Fragment.fromArray(rebuild(result))
    } catch (e) {
      if (e instanceof UnstorableStart) return false
      throw e
    }
    if (content.eq(state.doc.content)) return false
    if (dispatch) dispatch(keepSelection(state)(replaceChanged(state, content)).setMeta(META.levelsSet, true).setMeta(META.keepsText, true).scrollIntoView())
    return true
  }
}

/** `content` without bold (what a heading's text never stores). */
function withoutBold(content: Fragment): Fragment {
  const out: PMNode[] = []
  content.forEach((n) => out.push(n.isText ? n.mark(marks.bold.removeFromSet(n.marks)) : n))
  return Fragment.fromArray(out)
}

/**
 * Blocks pasted at the caret of `state` (a caret in a line that is not a code block), as one
 * transaction; null when the caret is not in a line or the result could not be stored (a list
 * would have to start past the largest number storage keeps). `pasted` is the pasted blocks, with
 * their marks already given. Where they land (plan Section 11, settled in Slice 3b):
 * - Pasted text that is one paragraph (or `inline`: a run copied from inside one line) joins the
 *   caret's line, as a plain paste does.
 * - Otherwise the caret's line is split around the paste: the text before the caret stays its line,
 *   of its kind, and the text after it becomes a line of the same kind after the paste (a new item
 *   of a list or checklist, unticked, like Enter, taking the rest of the caret's item with it). The
 *   existing line never takes the kind of a pasted block. A pasted first block that is a plain
 *   paragraph joins the text before the caret, and a pasted last one the text after it, as a plain
 *   paste of several lines does: both halves still keep the line's kind. At the start of a
 *   line no empty line is left before the paste, and at its end none after it.
 * - The pasted blocks go where the caret's line is: inside its list item or quote. Pasted items of a
 *   list of the same kind as the caret's list become items of that list (numbered on from there,
 *   the items after them numbered on too, as Enter does); any other pasted list nests in the item; a
 *   pasted quote inside a quote joins it.
 * - Lists the paste keeps apart stay apart. A pasted divider has no empty line after it, unless it is
 *   the last thing in the text, or was pasted on an empty line (which then stays after it): the caret goes there.
 * - The caret ends after the pasted text (or, after a final divider, at the start of the line after it).
 * - Yuriful's own copy across lines (`openStart`, `openEnd`: an edge of the copied selection fell
 *   inside a line): that partial first line joins the text before the caret and that partial last
 *   line the text after it, whatever kind of line they came from, taking the kind of the line they
 *   join. Every other copied line is placed as it stood relative to the first copied line, which
 *   stands where the caret's line is: in that line's item it goes in the caret's item; in another item of the same
 *   list it becomes an item of the caret's list with its tick; deeper blocks around it come too;
 *   blocks the joining line was in and it was not are left. The partial last line goes in its item
 *   of the caret's list in the same way when it was in another item of the anchor's list (the text
 *   after the caret goes with it), and otherwise in the line it joins. So a cut pasted back where it
 *   was gives back the text exactly, and the blocks too when the two ends of the cut were lines of
 *   one kind in the same blocks (a list's items aside). Whole lines of Yuriful's own copy pasted on
 *   an empty line in blocks of the same kinds as the first copied line's take that line's place the
 *   same way (where a cut of whole lines leaves the caret).
 */
export function pasteBlocks(state: EditorState, pasted: Fragment, opts: { inline?: boolean; openStart?: boolean; openEnd?: boolean; own?: boolean; continuesInto?: number; continuesList?: number; rest?: RestOfEnd; backInPlace?: boolean } = {}): Transaction | null {
  const $c = state.selection.$from
  if (!state.selection.empty || !$c.parent.isTextblock || $c.parent.type.spec.code) return null
  const tr = state.tr
  const single = pasted.childCount === 1 && pasted.firstChild!.type === nodes.paragraph
  if (single || opts.inline) {
    const content = Fragment.from(pasted.firstChild ? pasted.firstChild.content : Fragment.empty)
    tr.insert($c.pos, content)
    return tr.setSelection(TextSelection.create(tr.doc, $c.pos + content.size))
  }
  let ids = 0
  const next = () => ++ids
  const leaves = flatten(state.doc, next).map((l) => ({ ...l, selected: true }))
  const lineIdx = textblocksOf(state.doc).findIndex((t) => t.pos === $c.before())
  const li = leaves.findIndex((l) => l.line === lineIdx)
  if (li < 0) return null
  const L = leaves[li]!
  const leafAt: number[] = []
  state.doc.descendants((n, pos) => {
    if (n.isTextblock || n.type === nodes.divider) {
      leafAt.push(pos)
      return false
    }
    return true
  })
  const head = L.node.content.cut(0, $c.parentOffset)
  const tail = L.node.content.cut($c.parentOffset)
  const Lf = L.frames
  const k = lastListIndex(Lf)
  const inQuote = Lf.length > 0 && Lf[Lf.length - 1]!.kind === 'blockquote'
  const joinedItems = new Map<number, number>()
  const ownCopy = opts.own === true
  // Code lines are lines: an open edge in a code block takes only its own code line.
  const own = flatten(nodes.doc.create(null, ownCopy ? splitCodeEdges(pasted, opts.openStart === true, opts.openEnd === true) : pasted), next)
  const last = own.length - 1
  const openStart = ownCopy && opts.openStart === true && own.length >= 2 && own[0]!.node.isTextblock
  const openEnd = ownCopy && opts.openEnd === true && own.length >= 2 && own[last]!.node.isTextblock
  // A plain top-level paragraph at an end joins like plain text (and an open part-line always does).
  const plainPara = (i: number) => own[i]!.frames.length === 0 && own[i]!.node.type === nodes.paragraph
  const firstJoins = openStart || plainPara(0)
  const lastJoins = own.length >= 2 && (openEnd || plainPara(last))
  const sameFrame = (a: Frame | undefined, b: Frame | undefined) => a !== undefined && b !== undefined && a.kind === b.kind && a.id === b.id && a.item === b.item
  const sameItem = (f: Frame | undefined) => k >= 0 && sameFrame(f, Lf[k])
  const itemOf = (l: Leaf | undefined): { frame: Frame; depth: number } | null => {
    if (!l) return null
    const d = lastListIndex(l.frames)
    return d >= 0 ? { frame: l.frames[d]!, depth: d } : null
  }
  // Yuriful's own copy: copied items that hold a line joining at the caret go to the item of the line it
  // joins. The first copied line's item stands for the caret's item (when the first line joins, or the
  // last line shares its item, or whole lines are pasted where a cut of them left an empty line); the
  // last copied line's item, when it is another, for the continuation: what follows the caret.
  const firstItem = ownCopy ? itemOf(own[0]) : null
  const lastItem = ownCopy && lastJoins ? itemOf(own[last]) : null
  const sharedItem = firstItem !== null && lastItem !== null && sameFrame(firstItem.frame, lastItem.frame)
  // A whole first line pasted at the start of a line of its kind in blocks of the same kinds (where a cut of
  // it leaves the caret: that line holds what followed the cut, in the first line's blocks) takes that line's place.
  const inPlace = ownCopy && !firstJoins && head.size === 0 && own[0]!.node.isTextblock && own[0]!.node.type === L.node.type && own[0]!.node.attrs.level === L.node.attrs.level && own[0]!.frames.length === Lf.length && own[0]!.frames.every((f, i) => f.kind === Lf[i]!.kind)
  // The first copied line stands where the caret's line is when it joins it, when the last line shares its
  // item, or when whole lines are pasted where a cut of them left an empty line.
  // The continuation's item: the item the text after the caret came from when the paste over a selection
  // (or the cut just before it) left it behind, or else a new unticked one.
  // (Found by structure when the deletion's rest says the end item went on, `opts.rest`: the line after the
  // caret's is that rest; else from the mapped position.)
  const restNext = leaves[li + 1]?.frames[k]
  const intoFrame =
    k >= 0 && opts.rest && opts.rest.depth === k && opts.rest.item && restNext && restNext.kind === Lf[k]!.kind && restNext.id === Lf[k]!.id && restNext.item !== Lf[k]!.item
      ? restNext
      : opts.continuesInto !== undefined && k >= 0
        ? continuationItem(leafAt, leaves, li, Lf, k, opts.continuesInto)
        : null
  const contFrame: Frame | null = k >= 0 ? (intoFrame ?? { ...Lf[k]!, item: next(), checked: false, number: null }) : null
  // (Lines of one item pasted back exactly where they were copied or cut from, `opts.backInPlace`, stay in
  // that one item; anywhere else what follows the caret is a new unticked item, rule 6, whatever they came from.)
  const keepsItem = sharedItem && opts.backInPlace === true
  let continues = ownCopy && lastItem !== null && !keepsItem && contFrame !== null
  // The blocks the caret's line has inside its item (a quote in the item) come with the continuation, made anew.
  const contInner = k >= 0 ? Lf.slice(k + 1).map((f) => ({ ...f, id: next() })) : []
  /** The copied item whose frames are made unticked (the continuation's, when it goes back into its own list). */
  let untickKey: string | null = null
  const freshIds = new Map<number, number>()
  const freshItems = new Map<string, number>()
  const freshStarts = new Map<number, number>()
  const fresh = (f: Frame): Frame => {
    if (!freshIds.has(f.id)) {
      freshIds.set(f.id, next())
      // A numbered list made again starts at the number its first item here was painted with.
      freshStarts.set(f.id, f.kind === 'orderedList' && f.number !== null ? f.number : f.start)
    }
    const key = `${f.id}:${f.item}`
    if (f.kind !== 'blockquote' && !freshItems.has(key)) freshItems.set(key, next())
    return { ...f, id: freshIds.get(f.id)!, item: f.kind === 'blockquote' ? f.item : freshItems.get(key)!, start: freshStarts.get(f.id)!, number: null, ...(key === untickKey ? { checked: false } : {}) }
  }
  let siblings = false
  // What the deletion just before this paste left of the list (or the item) the last copied line came from,
  // a list of its own straight after the caret's line (W3): the last line's list, and its item when that item
  // went on, are that rest again, so the pasted lines and the rest are one list (and one item) once more.
  let restSeeded = false
  if (ownCopy && opts.rest && own[last] && li + 1 < leaves.length) {
    // (Found by structure: what follows the caret's line is what followed the last copied line, since the
    // deletion took everything between. A position mapped through the deletion only says that such a rest
    // exists: a rebuilt deletion maps it coarsely.) Every block around the last copied line, down to the one
    // the rest goes on in (`opts.rest.depth`), is that rest's block again; in the deepest, the item too only
    // when that item went on.
    const X = own[last]!.frames
    const R = leaves[li + 1]!.frames
    for (let i = 0; i <= opts.rest.depth && i < X.length; i++) {
      const xf = X[i]!
      const rf = R[i]
      if (!rf || rf.kind !== xf.kind) break
      const itemGoesOn = i < opts.rest.depth || opts.rest.item
      if (i < Lf.length && Lf[i]!.kind === rf.kind && Lf[i]!.id === rf.id) {
        // The caret's own block. Its next item holding the rest: the last whole line, an item of that list
        // here, goes back into it.
        if (xf.kind !== 'blockquote' && itemGoesOn && rf.item !== Lf[i]!.item && (i < opts.rest.depth || (!lastJoins && tail.size === 0))) {
          freshItems.set(`${xf.id}:${xf.item}`, rf.item)
          restSeeded = true
        }
        continue
      }
      freshIds.set(xf.id, rf.id)
      // (A list made again starts at the number its first pasted item was painted with: its start in the copy.)
      freshStarts.set(xf.id, xf.start)
      if (xf.kind !== 'blockquote' && itemGoesOn) freshItems.set(`${xf.id}:${xf.item}`, rf.item)
      restSeeded = true
    }
  }
  /** Another item of a list like the caret's: an item of the caret's list (`at` is the caret's list's frame), with its tick, numbered on. */
  const sibling = (at: Frame, xf: Frame): Frame => {
    siblings = true
    const key = `${xf.id}:${xf.item}`
    if (!freshItems.has(key)) freshItems.set(key, next())
    return { ...at, item: freshItems.get(key)!, checked: key === untickKey ? false : xf.checked, number: null }
  }
  /** Where pasted blocks went before Yuriful's own copy was laid along the caret's blocks (HTML from outside still does). */
  const placeAsBefore = (pl: Leaf): Frame[] => {
    const f0 = pl.frames[0]
    if (f0 && f0.kind !== 'blockquote' && k >= 0 && Lf[k]!.kind === f0.kind) {
      // Items of a list of the caret's list's kind: items of that list, after the caret's item.
      if (!joinedItems.has(f0.item)) joinedItems.set(f0.item, next())
      return [...Lf.slice(0, k), { ...f0, id: Lf[k]!.id, item: joinedItems.get(f0.item)!, start: Lf[k]!.start, number: null }, ...pl.frames.slice(1).map(fresh)]
    }
    if (f0 && f0.kind === 'blockquote' && inQuote) return [...Lf, ...pl.frames.slice(1).map(fresh)]
    return [...Lf, ...pl.frames.map(fresh)]
  }
  /** A line of Yuriful's own copy laid along the caret's blocks from the top: a quote in the caret's quote, an item of a list like the caret's as an item of it; another kind of block nests in the caret's block. */
  const alongTheCaret = (X: Leaf): Frame[] => {
    const base: Frame[] = []
    for (let d = 0; d < X.frames.length; d++) {
      const xf = X.frames[d]!
      if (d >= Lf.length || Lf[d]!.kind !== xf.kind) return d === 0 ? placeAsBefore(X) : [...Lf, ...X.frames.slice(d).map(fresh)]
      if (xf.kind === 'blockquote') {
        base.push(Lf[d]!)
        continue
      }
      return [...base, sibling(Lf[d]!, xf), ...X.frames.slice(d + 1).map(fresh)]
    }
    return [...Lf]
  }
  // Where the first copied line goes: where the caret's line is when it joins it, shares the last line's
  // item, or stands where a cut of whole lines left an empty line; else as its block, with the blocks
  // around it. Every other copied line goes where it stood relative to the first.
  const A = ownCopy && own[0]!.node.isTextblock ? own[0]! : null
  const itemAtCaret = ownCopy && k >= 0 && firstItem !== null && (firstJoins || keepsItem || inPlace)
  const AP: Frame[] | null = A ? (firstJoins || keepsItem || inPlace ? Lf : alongTheCaret(A)) : null
  /** The blocks of the copied line placed last (while they are placed in order). */
  let prevPlaced: Frame[] | null = null
  /** Where a copied line goes relative to the first copied line (`A`), whose blocks are `AP` here, matched from the innermost. */
  const relative = (X: Leaf): Frame[] => {
    const FA = A!.frames
    const P = AP!
    const off = FA.length - P.length
    let c = 0
    while (c < X.frames.length && c < FA.length && sameFrame(X.frames[c], FA[c])) c++
    const out: Frame[] = off < 0 ? P.slice(0, -off) : []
    for (let i = 0; i < c; i++) out.push(i - off >= 0 ? P[i - off]! : fresh(X.frames[i]!))
    const r0 = X.frames[c]
    const at = P[c - off]
    if (r0 && FA[c] && r0.kind !== 'blockquote' && r0.kind === FA[c]!.kind && r0.id === FA[c]!.id && at && at.kind === r0.kind) return [...out, sibling(at, r0), ...X.frames.slice(c + 1).map(fresh)]
    // Items of another copied list of the caret's list's kind, straight after pasted lines in the caret's list:
    // they join it too, numbered on (N1). (Not pasted back where they came from: there the lists are given back apart, N4.)
    // (At the depth the line would go to, in the caret's blocks down to there; also a copied list that stood
    // above the first line's, which then goes beside the caret's list.)
    const dOut = out.length
    const atCaret = Lf[dOut]
    if (!opts.backInPlace && r0 && r0.kind !== 'blockquote' && atCaret && atCaret.kind === r0.kind && out.every((x, i) => sameFrame(x, Lf[i])) && prevPlaced && prevPlaced[dOut]?.id === atCaret.id && prevPlaced[dOut]?.kind === atCaret.kind) return [...out, sibling(atCaret, r0), ...X.frames.slice(c + 1).map(fresh)]
    // Another item of the first line's list where that list is another kind than the one there: it nests in that item.
    if (r0 && FA[c] && r0.id === FA[c]!.id && at && at.kind !== r0.kind && at.kind !== 'blockquote') return [...P, ...X.frames.slice(c).map(fresh)]
    return [...out, ...X.frames.slice(c).map(fresh)]
  }
  // Where what follows the caret goes, when the last copied line joins it from an item: as a new unticked
  // item of the caret's list (rule 6), or, when the last line stood in a list of its own that has the
  // kinds of blocks of the caret's line, back into that list's item (made anew, unticked).
  const kindsOf = (fs: Frame[]) => fs.map((x) => x.kind).join('>')
  let relLast: Frame[] | null = null
  let backToOwnList = false
  if (continues && A && lastItem && opts.backInPlace === true) {
    // (A trial placement, leaving no trace: new lists are numbered from their first line in the copy's order.)
    const kept = [new Map(freshIds), new Map(freshItems), new Map(freshStarts), siblings] as const
    const rel = relative(own[last]!)
    freshIds.clear()
    kept[0].forEach((v, key) => freshIds.set(key, v))
    freshItems.clear()
    kept[1].forEach((v, key) => freshItems.set(key, v))
    freshStarts.clear()
    kept[2].forEach((v, key) => freshStarts.set(key, v))
    siblings = kept[3]
    if (kindsOf(rel) === kindsOf(Lf) && !(rel[k] && rel[k]!.id === Lf[k]!.id)) {
      if (!(restSeeded && opts.continuesInto !== undefined)) untickKey = `${lastItem.frame.id}:${lastItem.frame.item}`
      backToOwnList = true
      continues = false
    }
  }
  /** A whole line of Yuriful's own copy: as its block, with the blocks around it. */
  const placeOwn = (X: Leaf): Frame[] => {
    if (X === A) return AP!
    // In the first line's item, when that is the caret's: the caret's item; in the continuation's item: that item. Deeper blocks come too.
    if (itemAtCaret && firstItem && sameFrame(X.frames[firstItem.depth], firstItem.frame)) {
      const FA = own[0]!.frames
      const out = Lf.slice(0, k + 1)
      let i = firstItem.depth + 1
      for (; i < X.frames.length && sameFrame(X.frames[i], FA[i]) && Lf[k + i - firstItem.depth] && Lf[k + i - firstItem.depth]!.kind === X.frames[i]!.kind; i++) out.push(Lf[k + i - firstItem.depth]!)
      return [...out, ...X.frames.slice(i).map(fresh)]
    }
    if (continues && lastItem && sameFrame(X.frames[lastItem.depth], lastItem.frame)) return [...Lf.slice(0, k), contFrame!, ...X.frames.slice(lastItem.depth + 1).map(fresh)]
    // In another item of the first line's list, when the first line's item is the caret's: an item of the caret's
    // list (of its kind), numbered on, whatever blocks the first line had inside its item.
    const xi = itemAtCaret && firstItem ? X.frames[firstItem.depth] : undefined
    if (xi && firstItem && xi.kind === firstItem.frame.kind && xi.id === firstItem.frame.id && xi.item !== firstItem.frame.item && xi.kind === Lf[k]!.kind) return [...Lf.slice(0, k), sibling(Lf[k]!, xi), ...X.frames.slice(firstItem.depth + 1).map(fresh)]
    return A ? relative(X) : alongTheCaret(X)
  }
  const placed: Leaf[] = own.map((pl) => {
    const frames = ownCopy ? placeOwn(pl) : placeAsBefore(pl)
    prevPlaced = frames
    return { ...pl, frames, line: null, selected: true }
  })
  if (backToOwnList) relLast = relative(own[last]!)
  const out: Leaf[] = []
  let caret: { leaf: Leaf; offset: number } | null = null
  /** The line holding the text after the caret, once placed. */
  let tailHolder: Leaf | null = null
  // Both halves of the split line keep its kind (a heading its level; a heading stores no bold); words
  // from a code line keep the Mono font they were shown in.
  const ofLine = (content: Fragment) => L.node.type.create(L.node.attrs, L.node.type === nodes.heading ? withoutBold(content) : content)
  const words = (leaf: Leaf) => (leaf.node.type.spec.code ? inMono(leaf.node.content) : leaf.node.content)
  // What came before the caret in its item (the caret's line before it, or earlier lines of the item)
  // and what comes after it (the line after it, later lines of the item) are split apart when the line
  // is split, or when pasted items of the caret's list come between them: then what comes after is a
  // new unticked item, wherever in the item the caret was.
  const restOfItem = k >= 0 && leaves.slice(li + 1).some((l) => sameItem(l.frames[k]))
  const itemBefore = head.size > 0 || firstJoins || (k >= 0 && leaves.slice(0, li).some((l) => sameItem(l.frames[k])))
  // (Yuriful's own copy whose last part-line joins the text after the caret splits the line even at its end:
  // that part-line is what follows the caret, rule 6.)
  const lineSplit = (head.size > 0 || firstJoins) && (tail.size > 0 || (ownCopy && lastJoins))
  // (Pasted lines leave the caret's item when they go to another item of its list, or out of the list.)
  const leavesItem = k >= 0 && placed.slice(firstJoins ? 1 : 0, lastJoins ? placed.length - 1 : placed.length).some((pl) => !sameItem(pl.frames[k]))
  const itemSplit = (joinedItems.size > 0 || siblings || leavesItem) && itemBefore && (tail.size > 0 || restOfItem || lastJoins)
  const newItem = k >= 0 && (lineSplit || itemSplit) ? (contFrame ?? { ...Lf[k]!, item: next(), checked: false, number: null }) : null
  const tailFrames = newItem ? Lf.map((f, i) => (i === k ? newItem : f)) : Lf
  if (firstJoins) out.push({ ...L, node: ofLine(head.append(words(placed[0]!))) })
  else if (head.size > 0) out.push({ ...L, node: L.node.copy(head) })
  const middle = placed.slice(firstJoins ? 1 : 0, lastJoins ? placed.length - 1 : placed.length)
  out.push(...middle)
  const lastPlaced = placed[placed.length - 1]!
  if (lastJoins) {
    // The last pasted line joins the text after the caret, in the kind of that line: in the caret's item
    // when it shared the first line's item, in the continuation when it was in another item, else where
    // the split of the caret's line leaves it.
    // (Yuriful's own last part-line not in a list item goes where it stood relative to the first line when
    // that gives the blocks of the line it joins, such as another quote; else into that line's blocks.)
    const rel = ownCopy && A && lastItem === null ? relative(own[last]!) : null
    // (Inside the continuation's item, the last line's own blocks there, made anew as for the other lines from
    // them, when they are the kinds of the caret's: a quote it shares with earlier copied lines stays one quote.)
    const ownInner = continues && lastItem ? own[last]!.frames.slice(lastItem.depth + 1) : []
    const inner = continues && kindsOf(ownInner) === kindsOf(contInner) && ownInner.length > 0 ? ownInner.map(fresh) : contInner
    const frames = keepsItem && itemAtCaret ? Lf : relLast ? relLast : continues ? [...Lf.slice(0, k), contFrame!, ...inner] : rel && kindsOf(rel) === kindsOf(Lf) && !(newItem && sameItem(rel[k])) ? rel : tailFrames
    const leaf = tail.size > 0 || ownCopy ? { ...lastPlaced, node: ofLine(words(lastPlaced).append(tail)), frames } : lastPlaced
    if (tail.size > 0 || ownCopy) tailHolder = leaf
    out.push(leaf)
    caret = { leaf, offset: words(lastPlaced).size }
  } else {
    const lastOut = out[out.length - 1]
    if (lastOut && lastOut.node.isTextblock) caret = { leaf: lastOut, offset: lastOut === out[0] && firstJoins ? head.size + words(placed[0]!).size : lastOut.node.content.size }
    if (tail.size > 0) {
      // The text after the caret: a line of the caret line's kind.
      const leaf: Leaf = { ...L, node: L.node.type.create(L.node.attrs, tail), frames: tailFrames }
      tailHolder = leaf
      out.push(leaf)
      if (!caret) caret = { leaf, offset: 0 }
    }
  }
  // The rest of the caret's item goes with what came after the caret, when that went to another item
  // of the caret's list (with no text after the caret, to the new item when pasted items split the item).
  const held = tailHolder ? (tailHolder as Leaf).frames[k] : undefined
  // (When the deletion before this paste left what followed the last copied line, a whole line now in another
  // item of the caret's list, in the caret's item, that rest goes back into the last line's item.)
  const restAt = opts.continuesInto !== undefined && ownCopy && k >= 0 ? leafAt.findIndex((p) => p >= opts.continuesInto!) : -1
  const lastFrame = !lastJoins && ownCopy && k >= 0 ? lastPlaced.frames[k] : undefined
  // (The last line's item may be in the caret's list or in a list of its own, of the same kind, at the same depth.)
  // (The blocks around an item that takes the rest must be of the kinds around the caret's item: then the rest,
  // moved with its blocks, keeps its kind; they may be other blocks, as when the paste made new items around it.)
  const sameKindsTo = (fs: Frame[]) => k >= 0 && fs.length > k && fs.slice(0, k + 1).every((f, i) => f.kind === Lf[i]!.kind)
  const backToLast = restAt > li && sameItem(leaves[restAt]!.frames[k]) && lastFrame && !sameItem(lastFrame) && sameKindsTo(lastPlaced.frames) ? lastFrame : null
  // (What follows the caret may be in another item of the caret's list, or in an item of the last copied line's own
  // list, of the same kind at the same depth: the rest of the caret's item goes with it either way, rule 6.)
  const contFrames: Frame[] | null = backToLast
    ? lastPlaced.frames
    : !tailHolder
      ? newItem && [...Lf.slice(0, k), newItem]
      : held && !sameItem(held) && sameKindsTo((tailHolder as Leaf).frames)
        ? (tailHolder as Leaf).frames
        : null
  let after = leaves.slice(li + 1).map((l) => (contFrames && sameItem(l.frames[k]) ? { ...l, frames: [...contFrames.slice(0, k + 1), ...l.frames.slice(k + 1)] } : l))
  // The rest of the block the last copied line came from (`opts.rest`), which the deletion before this paste
  // joined to the caret's block (a quote's later lines to the caret's quote, say): it goes back with the line
  // that now ends the paste, into that line's block.
  if (ownCopy && opts.rest && (tailHolder || !lastJoins)) {
    const holder = (tailHolder as Leaf | null) ?? lastPlaced
    const j = opts.rest.depth
    const hf = holder.frames[j]
    const lf = Lf[j]
    const restItem = lf && lf.kind !== 'blockquote' ? opts.rest.item : true
    if (hf && lf && restItem && hf.kind === lf.kind && !sameFrame(hf, lf) && Lf.slice(0, j).every((f, i) => holder.frames[i] !== undefined && holder.frames[i]!.kind === f.kind)) {
      let run = true
      after = after.map((l) => {
        run = run && sameFrame(l.frames[j], lf)
        return run ? { ...l, frames: [...holder.frames.slice(0, j + 1), ...l.frames.slice(j + 1)] } : l
      })
    }
  }

  if (!caret) {
    // The paste ends with a divider. Pasted on an empty line, that line stays, after it, with the caret
    // (no line of the text goes); otherwise the caret goes to the start of the next line, or to a new
    // empty line at the end of the text.
    const nextLine = after.find((l) => l.node.isTextblock)
    if (head.size === 0 && !firstJoins && tail.size === 0) {
      const leaf: Leaf = { ...L, node: L.node.copy(Fragment.empty) }
      out.push(leaf)
      caret = { leaf, offset: 0 }
    } else if (nextLine) caret = { leaf: nextLine, offset: 0 }
    else {
      const leaf: Leaf = { node: nodes.paragraph.create(), frames: lastPlaced.frames, line: null, selected: true }
      out.push(leaf)
      caret = { leaf, offset: 0 }
    }
  }
  const all = [...leaves.slice(0, li), ...out, ...after]
  let content: Fragment
  try {
    content = Fragment.fromArray(rebuild(all))
  } catch (e) {
    if (e instanceof UnstorableStart) return null
    throw e
  }
  replaceChangedIn(tr, content)
  const line = all.slice(0, all.indexOf(caret.leaf)).filter((l) => l.node.isTextblock).length
  const at = textblocksOf(tr.doc)[line]
  if (!at) return null
  return tr.setSelection(TextSelection.create(tr.doc, at.pos + 1 + Math.min(caret.offset, at.node.content.size)))
}

/** `content`'s text in the Mono font (a code line's words arriving outside code, as they were shown). */
export function inMono(content: Fragment): Fragment {
  const mono = marks.font.create({ font: 'mono' })
  const out: PMNode[] = []
  content.forEach((n) => out.push(n.isText ? n.mark(mono.addToSet(marks.font.removeFromSet(n.marks))) : n))
  return Fragment.fromArray(out)
}

/**
 * Yuriful's own copy with an open edge in a code block: the code line at that edge on its own (a
 * code block of that one line, which joins the line it is pasted into), the rest of the code block as
 * its block. Inside a code block each code line is a line.
 */
function splitCodeEdges(content: Fragment, start: boolean, end: boolean): Fragment {
  if (!start && !end) return content
  const tr = EditorState.create({ doc: nodes.doc.create(null, content) }).tr
  const at = (which: 'first' | 'last') => {
    const lines = textblocksOf(tr.doc)
    return which === 'first' ? lines[0] : lines[lines.length - 1]
  }
  const first = at('first')
  if (start && first && first.node.type.spec.code && first.node.textContent.includes('\n')) {
    const pos = first.pos + 1 + first.node.textContent.indexOf('\n')
    tr.delete(pos, pos + 1).split(pos)
  }
  const lastLine = at('last')
  if (end && lastLine && lastLine.node.type.spec.code && lastLine.node.textContent.includes('\n')) {
    const pos = lastLine.pos + 1 + lastLine.node.textContent.lastIndexOf('\n')
    tr.delete(pos, pos + 1).split(pos)
  }
  return tr.doc.content
}

/**
 * What a deletion of `state`'s selection leaves of the blocks around the line it ends in: the deepest of
 * them (as `flatten`'s frames count them: a list with its item, a quote) that holds more after that line
 * and that the selection did not start in (`depth`), and whether, for a list, its item goes on (`item`) or
 * only the list. The rest stays where it was, after the caret; pasted back, the copied lines' blocks are that
 * rest's again (`pasteBlocks`' `rest`). Undefined when nothing of them is left.
 */
export interface RestOfEnd {
  depth: number
  item: boolean
}
export function restOfEnd(state: EditorState): RestOfEnd | undefined {
  const { $from, $to } = state.selection
  if (!$to.parent.isTextblock) return undefined
  // The frame index of each depth: lists and quotes have one (an item is its list's).
  const frameAt: number[] = []
  let n = -1
  for (let d = 1; d < $to.depth; d++) {
    const t = $to.node(d).type
    if (isListType(t) || t === nodes.blockquote) n++
    frameAt[d] = n
  }
  for (let d = $to.depth - 1; d > 0; d--) {
    const node = $to.node(d)
    if (d <= $from.depth && $from.node(d) === node) return undefined
    if ($to.index(d) < node.childCount - 1) return { depth: frameAt[d]!, item: isItemType(node.type) }
  }
  return undefined
}

/**
 * Where the rest of the item a deletion of `state`'s selection ends in will be (`mapping` is the
 * deletion's): the position after the line the selection ends in, mapped; when that item holds more
 * after that line and the selection did not start in it. The text after the caret then came from that
 * item, and its continuation goes back into it (`pasteBlocks`' `continuesInto`).
 */
export function restOfEndItem(state: EditorState, mapping: { map: (pos: number, assoc?: number) => number }): number | undefined {
  const { $from, $to } = state.selection
  for (let d = $to.depth - 1; d > 0; d--) {
    const item = $to.node(d)
    if (!isItemType(item.type)) continue
    if (d <= $from.depth && $from.node(d) === item) return undefined
    if ($to.index(d) >= item.childCount - 1) return undefined
    return mapping.map($to.after(d + 1), 1)
  }
  return undefined
}

/**
 * Where the rest of the list a deletion of `state`'s selection ends in will be: the position of the
 * item after the one the selection ends in, mapped; when the selection takes that item to its end, the
 * list holds more items, and the selection did not start in that list. (The rest stays a list of its own;
 * pasted back, the copied items join it, `pasteBlocks`' `continuesList`.)
 */
export function restOfEndList(state: EditorState, mapping: { map: (pos: number, assoc?: number) => number }): number | undefined {
  const { $from, $to } = state.selection
  for (let d = $to.depth - 1; d > 0; d--) {
    const item = $to.node(d)
    if (!isItemType(item.type)) continue
    if ($to.index(d) < item.childCount - 1) return undefined
    const list = $to.node(d - 1)
    if (d - 1 <= $from.depth && $from.node(d - 1) === list) return undefined
    if ($to.index(d - 1) >= list.childCount - 1) return undefined
    return mapping.map($to.after(d), 1)
  }
  return undefined
}

/**
 * The frame of the item of the caret's list that holds the line at `pos` (where the text after the
 * caret came from: the rest of its item, left behind by the deletion just before), when that is the
 * item straight after the caret's item; null otherwise.
 */
function continuationItem(leafAt: number[], leaves: Leaf[], li: number, Lf: Frame[], k: number, pos: number): Frame | null {
  const at = leafAt.findIndex((p) => p >= pos)
  if (at <= li) return null
  // Only the item straight after the caret's item (its rest aside).
  for (let i = li + 1; i < at; i++) {
    const f = leaves[i]!.frames[k]
    if (!f || f.kind !== Lf[k]!.kind || f.id !== Lf[k]!.id || f.item !== Lf[k]!.item) return null
  }
  const f = leaves[at]!.frames[k]
  return f && f.kind === Lf[k]!.kind && f.id === Lf[k]!.id && f.item !== Lf[k]!.item ? f : null
}

/**
 * A whole-box formatting command on a stored text (a selected box, not being edited): its document
 * changed by `change` (a transaction on the whole document) and by `command` (run as in an edit
 * with all the text selected, or acting on every line itself), its box formatting by `box`; the
 * canonical record after it (`contentFromDoc`). Null when that is what the text already was, or
 * when the result is over a bound a load enforces (a list around lines already nested to the depth
 * bound): nothing changes, records or saves, exactly as the edit session refuses it.
 */
export function boxCommandContent(
  source: TextSource,
  edits: { change?: (tr: Transaction) => unknown; box?: (fmt: TextFormatting) => TextFormatting; command?: Command },
): TextContent | null {
  const read = docFromText(source)
  if (!read) return null
  const before = contentFromDoc(read.doc, read.box)
  let doc = read.doc
  if (edits.change) {
    const tr = EditorState.create({ doc: read.doc }).tr
    edits.change(tr)
    doc = tr.doc
  }
  if (edits.command) {
    const state = EditorState.create({ doc: read.doc, selection: allText(read.doc) ?? undefined })
    edits.command(state, (tr) => {
      doc = tr.doc
    })
  }
  const nextBox = edits.box ? boxOf(edits.box(read.box)) : read.box
  if (exceedsBounds(doc, nextBox.font ?? 'sans')) return null
  const after = contentFromDoc(doc, nextBox)
  return JSON.stringify(after) === JSON.stringify(before) ? null : after
}

/** Bullet list, numbered list or checklist (`toggleBlockKind`). */
export const toggleList = (kind: 'bulletList' | 'orderedList' | 'taskList'): Command => toggleBlockKind(kind)
/** Quote (`toggleBlockKind`). */
export const toggleQuote: Command = toggleBlockKind('blockquote')
/** Code block (`toggleBlockKind`). */
export const toggleCodeBlock: Command = toggleBlockKind('codeBlock')

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
 * Enter. On a selected divider: a paragraph after it (`createParagraphNear`). Over a selection that
 * reaches into a list item from another line, the selection goes first (`enterOverItems`). In a code
 * block (wherever it sits, a list item too), a list item or an empty line of a quote, as those
 * blocks do (`codeEnter` before `listEnter`, `quoteEnter`); everywhere else a line break as before.
 */
const enterAnywhere: Command = chainCommands(enterOverDivider, createParagraphNear, enterOverItems, codeEnter, listEnter, quoteEnter, enterKey)

/**
 * Enter over a selection that reaches into a list item from another line (across items, or from a
 * line outside the list): the selection is deleted, then Enter acts at the caret it leaves, as it
 * would there (`enterAnywhere`), in the same transaction. Without this, a split inside a list item
 * would refuse a selection that does not lie in one line.
 */
function enterOverItems(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, $to, empty } = state.selection
  // Over a selection across lines in a text with blocks (in a text without them, only from or into a list item, which it never has).
  if (empty || $from.sameParent($to) || (!itemAround($from) && !itemAround($to) && isCompactDoc(state.doc))) return false
  if (!dispatch) return true
  const tr = settleReplacement(state, state.tr.deleteSelection(), { kind: 'delete' }, (doc) => !exceedsBounds(doc, DEFAULT_FONT))
  if (!tr) return true // the deletion cannot be stored: Enter changes nothing
  const sub = EditorState.create({ doc: tr.doc, selection: tr.selection })
  enterAnywhere(sub, (t) => {
    for (const step of t.steps) tr.step(step)
    tr.setSelection(TextSelection.create(tr.doc, t.selection.anchor, t.selection.head))
  })
  dispatch(tr.scrollIntoView())
  return true
}
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
  'Shift-ArrowLeft': extendPastDivider(-1),
  'Shift-ArrowRight': extendPastDivider(1),
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
