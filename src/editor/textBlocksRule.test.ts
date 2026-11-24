import { describe, expect, it, vi } from 'vitest'
import { DOMSerializer, Fragment, Slice as SliceClass } from 'prosemirror-model'
import type { Node as PMNode, Slice } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import type { MarkState } from '../model/richText.ts'
import { canonicalTextContent, MAX_BLOCK_DEPTH, MAX_LIST_START, MAX_TEXT_LENGTH, parseBlocks } from '../model/textDoc.ts'
import type { BlockNode, InlineRun } from '../model/types.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { EditSession } from './textSession.ts'
import { docFromBlocks, docFromText, exceedsBounds, isItemType, isListType, nodes, plainTextOfDoc, posAtTextOffset, textSchema, textblocksOf } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import { markdownToBlocks } from '../model/markdownPaste.ts'
import { htmlToBlocks } from './pasteHtml.ts'
import { BLOCK_KINDS, META, boxBlocks, boxCommandContent, completesShortcut, linesOfSelection, settleReplacement, shortcutTransaction, toggleBlockKind } from './textRules.ts'
import type { BlockKind, ReplacementInput } from './textRules.ts'
import { insert, open, press, type } from './testing/textHarness.ts'

// The randomised tests here take about two seconds each on an idle machine and several times that
// while other work is running: they are never to fail for being slow.
vi.setConfig({ testTimeout: 60_000 })

/**
 * The rule of the block buttons (lists, quote, code block), pinned by fixed cases and a seeded
 * randomised test: after a button is pressed, every selected line has that block (it was turned on)
 * or none of them has it (it was turned off), so the button reads on or off, never mixed; every
 * line outside the selection keeps exactly the blocks it had (the kinds of list, quote and code block
 * around it, its ticked state, the number it is painted with, its text, marks and fonts); selected
 * lines keep their text, marks, fonts and ticks; with no line selected nothing changes; and a change
 * refused for a stored bound changes nothing at all. One in-edit undo gives back the stored record
 * exactly. Also: S1 to S5, R1 (a refused composition takes back only itself), R3 (code characters
 * never count as a marker) and fonts in a code block (R5).
 */

const p = (text?: string, extra: Partial<InlineRun> = {}): BlockNode => (text ? { type: 'paragraph', content: [{ text, ...extra }] } : { type: 'paragraph' })
const list = (kind: 'bulletList' | 'orderedList' | 'taskList', ...items: BlockNode[][]): BlockNode =>
  kind === 'taskList' ? { type: 'taskList', items: items.map((blocks) => ({ checked: false, blocks })) } : { type: kind, items: items.map((blocks) => ({ blocks })) }
const numbered = (start: number, ...items: BlockNode[][]): BlockNode => ({ type: 'orderedList', start, items: items.map((blocks) => ({ blocks })) })
const quote = (...blocks: BlockNode[]): BlockNode => ({ type: 'blockquote', blocks })
const LIST_KINDS = ['bulletList', 'orderedList', 'taskList'] as const

/**
 * One line as the rule sees it: the blocks around it, outermost first (with a checklist item's
 * tick), what it is, its text, its marks and fonts, and the number it is painted with (the first
 * line of a numbered list's item; null otherwise).
 */
interface LineFacts {
  around: string[]
  kind: string
  text: string
  runs: string
  painted: number | null
}

function lineFacts(doc: PMNode): LineFacts[] {
  return textblocksOf(doc).map(({ node, pos }) => {
    const $p = doc.resolve(pos + 1)
    const around: string[] = []
    for (let d = 1; d < $p.depth; d++) {
      const n = $p.node(d)
      if (n.type === nodes.blockquote) around.push('quote')
      else if (isListType(n.type)) around.push(n.type.name)
      else if (n.type === nodes.taskItem) around.push(n.attrs.checked ? 'ticked' : 'unticked')
    }
    const d = $p.depth - 1
    const painted = d >= 2 && $p.node(d).type === nodes.listItem && $p.index(d) === 0 && $p.node(d - 1).type === nodes.orderedList ? ($p.node(d - 1).attrs.start as number) + $p.index(d - 1) : null
    return { around, kind: node.type === nodes.heading ? `h${node.attrs.level}` : node.type.name, text: node.textContent, runs: JSON.stringify(node.content.toJSON()), painted }
  })
}

/** The lists of a document none of whose lines (by index) is in `selected`. */
function untouchedLists(doc: PMNode, selected: ReadonlySet<number>): Array<{ node: PMNode; line: number; level: number }> {
  const lineAt = new Map(textblocksOf(doc).map((t, i) => [t.pos, i]))
  const out: Array<{ node: PMNode; line: number; level: number }> = []
  doc.descendants((n, pos) => {
    if (!isListType(n.type)) return true
    let any = false
    let line = -1
    n.descendants((c, rel) => {
      if (!c.isTextblock) return true
      const i = lineAt.get(pos + 1 + rel)!
      if (line < 0) line = i
      if (selected.has(i)) any = true
      return !any
    })
    const $n = doc.resolve(pos)
    let level = 0
    for (let d = 1; d <= $n.depth; d++) if (isListType($n.node(d).type)) level++
    // (A list of dividers only has no line to find it by.)
    if (!any && line >= 0) out.push({ node: n, line, level })
    return true
  })
  return out
}

/** How many lists there are at each level of nesting (lists inside lists), outermost first. */
function listsPerLevel(doc: PMNode): number[] {
  const out: number[] = []
  const walk = (node: PMNode, level: number) => {
    node.forEach((c) => {
      if (isListType(c.type)) {
        out[level] = (out[level] ?? 0) + 1
        walk(c, level + 1)
      } else walk(c, level)
    })
  }
  walk(doc, 0)
  return Array.from(out, (n) => n ?? 0)
}

/** Whether a line has a kind of block, as the controls read it. */
function has(f: LineFacts, kind: BlockKind): boolean {
  if (kind === 'codeBlock') return f.kind === 'codeBlock'
  if (kind === 'blockquote') return f.around.includes('quote')
  const lists = f.around.filter((a) => (LIST_KINDS as readonly string[]).includes(a))
  return lists[lists.length - 1] === kind
}

/** The tick of a line's checklist item when its nearest list is a checklist. */
function tickOf(f: LineFacts): string | null {
  if (!has(f, 'taskList')) return null
  return f.around[f.around.lastIndexOf('taskList') + 1] ?? null
}

/** The lists and quotes around a line. */
const containers = (f: LineFacts) => f.around.filter((a) => a === 'quote' || (LIST_KINDS as readonly string[]).includes(a)).length

/** The content now, checked to be what a load gives back. */
function content(s: EditSession): TextContent {
  const c = s.content()
  expect(canonicalTextContent(c as unknown as Record<string, unknown>)).toStrictEqual(c)
  return c
}

/** The text of a record with its line breaks as one "\n" each (a stored "\r\n" text keeps them until it becomes rich). */
const lf = (text: string) => text.replace(/\r\n/g, '\n')

/**
 * Whether the test itself shows that pressing `kind` on these lines may be refused for a stored
 * bound: turning a list or quote on around a line already at the depth bound, or a numbered list
 * whose numbers come near the largest start that can be stored.
 */
function mayBeRefused(doc: PMNode, selected: readonly LineFacts[], kind: BlockKind, on: boolean): boolean {
  if (on && kind !== 'codeBlock' && selected.some((f) => containers(f) >= MAX_BLOCK_DEPTH - 1)) return true
  let near = false
  doc.descendants((n) => {
    if (n.type === nodes.orderedList && (n.attrs.start as number) + n.childCount > MAX_LIST_START - 50) near = true
    return !near
  })
  return near
}

interface Press {
  kind: BlockKind
  beforeDoc: PMNode
  before: TextContent
  /** The lines the button acts on; null when no line is selected (only a divider). */
  lines: { first: number; last: number } | null
  changed: boolean
  after: TextContent
  afterDoc: PMNode
  readout: MarkState
  /** The line the selection's end is in (at the start of it included); `all` for the selected box. */
  toLine?: number | 'all'
}

/** Each divider of a document, in order: how many lines come before it, the lines of its list item and of its innermost block (null when in none), and the blocks around it. */
function dividerFacts(doc: PMNode): Array<{ linesBefore: number; item: number[] | null; inner: number[] | null; innerIsItem: boolean; quote: boolean; list: string | null }> {
  const tbs = textblocksOf(doc)
  const linesIn = (from: number, to: number) => tbs.flatMap((t, i) => (t.pos >= from && t.pos < to ? [i] : []))
  const out: Array<{ linesBefore: number; item: number[] | null; inner: number[] | null; innerIsItem: boolean; quote: boolean; list: string | null }> = []
  doc.descendants((n, pos) => {
    if (n.type !== nodes.divider) return true
    const $p = doc.resolve(pos)
    let item: number[] | null = null
    let inner: number[] | null = null
    let innerIsItem = false
    let quote = false
    let list: string | null = null
    for (let d = $p.depth; d > 0; d--) {
      const a = $p.node(d)
      const span = () => linesIn($p.before(d), $p.after(d))
      if (inner === null && (isItemType(a.type) || a.type === nodes.blockquote)) {
        inner = span()
        innerIsItem = isItemType(a.type)
      }
      if (item === null && isItemType(a.type)) item = span()
      if (a.type === nodes.blockquote) quote = true
      if (list === null && isListType(a.type)) list = a.type.name
    }
    out.push({ linesBefore: tbs.filter((t) => t.pos < pos).length, item, inner, innerIsItem, quote, list })
    return false
  })
  return out
}

/**
 * The divider rule, stated by structure: a divider inside the selection's range goes with the selected
 * lines, except that one whose innermost container (for a list button: its list item) is a list item
 * with lines, none of them selected, stays with that item; a divider outside the range goes only when
 * every line of its container is selected; a list button moves a divider only with its list item. One
 * that goes gets what the lines got: a list of that kind, or a quote, turned on or off. Null when it holds.
 */
function dividerRule(x: Press, on: boolean): string | null {
  if (x.kind === 'codeBlock' || !x.lines || x.toLine === undefined) return null
  const { first, last } = x.lines
  const was = dividerFacts(x.beforeDoc)
  const is = dividerFacts(x.afterDoc)
  if (was.length !== is.length) return `${was.length} dividers became ${is.length}`
  const chosen = (lines: number[]) => lines.every((i) => i >= first && i <= last)
  for (let k = 0; k < was.length; k++) {
    const d = was[k]!
    const inRange = x.toLine === 'all' || (d.linesBefore > first && d.linesBefore <= x.toLine)
    const container = x.kind === 'blockquote' ? d.inner : d.item
    const isItem = x.kind === 'blockquote' ? d.innerIsItem : true
    const noneChosen = (lines: number[]) => lines.every((i) => i < first || i > last)
    const goes = container === null ? x.kind === 'blockquote' && inRange : inRange ? !(isItem && container.length > 0 && noneChosen(container)) : container.length > 0 && chosen(container)
    if (!goes) continue
    const has = x.kind === 'blockquote' ? is[k]!.quote : is[k]!.list === x.kind
    if (has !== on) return `divider ${k} did not go with the selected lines (${x.kind} ${on ? 'on' : 'off'}): ${JSON.stringify(is[k])}`
  }
  return null
}

/** What the last judged press did (for the randomised test's counts). */
const lastPress = { changed: false, refused: false }

