import { describe, expect, it } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { canonicalTextContent, isBlankTextDoc, MAX_BLOCK_DEPTH, MAX_TEXT_LENGTH } from '../model/textDoc.ts'
import type { BlockNode, InlineRun } from '../model/types.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { EditSession } from './textSession.ts'
import { createEditSession } from './textSession.ts'
import { contentFromDoc, plainTextOfDoc, textblocksOf } from './textSchema.ts'
import { matchBlockShortcut, matchCodeShortcut, matchShortcut } from './textRules.ts'
import { insert, open, press, type } from './testing/textHarness.ts'

/**
 * The writing blocks of Slice 3a in the text engine, headless: the typing shortcuts and their
 * Backspace revert and two-step undo, Enter and Backspace in and at the edges of every block, Tab
 * in lists, checkboxes, marks and fonts inside blocks, the canonical record after each change (and
 * the collapse back to the compact form), what counts as blank, the stored bounds and IME. There is
 * no earlier canvas to compare with: every expectation is stated here.
 */

const p = (text?: string, extra: Partial<InlineRun> = {}): BlockNode => (text ? { type: 'paragraph', content: [{ text, ...extra }] } : { type: 'paragraph' })
const bullets = (...items: BlockNode[][]): BlockNode => ({ type: 'bulletList', items: items.map((blocks) => ({ blocks })) })
const tasks = (...items: Array<[boolean, BlockNode[]]>): BlockNode => ({ type: 'taskList', items: items.map(([checked, blocks]) => ({ checked, blocks })) })
const rich = (...blocks: BlockNode[]): TextContent => ({ text: canonicalTextContent({ text: '', blocks })!.text, blocks })

/** The content now, checked against what loading it would give (it is canonical) and against the document's text. */
function content(s: EditSession): TextContent {
  const c = s.content()
  expect(c).toStrictEqual(canonicalTextContent(c as unknown as Record<string, unknown>))
  expect(c.text).toBe(plainTextOfDoc(s.state.doc))
  expect(contentFromDoc(s.state.doc, c)).toStrictEqual(c)
  return c
}

/** Typing `text` straight into a new, empty text. */
function typed(text: string): EditSession {
  const s = open({ text: '' })
  type(s, text)
  return s
}

const caret = (s: EditSession) => s.selection().head

// ---- the matchers ------------------------------------------------------------------------------

describe('the block and inline code matchers (one line, no view)', () => {
  it('fire on the character that completes them, at the start of the line', () => {
    expect(matchBlockShortcut('- ', 2, ' ')).toEqual({ kind: 'bulletList', end: 2 })
    expect(matchBlockShortcut('- Buy', 2, ' ')).toEqual({ kind: 'bulletList', end: 2 })
    expect(matchBlockShortcut('1. ', 3, ' ')).toEqual({ kind: 'orderedList', start: 1, end: 3 })
    expect(matchBlockShortcut('12. ', 4, ' ')).toEqual({ kind: 'orderedList', start: 12, end: 4 })
    expect(matchBlockShortcut('> ', 2, ' ')).toEqual({ kind: 'blockquote', end: 2 })
    expect(matchBlockShortcut('[ ] ', 4, ' ')).toEqual({ kind: 'taskList', checked: false, end: 4 })
    expect(matchBlockShortcut('[] ', 3, ' ')).toEqual({ kind: 'taskList', checked: false, end: 3 })
    expect(matchBlockShortcut('[x] ', 4, ' ')).toEqual({ kind: 'taskList', checked: true, end: 4 })
    expect(matchBlockShortcut('---', 3, '-')).toEqual({ kind: 'divider', end: 3 })
    expect(matchBlockShortcut('```', 3, '`')).toEqual({ kind: 'codeBlock', end: 3 })
    expect(matchBlockShortcut('```js', 3, '`')).toEqual({ kind: 'codeBlock', end: 3 })
    expect(matchCodeShortcut('a `b c`', 7, '`')).toEqual({ kind: 'code', remove: [{ start: 2, end: 3 }, { start: 6, end: 7 }], content: { start: 3, end: 6 } })
  })

  it('stay literal: `* item`, `0. `, a marker after text, `----`, `` `` ``, inner spaces at the edges, a backtick inside a word', () => {
    for (const [line, at, ch] of [
      ['* ', 2, ' '],
      ['+ ', 2, ' '],
      ['0. ', 3, ' '],
      ['a - ', 4, ' '],
      [' - ', 3, ' '],
      ['-  ', 3, ' '],
      ['1.5 ', 4, ' '],
      ['----', 4, '-'],
      ['--- ', 4, ' '],
      ['a---', 4, '-'],
      ['[X ] ', 5, ' '],
      ['x```', 4, '`'],
    ] as const) {
      expect(matchBlockShortcut(line, at, ch), line).toBeNull()
    }
    for (const [line, at] of [
      ['``', 2],
      ['` a`', 4],
      ['`a `', 4],
      ['a`b`', 4],
      ['``a`', 4],
      ['`a``', 3],
    ] as const) {
      expect(matchCodeShortcut(line, at, '`'), line).toBeNull()
    }
    // The pinned literal cases of the heading and mark shortcuts are untouched by the block ones.
    for (const lit of ['2 * 3 * 4', 'a ** b', '* item', 'snake*case*', '#tag ', '#### ']) {
      const ch = lit[lit.length - 1]!
      expect(matchShortcut(lit, lit.length, ch) ?? matchBlockShortcut(lit, lit.length, ch) ?? matchCodeShortcut(lit, lit.length, ch), lit).toBeNull()
    }
  })
})

