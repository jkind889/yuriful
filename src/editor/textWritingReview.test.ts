import { describe, expect, it } from 'vitest'
import { canonicalTextContent, MAX_LIST_START, MAX_TEXT_LENGTH, parseBlocks } from '../model/textDoc.ts'
import type { BlockNode } from '../model/types.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { EditSession } from './textSession.ts'
import { plainTextOfDoc, textSchema, textblocksOf } from './textSchema.ts'
import { matchBlockShortcut } from './textRules.ts'
import { insert, open, press, type } from './testing/textHarness.ts'

/**
 * The faults the Slice 3a review found in the text engine, each pinned by the case that showed it
 * (numbers are the review's). Every expectation is stated here.
 */

const p = (text?: string, extra: Record<string, unknown> = {}): BlockNode => (text ? ({ type: 'paragraph', content: [{ text, ...extra }] } as BlockNode) : { type: 'paragraph' })
const bullets = (...items: BlockNode[][]): BlockNode => ({ type: 'bulletList', items: items.map((blocks) => ({ blocks })) })
const numbered = (...items: BlockNode[][]): BlockNode => ({ type: 'orderedList', items: items.map((blocks) => ({ blocks })) })
const tasks = (...items: Array<[boolean, BlockNode[]]>): BlockNode => ({ type: 'taskList', items: items.map(([checked, blocks]) => ({ checked, blocks })) })
const quote = (...blocks: BlockNode[]): BlockNode => ({ type: 'blockquote', blocks })

/** The content now, checked to be what a load gives back (canonical, loadable). */
function content(s: EditSession): TextContent {
  const c = s.content()
  expect(canonicalTextContent(c as unknown as Record<string, unknown>)).toStrictEqual(c)
  expect(c.text).toBe(plainTextOfDoc(s.state.doc))
  return c
}

/** A paragraph six levels deep: five quotes around it. */
function deepest(text?: string): BlockNode {
  let b = p(text)
  for (let i = 0; i < 5; i++) b = quote(b)
  return b
}

describe('1. a divider over a selection', () => {
  it('replaces the selected text: `a`, a divider, `c`', () => {
    const s = open({ text: 'abc' })
    s.select(1, 2)
    expect(s.insertDivider()).toBe(true)
    expect(content(s)).toStrictEqual({ text: 'a\nc', blocks: [p('a'), { type: 'divider' }, p('c')] })
  })

  it('replaces all the text: a divider and an empty line after it for the caret', () => {
    const s = open({ text: 'abc' })
    s.select(0, 3)
    s.insertDivider()
    expect(content(s)).toStrictEqual({ text: '', blocks: [{ type: 'divider' }, p()] })
    type(s, 'x')
    expect(content(s).text).toBe('x')
  })

  it('in a text with blocks too, and the typing styling never indexes a document the change has restructured', () => {
    const s = open({ text: '', blocks: [bullets([p('abc')])] })
    s.select(1, 2)
    s.insertDivider()
    expect(content(s).blocks).toStrictEqual([bullets([p('a'), { type: 'divider' }, p('c')])])
  })
})

describe('3. an IME composition that would take a text over the character bound', () => {
  it('is undone straight after it ends (headless); the text stays storable', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'x'.repeat(MAX_TEXT_LENGTH) }] }, { caret: 0 })
    s.compositionStart()
    insert(s, 'か', true)
    s.compositionEnd()
    expect(content(s).text.length).toBe(MAX_TEXT_LENGTH)
    // One that fits is kept.
    const t = open({ text: '', blocks: [{ type: 'codeBlock', text: 'x'.repeat(MAX_TEXT_LENGTH - 1) }] }, { caret: 0 })
    t.compositionStart()
    insert(t, 'か', true)
    t.compositionEnd()
    expect(content(t).text).toBe(`か${'x'.repeat(MAX_TEXT_LENGTH - 1)}`)
  })
})