/** Judges one press by the rule; returns a description of the first way it was broken, or null. */
function judge(x: Press): string | null {
  lastPress.changed = x.changed
  lastPress.refused = !x.changed && x.lines !== null && textblocksOf(x.beforeDoc).length > 0
  const { kind, before, after } = x
  if (canonicalTextContent(after as unknown as Record<string, unknown>) === null || (after.blocks && parseBlocks(after.blocks) === null)) return 'the result does not load'
  // Line endings are normalised only where the input is a compact text (its stored "\r\n" goes once it holds blocks); a rich text compares exactly.
  const same = before.blocks ? after.text === before.text : lf(after.text) === lf(before.text)
  if (!same) return `text changed: ${JSON.stringify(before.text)} -> ${JSON.stringify(after.text)}`
  if (x.changed === (JSON.stringify(after) === JSON.stringify(before))) return x.changed ? 'reported a change, but nothing changed' : 'reported no change, but changed'
  const facts = lineFacts(x.beforeDoc)
  if (!x.lines || facts.length === 0) {
    if (x.changed) return 'changed with no line selected'
    if (x.readout !== 'off') return `the button reads ${x.readout} with no line selected`
    return null
  }
  const { first, last } = x.lines
  const selected = facts.slice(first, last + 1)
  const on = !selected.every((f) => has(f, kind))
  if (!x.changed) return mayBeRefused(x.beforeDoc, selected, kind, on) ? null : `nothing changed, and no bound explains it (turning ${on ? 'on' : 'off'})`
  const now = lineFacts(x.afterDoc)
  const tail = facts.length - 1 - last
  const sameUnselected = (a: LineFacts, b: LineFacts | undefined) => {
    if (!b) return false
    const { painted: pa, ...ra } = a
    const { painted: pb, ...rb } = b
    // An unselected line keeps its blocks, text, marks and fonts, and the number it was painted with.
    return JSON.stringify(ra) === JSON.stringify(rb) && (pa === null || pa === pb)
  }
  for (let i = 0; i < first; i++) if (!sameUnselected(facts[i]!, now[i])) return `unselected line ${i} changed: ${JSON.stringify(facts[i])} -> ${JSON.stringify(now[i])}`
  for (let i = 0; i < tail; i++) {
    const a = facts[facts.length - 1 - i]!
    const b = now[now.length - 1 - i]
    if (!sameUnselected(a, b)) return `unselected line ${facts.length - 1 - i} (from the end) changed: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
  }
  const middle = now.slice(first, now.length - tail)
  const bad = middle.find((f) => has(f, kind) !== on)
  if (bad) return `a selected line does not have the block ${on ? 'on' : 'off'}: ${JSON.stringify(bad)}`
  if (kind !== 'codeBlock') {
    if (middle.length !== selected.length) return 'the selected lines changed in number'
    for (let i = 0; i < selected.length; i++) {
      const a = selected[i]!
      const b = middle[i]!
      if (b.text !== a.text || b.runs !== a.runs || b.kind !== a.kind) return `selected line ${first + i} lost its text, marks or fonts: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
      // A quote changes no list around a line, nor its tick.
      if (kind === 'blockquote' && JSON.stringify(a.around.filter((t) => t !== 'quote')) !== JSON.stringify(b.around.filter((t) => t !== 'quote'))) return `selected line ${first + i} changed its lists: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
      // Checklist on: a line already in a checklist keeps its tick; one that newly becomes an item is unticked.
      if (kind === 'taskList' && on && tickOf(b) !== (tickOf(a) ?? 'unticked')) return `selected line ${first + i} has the tick ${tickOf(b)}, not ${tickOf(a) ?? 'unticked'}`
    }
  }
  // A list none of whose lines is selected is left exactly as it is (nothing joins it), where it was:
  // the list around its first line, at the same level of nesting, after the press.
  const selectedLines = new Set(Array.from({ length: last - first + 1 }, (_, k) => first + k))
  const afterLines = textblocksOf(x.afterDoc)
  for (const { node, line, level } of untouchedLists(x.beforeDoc, selectedLines)) {
    const j = line < first ? line : afterLines.length - (facts.length - line)
    const at = afterLines[j]
    const lists: PMNode[] = []
    if (at) {
      const $l = x.afterDoc.resolve(at.pos + 1)
      for (let d = 1; d < $l.depth; d++) if (isListType($l.node(d).type)) lists.push($l.node(d))
    }
    if (!lists[level]?.eq(node)) return `an unselected list changed or moved: ${JSON.stringify(node.toJSON())} -> ${JSON.stringify(lists[level]?.toJSON() ?? null)}`
  }
  // Every line selected and already in a list, a list button on: at each level of nesting there are no more lists than before (a nested item never splits its parent's list).
  if (on && kind !== 'blockquote' && kind !== 'codeBlock' && first === 0 && last === facts.length - 1 && facts.every((f) => f.around.some((a) => (LIST_KINDS as readonly string[]).includes(a)))) {
    const was = listsPerLevel(x.beforeDoc)
    const now2 = listsPerLevel(x.afterDoc)
    if (now2.some((n, level) => n > (was[level] ?? 0))) return `lists per level of nesting went from ${JSON.stringify(was)} to ${JSON.stringify(now2)}`
  }
  // Every line selected, a list button on: no two lists of that kind sit side by side in one parent
  // (every selected line next to another at its level shares its list; nothing is pinned to stay apart).
  if (on && kind !== 'blockquote' && kind !== 'codeBlock' && first === 0 && last === facts.length - 1) {
    let split: string | null = null
    x.afterDoc.descendants((n) => {
      for (let i = 1; i < n.childCount && !split; i++) if (n.child(i).type.name === kind && n.child(i - 1).type.name === kind) split = JSON.stringify(n.toJSON())
      return !split
    })
    if (split) return `two ${kind}s side by side after turning it on for every line: ${split}`
  }
  const dividerBroken = dividerRule(x, on)
  if (dividerBroken) return dividerBroken
  if (x.readout !== (on ? 'on' : 'off')) return `the button reads ${x.readout} after turning it ${on ? 'on' : 'off'}`
  return null
}

/** Presses `kind` in the edit `s` with the selection it has, judges it, and checks that one undo gives back the stored record exactly and redo the result. */
function checkRule(s: EditSession, kind: BlockKind, noLine = false): string | null {
  const beforeDoc = s.state.doc
  const before = s.content()
  const sel = s.state.selection
  const lines = noLine ? null : linesOfSelection(beforeDoc, sel.from, sel.to)
  const changed = s.toggleBlock(kind)
  const after = s.content()
  const toLine = textblocksOf(beforeDoc).findIndex((t) => t.pos + 1 + t.node.content.size >= sel.to)
  const broken = judge({ kind, beforeDoc, before, lines, changed, after, afterDoc: s.state.doc, readout: s.blockFormat().blocks[kind], toLine })
  if (broken) return broken
  if (noLine && !s.state.selection.eq(sel)) return 'the divider is no longer selected'
  if (!changed) return null
  s.undo()
  if (JSON.stringify(s.content()) !== JSON.stringify(before)) return `one undo did not give back the stored record: ${JSON.stringify(before)} -> ${JSON.stringify(s.content())}`
  s.redo()
  if (JSON.stringify(s.content()) !== JSON.stringify(after)) return 'redo did not give back the result'
  s.undo()
  return null
}

/** Presses `kind` on a selected box (the whole-box command, every line), and judges it. */
function checkBoxRule(source: TextSource, kind: BlockKind): string | null {
  const read = docFromText(source)!
  const result = boxCommandContent(source, { command: toggleBlockKind(kind, { wholeBox: true }) })
  const after = result ?? read.content
  const afterDoc = docFromText(after)!.doc
  return judge({ kind, beforeDoc: read.doc, before: read.content, lines: { first: 0, last: textblocksOf(read.doc).length - 1 }, changed: result !== null, after, afterDoc, readout: boxBlocks(afterDoc).blocks[kind], toLine: 'all' })
}

/** Selects the divider at `pos` (as a click on it does). */
function selectDivider(s: EditSession, pos: number) {
  s.dispatch(s.state.tr.setSelection(NodeSelection.create(s.state.doc, pos)))
}

/** The positions of the dividers in a document. */
function dividers(doc: PMNode): number[] {
  const out: number[] = []
  doc.descendants((n, pos) => {
    if (n.type === nodes.divider) out.push(pos)
  })
  return out
}

/** The painted number of each line (null where none is painted). */
const paintedOf = (doc: PMNode) => lineFacts(doc).map((f) => f.painted)

// ---- the fixed cases the reviews found ---------------------------------------------------------------

describe('the block-button rule: the cases the reviews found', () => {
  const pressOn = (blocks: BlockNode[], from: number, to: number, kind: BlockKind) => {
    const s = open({ text: '', blocks })
    s.select(from, to)
    const broken = checkRule(s, kind)
    return { s, broken }
  }

  it('R2a: 65 sibling quotes (or lists) all selected, the pressed button: all of them go, in one pass', () => {
    for (const make of [() => quote(p('a')), () => list('bulletList', [p('a')])]) {
      const blocks = Array.from({ length: 65 }, make)
      const text = Array.from({ length: 65 }, () => 'a').join('\n')
      const s = open({ text: '', blocks })
      s.select(0, text.length)
      const kind = blocks[0]!.type === 'blockquote' ? 'blockquote' : 'bulletList'
      expect(checkRule(s, kind)).toBeNull()
      s.select(0, text.length)
      s.toggleBlock(kind)
      expect(content(s)).toStrictEqual({ text })
    }
  })

  it('R2a: 2,000 sibling quotes leave quickly', () => {
    const blocks = Array.from({ length: 2000 }, (_, i) => quote(p(`line ${i}`)))
    const s = open({ text: '', blocks })
    s.select(0, s.content().text.length)
    const t = performance.now()
    s.toggleBlock('blockquote')
    const ms = performance.now() - t
    expect(content(s).blocks).toBeUndefined()
    expect(ms).toBeLessThan(2000)
  })

  it('R2b: in a quote holding bullets `a` and `b`, Quote off on `a` alone: `b` keeps its quote', () => {
    const { s, broken } = pressOn([quote(list('bulletList', [p('a')], [p('b')]))], 0, 1, 'blockquote')
    expect(broken).toBeNull()
    s.select(0, 1)
    s.toggleBlock('blockquote')
    expect(content(s).blocks).toStrictEqual([list('bulletList', [p('a')]), quote(list('bulletList', [p('b')]))])
    s.select(2)
    expect(s.blockFormat().blocks.blockquote).toBe('on')
  })

  it('R2c: a paragraph and the checklist item after it, Numbered list: both numbered, the button reads on', () => {
    const { s, broken } = pressOn([p('a'), list('taskList', [p('b')])], 0, 3, 'orderedList')
    expect(broken).toBeNull()
    s.select(0, 3)
    s.toggleBlock('orderedList')
    expect(content(s).blocks).toStrictEqual([list('orderedList', [p('a')], [p('b')])])
  })

  it('R2c as a person meets it: `Review`, `Album` and a nested `Track`, Checklist on all: every line a checklist item, `Track` still nested under `Album`', () => {
    const blocks = [p('Review'), list('bulletList', [p('Album'), list('bulletList', [p('Track')])])]
    const s = open({ text: '', blocks })
    s.select(0, 18)
    expect(checkRule(s, 'taskList')).toBeNull()
    s.select(0, 18)
    s.toggleBlock('taskList')
    expect(content(s).blocks).toStrictEqual([list('taskList', [p('Review')], [p('Album'), list('taskList', [p('Track')])])])
  })

  it('three nested list kinds all become numbered; a nested list kept when its parent leaves', () => {
    const s = open({ text: '', blocks: [list('bulletList', [p('a'), list('orderedList', [p('b'), list('taskList', [p('c')])])])] })
    s.select(0, 5)
    expect(checkRule(s, 'orderedList')).toBeNull()
  })
})

// ---- S1: a block button never counts as typing ---------------------------------------------------------

describe('S1: a block button, then one undo, gives back the stored record byte for byte', () => {
  const sources: TextSource[] = [
    { text: 'A\r\nB', spans: [{ start: 3, end: 4, font: 'serif' }] },
    { text: 'Title\r\nA\r\nB', headings: [2, 0, 0], spans: [{ start: 7, end: 8, bold: true }, { start: 10, end: 11, font: 'mono' }] },
    { text: 'A\rB\r\nC', spans: [{ start: 5, end: 6, italic: true }] },
    { text: 'one\rline' },
  ]
  for (const source of sources) {
    for (const kind of BLOCK_KINDS) {
      it(`${JSON.stringify(source.text)}, ${kind} on the first line, in an edit: undo, redo, undo`, () => {
        const record = canonicalTextContent(source as unknown as Record<string, unknown>)!
        const s = open(source, { caret: 0 })
        expect(s.content()).toStrictEqual(record)
        expect(s.toggleBlock(kind)).toBe(true)
        const after = s.content()
        s.undo()
        expect(s.content()).toStrictEqual(record)
        s.redo()
        expect(s.content()).toStrictEqual(after)
        s.undo()
        expect(s.content()).toStrictEqual(record)
        // Typing still counts as typing: the stored line breaks then go, as before.
        type(s, 'x')
        expect(s.content().text.includes('\r\n')).toBe(false)
      })
    }
  }

  it('the change covers only the blocks that change: the line after a quoted first line is not replaced', () => {
    const s = open({ text: '', blocks: [p('a'), p('b'), p('c')] }, { caret: 0 })
    let steps: unknown[] = []
    const dispatch = s.dispatch.bind(s)
    s.dispatch = (tr) => {
      if (tr.steps.length > 0) steps = tr.steps.map((st) => st.toJSON())
      dispatch(tr)
    }
    s.toggleBlock('blockquote')
    expect(steps).toHaveLength(1)
    const step = steps[0] as { from: number; to: number }
    expect(step.from).toBe(0)
    expect(step.to).toBe(3) // only `a` (positions 0 to 3), not `b` or `c`
  })
})

// ---- S2: what a button acts on ------------------------------------------------------------------------

describe('S2: the lines a button acts on', () => {
  it('a selected box whose text ends with an empty line: every button covers every line, the empty last one included, and reads on', () => {
    for (const kind of BLOCK_KINDS) {
      const source = { text: 'a\n' }
      expect(checkBoxRule(source, kind), kind).toBeNull()
      const after = boxCommandContent(source, { command: toggleBlockKind(kind, { wholeBox: true }) })!
      const doc = docFromText(after)!.doc
      expect(boxBlocks(doc).blocks[kind], kind).toBe('on')
      expect(lineFacts(doc).every((f) => has(f, kind)), kind).toBe(true)
    }
  })

  it('only a divider selected: no button changes anything, each reads off, and the divider stays selected', () => {
    for (const kind of BLOCK_KINDS) {
      const s = open({ text: '', blocks: [p('a'), { type: 'divider' }, p('b')] })
      selectDivider(s, dividers(s.state.doc)[0]!)
      expect(s.blockFormat().blocks[kind]).toBe('off')
      expect(checkRule(s, kind, true), kind).toBeNull()
      expect(s.toggleBlock(kind)).toBe(false)
      expect(s.state.selection).toBeInstanceOf(NodeSelection)
    }
  })
})

// ---- S3: numbered lists through the rebuild --------------------------------------------------------------

describe('S3: numbered lists keep their numbers, and neighbouring selected lines share one list', () => {
  it('a numbered list from 10, item 10 holding `a` and `b`: Quote on `b` to `c` leaves `d` painted 12', () => {
    const blocks = [numbered(10, [p('a'), p('b')], [p('c')], [p('d')])]
    const s = open({ text: '', blocks })
    expect(paintedOf(s.state.doc)).toStrictEqual([10, null, 11, 12])
    s.select(2, 5)
    expect(checkRule(s, 'blockquote')).toBeNull()
    s.select(2, 5)
    s.toggleBlock('blockquote')
    expect(paintedOf(s.state.doc)[3]).toBe(12)
    expect(paintedOf(s.state.doc)[0]).toBe(10)
  })

  it('a numbered list from 999,999,999, Bulleted list on the middle item: refused (the last item would need 1,000,000,001), nothing changes', () => {
    const source = { text: '', blocks: [numbered(MAX_LIST_START, [p('a')], [p('b')], [p('c')])] }
    const s = open(source, { caret: 2 })
    const before = s.content()
    expect(s.toggleBlock('bulletList')).toBe(false)
    expect(s.content()).toStrictEqual(before)
    expect(s.canUndo).toBe(false)
    // An item at the end can still leave: the others keep their numbers.
    s.select(4)
    expect(s.toggleBlock('bulletList')).toBe(true)
    expect(paintedOf(s.state.doc)).toStrictEqual([MAX_LIST_START, MAX_LIST_START + 1, null])
  })

  it('`a` and the one-item numbered list `b` after it, both selected, Numbered list: one list, 1 and 2 (bullets and checklists too)', () => {
    for (const kind of LIST_KINDS) {
      const s = open({ text: '', blocks: [p('a'), list(kind, [p('b')])] })
      s.select(0, 3)
      expect(checkRule(s, kind), kind).toBeNull()
      s.select(0, 3)
      s.toggleBlock(kind)
      expect(content(s).blocks, kind).toStrictEqual([list(kind, [p('a')], [p('b')])])
    }
  })

  it('an unselected neighbouring list of the same kind is left exactly as it is', () => {
    for (const kind of LIST_KINDS) {
      const s = open({ text: '', blocks: [list(kind, [p('x')]), p('a')] })
      s.select(2)
      s.toggleBlock(kind)
      expect(content(s).blocks, kind).toStrictEqual([list(kind, [p('x')]), list(kind, [p('a')])])
    }
  })

  it('`Review`, `1. Album`, `Track`, all selected, Numbered list: one list 1 to 3, and Tab then indents `Album` under `Review`', () => {
    const s = open({ text: '' }, { caret: 0 })
    type(s, 'Review\n1. Album\nTrack')
    expect(content(s).blocks).toStrictEqual([p('Review'), list('orderedList', [p('Album')], [p('Track')])])
    s.select(0, 18)
    s.toggleBlock('orderedList')
    expect(content(s).blocks).toStrictEqual([list('orderedList', [p('Review')], [p('Album')], [p('Track')])])
    expect(paintedOf(s.state.doc)).toStrictEqual([1, 2, 3])
    s.select(8)
    press(s, 'Tab')
    expect(content(s).blocks).toStrictEqual([list('orderedList', [p('Review'), list('orderedList', [p('Album')])], [p('Track')])])
    // The same on a selected box.
    const box = boxCommandContent({ text: '', blocks: [p('Review'), list('orderedList', [p('Album')], [p('Track')])] }, { command: toggleBlockKind('orderedList', { wholeBox: true }) })!
    expect(box.blocks).toStrictEqual([list('orderedList', [p('Review')], [p('Album')], [p('Track')])])
  })
})

// ---- S4: a composition over a bound never reaches a record -----------------------------------------------

describe('S4: an over-limit composition never reaches a record, however the edit ends', () => {
  const base = 'x'.repeat(MAX_TEXT_LENGTH - 1)
  const loads = (c: TextContent) => canonicalTextContent(c as unknown as Record<string, unknown>) !== null && (!c.blocks || parseBlocks(c.blocks) !== null)

  it('while the candidate is open, the content is what the text held before it (typing before it included)', () => {
    const reported: TextContent[] = []
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: base }] }, { caret: 0, hooks: { onChange: (c) => reported.push(c) } })
    type(s, 'A')
    s.compositionStart()
    insert(s, 'B', true)
    expect(s.composing).toBe(true)
    expect(s.content().text).toBe(`A${base}`)
    expect(loads(s.content())).toBe(true)
    expect(reported.every(loads)).toBe(true)
    expect(reported.at(-1)!.text).toBe(`A${base}`)
    s.compositionEnd()
    expect(s.content().text).toBe(`A${base}`)
  })

  it('the board goes read-only with an over-limit candidate open, and the edit ends: the composition is refused, the record loads', () => {
    let editable = true
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: `A${base}` }] }, { hooks: { canEdit: () => editable } })
    s.select(0, 1)
    s.compositionStart()
    insert(s, 'BC', true)
    editable = false
    s.finish()
    expect(s.content().text).toBe(`A${base}`)
    expect(loads(s.content())).toBe(true)
    expect(s.state.doc.textContent).toBe(`A${base}`)
  })

  it('a composition that fits is untouched by the guard', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'short' }] }, { caret: 0 })
    s.compositionStart()
    insert(s, 'か', true)
    expect(s.content().text).toBe('かshort')
    s.compositionEnd()
    expect(s.content().text).toBe('かshort')
  })
})

// ---- S5: a keystroke that completes nothing never reads the line's marks -------------------------------------

describe('S5: a keystroke that completes no shortcut does not look at the marks of its long line', () => {
  it('a space at the end of a long paragraph of 50,000 alternately bold words reads at most a few marks', () => {
    const words = 50_000
    const text = 'word '.repeat(words)
    const spans = Array.from({ length: words / 2 }, (_, i) => ({ start: i * 10, end: i * 10 + 4, bold: true as const }))
    const { doc } = docFromText({ text, spans })!
    const line = doc.firstChild!
    expect(line.childCount).toBeGreaterThan(words / 2)
    let reads = 0
    line.forEach((child) => {
      const kept = child.marks
      Object.defineProperty(child, 'marks', {
        get: () => {
          reads++
          return kept
        },
      })
    })
    const at = doc.content.size - 1
    const st = EditorState.create({ doc, selection: TextSelection.create(doc, at) })
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) expect(completesShortcut(st, at, ' ')).toBe(false)
    expect(reads, 'marks read while matching').toBeLessThanOrEqual(20 * 4)
    // And once the space is in, the conversion finds nothing to convert without reading them either.
    const typed = st.apply(st.tr.insertText(' ', at))
    const line2 = typed.doc.firstChild!
    let reads2 = 0
    line2.forEach((child) => {
      const kept = child.marks
      Object.defineProperty(child, 'marks', {
        get: () => {
          reads2++
          return kept
        },
      })
    })
    for (let i = 0; i < 20; i++) expect(shortcutTransaction(typed, ' ')).toBeNull()
    expect(reads2, 'marks read while converting').toBeLessThanOrEqual(20 * 4)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

// ---- the seeded randomised test ---------------------------------------------------------------------

/** A small, seeded random source (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! }
}

type Rand = ReturnType<typeof random>

/** A short line of text, sometimes with marks (bold, italic, inline code) and fonts. */
function line(r: Rand, kind: 'paragraph' | 'heading'): BlockNode {
  const words = ['a', 'bc', 'def', 'gh', 'ij k']
  const runs: InlineRun[] = []
  const n = r.int(3)
  for (let i = 0; i < n; i++) {
    const run: InlineRun = { text: r.pick(words) }
    const m = r.int(6)
    if (m === 1) run.bold = true
    if (m === 2) run.italic = true
    if (m === 3) run.code = true
    if (m === 4) run.font = r.pick(['serif', 'mono'] as const)
    runs.push(run)
  }
  const merged = runs.length > 0 ? { content: runs } : {}
  return kind === 'heading' ? { type: 'heading', level: (1 + r.int(3)) as 1 | 2 | 3, ...merged } : { type: 'paragraph', ...merged }
}

/** A block at `depth` (top level 1), lists nested at most three deep. */
function block(r: Rand, depth: number, lists: number): BlockNode {
  const choice = r.int(10)
  if (choice <= 2 || depth >= 5) return line(r, 'paragraph')
  if (choice === 3) return line(r, 'heading')
  if (choice === 4) return { type: 'codeBlock', text: r.pick(['x', 'a\nb', '', 'let y']) }
  if (choice === 5) return { type: 'divider' }
  if (choice === 6) return quote(...blocks(r, depth + 1, lists, 1 + r.int(2)), ...(r.int(4) === 0 ? [{ type: 'divider' } as BlockNode, line(r, 'paragraph')] : []))
  if (lists >= 3) return line(r, 'paragraph')
  const kind = r.pick(LIST_KINDS)
  const items = Array.from({ length: 1 + r.int(3) }, () => {
    const first = r.int(6) === 0 ? { type: 'codeBlock' as const, text: 'c' } : line(r, r.int(5) === 0 ? 'heading' : 'paragraph')
    // Sometimes the item begins with a divider.
    if (r.int(8) === 0) return [{ type: 'divider' } as BlockNode, first]
    // Sometimes several paragraphs in one item, sometimes a nested block.
    const more = r.int(3) === 0 ? Array.from({ length: 1 + r.int(2) }, (): BlockNode => (r.int(3) === 0 ? { type: 'divider' } : line(r, 'paragraph'))) : []
    const rest = r.int(3) === 0 ? [block(r, depth + 1, lists + 1)] : []
    return [first, ...more, ...rest]
  })
  const out = list(kind, ...items)
  if (out.type === 'taskList') for (const it of out.items) it.checked = r.int(2) === 0
  if (out.type === 'orderedList') {
    const pick = r.int(15)
    if (pick <= 4) out.start = 2 + r.int(20)
    else if (pick === 5) out.start = MAX_LIST_START - r.int(4)
  }
  return out
}

function blocks(r: Rand, depth: number, lists: number, n: number): BlockNode[] {
  return Array.from({ length: n }, () => block(r, depth, lists))
}

/** A list of 2 to 4 items, each a line and sometimes a nested list (to `depth` 2), a quote or a code block. */
function nestedList(r: Rand, depth: number): BlockNode {
  const kind = r.pick(LIST_KINDS)
  const items = Array.from({ length: 2 + r.int(3) }, (_, i) => {
    const blocks: BlockNode[] = r.int(6) === 0 ? [{ type: 'divider' }, line(r, 'paragraph')] : [line(r, 'paragraph')]
    const extra = r.int(5)
    if (extra <= 1 && depth < 2) blocks.push(nestedList(r, depth + 1))
    else if (extra === 2) blocks.push(quote(p(`q${i}`)))
    else if (extra === 3) blocks.push(r.int(2) === 0 ? { type: 'codeBlock', text: `c${i}` } : { type: 'divider' })
    return blocks
  })
  const out = list(kind, ...items)
  if (out.type === 'taskList') for (const it of out.items) it.checked = r.int(2) === 0
  if (out.type === 'orderedList' && r.int(6) === 0) out.start = MAX_LIST_START - r.int(3)
  return out
}

/** A compact text whose line breaks are sometimes "\r\n", with a lone "\r" now and then, spans and headings. */
function compactText(r: Rand): TextSource | null {
  const n = 1 + r.int(4)
  const lines = Array.from({ length: n }, () => r.pick(['a', 'bc d', 'e\rf', '', 'gh']))
  let text = lines[0]!
  for (let i = 1; i < n; i++) text += r.pick(['\r\n', '\r\n', '\n']) + lines[i]
  const spans = text.length > 1 && r.int(2) === 0 ? [{ start: 0, end: 1 + r.int(text.length - 1), ...(r.int(2) ? { bold: true } : { font: 'serif' as const }) }] : undefined
  const headings = r.int(3) === 0 ? Array.from({ length: n }, () => r.pick([0, 0, 1, 2])) : undefined
  const record = canonicalTextContent({ text, spans, headings } as unknown as Record<string, unknown>)
  return record as TextSource | null
}

/** A selection on a text of `length` characters: a caret, a range within a line or across lines, or everything. */
function selection(r: Rand, s: EditSession): [number, number] {
  const text = s.content().text
  const len = text.length
  // Sometimes a caret in a line in no list just before or after a list (a neighbouring list it must not join).
  const facts = lineFacts(s.state.doc)
  const inList = (f: LineFacts | undefined) => f !== undefined && f.around.some((a) => (LIST_KINDS as readonly string[]).includes(a))
  const nextToList = facts.map((f, i) => (!inList(f) && (inList(facts[i - 1]) || inList(facts[i + 1])) ? i : -1)).filter((i) => i >= 0)
  if (nextToList.length > 0 && r.int(4) === 0) {
    const i = r.pick(nextToList)
    const at = facts.slice(0, i).reduce((n, f) => n + f.text.length + 1, 0)
    return [at, at]
  }
  // Sometimes from the start of a line to the start of a later line that comes just after a divider.
  const doc = s.state.doc
  const tbs = textblocksOf(doc)
  const afterDivider = tbs.map((t, i) => (i > 0 && doc.resolve(t.pos).nodeBefore?.type === nodes.divider ? i : -1)).filter((i) => i > 0)
  if (afterDivider.length > 0 && r.int(4) === 0) {
    const i = r.pick(afterDivider)
    const j = r.int(i)
    const start = (k: number) => facts.slice(0, k).reduce((n, f) => n + f.text.length + 1, 0)
    return [start(j), start(i)]
  }
  const mode = r.int(4)
  if (mode === 0) {
    const at = r.int(len + 1)
    return [at, at]
  }
  if (mode === 3) return [0, len]
  const a = r.int(len + 1)
  const b = r.int(len + 1)
  return [Math.min(a, b), Math.max(a, b)]
}

describe('the block-button rule, seeded and randomised', () => {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
  const SEED = Number(env?.BLOCK_RULE_SEED ?? 0x3a3a)
  const DOCS = 300

  it(`holds for ${DOCS} random documents × (3 selections in an edit, a divider, the selected box) × 5 buttons (seed ${SEED})`, () => {
    const r = random(SEED)
    const failures: string[] = []
    let pressed = 0
    let changedCount = 0
    let refused = 0
    const counts = { edit: 0, divider: 0, box: 0, crlf: 0 }
    for (let d = 0; d < DOCS && failures.length < 5; d++) {
      let source: TextSource | null
      const shape = r.int(20)
      if (shape === 0) {
        // A long run of sibling one-line quotes or lists (the 65-container case).
        const sibling = r.pick(['blockquote', 'bulletList', 'orderedList', 'taskList'] as const)
        const raw = parseBlocks(Array.from({ length: 60 + r.int(10) }, (_, i) => (sibling === 'blockquote' ? quote(p(`q${i}`)) : list(sibling, [p(`l${i}`)]))))
        source = raw && { text: '', blocks: raw }
      } else if (shape <= 5) {
        // One list whose items hold nested lists, quotes or code (Album, a nested Track, Cover).
        const raw = parseBlocks([nestedList(r, 0)])
        source = raw && { text: '', blocks: raw }
      } else if (shape <= 8) {
        source = compactText(r)
        if (source) counts.crlf++
      } else {
        const doc = blocks(r, 1, 0, 1 + r.int(5))
        // Sometimes the text ends with an empty line.
        if (r.int(5) === 0) doc.push(p())
        const raw = parseBlocks(doc)
        source = raw && { text: '', blocks: raw }
      }
      if (!source || !docFromText(source)) continue
      const note = (where: string, kind: BlockKind, broken: string | null) => {
        pressed++
        if (broken) failures.push(`seed ${SEED}, document ${d}, ${where}, ${kind}: ${broken}\n  source: ${JSON.stringify(source)}`)
      }
      for (let k = 0; k < 3; k++) {
        const sel = selection(r, open(source))
        for (const kind of BLOCK_KINDS) {
          const s = open(source)
          s.select(sel[0], sel[1])
          let broken: string | null
          try {
            broken = checkRule(s, kind)
          } catch (e) {
            broken = `threw ${String(e)}`
          }
          counts.edit++
          if (lastPress.changed) changedCount++
          else if (lastPress.refused) refused++
          note(`selection [${sel[0]}, ${sel[1]}]`, kind, broken)
        }
      }
      // A divider alone selected.
      const probe = open(source)
      const divs = dividers(probe.state.doc)
      if (divs.length > 0) {
        const at = r.pick(divs)
        for (const kind of BLOCK_KINDS) {
          const s = open(source)
          selectDivider(s, at)
          counts.divider++
          note(`the divider at ${at}`, kind, checkRule(s, kind, true))
        }
      }
      // The selected box, through the whole-box command.
      for (const kind of BLOCK_KINDS) {
        let broken: string | null
        try {
          broken = checkBoxRule(source, kind)
        } catch (e) {
          broken = `threw ${String(e)}`
        }
        counts.box++
        note('the selected box', kind, broken)
      }
    }
    if (failures.length > 0) console.log(failures.join('\n'))
    console.log(`block-button rule: ${pressed} presses on random documents (seed ${SEED}): ${counts.edit} in an edit (${changedCount} changed the text, ${refused} were refused for a bound), ${counts.divider} with a divider selected, ${counts.box} on the selected box; ${counts.crlf} compact texts with stored line breaks`)
    expect(failures, failures[0]).toEqual([])
    expect(pressed).toBeGreaterThan(DOCS * 10)
    expect(counts.divider).toBeGreaterThan(50)
    expect(counts.crlf).toBeGreaterThan(20)
  })
})

// ---- T2: a nested item never splits its parent's list ------------------------------------------------------

describe('T2: a list with nested items, all selected, another list kind: one list at each level', () => {
  const kinds = LIST_KINDS
  const shapes = (k: (typeof LIST_KINDS)[number]) => ({
    'Album, a nested Track, Cover': [list(k, [p('Album'), list(k, [p('Track')])], [p('Cover')])],
    'three levels, then back out one at a time': [list(k, [p('Album'), list(k, [p('Track'), list(k, [p('Deep')])], [p('Track2')])], [p('Cover')])],
    'a quote nested in the item': [list(k, [p('Album'), quote(p('note'))], [p('Cover')])],
    'a code block nested in the item': [list(k, [p('Album'), { type: 'codeBlock', text: 'x = 1' }], [p('Cover')])],
  })
  for (const from of kinds) {
    for (const to of kinds) {
      if (from === to) continue
      it(`${from} to ${to}: in an edit and on a selected box`, () => {
        const before = shapes(from)
        const after = shapes(to)
        for (const name of Object.keys(before) as Array<keyof typeof before>) {
          const s = open({ text: '', blocks: before[name] })
          const len = s.content().text.length
          s.select(0, len)
          expect(checkRule(s, to), name).toBeNull()
          s.select(0, len)
          s.toggleBlock(to)
          expect(content(s).blocks, name).toStrictEqual(after[name])
          const box = boxCommandContent({ text: '', blocks: before[name] }, { command: toggleBlockKind(to, { wholeBox: true }) })!
          expect(box.blocks, `${name}, on a selected box`).toStrictEqual(after[name])
        }
      })
    }
  }

  it('the numbers: `Album` 1 and `Cover` 2, `Track` 1 under `Album`', () => {
    const s = open({ text: '', blocks: [list('bulletList', [p('Album'), list('bulletList', [p('Track')])], [p('Cover')])] })
    s.select(0, s.content().text.length)
    s.toggleBlock('orderedList')
    expect(paintedOf(s.state.doc)).toStrictEqual([1, 1, 2])
  })
})

// ---- T1: typing, pasting, Enter, Backspace, Delete and a composition over any selection -------------------

/** A document from the generator: sometimes a code block next to a line with marks (the reviewer's shape). */
function richSource(r: Rand): TextSource | null {
  const shapes: Array<() => BlockNode[]> = [
    () => [p('alpha'), { type: 'codeBlock', text: r.pick(['code', 'a\nb']) }, p('beta', { italic: true }), p('gamma')],
    // U2: a code block, then a quote holding an italic line and a second line.
    () => [{ type: 'codeBlock', text: 'alpha' }, quote(p('beta', { italic: true }), p('Tail'))],
    // U4: a code block, then a numbered list at the largest start.
    () => [{ type: 'codeBlock', text: 'alpha' }, numbered(MAX_LIST_START, [p('beta', { italic: true })], [p('next')])],
    () => [nestedList(r, 0)],
  ]
  const doc = r.int(3) === 0 ? r.pick(shapes)() : blocks(r, 1, 0, 1 + r.int(5))
  if (r.int(5) === 0) doc.push(p())
  const raw = parseBlocks(doc)
  return raw && { text: '', blocks: raw }
}

type Input = 'type' | 'paste' | 'paste lines' | 'Enter' | 'Backspace' | 'Delete' | 'composition'
const INPUTS: readonly Input[] = ['type', 'paste', 'paste lines', 'Enter', 'Backspace', 'Delete', 'composition']

/** Applies one input to the selection of `s`; returns what it means to put in place of the selection (Enter: a line break, or none when it takes an emptied item or quote line out instead). */
function apply(s: EditSession, input: Input): string[] {
  switch (input) {
    case 'type':
      type(s, 'QRS')
      return ['QRS']
    case 'paste':
      s.paste({ text: 'P' })
      return ['P']
    case 'paste lines':
      s.paste({ text: 'P1\nP2' })
      return ['P1\nP2']
    case 'Enter':
      press(s, 'Enter')
      return ['\n', '']
    case 'Backspace':
    case 'Delete':
      press(s, input)
      return ['']
    case 'composition':
      s.compositionStart()
      insert(s, 'か', true)
      s.compositionEnd()
      return ['か']
  }
}

/** A line's kind and the blocks around it, outermost last: `paragraph/listItem/bulletList`. */
function kindAt(doc: PMNode, offset: number): string {
  if (textblocksOf(doc).length === 0) return '(no line left)'
  const $p = doc.resolve(posAtTextOffset(doc, offset))
  // A heading's level follows the line-level rule (`headingsAfterEdit`): heading and paragraph are one kind here.
  return [$p.parent.type.spec.code ? 'code' : 'line', ...Array.from({ length: Math.max(0, $p.depth - 1) }, (_, d) => $p.node($p.depth - 1 - d).type.name)].join('/')
}

/** Whether a numbered list's numbers come near the largest start that can be stored (a replacement may then be refused). */
function nearListLimit(doc: PMNode): boolean {
  let near = false
  doc.descendants((n) => {
    if (n.type === nodes.orderedList && (n.attrs.start as number) + n.childCount > MAX_LIST_START - 50) near = true
    return !near
  })
  return near
}

/**
 * Checks one input over a selected divider (`s` has it selected): Backspace or Delete removes it and
 * leaves a caret where it was, the text unchanged; anything else puts a line in its place holding the
 * input (Enter: an empty line), caret after it. One undo brings the divider back.
 */
function checkDividerReplacement(s: EditSession, input: Input): string | null {
  const before = s.content()
  const doc = s.state.doc
  const old = plainTextOfDoc(doc)
  const at = (s.state.selection as NodeSelection).from
  const facts = lineFacts(doc)
  const next = textblocksOf(doc).findIndex((t) => t.pos > at)
  const startOf = (k: number) => facts.slice(0, k).reduce((n, f) => n + f.text.length + 1, 0)
  const lineStart = next >= 0 ? startOf(next) : null
  const count = dividers(doc).length
  const meant = apply(s, input)
  const after = s.content()
  if (canonicalTextContent(after as unknown as Record<string, unknown>) === null || (after.blocks && parseBlocks(after.blocks) === null)) return 'the result does not load'
  // W5: a divider with a divider (or nothing) on each side, and one at least, leaves an empty line when it goes.
  const $d = doc.resolve(at)
  const nb = (i: number) => (i >= 0 && i < $d.parent.childCount ? $d.parent.child(i) : null)
  const isDiv = (n: PMNode | null) => n !== null && n.type === nodes.divider
  const alone = (nb($d.index() - 1) === null || isDiv(nb($d.index() - 1))) && (nb($d.index() + 1) === null || isDiv(nb($d.index() + 1))) && (isDiv(nb($d.index() - 1)) || isDiv(nb($d.index() + 1)))
  const deleted = (input === 'Backspace' || input === 'Delete') && !alone
  const line = input === 'Enter' || input === 'Backspace' || input === 'Delete' ? '' : meant[0]!
  const hasLines = textblocksOf(doc).length > 0
  const want = deleted ? old : lineStart !== null ? `${old.slice(0, lineStart)}${line}\n${old.slice(lineStart)}` : hasLines ? `${old}\n${line}` : line
  const now = plainTextOfDoc(s.state.doc)
  if (now !== want) return `the text is ${JSON.stringify(now)}, not ${JSON.stringify(want)}`
  if (after.blocks && after.text !== now) return 'the stored text is not the text shown'
  if (dividers(s.state.doc).length !== count - 1) return 'the divider is still there'
  const added = deleted ? 0 : line.length + 1
  const marksBroken = survivorsKeepMarks(doc, s.state.doc, (i) => (lineStart === null || i < lineStart ? i : i + added))
  if (marksBroken) return marksBroken
  const sel = s.selection()
  if (sel.anchor !== sel.head) return `the selection is ${sel.anchor} to ${sel.head}, not a caret`
  const caret = deleted ? (lineStart ?? old.length) : (lineStart ?? (hasLines ? old.length + 1 : 0)) + line.length
  if (sel.head !== caret) return `the caret is at ${sel.head}, not ${caret}`
  s.undo()
  if (JSON.stringify(s.content()) !== JSON.stringify(before)) return `one undo did not give back the stored record: ${JSON.stringify(before)} -> ${JSON.stringify(s.content())}`
  if (dividers(s.state.doc).length !== count) return 'undo did not bring the divider back'
  return null
}

/** For each line, the position of the nearest list around it (null in none): which list it is in. */
function listPositions(doc: PMNode): Array<number | null> {
  return textblocksOf(doc).map(({ pos }) => {
    const $p = doc.resolve(pos + 1)
    for (let d = $p.depth - 1; d > 0; d--) if (isListType($p.node(d).type)) return $p.before(d)
    return null
  })
}

/** The positions of every list around line `line`. */
function allListPositions(doc: PMNode, line: number): number[] {
  const t = textblocksOf(doc)[line]
  if (!t) return []
  const $p = doc.resolve(t.pos + 1)
  const out: number[] = []
  for (let d = $p.depth - 1; d > 0; d--) if (isListType($p.node(d).type)) out.push($p.before(d))
  return out
}

/** For each UTF-16 unit of a document's text (null for a line break), its marks and font, and whether it sits in a code block or a heading. */
function charMarks(doc: PMNode): Array<{ marks: string; code: boolean; heading: boolean } | null> {
  const out: Array<{ marks: string; code: boolean; heading: boolean } | null> = []
  textblocksOf(doc).forEach(({ node }, i) => {
    if (i > 0) out.push(null)
    node.forEach((child) => {
      const marks = child.marks.map((m) => (m.type.name === 'font' ? `font:${m.attrs.font as string}` : m.type.name)).sort().join(',')
      for (let k = 0; k < (child.text ?? '').length; k++) {
        if (node.type.spec.code && child.text![k] === '\n') out.push(null)
        else out.push({ marks, code: node.type.spec.code === true, heading: node.type === nodes.heading })
      }
    })
  })
  return out
}

/**
 * W1: every character that was in the text before an input and is still there afterwards keeps exactly
 * its marks and font (where it lands in a code block, it holds none; in a heading, no stored bold).
 * `shift(i)`: where the character at `i` is afterwards (null: it went).
 */
function survivorsKeepMarks(before: PMNode, after: PMNode, shift: (i: number) => number | null): string | null {
  const was = charMarks(before)
  const is = charMarks(after)
  for (let i = 0; i < was.length; i++) {
    const a = was[i]
    const j = shift(i)
    if (!a || j === null) continue
    const b = is[j]
    if (!b) return `character ${i} is no longer a character at ${j}`
    if (b.code) continue
    const strip = (m: string, heading: boolean) => (heading ? m.split(',').filter((x) => x !== 'bold').join(',') : m)
    if (strip(a.marks, b.heading) !== strip(b.marks, b.heading)) return `character ${i} changed its marks: ${a.marks} -> ${b.marks}`
  }
  return null
}

/** How many inputs the replacement test saw refused whole (a stored limit). */
let replacementsRefused = 0

/** Checks one input over the selection `s` has; a description of the first way it went wrong, or null. */
function checkReplacement(s: EditSession, input: Input): string | null {
  const before = s.content()
  const beforeDoc = s.state.doc
  const rich = before.blocks !== undefined
  const old = plainTextOfDoc(beforeDoc)
  const { from, to, anchor, head } = s.selection()
  const startKind = kindAt(beforeDoc, from)
  const meant = apply(s, input)
  const after = s.content()
  if (canonicalTextContent(after as unknown as Record<string, unknown>) === null || (after.blocks && parseBlocks(after.blocks) === null)) return 'the result does not load'
  const now = plainTextOfDoc(s.state.doc)
  // Refused whole: allowed only where a stored limit explains it (a list start past 999,999,999).
  const kept = s.selection()
  if (JSON.stringify(after) === JSON.stringify(before) && kept.anchor === anchor && kept.head === head && kept.anchor !== kept.head) {
    const sel = kept
    replacementsRefused++
    if (!nearListLimit(beforeDoc)) return `nothing changed, and no stored limit explains it (text ${JSON.stringify(now)})`
    return sel.anchor === anchor && sel.head === head ? null : 'refused, but the selection moved'
  }
  if (after.blocks && after.text !== now) return 'the stored text is not the text shown'
  const which = meant.find((text) => now === old.slice(0, from) + text + old.slice(to))
  if (which === undefined) return `the text is ${JSON.stringify(now)}, not ${meant.map((t) => JSON.stringify(old.slice(0, from) + t + old.slice(to))).join(' or ')}`
  const sel = s.selection()
  if (sel.anchor !== sel.head) return `the selection is ${sel.anchor} to ${sel.head}, not a caret`
  // Enter that takes an emptied nested item out of an item with no line of its own (ProseMirror then adds the line) leaves the caret before that line.
  if (sel.head !== from + which.length && !(input === 'Enter' && sel.head === from)) return `the caret is at ${sel.head}, not ${from + which.length}`
  // W1: the characters outside the selection keep their marks and fonts (in a text with blocks: a text
  // without them keeps the earlier canvas's styling of Enter and paste over a selection, U1).
  const delta = which.length - (to - from)
  const marksBroken = !rich ? null : survivorsKeepMarks(beforeDoc, s.state.doc, (i) => (i < from ? i : i >= to ? i + delta : null))
  if (marksBroken) return marksBroken
  // In a text with blocks, the two ends become one line of the kind the selection started in, in its place.
  // (Enter is judged on its deletion: after it, Enter's own rules at the caret may move that line.)
  if (rich && input !== 'Enter' && kindAt(s.state.doc, from) !== startKind) return `the joined line is ${kindAt(s.state.doc, from)}, not ${startKind} where the selection started`
  if (rich && input !== 'Enter') {
    // The lines before the selection, the joined line (the line the selection started on: its item with
    // its tick, its list and painted number, its quote) and every line after the selection keep their
    // blocks, ticks and painted numbers. (Enter is judged on its deletion, which Backspace and Delete
    // check: after it, Enter's own rules at the caret may lift or renumber the item it is in.)
    const was = lineFacts(beforeDoc)
    const is = lineFacts(s.state.doc)
    const lineOf = (facts: LineFacts[], offset: number) => {
      let at = 0
      for (let i = 0; i < facts.length; i++) {
        if (offset <= at + facts[i]!.text.length) return i
        at += facts[i]!.text.length + 1
      }
      return facts.length - 1
    }
    const startLine = lineOf(was, from)
    const endLine = lineOf(was, to)
    const same = (a: LineFacts, b: LineFacts | undefined) => b !== undefined && JSON.stringify(a.around) === JSON.stringify(b.around) && (a.painted === null || a.painted === b.painted)
    for (let i = 0; i < startLine; i++) if (!same(was[i]!, is[i]) || was[i]!.text !== is[i]!.text) return `line ${i} before the selection changed: ${JSON.stringify(was[i])} -> ${JSON.stringify(is[i])}`
    {
      const a = was[startLine]!
      const b = is[startLine]
      if (!b || JSON.stringify(a.around) !== JSON.stringify(b.around) || a.painted !== b.painted) return `the joined line is not the line the selection started on: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
      // Lines after the selection keep their blocks and ticks and stay in the list they were in: a line
      // in the list the selection started in stays in the joined line's list (numbered on from it); any
      // other stays out of it, with the number it was painted with.
      const wasList = listPositions(beforeDoc)
      const isList = listPositions(s.state.doc)
      const startLists = new Set(allListPositions(beforeDoc, startLine))
      const joinedLists = new Set(allListPositions(s.state.doc, startLine))
      const tail = was.length - 1 - endLine
      for (let k = 1; k <= tail; k++) {
        const x = was[was.length - k]!
        const y = is[is.length - k]
        if (!y || JSON.stringify(x.around) !== JSON.stringify(y.around) || x.text !== y.text || x.kind !== y.kind) return `line ${was.length - k} after the selection changed: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`
        const w = wasList[was.length - k]!
        const v = isList[is.length - k]!
        const inStart = w === null ? startLists.size === 0 : startLists.has(w)
        const inJoined = v === null ? joinedLists.size === 0 : joinedLists.has(v)
        if (inStart ? !inJoined : (inJoined && v !== null) || (x.painted !== null && x.painted !== y.painted)) return `line ${was.length - k} after the selection left its list or its number: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`
      }
    }
  }
  s.undo()
  // A composition over a selection in a text without blocks keeps ProseMirror's usual grouping: its deletion can be an undo step of its own.
  if (!rich && input === 'composition' && JSON.stringify(s.content()) !== JSON.stringify(before)) s.undo()
  if (JSON.stringify(s.content()) !== JSON.stringify(before)) return `one undo did not give back the stored record: ${JSON.stringify(before)} -> ${JSON.stringify(s.content())}`
  return null
}

