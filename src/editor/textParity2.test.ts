import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import type { TextContent } from '../model/textDoc.ts'
import { docFromText } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import { insert, open, press, type } from './testing/textHarness.ts'
import type { EditSession } from './textSession.ts'

/**
 * Parity with today's canvas, second review round (letters as in the review). Marks after
 * typing, Enter and deletions over a selection are also checked against Fabric's real
 * `onInput` in Chromium (`e2e/text-engine-parity.spec.ts`).
 */

const hosts: HTMLElement[] = []
afterEach(() => {
  hosts.splice(0).forEach((h) => h.remove())
  vi.useRealTimers()
})

const showsRecord = (s: EditSession) => expect(s.state.doc.eq(docFromText(s.content())!.doc)).toBe(true)

function mountedSession(source: Parameters<typeof open>[0], hooks: Parameters<typeof open>[1] = {}) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  hosts.push(el)
  const s = open(source, hooks)
  s.mount(el)
  return { s, el }
}

// ---- A: a composition ended early -----------------------------------------------------------------

describe('a composition ended early leaves exactly what a completed one leaves', () => {
  const boldA: TextSource = { text: 'a', spans: [{ start: 0, end: 1, bold: true }] }

  it('mid-composition, the content (what a save reads) is already the final plain `á`', () => {
    const seen: TextContent[] = []
    const s = open(boldA, { hooks: { onChange: (c) => seen.push(c) } })
    s.toggleMark('bold')
    s.compositionStart()
    insert(s, '́', true)
    expect(s.content()).toStrictEqual({ text: 'á' })
    expect(seen.every((c) => c.spans === undefined)).toBe(true)
  })

  it('finishing before the composition is committed saves plain `á` and shows it in the static HTML', () => {
    const { s, el } = mountedSession(boldA)
    s.toggleMark('bold')
    s.compositionStart()
    insert(s, '́', true)
    s.finish() // the press outside, while still composing
    expect(s.content()).toStrictEqual({ text: 'á' })
    expect(el.innerHTML).toBe('<p>á</p>')
    showsRecord(s) // the session's own final document too
  })

  it('the same when the board went read-only first: the static HTML still shows the final form', () => {
    let editable = true
    const { s, el } = mountedSession(boldA, { hooks: { canEdit: () => editable } })
    s.toggleMark('bold')
    s.compositionStart()
    insert(s, '́', true)
    editable = false
    s.finish()
    expect(el.innerHTML).toBe('<p>á</p>')
    expect(s.content()).toStrictEqual({ text: 'á' })
  })
})

// ---- B: no selection inside a character ------------------------------------------------------------

describe('no transaction leaves a selection end inside a character', () => {
  it('bold 👍, bold off, a composed 🏽, undo, redo, Backspace: the whole 👍🏽 goes', () => {
    const s = open({ text: '\u{1F44D}', spans: [{ start: 0, end: 2, bold: true }] })
    s.toggleMark('bold')
    s.compositionStart()
    insert(s, '\u{1F3FD}', true)
    s.compositionEnd()
    s.undo()
    s.redo()
    expect(s.selection().head).toBe(4)
    press(s, 'Backspace')
    expect(s.content().text).toBe('')
  })

  it('a decomposed accent: redo puts the caret after the whole character, where the edit left it', () => {
    const s = open({ text: 'a' })
    s.compositionStart()
    insert(s, '́', true)
    s.compositionEnd()
    expect(s.selection().head).toBe(2)
    s.undo()
    s.redo()
    expect(s.selection().head).toBe(2)
  })

  it('any transaction: a caret inside a character goes to its end, a range grows to whole characters (either direction)', () => {
    const s = open({ text: 'xá\u{1F44D}\u{1F3FD}y' })
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, 3)))
    expect(s.selection().head).toBe(3 + 0) // offset 2 → after `á` (offset 3)
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, 3, 6)))
    expect(s.selection()).toMatchObject({ anchor: 1, head: 7 })
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, 6, 3)))
    expect(s.selection()).toMatchObject({ anchor: 7, head: 1 })
  })
})

// ---- C: replacing a selection that holds a line break ------------------------------------------------

describe('typing, Enter and deletions over a selection are styled as today', () => {
  it('`a\\nb`, only `a` italic, the break selected backward, Enter: italic over `a\\nb`, as the canvas stores it', () => {
    const s = open({ text: 'a\nb', spans: [{ start: 0, end: 1, italic: true }] })
    s.select(2, 1)
    press(s, 'Enter')
    expect(s.content()).toStrictEqual({ text: 'a\nb', spans: [{ start: 0, end: 3, italic: true }] })
    showsRecord(s)
  })

  it('`ab\\ncd` (second line H2), the break selected and `x` typed: the `x` is italic and underlined', () => {
    const iu = { italic: true as const, underline: true as const }
    const s = open({ text: 'ab\ncd', headings: [0, 2], spans: [{ start: 0, end: 1, ...iu }, { start: 1, end: 2, strike: true }, { start: 3, end: 4, ...iu }, { start: 4, end: 5, strike: true }] })
    s.select(2, 3)
    type(s, 'x')
    const c = s.content()
    expect(c.text).toBe('abxcd')
    expect(c.spans?.find((sp) => sp.start <= 2 && sp.end > 2)).toMatchObject(iu)
    showsRecord(s)
  })
})