describe('4. pastes into a code block, and empty pastes', () => {
  it('HTML only: the plain text of the HTML replaces the selection', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'abc' }] })
    s.select(0, 3)
    s.paste({ html: '<p>new</p><p>line</p>' })
    expect(content(s).blocks).toStrictEqual([{ type: 'codeBlock', text: 'new\nline' }])
  })

  it('no text at all (empty HTML, or neither flavour): nothing changes, in a code block and elsewhere', () => {
    for (const data of [{ html: '<img src="x.png">' }, {}, { text: '' }]) {
      const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'abc' }] })
      s.select(0, 3)
      expect(s.paste(data)).toBe(false)
      expect(content(s).blocks).toStrictEqual([{ type: 'codeBlock', text: 'abc' }])
      const t = open({ text: 'abc' })
      t.select(0, 3)
      t.paste(data)
      expect(content(t)).toStrictEqual({ text: 'abc' })
    }
  })
})

describe('5. Backspace after a shortcut the bounds refused', () => {
  it('deletes one character; nothing to revert, and in-edit undo takes back only typing', () => {
    // Each of these would put the line one level deeper (a divider or a code block would not, and converts).
    for (const marker of ['- ', '> ', '1. ', '[] ']) {
      const s = open({ text: '', blocks: [deepest()] })
      type(s, 'keep')
      press(s, 'Enter')
      type(s, marker)
      expect(content(s).text, marker).toBe(`keep\n${marker}`)
      expect(s.canRevertShortcut, marker).toBe(false)
      press(s, 'Backspace')
      expect(content(s).text, marker).toBe(`keep\n${marker.slice(0, -1)}`)
    }
  })
})

describe('6. checkboxes and block commands are in-edit undo steps of their own', () => {
  it('tick, untick, undo: the state in between', () => {
    const s = open({ text: '', blocks: [tasks([false, [p('a')]])] })
    const item = textblocksOf(s.state.doc)[0]!.pos - 1
    s.toggleTask(item)
    s.toggleTask(item)
    s.undo()
    expect(content(s).blocks).toStrictEqual([tasks([true, [p('a')]])])
    s.undo()
    expect(content(s).blocks).toStrictEqual([tasks([false, [p('a')]])])
  })

  it('a divider then typing straight away: undo takes back the typing only; typing then a list: undo takes back the list only', () => {
    const s = open({ text: 'ab' })
    s.insertDivider()
    type(s, 'c')
    s.undo()
    expect(content(s)).toStrictEqual({ text: 'ab\n', blocks: [p('ab'), { type: 'divider' }, p()] })
    const t = open({ text: '' })
    type(t, 'word')
    t.toggleBlock('bulletList')
    t.undo()
    expect(content(t)).toStrictEqual({ text: 'word' })
    // Two commands straight after each other: two steps.
    t.toggleBlock('taskList')
    t.toggleBlock('taskList')
    t.undo()
    expect(content(t).blocks?.[0]?.type).toBe('taskList')
  })

  it('Tab and Shift+Tab are steps of their own too', () => {
    const s = open({ text: '', blocks: [bullets([p('a')], [p('b')])] })
    type(s, 'x')
    press(s, 'Tab')
    s.undo()
    expect(content(s).blocks).toStrictEqual([bullets([p('a')], [p('bx')])])
  })
})

describe('7. Enter over a selection across list items', () => {
  it('deletes the selection, then splits there: `a` and `ef` in separate items', () => {
    const s = open({ text: '', blocks: [bullets([p('abc')], [p('def')])] })
    s.select(1, 5)
    press(s, 'Enter')
    expect(content(s).blocks).toStrictEqual([bullets([p('a')], [p('ef')])])
    expect(s.selection().head).toBe(2)
  })

  it('from a line before the list into an item too', () => {
    const s = open({ text: '', blocks: [p('xy'), bullets([p('abc')])] })
    s.select(1, 4)
    press(s, 'Enter')
    expect(content(s).text).toBe('x\nbc')
  })
})

describe('8. Enter in a code block inside a list item', () => {
  it('is a line break of the code; Enter twice at its end leaves it, still in the item', () => {
    const s = open({ text: '', blocks: [bullets([{ type: 'codeBlock', text: 'ab' }])] }, { caret: 1 })
    press(s, 'Enter')
    expect(content(s).blocks).toStrictEqual([bullets([{ type: 'codeBlock', text: 'a\nb' }])])
    s.select(3)
    press(s, 'Enter')
    press(s, 'Enter')
    expect(content(s).blocks).toStrictEqual([bullets([{ type: 'codeBlock', text: 'a\nb' }, p()])])
  })
})