// ---- typing the shortcuts --------------------------------------------------------------------------

describe('typing a block shortcut converts it, Backspace straight after puts the characters back, and undo takes two steps', () => {
  const cases: Array<{ typed: string; after: TextContent; caretAfter: number }> = [
    { typed: '- ', after: rich(bullets([p()])), caretAfter: 0 },
    { typed: '1. ', after: rich({ type: 'orderedList', items: [{ blocks: [p()] }] }), caretAfter: 0 },
    { typed: '7. ', after: rich({ type: 'orderedList', start: 7, items: [{ blocks: [p()] }] }), caretAfter: 0 },
    { typed: '[] ', after: rich(tasks([false, [p()]])), caretAfter: 0 },
    { typed: '[ ] ', after: rich(tasks([false, [p()]])), caretAfter: 0 },
    { typed: '> ', after: rich({ type: 'blockquote', blocks: [p()] }), caretAfter: 0 },
    { typed: '---', after: rich({ type: 'divider' }, p()), caretAfter: 0 },
    { typed: '```', after: rich({ type: 'codeBlock', text: '' }), caretAfter: 0 },
  ]
  for (const c of cases) {
    it(`\`${c.typed}\``, () => {
      const s = typed(c.typed)
      expect(content(s)).toStrictEqual(c.after)
      expect(caret(s)).toBe(c.caretAfter)
      expect(s.canRevertShortcut).toBe(true)
      // Backspace straight after: the literal characters, the caret after them, nothing deleted.
      press(s, 'Backspace')
      expect(content(s)).toStrictEqual({ text: c.typed })
      expect(caret(s)).toBe(c.typed.length)
      // Redo brings the conversion back (the revert is an in-edit undo step).
      s.redo()
      expect(content(s)).toStrictEqual(c.after)
      // In-edit undo: the conversion, then what was typed (one run of typing).
      s.undo()
      expect(content(s)).toStrictEqual({ text: c.typed })
      s.undo()
      expect(content(s)).toStrictEqual({ text: '' })
    })
  }

  it('`- [ ] Buy vinyl`, typed character by character: `- ` makes a bullet, then `[ ] ` makes it a checklist item, not a bullet holding `[ ] `', () => {
    const s = open({ text: '' })
    type(s, '- [')
    expect(content(s)).toStrictEqual(rich(bullets([p('[')])))
    type(s, ' ] ')
    expect(content(s)).toStrictEqual(rich(tasks([false, [p()]])))
    type(s, 'Buy vinyl')
    expect(content(s)).toStrictEqual(rich(tasks([false, [p('Buy vinyl')]])))
    // Backspace straight after `[ ] ` converted: back to a bullet holding `[ ] `.
    const t = open({ text: '' })
    type(t, '- [ ] ')
    press(t, 'Backspace')
    expect(content(t)).toStrictEqual(rich(bullets([p('[ ] ')])))
    expect(caret(t)).toBe(4)
  })

  it('`- [x] ` makes a ticked item, which is content at once; `[x] ` on a plain line stays as typed', () => {
    const s = typed('- [x] ')
    const c = content(s)
    expect(c).toStrictEqual(rich(tasks([true, [p()]])))
    expect(isBlankTextDoc(c)).toBe(false)
    expect(content(typed('[x] '))).toStrictEqual({ text: '[x] ' })
  })

  it('only one bullet item of several becomes a checklist item; the bullets around it stay, a checklist beside it is joined', () => {
    const s = open({ text: '', blocks: [bullets([p('one')], [p('two')], [p('three')])] }, { caret: 4 })
    type(s, '[ ] ')
    expect(content(s)).toStrictEqual(rich(bullets([p('one')]), tasks([false, [p('two')]]), bullets([p('three')])))
    expect(caret(s)).toBe(4)
    const t = open({ text: '', blocks: [tasks([true, [p('done')]]), bullets([p('next')])] }, { caret: 5 })
    type(t, '[ ] ')
    expect(content(t)).toStrictEqual(rich(tasks([true, [p('done')]], [false, [p('next')]])))
  })

  it('a block shortcut on a line that already has text keeps the text; a list typed after a list of its kind continues it', () => {
    const s = open({ text: 'Buy milk' }, { caret: 0 })
    type(s, '- ')
    expect(content(s)).toStrictEqual(rich(bullets([p('Buy milk')])))
    expect(caret(s)).toBe(0)
    const t = open({ text: '', blocks: [bullets([p('a')]), p('b')] }, { caret: 2 })
    type(t, '- ')
    expect(content(t)).toStrictEqual(rich(bullets([p('a')], [p('b')])))
    // A numbered list continues the one before only when its number follows on.
    const n = open({ text: '', blocks: [{ type: 'orderedList', items: [{ blocks: [p('a')] }] }, p('b'), p('c')] }, { caret: 2 })
    type(n, '2. ')
    expect(content(n).blocks).toStrictEqual([{ type: 'orderedList', items: [{ blocks: [p('a')] }, { blocks: [p('b')] }] }, p('c')])
    const m = open({ text: '', blocks: [{ type: 'orderedList', items: [{ blocks: [p('a')] }] }, p('b')] }, { caret: 2 })
    type(m, '5. ')
    expect(content(m).blocks).toStrictEqual([{ type: 'orderedList', items: [{ blocks: [p('a')] }] }, { type: 'orderedList', start: 5, items: [{ blocks: [p('b')] }] }])
  })

  it('`` `code` `` makes inline code, and what is typed next is plain; in a heading too', () => {
    const s = typed('see `npm test` now')
    expect(content(s)).toStrictEqual(rich({ type: 'paragraph', content: [{ text: 'see ' }, { text: 'npm test', code: true }, { text: ' now' }] }))
    press(s, 'Backspace') // not straight after any more: deletes a character
    expect(content(s).text).toBe('see npm test no')
    const h = typed('# A `b`')
    expect(content(h)).toStrictEqual(rich({ type: 'heading', level: 1, content: [{ text: 'A ' }, { text: 'b', code: true }] }))
    const r = typed('a `b`')
    press(r, 'Backspace')
    expect(content(r)).toStrictEqual({ text: 'a `b`' })
  })

  it('a code block takes the rest of its line as code, and nothing fires inside it', () => {
    const s = open({ text: 'let x' }, { caret: 0 })
    type(s, '```')
    expect(content(s)).toStrictEqual(rich({ type: 'codeBlock', text: 'let x' }))
    type(s, ' # - **a** `b` ')
    expect(content(s).blocks).toStrictEqual([{ type: 'codeBlock', text: ' # - **a** `b` let x' }])
    const t = typed('```')
    type(t, '- > 1. ---')
    expect(content(t).blocks).toStrictEqual([{ type: 'codeBlock', text: '- > 1. ---' }])
  })

  it('`* item` stays literal (owner decision 7), and so do `- ` inside a list item and markers inside inline code', () => {
    expect(content(typed('* item'))).toStrictEqual({ text: '* item' })
    const s = typed('- ')
    type(s, '- > 1. x')
    expect(content(s)).toStrictEqual(rich(bullets([p('- > 1. x')])))
    const c = typed('`a`')
    s.select(0)
    // Inside a code run (between its characters), `*x*` does not become italic.
    const inCode = open({ text: '', blocks: [{ type: 'paragraph', content: [{ text: 'ab', code: true }] }] }, { caret: 1 })
    type(inCode, '*x*')
    expect(content(inCode).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: 'a*x*b', code: true }] }])
    expect(content(c).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: 'a', code: true }] }])
  })

  it('a shortcut never fires on pasted text, nor on text that arrives without a key', () => {
    // A literal paste stays literal (a converted Markdown paste is `markdownToBlocks`, never a typing shortcut).
    const s = open({ text: '' })
    s.paste({ text: '- item\n> q\n---\n`c`', plain: true })
    expect(content(s)).toStrictEqual({ text: '- item\n> q\n---\n`c`' })
    const t = open({ text: '-' })
    insert(t, ' ') // no keydown typed it
    expect(content(t)).toStrictEqual({ text: '- ' })
  })

  it('an IME composition of `-` and a space does not fire; composing inside a list item and a code block keeps the block', () => {
    const s = open({ text: '' })
    s.compositionStart()
    insert(s, '-', true)
    insert(s, ' ', true)
    s.compositionEnd()
    expect(content(s)).toStrictEqual({ text: '- ' })
    const l = open({ text: '', blocks: [bullets([p('ab')])] }, { caret: 1 })
    l.compositionStart()
    insert(l, 'か', true)
    l.compositionEnd()
    expect(content(l)).toStrictEqual(rich(bullets([p('aかb')])))
    const c = open({ text: '', blocks: [{ type: 'codeBlock', text: 'x\ny' }] }, { caret: 2 })
    c.compositionStart()
    insert(c, '語', true)
    c.compositionEnd()
    expect(content(c)).toStrictEqual(rich({ type: 'codeBlock', text: 'x\n語y' }))
    // A command issued during a composition is refused, a block command too.
    c.compositionStart()
    expect(c.toggleBlock('codeBlock')).toBe(false)
    c.compositionEnd()
  })
})