describe('T1: typing, pasting, Enter, Backspace, Delete and a composition over a selection', () => {
  it('the reviewer\'s case: `alpha` as a code block, the selection from its start to the start of the italic `beta`, `XYZ` typed: every key kept, the caret after them', () => {
    for (const backward of [false, true]) {
      const s = open({ text: '', blocks: [p('alpha'), p('beta', { italic: true }), p('gamma')] })
      s.select(0, 6)
      s.toggleBlock('codeBlock')
      expect(s.selection()).toMatchObject({ from: 0, to: 6 })
      if (backward) s.select(6, 0)
      type(s, 'XYZ')
      expect(content(s)).toStrictEqual({ text: 'XYZbeta\ngamma', blocks: [{ type: 'codeBlock', text: 'XYZbeta' }, p('gamma')] })
      expect(s.selection()).toMatchObject({ anchor: 3, head: 3 })
    }
  })

  it('each input over a selection from a code block into a line with marks, and the other way: exact text, a caret after it, one undo back', () => {
    for (const input of INPUTS) {
      for (const [a, b] of [
        [2, 8],
        [8, 2],
        [0, 6],
        [3, 12],
      ] as const) {
        const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'alpha' }, p('beta', { italic: true }), p('gamma', { bold: true })] })
        s.select(a, b)
        expect(checkReplacement(s, input), `${input} over [${a}, ${b}]`).toBeNull()
        const t = open({ text: '', blocks: [p('alpha', { italic: true }), { type: 'codeBlock', text: 'beta' }, p('gamma')] })
        t.select(a, b)
        expect(checkReplacement(t, input), `${input} over [${a}, ${b}], code second`).toBeNull()
      }
    }
  })

  it('holds for random selections over random rich texts, every input (seeded)', () => {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    const SEED = Number(env?.REPLACE_RULE_SEED ?? 0x7171)
    const r = random(SEED)
    const failures: string[] = []
    let applied = 0
    let atLineStart = 0
    let dividerInputs = 0
    for (let d = 0; d < 250 && failures.length < 5; d++) {
      const source = richSource(r)
      if (!source || !docFromText(source)) continue
      const text = plainTextOfDoc(open(source).state.doc)
      if (text.length === 0) continue
      // A divider selected on its own, every input.
      const divs = dividers(open(source).state.doc)
      if (divs.length > 0) {
        const at = r.pick(divs)
        for (const input of INPUTS) {
          const s = open(source)
          selectDivider(s, at)
          let broken: string | null
          try {
            broken = checkDividerReplacement(s, input)
          } catch (e) {
            broken = `threw ${String(e)}`
          }
          applied++
          dividerInputs++
          if (broken) failures.push(`seed ${SEED}, document ${d}, ${input} over the divider at ${at}: ${broken}\n  source: ${JSON.stringify(source)}`)
        }
      }
      for (let k = 0; k < 2; k++) {
        let a = r.int(text.length + 1)
        let b = r.int(text.length + 1)
        // Sometimes ending exactly at the start of a line.
        const starts = [...text.matchAll(/\n/g)].map((m) => m.index! + 1)
        if (starts.length > 0 && r.int(3) === 0) {
          b = r.pick(starts)
          atLineStart++
        }
        if (a === b) a = a > 0 ? a - 1 : Math.min(text.length, a + 1)
        if (a === b) continue
        const [anchor, head] = r.int(2) === 0 ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)]
        for (const input of INPUTS) {
          const s = open(source)
          s.select(anchor, head)
          let broken: string | null
          try {
            broken = checkReplacement(s, input)
          } catch (e) {
            broken = `threw ${String(e)}`
          }
          applied++
          if (broken) failures.push(`seed ${SEED}, document ${d}, ${input} over [${anchor}, ${head}]: ${broken}\n  source: ${JSON.stringify(source)}`)
        }
      }
    }
    if (failures.length > 0) console.log(failures.join('\n'))
    console.log(`replacement rule: ${applied} inputs over random selections (seed ${SEED}), ${atLineStart} selections ending at the start of a line, ${replacementsRefused} refused whole at a stored limit, ${dividerInputs} over a selected divider`)
    expect(failures, failures[0]).toEqual([])
    expect(applied).toBeGreaterThan(2000)
  })
})

