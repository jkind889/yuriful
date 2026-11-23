import { describe, expect, it } from 'vitest'
import { createEmptyDoc, parseDoc, sceneEqual, serializeDoc } from './doc.ts'
import { canonicalSpans } from './richText.ts'
import {
  EDITABLE_RICH_FIELDS,
  MAX_BLOCK_DEPTH,
  MAX_NODES,
  MAX_TEXT_LENGTH,
  blocksToLegacy,
  canonicalTextContent,
  isBlankTextDoc,
  legacyToBlocks,
  needsRichFence,
  parseBlocks,
  plainTextOf,
  uneditableRichFields,
} from './textDoc.ts'
import type { BlockNode, TextRecord } from './types.ts'

const base = { type: 'text', id: 't1', left: 1, top: 2, angle: 0, fontSize: 18, width: 300 } as const
const p = (...content: Array<Record<string, unknown>>): Record<string, unknown> => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' })
const run = (text: string, marks: Record<string, unknown> = {}) => ({ text, ...marks })
/** A wire version 3 document holding one text with `fields`. */
const v3 = (fields: Record<string, unknown>) => ({ version: 3, title: 'Rich', frames: [], objects: [{ ...base, text: '', ...fields }], viewport: { zoom: 1, panX: 0, panY: 0 } })
const textOf = (doc: unknown) => (parseDoc(doc)?.objects[0] ?? null) as TextRecord | null
const scene = (o: TextRecord) => ({ frames: [], objects: [o] })

/** Blocks nested `depth` levels deep: the paragraph sits at that depth. */
function nest(depth: number, wrap: (inner: unknown[]) => unknown = (blocks) => ({ type: 'blockquote', blocks })): unknown[] {
  let blocks: unknown[] = [p(run('deep'))]
  for (let d = 1; d < depth; d++) blocks = [wrap(blocks)]
  return blocks
}

