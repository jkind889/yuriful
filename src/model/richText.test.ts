import { describe, expect, it } from 'vitest'
import {
  FONT_IDS,
  FONT_LABELS,
  HEADING_SCALE,
  canonicalHeadings,
  canonicalSpans,
  canonicalTextFormatting,
  diffText,
  fontOfRange,
  formatOfText,
  headingsAfterEdit,
  lastBoxLine,
  markMask,
  paragraphsOf,
  splitGraphemes,
  textAfterEdit,
  withPendingMarks,
} from './richText.ts'

const spans = (text: string, raw: unknown, headings?: number[]) => canonicalSpans(text, raw, headings)

describe('canonical spans', () => {
  it('keeps grapheme-wide font overrides and merges them with overlapping marks', () => {
    expect(canonicalTextFormatting('a😀b', { font: 'mono', spans: [
      { start: 0, end: 4, italic: true },
      { start: 2, end: 3, font: 'sans' },
      { start: 3, end: 4, font: 'mono' },
      { start: 0, end: 1, font: 'unknown' },
    ] })).toStrictEqual({ font: 'mono', spans: [
      { start: 0, end: 1, italic: true },
      { start: 1, end: 3, italic: true, font: 'sans' },
      { start: 3, end: 4, italic: true },
    ] })
  })

  it('text without formatting has none', () => {
    expect(spans('abc', undefined)).toBeUndefined()
    expect(spans('abc', [])).toBeUndefined()
    expect(spans('abc', 'bold')).toBeUndefined()
    expect(spans('', [{ start: 0, end: 1, bold: true }])).toBeUndefined()
    expect(canonicalTextFormatting('abc', {})).toStrictEqual({})
  })

  it('overlapping spans combine their marks into non-overlapping runs', () => {
    expect(spans('abcdef', [{ start: 0, end: 4, bold: true }, { start: 2, end: 6, italic: true }])).toStrictEqual([
      { start: 0, end: 2, bold: true },
      { start: 2, end: 4, bold: true, italic: true },
      { start: 4, end: 6, italic: true },
    ])
  })

  it('trims spans to the text and drops what is left empty, reversed or zero-length', () => {
    expect(spans('abcdef', [{ start: -3, end: 2, bold: true }, { start: 4, end: 99, italic: true }])).toStrictEqual([
      { start: 0, end: 2, bold: true },
      { start: 4, end: 6, italic: true },
    ])
    expect(spans('abcdef', [{ start: 2, end: 2, bold: true }, { start: 4, end: 1, bold: true }, { start: 7, end: 9, bold: true }])).toBeUndefined()
  })

  it('drops entries that are not spans: non-integer offsets, non-objects', () => {
    expect(spans('abcdef', [{ start: 0.5, end: 3, bold: true }, { start: '0', end: 3, bold: true }, { end: 3, bold: true }])).toBeUndefined()
    expect(spans('abcdef', [null, 3, 'x', [0, 2], { start: 0, end: 1, bold: true }])).toStrictEqual([{ start: 0, end: 1, bold: true }])
  })

  it('sorts unsorted spans', () => {
    expect(spans('abcdef', [{ start: 4, end: 6, bold: true }, { start: 0, end: 2, italic: true }])).toStrictEqual([
      { start: 0, end: 2, italic: true },
      { start: 4, end: 6, bold: true },
    ])
  })

  it('merges adjacent and overlapping spans with identical marks', () => {
    expect(spans('abcdef', [{ start: 0, end: 2, bold: true }, { start: 2, end: 4, bold: true }])).toStrictEqual([{ start: 0, end: 4, bold: true }])
    expect(spans('abcdef', [{ start: 0, end: 3, bold: true }, { start: 1, end: 5, bold: true }])).toStrictEqual([{ start: 0, end: 5, bold: true }])
  })

  it('a mark counts only when it is exactly true; a span with no mark is dropped; no false keys survive', () => {
    expect(spans('abc', [{ start: 0, end: 3, bold: 'yes', italic: 1, underline: false, strike: null }])).toBeUndefined()
    const out = spans('abc', [{ start: 0, end: 3, bold: true, italic: false, colour: 'red' }])
    expect(out).toStrictEqual([{ start: 0, end: 3, bold: true }])
    expect(Object.keys(out![0]!)).toEqual(['start', 'end', 'bold'])
    expect(spans('abc', [{ start: 0, end: 3, strike: true, underline: true, italic: true, bold: true }])).toStrictEqual([
      { start: 0, end: 3, bold: true, italic: true, underline: true, strike: true },
    ])
  })

  it('never stores bold inside a heading line (a heading is bold already); other marks stay', () => {
    expect(spans('Title\nbody', [{ start: 0, end: 10, bold: true }], [1])).toStrictEqual([{ start: 6, end: 10, bold: true }])
    expect(spans('Title\nbody', [{ start: 0, end: 5, bold: true, italic: true }], [2])).toStrictEqual([{ start: 0, end: 5, italic: true }])
    expect(spans('Title\nbody', [{ start: 0, end: 5, bold: true }], [0, 3])).toStrictEqual([{ start: 0, end: 5, bold: true }])
  })

  it('a line break carries only the marks shared by the characters on both sides of it', () => {
    expect(spans('ab\ncd', [{ start: 0, end: 5, bold: true }])).toStrictEqual([{ start: 0, end: 5, bold: true }])
    expect(spans('ab\ncd', [{ start: 0, end: 2, bold: true }, { start: 3, end: 5, bold: true }])).toStrictEqual([{ start: 0, end: 5, bold: true }])
    expect(spans('ab\n\ncd', [{ start: 0, end: 6, italic: true }])).toStrictEqual([{ start: 0, end: 6, italic: true }]) // across an empty line
    expect(spans('ab\ncd', [{ start: 2, end: 3, bold: true }])).toBeUndefined() // the break alone is not a character
    expect(spans('ab\ncd', [{ start: 0, end: 4, bold: true }])).toStrictEqual([{ start: 0, end: 4, bold: true }])
    expect(spans('ab\n', [{ start: 0, end: 3, bold: true }])).toStrictEqual([{ start: 0, end: 2, bold: true }]) // nothing after it
    expect(spans('ab\ncd', [{ start: 1, end: 4, bold: true, italic: true }, { start: 4, end: 5, bold: true }])).toStrictEqual([
      { start: 1, end: 4, bold: true, italic: true }, // "b", the break and "c"
      { start: 4, end: 5, bold: true },
    ])
  })

  it('"\\r\\n" is one line break, like on the canvas: the "\\r" is not a character', () => {
    expect(spans('ab\r\ncd', [{ start: 2, end: 3, bold: true }])).toBeUndefined()
    expect(spans('ab\r\ncd', [{ start: 0, end: 2, bold: true }, { start: 4, end: 6, bold: true }])).toStrictEqual([{ start: 0, end: 6, bold: true }])
    expect(paragraphsOf('ab\r\ncd')).toEqual([
      { start: 0, end: 2, chars: [0, 1] },
      { start: 4, end: 6, chars: [4, 5] },
    ])
  })

  it('a boundary inside a character (surrogate pair or grapheme cluster) grows outwards to cover it', () => {
    // "a😀b": the emoji is code units 1..3.
    expect(spans('a😀b', [{ start: 2, end: 4, bold: true }])).toStrictEqual([{ start: 1, end: 4, bold: true }])
    expect(spans('a😀b', [{ start: 0, end: 2, bold: true }])).toStrictEqual([{ start: 0, end: 3, bold: true }])
    expect(spans('a😀b', [{ start: 1, end: 3, bold: true }])).toStrictEqual([{ start: 1, end: 3, bold: true }]) // already whole
    // "e" + combining acute accent is one character.
    expect(spans('éx', [{ start: 1, end: 3, italic: true }])).toStrictEqual([{ start: 0, end: 3, italic: true }])
    // A family emoji joined by ZWJ is one character of 8 code units.
    const family = '👨‍👩‍👧'
    expect(splitGraphemes(`${family}z`)).toEqual([family, 'z'])
    expect(spans(`${family}z`, [{ start: 3, end: 4, bold: true }])).toStrictEqual([{ start: 0, end: family.length, bold: true }])
  })

  it('is idempotent', () => {
    const text = 'Title\n\nsome 😀 bold\nend'
    const once = spans(text, [{ start: 0, end: 13, bold: true }, { start: 9, end: 20, italic: true }], [1, 2])
    expect(spans(text, once, [1, 2])).toStrictEqual(once)
  })
})