// ---- paste, seeded and randomised (Slice 3b) ---------------------------------------------------------------

/** The plain text of blocks, as storage reads it. */
const textOfBlocks = (blocks: BlockNode[]): string => (canonicalTextContent({ text: '', blocks } as unknown as Record<string, unknown>) as TextContent | null)?.text ?? ''

describe('paste, seeded and randomised', () => {
  it('holds for random pastes (Markdown, prose, HTML of random blocks, unformatted web lines, Yuriful\'s own copy) at random carets and selections (seeded)', () => {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env
    const SEED = Number(env?.PASTE_RULE_SEED ?? 0x5a5a)
    const r = random(SEED)
    const snippets = ['# Title', '## Sub', '- one', '- [x] done', '- [ ] todo', '1. first', '3. third', '> quote', '---', '```\ncode\n```', '**bold** and *it*', '`code` span', 'plain words', '', '  - nested']
    const prose = ['just words', 'a b c', '2 * 3', 'x', 'snake*case*']
    const serializer = DOMSerializer.fromSchema(textSchema)
    const failures: string[] = []
    let pasted = 0
    let converted = 0
    let refused = 0
    const el = document.createElement('div')
    document.body.appendChild(el)
    for (let d = 0; d < 150 && failures.length < 5; d++) {
      const source = r.int(6) === 0 ? compactText(r) : richSource(r)
      if (!source || !docFromText(source)) continue
      const text0 = plainTextOfDoc(open(source).state.doc)
      for (let k = 0; k < 3; k++) {
        // The paste.
        const kind = r.pick(['markdown', 'prose', 'html', 'web', 'copy'] as const)
        let data: { text: string; html?: string }
        if (kind === 'markdown') data = { text: Array.from({ length: 1 + r.int(4) }, () => r.pick(snippets)).join('\n') }
        else if (kind === 'prose') data = { text: Array.from({ length: 1 + r.int(2) }, () => r.pick(prose)).join('\n') }
        else if (kind === 'web') {
          // Lines of a web page with no formatting of their own (colour spans only), Markdown or prose.
          const lines = Array.from({ length: 1 + r.int(3) }, () => r.pick([...snippets, ...prose]).split('\n')).flat()
          const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          data = { html: lines.map((l) => `<p><span style="color: rgb(32, 33, 36); font-weight: 400">${esc(l)}</span></p>`).join(''), text: lines.join('\n') }
        } else if (kind === 'html') {
          const raw = parseBlocks(blocks(r, 1, 0, 1 + r.int(3)))
          if (!raw) continue
          const box = document.createElement('div')
          box.appendChild(serializer.serializeFragment(docFromBlocks(raw).content))
          data = { html: box.innerHTML, text: textOfBlocks(raw) }
        } else {
          const other = richSource(r)
          if (!other || !docFromText(other)) continue
          const from = open(other)
          from.mount(el)
          const t = plainTextOfDoc(from.state.doc)
          const a = r.int(t.length + 1)
          const b = r.int(t.length + 1)
          from.select(Math.min(a, b), Math.max(a, b))
          if (from.state.selection.empty) {
            from.finish()
            continue
          }
          const copy = from.view!.serializeForClipboard(from.state.selection.content())
          data = { html: copy.dom.innerHTML, text: copy.text }
          from.finish()
        }
        // Where.
        const s = open(source)
        let a = r.int(text0.length + 1)
        let b = r.int(2) === 0 ? a : r.int(text0.length + 1)
        if (r.int(2) === 0) [a, b] = [b, a]
        s.select(a, b)
        // Sometimes something is typed or pasted at the caret just before, with no pause (Y1): the
        // paste's own undo steps must still give back exactly the text as it was just before the paste.
        let lead = ''
        if (a === b && r.int(3) === 0) {
          lead = r.pick(['typed', 'pasted'] as const)
          if (lead === 'typed') type(s, 'q')
          else s.paste({ text: 'z' })
        }
        const before = s.content()
        const beforeDoc = s.state.doc
        const rich = before.blocks !== undefined
        const { from, to } = s.selection()
        const old = plainTextOfDoc(beforeDoc)
        const prefix = old.slice(0, from)
        const suffix = old.slice(to)
        // Inline code where it arrives (the caret's, or the first selected character's): a literal paste, as code (Y4).
        const $at = s.state.selection.$from
        const firstSelected = !s.state.selection.empty && $at.parent.isTextblock && $at.parentOffset < $at.parent.content.size ? $at.parent.childAfter($at.parentOffset).node : null
        const atCode = (firstSelected?.isText ? firstSelected.marks : $at.marks()).some((m) => m.type.name === 'code')
        let broken: string | null = null
        try {
          s.paste(data)
          pasted++
          const after = s.content()
          const afterDoc = s.state.doc
          if (canonicalTextContent(after as unknown as Record<string, unknown>) === null || (after.blocks && parseBlocks(after.blocks) === null)) broken = 'the result does not load'
          const now = plainTextOfDoc(s.state.doc)
          if (!broken && now === old && JSON.stringify(after) === JSON.stringify(before)) {
            refused++
            // Allowed for a paste that brings no characters, one that puts back exactly the characters it replaces, or at a stored limit.
            const empty = (data.text === '' && (data.html === undefined || textOfBlocks(htmlToBlocks(data.html).blocks) === '')) || old.slice(from, to) === data.text.replace(/\r\n?/g, '\n')
            if (!empty && !nearListLimit(beforeDoc) && old.length + data.text.length < MAX_TEXT_LENGTH - 1000) broken = 'nothing changed'
          } else if (!broken) {
            // The characters: outside the selection unchanged; in between, the paste once and in order (with the line breaks its placement adds).
            if (!now.startsWith(prefix) || !now.endsWith(suffix)) broken = 'the text outside the selection changed'
            else {
              const middle = now.slice(prefix.length, now.length - suffix.length)
              const md = kind === 'markdown' || kind === 'prose' || kind === 'web' ? markdownToBlocks(data.text) : null
              const read = data.html !== undefined ? htmlToBlocks(data.html) : null
              const cores = new Set<string>([data.text.replace(/\r\n?/g, '\n')])
              if (md) cores.add(textOfBlocks(md))
              if (read) cores.add(read.inline ? (textOfBlocks(read.blocks).split('\n')[0] ?? '') : textOfBlocks(read.blocks))
              const fits = [...cores].some((c) => ['', '\n'].some((lead) => ['', '\n', '\n\n'].some((tail) => middle === lead + c + tail)))
              if (!fits) broken = `the pasted text is ${JSON.stringify(middle)}, not one of ${JSON.stringify([...cores])}`
              const caret = s.selection()
              if (!broken && caret.anchor !== caret.head) broken = 'the selection is not a caret'
              if (!broken && (caret.head < prefix.length || caret.head > now.length - suffix.length + 1)) broken = `the caret is at ${caret.head}, outside the paste`
              if (!broken && rich) broken = survivorsKeepMarks(beforeDoc, s.state.doc, (i) => (i < from ? i : i >= to ? i + now.length - old.length : null))
              // Undo: one step, or two for a converted Markdown paste, with the literal text between them; redo brings it back.
              if (!broken) {
                const result = JSON.stringify(after)
                // (An old text's stored "\r\n" breaks go once it is typed or pasted into, as before: there the document is compared.)
                const back = () => (old.includes('\r') || JSON.stringify(before).includes('\\r') ? s.state.doc.eq(beforeDoc) : JSON.stringify(s.content()) === JSON.stringify(before))
                s.undo()
                let steps = 1
                if (!back()) {
                  steps = 2
                  converted++
                  const literal = plainTextOfDoc(s.state.doc)
                  if (!literal.startsWith(prefix) || !literal.endsWith(suffix) || literal.slice(prefix.length, literal.length - suffix.length) !== data.text.replace(/\r\n?/g, '\n')) broken = `the first undo is not the literal paste: ${JSON.stringify(literal)}`
                  s.undo()
                }
                if (!broken && !back()) broken = `undo did not give back the record: ${JSON.stringify(s.content())}`
                for (let i = 0; i < steps && !broken; i++) s.redo()
                if (!broken && JSON.stringify(s.content()) !== result) broken = 'redo did not give back the paste'
                // Whose formatting (X1): a clipboard that carried HTML, and Markdown that converted, give the
                // pasted characters only marks their source gave them, never the marks around the caret (no
                // mark is pending here). Plain text left literal takes the place's formatting, as before.
                if (!broken && !atCode && (data.html !== undefined || steps === 2)) {
                  const own = new Set<string>()
                  const collect = (list: BlockNode[]): void => {
                    for (const b of list) {
                      if (b.type === 'paragraph' || b.type === 'heading') {
                        if (b.type === 'heading') own.add('bold') // a heading's text arrives bold where it is not a heading
                        for (const r of b.content ?? []) for (const k of Object.keys(r)) if (k !== 'text' && k !== 'font') own.add(k)
                      } else if (b.type === 'blockquote') collect(b.blocks)
                      else if (b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'taskList') for (const it of b.items) collect(it.blocks)
                    }
                  }
                  if (read) collect(read.blocks)
                  const fromText = markdownToBlocks(data.text)
                  if (fromText) collect(fromText)
                  const marksNow = charMarks(afterDoc)
                  for (let i = prefix.length; i < now.length - suffix.length && !broken; i++) {
                    const c = marksNow[i]
                    if (!c || c.code) continue
                    const taken = c.marks.split(',').filter((m) => m !== '' && !m.startsWith('font:') && !own.has(m))
                    if (taken.length > 0) broken = `pasted character ${i} took ${taken.join(',')} from around it (its source has ${[...own].join(',') || 'no marks'})`
                  }
                }
              }
            }
          }
        } catch (e) {
          broken = `threw ${String(e)}`
        }
        if (broken) failures.push(`seed ${SEED}, document ${d}, ${kind} paste over [${a}, ${b}]${lead ? ` after a character ${lead} there` : ''}: ${broken}\n  source: ${JSON.stringify(source)}\n  paste: ${JSON.stringify(data)}`)
      }
    }
    el.remove()
    if (failures.length > 0) console.log(failures.join('\n'))
    console.log(`paste rule: ${pasted} pastes (seed ${SEED}), ${converted} converted in two steps, ${refused} refused whole`)
    expect(failures, failures[0]).toEqual([])
    expect(pasted).toBeGreaterThan(300)
  })
})

