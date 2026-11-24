import { TextSelection } from 'prosemirror-state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalTextContent } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import { contentFromDoc, docFromText, plainTextOfDoc } from './textSchema.ts'
import { insert, open } from './testing/textHarness.ts'
import type { EditSession } from './textSession.ts'

/**
 * IME composition: a composition never starts over a selection (the selection is deleted at
 * `compositionstart`, N1, and given back when nothing is composed); nothing ever rewrites
 * characters from a model of what a composition should have produced (N2); a session command
 * issued while a composition is open is refused and never runs later, and works as soon as it
 * has ended (N3); the follow-up runs straight after `compositionend`, only sets marks and the
 * canonical form, and never runs once an undo or redo has come (N4); `content()` is a pure
 * function of the live document and the composed ranges, and the last record reported equals
 * it (N5). `finish()` keeps the candidate
 * (R4); composed text follows rule R5. Real compositions on a mounted view are in
 * `e2e/text-engine-parity.spec.ts`.
 */

const hosts: HTMLElement[] = []
afterEach(() => {
  hosts.splice(0).forEach((h) => h.remove())
  vi.useRealTimers()
})

const isCanonical = (c: TextContent) => expect(c).toStrictEqual(canonicalTextContent(c as unknown as Record<string, unknown>))
const showsRecord = (s: EditSession) => expect(s.state.doc.eq(docFromText(s.content())!.doc)).toBe(true)

/** A session that keeps the last record its `onChange` reported. */
function watched(src: Parameters<typeof open>[0], opts: { caret?: number } = {}) {
  const seen: { last: TextContent | undefined; count: number } = { last: undefined, count: 0 }
  const s = open(src, { ...opts, hooks: { onChange: (c) => ((seen.last = c), seen.count++) } })
  return { s, seen, initial: s.content() }
}

/** N5: the last record reported equals `content()`, which has the live document's text and, with nothing composed pending, is its canonical form. */
function invariant(w: ReturnType<typeof watched>, settled = true) {
  const { s, seen, initial } = w
  const c = s.content()
  expect(seen.last ?? initial).toStrictEqual(c)
  expect(c.text).toBe(plainTextOfDoc(s.state.doc))
  isCanonical(c)
  if (settled) expect(c).toStrictEqual(canonicalTextContent(contentFromDoc(s.state.doc, c) as unknown as Record<string, unknown>))
}

/** A composition typed headlessly: each candidate replaces the previous one at the caret. */
function compose(s: EditSession, candidates: string[]) {
  s.compositionStart()
  let shown = ''
  for (const c of candidates) {
    const { from } = s.state.selection
    const start = from - shown.length
    if (shown) s.dispatch(s.state.tr.delete(start, from))
    insert(s, c, true)
    shown = c
  }
}

/** A view mounted in jsdom, with ProseMirror's own composition handling: composition events on its element, its reading of a candidate as a transaction with its `composition` metadata. */
function mounted(src: Parameters<typeof open>[0]) {
  vi.useFakeTimers()
  const el = document.createElement('div')
  document.body.appendChild(el)
  hosts.push(el)
  const w = watched(src)
  const view = w.s.mount(el)
  let id = 100
  return {
    ...w,
    view,
    start() {
      id++
      view.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    },
    /** ProseMirror reading a candidate: `text` replaces `length` characters before the caret. */
    candidate(text: string, length = 0) {
      const { from } = w.s.state.selection
      view.dispatch(view.state.tr.insertText(text, from - length, from).setMeta('composition', id))
    },
    end(data: string) {
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { data }))
    },
  }
}