describe('canonical headings', () => {
  it('trims trailing zeros, and none at all is absent', () => {
    expect(canonicalHeadings('a\nb\nc', [0, 2, 0])).toStrictEqual([0, 2])
    expect(canonicalHeadings('a\nb\nc', [0, 0])).toBeUndefined()
    expect(canonicalHeadings('a\nb\nc', [])).toBeUndefined()
    expect(canonicalHeadings('a', 1)).toBeUndefined()
    expect(canonicalHeadings('a', undefined)).toBeUndefined()
  })

  it('invalid levels count as 0', () => {
    expect(canonicalHeadings('a\nb\nc\nd\ne\nf', [5, 'x', 1.5, -1, null, 3])).toStrictEqual([0, 0, 0, 0, 0, 3])
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalHeadings('a\nb', [, 1])).toStrictEqual([0, 1])
  })

  it('never has more entries than paragraphs (including an empty last one)', () => {
    expect(canonicalHeadings('a\nb', [1, 2, 3])).toStrictEqual([1, 2])
    expect(canonicalHeadings('a\n', [0, 3, 1])).toStrictEqual([0, 3])
    expect(canonicalHeadings('', [2, 1])).toStrictEqual([2]) // an empty text is one empty paragraph
  })
})

describe('font, alignment and colour', () => {
  it('drops defaults and anything unknown; colours are lower case', () => {
    const f = (raw: Record<string, unknown>) => canonicalTextFormatting('x', raw)
    expect(f({ font: 'sans' })).toStrictEqual({})
    expect(f({ font: 'comic' })).toStrictEqual({})
    expect(f({ font: 'serif' })).toStrictEqual({ font: 'serif' })
    expect(f({ align: 'left' })).toStrictEqual({})
    expect(f({ align: 'justify' })).toStrictEqual({})
    expect(f({ align: 'center' })).toStrictEqual({ align: 'center' })
    expect(f({ align: 'right' })).toStrictEqual({ align: 'right' })
    expect(f({ color: '#1d2230' })).toStrictEqual({}) // the default ink
    expect(f({ color: '#1D2230' })).toStrictEqual({})
    expect(f({ color: '#ABCDEF' })).toStrictEqual({ color: '#abcdef' })
    expect(f({ color: 'red' })).toStrictEqual({})
    expect(f({ color: '#abc' })).toStrictEqual({})
    expect(f({ color: 0xabcdef })).toStrictEqual({})
  })

  it('keeps its keys in one order', () => {
    const out = canonicalTextFormatting('ab\ncd', { headings: [1], spans: [{ start: 3, end: 5, bold: true }], color: '#ff0000', align: 'right', font: 'mono' })
    expect(Object.keys(out)).toEqual(['font', 'align', 'color', 'spans', 'headings'])
  })
})