// ---- U1 to U4 -------------------------------------------------------------------------------------------------

describe('U1: in a text without blocks the settle step changes nothing at all', () => {
  /** What the session settles a transaction as (as `EditSession.settleSelectionReplacement` reads it), or null when it does not settle it. */
  const inputOf = (s: EditSession, tr: Transaction): ReplacementInput | null => {
    const replaced = tr.getMeta(META.replaced) as { text: string } | undefined
    if (replaced) return replaced.text === '' ? { kind: 'delete' } : replaced.text === '\n' ? { kind: 'enter' } : { kind: 'text', text: replaced.text }
    const slice = (s as unknown as { pastedSlice: Slice | null }).pastedSlice
    return tr.getMeta('paste') === true && slice ? { kind: 'slice', slice } : null
  }

  it('for thousands of random plain texts, selections and inputs, the transaction is the very one given (seeded)', () => {
    const r = random(0x0101)
    const words = ['AB', 'CD', 'EF', 'gh', 'ij k', '😀x', '']
    let checked = 0
    let compositions = 0
    const failures: string[] = []
    for (let d = 0; d < 400 && failures.length < 5; d++) {
      const n = 1 + r.int(4)
      const lines = Array.from({ length: n }, () => r.pick(words))
      const text = lines.join('\n')
      const spans = text.length > 1 && r.int(2) === 0 ? [{ start: 0, end: 1 + r.int(text.length - 1), ...r.pick([{ bold: true as const }, { italic: true as const }, { font: 'mono' as const }]) }] : undefined
      const headings = r.int(2) === 0 ? lines.map(() => r.pick([0, 0, 1, 2, 3])) : undefined
      const source = canonicalTextContent({ text, spans, headings } as unknown as Record<string, unknown>) as TextSource | null
      if (!source || text.length < 2) continue
      for (let k = 0; k < 4; k++) {
        let a = r.int(text.length + 1)
        let b = r.int(text.length + 1)
        if (a === b) b = a === 0 ? 1 : a - 1
        if (r.int(2) === 0) [a, b] = [b, a]
        const input = r.pick(['type', 'paste', 'html empty', 'html br', 'html lines', 'html bold', 'view paste empty', 'view paste open', 'view paste lines', 'Enter', 'Backspace', 'Delete', 'composition'] as const)
        const s = open(source)
        s.select(a, b)
        const dispatch = s.dispatch.bind(s)
        s.dispatch = (tr: Transaction) => {
          if (!s.state.selection.empty && tr.docChanged) {
            const what = inputOf(s, tr)
            if (what) {
              checked++
              // Not only the same object: the same steps, selection, stored marks and metadata as before the call.
              const snapshot = () => JSON.stringify({ steps: tr.steps.map((st) => st.toJSON()), selection: tr.selection.toJSON(), marks: tr.storedMarks?.map((m) => m.toJSON()) ?? null, meta: Object.entries((tr as unknown as { meta: Record<string, unknown> }).meta).map(([k, v]) => [k, v instanceof SliceClass ? v.toJSON() : typeof v === 'object' && v !== null && 'toJSON' in v ? String(v) : v]) })
              const was = snapshot()
              const settled = settleReplacement(s.state, tr, what, (doc) => !exceedsBounds(doc, s.baseFont))
              if (settled !== tr) failures.push(`${input} over [${a}, ${b}] in ${JSON.stringify(source)}: the step returned another transaction (or refused it)`)
              else if (snapshot() !== was) failures.push(`${input} over [${a}, ${b}] in ${JSON.stringify(source)}: the step changed the transaction it was given`)
            }
            if (s.composing || input === 'composition') {
              compositions++
              if (tr.getMeta('composition') !== undefined && !s.composing) failures.push(`${input} over [${a}, ${b}]: the deletion starting a composition carries a composition id in a text without blocks`)
            }
          }
          dispatch(tr)
        }
        if (input === 'type') type(s, 'Z')
        else if (input === 'paste') s.paste({ text: r.pick(['P', 'P1\nP2', '']) || 'P' })
        else if (input === 'html empty') s.paste({ html: '<p></p>', text: '' })
        else if (input === 'html br') s.paste({ html: '<p><br></p>', text: '\n' })
        else if (input === 'html lines') s.paste({ html: '<p>H1</p><p>H2</p>', text: 'H1\nH2' })
        else if (input === 'html bold') s.paste({ html: '<b>B</b>', text: 'B' })
        else if (input.startsWith('view paste')) {
          // As a mounted view pastes: ProseMirror's own replaceSelection of the slice it parsed (an empty paragraph, closed or open, or two paragraphs).
          const slice =
            input === 'view paste empty'
              ? new SliceClass(Fragment.from(nodes.paragraph.create()), 0, 0)
              : input === 'view paste open'
                ? new SliceClass(Fragment.from(nodes.paragraph.create()), 1, 1)
                : new SliceClass(Fragment.fromArray([nodes.paragraph.create(null, textSchema.text('H1')), nodes.paragraph.create(null, textSchema.text('H2'))]), 1, 1)
          ;(s as unknown as { pastedSlice: Slice | null }).pastedSlice = slice
          s.dispatch(s.state.tr.replaceSelection(slice).setMeta('paste', true).setMeta('uiEvent', 'paste'))
        } else if (input === 'composition') {
          s.compositionStart()
          insert(s, 'か', true)
          s.compositionEnd()
        } else press(s, input)
      }
    }
    if (failures.length > 0) console.log(failures.join('\n'))
    console.log(`U1: ${checked} replacements of a selection in texts without blocks, every one left as given; ${compositions} composition steps`)
    expect(failures, failures[0]).toEqual([])
    expect(checked).toBeGreaterThan(1000)
  })
})

