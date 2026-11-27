import { afterEach, describe, expect, it } from 'vitest'
import { AllSelection, TextSelection } from 'prosemirror-state'
import { canonicalTextContent } from '../model/textDoc.ts'
import { headingsAfterEdit } from '../model/richText.ts'
import type { TextSpan } from '../model/types.ts'
import { docFromText } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import { open, press, type, insert } from './testing/textHarness.ts'
import { setBoxLevel } from './textRules.ts'
import type { EditSession } from './textSession.ts'

/**
 * Parity with today's canvas. Expectations never come from the engine itself: line levels
 * from today's `headingsAfterEdit` on the edit as described, and everything that today's
 * canvas decides on its own (pasted styles, what Backspace deletes) from results recorded on
 * the shipped Fabric canvas in Chromium (a probe of the app at `2c296b3`, 2026-11-23).
 */

const hosts: HTMLElement[] = []
afterEach(() => {
  hosts.splice(0).forEach((h) => h.remove())
})

/** The live document equals the record it stands for. */
const showsRecord = (s: EditSession) => expect(s.state.doc.eq(docFromText(s.content())!.doc)).toBe(true)

// ---- 1, 2: line levels by construction ---------------------------------------------------------

describe('line levels follow today’s rule for every edit (differential matrix)', () => {
  const texts = ['ab', 'a\nb', 'a\n', '\na', '\n\n', 'a\n\nb', 'aa\nab\nba', 'a\na\na', 'ab\nc\n', '\n\nx', '\n\n\n']
  const levelSets = [[1, 2, 3, 1], [0, 2, 0, 1], [1, 0, 2, 3]]
  const ops = ['Enter', 'Backspace', 'Delete', 'x', 'a', 'p:a\nb', 'p:a\n', 'p:\n', 'p:\na', 'p:\n\n', 'p:sel'] as const

  /** What an edit does to the text, from the description alone: the replaced range and what goes in. */
  function describeEdit(text: string, i: number, j: number, op: (typeof ops)[number]) {
    let start = i
    let end = j
    let str = ''
    if (op === 'Enter') str = '\n'
    else if (op === 'Backspace') start = i === j ? Math.max(0, i - 1) : i
    else if (op === 'Delete') end = i === j ? Math.min(text.length, j + 1) : j
    else if (op === 'p:sel') str = text.slice(i, j)
    else str = op.startsWith('p:') ? op.slice(2) : op
    return { start, end, str }
  }

  it('Enter, Backspace, Delete, typing over a selection and multi-line paste, at every start, middle and end, across empty lines and mixed levels', () => {
    const failures: string[] = []
    let cases = 0
    for (const text of texts) {
      for (const levels of levelSets) {
        const rec = canonicalTextContent({ text, headings: levels })!
        for (let i = 0; i <= text.length; i++) {
          for (let j = i; j <= text.length; j++) {
            for (const op of ops) {
              if (op === 'p:sel' && i === j) continue
              cases++
              const { start, end, str } = describeEdit(text, i, j, op)
              const wantText = text.slice(0, start) + str + text.slice(end)
              const want = { text: wantText, levels: headingsAfterEdit(text, rec.headings, wantText, start + str.length), caret: start + str.length }
              const s = open(rec)
              s.select(i, j)
              if (op.startsWith('p:')) s.paste({ text: op === 'p:sel' ? str : op.slice(2) })
              else if (op === 'Enter' || op === 'Backspace' || op === 'Delete') press(s, op)
              else type(s, op)
              const got = { text: s.content().text, levels: s.content().headings, caret: s.selection().head }
              if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${JSON.stringify({ text, headings: rec.headings, i, j, op })} want ${JSON.stringify(want)} got ${JSON.stringify(got)}`)
            }
          }
        }
      }
    }
    expect(cases).toBe(4998)
    expect(failures.slice(0, 10)).toEqual([])
  })

  it('replacing a line break with Enter changes no level (`a\\nb`, levels [1, 2])', () => {
    const s = open({ text: 'a\nb', headings: [1, 2] })
    s.select(1, 2)
    press(s, 'Enter')
    expect(s.content()).toStrictEqual({ text: 'a\nb', headings: [1, 2] })
  })

  it('a heading’s whole text replaced by pasted `a\\nb`: the pasted second line is body text', () => {
    const s = open({ text: 'ab', headings: [1] })
    s.select(0, 2)
    s.paste({ text: 'a\nb' })
    expect(s.content()).toStrictEqual({ text: 'a\nb', headings: [1] })
  })
})

// ---- 3: select-all ---------------------------------------------------------------------------

describe('Ctrl/Cmd+A selects all the text, as the canvas does', () => {
  const selectAll = (s: EditSession) => press(s, 'a', { ctrlKey: true })

  it('then Enter: one empty line break, the caret on the new line', () => {
    const s = open({ text: 'a\nb' })
    selectAll(s)
    press(s, 'Enter')
    expect(s.content()).toStrictEqual({ text: '\n' })
    expect(s.selection()).toMatchObject({ from: 1, to: 1 })
  })

  it('then a heading: an empty last line is not counted (as a range ending at a line start)', () => {
    const s = open({ text: 'x\n' })
    selectAll(s)
    s.setHeading(2)
    expect(s.content()).toStrictEqual({ text: 'x\n', headings: [2] })
    const t = open({ text: 'x\n', headings: [2] })
    selectAll(t)
    expect(t.format().heading).toBe(2)
  })

  it('then typing: the typed text takes the style of the first selected character', () => {
    const s = open({ text: 'a\nb', headings: [1, 2], spans: [{ start: 0, end: 1, italic: true }] })
    selectAll(s)
    type(s, 'x')
    expect(s.content()).toStrictEqual({ text: 'x', spans: [{ start: 0, end: 1, italic: true }], headings: [1] })
  })

  it('then Delete and typing; and a whole-document selection made any other way behaves the same', () => {
    const s = open({ text: 'a\nb', headings: [1, 2] })
    selectAll(s)
    press(s, 'Delete')
    type(s, 'x')
    expect(s.content()).toStrictEqual({ text: 'x', headings: [1] })
    const t = open({ text: 'x\n' })
    t.run((state, dispatch) => {
      dispatch?.(state.tr.setSelection(new AllSelection(state.doc)))
      return true
    })
    expect(t.selection()).toMatchObject({ from: 0, to: 2 })
  })
})

// ---- 4: pending bold on a line that ends up body text ---------------------------------------------

describe('a pending bold is judged on the line as it ends up', () => {
  it('`\\n\\nb` (levels [0, 1]), bold at the start, Delete, typing: the first line is body text and the typed `x` bold', () => {
    const s = open({ text: '\n\nb', headings: [0, 1] }, { caret: 0 })
    s.toggleMark('bold')
    press(s, 'Delete')
    type(s, 'x')
    expect(s.content()).toStrictEqual({ text: 'x\nb', spans: [{ start: 0, end: 1, bold: true }] })
  })
})

// ---- 5: characters extended by typing ---------------------------------------------------------------

describe('a character extended by what is typed takes the style of what was typed, and the document equals the record', () => {
  it('an accent composed onto a bold `a` with bold turned off: a plain `á`, also in the live document once the composition ends', () => {
    const s = open({ text: 'a', spans: [{ start: 0, end: 1, bold: true }] })
    s.toggleMark('bold')
    s.compositionStart()
    insert(s, '\u0301', true)
    s.compositionEnd()
    expect(s.content()).toStrictEqual({ text: 'a\u0301' })
    showsRecord(s)
  })

  it('a skin tone inserted after a bold 👍 with bold turned off: a plain 👍🏽; without the choice it stays bold', () => {
    const s = open({ text: '\u{1F44D}', spans: [{ start: 0, end: 2, bold: true }] })
    s.toggleMark('bold')
    insert(s, '\u{1F3FD}')
    expect(s.content()).toStrictEqual({ text: '\u{1F44D}\u{1F3FD}' })
    showsRecord(s)
    const t = open({ text: '\u{1F44D}', spans: [{ start: 0, end: 2, bold: true }] })
    insert(t, '\u{1F3FD}')
    expect(t.content()).toStrictEqual({ text: '\u{1F44D}\u{1F3FD}', spans: [{ start: 0, end: 4, bold: true }] })
    showsRecord(t)
  })

  it('a range that splits a character still marks it whole', () => {
    const s = open({ text: 'a\u0301b' })
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, 2, 4))) // from inside `á` (only ProseMirror itself could make this)
    s.toggleMark('italic')
    expect(s.content().spans).toEqual([{ start: 0, end: 3, italic: true }])
    showsRecord(s)
  })
})

// ---- 6: Backspace and Delete ---------------------------------------------------------------------------

describe('Backspace and Delete delete what they delete today (recorded on the canvas)', () => {
  const backspace: Array<[string, string, number, string]> = [
    ['an accent alone', 'a\u0301X', 2, 'aX'],
    ['the last of two accents', 'e\u0301\u0302X', 3, 'e\u0301X'],
    ['a ZWJ sequence whole', '👩‍💻X', 5, 'X'],
    ['a family whole', '👨‍👩‍👧X', 8, 'X'],
    ['a skin-toned emoji whole', '👍🏽X', 4, 'X'],
    ['a surrogate pair whole', '😀X', 2, 'X'],
    ['a flag whole', '🇯🇵X', 4, 'X'],
    ['one of two flags', '🇯🇵🇫🇷X', 8, '🇯🇵X'],
    ['a keycap whole', '1️⃣X', 3, 'X'],
    ['an emoji with a variation selector whole', '❤️X', 2, 'X'],
    ['a rainbow flag whole', '🏳️‍🌈X', 6, 'X'],
    ['a tag-sequence flag whole', '🏴󠁧󠁢󠁥󠁮󠁧󠁿X', 14, 'X'],
    ['a vowel sign alone', 'क्षिX', 4, 'क्षX'],
    ['a final jamo alone', '\u1100\u1161\u11A8X', 3, '\u1100\u1161X'],
  ]
  for (const [what, text, caret, want] of backspace) {
    it(`Backspace: ${what}`, () => {
      const s = open({ text }, { caret })
      press(s, 'Backspace')
      expect(s.content().text).toBe(want)
    })
  }

  const del: Array<[string, string, string]> = [
    ['an accented letter whole', 'Xa\u0301', 'X'],
    ['a skin-toned emoji whole', 'X👍🏽', 'X'],
    ['a conjunct with its vowel sign whole', 'Xक्षि', 'X'],
  ]
  for (const [what, text, want] of del) {
    it(`Delete: ${what}`, () => {
      const s = open({ text }, { caret: 1 })
      press(s, 'Delete')
      expect(s.content().text).toBe(want)
    })
  }

  it('a caret asked for inside a surrogate pair lands before it: Backspace never leaves half a pair', () => {
    const s = open({ text: 'a😀' })
    s.select(2)
    expect(s.selection().head).toBe(1)
    press(s, 'Backspace')
    expect(s.content().text).toBe('😀')
    const t = open({ text: '😀' }, { caret: 1 })
    expect(t.selection().head).toBe(0)
  })
})

// ---- 7, 8: pasted HTML keeps spaces and empty lines; plain copy has one break per line --------------

describe('rich paste keeps spaces and empty paragraphs; the plain-text copy has one line break per line', () => {
  function mounted(source: TextSource) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    hosts.push(el)
    const s = open(source)
    s.mount(el)
    return s
  }

  it('HTML `<p> x   y </p>` after `A` gives `A x   y `', () => {
    const s = open({ text: 'A' })
    s.paste({ html: '<p> x   y </p>' })
    expect(s.content().text).toBe('A x   y ')
  })

  it('HTML with empty paragraphs keeps them as empty lines; source line breaks are one space; <pre> keeps its lines', () => {
    const s = open({ text: 'A' })
    s.paste({ html: '<p>x</p><p></p><p>y\n   z</p><pre>p\n  q</pre>' })
    expect(s.content().text).toBe('Ax\n\ny z\np\n  q')
  })

  it('copying `x\\n\\ny` inside a card and pasting it keeps the empty line; its plain text is `x\\n\\ny`', () => {
    const s = mounted({ text: 'x\n\ny' })
    s.select(0, 4)
    const copy = s.view!.serializeForClipboard(s.state.selection.content())
    expect(copy.text).toBe('x\n\ny')
    s.select(4)
    s.paste({ html: copy.dom.innerHTML, text: copy.text })
    expect(s.content().text).toBe('x\n\nyx\n\ny')
  })

  it('copying `a\\nb` then pasting it as plain text at the end gives `a\\nba\\nb`', () => {
    const s = mounted({ text: 'a\nb' })
    s.select(0, 3)
    const copy = s.view!.serializeForClipboard(s.state.selection.content())
    expect(copy.text).toBe('a\nb')
    s.select(3)
    s.paste({ text: copy.text, html: copy.dom.innerHTML, plain: true })
    expect(s.content().text).toBe('a\nba\nb')
  })
})

// ---- 9: where pasted text takes its formatting from -------------------------------------------------------

describe('plain paste is styled exactly as today (recorded on the canvas)', () => {
  const b = (start: number, end: number): TextSpan => ({ start, end, bold: true })
  const cases: Array<[string, TextSource, number, number, string, { text: string; spans?: TextSpan[]; headings?: number[] }]> = [
    ['two lines before a bold letter', { text: 'aB', spans: [b(1, 2)] }, 1, 1, 'x\ny', { text: 'ax\nyB' }],
    ['two lines after a bold letter (the next letter turns bold too)', { text: 'Ab', spans: [b(0, 1)] }, 1, 1, 'x\ny', { text: 'Ax\nyb', spans: [b(0, 5)] }],
    ['two lines at the end of a line', { text: 'Ab', spans: [b(0, 1)] }, 2, 2, 'x\ny', { text: 'Abx\ny', spans: [b(0, 1)] }],
    ['two lines at the start of a line', { text: 'Ab', spans: [b(0, 1)] }, 0, 0, 'x\ny', { text: 'x\nyAb', spans: [b(0, 4)] }],
    ['two characters at the start of a line take no style', { text: 'Ab', spans: [b(0, 1)] }, 0, 0, 'xy', { text: 'xyAb', spans: [b(2, 3)] }],
    ['one character at the start of a line takes the next one’s', { text: 'Ab', spans: [b(0, 1)] }, 0, 0, 'x', { text: 'xAb', spans: [b(0, 2)] }],
    ['three lines after a bold letter', { text: 'aB', spans: [b(1, 2)] }, 2, 2, 'x\ny\nz', { text: 'aBx\ny\nz', spans: [b(1, 7)] }],
    ['over a bold selection', { text: 'abc', spans: [b(1, 2)] }, 1, 2, 'x\ny', { text: 'ax\nyc', spans: [b(1, 4)] }],
    ['into the middle of a heading', { text: 'Title\nbody', headings: [1] }, 2, 2, 'x\ny', { text: 'Tix\nytle\nbody', headings: [1, 1] }],
    ['at the end of a heading', { text: 'Title\nbody', headings: [1] }, 5, 5, 'x\ny', { text: 'Titlex\ny\nbody', headings: [1] }],
    ['at the start of a heading', { text: 'Title\nbody', headings: [1] }, 0, 0, 'x\ny', { text: 'x\nyTitle\nbody', headings: [1, 1] }],
    ['with an empty line in it', { text: 'abc', spans: [{ start: 0, end: 1, italic: true }, b(2, 3)] }, 1, 1, 'x\n\ny', { text: 'ax\n\nybc', spans: [{ start: 0, end: 2, italic: true }, b(6, 7)] }],
    ['over a selection across lines', { text: 'ab\ncd', spans: [b(0, 5)] }, 1, 4, 'x\ny', { text: 'ax\nyd', spans: [b(0, 5)] }],
    ['a long first line before unstyled text', { text: 'abcdef', spans: [b(0, 1)] }, 1, 1, 'xxxxxx\ny', { text: 'axxxxxx\nybcdef', spans: [b(0, 10)] }],
    ['inside italic mono text', { text: 'ab', spans: [{ start: 0, end: 2, italic: true, font: 'mono' }] }, 1, 1, 'x\ny', { text: 'ax\nyb', spans: [{ start: 0, end: 5, italic: true, font: 'mono' }] }],
    ['on an empty heading line', { text: 'a\n', headings: [0, 2] }, 2, 2, 'x\ny', { text: 'a\nx\ny', headings: [0, 2] }],
    ['starting with a line break', { text: 'Ab', spans: [b(0, 1), { start: 1, end: 2, underline: true }] }, 1, 1, '\nx', { text: 'A\nxb', spans: [b(0, 1), { start: 2, end: 4, underline: true }] }],
    ['over a selection starting at a line end', { text: 'ab\ncd', spans: [b(1, 2), { start: 3, end: 4, italic: true }] }, 2, 4, 'x', { text: 'abxd', spans: [b(1, 2)] }],
    ['between italic and bold text', { text: 'aBc', spans: [{ start: 0, end: 1, italic: true }, b(1, 3)] }, 1, 1, 'x\ny', { text: 'ax\nyBc', spans: [{ start: 0, end: 2, italic: true }, b(3, 6)] }],
    ['three lines into an italic heading', { text: 'Title', headings: [2], spans: [{ start: 0, end: 5, italic: true }] }, 2, 2, 'x\ny\nz', { text: 'Tix\ny\nztle', spans: [{ start: 0, end: 10, italic: true }], headings: [2, 0, 2] }],
    ['over a selection from a heading into an underlined line', { text: 'Big\nb', headings: [1], spans: [{ start: 4, end: 5, underline: true }] }, 1, 5, 'x\ny', { text: 'Bx\ny', headings: [1] }],
    ['two characters inside bold text', { text: 'abc', spans: [b(0, 3)] }, 1, 1, 'xy', { text: 'axybc', spans: [b(0, 5)] }],
    ['with a "\\r\\n" line break', { text: 'ab', spans: [b(0, 1)] }, 1, 1, 'x\r\ny', { text: 'ax\nyb', spans: [b(0, 5)] }],
  ]
  for (const [what, rec, from, to, pasted, want] of cases) {
    it(what, () => {
      const s = open(rec)
      s.select(from, to)
      s.paste({ text: pasted })
      expect(s.content()).toStrictEqual(want)
      showsRecord(s)
    })
  }

  it('pending choices apply to pasted plain text, as to typed text', () => {
    const s = open({ text: 'ab' }, { caret: 1 })
    s.toggleMark('underline')
    s.setFont('serif')
    s.paste({ text: 'x\ny' })
    expect(s.content()).toStrictEqual({ text: 'ax\nyb', spans: [{ start: 1, end: 4, underline: true, font: 'serif' }] })
  })
})

describe('pasted HTML keeps its own marks and takes the font of the place it is pasted', () => {
  it('an unformatted paragraph next to bold mono text arrives plain-weight but mono', () => {
    const s = open({ text: 'B', spans: [{ start: 0, end: 1, bold: true, font: 'mono' }] })
    s.paste({ html: '<p>x</p>' })
    expect(s.content()).toStrictEqual({ text: 'Bx', spans: [{ start: 0, end: 1, bold: true, font: 'mono' }, { start: 1, end: 2, font: 'mono' }] })
  })

  it('over a selection: the font of the first selected character; a pending font wins at a caret', () => {
    const s = open({ text: 'ab', spans: [{ start: 1, end: 2, font: 'hand' }] })
    s.select(1, 2)
    s.paste({ html: '<p><em>x</em></p>' })
    expect(s.content()).toStrictEqual({ text: 'ax', spans: [{ start: 1, end: 2, italic: true, font: 'hand' }] })
    s.setFont('serif')
    s.paste({ html: '<p>y</p>' })
    expect(s.content().spans).toEqual([{ start: 1, end: 2, italic: true, font: 'hand' }, { start: 2, end: 3, font: 'serif' }])
  })
})

// ---- 10: text leaving a heading ----------------------------------------------------------------------------

describe('text that leaves a heading by copy, cut or drag arrives bold at normal size, never with its font', () => {
  const rec: TextSource = { text: 'Hword\nbody', headings: [1], spans: [{ start: 1, end: 5, font: 'mono' }] }

  it('dragging `word` to the end of `body`: bold in the destination font', () => {
    const s = open(rec)
    s.drop(s.dragSlice(1, 5), 10, { from: 1, to: 5 })
    expect(s.content()).toStrictEqual({ text: 'H\nbodyword', spans: [{ start: 6, end: 10, bold: true }], headings: [1] })
    showsRecord(s)
  })

  it('a drop next to a font override takes that font; pending choices apply', () => {
    const s = open({ ...rec, text: 'Hword\nbody', spans: [{ start: 1, end: 5, font: 'mono' }, { start: 6, end: 10, font: 'hand' }] })
    s.drop(s.dragSlice(1, 5), 10, { from: 1, to: 5 })
    expect(s.content().spans).toEqual([{ start: 2, end: 6, font: 'hand' }, { start: 6, end: 10, bold: true, font: 'hand' }])
  })

  it('copy and paste: the clipboard holds the heading and its font; text from inside it arrives in a body line bold, with its font (Slice 3b: a copy inside Yuriful keeps fonts)', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    hosts.push(el)
    const s = open(rec)
    s.mount(el)
    s.select(1, 5)
    const copy = s.view!.serializeForClipboard(s.state.selection.content())
    expect(copy.dom.innerHTML).toContain('<h1')
    expect(copy.dom.innerHTML).toContain('data-font="mono"')
    expect(copy.dom.innerHTML).not.toContain('<strong>')
    s.select(10)
    s.paste({ html: copy.dom.innerHTML, text: copy.text })
    expect(s.content()).toStrictEqual({ text: 'Hword\nbodyword', spans: [{ start: 1, end: 5, font: 'mono' }, { start: 10, end: 14, bold: true, font: 'mono' }], headings: [1] })
  })
})

// ---- 11, 12: box settings ----------------------------------------------------------------------------------

describe('box settings are guarded, are not steps of in-edit undo, and drop the Backspace offer', () => {
  it('refused after finish and while the editor says no', () => {
    let editable = false
    const s = open({ text: 'ab' }, { hooks: { canEdit: () => editable } })
    expect(s.setBox({ align: 'center' })).toBe(false)
    expect(s.content()).toStrictEqual({ text: 'ab' })
    editable = true
    s.finish()
    expect(s.setBox({ align: 'center', font: 'mono' })).toBe(false)
    expect(s.content()).toStrictEqual({ text: 'ab' })
  })

  it('a base font equal to a span font neither creates nor consumes an undo step', () => {
    const s = open({ text: 'ab', spans: [{ start: 0, end: 1, font: 'mono' }] })
    s.setBox({ font: 'mono' })
    expect(s.content()).toStrictEqual({ text: 'ab', font: 'mono' })
    expect(s.canUndo).toBe(false)
    type(s, 'c')
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'ab', font: 'mono' })
    expect(s.canUndo).toBe(false)
  })

  it('`go `, `*i*`, Align centre, Backspace: the Backspace deletes the italic `i`', () => {
    const s = open({ text: 'go ' })
    type(s, '*i*')
    s.setBox({ align: 'center' })
    press(s, 'Backspace')
    expect(s.content()).toStrictEqual({ text: 'go ', align: 'center' })
  })
})

// ---- 13: redo of a conversion ---------------------------------------------------------------------------------

describe('redoing a typing shortcut brings back "plain after the shortcut"', () => {
  for (const how of ['undo', 'Backspace'] as const) {
    it(`\`**b**\`, ${how}, redo, typing: only \`b\` is bold`, () => {
      const s = open({ text: 'go ' })
      type(s, '**b**')
      if (how === 'undo') press(s, 'z', { ctrlKey: true })
      else press(s, 'Backspace')
      press(s, 'z', { ctrlKey: true, shiftKey: true })
      type(s, 'x')
      expect(s.content()).toStrictEqual({ text: 'go bx', spans: [{ start: 3, end: 4, bold: true }] })
    })
  }
})

// ---- 14: entering and leaving changes nothing ---------------------------------------------------------------------

describe('until something changes, the content is the record’s own', () => {
  it('a "\\r\\n" record entered, moved about in and formatted with nothing comes back exactly', () => {
    const rec: TextSource = { text: 'x\r\ny', spans: [{ start: 3, end: 4, italic: true }] }
    const s = open(rec)
    s.select(0)
    s.select(0, 4)
    s.setHeading(0)
    s.toggleMark('bold')
    s.toggleMark('bold')
    // Formatting alone keeps the stored "\r\n" (today the textarea turns it into "\n" only on a keystroke).
    expect(s.content()).toStrictEqual({ text: 'x\r\ny', spans: [{ start: 3, end: 4, italic: true }] })
    const t = open(rec)
    t.select(0)
    t.select(1, 3)
    t.setHeading(0)
    t.setBox({ color: '#1d2230' }) // the default ink: no change
    expect(t.content()).toStrictEqual(canonicalTextContent(rec as never))
    t.select(1)
    type(t, 'z')
    expect(t.content().text).toBe('xz\ny')
  })

  it('a whole-box heading on a "\\r\\n" record keeps its "\\r\\n", as today', () => {
    const s = open({ text: 'x\r\ny', spans: [{ start: 3, end: 4, italic: true }] })
    s.run((state, dispatch) => {
      const tr = state.tr
      if (setBoxLevel(tr, 2)) dispatch?.(tr)
      return true
    })
    expect(s.content()).toStrictEqual({ text: 'x\r\ny', spans: [{ start: 3, end: 4, italic: true }], headings: [2, 2] })
  })
})

// ---- 15: heading weight in pasted HTML ---------------------------------------------------------------------------

describe('a pasted heading is a heading, whatever its own weight (Slice 3b)', () => {
  it('`<h1 style="font-weight:normal">Title</h1>` is a level 1 heading, with no bold stored', () => {
    const s = open()
    s.paste({ html: '<h1 style="font-weight:normal">Title</h1>' })
    expect(s.content()).toStrictEqual({ text: 'Title', headings: [1] })
  })
})