describe('9. list and quote buttons act on every selected line', () => {
  it('(a) an outer and a nested bullet both become numbered, and the button then shows on', () => {
    const s = open({ text: '', blocks: [bullets([p('outer'), bullets([p('inner')])])] })
    s.select(0, 11)
    s.toggleBlock('orderedList')
    expect(content(s).blocks).toStrictEqual([numbered([p('outer'), numbered([p('inner')])])])
    expect(s.blockFormat().blocks.orderedList).toBe('on')
  })

  it('(b) two sibling lists, or two sibling quotes, shown on: pressing takes every line out, and the button then shows off', () => {
    const s = open({ text: '', blocks: [bullets([p('one')]), bullets([p('two')])] })
    s.select(0, 7)
    expect(s.blockFormat().blocks.bulletList).toBe('on')
    s.toggleBlock('bulletList')
    expect(content(s)).toStrictEqual({ text: 'one\ntwo' })
    expect(s.blockFormat().blocks.bulletList).toBe('off')
    const q = open({ text: '', blocks: [quote(p('one')), quote(p('two'))] })
    q.select(0, 7)
    q.toggleBlock('blockquote')
    expect(content(q)).toStrictEqual({ text: 'one\ntwo' })
    expect(q.blockFormat().blocks.blockquote).toBe('off')
  })

  it('a nested bullet and its parent, shown on, both leave every bullet list; quotes inside quotes too', () => {
    const s = open({ text: '', blocks: [bullets([p('outer'), bullets([p('inner')])])] })
    s.select(0, 11)
    s.toggleBlock('bulletList')
    expect(content(s)).toStrictEqual({ text: 'outer\ninner' })
    const q = open({ text: '', blocks: [quote(p('a'), quote(p('b')))] })
    q.select(0, 3)
    q.toggleBlock('blockquote')
    expect(content(q)).toStrictEqual({ text: 'a\nb' })
  })
})

describe('10. no shortcut fires inside inline code', () => {
  it('a space between `-` and `x` of a code run stays a space; so do `> `, `# ` and `1. `', () => {
    for (const marker of ['-', '>', '#', '1.']) {
      const s = open({ text: '', blocks: [{ type: 'paragraph', content: [{ text: `${marker}x`, code: true }] }] }, { caret: marker.length })
      type(s, ' ')
      expect(content(s).blocks, marker).toStrictEqual([{ type: 'paragraph', content: [{ text: `${marker} x`, code: true }] }])
    }
  })

  it('`*x*` typed after a space inside a code run stays literal (at a word boundary, where it would fire outside code)', () => {
    const s = open({ text: '', blocks: [{ type: 'paragraph', content: [{ text: 'A Z', code: true }] }] }, { caret: 2 })
    type(s, '*x*')
    expect(content(s).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: 'A *x*Z', code: true }] }])
    // The same typed outside code fires.
    const t = open({ text: 'A Z' }, { caret: 2 })
    type(t, '*x*')
    expect(content(t)).toStrictEqual({ text: 'A xZ', spans: [{ start: 2, end: 3, italic: true }] })
  })
})

describe('11 and R4. a numbered list starts at any number from 1 to 999,999,999, for the shortcut and storage alike', () => {
  it('999,999,999 converts; 1,000,000,000 stays as typed; so does 0', () => {
    expect(MAX_LIST_START).toBe(999_999_999)
    const s = open({ text: '' })
    type(s, '999999999. ')
    expect(content(s).blocks).toStrictEqual([{ type: 'orderedList', start: 999_999_999, items: [{ blocks: [p()] }] }])
    const t = open({ text: '' })
    type(t, '1000000000. ')
    expect(content(t)).toStrictEqual({ text: '1000000000. ' })
    expect(matchBlockShortcut('999999999. ', 11, ' ')).toEqual({ kind: 'orderedList', start: 999_999_999, end: 11 })
    expect(matchBlockShortcut('1000000000. ', 12, ' ')).toBeNull()
    expect(matchBlockShortcut('0. ', 3, ' ')).toBeNull()
  })

  it('the validator does not take a stored start over the limit (it is read as 1, as any other invalid start is), and the schema refuses it', () => {
    const list = (start: number) => [{ type: 'orderedList', start, items: [{ blocks: [{ type: 'paragraph', content: [{ text: 'a' }] }] }] }]
    expect(parseBlocks(list(999_999_999))).toStrictEqual(list(999_999_999))
    expect(parseBlocks(list(1_000_000_000))).toStrictEqual([{ type: 'orderedList', items: [{ blocks: [{ type: 'paragraph', content: [{ text: 'a' }] }] }] }])
    expect(() => textSchema.nodes.orderedList!.create({ start: 1_000_000_000 }, textSchema.nodes.listItem!.create(null, textSchema.nodes.paragraph!.create()))).toThrow()
  })
})