describe('U2: the two ends become one line of the kind the selection started in', () => {
  type Kind = 'paragraph' | 'heading' | 'bullet item' | 'checklist item' | 'quote' | 'code block'
  const KINDS: readonly Kind[] = ['paragraph', 'heading', 'bullet item', 'checklist item', 'quote', 'code block']
  const make = (kind: Kind, text: string, extra: Partial<InlineRun> = {}): BlockNode => {
    switch (kind) {
      case 'paragraph':
        return p(text, extra)
      case 'heading':
        return { type: 'heading', level: 2, content: [{ text, ...extra }] }
      case 'bullet item':
        return list('bulletList', [p(text, extra)])
      case 'checklist item':
        return list('taskList', [p(text, extra)])
      case 'quote':
        return quote(p(text, extra), p('Tail'))
      case 'code block':
        return { type: 'codeBlock', text }
    }
  }
  for (const a of KINDS) {
    it(`starting in a ${a}, ending in each other kind, both directions, every input`, () => {
      for (const b of KINDS) {
        if (a === b) continue
        for (const [from, to] of [
          [0, 6],
          [2, 8],
        ] as const) {
          for (const backward of [false, true]) {
            for (const input of INPUTS) {
              const s = open({ text: '', blocks: [make(a, 'alpha'), make(b, 'beta', { italic: true })] })
              if (backward) s.select(to, from)
              else s.select(from, to)
              expect(checkReplacement(s, input), `${a} into ${b}, [${from}, ${to}]${backward ? ' backward' : ''}, ${input}`).toBeNull()
            }
          }
        }
      }
    })
  }

  it('the reviewer\'s case: code `alpha`, a quote holding italic `beta` and `Tail`; Backspace or Delete, then Z: `Zbeta` in the code block, `Tail` still quoted', () => {
    for (const key of ['Backspace', 'Delete']) {
      for (const backward of [false, true]) {
        const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'alpha' }, quote(p('beta', { italic: true }), p('Tail'))] })
        if (backward) s.select(6, 0)
        else s.select(0, 6)
        press(s, key)
        type(s, 'Z')
        expect(content(s).blocks, `${key}${backward ? ' backward' : ''}`).toStrictEqual([{ type: 'codeBlock', text: 'Zbeta' }, quote(p('Tail'))])
      }
    }
  })
})

