import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import type { MarkState } from '../model/richText.ts'
import { canonicalTextContent, MAX_BLOCK_DEPTH, MAX_LIST_START, MAX_TEXT_LENGTH, parseBlocks } from '../model/textDoc.ts'
import type { BlockNode, InlineRun } from '../model/types.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { EditSession } from './textSession.ts'
import { docFromText, isListType, nodes, textblocksOf } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import { BLOCK_KINDS, boxBlocks, boxCommandContent, completesShortcut, linesOfSelection, shortcutTransaction, toggleBlockKind } from './textRules.ts'
import type { BlockKind } from './textRules.ts'
import { insert, open, press, type } from './testing/textHarness.ts'

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
}

/** What the last judged press did (for the randomised test's counts). */
const lastPress = { changed: false, refused: false }

/** Judges one press by the rule; returns a description of the first way it was broken, or null. */
function judge(x: Press): string | null {
  lastPress.changed = x.changed
  lastPress.refused = !x.changed && x.lines !== null && textblocksOf(x.beforeDoc).length > 0
  const { kind, before, after } = x
  if (canonicalTextContent(after as unknown as Record<string, unknown>) === null || (after.blocks && parseBlocks(after.blocks) === null)) return 'the result does not load'
  if (lf(after.text) !== lf(before.text)) return `text changed: ${JSON.stringify(before.text)} -> ${JSON.stringify(after.text)}`
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
  const broken = judge({ kind, beforeDoc, before, lines, changed, after, afterDoc: s.state.doc, readout: s.blockFormat().blocks[kind] })
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
  return judge({ kind, beforeDoc: read.doc, before: read.content, lines: { first: 0, last: textblocksOf(read.doc).length - 1 }, changed: result !== null, after, afterDoc, readout: boxBlocks(afterDoc).blocks[kind] })
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
  if (choice === 6) return quote(...blocks(r, depth + 1, lists, 1 + r.int(2)))
  if (lists >= 3) return line(r, 'paragraph')
  const kind = r.pick(LIST_KINDS)
  const items = Array.from({ length: 1 + r.int(3) }, () => {
    const first = r.int(6) === 0 ? { type: 'codeBlock' as const, text: 'c' } : line(r, r.int(5) === 0 ? 'heading' : 'paragraph')
    // Sometimes several paragraphs in one item, sometimes a nested block.
    const more = r.int(3) === 0 ? Array.from({ length: 1 + r.int(2) }, () => line(r, 'paragraph')) : []
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
      } else if (shape <= 3) {
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