describe('tables', () => {
  it('heading sizes are 2, 1.5 and 1.25 times the base size', () => {
    expect(HEADING_SCALE).toEqual({ 1: 2, 2: 1.5, 3: 1.25 })
  })

  it('every font id has a label', () => {
    expect(FONT_IDS).toEqual(['sans', 'serif', 'mono', 'hand', 'display'])
    for (const id of FONT_IDS) expect(FONT_LABELS[id]).toBeTruthy()
  })
})

describe('lenient parsing stays bounded on hostile input', () => {
  it('a huge sparse span list is dropped at once, not walked hole by hole', () => {
    const sparse: unknown[] = []
    sparse.length = 2 ** 32 - 1
    sparse[0] = { start: 0, end: 1, bold: true }
    const t0 = performance.now()
    expect(spans('abc', sparse)).toBeUndefined()
    expect(canonicalTextFormatting('abc', { spans: sparse })).toStrictEqual({})
    expect(performance.now() - t0).toBeLessThan(50)
  })

  it('any span list longer than the text is dropped: a canonical one never is', () => {
    const many = Array.from({ length: 4 }, () => ({ start: 0, end: 1, bold: true }))
    expect(spans('abc', many)).toBeUndefined()
    expect(spans('abcd', many)).toStrictEqual([{ start: 0, end: 1, bold: true }])
  })

  it('a huge sparse heading list is read only as far as the text has lines', () => {
    const sparse: unknown[] = []
    sparse.length = 2 ** 32 - 1
    sparse[1] = 2
    const t0 = performance.now()
    expect(canonicalHeadings('a\nb', sparse)).toStrictEqual([0, 2])
    expect(performance.now() - t0).toBeLessThan(50)
  })
})