describe('U3: a divider inside a list item or quote goes with its item', () => {
  const albumCover = (k: 'bulletList' | 'orderedList' | 'taskList') => [list(k, [p('Album'), { type: 'divider' }], [p('Cover')])]
  it('Album with a divider inside its item, then Cover: every list kind to every other, in an edit and on the box: one list, the divider still in Album\'s item', () => {
    for (const from of LIST_KINDS) {
      for (const to of LIST_KINDS) {
        if (from === to) continue
        const s = open({ text: '', blocks: albumCover(from) })
        s.select(0, s.content().text.length)
        expect(checkRule(s, to), `${from} to ${to}`).toBeNull()
        s.select(0, s.content().text.length)
        s.toggleBlock(to)
        expect(content(s).blocks, `${from} to ${to}`).toStrictEqual(albumCover(to))
        const box = boxCommandContent({ text: '', blocks: albumCover(from) }, { command: toggleBlockKind(to, { wholeBox: true }) })!
        expect(box.blocks, `${from} to ${to}, on the box`).toStrictEqual(albumCover(to))
      }
    }
  })

  it('turning the list off takes the divider out with its item; Quote on and off over a divider inside the selection keeps one quote', () => {
    const s = open({ text: '', blocks: albumCover('bulletList') })
    s.select(0, s.content().text.length)
    s.toggleBlock('bulletList')
    expect(content(s).blocks).toStrictEqual([p('Album'), { type: 'divider' }, p('Cover')])
    s.select(0, s.content().text.length)
    expect(checkRule(s, 'blockquote')).toBeNull()
    s.select(0, s.content().text.length)
    s.toggleBlock('blockquote')
    expect(content(s).blocks).toStrictEqual([quote(p('Album'), { type: 'divider' }, p('Cover'))])
    s.select(0, s.content().text.length)
    s.toggleBlock('blockquote')
    expect(content(s).blocks).toStrictEqual([p('Album'), { type: 'divider' }, p('Cover')])
    // A divider at the end of a quote whose lines are all selected leaves with them.
    const t = open({ text: '', blocks: [quote(p('a'), { type: 'divider' }), p('b')] })
    t.select(0, 1)
    t.toggleBlock('blockquote')
    expect(content(t).blocks).toStrictEqual([p('a'), { type: 'divider' }, p('b')])
  })
})

describe('U4: a replacement that cannot be stored changes nothing', () => {
  it('code `alpha`, then a numbered list at 999,999,999 holding italic `beta` and `next`: XYZ typed from the start of alpha to the start of beta changes nothing', () => {
    const source = { text: '', blocks: [{ type: 'codeBlock', text: 'alpha' } as BlockNode, numbered(MAX_LIST_START, [p('beta', { italic: true })], [p('next')])] }
    for (const backward of [false, true]) {
      const s = open(source)
      if (backward) s.select(6, 0)
      else s.select(0, 6)
      const before = s.content()
      const sel = s.selection()
      type(s, 'XYZ')
      expect(s.content()).toStrictEqual(before)
      expect(s.selection()).toStrictEqual(sel)
      expect(s.canUndo).toBe(false)
      for (const input of INPUTS) {
        const t = open(source)
        t.select(0, 6)
        expect(checkReplacement(t, input), input).toBeNull()
        expect(t.content(), input).toStrictEqual(before)
      }
    }
  })
})

// ---- V1 to V4 -------------------------------------------------------------------------------------------------

describe('V1: every input over a selected divider', () => {
  const shapes: Record<string, BlockNode[]> = {
    'at the start': [{ type: 'divider' }, p('Album'), p('Cover')],
    'in the middle': [p('Album'), { type: 'divider' }, p('Cover')],
    'at the end': [p('Album'), p('Cover'), { type: 'divider' }],
    'inside a list item': [list('bulletList', [p('Album'), { type: 'divider' }], [p('Cover')])],
    'inside a quote': [quote(p('Album'), { type: 'divider' }, p('Cover'))],
  }
  for (const [name, blocks] of Object.entries(shapes)) {
    it(`${name}: Backspace and Delete remove it, anything else puts a line holding the input in its place; one undo brings it back`, () => {
      for (const input of INPUTS) {
        const s = open({ text: '', blocks })
        selectDivider(s, dividers(s.state.doc)[0]!)
        expect(checkDividerReplacement(s, input), `${name}, ${input}`).toBeNull()
      }
    })
  }

  it('the reviewer\'s case: `Album`, a divider, `Cover`; the divider selected, Backspace: both lines kept, the caret at the start of Cover, Undo brings it back', () => {
    const s = open({ text: '', blocks: [p('Album'), { type: 'divider' }, p('Cover')] })
    selectDivider(s, dividers(s.state.doc)[0]!)
    press(s, 'Backspace')
    expect(content(s)).toStrictEqual({ text: 'Album\nCover' })
    expect(s.selection()).toMatchObject({ anchor: 6, head: 6 })
    expect(s.canUndo).toBe(true)
    s.undo()
    expect(content(s).blocks).toStrictEqual([p('Album'), { type: 'divider' }, p('Cover')])
    // A composition: committed into a line in the divider's place.
    selectDivider(s, dividers(s.state.doc)[0]!)
    s.compositionStart()
    insert(s, '仮名', true)
    s.compositionEnd()
    type(s, 'Z')
    expect(content(s)).toStrictEqual({ text: 'Album\n仮名Z\nCover' })
  })
})

describe('V2: the joined line is the line the selection started on, for every input', () => {
  it('a checklist, ticked `Album` and unticked `Cover`, from the start of Album to the start of Cover: the joined line stays ticked', () => {
    for (const input of INPUTS) {
      const s = open({ text: '', blocks: [{ type: 'taskList', items: [{ checked: true, blocks: [p('Album')] }, { checked: false, blocks: [p('Cover')] }] }] })
      s.select(0, 6)
      expect(checkReplacement(s, input), input).toBeNull()
      const t = open({ text: '', blocks: [{ type: 'taskList', items: [{ checked: true, blocks: [p('Album')] }, { checked: false, blocks: [p('Cover')] }] }] })
      t.select(0, 6)
      apply(t, input)
      expect(lineFacts(t.state.doc)[0]!.around, input).toStrictEqual(['taskList', 'ticked'])
    }
  })

  it('`7. Album`, then `21. Cover` and `22. Tail`, from the start of Album to the start of Cover: the joined line is 7 and Tail stays 22', () => {
    const blocks = [numbered(7, [p('Album')]), numbered(21, [p('Cover')], [p('Tail')])]
    for (const input of INPUTS) {
      const s = open({ text: '', blocks })
      s.select(0, 6)
      expect(checkReplacement(s, input), input).toBeNull()
      const t = open({ text: '', blocks })
      t.select(0, 6)
      apply(t, input)
      const painted = paintedOf(t.state.doc)
      expect(painted[0], input).toBe(7)
      expect(painted[painted.length - 1], `${input}: Tail`).toBe(22)
    }
  })
})

describe('V3: a divider at the edges of what is selected', () => {
  it('from the start of Album, through a divider, to the start of Cover: the divider goes with Album for Quote on and off, a list kind change and a list off', () => {
    const s = open({ text: '', blocks: [p('Album'), { type: 'divider' }, p('Cover')] })
    s.select(0, 6)
    expect(checkRule(s, 'blockquote')).toBeNull()
    s.select(0, 6)
    s.toggleBlock('blockquote')
    expect(content(s).blocks).toStrictEqual([quote(p('Album'), { type: 'divider' }), p('Cover')])
    s.select(0, 6)
    s.toggleBlock('blockquote')
    expect(content(s).blocks).toStrictEqual([p('Album'), { type: 'divider' }, p('Cover')])
    const l = open({ text: '', blocks: [list('bulletList', [p('Album'), { type: 'divider' }]), p('Cover')] })
    l.select(0, 6)
    l.toggleBlock('orderedList')
    expect(content(l).blocks).toStrictEqual([list('orderedList', [p('Album'), { type: 'divider' }]), p('Cover')])
    l.select(0, 6)
    l.toggleBlock('orderedList')
    expect(content(l).blocks).toStrictEqual([p('Album'), { type: 'divider' }, p('Cover')])
    // A divider that begins the item of an unselected line stays with that item.
    const u = open({ text: '', blocks: [p('Album'), list('bulletList', [{ type: 'divider' }, p('Cover')])] })
    u.select(0, 6)
    expect(checkRule(u, 'blockquote')).toBeNull()
  })

  it('`Review`, then a numbered list whose first item begins with a divider: Numbered list on all gives one list 1 to 3, the divider still in Album\'s item', () => {
    const blocks = [p('Review'), list('orderedList', [{ type: 'divider' }, p('Album')], [p('Cover')])]
    const want = [list('orderedList', [p('Review')], [{ type: 'divider' }, p('Album')], [p('Cover')])]
    const s = open({ text: '', blocks })
    s.select(0, s.content().text.length)
    expect(checkRule(s, 'orderedList')).toBeNull()
    s.select(0, s.content().text.length)
    s.toggleBlock('orderedList')
    expect(content(s).blocks).toStrictEqual(want)
    // Album's item is 2 (its marker is beside the divider that begins it), Cover 3.
    expect(paintedOf(s.state.doc)).toStrictEqual([1, null, 3])
    expect(boxCommandContent({ text: '', blocks }, { command: toggleBlockKind('orderedList', { wholeBox: true }) })!.blocks).toStrictEqual(want)
  })
})

describe('V4: deciding which dividers travel is one pass', () => {
  it('Quote off on one line of a quote of 6,400 alternating lines and dividers stays quick', () => {
    const inner: BlockNode[] = []
    for (let i = 0; i < 3200; i++) inner.push(p(`l${i}`), { type: 'divider' })
    const s = open({ text: '', blocks: [quote(...inner)] })
    s.select(0)
    const t0 = performance.now()
    expect(s.toggleBlock('blockquote')).toBe(true)
    // About 1,000 ms here when every divider rescanned every line; a single pass takes a few milliseconds.
    expect(performance.now() - t0).toBeLessThan(250)
  })
})

// ---- W1 to W5 -------------------------------------------------------------------------------------------------

describe('W1: an input over a selection changes the formatting of its own characters only', () => {
  it('the reviewer\'s case: a plain `X` pasted from `Al|bum` to `Co|ver` leaves `ver` bold Serif and `Tail` underlined Serif', () => {
    const s = open({ text: '', blocks: [list('orderedList', [p('Album', { italic: true, font: 'mono' })], [p('Cover', { bold: true, font: 'serif' })], [p('Tail', { underline: true, font: 'serif' })])] })
    s.select(2, 8)
    s.paste({ text: 'X' })
    expect(content(s).blocks).toStrictEqual([{ type: 'orderedList', items: [{ blocks: [{ type: 'paragraph', content: [{ text: 'AlX', italic: true, font: 'mono' }, { text: 'ver', bold: true, font: 'serif' }] }] }, { blocks: [p('Tail', { underline: true, font: 'serif' })] }] }])
  })

  it('the same where the replacement is rebuilt (two lists): only the pasted X takes formatting', () => {
    const s = open({ text: '', blocks: [numbered(7, [p('Album', { italic: true, font: 'mono' })]), numbered(21, [p('Cover', { bold: true, font: 'serif' })], [p('Tail', { underline: true, font: 'serif' })])] })
    s.select(2, 8)
    s.paste({ text: 'X' })
    expect(content(s).blocks).toStrictEqual([numbered(7, [{ type: 'paragraph', content: [{ text: 'AlX', italic: true, font: 'mono' }, { text: 'ver', bold: true, font: 'serif' }] }]), numbered(22, [p('Tail', { underline: true, font: 'serif' })])])
  })
})

