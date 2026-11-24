import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { canonicalTextContent, MAX_TEXT_LENGTH, parseBlocks } from '../model/textDoc.ts'
import type { BlockNode, InlineRun } from '../model/types.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { EditSession } from './textSession.ts'
import { isListType, nodes, textblocksOf } from './textSchema.ts'
import { BLOCK_KINDS, linesOfSelection } from './textRules.ts'
import type { BlockKind } from './textRules.ts'
import { insert, open, press, type } from './testing/textHarness.ts'

/**
 * The rule of the block buttons (lists, quote, code block), pinned by fixed cases and a seeded
 * randomised test: after a button is pressed, every selected line has that block (it was turned on)
 * or none of them has it (it was turned off), so the button reads on or off, never mixed; and every
 * line outside the selection keeps exactly the blocks it had (the kinds of list, quote and code block
 * around it, its ticked state, its text and marks). A change refused for a stored bound changes
 * nothing at all. Also: R1 (a refused composition takes back only itself) and R3 (code characters
 * never count as a marker), and fonts in a code block (R5).
 */

const p = (text?: string, extra: Partial<InlineRun> = {}): BlockNode => (text ? { type: 'paragraph', content: [{ text, ...extra }] } : { type: 'paragraph' })
const list = (kind: 'bulletList' | 'orderedList' | 'taskList', ...items: BlockNode[][]): BlockNode =>
  kind === 'taskList' ? { type: 'taskList', items: items.map((blocks) => ({ checked: false, blocks })) } : { type: kind, items: items.map((blocks) => ({ blocks })) }
const quote = (...blocks: BlockNode[]): BlockNode => ({ type: 'blockquote', blocks })

/** One line as the rule sees it: the blocks around it, outermost first (with a checklist item's tick), what it is, its text and marks. */
interface LineFacts {
  around: string[]
  kind: string
  text: string
  runs: string
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
    return { around, kind: node.type === nodes.heading ? `h${node.attrs.level}` : node.type.name, text: node.textContent, runs: JSON.stringify(node.content.toJSON()) }
  })
}

/** Whether a line has a kind of block, as the controls read it. */
function has(f: LineFacts, kind: BlockKind): boolean {
  if (kind === 'codeBlock') return f.kind === 'codeBlock'
  if (kind === 'blockquote') return f.around.includes('quote')
  const lists = f.around.filter((a) => a === 'bulletList' || a === 'orderedList' || a === 'taskList')
  return lists[lists.length - 1] === kind
}

/** The content now, checked to be what a load gives back. */
function content(s: EditSession): TextContent {
  const c = s.content()
  expect(canonicalTextContent(c as unknown as Record<string, unknown>)).toStrictEqual(c)
  return c
}

/**
 * Presses `kind` on `s` with the selection it has and checks the rule; returns a description of the
 * first way it was broken, or null.
 */
function checkRule(s: EditSession, kind: BlockKind): string | null {
  const doc = s.state.doc
  const before = s.content()
  const facts = lineFacts(doc)
  const { first, last } = linesOfSelection(doc, s.state.selection.from, s.state.selection.to)
  const selected = facts.slice(first, last + 1)
  const on = !selected.every((f) => has(f, kind))
  const changed = s.toggleBlock(kind)
  const after = s.content()
  if (canonicalTextContent(after as unknown as Record<string, unknown>) === null || (after.blocks && parseBlocks(after.blocks) === null)) return 'the result does not load'
  if (after.text !== before.text) return `text changed: ${JSON.stringify(before.text)} -> ${JSON.stringify(after.text)}`
  if (!changed) {
    if (JSON.stringify(after) !== JSON.stringify(before)) return 'reported no change, but changed'
    // Nothing changes only when the bound refuses it (the stored depth would be exceeded).
    return null
  }
  const now = lineFacts(s.state.doc)
  const tail = facts.length - 1 - last
  for (let i = 0; i < first; i++) if (JSON.stringify(now[i]) !== JSON.stringify(facts[i])) return `unselected line ${i} changed: ${JSON.stringify(facts[i])} -> ${JSON.stringify(now[i])}`
  for (let i = 0; i < tail; i++) {
    const a = facts[facts.length - 1 - i]
    const b = now[now.length - 1 - i]
    if (JSON.stringify(a) !== JSON.stringify(b)) return `unselected line ${facts.length - 1 - i} (from the end) changed: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`
  }
  const middle = now.slice(first, now.length - tail)
  const bad = middle.find((f) => has(f, kind) !== on)
  if (bad) return `a selected line does not have the block ${on ? 'on' : 'off'}: ${JSON.stringify(bad)}`
  if (kind !== 'codeBlock') {
    for (let i = 0; i < selected.length; i++) {
      if (middle[i]?.text !== selected[i]!.text || middle[i]?.runs !== selected[i]!.runs || middle[i]?.kind !== selected[i]!.kind) return `selected line ${first + i} lost its text or marks`
    }
  }
  const read = s.blockFormat().blocks[kind]
  if (read !== (on ? 'on' : 'off')) return `the button reads ${read} after turning it ${on ? 'on' : 'off'}`
  s.undo()
  if (JSON.stringify(s.content()) !== JSON.stringify(before)) return 'one undo did not restore the document'
  return null
}

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