// ---- Enter and Backspace in blocks -------------------------------------------------------------------

describe('Enter and Backspace inside and at the edges of every block', () => {
  it('in a list: Enter makes a new item; Enter on an empty item leaves the list; Backspace at an item start leaves it too', () => {
    const s = typed('- one\ntwo\n')
    expect(content(s)).toStrictEqual(rich(bullets([p('one')], [p('two')], [p()])))
    press(s, 'Enter')
    expect(content(s)).toStrictEqual(rich(bullets([p('one')], [p('two')]), p()))
    type(s, 'after')
    expect(content(s)).toStrictEqual(rich(bullets([p('one')], [p('two')]), p('after')))
    // Backspace at the start of "two": out of the list.
    s.select(4)
    press(s, 'Backspace')
    expect(content(s)).toStrictEqual(rich(bullets([p('one')]), p('two'), p('after')))
    // And again at the start of a plain line after a list: it goes back into the list as its last item.
    press(s, 'Backspace')
    expect(content(s)).toStrictEqual(rich(bullets([p('one')], [p('two')]), p('after')))
  })

  it('Enter in the middle of an item splits it; a new checklist item starts unticked', () => {
    const s = open({ text: '', blocks: [tasks([true, [p('buyvinyl')]])] }, { caret: 3 })
    press(s, 'Enter')
    expect(content(s)).toStrictEqual(rich(tasks([true, [p('buy')]], [false, [p('vinyl')]])))
  })

  it('a numbered list keeps its start through Enter, and Enter on an empty nested item moves it out one level', () => {
    const s = open({ text: '', blocks: [{ type: 'orderedList', start: 3, items: [{ blocks: [p('c'), bullets([p('x')])] }] }] }, { caret: 3 })
    press(s, 'Enter')
    expect(content(s).blocks).toStrictEqual([{ type: 'orderedList', start: 3, items: [{ blocks: [p('c'), bullets([p('x')], [p()])] }] }])
    press(s, 'Enter')
    expect(content(s).blocks).toStrictEqual([{ type: 'orderedList', start: 3, items: [{ blocks: [p('c'), bullets([p('x')])] }, { blocks: [p()] }] }])
  })

  it('in a quote: Enter adds a line to it, Enter on an empty line leaves it, and a split keeps both halves quoted; Backspace at its start lifts the line out', () => {
    const s = typed('> one\n')
    expect(content(s)).toStrictEqual(rich({ type: 'blockquote', blocks: [p('one'), p()] }))
    press(s, 'Enter')
    expect(content(s)).toStrictEqual(rich({ type: 'blockquote', blocks: [p('one')] }, p()))
    const t = open({ text: '', blocks: [{ type: 'blockquote', blocks: [p('abcd')] }] }, { caret: 2 })
    press(t, 'Enter')
    expect(content(t)).toStrictEqual(rich({ type: 'blockquote', blocks: [p('ab'), p('cd')] }))
    t.select(0)
    press(t, 'Backspace')
    expect(content(t)).toStrictEqual(rich(p('ab'), { type: 'blockquote', blocks: [p('cd')] }))
  })

  it('in a code block: Enter is a line break of the code, Enter on its empty last line leaves it, and Backspace at its start turns it back into lines', () => {
    const s = typed('```let a\nlet b\n')
    expect(content(s)).toStrictEqual(rich({ type: 'codeBlock', text: 'let a\nlet b\n' }))
    press(s, 'Enter')
    expect(content(s)).toStrictEqual(rich({ type: 'codeBlock', text: 'let a\nlet b' }, p()))
    type(s, 'prose')
    expect(content(s).text).toBe('let a\nlet b\nprose')
    s.select(0)
    press(s, 'Backspace')
    expect(content(s)).toStrictEqual({ text: 'let a\nlet b\nprose' })
    expect(caret(s)).toBe(0)
  })

  it('a divider: Backspace at the start of the line after it removes it; Delete at the end of the line before it too', () => {
    const s = open({ text: '', blocks: [p('a'), { type: 'divider' }, p('b')] }, { caret: 2 })
    press(s, 'Backspace')
    expect(content(s)).toStrictEqual({ text: 'a\nb' })
    const t = open({ text: '', blocks: [p('a'), { type: 'divider' }, p('b')] }, { caret: 1 })
    press(t, 'Delete')
    expect(content(t)).toStrictEqual({ text: 'a\nb' })
  })

  it('a text emptied to an empty list is blank; a heading line in a list keeps the heading rule (never bold)', () => {
    const s = typed('- x')
    press(s, 'Backspace')
    expect(isBlankTextDoc(content(s))).toBe(true)
    const h = typed('- # Title')
    expect(content(h)).toStrictEqual(rich(bullets([{ type: 'heading', level: 1, content: [{ text: 'Title' }] }])))
    h.select(0, 5)
    h.toggleMark('bold')
    expect(content(h).blocks).toStrictEqual([bullets([{ type: 'heading', level: 1, content: [{ text: 'Title' }] }])])
  })
})