describe('the changed region of an edit', () => {
  it('is the longest common prefix, then the longest common suffix, without a caret', () => {
    expect(diffText('abc', 'abXc')).toEqual({ start: 2, prevEnd: 2, nextEnd: 3 })
    expect(diffText('abc', 'ac')).toEqual({ start: 1, prevEnd: 2, nextEnd: 1 })
    expect(diffText('', 'ab')).toEqual({ start: 0, prevEnd: 0, nextEnd: 2 })
    expect(diffText('ab', '')).toEqual({ start: 0, prevEnd: 2, nextEnd: 0 })
    expect(diffText('ab', 'ab')).toEqual({ start: 2, prevEnd: 2, nextEnd: 2 })
  })

  it('ends at the caret when the caret fits, among repeated characters', () => {
    // "aa" -> "aaa": the new "a" is the first, second or third depending on the caret.
    expect(diffText('aa', 'aaa', 1)).toEqual({ start: 0, prevEnd: 0, nextEnd: 1 })
    expect(diffText('aa', 'aaa', 2)).toEqual({ start: 1, prevEnd: 1, nextEnd: 2 })
    expect(diffText('aa', 'aaa', 3)).toEqual({ start: 2, prevEnd: 2, nextEnd: 3 })
    expect(diffText('aa', 'aaa')).toEqual({ start: 2, prevEnd: 2, nextEnd: 3 })
    // Backspace and forward Delete leave the caret where the deletion was.
    expect(diffText('abba', 'aba', 1)).toEqual({ start: 1, prevEnd: 2, nextEnd: 1 })
    expect(diffText('abba', 'aba', 2)).toEqual({ start: 2, prevEnd: 3, nextEnd: 2 })
  })

  it('ignores a caret that does not fit the change', () => {
    expect(diffText('aa', 'aaa', 9)).toEqual(diffText('aa', 'aaa'))
    expect(diffText('abc', 'abXc', 0)).toEqual({ start: 2, prevEnd: 2, nextEnd: 3 })
    expect(diffText('abc', 'abXc', 1.5)).toEqual({ start: 2, prevEnd: 2, nextEnd: 3 })
  })

  it('never splits a surrogate pair or a "\\r\\n" line break', () => {
    // 😀 and 😁 share their first code unit.
    expect(diffText('x😀y', 'x😁y')).toEqual({ start: 1, prevEnd: 3, nextEnd: 3 })
    expect(diffText('a\r\nb', 'a\nb')).toEqual({ start: 1, prevEnd: 3, nextEnd: 2 })
  })
})

