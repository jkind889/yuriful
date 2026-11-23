import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalTextContent } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import { docFromText } from './textSchema.ts'
import { insert, open } from './testing/textHarness.ts'
import type { EditSession } from './textSession.ts'

/**
 * IME composition, sixth review round: while a composition is open the browser and
 * ProseMirror own the text. The session's own rules and every command wait for one follow-up
 * after the composition (R1, R2); `content()` is the canonical record at every moment without
 * touching the document (R3); `finish()` keeps the candidate (R4); composed text follows rule
 * R5. Real compositions on a mounted view are in `e2e/text-engine-parity.spec.ts`.
 */

const hosts: HTMLElement[] = []
afterEach(() => {
  hosts.splice(0).forEach((h) => h.remove())
  vi.useRealTimers()
})

const isCanonical = (c: TextContent) => expect(c).toStrictEqual(canonicalTextContent(c as unknown as Record<string, unknown>))
const showsRecord = (s: EditSession) => expect(s.state.doc.eq(docFromText(s.content())!.doc)).toBe(true)

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

describe('R2: commands issued during a composition wait for it, then run in order', () => {
  it('heading, mark, font, box, paste, select, undo and redo leave the document untouched while it is open', () => {
    const s = open({ text: 'ab' })
    compose(s, ['か', 'かな'])
    const doc = s.state.doc
    const selection = s.state.selection
    expect(s.setHeading(1)).toBe(false)
    expect(s.toggleMark('italic')).toBe(false)
    expect(s.setFont('serif')).toBe(false)
    expect(s.setBox({ align: 'center' })).toBe(false)
    expect(s.paste({ text: '!' })).toBe(false)
    s.select(0)
    expect(s.undo()).toBe(false)
    expect(s.redo()).toBe(false)
    expect(s.state.doc).toBe(doc) // not touched at all
    expect(s.state.selection.eq(selection)).toBe(true)
    s.compositionEnd()
    // In order: heading, then the caret's pending italic and serif, the box centred, `!` pasted
    // with those pending choices, the caret moved to 0, the paste undone and redone.
    expect(s.content()).toStrictEqual({ text: 'abかな!', align: 'center', spans: [{ start: 4, end: 5, italic: true, font: 'serif' }], headings: [1] })
    expect(s.selection().head).toBe(5)
    showsRecord(s)
  })

  it('a command issued after the composition has ended (follow-up still owed) runs at once, after the follow-up', () => {
    const s = open({ text: 'Title\nb', headings: [0, 1] })
    s.select(0, 7)
    s.compositionStart()
    insert(s, 'x', true)
    // A mounted view ends a composition in two steps; headless, compositionEnd runs the follow-up at once.
    s.compositionEnd()
    expect(s.setHeading(2)).toBe(true)
    expect(s.content()).toStrictEqual({ text: 'x', headings: [2] })
  })
})

describe('R3: the record is canonical at every moment, without touching the document', () => {
  it('mid-composition: the composed accent takes the typed marks (bold off) although the document still shows it bold, as ProseMirror inserted it', () => {
    const s = open({ text: 'a', spans: [{ start: 0, end: 1, bold: true }] })
    s.toggleMark('bold')
    s.compositionStart()
    insert(s, '́', true)
    expect(s.content()).toStrictEqual({ text: 'á' })
    // The document is as ProseMirror left it: the accent took the bold of `a`; the record already has the choice.
    expect(s.state.doc.child(0).firstChild!.marks.map((m) => m.type.name)).toEqual(['bold'])
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'á' })
    showsRecord(s)
  })

  it('mid-composition over a selection across lines: levels by today’s rule, composed text with the first selected character’s marks', () => {
    const s = open({ text: 'ab\ncd', headings: [0, 2], spans: [{ start: 1, end: 2, italic: true }, { start: 3, end: 4, bold: true }] })
    s.select(1, 4)
    s.compositionStart()
    insert(s, 'か', true)
    const want = { text: 'aかd', spans: [{ start: 1, end: 2, italic: true }] }
    expect(s.content()).toStrictEqual(want)
    isCanonical(s.content())
    s.compositionEnd()
    expect(s.content()).toStrictEqual(want)
    showsRecord(s)
  })

  it('a save taken at every step of a composition stores a canonical record', () => {
    const saves: TextContent[] = []
    const s = open({ text: 'Big', headings: [1], spans: [] }, { hooks: { onChange: (c) => saves.push(c) } })
    s.toggleMark('italic')
    compose(s, ['ㅎ', '하', '한', '한ㄱ', '한그', '한글'])
    s.compositionEnd()
    expect(saves.length).toBeGreaterThan(0)
    for (const c of saves) isCanonical(c)
    expect(s.content()).toStrictEqual({ text: 'Big한글', spans: [{ start: 3, end: 5, italic: true }], headings: [1] })
  })
})

describe('R4: finishing during a composition keeps the candidate, canonical', () => {
  it('the record, the session document and the static HTML hold the candidate as last shown', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    hosts.push(el)
    const s = open({ text: 'bcD', spans: [{ start: 0, end: 1, bold: true }, { start: 2, end: 3, underline: true }] })
    s.mount(el)
    s.select(0, 2)
    compose(s, ['仮', '仮名'])
    s.setHeading(2) // queued
    s.finish()
    // The composed text took the bold of `b`, the first selected character; on the heading the queued H2 made, bold is the heading's own.
    expect(s.content()).toStrictEqual({ text: '仮名D', spans: [{ start: 2, end: 3, underline: true }], headings: [2] })
    showsRecord(s)
    expect(el.innerHTML).toBe('<h2>仮名<u>D</u></h2>')
  })
})

describe('R5 and history: composed text, levels and in-edit undo', () => {
  it('at a caret: as typed text, pending marks and font included; inside a heading bold is not stored', () => {
    const s = open({ text: 'Title', headings: [1], spans: [{ start: 0, end: 5, underline: true }] }, { caret: 2 })
    s.setFont('mono')
    compose(s, ['か', 'かな'])
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'Tiかなtle', spans: [{ start: 0, end: 2, underline: true }, { start: 2, end: 4, underline: true, font: 'mono' }, { start: 4, end: 7, underline: true }], headings: [1] })
  })

  it('a composition that changed nothing (cancelled) restores the levels ProseMirror may have changed, and nothing else', () => {
    const s = open({ text: 'ab', spans: [{ start: 0, end: 1, bold: true }] })
    s.compositionStart()
    insert(s, 'k', true)
    s.dispatch(s.state.tr.delete(s.state.selection.from - 1, s.state.selection.from))
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'ab', spans: [{ start: 0, end: 1, bold: true }] })
  })

  it('in-edit undo takes back the composition and its follow-up as one step; redo brings both back', () => {
    const s = open({ text: 'ab\ncd', headings: [0, 2], spans: [{ start: 1, end: 2, italic: true }] })
    s.select(1, 4)
    compose(s, ['か', 'かな'])
    s.compositionEnd()
    const after = s.content()
    expect(after).toStrictEqual({ text: 'aかなd', spans: [{ start: 1, end: 3, italic: true }] })
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'ab\ncd', spans: [{ start: 1, end: 2, italic: true }], headings: [0, 2] })
    s.redo()
    expect(s.content()).toStrictEqual(after)
    showsRecord(s)
  })
})
