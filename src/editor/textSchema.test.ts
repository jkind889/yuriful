import { describe, expect, it } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { canonicalTextContent } from '../model/textDoc.ts'
import { contentFromDoc, docFromText, linesOf, plainTextOfDoc, posAtTextOffset, renderStatic, textOffsetAt, textSchema } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'

/** A record read into a document and straight back. */
const roundTrip = (rec: TextSource) => {
  const read = docFromText(rec)
  if (!read) throw new Error('unreadable')
  return contentFromDoc(read.doc, read.box)
}
/** What loading the record gives (`canonicalTextContent`). */
const loaded = (rec: TextSource) => canonicalTextContent(rec as unknown as Record<string, unknown>)

describe('a stored text read into the editor document and back', () => {
  it('is exactly what loading gives, for every formatting field', () => {
    const recs: TextSource[] = [
      { text: '' },
      { text: 'plain' },
      { text: 'Title\nSome bold words', headings: [1], spans: [{ start: 11, end: 15, bold: true }] },
      { text: 'a\nb\nc', font: 'serif', align: 'center', color: '#D92D20', headings: [0, 2, 3], spans: [{ start: 0, end: 5, italic: true }, { start: 2, end: 3, font: 'mono' }] },
      { text: 'line one\nline two', spans: [{ start: 5, end: 13, underline: true, strike: true }] },
    ]
    for (const rec of recs) expect(roundTrip(rec), rec.text).toStrictEqual(loaded(rec))
  })

  it('keeps emoji, ZWJ sequences and flags whole, with their spans at the same UTF-16 offsets', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const text = `${family} and \u{1F1EF}\u{1F1F5} ok`
    const rec: TextSource = { text, spans: [{ start: 0, end: family.length, bold: true }, { start: family.length + 5, end: family.length + 9, italic: true }] }
    expect(roundTrip(rec)).toStrictEqual(loaded(rec))
    // A span that starts inside a character grows outwards to cover it, as loading does.
    const half: TextSource = { text, spans: [{ start: 2, end: 3, underline: true }] }
    expect(roundTrip(half)).toStrictEqual({ text, spans: [{ start: 0, end: family.length, underline: true }] })
  })

  it('"\\r\\n" is one line break: the levels and marks after it stay on their lines, and the text comes back with "\\n"', () => {
    const rec: TextSource = { text: 'T\r\nHead\r\nx', headings: [0, 1], spans: [{ start: 9, end: 10, italic: true }] }
    expect(roundTrip(rec)).toStrictEqual({ text: 'T\nHead\nx', headings: [0, 1], spans: [{ start: 7, end: 8, italic: true }] })
  })

  it('an empty heading line is a heading, empty lines are kept, and an empty last line too', () => {
    const rec: TextSource = { text: 'a\n\n\nb\n', headings: [0, 2, 0, 3] }
    const read = docFromText(rec)!
    expect(read.doc.childCount).toBe(5)
    expect(read.doc.child(1).type.name).toBe('heading')
    expect(read.doc.child(1).content.size).toBe(0)
    expect(roundTrip(rec)).toStrictEqual({ text: 'a\n\n\nb\n', headings: [0, 2, 0, 3] })
  })

  it('a span font equal to the box font, bold stored inside a heading, and broken formatting are dropped as loading drops them', () => {
    const rec: TextSource = {
      text: 'Title\nbody',
      font: 'serif',
      headings: [1, 7] as number[],
      spans: [{ start: 0, end: 10, bold: true }, { start: 6, end: 8, font: 'serif' }, { start: 8, end: 10, font: 'mono' }, { start: 'x' } as never],
    }
    expect(roundTrip(rec)).toStrictEqual({ text: 'Title\nbody', font: 'serif', spans: [{ start: 6, end: 8, bold: true }, { start: 8, end: 10, bold: true, font: 'mono' }], headings: [1] })
    expect(roundTrip(rec)).toStrictEqual(loaded(rec))
    const heading = docFromText(rec)!.doc.child(0)
    expect(heading.firstChild!.marks).toEqual([]) // no bold in the heading's document either
  })

  it('a line break carries only the marks both sides share; canonical spans come back unchanged', () => {
    const rec: TextSource = { text: 'ab\ncd', spans: [{ start: 0, end: 5, bold: true }] }
    expect(roundTrip(rec)).toStrictEqual({ text: 'ab\ncd', spans: [{ start: 0, end: 5, bold: true }] })
  })

  it('compact rich blocks are read too; other rich blocks (lists, quotes, code) are not editable yet', () => {
    expect(roundTrip({ text: 'x', blocks: [{ type: 'heading', level: 2, content: [{ text: 'Hi', italic: true }] }] })).toStrictEqual({ text: 'Hi', spans: [{ start: 0, end: 2, italic: true }], headings: [2] })
    expect(docFromText({ text: 'x', blocks: [{ type: 'bulletList', items: [{ blocks: [{ type: 'paragraph' }] }] }] })).toBeNull()
    expect(docFromText({ text: 'x', blocks: [{ type: 'paragraph', content: [{ text: 'a', code: true }] }] })).toBeNull()
    expect(docFromText({ text: 3 } as unknown as TextSource)).toBeNull()
  })

  it('a long compact text is not held to the rich-text bounds', () => {
    const text = Array.from({ length: 12_000 }, (_, i) => `line ${i}`).join('\n')
    const read = docFromText({ text })!
    expect(read.doc.childCount).toBe(12_000)
    expect(contentFromDoc(read.doc, read.box).text).toBe(text)
  })
})