describe('W2: a cancelled composition gives everything back, with no undo step', () => {
  const shapes: Record<string, BlockNode[]> = {
    'a text that is only a divider': [{ type: 'divider' }],
    'a divider at the end': [p('a'), { type: 'divider' }],
    'a divider between lines': [p('Album'), { type: 'divider' }, p('Cover')],
    'a divider in a list item': [list('bulletList', [p('Album'), { type: 'divider' }], [p('Cover')])],
    'a divider in a quote': [quote(p('Album'), { type: 'divider' }, p('Cover'))],
  }
  for (const [name, blocks] of Object.entries(shapes)) {
    it(`over ${name}: a candidate, then cancelled`, () => {
      const s = open({ text: '', blocks })
      const at = dividers(s.state.doc)[0]!
      selectDivider(s, at)
      const before = s.content()
      s.compositionStart()
      insert(s, 'kana', true)
      // Cancelled: the candidate goes again.
      const { from } = s.state.selection
      s.dispatch(s.state.tr.delete(from - 4, from))
      s.compositionEnd()
      expect(s.content()).toStrictEqual(before)
      expect(s.state.selection).toBeInstanceOf(NodeSelection)
      expect(s.canUndo).toBe(false)
    })
  }

  it('over an ordinary selection in a text with blocks', () => {
    const s = open({ text: '', blocks: [list('bulletList', [p('Album')], [p('Cover')])] })
    s.select(2, 8)
    const before = s.content()
    s.compositionStart()
    insert(s, 'kana', true)
    const { from } = s.state.selection
    s.dispatch(s.state.tr.delete(from - 4, from))
    s.compositionEnd()
    expect(s.content()).toStrictEqual(before)
    expect(s.selection()).toMatchObject({ from: 2, to: 8 })
    expect(s.canUndo).toBe(false)
  })
})

describe('W3: lines after a selection stay in their list; one list numbers on, another keeps its numbers', () => {
  it('`7. Album`, `8. Cover`, `9. Tail`, from the start of Album to the start of Cover: one list, `7. Cover` (or `7. ZCover`) and `8. Tail`, for every input', () => {
    for (const input of INPUTS) {
      const s = open({ text: '', blocks: [numbered(7, [p('Album')], [p('Cover')], [p('Tail')])] })
      s.select(0, 6)
      const meant = apply(s, input)
      const blocks = content(s).blocks!
      // One list (Enter adds an item, numbered on as well).
      expect(blocks.length, input).toBe(1)
      expect(blocks[0]!.type, input).toBe('orderedList')
      expect(content(s).text, input).toBe(input === 'Enter' ? '\nCover\nTail' : `${meant[0]}Cover\nTail`)
      // (A two-line paste puts its second line in the same item: no number beside it.)
      expect(paintedOf(s.state.doc), input).toStrictEqual(input === 'Enter' ? [7, 8, 9] : input === 'paste lines' ? [7, null, 8] : [7, 8])
    }
  })

  it('where the replacement is rebuilt (a code block joining an italic line), the list still numbers on: `7. ZCover`, `8. Tail`', () => {
    for (const input of ['type', 'Backspace'] as const) {
      const s = open({ text: '', blocks: [numbered(7, [{ type: 'codeBlock', text: 'Album' }], [p('Cover', { italic: true })], [p('Tail')])] })
      s.select(0, 6)
      apply(s, input)
      expect(content(s).blocks, input).toStrictEqual([numbered(7, [{ type: 'codeBlock', text: input === 'type' ? 'QRSCover' : 'Cover' }], [p('Tail')])])
    }
  })

  it('`7. Album`, then `21. Cover` and `22. Tail`: `7. ZCover`, and `22. Tail` a list of its own', () => {
    const s = open({ text: '', blocks: [numbered(7, [p('Album')]), numbered(21, [p('Cover')], [p('Tail')])] })
    s.select(0, 6)
    type(s, 'Z')
    expect(content(s).blocks).toStrictEqual([numbered(7, [p('ZCover')]), numbered(22, [p('Tail')])])
  })

  it('Enter over `lb` inside `7. Album` makes a new item: Cover and Tail become 9 and 10', () => {
    const s = open({ text: '', blocks: [numbered(7, [p('Album')], [p('Cover')], [p('Tail')])] })
    s.select(1, 3)
    press(s, 'Enter')
    expect(paintedOf(s.state.doc)).toStrictEqual([7, 8, 9, 10])
  })
})

describe('W4: a divider inside the selected range goes with the selected lines, unless it begins an unselected item', () => {
  it('one quote holding `Album`, a divider, `Cover`; from the start of Album to the start of Cover; Quote: Album and the divider leave the quote', () => {
    const s = open({ text: '', blocks: [quote(p('Album'), { type: 'divider' }, p('Cover'))] })
    s.select(0, 6)
    expect(checkRule(s, 'blockquote')).toBeNull()
    s.select(0, 6)
    s.toggleBlock('blockquote')
    expect(content(s).blocks).toStrictEqual([p('Album'), { type: 'divider' }, quote(p('Cover'))])
  })

  it('a list item holding `Album`, a divider, `Cover`: the kind changed from Album to the start of Cover takes the divider with Album', () => {
    const s = open({ text: '', blocks: [list('bulletList', [p('Album'), { type: 'divider' }, p('Cover')])] })
    s.select(0, 6)
    expect(checkRule(s, 'orderedList')).toBeNull()
    s.select(0, 6)
    s.toggleBlock('orderedList')
    expect(content(s).blocks).toStrictEqual([list('orderedList', [p('Album'), { type: 'divider' }]), list('bulletList', [p('Cover')])])
  })
})

describe('W5: a divider with no line beside it, and Shift+arrows across a divider', () => {
  it('three dividers and no text: the middle one selected, Delete or Backspace leaves an empty line with the caret; Z lands between two dividers', () => {
    for (const key of ['Delete', 'Backspace']) {
      const s = open({ text: '', blocks: [{ type: 'divider' }, { type: 'divider' }, { type: 'divider' }] })
      selectDivider(s, dividers(s.state.doc)[1]!)
      press(s, key)
      type(s, 'Z')
      expect(content(s).blocks, key).toStrictEqual([{ type: 'divider' }, p('Z'), { type: 'divider' }])
    }
    const first = open({ text: '', blocks: [{ type: 'divider' }, { type: 'divider' }, p('a')] })
    selectDivider(first, dividers(first.state.doc)[0]!)
    press(first, 'Delete')
    type(first, 'Z')
    expect(content(first).blocks).toStrictEqual([p('Z'), { type: 'divider' }, p('a')])
  })

  it('Shift+Right at the end of `Album` reaches past the divider to the start of `Cover`; Shift+Left back from the start of Cover reaches the end of Album', () => {
    const s = open({ text: '', blocks: [p('Album'), { type: 'divider' }, p('Cover')] }, { caret: 5 })
    press(s, 'ArrowRight', { shiftKey: true })
    expect(s.selection()).toMatchObject({ anchor: 5, head: 6 })
    const t = open({ text: '', blocks: [p('Album'), { type: 'divider' }, p('Cover')] }, { caret: 6 })
    press(t, 'ArrowLeft', { shiftKey: true })
    expect(t.selection()).toMatchObject({ anchor: 6, head: 5 })
    // Away from a divider the browser moves it (nothing claimed).
    const u = open({ text: '', blocks: [p('Album'), { type: 'divider' }, p('Cover')] }, { caret: 2 })
    expect(press(u, 'ArrowRight', { shiftKey: true })).toBe(false)
  })
})

// ---- R1: a refused composition takes back only itself ---------------------------------------------------

describe('R1: a composition refused at the character bound takes back exactly what it changed', () => {
  const base = 'x'.repeat(MAX_TEXT_LENGTH - 1)
  const compose = (s: EditSession, text: string) => {
    s.compositionStart()
    insert(s, text, true)
    s.compositionEnd()
  }

  it('`A` typed, then `B` composed straight after: `B` goes, `A` stays; redo does not bring `B` back', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: base }] }, { caret: 0 })
    type(s, 'A')
    compose(s, 'B')
    expect(content(s).text).toBe(`A${base}`)
    expect(s.canRedo).toBe(false)
    s.redo()
    expect(content(s).text).toBe(`A${base}`)
    s.undo()
    expect(content(s).text).toBe(base)
    s.redo()
    expect(content(s).text).toBe(`A${base}`)
  })

  it('two compositions in a row, one undo step: the second goes, the first stays', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: base }] }, { caret: 0 })
    compose(s, 'A')
    compose(s, 'B')
    expect(content(s).text).toBe(`A${base}`)
    expect(s.canRedo).toBe(false)
    s.undo()
    expect(content(s).text).toBe(base)
    // Undo grouping is untouched: away from the bound, two quick compositions side by side share one step, as typing does.
    const t = open({ text: 'z' })
    compose(t, 'か')
    compose(t, 'な')
    t.undo()
    expect(content(t).text).toBe('z')
  })

  it('over a selection: one that fits is kept; one that does not gives the selection back', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: `A${base}` }] })
    s.select(0, 1)
    compose(s, 'B')
    expect(content(s).text).toBe(`B${base}`)
    const t = open({ text: '', blocks: [{ type: 'codeBlock', text: `A${base}` }] })
    t.select(0, 1)
    compose(t, 'BC')
    expect(content(t).text).toBe(`A${base}`)
    expect(t.selection()).toMatchObject({ from: 0, to: 1 })
    expect(t.canRedo).toBe(false)
    t.undo()
    expect(content(t).text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH)
  })

  it('a compact text has no bound', () => {
    const s = open({ text: `${base}xx` }, { caret: 0 })
    compose(s, 'A')
    expect(content(s).text).toBe(`A${base}xx`)
  })
})

// ---- R3: code characters never count as a marker ---------------------------------------------------------

describe('R3: a marker character that is inline code never counts towards a shortcut', () => {
  it('an inline-code `-` at the start of a line, a space typed after it outside the code: no bullet', () => {
    const s = open({ text: '', blocks: [{ type: 'paragraph', content: [{ text: '-', code: true }] }] })
    type(s, ' ')
    expect(content(s).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: '-', code: true }, { text: ' ' }] }])
  })

  it('nor an inline-code `#` for a heading, `>` for a quote, `*` for italic, or a backtick for code', () => {
    const cases: Array<[InlineRun[], string]> = [
      [[{ text: '#', code: true }], ' '],
      [[{ text: '>', code: true }], ' '],
      [[{ text: ' ' }, { text: '*', code: true }, { text: 'x' }], '*'],
      [[{ text: ' ' }, { text: '`', code: true }, { text: 'x' }], '`'],
    ]
    for (const [runs, typed] of cases) {
      const s = open({ text: '', blocks: [{ type: 'paragraph', content: runs }] })
      type(s, typed)
      expect(content(s).text, JSON.stringify(runs)).toBe(`${runs.map((x) => x.text).join('')}${typed}`)
    }
  })
})

// ---- R3 test gap: Shift+Tab is a step of its own -------------------------------------------------------

describe('Shift+Tab is an in-edit undo step of its own', () => {
  it('Shift+Tab twice, then one undo: the state in between (two outdents never merge)', () => {
    const s = open({ text: '', blocks: [list('bulletList', [p('a'), list('bulletList', [p('b'), list('bulletList', [p('c')])])])] })
    press(s, 'Tab', { shiftKey: true })
    const once = s.content()
    press(s, 'Tab', { shiftKey: true })
    expect(s.content()).not.toStrictEqual(once)
    s.undo()
    expect(s.content()).toStrictEqual(once)
  })

  it('Tab, Shift+Tab, typing: each undoes on its own, and redoes in order', () => {
    const s = open({ text: '', blocks: [list('bulletList', [p('a')], [p('b')])] })
    press(s, 'Tab')
    const indented = s.content()
    press(s, 'Tab', { shiftKey: true })
    const outdented = s.content()
    type(s, 'xyz')
    s.undo()
    expect(s.content()).toStrictEqual(outdented)
    s.undo()
    expect(s.content()).toStrictEqual(indented)
    s.redo()
    expect(s.content()).toStrictEqual(outdented)
    s.redo()
    expect(s.content().text).toBe('a\nbxyz')
  })

  it('typing, then Shift+Tab: one undo takes back the Shift+Tab only', () => {
    const s = open({ text: '', blocks: [list('bulletList', [p('a'), list('bulletList', [p('b')])])] })
    type(s, 'x')
    press(s, 'Tab', { shiftKey: true })
    expect(content(s).blocks).toStrictEqual([list('bulletList', [p('a')], [p('bx')])])
    s.undo()
    expect(content(s).blocks).toStrictEqual([list('bulletList', [p('a'), list('bulletList', [p('bx')])])])
  })
})

// ---- R5: fonts in a code block ---------------------------------------------------------------------------

describe('R5: a code block is always Mono', () => {
  it('with the caret in one, a font choice sets nothing pending; over a mixed selection, the non-code lines change only', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'const' }, p('prose')] }, { caret: 2 })
    expect(s.setFont('serif')).toBe(false)
    expect(s.pending).toBeNull()
    type(s, 'X')
    expect(content(s).blocks?.[0]).toStrictEqual({ type: 'codeBlock', text: 'coXnst' })
    s.select(0, 12)
    expect(s.setFont('serif')).toBe(true)
    expect(content(s).blocks).toStrictEqual([{ type: 'codeBlock', text: 'coXnst' }, p('prose', { font: 'serif' })])
  })
})