describe('12 and 13. pinned as they are today (open design questions)', () => {
  it('12: Enter on an empty bullet nested directly in a checklist item gives another paragraph in that item (not a new checklist item)', () => {
    // Open design question: whether it should move out to the checklist as a new item, as an empty
    // nested item of the same kind does. Today a list item of another kind's list is lifted into the
    // parent item.
    const s = open({ text: '', blocks: [tasks([false, [p('parent'), bullets([p()])]])] })
    press(s, 'Enter')
    expect(content(s).blocks).toStrictEqual([tasks([false, [p('parent'), p()]])])
  })

  it('13: Ctrl+A then Delete leaves a leading divider, or a ticked empty item, behind; Backspace on the line left removes it', () => {
    const s = open({ text: '', blocks: [{ type: 'divider' }, p('text')] })
    press(s, 'a', { ctrlKey: true })
    press(s, 'Delete')
    expect(content(s)).toStrictEqual({ text: '', blocks: [{ type: 'divider' }, p()] })
    press(s, 'Backspace')
    expect(content(s)).toStrictEqual({ text: '' })
    const t = open({ text: '', blocks: [tasks([true, [p('text')]])] })
    press(t, 'a', { ctrlKey: true })
    press(t, 'Delete')
    expect(content(t)).toStrictEqual({ text: '', blocks: [tasks([true, [p()]])] })
    press(t, 'Backspace')
    expect(content(t)).toStrictEqual({ text: '' })
  })
})

describe('15. a paste that would take a rich text over a bound', () => {
  it('is refused; one that fits is kept; undo and redo stay within the bound', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'x'.repeat(MAX_TEXT_LENGTH - 2) }] })
    s.paste({ text: '12' })
    expect(content(s).text.length).toBe(MAX_TEXT_LENGTH)
    s.paste({ text: '3' })
    expect(content(s).text.length).toBe(MAX_TEXT_LENGTH)
    s.undo()
    expect(content(s).text.length).toBe(MAX_TEXT_LENGTH - 2)
    s.redo()
    expect(content(s).text.length).toBe(MAX_TEXT_LENGTH)
    // Paste of many lines into a list at the node bound: refused.
    const items = Array.from({ length: 3333 }, (_, i) => [p(`w${i}`)])
    const l = open({ text: '', blocks: [bullets(...items)] })
    l.paste({ text: 'a\nb' })
    expect((content(l).blocks?.[0] as { items: unknown[] }).items).toHaveLength(3333)
  })
})

describe('21. marks in a code block', () => {
  it('do nothing on a selection inside one, with only a caret in one, or by key; a mixed selection formats the lines outside it', () => {
    const s = open({ text: '', blocks: [{ type: 'codeBlock', text: 'const x' }, p('prose')] })
    s.select(0, 7)
    expect(s.toggleMark('bold')).toBe(false)
    expect(s.toggleMark('code')).toBe(false)
    s.select(2)
    expect(s.toggleMark('italic')).toBe(false)
    expect(s.pending).toBeNull()
    s.select(0, 13)
    expect(s.toggleMark('bold')).toBe(true)
    expect(content(s).blocks).toStrictEqual([{ type: 'codeBlock', text: 'const x' }, p('prose', { bold: true })])
    expect(s.blockFormat().blocks.codeBlock).toBe('mixed')
  })
})