// ---- Tab -------------------------------------------------------------------------------------------

describe('Tab and Shift+Tab in lists', () => {
  it('Tab nests the second item under the first and Shift+Tab lifts it back, the edit staying open; Tab on the first item changes nothing', () => {
    const wants: string[] = []
    const s = open({ text: '', blocks: [bullets([p('one')], [p('two')])] }, { caret: 5, hooks: { onWantsFinish: (r) => wants.push(r) } })
    expect(press(s, 'Tab')).toBe(true)
    expect(content(s)).toStrictEqual(rich(bullets([p('one'), bullets([p('two')])])))
    expect(caret(s)).toBe(5)
    expect(press(s, 'Tab', { shiftKey: true })).toBe(true)
    expect(content(s)).toStrictEqual(rich(bullets([p('one')], [p('two')])))
    s.select(1)
    const before = s.state.doc
    expect(press(s, 'Tab')).toBe(true)
    expect(s.state.doc).toBe(before)
    expect(wants).toEqual([])
    // Shift+Tab on a top-level item takes it out of the list.
    press(s, 'Tab', { shiftKey: true })
    expect(content(s)).toStrictEqual(rich(p('one'), bullets([p('two')])))
  })

  it('in a checklist too; everywhere else Tab asks to leave the edit', () => {
    const wants: string[] = []
    const s = open({ text: '', blocks: [tasks([false, [p('a')]], [true, [p('b')]]), p('c')] }, { caret: 3, hooks: { onWantsFinish: (r) => wants.push(r) } })
    press(s, 'Tab')
    expect(content(s)).toStrictEqual(rich(tasks([false, [p('a'), tasks([true, [p('b')]])]]), p('c')))
    s.select(5)
    press(s, 'Tab')
    expect(wants).toEqual(['tab'])
  })
})