describe('N1: a composition never starts over a selection', () => {
  it('the selection is deleted at compositionstart, as an ordinary edit; the composed text takes the marks of its first character', () => {
    const w = watched({ text: 'AbCD', spans: [{ start: 0, end: 1, bold: true }, { start: 3, end: 4, underline: true }] })
    const { s } = w
    s.select(0, 2)
    s.compositionStart()
    expect(plainTextOfDoc(s.state.doc)).toBe('CD')
    expect(s.state.selection.empty).toBe(true)
    expect(s.state.storedMarks).toBe(null) // no mark cursor for ProseMirror
    invariant(w, false)
    insert(s, 'ㄱ', true)
    s.dispatch(s.state.tr.insertText('가', s.state.selection.from - 1, s.state.selection.from))
    invariant(w, false)
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: '가CD', spans: [{ start: 0, end: 1, bold: true }, { start: 2, end: 3, underline: true }] })
    invariant(w)
  })

  it('across a heading and a body line: the lines join by today’s rule; one in-edit undo takes back the deletion, the composition and its follow-up', () => {
    const w = watched({ text: 'Title\nbody', headings: [1], spans: [{ start: 6, end: 8, italic: true }] })
    const { s } = w
    s.select(3, 8)
    compose(s, ['か', 'かな'])
    s.compositionEnd()
    const after = s.content()
    expect(after).toStrictEqual({ text: 'Titかなdy', headings: [1] })
    invariant(w)
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'Title\nbody', headings: [1], spans: [{ start: 6, end: 8, italic: true }] })
    s.redo()
    expect(s.content()).toStrictEqual(after)
    invariant(w)
  })

  it('a composition starting where the composed text of the one before ends carries its range on (back-to-back syllables)', () => {
    const w = watched({ text: 'AbCD', spans: [{ start: 0, end: 1, bold: true }] })
    const { s } = w
    s.select(0, 2)
    compose(s, ['ㄱ', '가'])
    s.compositionEnd()
    compose(s, ['나'])
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: '가나CD', spans: [{ start: 0, end: 2, bold: true }] })
    invariant(w)
  })
})

describe('N3: session commands during a composition are refused and never run later; afterwards they work at once', () => {
  it('heading, mark, font, box font, paste, select, undo, redo and run return false and change nothing; after the composition nothing of them happens', () => {
    const w = watched({ text: 'ab' })
    const { s } = w
    compose(s, ['か', 'かな'])
    const doc = s.state.doc
    const selection = s.state.selection
    const before = s.content()
    expect(s.settling).toBe(true)
    expect(s.setHeading(1)).toBe(false)
    expect(s.toggleMark('italic')).toBe(false)
    expect(s.setFont('serif')).toBe(false)
    expect(s.setBox({ font: 'mono' })).toBe(false)
    expect(s.paste({ text: '!' })).toBe(false)
    expect(s.select(0)).toBe(false)
    expect(s.undo()).toBe(false)
    expect(s.redo()).toBe(false)
    expect(s.run((_state, dispatch) => (dispatch?.(s.state.tr.insertText('!')), true))).toBe(false)
    expect(s.state.doc).toBe(doc)
    expect(s.state.selection.eq(selection)).toBe(true)
    expect(s.content()).toStrictEqual(before)
    s.compositionEnd()
    expect(s.settling).toBe(false)
    expect(s.content()).toStrictEqual({ text: 'abかな' })
    expect(s.pending).toBe(null)
    invariant(w)
  })

  it('alignment and colour change no character: they apply during a composition', () => {
    const w = watched({ text: 'ab' })
    const { s } = w
    compose(s, ['か'])
    expect(s.setBox({ align: 'center', color: '#d92d20' })).toBe(true)
    expect(s.content()).toStrictEqual({ text: 'abか', align: 'center', color: '#d92d20' })
    invariant(w, false)
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'abか', align: 'center', color: '#d92d20' })
    invariant(w)
  })

  it('on a mounted view, commands and shortcuts work as soon as compositionend has come', () => {
    const m = mounted({ text: 'a\nbc' })
    m.s.select(1)
    m.start()
    m.candidate('か')
    expect(m.s.setHeading(2)).toBe(false)
    m.end('仮')
    expect(m.s.composing).toBe(false)
    expect(m.s.settling).toBe(false)
    expect(m.s.setHeading(2)).toBe(true)
    // Ctrl+I straight after the commit: the key is claimed and has its effect.
    const key = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true })
    m.view.dom.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(true)
    expect(m.s.pending).toStrictEqual({ italic: true })
    insert(m.s, 'x')
    expect(m.s.content()).toStrictEqual({ text: 'aかx\nbc', spans: [{ start: 2, end: 3, italic: true }], headings: [2] })
  })
})