describe('heading levels carried across an edit', () => {
  const H = headingsAfterEdit

  it('typing in a line keeps every level; lines below shift when lines are added or removed above', () => {
    expect(H('Title\nbody', [1], 'Tixtle\nbody', 3)).toStrictEqual([1])
    expect(H('Title\nbody', [1], 'Title\nbodyx', 11)).toStrictEqual([1])
    expect(H('a\nTitle', [0, 1], 'a\n\nTitle', 2)).toStrictEqual([0, 0, 1])
    expect(H('a\n\nTitle', [0, 0, 1], 'a\nTitle', 2)).toStrictEqual([0, 1])
  })

  it('pasting text copied from a heading into a normal line leaves it normal, and normal text into a heading leaves it a heading', () => {
    expect(H('Title\nbody', [1], 'Title\nTitlebody', 11)).toStrictEqual([1])
    expect(H('Title\nbody', [1], 'bodyTitle\nbody', 4)).toStrictEqual([1])
  })

  it('Enter at the end of a heading starts a normal line; in the middle it leaves two headings', () => {
    expect(H('Title\nbody', [1], 'Title\n\nbody', 6)).toStrictEqual([1])
    expect(H('Title', [2], 'Title\n', 6)).toStrictEqual([2])
    expect(H('Title', [1], 'Ti\ntle', 3)).toStrictEqual([1, 1])
  })

  it('Enter at the start of a heading leaves an empty heading line above it (the line it started in keeps its level)', () => {
    expect(H('body\nTitle', [0, 1], 'body\n\nTitle', 6)).toStrictEqual([0, 1, 1])
  })

  it('the caret decides which of two identical results was meant', () => {
    // The same new text, from Enter at the end of "body" or at the start of "Title".
    expect(H('body\nTitle', [0, 1], 'body\n\nTitle', 5)).toStrictEqual([0, 0, 1])
    expect(H('body\nTitle', [0, 1], 'body\n\nTitle', 6)).toStrictEqual([0, 1, 1])
    // Enter on an empty heading line, or at the end of the normal line above it.
    expect(H('a\n\nb', [0, 2], 'a\n\n\nb', 3)).toStrictEqual([0, 2])
    expect(H('a\n\nb', [0, 2], 'a\n\n\nb', 2)).toStrictEqual([0, 0, 2])
    // Without a caret (or with one that does not fit): the longest common prefix wins.
    expect(H('body\nTitle', [0, 1], 'body\n\nTitle')).toStrictEqual([0, 1, 1])
    expect(H('body\nTitle', [0, 1], 'body\n\nTitle', 99)).toStrictEqual([0, 1, 1])
  })

  it('a multi-line paste: the first line joins the line pasted into, lines in between are normal, the last follows its remaining text', () => {
    expect(H('Title\nbody', [1], 'TiA\nB\nCtle\nbody', 7)).toStrictEqual([1, 0, 1])
    expect(H('Title\nbody', [1], 'TitleA\nB\nbody', 8)).toStrictEqual([1])
    expect(H('Title\nbody', [1], 'Title\nbA\nBody', 10)).toStrictEqual([1])
    expect(H('Title\nbody', [0, 1], 'TitlA\nBe\nbody', 7)).toStrictEqual([0, 0, 1])
  })

  it('joining lines keeps the level of the line the change starts in', () => {
    expect(H('Title\nbody', [1], 'Titlebody', 5)).toStrictEqual([1]) // Backspace at the start of a normal line under a heading
    expect(H('body\nTitle', [0, 1], 'bodyTitle', 4)).toBeUndefined() // Backspace at the start of a heading under a normal line
    expect(H('ab\nTitle', [0, 1], 'abTitle', 2)).toBeUndefined() // forward Delete at the end of the normal line
    expect(H('Title\nbody', [0, 1], 'Tidy', 2)).toBeUndefined() // a selection from the middle of a line across the break
    expect(H('Title\n\nbody', [1], 'Title\nbody', 5)).toStrictEqual([1]) // Delete at the end of a heading, over an empty line
    expect(H('Title\n\nbody', [0, 1], 'Title\nbody', 5)).toBeUndefined() // Backspace on an empty heading line
  })

  it('unless nothing of that line is left before the change and text of a later line follows it', () => {
    expect(H('\nTitle', [0, 1], 'Title', 0)).toStrictEqual([1]) // Backspace at the start of a heading under an empty line
    expect(H('ab\nTitle', [0, 1], 'tle', 0)).toStrictEqual([1]) // "ab\nTi" selected and deleted
    expect(H('Title\nbody', [1], 'body', 0)).toBeUndefined() // a whole heading line deleted with its break
    expect(H('Title\nbody', [1], 'x', 1)).toStrictEqual([1]) // everything selected and typed over: nothing follows
  })

  it('emptying a heading line keeps it a heading', () => {
    expect(H('Title\nbody', [1], '\nbody', 0)).toStrictEqual([1])
    expect(H('Title', [1], 'x', 1)).toStrictEqual([1])
    expect(H('Title', [3], '', 0)).toStrictEqual([3])
  })

  it('a move within the text that keeps the number of lines keeps every level by position', () => {
    // " two" dragged from line 1 to the end of "Title" on line 3: one change, from line 1 to line 3.
    expect(H('one two\nb\nTitle end', [0, 0, 1], 'one\nb\nTitle two end', 15)).toStrictEqual([0, 0, 1])
    expect(H('Title one\nb\nend', [1], 'Title\nb\nend one', 15)).toStrictEqual([1])
  })

  it('from or to an empty text', () => {
    expect(H('', undefined, 'a\nb', 3)).toBeUndefined()
    expect(H('', [1], 'Title', 5)).toStrictEqual([1])
    expect(H('a\nb', [1, 1], '', 0)).toStrictEqual([1])
  })

  it('a stored "\\r\\n" text compares line for line with the "\\n" text typing leaves of it', () => {
    expect(H('Title\r\nbody', [1], 'Title\nbody!', 11)).toStrictEqual([1])
    expect(H('Title\r\nbody', [1], '!Title\nbody', 1)).toStrictEqual([1])
    expect(H('a\r\nTitle', [0, 1], 'aTitle', 1)).toBeUndefined()
    expect(H('a\r\nb\r\nTitle', [0, 0, 1], 'a\nb\n\nTitle', 4)).toStrictEqual([0, 0, 0, 1])
    // The characters after the "\r\n" are recognised as already there, on their own line.
    const typed = textAfterEdit('T\r\nHead', [0, 1], 'xT\nHead', 1)
    expect(typed.levelBefore(3, 4)).toBe(1)
    expect(typed.levelBefore(1, 2)).toBe(0)
  })

  it('an unchanged text keeps its levels, in canonical form', () => {
    expect(H('a\nb', [0, 1, 0, 5], 'a\nb')).toStrictEqual([0, 1])
    expect(H('a\nb', undefined, 'a\nb')).toBeUndefined()
  })

  it('tells which characters were already there, and on what level of line', () => {
    const join = textAfterEdit('body\nTitle', [0, 1], 'bodyTitle', 4)
    expect(join.levelBefore(0, 1)).toBe(0)
    expect(join.levelBefore(4, 5)).toBe(1) // "T" came from the heading
    const typed = textAfterEdit('Title\nab', [1], 'Title\naXb', 8)
    expect(typed.levelBefore(7, 8)).toBeUndefined() // inserted
    expect(typed.levelBefore(0, 1)).toBe(1)
    expect(typed.levelBefore(8, 9)).toBe(0)
    // A character that the change altered (an emoji whose second unit changed) was not there before.
    expect(textAfterEdit('😀', [1], '😁').levelBefore(0, 2)).toBeUndefined()
  })
})