// ---- checkboxes --------------------------------------------------------------------------------------

describe('checkboxes', () => {
  it('toggle as a change of the edit: reported, an in-edit undo step, never changing the words', () => {
    const changes: TextContent[] = []
    const s = open({ text: '', blocks: [tasks([false, [p('Buy vinyl')]])] }, { hooks: { onChange: (c) => changes.push(c) } })
    const item = textblocksOf(s.state.doc)[0]!.pos - 1
    expect(s.toggleTask(item)).toBe(true)
    expect(content(s)).toStrictEqual(rich(tasks([true, [p('Buy vinyl')]])))
    expect(changes).toHaveLength(1)
    s.undo()
    expect(content(s)).toStrictEqual(rich(tasks([false, [p('Buy vinyl')]])))
    expect(s.toggleTask(0)).toBe(false) // not an item
  })
})

// ---- block commands (the Inspector's buttons) ------------------------------------------------------------

describe('the block commands on the selected lines', () => {
  it('bullet, numbered and check lists: on, switch kind, off; the words and selection stay', () => {
    const s = open({ text: 'a\nb\nc' })
    s.select(0, 3)
    expect(s.toggleBlock('bulletList')).toBe(true)
    expect(content(s)).toStrictEqual(rich(bullets([p('a')], [p('b')]), p('c')))
    expect(s.selection()).toMatchObject({ from: 0, to: 3 })
    s.toggleBlock('orderedList')
    expect(content(s).blocks).toStrictEqual([{ type: 'orderedList', items: [{ blocks: [p('a')] }, { blocks: [p('b')] }] }, p('c')])
    s.toggleBlock('taskList')
    expect(content(s).blocks).toStrictEqual([tasks([false, [p('a')]], [false, [p('b')]]), p('c')])
    expect(s.blockFormat().blocks).toMatchObject({ taskList: 'on', bulletList: 'off' })
    s.toggleBlock('taskList')
    expect(content(s)).toStrictEqual({ text: 'a\nb\nc' })
  })

  it('quote and code block on and off; code joins the lines into one block, and coming back gives the lines again', () => {
    const s = open({ text: 'Title\nb\nc', headings: [1] })
    s.select(0, 7)
    s.toggleBlock('blockquote')
    expect(content(s).blocks).toStrictEqual([{ type: 'blockquote', blocks: [{ type: 'heading', level: 1, content: [{ text: 'Title' }] }, p('b')] }, p('c')])
    s.toggleBlock('blockquote')
    expect(content(s)).toStrictEqual({ text: 'Title\nb\nc', headings: [1] })
    s.select(0, 7)
    s.toggleBlock('codeBlock')
    expect(content(s)).toStrictEqual(rich({ type: 'codeBlock', text: 'Title\nb' }, p('c')))
    expect(s.blockFormat().blocks.codeBlock).toBe('on')
    s.toggleBlock('codeBlock')
    expect(content(s)).toStrictEqual({ text: 'Title\nb\nc' })
  })

  it('a divider goes in at the caret, splitting the line, with a line after it for the caret', () => {
    const s = open({ text: 'abcd' }, { caret: 2 })
    s.insertDivider()
    expect(content(s)).toStrictEqual(rich(p('ab'), { type: 'divider' }, p('cd')))
    expect(caret(s)).toBe(3)
    const t = open({ text: 'ab' })
    t.insertDivider()
    expect(content(t)).toStrictEqual(rich(p('ab'), { type: 'divider' }, p()))
    s.undo()
    expect(content(s)).toStrictEqual({ text: 'abcd' })
  })

  it('inline code on a range, and with only a caret for what is typed next', () => {
    const s = open({ text: 'run it' })
    s.select(0, 3)
    s.toggleMark('code')
    expect(content(s).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: 'run', code: true }, { text: ' it' }] }])
    expect(s.blockFormat().code).toBe('on')
    s.select(6)
    s.toggleMark('code')
    expect(s.blockFormat().code).toBe('on')
    type(s, 'x')
    expect(content(s).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: 'run', code: true }, { text: ' it' }, { text: 'x', code: true }] }])
    // Over a range that is partly code, code goes on all of it; again, it comes off, and the text is compact again.
    s.select(0, 7)
    s.toggleMark('code')
    expect(content(s).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: 'run itx', code: true }] }])
    s.toggleMark('code')
    expect(content(s)).toStrictEqual({ text: 'run itx' })
  })

  it('marks and fonts work inside blocks; a code block holds none', () => {
    const s = open({ text: '', blocks: [bullets([p('one two')]), { type: 'codeBlock', text: 'x' }] })
    s.select(0, 3)
    s.toggleMark('italic')
    s.setFont('serif')
    expect(content(s).blocks).toStrictEqual([bullets([{ type: 'paragraph', content: [{ text: 'one', italic: true, font: 'serif' }, { text: ' two' }] }]), { type: 'codeBlock', text: 'x' }])
    s.select(8, 9)
    expect(s.toggleMark('bold')).toBe(false)
    expect(content(s).blocks?.[1]).toStrictEqual({ type: 'codeBlock', text: 'x' })
  })
})