describe('the schema', () => {
  it('holds only paragraphs and headings of level 1 to 3, with the four marks and a font', () => {
    expect(Object.keys(textSchema.nodes)).toEqual(['doc', 'paragraph', 'heading', 'text'])
    expect(Object.keys(textSchema.marks)).toEqual(['font', 'bold', 'italic', 'underline', 'strike'])
    expect(() => textSchema.nodes.heading!.create({ level: 4 })).toThrow()
    expect(() => textSchema.marks.font!.create({ font: 'comic' })).toThrow()
  })
})

describe('static rendering (an idle card)', () => {
  it('uses the editor’s own DOM, with a <br> in every empty block so an empty line keeps its height', () => {
    const read = docFromText({ text: 'Title\n\nbold mono\n', headings: [1, 2], spans: [{ start: 7, end: 11, bold: true }, { start: 12, end: 16, font: 'mono', underline: true }, { start: 7, end: 9, strike: true }] })!
    const host = document.createElement('div')
    host.appendChild(renderStatic(read.doc))
    expect(host.innerHTML).toBe('<h1>Title</h1><h2><br></h2><p><strong><s>bo</s>ld</strong> <span data-font="mono"><u>mono</u></span></p><p><br></p>')
  })

  it('the static HTML parses back to the same document', async () => {
    const { DOMParser } = await import('prosemirror-model')
    const read = docFromText({ text: 'A\nb c', headings: [3], spans: [{ start: 2, end: 3, italic: true }, { start: 4, end: 5, font: 'hand' }] })!
    const host = document.createElement('div')
    host.appendChild(renderStatic(read.doc))
    host.querySelectorAll('br').forEach((br) => br.remove())
    expect(DOMParser.fromSchema(textSchema).parse(host).eq(read.doc)).toBe(true)
  })
})

describe('plain-text offsets', () => {
  const read = docFromText({ text: 'ab\n\ncde' })!
  const doc = read.doc

  it('a block is a line; its break is the "\\n" between two blocks', () => {
    expect(linesOf(doc)).toEqual(['ab', '', 'cde'])
    expect(plainTextOfDoc(doc)).toBe('ab\n\ncde')
  })

  it('offsets and positions convert both ways; a position between blocks is either side of its break', () => {
    for (let o = 0; o <= 7; o++) expect(textOffsetAt(doc, posAtTextOffset(doc, o))).toBe(o)
    expect(posAtTextOffset(doc, 99)).toBe(doc.content.size - 1)
    expect(textOffsetAt(doc, 0, -1)).toBe(0)
    expect(textOffsetAt(doc, 4, -1)).toBe(2) // between "ab" and the empty line: end of "ab"
    expect(textOffsetAt(doc, 4, 1)).toBe(3) // or start of the empty line
    expect(textOffsetAt(doc, doc.content.size, 1)).toBe(7)
  })

  it('works on a state built from the document', () => {
    const state = EditorState.create({ doc })
    expect(state.doc.textBetween(0, state.doc.content.size, '\n')).toBe('ab\n\ncde')
  })
})