// ---- D: a paragraph of spaces ----------------------------------------------------------------------------

describe('a whitespace-only paragraph keeps its spaces in a rich paste', () => {
  it('`<p>x</p><p>   </p><p>y</p>` after `A` gives `Ax\\n   \\ny`', () => {
    const s = open({ text: 'A' })
    s.paste({ html: '<p>x</p><p>   </p><p>y</p>' })
    expect(s.content().text).toBe('Ax\n   \ny')
  })

  it('a line of spaces copied inside a card comes back as spaces', () => {
    const { s } = mountedSession({ text: 'a\n   \nb' })
    s.select(0, 7)
    const copy = s.view!.serializeForClipboard(s.state.selection.content())
    s.select(7)
    s.paste({ html: copy.dom.innerHTML, text: copy.text })
    expect(s.content().text).toBe('a\n   \nba\n   \nb')
  })
})

// ---- E: "plain after a shortcut" follows the history step --------------------------------------------------

describe('"plain after a shortcut" comes back exactly when that conversion step is redone', () => {
  /** Each call in its own history event (the history groups changes less than 500 ms apart). */
  function apart() {
    vi.setSystemTime(Date.now() + 1000)
  }

  it('`**b**`, Left, Right, `x`, undo, `y`: an undo that lands on the shortcut’s document brings nothing back, `by` is bold', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = open({ text: 'go ' })
    type(s, '**b**')
    s.select(3)
    s.select(4)
    apart()
    type(s, 'x')
    expect(s.content()).toStrictEqual({ text: 'go bx', spans: [{ start: 3, end: 5, bold: true }] })
    apart()
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'go b', spans: [{ start: 3, end: 4, bold: true }] })
    type(s, 'y')
    expect(s.content()).toStrictEqual({ text: 'go by', spans: [{ start: 3, end: 5, bold: true }] })
  })

  it('21 conversions, everything undone, the first literal and its conversion redone, `x`: only `b` bold (no cap on remembered conversions)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = open()
    for (let i = 0; i < 21; i++) {
      apart()
      type(s, '**b**')
      apart()
      type(s, ' ')
    }
    expect(s.content().text).toBe('b '.repeat(21))
    while (s.canUndo) s.undo()
    expect(s.content().text).toBe('')
    s.redo()
    expect(s.content().text).toBe('**b**')
    s.redo()
    expect(s.content()).toStrictEqual({ text: 'b', spans: [{ start: 0, end: 1, bold: true }] })
    type(s, 'x')
    expect(s.content()).toStrictEqual({ text: 'bx', spans: [{ start: 0, end: 1, bold: true }] })
  })
})

// ---- F: the headless drop ------------------------------------------------------------------------------------

describe('the headless drop selects what was dropped, as a real drop does', () => {
  it('`word` moved to the end of `Hword\\nbody` is selected at [6, 10); typing replaces it', () => {
    const s = open({ text: 'Hword\nbody', headings: [1] })
    s.drop(s.dragSlice(1, 5), 10, { from: 1, to: 5 })
    expect(s.selection()).toMatchObject({ from: 6, to: 10, anchor: 6, head: 10 })
    type(s, 'x')
    expect(s.content().text).toBe('H\nbodyx')
  })
})

// ---- G: nothing changed, nothing reported ----------------------------------------------------------------------

describe('onChange fires only when the content really changed', () => {
  it('the break of `a\\nb` (levels [1, 2]) replaced by Enter: no report; a real change after it: one', () => {
    const seen: TextContent[] = []
    const s = open({ text: 'a\nb', headings: [1, 2] }, { hooks: { onChange: (c) => seen.push(c) } })
    s.select(1, 2)
    press(s, 'Enter')
    expect(seen).toEqual([])
    type(s, 'z')
    expect(seen).toEqual([{ text: 'a\nzb', headings: [1, 2] }])
  })

  it('a change and its undo report twice; a box setting that changes nothing reports nothing', () => {
    const seen: string[] = []
    const s = open({ text: 'a' }, { hooks: { onChange: (c) => seen.push(c.text) } })
    type(s, 'b')
    s.undo()
    s.setBox({ color: '#1d2230' })
    expect(seen).toEqual(['ab', 'a'])
  })
})

// ---- H: weight inside a pasted heading -------------------------------------------------------------------------

describe('all text of a pasted heading arrives bold', () => {
  it('`<h2><span style="font-weight:normal">Big</span></h2>` is bold', () => {
    const s = open()
    s.paste({ html: '<h2><span style="font-weight:normal">Big</span> <b style="font-weight:400">deal</b></h2><p><span style="font-weight:normal">x</span></p>' })
    expect(s.content()).toStrictEqual({ text: 'Big deal\nx', spans: [{ start: 0, end: 8, bold: true }] })
  })
})