/** Lets the follow-up a mounted view queues at `compositionend` run (microtasks). */
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('the follow-up: right after compositionend, before any other input; never once an undo or redo has come', () => {
  it('runs straight after the composition ends: the composed text has its marks before the next key, which keeps its place and takes the composed text’s marks', async () => {
    const m = mounted({ text: 'AなZ', spans: [{ start: 0, end: 1, bold: true }] })
    m.s.select(1)
    m.s.toggleMark('bold') // pending: bold off for what is typed (and composed) here
    m.start()
    m.candidate('か')
    m.candidate('かな', 1)
    m.candidate('か', 2)
    m.end('か')
    invariant(m, false)
    await settle()
    expect(m.s.content()).toStrictEqual({ text: 'AかなZ', spans: [{ start: 0, end: 1, bold: true }] })
    invariant(m)
    m.view.dispatch(m.view.state.tr.insertText('x'))
    expect(m.s.selection().head).toBe(3)
    expect(m.s.content()).toStrictEqual({ text: 'AかxなZ', spans: [{ start: 0, end: 1, bold: true }] })
    invariant(m)
  })

  it('an undo before it runs drops it: redo then brings back the committed text, and the redo side is never cleared', async () => {
    const m = mounted({ text: 'AbCD', spans: [{ start: 0, end: 1, bold: true }, { start: 3, end: 4, underline: true }] })
    m.s.select(0, 2)
    m.start()
    m.candidate('ㄱ')
    m.candidate('가', 1)
    m.end('가')
    // The keyboard's Ctrl+Z in the same instant as the commit.
    m.view.someProp('handleKeyDown', (f) => f(m.view, new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })))
    await settle()
    expect(m.s.content()).toStrictEqual({ text: 'AbCD', spans: [{ start: 0, end: 1, bold: true }, { start: 3, end: 4, underline: true }] })
    expect(m.s.canRedo).toBe(true)
    vi.advanceTimersByTime(100)
    expect(m.s.redo()).toBe(true)
    expect(plainTextOfDoc(m.s.state.doc)).toBe('가CD')
    expect(m.s.selection().head).toBe(1)
    invariant(m)
  })

  it('redo puts the caret back after the composed text, where composing left it', () => {
    const w = watched({ text: 'plain text' }, { caret: 5 })
    const { s } = w
    compose(s, ['か', 'かな', 'な'])
    s.compositionEnd()
    expect(s.selection().head).toBe(6)
    s.undo()
    expect(s.selection().head).toBe(5)
    s.redo()
    expect(s.content().text).toBe('plainな text')
    expect(s.selection().head).toBe(6)
  })
})

describe('B1: a composition that composes nothing gives back the selection it deleted', () => {
  const src = { text: 'AbCD', spans: [{ start: 0, end: 1, bold: true as const }, { start: 3, end: 4, underline: true as const }] }
  const back = (w: ReturnType<typeof watched>) => {
    expect(w.s.content()).toStrictEqual(w.initial)
    expect(w.s.selection()).toStrictEqual({ anchor: 0, head: 2, from: 0, to: 2 })
    expect(w.s.canUndo).toBe(false) // no undo step left behind
    expect(w.s.composing).toBe(false)
    expect(w.s.settling).toBe(false)
    invariant(w)
  }

  it('compositionend with nothing delivered', () => {
    const w = watched(src)
    w.s.select(0, 2)
    w.s.compositionStart()
    expect(w.s.content().text).toBe('CD')
    w.s.compositionEnd()
    back(w)
  })

  it('the edit losing focus, with no compositionend from the browser', () => {
    const m = mounted(src)
    m.s.select(0, 2)
    m.start()
    expect(m.s.content().text).toBe('CD')
    m.view.dom.dispatchEvent(new FocusEvent('blur'))
    back(m)
    expect(m.view.composing).toBe(false) // ProseMirror was told the composition ended too
  })

  it('finish() during it', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    hosts.push(el)
    const w = watched(src)
    w.s.mount(el)
    w.s.select(0, 2)
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    w.s.finish()
    expect(w.s.content()).toStrictEqual(w.initial)
    expect(el.innerHTML).toBe('<p><strong>A</strong>bC<u>D</u></p>')
  })

  it('a composition that delivered text and was then cancelled keeps the deletion, as the canvas does', () => {
    const w = watched(src)
    w.s.select(0, 2)
    compose(w.s, ['ㄱ', ''])
    w.s.compositionEnd()
    expect(w.s.content()).toStrictEqual({ text: 'CD', spans: [{ start: 1, end: 2, underline: true }] })
    invariant(w)
  })
})