// ---- applying formatting ----------------------------------------------------------------------

describe('the state a selected box shows', () => {
  it('its heading over every line but an empty last one, and each mark over all of its characters', () => {
    expect(formatOfText('Title\n', { headings: [1, 1] }).heading).toBe(1)
    expect(formatOfText('Title\n', { headings: [1] }).heading).toBe(1)
    expect(formatOfText('Title\nbody\n', { headings: [1] }).heading).toBe('mixed')
    expect(formatOfText('Title', { headings: [1] }).heading).toBe(1)
    expect(formatOfText('ab\ncd', { spans: [{ start: 0, end: 5, bold: true }] }).marks.bold).toBe('on')
    expect(formatOfText('Title\nbody', { headings: [1], spans: [{ start: 6, end: 10, italic: true }] })).toStrictEqual({
      marks: { bold: 'mixed', italic: 'mixed', underline: 'off', strike: 'off' },
      heading: 'mixed',
      boldFromHeading: false,
    })
  })

  it('its font: the box font, a span font over all of it, or mixed', () => {
    expect(fontOfRange('ab cd', { font: 'serif' }, 0, 5)).toBe('serif')
    expect(fontOfRange('ab cd', { spans: [{ start: 0, end: 5, font: 'mono' }] }, 0, 5)).toBe('mono')
    expect(fontOfRange('ab cd', { spans: [{ start: 0, end: 2, font: 'mono' }] }, 0, 5)).toBe('mixed')
  })
})

describe('pending choices', () => {
  it('a typed character’s marks with the pending choices applied', () => {
    const bold = markMask({ bold: true })
    const italic = markMask({ italic: true })
    expect(withPendingMarks(bold, { bold: false, italic: true })).toBe(italic)
    expect(withPendingMarks(0, {})).toBe(0)
    expect(withPendingMarks(bold | italic, { underline: false })).toBe(bold | italic)
  })
})

describe('the lines of a box', () => {
  it('every line but an empty last one; a text without characters keeps all its lines', () => {
    expect(lastBoxLine('a')).toBe(0)
    expect(lastBoxLine('a\nb')).toBe(1)
    expect(lastBoxLine('a\n')).toBe(0)
    expect(lastBoxLine('a\r\n')).toBe(0)
    expect(lastBoxLine('a\n\n')).toBe(1)
    expect(lastBoxLine('')).toBe(0)
    expect(lastBoxLine('\n')).toBe(1)
    expect(lastBoxLine('\n\n')).toBe(2)
  })
})
