import { afterEach, describe, expect, it } from 'vitest'
import { docFromText } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import { insert, open } from './testing/textHarness.ts'
import type { EditSession } from './textSession.ts'

/**
 * Parity with today's canvas, fourth review round: IME composition as a first-class input
 * (marks of composed text over a selection follow rule R5 since the sixth round)
 * (numbers as in the review). Real compositions on a mounted view are checked in Chromium
 * against Fabric fed the same updates (`e2e/text-engine-parity.spec.ts`).
 */

const hosts: HTMLElement[] = []
afterEach(() => {
  hosts.splice(0).forEach((h) => h.remove())
})

const showsRecord = (s: EditSession) => expect(s.state.doc.eq(docFromText(s.content())!.doc)).toBe(true)

function mounted(source: TextSource) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  hosts.push(el)
  const s = open(source)
  s.mount(el)
  return { s, el }
}

// ---- 1: keys ProseMirror makes up -------------------------------------------------------------------------

describe('the editing keys act only on real key presses, never during a composition', () => {
  it('a Backspace ProseMirror makes up from a DOM change is declined; a real one deletes', () => {
    const { s, el } = mounted({ text: 'XY' })
    const view = s.view!
    const madeUp = document.createEvent('Event') // how ProseMirror builds it (prosemirror-view `keyEvent`)
    madeUp.initEvent('keydown', true, true)
    Object.assign(madeUp, { keyCode: 8, key: 'Backspace', code: 'Backspace' })
    expect(view.someProp('handleKeyDown', (f) => f(view, madeUp as KeyboardEvent))).toBeFalsy()
    expect(s.content().text).toBe('XY')
    const real = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    el.dispatchEvent(real)
    expect(real.defaultPrevented).toBe(true)
    expect(s.content().text).toBe('X')
  })

  it('a real Backspace or Delete while composing is left to the IME', () => {
    const { s, el } = mounted({ text: 'XY' })
    s.compositionStart()
    for (const key of ['Backspace', 'Delete']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
    expect(s.content().text).toBe('XY')
    s.compositionEnd()
  })
})

// ---- 2: each update of a composition as its own input -------------------------------------------------------

describe('composed text over a selection takes the marks of the first selected character (rule R5)', () => {
  it('`bcD` (`b` bold, `D` underlined), the plain `c` selected, compose `k` → `ka`: `ka` plain (the canvas underlines it; an approved difference)', () => {
    const s = open({ text: 'bcD', spans: [{ start: 0, end: 1, bold: true }, { start: 2, end: 3, underline: true }] })
    s.select(1, 2)
    s.compositionStart()
    insert(s, 'k', true)
    insert(s, 'a', true)
    const expected = { text: 'bkaD', spans: [{ start: 0, end: 1, bold: true }, { start: 3, end: 4, underline: true }] }
    expect(s.content()).toStrictEqual(expected) // already the final form mid-composition
    s.compositionEnd()
    expect(s.content()).toStrictEqual(expected)
    showsRecord(s)
  })

  it('the same composition ended by finishing the session', () => {
    const s = open({ text: 'bcD', spans: [{ start: 0, end: 1, bold: true }, { start: 2, end: 3, underline: true }] })
    s.select(1, 2)
    s.compositionStart()
    insert(s, 'k', true)
    insert(s, 'a', true)
    s.finish()
    expect(s.content()).toStrictEqual({ text: 'bkaD', spans: [{ start: 0, end: 1, bold: true }, { start: 3, end: 4, underline: true }] })
    showsRecord(s)
  })

  it('a cancelled composition leaves the text as it was', () => {
    const s = open({ text: 'ab', spans: [{ start: 0, end: 1, bold: true }] })
    s.compositionStart()
    insert(s, 'k', true)
    s.dispatch(s.state.tr.delete(s.state.selection.from - 1, s.state.selection.from))
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'ab', spans: [{ start: 0, end: 1, bold: true }] })
  })
})

// ---- 3: a non-breaking space is text ------------------------------------------------------------------------

describe('only ASCII whitespace is layout in pasted HTML', () => {
  it('`<div><div>x</div>&nbsp;<b>y</b></div>` after `A` keeps the U+00A0 before `y`', () => {
    const s = open({ text: 'A' })
    s.paste({ html: '<div><div>x</div>&nbsp;<b>y</b></div>' })
    expect(s.content().text).toBe('Ax\n y')
    const t = open({ text: 'A' })
    t.paste({ html: '<p>a\n  b</p>' })
    expect(t.content().text).toBe('Aa   b')
  })
})