/** A short line of text, sometimes with marks (bold, italic, inline code). */
function line(r: Rand, kind: 'paragraph' | 'heading'): BlockNode {
  const words = ['a', 'bc', 'def', 'gh', 'ij k']
  const runs: InlineRun[] = []
  const n = r.int(3)
  for (let i = 0; i < n; i++) {
    const run: InlineRun = { text: r.pick(words) }
    const m = r.int(5)
    if (m === 1) run.bold = true
    if (m === 2) run.italic = true
    if (m === 3) run.code = true
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
  const kind = r.pick(['bulletList', 'orderedList', 'taskList'] as const)
  const items = Array.from({ length: 1 + r.int(3) }, () => {
    const first = r.int(6) === 0 ? { type: 'codeBlock' as const, text: 'c' } : line(r, r.int(5) === 0 ? 'heading' : 'paragraph')
    const rest = r.int(3) === 0 ? [block(r, depth + 1, lists + 1)] : []
    return [first, ...rest]
  })
  const out = list(kind, ...items)
  if (out.type === 'taskList') for (const it of out.items) it.checked = r.int(2) === 0
  if (out.type === 'orderedList' && r.int(3) === 0) out.start = 1 + r.int(20)
  return out
}

function blocks(r: Rand, depth: number, lists: number, n: number): BlockNode[] {
  return Array.from({ length: n }, () => block(r, depth, lists))
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

  it(`holds for ${DOCS} random documents × 3 selections × 5 buttons (seed ${SEED})`, () => {
    const r = random(SEED)
    const failures: string[] = []
    let pressed = 0
    for (let d = 0; d < DOCS && failures.length < 5; d++) {
      // One document in twenty is a long run of sibling one-line quotes or lists (the 65-container case).
      const sibling = r.pick(['blockquote', 'bulletList', 'orderedList', 'taskList'] as const)
      const doc = r.int(20) === 0 ? Array.from({ length: 60 + r.int(10) }, (_, i) => (sibling === 'blockquote' ? quote(p(`q${i}`)) : list(sibling, [p(`l${i}`)]))) : blocks(r, 1, 0, 1 + r.int(5))
      const raw = parseBlocks(doc)
      if (!raw) continue
      for (let k = 0; k < 3; k++) {
        const sel: [number, number] | null = k === 2 ? null : (() => {
          const probe = open({ text: '', blocks: raw })
          return selection(r, probe)
        })()
        for (const kind of BLOCK_KINDS) {
          const s = open({ text: '', blocks: raw })
          const [a, b] = sel ?? [0, s.content().text.length] // the third: everything (the whole-box path)
          s.select(a, b)
          let broken: string | null
          try {
            broken = checkRule(s, kind)
          } catch (e) {
            broken = `threw ${String(e)}`
          }
          pressed++
          if (broken) failures.push(`seed ${SEED}, document ${d}, selection [${a}, ${b}], ${kind}: ${broken}\n  blocks: ${JSON.stringify(raw)}`)
        }
      }
    }
    if (failures.length > 0) console.log(failures.join('\n'))
    console.log(`block-button rule: ${pressed} presses on random documents (seed ${SEED})`)
    expect(failures, failures[0]).toEqual([])
    expect(pressed).toBeGreaterThan(DOCS * 10)
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
