import { afterEach, describe, expect, it, vi } from 'vitest'
import { docFromText, posAtTextOffset, textSchema } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import { open, press, type } from './testing/textHarness.ts'
import type { EditSession } from './textSession.ts'

/**
 * Parity with today's canvas, third review round (numbers as in the review). Text arriving
 * by IME or insertion over a selection is also checked on a mounted view in Chromium against
 * Fabric's real `onInput` (`e2e/text-engine-parity.spec.ts`).
 */

afterEach(() => {
  vi.useRealTimers()
})

const showsRecord = (s: EditSession) => expect(s.state.doc.eq(docFromText(s.content())!.doc)).toBe(true)

/** `ab\ncd` with only `b` bold, the line break selected. */
function breakSelected() {
  const s = open({ text: 'ab\ncd', spans: [{ start: 1, end: 2, bold: true }] })
  s.select(2, 3)
  return s
}

/** What ProseMirror dispatches when it reads text the browser put over the selection: the text with the marks it found in the DOM (here, the bold of `b`). */
const browserReplacement = (s: EditSession, text: string) => {
  const { from, to } = s.state.selection
  s.dispatch(s.state.tr.replaceWith(from, to, textSchema.text(text, [textSchema.marks.bold!.create()])))
}

// ---- 1: every replacement of a selection, whatever its source ----------------------------------------------

describe('text that replaces a selection is styled as today, whatever brought it', () => {
  it('an insertion that ProseMirror reads from the browser (no key, no composition): only `b` stays bold', () => {
    const s = breakSelected()
    browserReplacement(s, 'カ')
    expect(s.content()).toStrictEqual({ text: 'abカcd', spans: [{ start: 1, end: 2, bold: true }] })
    showsRecord(s)
  })

  it('an IME composition over the selection: final from the start (what a save reads mid-composition), applied when it ends', () => {
    const s = breakSelected()
    s.compositionStart()
    browserReplacement(s, 'k')
    expect(s.content()).toStrictEqual({ text: 'abkcd', spans: [{ start: 1, end: 2, bold: true }] })
    const k = posAtTextOffset(s.state.doc, 2) // the composed `k`, now `カ`
    s.dispatch(s.state.tr.replaceWith(k, k + 1, textSchema.text('カ', [textSchema.marks.bold!.create()])))
    expect(s.content()).toStrictEqual({ text: 'abカcd', spans: [{ start: 1, end: 2, bold: true }] })
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'abカcd', spans: [{ start: 1, end: 2, bold: true }] })
    showsRecord(s)
  })

  it('a composition over the selection ended by finishing the session: the same record', () => {
    const s = breakSelected()
    s.compositionStart()
    browserReplacement(s, 'カ')
    s.finish()
    expect(s.content()).toStrictEqual({ text: 'abカcd', spans: [{ start: 1, end: 2, bold: true }] })
    showsRecord(s)
  })

  it('a formatting command over a range is not a replacement (its marks stay)', () => {
    const s = open({ text: 'abc' })
    s.select(0, 2)
    s.toggleMark('italic')
    expect(s.content()).toStrictEqual({ text: 'abc', spans: [{ start: 0, end: 2, italic: true }] })
  })
})

// ---- 2: layout whitespace between block elements -------------------------------------------------------------

describe('whitespace between block elements is layout, even inside a block', () => {
  it('`<div><div>x</div> <div>y</div></div>` after `A` gives `Ax\\ny`; `<p>   </p>` keeps its spaces', () => {
    const s = open({ text: 'A' })
    s.paste({ html: '<div><div>x</div> <div>y</div></div>' })
    expect(s.content().text).toBe('Ax\ny')
    const t = open({ text: 'A' })
    t.paste({ html: '<p>x</p><p>   </p><div>y <b>z</b></div>' })
    expect(t.content().text).toBe('Ax\n   \ny z')
  })
})

// ---- 3: a discarded conversion is forgotten -------------------------------------------------------------------

describe('a conversion the history discarded leaves nothing behind at its depth', () => {
  const apart = () => vi.setSystemTime(Date.now() + 1000)
  const boldB: TextSource = { text: 'B ', spans: [{ start: 0, end: 1, bold: true }] }

  it('`**b**`, Backspace (revert), caret after `B`, `q`, undo, redo, `y`: `Bqy` stays bold', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = open(boldB)
    type(s, '**b**')
    press(s, 'Backspace')
    expect(s.content()).toStrictEqual({ text: 'B **b**', spans: [{ start: 0, end: 1, bold: true }] })
    s.select(1)
    apart()
    type(s, 'q')
    apart()
    s.undo()
    s.redo()
    type(s, 'y')
    expect(s.content()).toStrictEqual({ text: 'Bqy **b**', spans: [{ start: 0, end: 3, bold: true }] })
  })

  it('the same after an undone (not reverted) conversion', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = open(boldB)
    type(s, '**b**')
    s.undo()
    s.select(1)
    apart()
    type(s, 'q')
    apart()
    s.undo()
    s.redo()
    type(s, 'y')
    expect(s.content()).toStrictEqual({ text: 'Bqy **b**', spans: [{ start: 0, end: 3, bold: true }] })
  })
})