// ---- what counts as blank ------------------------------------------------------------------------------

describe('blank (owner decision 4)', () => {
  it('only `# `, `- `, `> ` or `- [ ] ` typed is blank; a divider or a ticked box is content', () => {
    for (const t of ['# ', '- ', '> ', '- [ ] ', '1. ', '```']) expect(isBlankTextDoc(content(typed(t))), t).toBe(true)
    for (const t of ['---', '- [x] ']) expect(isBlankTextDoc(content(typed(t))), t).toBe(false)
  })
})

// ---- the stored bounds ------------------------------------------------------------------------------

describe('a-card-cannot-grow-past-the-stored-bounds (engine)', () => {
  it('a change that would store blocks deeper than the bound is refused: Tab does nothing at the deepest level', () => {
    // Lists nested five deep: the innermost items' lines are at depth 6, the bound. Its second item
    // cannot go deeper; one level up it still can.
    expect(MAX_BLOCK_DEPTH).toBe(6)
    let inner: BlockNode = bullets([p('a')], [p('b')])
    for (let i = 0; i < 4; i++) inner = bullets([p(`l${i}`), inner])
    const s = open({ text: '', blocks: [inner] })
    const lines = s.content().text.split('\n')
    expect(lines).toEqual(['l3', 'l2', 'l1', 'l0', 'a', 'b'])
    s.select(s.content().text.length)
    const before = s.state.doc
    expect(press(s, 'Tab')).toBe(true)
    expect(s.state.doc).toBe(before)
    // Deeper by a block command is refused the same way: a quote around the deepest line.
    expect(s.toggleBlock('blockquote')).toBe(false)
    expect(s.state.doc).toBe(before)
  })

  it('typing that would push a rich text past the character bound does not happen; a compact text has no bound', () => {
    const long = 'x'.repeat(MAX_TEXT_LENGTH - 1)
    const s = open({ text: '', blocks: [bullets([p(long)])] })
    type(s, 'a')
    expect(content(s).text.length).toBe(MAX_TEXT_LENGTH)
    type(s, 'b')
    expect(content(s).text.length).toBe(MAX_TEXT_LENGTH)
    expect(s.state.doc.textContent.endsWith('a')).toBe(true)
    const c = open({ text: long })
    type(c, 'ab')
    expect(content(c).text.length).toBe(MAX_TEXT_LENGTH + 1)
    // Turning a compact text that is over the bound into a list is refused too.
    expect(c.toggleBlock('bulletList')).toBe(false)
    expect(content(c).blocks).toBeUndefined()
  })
})

describe('a text that goes back to paragraphs and headings', () => {
  it('is stored compact again, exactly as a text that never had a block', () => {
    const s = typed('- a')
    press(s, 'Tab', { shiftKey: true })
    expect(content(s)).toStrictEqual({ text: 'a' })
    const t = typed('```x')
    t.select(0)
    press(t, 'Backspace')
    expect(content(t)).toStrictEqual({ text: 'x' })
  })

  it('a session on a rich text that changes nothing reports nothing and keeps the stored content', () => {
    const blocks = [bullets([p('a')]), { type: 'divider' as const }]
    const s = createEditSession({ text: 'a', blocks })!
    s.select(1)
    expect(s.content()).toStrictEqual({ text: 'a', blocks })
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, 3)))
    expect(s.content()).toStrictEqual({ text: 'a', blocks })
  })
})