describe('R1: while a composition is open the session’s own rules change nothing', () => {
  it('the IME’s caret inside a character of the candidate stays where the IME put it, and the pending choices stay; after the composition the caret leaves the character', () => {
    const w = watched({ text: 'ab' })
    const { s } = w
    s.toggleMark('italic')
    s.compositionStart()
    insert(s, 'é', true)
    // ProseMirror reads the IME's caret between the `e` and its accent.
    const inside = s.state.selection.from - 1
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, inside)))
    expect(s.state.selection.from).toBe(inside)
    expect(s.pending).toStrictEqual({ italic: true })
    s.compositionEnd()
    expect(s.selection().head).toBe(4)
    expect(s.content()).toStrictEqual({ text: 'abé', spans: [{ start: 2, end: 4, italic: true }] })
    invariant(w)
  })
})

describe('N5 and R3: the record is canonical at every moment, and the last one reported', () => {
  it('mid-composition: the composed accent takes the typed marks (bold off) although the document still shows it bold, as ProseMirror inserted it', () => {
    const w = watched({ text: 'a', spans: [{ start: 0, end: 1, bold: true }] })
    const { s } = w
    s.toggleMark('bold')
    s.compositionStart()
    insert(s, '́', true)
    expect(s.content()).toStrictEqual({ text: 'á' })
    expect(s.state.doc.child(0).firstChild!.marks.map((m) => m.type.name)).toEqual(['bold'])
    invariant(w, false)
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'á' })
    showsRecord(s)
    invariant(w)
  })

  it('a save taken at every step of a composition stores a canonical record of exactly the text shown', () => {
    const saves: TextContent[] = []
    const s = open({ text: 'Big', headings: [1], spans: [] }, { hooks: { onChange: (c) => saves.push(c) } })
    s.toggleMark('italic')
    s.compositionStart()
    let shown = ''
    for (const c of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글']) {
      const { from } = s.state.selection
      if (shown) s.dispatch(s.state.tr.delete(from - shown.length, from))
      insert(s, c, true)
      shown = c
      expect(saves.at(-1)).toStrictEqual(s.content())
      expect(s.content().text).toBe(plainTextOfDoc(s.state.doc))
    }
    s.compositionEnd()
    for (const c of saves) isCanonical(c)
    expect(s.content()).toStrictEqual({ text: 'Big한글', spans: [{ start: 3, end: 5, italic: true }], headings: [1] })
    expect(saves.at(-1)).toStrictEqual(s.content())
  })

  it('a composition that changed nothing (cancelled) leaves the record as it was', () => {
    const w = watched({ text: 'ab', spans: [{ start: 0, end: 1, bold: true }] })
    const { s } = w
    s.compositionStart()
    insert(s, 'k', true)
    s.dispatch(s.state.tr.delete(s.state.selection.from - 1, s.state.selection.from))
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'ab', spans: [{ start: 0, end: 1, bold: true }] })
    invariant(w)
  })
})

describe('R4 and R5: finishing during a composition; composed text at a caret', () => {
  it('finish() keeps the candidate as last shown: the record, the session document and the static HTML', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    hosts.push(el)
    const s = open({ text: 'bcD', spans: [{ start: 0, end: 1, bold: true }, { start: 2, end: 3, underline: true }] })
    s.mount(el)
    s.select(0, 2)
    compose(s, ['仮', '仮名'])
    expect(s.setHeading(2)).toBe(false) // refused, and never run
    s.finish()
    expect(s.content()).toStrictEqual({ text: '仮名D', spans: [{ start: 0, end: 2, bold: true }, { start: 2, end: 3, underline: true }] })
    showsRecord(s)
    expect(el.innerHTML).toBe('<p><strong>仮名</strong><u>D</u></p>')
  })

  it('at a caret: as typed text, pending marks and font included; inside a heading bold is not stored', () => {
    const s = open({ text: 'Title', headings: [1], spans: [{ start: 0, end: 5, underline: true }] }, { caret: 2 })
    s.setFont('mono')
    compose(s, ['か', 'かな'])
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'Tiかなtle', spans: [{ start: 0, end: 2, underline: true }, { start: 2, end: 4, underline: true, font: 'mono' }, { start: 4, end: 7, underline: true }], headings: [1] })
  })
})