describe('parseBlocks: strict structure', () => {
  it('accepts every block type and returns them in canonical form', () => {
    const blocks = [
      { type: 'heading', level: 2, content: [run('Blue Lines')] },
      { type: 'bulletList', items: [{ blocks: [p(run('one'))] }] },
      { type: 'orderedList', start: 3, items: [{ blocks: [p(run('three'))] }] },
      { type: 'taskList', items: [{ checked: true, blocks: [p(run('done'))] }] },
      { type: 'blockquote', blocks: [p(run('quoted', { italic: true }))] },
      { type: 'codeBlock', text: 'let x = 1\nx++' },
      { type: 'divider' },
      p(),
    ]
    expect(parseBlocks(blocks)).toStrictEqual(blocks)
  })

  it('failed-restore-blocks-writes-on-unknown-block-type: an unknown block anywhere makes the text unreadable instead of being dropped', () => {
    const table = { type: 'table', rows: [] }
    expect(parseBlocks([p(run('a')), table])).toBeNull()
    expect(parseBlocks([{ type: 'blockquote', blocks: [table] }])).toBeNull()
    expect(parseBlocks([{ type: 'bulletList', items: [{ blocks: [p(run('a')), table] }] }])).toBeNull()
    expect(textOf(v3({ text: 'a', blocks: [p(run('a')), table] }))).toBeNull()
    expect(parseDoc(v3({ text: 'a', blocks: [p(run('a')), table] }))).toBeNull()
  })

  it('rejects a malformed container, level, code block or run', () => {
    const bad: unknown[] = [
      'oops',
      null,
      [],
      {},
      [null],
      [{ content: [] }],
      [{ type: 'heading', level: 4, content: [run('h')] }],
      [{ type: 'heading', level: '1' }],
      [{ type: 'heading' }],
      [{ type: 'bulletList', items: [] }],
      [{ type: 'bulletList', items: 'x' }],
      [{ type: 'bulletList', items: [{ blocks: [] }] }],
      [{ type: 'bulletList', items: [{}] }],
      [{ type: 'taskList', items: [{ checked: true }] }],
      [{ type: 'orderedList' }],
      [{ type: 'blockquote', blocks: [] }],
      [{ type: 'blockquote' }],
      [{ type: 'codeBlock' }],
      [{ type: 'codeBlock', text: 5 }],
      [{ type: 'paragraph', content: 'text' }],
      [{ type: 'paragraph', content: [null] }],
      [{ type: 'paragraph', content: [{ text: 3 }] }],
      [{ type: 'paragraph', content: [{ bold: true }] }],
      [{ type: 'paragraph', content: [run('two\nlines')] }],
    ]
    for (const raw of bad) expect(parseBlocks(raw), JSON.stringify(raw)).toBeNull()
  })

  it(`allows ${MAX_BLOCK_DEPTH} levels of nesting and no more, through quotes and through lists`, () => {
    expect(parseBlocks(nest(MAX_BLOCK_DEPTH))).not.toBeNull()
    expect(parseBlocks(nest(MAX_BLOCK_DEPTH + 1))).toBeNull()
    const list = (blocks: unknown[]) => ({ type: 'bulletList', items: [{ blocks }] })
    expect(parseBlocks(nest(MAX_BLOCK_DEPTH, list))).not.toBeNull()
    expect(parseBlocks(nest(MAX_BLOCK_DEPTH + 1, list))).toBeNull()
  })

  it(`allows ${MAX_NODES} nodes and no more, counting blocks, list items and runs`, () => {
    const dividers = (n: number) => Array.from({ length: n }, () => ({ type: 'divider' }))
    expect(parseBlocks(dividers(MAX_NODES))).toHaveLength(MAX_NODES)
    expect(parseBlocks(dividers(MAX_NODES + 1))).toBeNull()
    // One paragraph and the rest as runs (alternating marks, so they are not merged away).
    const runs = (n: number) => Array.from({ length: n }, (_, i) => run('x', { bold: i % 2 === 0 }))
    expect(parseBlocks([p(...runs(MAX_NODES - 1))])).not.toBeNull()
    expect(parseBlocks([p(...runs(MAX_NODES))])).toBeNull()
    // A list item counts too: list + item + paragraph is three.
    const items = (n: number) => [{ type: 'bulletList', items: Array.from({ length: n }, () => ({ blocks: [p()] })) }]
    const fits = Math.floor((MAX_NODES - 1) / 2) // 1 + 2n nodes
    expect(parseBlocks(items(fits))).not.toBeNull()
    expect(parseBlocks(items(fits + 1))).toBeNull()
  })

  it(`allows ${MAX_TEXT_LENGTH} code units of text and no more, across runs and code blocks`, () => {
    const half = MAX_TEXT_LENGTH / 2
    expect(parseBlocks([p(run('a'.repeat(half))), { type: 'codeBlock', text: 'b'.repeat(half) }])).not.toBeNull()
    expect(parseBlocks([p(run('a'.repeat(half))), { type: 'codeBlock', text: 'b'.repeat(half + 1) }])).toBeNull()
    expect(parseBlocks([{ type: 'codeBlock', text: 'b'.repeat(MAX_TEXT_LENGTH + 1) }])).toBeNull()
  })

  it('stops at once on a huge sparse list instead of walking it', () => {
    const sparse: unknown[] = []
    sparse.length = 1e9
    const started = Date.now()
    expect(parseBlocks(sparse)).toBeNull()
    expect(parseBlocks([{ type: 'paragraph', content: sparse }])).toBeNull()
    expect(parseBlocks([{ type: 'bulletList', items: sparse }])).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('parseBlocks: lenient values', () => {
  it('cleans an ordered list start, a task checkbox and unknown properties', () => {
    const ordered = (start: unknown) => (parseBlocks([{ type: 'orderedList', start, items: [{ blocks: [p()] }] }])?.[0] ?? null) as Record<string, unknown> | null
    for (const start of [0, 1, -4, 2.5, '3', null, Number.NaN, Number.POSITIVE_INFINITY]) expect(ordered(start)).not.toHaveProperty('start')
    expect(ordered(3)).toStrictEqual({ type: 'orderedList', start: 3, items: [{ blocks: [{ type: 'paragraph' }] }] })
    for (const checked of ['yes', 1, null, undefined]) {
      expect(parseBlocks([{ type: 'taskList', items: [{ checked, blocks: [p()] }] }])).toStrictEqual([{ type: 'taskList', items: [{ checked: false, blocks: [{ type: 'paragraph' }] }] }])
    }
    const extra = parseBlocks([{ type: 'divider', colour: 'red' }, { type: 'paragraph', align: 'left', content: [{ text: 'a', size: 9, href: 'x' }] }])
    expect(extra).toStrictEqual([{ type: 'divider' }, { type: 'paragraph', content: [{ text: 'a' }] }])
  })

  it('keeps only marks that are true and fonts that are known and differ from the box font', () => {
    const runs = parseBlocks([p({ text: 'a', bold: 'yes', italic: false, code: true, font: 'wingdings' }, { text: 'b', underline: true, font: 'sans' }, { text: 'c', strike: true, font: 'mono' })])
    expect(runs).toStrictEqual([p({ text: 'a', code: true }, { text: 'b', underline: true }, { text: 'c', strike: true, font: 'mono' })])
    expect(parseBlocks([p({ text: 'c', font: 'mono' })], 'mono')).toStrictEqual([p({ text: 'c' })])
  })

  it('drops empty runs, merges neighbours with the same formatting and leaves out empty content', () => {
    expect(parseBlocks([p(run(''), run('ab', { italic: true }), run('', { bold: true }), run('cd', { italic: true }), run('e'))])).toStrictEqual([p(run('abcd', { italic: true }), run('e'))])
    expect(parseBlocks([{ type: 'paragraph', content: [] }, { type: 'heading', level: 1, content: [run('')] }])).toStrictEqual([{ type: 'paragraph' }, { type: 'heading', level: 1 }])
  })

  it('never stores bold inside a heading, at any depth', () => {
    const quoted = parseBlocks([{ type: 'blockquote', blocks: [{ type: 'heading', level: 3, content: [run('H', { bold: true, italic: true })] }] }])
    expect(quoted).toStrictEqual([{ type: 'blockquote', blocks: [{ type: 'heading', level: 3, content: [run('H', { italic: true })] }] }])
  })

  it('writes run keys in a fixed order', () => {
    const [block] = parseBlocks([p({ font: 'serif', code: true, strike: true, underline: true, italic: true, bold: true, text: 'x' })])!
    expect(Object.keys((block as { content: object[] }).content[0]!)).toEqual(['text', 'bold', 'italic', 'underline', 'strike', 'code', 'font'])
  })
})

describe('canonical form of a stored text', () => {
  const quote = [{ type: 'blockquote', blocks: [p(run('Warm bassline', { italic: true }))] }]

  it('canonical-richdoc-equality-noop: shuffled keys, split runs, bold in a heading and a redundant font load as the same scene', () => {
    const a = v3({
      text: 'stale',
      font: 'serif',
      blocks: [
        { level: 1, content: [{ bold: true, text: 'Blue ' }, { text: 'Lines' }], type: 'heading' },
        { blocks: [{ content: [{ italic: true, text: 'Warm ' }, { text: 'bass', italic: true }, { font: 'serif', italic: true, text: 'line' }], type: 'paragraph' }], type: 'blockquote' },
        { type: 'taskList', items: [{ blocks: [p(run('Check', { code: true }))], checked: 'no' }] },
      ],
    })
    const task = (checked: boolean) => ({ type: 'taskList', items: [{ checked, blocks: [p(run('Check', { code: true }))] }] })
    const head = [
      { type: 'heading', level: 1, content: [run('Blue Lines')] },
      { type: 'blockquote', blocks: [p(run('Warm bassline', { italic: true }))] },
    ]
    const b = v3({ text: 'Blue Lines\nWarm bassline\nCheck', font: 'serif', blocks: [...head, task(false)] })
    const ta = textOf(a)!
    const tb = textOf(b)!
    expect(sceneEqual(scene(ta), scene(tb))).toBe(true)
    expect(JSON.stringify(ta)).toBe(JSON.stringify(tb)) // the same keys in the same order, not just equal values
    // Saving and loading again changes nothing either.
    const doc = { ...createEmptyDoc(), objects: [ta] }
    expect(parseDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))?.objects).toStrictEqual([ta])
    // A real difference is still a difference.
    const checked = textOf(v3({ font: 'serif', blocks: [...head, task(true)] }))!
    expect(sceneEqual(scene(ta), scene(checked))).toBe(false)
  })

  it('collapses paragraphs and headings without code to the compact form, exactly as if they had been stored that way', () => {
    const blocks = [{ type: 'heading', level: 2, content: [run('Side '), run('A', { bold: true })] }, p(run('warm', { italic: true })), p(run('bass', { italic: true }))]
    const collapsed = textOf(v3({ text: 'ignored', blocks, color: '#AA0000' }))!
    const compact = textOf({ ...v3({}), version: 1, objects: [{ ...base, text: 'Side A\nwarm\nbass', color: '#aa0000', headings: [2], spans: [{ start: 7, end: 16, italic: true }] }] })!
    expect(collapsed).toStrictEqual(compact)
    expect(collapsed).not.toHaveProperty('blocks')
    expect(needsRichFence({ objects: [collapsed] })).toBe(false)
    expect(serializeDoc({ ...createEmptyDoc(), objects: [collapsed] }).version).toBe(1)
  })

  it('makes blocks the authority over a disagreeing text, spans and headings', () => {
    const rec = textOf(v3({ text: 'something else', spans: [{ start: 0, end: 3, bold: true }], headings: [1], blocks: quote }))!
    expect(rec).toStrictEqual({ ...base, text: 'Warm bassline', blocks: quote })
    expect(canonicalTextContent({ text: 5, blocks: quote })).toBeNull() // text must still be a string
  })

  it('reads height and surface leniently', () => {
    for (const height of [0, -5, Number.NaN, '40', null]) expect(textOf(v3({ text: 'a', height }))).not.toHaveProperty('height')
    expect(textOf(v3({ text: 'a', height: 360 }))).toMatchObject({ height: 360 })
    for (const surface of ['paper', true, null, 'Card']) expect(textOf(v3({ text: 'a', surface }))).not.toHaveProperty('surface')
    expect(textOf(v3({ text: 'a', surface: 'card' }))).toMatchObject({ surface: 'card' })
  })
})

describe('legacy conversion', () => {
  // A ZWJ family emoji is 8 UTF-16 code units and one character.
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'

  it('legacy-utf16-emoji-crlf-empty-heading-roundtrip: offsets after an emoji, CRLF breaks and an empty H2 line convert and come back identically', () => {
    const crlf = `${family} Bold\r\n\r\ntail`
    const spans = [
      { start: 9, end: 13, bold: true },
      { start: 17, end: 21, italic: true },
    ]
    const blocks = legacyToBlocks(crlf, { spans, headings: [0, 2] })
    const expected: BlockNode[] = [
      { type: 'paragraph', content: [{ text: `${family} ` }, { text: 'Bold', bold: true }] },
      { type: 'heading', level: 2 },
      { type: 'paragraph', content: [{ text: 'tail', italic: true }] },
    ]
    expect(blocks).toStrictEqual(expected)
    // Back to the compact form: the same lines, marks and heading. A "\r\n" is one line break and comes back as "\n".
    const lf = { text: `${family} Bold\n\ntail`, spans: [{ start: 9, end: 13, bold: true }, { start: 15, end: 19, italic: true }], headings: [0, 2] }
    expect(blocksToLegacy(blocks)).toStrictEqual(lf)
    expect(legacyToBlocks(lf.text, lf)).toStrictEqual(expected)
    expect(blocksToLegacy(legacyToBlocks(lf.text, lf))).toStrictEqual(lf)
    expect(plainTextOf(blocks)).toBe(lf.text)
  })

  it('never splits a character: a span that starts inside the emoji covers all of it', () => {
    const text = `${family}ab`
    expect(legacyToBlocks(text, { spans: [{ start: 3, end: 9, bold: true }] })).toStrictEqual([{ type: 'paragraph', content: [{ text: `${family}a`, bold: true }, { text: 'b' }] }])
  })

  it('cuts a span that crosses a line break into one run per line, and drops bold inside headings', () => {
    const blocks = legacyToBlocks('ab\ncd', { spans: [{ start: 1, end: 5, bold: true, font: 'mono' }], headings: [0, 1] }, 'serif')
    expect(blocks).toStrictEqual([
      { type: 'paragraph', content: [{ text: 'a' }, { text: 'b', bold: true, font: 'mono' }] },
      { type: 'heading', level: 1, content: [{ text: 'cd', font: 'mono' }] },
    ])
    expect(blocksToLegacy(blocks, 'serif')).toStrictEqual({ text: 'ab\ncd', spans: [{ start: 1, end: 2, bold: true, font: 'mono' }, { start: 2, end: 5, font: 'mono' }], headings: [0, 1] })
  })

  it('converts a long text with thousands of spans over several lines run by run', () => {
    // Every other character bold, over five lines of 8,000 characters (one of them a heading).
    const lines = 5
    const width = 8_000
    const text = Array.from({ length: lines }, () => 'ab'.repeat(width / 2)).join('\n')
    const spans: Array<{ start: number; end: number; bold: true }> = []
    for (let l = 0; l < lines; l++) for (let k = 0; k < width; k += 2) spans.push({ start: l * (width + 1) + k, end: l * (width + 1) + k + 1, bold: true })
    const blocks = legacyToBlocks(text, { spans, headings: [0, 2] })
    expect(blocks).toHaveLength(lines)
    blocks.forEach((b, l) => {
      expect(b.type).toBe(l === 1 ? 'heading' : 'paragraph')
      const runs = (b as { content: Array<{ text: string; bold?: true }> }).content
      if (l === 1) {
        expect(runs).toStrictEqual([{ text: 'ab'.repeat(width / 2) }]) // bold is never stored inside a heading
        return
      }
      expect(runs).toHaveLength(width)
      runs.forEach((r, k) => expect(r).toStrictEqual(k % 2 === 0 ? { text: 'a', bold: true } : { text: 'b' }))
    })
    const back = blocksToLegacy(blocks)!
    expect(back.text).toBe(text)
    expect(back.headings).toStrictEqual([0, 2])
    expect(back.spans).toStrictEqual(canonicalSpans(text, spans, [0, 2]))
    expect(legacyToBlocks(back.text, back)).toStrictEqual(blocks)
  })

  it('an empty text is one empty paragraph', () => {
    expect(legacyToBlocks('')).toStrictEqual([{ type: 'paragraph' }])
    expect(blocksToLegacy([{ type: 'paragraph' }])).toStrictEqual({ text: '' })
  })

  it('has no compact form for blocks beyond paragraphs and headings, or for the code mark', () => {
    expect(blocksToLegacy([{ type: 'divider' }])).toBeNull()
    expect(blocksToLegacy([{ type: 'paragraph', content: [{ text: 'x', code: true }] }])).toBeNull()
  })
})

describe('plainTextOf and isBlankTextDoc', () => {
  it('lists the words of every paragraph, heading and code block, one per line', () => {
    const blocks: BlockNode[] = [
      { type: 'heading', level: 1, content: [{ text: 'Title' }] },
      { type: 'divider' },
      { type: 'bulletList', items: [{ blocks: [{ type: 'paragraph', content: [{ text: 'a' }] }, { type: 'blockquote', blocks: [{ type: 'paragraph', content: [{ text: 'b' }] }] }] }] },
      { type: 'codeBlock', text: 'x\ny' },
      { type: 'paragraph' },
    ]
    expect(plainTextOf(blocks)).toBe('Title\na\nb\nx\ny\n')
  })

  it('is blank exactly with no visible character, no divider and no ticked checkbox', () => {
    const para = (text?: string): BlockNode => (text ? { type: 'paragraph', content: [{ text }] } : { type: 'paragraph' })
    const task = (checked: boolean): BlockNode => ({ type: 'taskList', items: [{ checked, blocks: [para()] }] })
    expect(isBlankTextDoc({ text: ' \n\t' })).toBe(true)
    expect(isBlankTextDoc({ text: ' x ' })).toBe(false)
    const blank: BlockNode[][] = [
      [para(), para('  ')],
      [{ type: 'bulletList', items: [{ blocks: [para()] }] }],
      [{ type: 'orderedList', items: [{ blocks: [para()] }] }],
      [task(false)],
      [{ type: 'blockquote', blocks: [para()] }],
      [{ type: 'codeBlock', text: ' \n ' }],
      [{ type: 'heading', level: 1 }],
    ]
    for (const blocks of blank) expect(isBlankTextDoc({ text: '', blocks }), JSON.stringify(blocks)).toBe(true)
    const kept: BlockNode[][] = [
      [{ type: 'divider' }],
      [task(true)],
      [{ type: 'blockquote', blocks: [{ type: 'bulletList', items: [{ blocks: [task(true)] }] }] }],
      [{ type: 'blockquote', blocks: [{ type: 'divider' }] }],
      [{ type: 'codeBlock', text: 'x' }],
      [{ type: 'taskList', items: [{ checked: false, blocks: [para('todo')] }] }],
    ]
    for (const blocks of kept) expect(isBlankTextDoc({ text: '', blocks }), JSON.stringify(blocks)).toBe(false)
  })
})

describe('rich fields and the storage fence', () => {
  const text: TextRecord = { ...base, text: 'a' }

  it('needs wire version 3 exactly when a text has blocks, a fixed height or paper', () => {
    expect(needsRichFence({ objects: [text] })).toBe(false)
    expect(needsRichFence({ objects: [{ ...text, height: undefined, blocks: undefined, surface: undefined }] })).toBe(false)
    expect(needsRichFence({ objects: [{ ...text, blocks: [{ type: 'divider' }] }] })).toBe(true)
    expect(needsRichFence({ objects: [{ ...text, height: 40 }] })).toBe(true)
    expect(needsRichFence({ objects: [{ ...text, surface: 'card' }] })).toBe(true)
  })

  it('this build can edit none of them yet', () => {
    expect([...EDITABLE_RICH_FIELDS]).toEqual([])
    expect(uneditableRichFields({ objects: [text] }).size).toBe(0)
    const all = uneditableRichFields({ objects: [{ ...text, height: 40 }, { ...text, id: 'b', blocks: [{ type: 'divider' }], surface: 'card' }] })
    expect([...all].sort()).toEqual(['blocks', 'height', 'surface'])
  })
})
