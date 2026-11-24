import { describe, expect, it } from 'vitest'
import { markdownToBlocks } from './markdownPaste.ts'
import { LITERAL_CASES } from './testing/literalCases.ts'
import { MAX_BLOCK_DEPTH, MAX_NODES, MAX_TEXT_LENGTH, canonicalTextContent, parseBlocks, plainTextOf } from './textDoc.ts'
import type { BlockNode, InlineRun } from './types.ts'

/**
 * `markdownToBlocks`: pasted plain Markdown as blocks (plan Section 11). Every result is checked
 * against the model's own strict validator and canonical form (`md`). Agreement with typing the
 * same line key by key is in `src/editor/literalCases.test.ts`.
 */

/** The conversion of `text`, checked to be valid, canonical and storable whenever it is not null. */
function md(text: string): BlockNode[] | null {
  const out = markdownToBlocks(text)
  if (out !== null) {
    expect(parseBlocks(out)).toStrictEqual(out)
    expect(canonicalTextContent({ text: '', blocks: out })).not.toBeNull()
    expect(JSON.stringify(out)).not.toContain('\\r')
  }
  return out
}

type Marks = Omit<InlineRun, 'text'>
const r = (text: string, marks: Marks = {}): InlineRun => ({ text, ...marks })
const p = (...content: Array<InlineRun | string>): BlockNode => (content.length ? { type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? r(c) : c)) } : { type: 'paragraph' })
const h = (level: 1 | 2 | 3, ...content: Array<InlineRun | string>): BlockNode => ({ type: 'heading', level, ...(content.length && { content: content.map((c) => (typeof c === 'string' ? r(c) : c)) }) })
const ul = (...items: BlockNode[][]): BlockNode => ({ type: 'bulletList', items: items.map((blocks) => ({ blocks })) })
const ol = (start: number, ...items: BlockNode[][]): BlockNode => ({ type: 'orderedList', ...(start > 1 && { start }), items: items.map((blocks) => ({ blocks })) })
const tl = (...items: Array<[boolean, BlockNode[]]>): BlockNode => ({ type: 'taskList', items: items.map(([checked, blocks]) => ({ checked, blocks })) })
const q = (...blocks: BlockNode[]): BlockNode => ({ type: 'blockquote', blocks })
const code = (text: string): BlockNode => ({ type: 'codeBlock', text })
const hr: BlockNode = { type: 'divider' }
const B = { bold: true } as const
const I = { italic: true } as const
const C = { code: true } as const

/** The depth of the deepest block (top level 1), as `parseBlocks` counts. */
function depthOf(blocks: readonly BlockNode[], depth = 1): number {
  let max = depth
  for (const b of blocks) {
    if (b.type === 'blockquote') max = Math.max(max, depthOf(b.blocks, depth + 1))
    else if (b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'taskList') for (const i of b.items) max = Math.max(max, depthOf(i.blocks, depth + 1))
  }
  return max
}

describe('nothing to convert', () => {
  it('gives null for text with no marker, so the paste is the literal paste', () => {
    for (const t of ['', 'plain', 'two\nlines', 'a\n\nb', '  indented', '   ', '\t', 'trailing\n', 'a\r\nb\rc', 'nothing *here', 'no `code', '1) not a list', '•  bullet char']) expect(md(t), JSON.stringify(t)).toBeNull()
  })

  it('gives null for every shared literal case, and for them all pasted together', () => {
    for (const c of LITERAL_CASES) expect(md(c.text), `${c.text}: ${c.why}`).toBeNull()
    expect(md(LITERAL_CASES.map((c) => c.text).join('\n'))).toBeNull()
  })
})

describe('the plan example', () => {
  it('gives a heading, an empty paragraph, a bullet, a ticked task, a quote and a paragraph whose only bold run is `bold`', () => {
    expect(md('# Title\n\n- one\n- [x] two\n> quote\n**bold** and 2 * 3 * 4')).toStrictEqual([
      h(1, 'Title'),
      p(),
      ul([p('one')]),
      tl([true, [p('two')]]),
      q(p('quote')),
      p(r('bold', B), ' and 2 * 3 * 4'),
    ])
  })
})

describe('every marker', () => {
  it('converts each line marker alone', () => {
    expect(md('# One')).toStrictEqual([h(1, 'One')])
    expect(md('## Two')).toStrictEqual([h(2, 'Two')])
    expect(md('### Three')).toStrictEqual([h(3, 'Three')])
    expect(md('# ')).toStrictEqual([h(1)])
    expect(md('- item')).toStrictEqual([ul([p('item')])])
    expect(md('- ')).toStrictEqual([ul([p()])])
    expect(md('1. first')).toStrictEqual([ol(1, [p('first')])])
    expect(md('7. seventh')).toStrictEqual([ol(7, [p('seventh')])])
    expect(md('007. bond')).toStrictEqual([ol(7, [p('bond')])])
    expect(md('999999999. last')).toStrictEqual([ol(999_999_999, [p('last')])])
    expect(md('- [ ] open')).toStrictEqual([tl([false, [p('open')]])])
    expect(md('- [x] done')).toStrictEqual([tl([true, [p('done')]])])
    expect(md('- [] empty')).toStrictEqual([tl([false, [p('empty')]])])
    expect(md('[ ] bare')).toStrictEqual([tl([false, [p('bare')]])])
    expect(md('> said')).toStrictEqual([q(p('said'))])
    expect(md('> ')).toStrictEqual([q(p())])
    expect(md('---')).toStrictEqual([hr])
    expect(md('```')).toStrictEqual([code('')])
  })

  it('leaves near misses literal', () => {
    for (const t of ['#### four', '#x', '-x', '- [X] not ticked', '1.x', '0. zero', '1000000000. over', '>x', '----', '--- ', ' ---', '``', '`` x', '+ plus', '* star', '[x] alone']) {
      const out = md(t)
      if (t === '- [X] not ticked') expect(out).toStrictEqual([ul([p('[X] not ticked')])])
      else expect(out, t).toBeNull()
    }
  })

  it('converts each inline marker alone and together, with the typed conditions', () => {
    expect(md('**bold**')).toStrictEqual([p(r('bold', B))])
    expect(md('*it*')).toStrictEqual([p(r('it', I))])
    expect(md('`code`')).toStrictEqual([p(r('code', C))])
    expect(md('a **b** *c* `d` e')).toStrictEqual([p('a ', r('b', B), ' ', r('c', I), ' ', r('d', C), ' e')])
    expect(md('**a *b* c**')).toStrictEqual([p(r('a ', B), r('b', { bold: true, italic: true }), r(' c', B))])
    expect(md('*x **y** z*')).toStrictEqual([p(r('x ', I), r('y', { bold: true, italic: true }), r(' z', I))])
    expect(md('(*x*) "**y**" [`z`]')).toStrictEqual([p('(', r('x', I), ') "', r('y', B), '" [', r('z', C), ']')])
    // Typed key by key, the closing `*` of `*a*` fires before the next `*` is typed.
    expect(md('*a**')).toStrictEqual([p(r('a', I), '*')])
    // A marker removed by an earlier conversion is gone: the later `*` pairs with nothing.
    expect(md('*a*b*')).toStrictEqual([p(r('a', I), 'b*')])
    // P2: code spans come first. No `*` inside one is a marker, and a `*` pair around one marks it.
    expect(md('`*a*`')).toStrictEqual([p(r('*a*', C))])
    expect(md('`echo *demo*`')).toStrictEqual([p(r('echo *demo*', C))])
    expect(md('`a *b` c*')).toStrictEqual([p(r('a *b', C), ' c*')])
    expect(md('*a `b* c`')).toStrictEqual([p('*a ', r('b* c', C))])
    expect(md('*a `b` c*')).toStrictEqual([p(r('a ', I), r('b', { italic: true, code: true }), r(' c', I))])
    expect(md('*`a`*')).toStrictEqual([p(r('`a`', I))])
    // Left to right: a backtick that opens nothing is a character, and does not stop emphasis.
    expect(md('`x `a` y`')).toStrictEqual([p('`x ', r('a', C), ' y`')])
    expect(md('it`s *fine*')).toStrictEqual([p('it`s ', r('fine', I))])
    expect(md('` *x*')).toStrictEqual([p('` ', r('x', I))])
    // A marker joined to a combining mark is no marker; an emoji is one character.
    expect(md('*a*́')).toBeNull()
    expect(md('*🙂*')).toStrictEqual([p(r('🙂', I))])
    expect(md('\t*tab*')).toStrictEqual([p('\t', r('tab', I))])
  })

  it('converts inline markers inside headings (bold not stored), list items and quotes, and never in a code block', () => {
    expect(md('# **big** *it*')).toStrictEqual([h(1, 'big ', r('it', I))])
    expect(md('- **b** and `c`')).toStrictEqual([ul([p(r('b', B), ' and ', r('c', C))])])
    expect(md('> *quoted*')).toStrictEqual([q(p(r('quoted', I)))])
    expect(md('```\n**not bold** `x`\n```')).toStrictEqual([code('**not bold** `x`')])
  })

  it('converts at the start of an item only what typing there converts', () => {
    expect(md('- # heading')).toStrictEqual([ul([h(1, 'heading')])])
    expect(md('- [ ] ## task heading')).toStrictEqual([tl([false, [h(2, 'task heading')]])])
    expect(md('- - not nested')).toStrictEqual([ul([p('- not nested')])])
    expect(md('- > not quoted')).toStrictEqual([ul([p('> not quoted')])])
    expect(md('- ---')).toStrictEqual([ul([p('---')])])
    expect(md('- ```')).toStrictEqual([ul([p('```')])])
    expect(md('1. [ ] not a task')).toStrictEqual([ol(1, [p('[ ] not a task')])])
    expect(md('- [x] [ ] one box')).toStrictEqual([tl([true, [p('[ ] one box')]])])
    expect(md('# - not a list')).toStrictEqual([h(1, '- not a list')])
    expect(md('# # again')).toStrictEqual([h(1, 'again')])
    expect(md('## # last wins')).toStrictEqual([h(1, 'last wins')])
    expect(md('-  two spaces')).toStrictEqual([ul([p(' two spaces')])])
    expect(md('#  two spaces')).toStrictEqual([h(1, ' two spaces')])
  })
})

describe('lines and nesting', () => {
  it('nests a list line indented by two spaces or more, or a tab, one level under the item above', () => {
    expect(md('- a\n  - b\n    - c\n- d')).toStrictEqual([ul([p('a'), ul([p('b'), ul([p('c')])])], [p('d')])])
    expect(md('- a\n\t- b\n\t\t- c')).toStrictEqual([ul([p('a'), ul([p('b'), ul([p('c')])])])])
    expect(md('- a\n \t- b\n\t  - c')).toStrictEqual([ul([p('a'), ul([p('b'), ul([p('c')])])])])
    // Far deeper than the item above is still only one level down.
    expect(md('- a\n          - b')).toStrictEqual([ul([p('a'), ul([p('b')])])])
    // One space is not enough.
    expect(md('- a\n - b')).toStrictEqual([ul([p('a')], [p('b')])])
    // Between two open levels, a line sits beside the deeper one.
    expect(md('- a\n    - b\n  - c')).toStrictEqual([ul([p('a'), ul([p('b')], [p('c')])])])
    // Fault 2: later lines are measured against the last item's own indent.
    expect(md('- a\n    - b\n  - c\n    - d')).toStrictEqual([ul([p('a'), ul([p('b')], [p('c'), ul([p('d')])])])])
    expect(md('- a\n    - b\n  - c\n    - d\n  - e')).toStrictEqual([ul([p('a'), ul([p('b')], [p('c'), ul([p('d')])], [p('e')])])])
    expect(md('- a\n    - b\n  1. c\n    - d')).toStrictEqual([ul([p('a'), ul([p('b')]), ol(1, [p('c'), ul([p('d')])])])])
    // Kinds mix at any level.
    expect(md('1. a\n   - [ ] b\n   - [x] c\n2. d')).toStrictEqual([ol(1, [p('a'), tl([false, [p('b')]], [true, [p('c')]])], [p('d')])])
  })

  it('stops nesting at the depth bound: deeper lines stay at the deepest level', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `${'  '.repeat(i)}- l${i}`)
    const out = md(lines.join('\n'))!
    expect(depthOf(out)).toBe(MAX_BLOCK_DEPTH)
    let list = out[0] as Extract<BlockNode, { type: 'bulletList' }>
    for (let level = 1; level < MAX_BLOCK_DEPTH - 1; level++) list = list.items[0]!.blocks[1] as typeof list
    expect(list.items.map((i) => i.blocks)).toStrictEqual([[p('l4')], [p('l5')], [p('l6')], [p('l7')], [p('l8')]])
    // Inside a quote, one level less.
    const quoted = md(lines.map((l) => `> ${l}`).join('\n'))!
    expect(depthOf(quoted)).toBe(MAX_BLOCK_DEPTH)
  })

  it('makes a blank line an empty paragraph, but drops one blank line inside a list', () => {
    expect(md('a\n\n- b')).toStrictEqual([p('a'), p(), ul([p('b')])])
    expect(md('- a\n\n- b')).toStrictEqual([ul([p('a')], [p('b')])])
    expect(md('1. a\n\n2. b\n\n3. c')).toStrictEqual([ol(1, [p('a')], [p('b')], [p('c')])])
    // A blank line before a new list inside an item stays there; before the next item of the same list it goes.
    expect(md('- a\n\n  - b\n\n- c')).toStrictEqual([ul([p('a'), p(), ul([p('b')])], [p('c')])])
    expect(md('- a\n  - b\n\n  - c')).toStrictEqual([ul([p('a'), ul([p('b')], [p('c')])])])
    // Fault 1: a blank line between two different lists inside an item stays, between them.
    expect(md('- a\n  - b\n\n  1. c')).toStrictEqual([ul([p('a'), ul([p('b')]), p(), ol(1, [p('c')])])])
    expect(md('- a\n  - b\n\n  - [ ] c')).toStrictEqual([ul([p('a'), ul([p('b')]), p(), tl([false, [p('c')]])])])
    // Two blank lines end the list.
    expect(md('- a\n\n\n- b')).toStrictEqual([ul([p('a')]), p(), p(), ul([p('b')])])
    // A blank line before a different list, or a paragraph, is kept.
    expect(md('- a\n\n1. b')).toStrictEqual([ul([p('a')]), p(), ol(1, [p('b')])])
    expect(md('- a\n\nafter')).toStrictEqual([ul([p('a')]), p(), p('after')])
    // A blank line before an indented paragraph of the item stays, inside the item.
    expect(md('- a\n\n  more')).toStrictEqual([ul([p('a'), p(), p('more')])])
    // Fault 3: two blank lines end the list before an indented line too, which then stays as written.
    expect(md('- a\n\n\n  b')).toStrictEqual([ul([p('a')]), p(), p(), p('  b')])
    expect(md('- a\n \t\n\t\n  b *i*')).toStrictEqual([ul([p('a')]), p(' \t'), p('\t'), p('  b ', r('i', I))])
    // Blank lines at the end are kept.
    expect(md('- a\n')).toStrictEqual([ul([p('a')]), p()])
    // A line of only spaces is blank: kept as written outside a list, dropped once inside one.
    expect(md('   \n- a\n  \n- b')).toStrictEqual([p('   '), ul([p('a')], [p('b')])])
  })

  it('makes consecutive numbered items one list, numbered from its first item whatever the later numbers (P4)', () => {
    expect(md('3. c\n4. d')).toStrictEqual([ol(3, [p('c')], [p('d')])])
    expect(md('1. a\n1. b\n1. c')).toStrictEqual([ol(1, [p('a')], [p('b')], [p('c')])])
    expect(md('3. a\n7. b')).toStrictEqual([ol(3, [p('a')], [p('b')])])
    expect(md('1. a\n5. b\n\n6. c')).toStrictEqual([ol(1, [p('a')], [p('b')], [p('c')])])
    expect(md('5. a\n  1. x\n  9. y\n6. b')).toStrictEqual([ol(5, [p('a'), ol(1, [p('x')], [p('y')])], [p('b')])])
    expect(md('1. a\n   1. x\n   2. y\n2. b')).toStrictEqual([ol(1, [p('a'), ol(1, [p('x')], [p('y')])], [p('b')])])
    expect(md('- a\n- [ ] b\n- c')).toStrictEqual([ul([p('a')]), tl([false, [p('b')]]), ul([p('c')])])
  })

  it('ends a list at a line that is not indented; an indented line is a further paragraph of the item above it', () => {
    expect(md('- a\nafter\n- b')).toStrictEqual([ul([p('a')]), p('after'), ul([p('b')])])
    expect(md('- a\n  more *about* a\n- b')).toStrictEqual([ul([p('a'), p('more ', r('about', I), ' a')], [p('b')])])
    expect(md('- a\n  - b\n  back to a\n    under b?')).toStrictEqual([ul([p('a'), ul([p('b')]), p('back to a'), p('under b?')])])
    expect(md('- a\n  - b\n      under b')).toStrictEqual([ul([p('a'), ul([p('b'), p('under b')])])])
    // Only headings and inline marks convert in such a paragraph, as typing there would.
    expect(md('- a\n  # h\n  > not quoted\n  ---')).toStrictEqual([ul([p('a'), h(1, 'h'), p('> not quoted'), p('---')])])
    // A list that starts indented: a line no further in is not under it.
    expect(md('  - a\n  b')).toStrictEqual([ul([p('a')]), p('  b')])
    // Under a paragraph, an indented line stays as written.
    expect(md('para\n  indented *i*')).toStrictEqual([p('para'), p('  indented ', r('i', I))])
    expect(md('para\n  - nested?')).toStrictEqual([p('para'), ul([p('nested?')])])
  })

  it('makes consecutive `> ` lines one quote, converted again inside', () => {
    expect(md('> one\n> two')).toStrictEqual([q(p('one'), p('two'))])
    expect(md('> one\n>\n> two')).toStrictEqual([q(p('one'), p(), p('two'))])
    expect(md('>\n> two')).toStrictEqual([q(p(), p('two'))])
    expect(md('> one\n\n> two')).toStrictEqual([q(p('one')), p(), q(p('two'))])
    expect(md('> one\nafter')).toStrictEqual([q(p('one')), p('after')])
    expect(md('> > deep\n> shallow')).toStrictEqual([q(q(p('deep')), p('shallow'))])
    expect(md('> - a\n>   - b\n> # h')).toStrictEqual([q(ul([p('a'), ul([p('b')])]), h(1, 'h'))])
    expect(md('> ```\n> code *x*\n> ```\n> after')).toStrictEqual([q(code('code *x*'), p('after'))])
    expect(md('> ---')).toStrictEqual([q(hr)])
    // `>` lines alone stay as written, and so does a `>` joined to a mark.
    expect(md('>\n>')).toBeNull()
    expect(md('> ́x')).toBeNull()
    // A quote ends a list and a list ends a quote.
    expect(md('- a\n> b\n- c')).toStrictEqual([ul([p('a')]), q(p('b')), ul([p('c')])])
  })

  it('stops nesting quotes at the depth bound: the rest of the line stays as written', () => {
    const out = md('> > > > > > > x *i*')!
    expect(depthOf(out)).toBe(MAX_BLOCK_DEPTH)
    expect(out).toStrictEqual([q(q(q(q(q(p('> > x ', r('i', I)))))))])
    expect(md('> > > > > - x')).toStrictEqual([q(q(q(q(q(p('- x'))))))])
  })

  it('closes a fence only on a line of at least as many backticks as opened it (P3)', () => {
    const t = '`'
    const f3 = t.repeat(3)
    const f4 = t.repeat(4)
    // Four can hold an example of three.
    expect(md([`${f4}md`, `${f3}js`, 'const x = 1', f3, f4, 'after'].join('\n'))).toStrictEqual([code([`${f3}js`, 'const x = 1', f3].join('\n')), p('after')])
    expect(md([f4, 'x', f3].join('\n'))).toStrictEqual([code(['x', f3].join('\n'))])
    expect(md([f4, 'x', `${t.repeat(5)} \t`, 'y'].join('\n'))).toStrictEqual([code('x'), p('y')])
    // A line of backticks with text after them is content, never a close.
    expect(md([f3, 'x', `${f3}js`, '# y'].join('\n'))).toStrictEqual([code(['x', `${f3}js`, '# y'].join('\n'))])
  })

  it('makes a code block of a fence, to the next line of only backticks or the end', () => {
    expect(md('```\na\n```')).toStrictEqual([code('a')])
    expect(md('```\n```')).toStrictEqual([code('')])
    expect(md('```ts\nconst a = 1\n```\nafter')).toStrictEqual([code('const a = 1'), p('after')])
    expect(md('```\nnever closed\n# not a heading')).toStrictEqual([code('never closed\n# not a heading')])
    expect(md('```\n- a\n\n> b\n---\n**c**\n```')).toStrictEqual([code('- a\n\n> b\n---\n**c**')])
    expect(md('```\n```js not a fence\nstill code\n````  ')).toStrictEqual([code('```js not a fence\nstill code')])
    expect(md('```\n  indented\n\ttab\n```')).toStrictEqual([code('  indented\n\ttab')])
    expect(md('- a\n```\nx\n```\n- b')).toStrictEqual([ul([p('a')]), code('x'), ul([p('b')])])
    expect(md('```\na\r\nb\rc\n```')).toStrictEqual([code('a\nb\nc')])
    // An indented fence is no fence, and nor is one joined to a mark.
    expect(md('  ```\n  x')).toBeNull()
    expect(md('```́')).toBeNull()
  })

  it('ends a line at "\\n", "\\r\\n" and a lone "\\r"', () => {
    const expected = [h(1, 'a'), ul([p('b')], [p('c')]), p('d')]
    expect(md('# a\n- b\n- c\nd')).toStrictEqual(expected)
    expect(md('# a\r\n- b\r\n- c\r\nd')).toStrictEqual(expected)
    expect(md('# a\r- b\r- c\rd')).toStrictEqual(expected)
    expect(md('# a\r\n- b\r- c\nd')).toStrictEqual(expected)
    expect(md('- a\r\n\r\n- b')).toStrictEqual([ul([p('a')], [p('b')])])
  })
})

describe('what stays untouched inside too (P1)', () => {
  it('converts nothing inside a link, an image, an HTML tag, on a table line, or for an escaped marker', () => {
    for (const t of [
      '[*mix*](u)',
      '![*cover*](u)',
      '[**Session notes**](notes.md)',
      '[a `b` c](u*v*)',
      '<b title="*mix*">x</b>',
      '<span title="`x`">y</span>',
      '| *mix* |',
      '| name |\n| --- |\n| *mix* | **ok** | `x` |',
      '  | *indented* |',
      '*a\\*',
      '\\*a*',
      '\\`a`',
      '\\# not a heading',
    ]) {
      expect(md(t), t).toBeNull()
    }
  })

  it('still converts the real markers on the line, and a block marker before such a span', () => {
    expect(md('**bold** and [*x*](u)')).toStrictEqual([p(r('bold', B), ' and [*x*](u)')])
    expect(md('see <a href="*x*">this</a> *here*')).toStrictEqual([p('see <a href="*x*">this</a> ', r('here', I))])
    // The opener must still start a word: straight after a tag's `>` it does not.
    expect(md('<i>*x*</i>')).toBeNull()
    expect(md('**a\\*b**')).toStrictEqual([p(r('a\\*b', B))])
    expect(md('**a\\\\**')).toStrictEqual([p(r('a\\\\', B))]) // an escaped backslash escapes nothing after it
    expect(md('- [*mix*](u)')).toStrictEqual([ul([p('[*mix*](u)')])])
    expect(md('# ![*cover*](c.jpg)')).toStrictEqual([h(1, '![*cover*](c.jpg)')])
    expect(md('> | *a* |')).toStrictEqual([q(p('| *a* |'))])
    // A table line ends a list and keeps its indent.
    expect(md('- a\n  | *x* |')).toStrictEqual([ul([p('a')]), p('  | *x* |')])
    // A `[` or `<` that opens nothing is a character.
    expect(md('[*x*] and 2 < *y*')).toStrictEqual([p('[', r('x', I), '] and 2 < ', r('y', I))])
  })
})

describe('a marker never joins the characters around it (fault 4)', () => {
  it('does not count a marker whose removal would join two characters into one', () => {
    // Two regional indicators either side of a marker would become one flag.
    expect(md('- *🇺*🇸')).toStrictEqual([ul([p('*🇺*🇸')])])
    expect(md('**🇺**🇸')).toBeNull()
    expect(md('`🇺`🇸')).toBeNull()
    // A ZWJ at the end of the marked text would join the emoji after the marker.
    expect(md('*👨‍*👩')).toBeNull()
    expect(md('**👨‍**👩')).toBeNull()
    expect(md('`👨‍`👩')).toBeNull()
    // A skin tone, a variation selector or a combining mark straight after a marker joins the marker itself.
    for (const joiner of ['\u{1F3FD}', '️', '́']) {
      expect(md(`*a*${joiner}`), joiner).toBeNull()
      expect(md(`**a**${joiner}`), joiner).toBeNull()
      expect(md(`\`a\`${joiner}`), joiner).toBeNull()
    }
    // Hangul jamo: a trailing consonant after a syllable joins it.
    expect(md('*가*ᆨ')).toBeNull()
  })

  it('counts a marker beside characters that stay apart', () => {
    expect(md('*🇺🇸*🇬🇧')).toStrictEqual([p(r('🇺🇸', I), '🇬🇧')])
    expect(md('`🇺🇸`🇬🇧')).toStrictEqual([p(r('🇺🇸', C), '🇬🇧')])
    expect(md('*👍🏽*👍')).toStrictEqual([p(r('👍🏽', I), '👍')])
    expect(md('*한*국')).toStrictEqual([p(r('한', I), '국')])
    expect(md('*é*é')).toStrictEqual([p(r('é', I), 'é')])
  })
})

describe('the shared literal table', () => {
  it("holds each of the plan's twelve pinned cases by name", () => {
    const texts = LITERAL_CASES.map((c) => c.text)
    for (const pinned of ['2 * 3 * 4', 'a ** b', '* item', '**', 'snake*case*', '***x***', '#tag', '#### four', 'a # b', '** x**', '*x *', '#x']) expect(texts, pinned).toContain(pinned)
  })
})

describe('real documents', () => {
  const t = '`'
  const f3 = t.repeat(3)
  const f4 = t.repeat(4)

  it('an album review: title, notes, a numbered track list with nested notes, a checklist, a pull quote, code, a divider, a link and an image', () => {
    const album = [
      '# Glass Harbour — Night Ferry',
      '',
      'The **bass** leaves room for *air*.',
      '',
      '1. Channel Lights',
      '   - Listen for the guitar.',
      '2. Low Water',
      '   - [x] Compare the master.',
      '',
      '- [ ] Buy the LP',
      '- [x] Save the radio edit',
      '',
      '> The voice seems to come from the room next door.',
      '',
      '---',
      '',
      `${f3}text`,
      'Track 02   DR10   -1.2 dB',
      f3,
      '',
      '[**Session notes**](notes.md)',
      '![*Front cover*](cover.jpg)',
    ].join('\r\n')
    expect(md(album)).toStrictEqual([
      h(1, 'Glass Harbour — Night Ferry'),
      p(),
      p('The ', r('bass', B), ' leaves room for ', r('air', I), '.'),
      p(),
      ol(1, [p('Channel Lights'), ul([p('Listen for the guitar.')])], [p('Low Water'), tl([true, [p('Compare the master.')]])]),
      p(),
      tl([false, [p('Buy the LP')]], [true, [p('Save the radio edit')]]),
      p(),
      q(p('The voice seems to come from the room next door.')),
      p(),
      hr,
      p(),
      code('Track 02   DR10   -1.2 dB'),
      p(),
      p('[**Session notes**](notes.md)'),
      p('![*Front cover*](cover.jpg)'),
    ])
  })

  it('a short README: a command with wildcards in a code span, steps all numbered 1., a table, an HTML tag, a four-backtick example', () => {
    const readme = [
      '# Pocket Mixer',
      '',
      `Install ${t}npm install${t}, then try ${t}echo *demo*${t}.`,
      '',
      '1. Install Node',
      '1. Start the app',
      '1. Open *Mixer*',
      '',
      '| API | Result |',
      '| --- | --- |',
      `| ${t}mix${t} | **ok** |`,
      '',
      '<span title="*example*">Mixer</span>',
      '',
      `${f4}md`,
      `${f3}js`,
      'const x = 1',
      f3,
      f4,
    ].join('\n')
    expect(md(readme)).toStrictEqual([
      h(1, 'Pocket Mixer'),
      p(),
      p('Install ', r('npm install', C), ', then try ', r('echo *demo*', C), '.'),
      p(),
      ol(1, [p('Install Node')], [p('Start the app')], [p('Open ', r('Mixer', I))]),
      p(),
      p('| API | Result |'),
      p('| --- | --- |'),
      p(`| ${t}mix${t} | **ok** |`),
      p(),
      p('<span title="*example*">Mixer</span>'),
      p(),
      code([`${f3}js`, 'const x = 1', f3].join('\n')),
    ])
  })

  it('ordinary prose with stray `*`, `#`, `>` and dashes stays as written', () => {
    const prose = [
      'It costs 2 * 3 * 4. Use C# and A > B; wait - then listen.',
      'Track 3 - the one with a 5 * 2 hook - is #1 on my list.',
      'He said > that was it, and -- honestly -- I agree.',
      'Ratings: 4/5 * maybe, a*b, x - y, #hashtag, 3>2 and 1.5 stars.',
      '',
      '    indented, 10 - 2 = 8, and *nothing* else? no: snake*case*',
    ]
    expect(md(prose.slice(0, 5).join('\n'))).toBeNull()
    expect(md(prose[5]!)).toStrictEqual([p('    indented, 10 - 2 = 8, and ', r('nothing', I), ' else? no: snake*case*')])
  })
})

describe('bounds', () => {
  it('converts a result of exactly MAX_NODES nodes and refuses one more', () => {
    // A bullet list (1) whose items are an item, a paragraph and a run each (3).
    const items = (MAX_NODES - 1) / 3
    expect(Number.isInteger(items)).toBe(true)
    const at = md(Array.from({ length: items }, () => '- a').join('\n'))!
    expect((at[0] as Extract<BlockNode, { type: 'bulletList' }>).items).toHaveLength(items)
    // One node more: a trailing blank line is one empty paragraph.
    expect(md(`${Array.from({ length: items }, () => '- a').join('\n')}\n`)).toBeNull()
    expect(md(Array.from({ length: items + 1 }, () => '- a').join('\n'))).toBeNull()
    // Dividers are one node each.
    expect(md(Array.from({ length: MAX_NODES }, () => '---').join('\n'))).toHaveLength(MAX_NODES)
    expect(md(Array.from({ length: MAX_NODES + 1 }, () => '---').join('\n'))).toBeNull()
  })

  it('converts a result of exactly MAX_TEXT_LENGTH characters and refuses one more', () => {
    expect(md(`# ${'a'.repeat(MAX_TEXT_LENGTH)}`)).toStrictEqual([h(1, 'a'.repeat(MAX_TEXT_LENGTH))])
    expect(md(`# ${'a'.repeat(MAX_TEXT_LENGTH + 1)}`)).toBeNull()
    expect(md(`\`\`\`\n${'a'.repeat(MAX_TEXT_LENGTH)}`)).toStrictEqual([code('a'.repeat(MAX_TEXT_LENGTH))])
    expect(md(`\`\`\`\n${'a'.repeat(MAX_TEXT_LENGTH / 2)}\n${'a'.repeat(MAX_TEXT_LENGTH / 2)}`)).toBeNull() // the line break counts
    // Markers do not count: only the characters that are kept.
    expect(md(`**${'a'.repeat(MAX_TEXT_LENGTH)}**`)).not.toBeNull()
  })

  it('converts a result exactly at the depth bound, and never goes past it', () => {
    const atBound = md(['- 1', '  - 2', '    - 3', '      - 4', '        - 5'].join('\n'))!
    expect(depthOf(atBound)).toBe(MAX_BLOCK_DEPTH)
    const capped = md(['- 1', '  - 2', '    - 3', '      - 4', '        - 5', '          - 6'].join('\n'))!
    expect(depthOf(capped)).toBe(MAX_BLOCK_DEPTH)
  })
})

describe('performance', () => {
  const timed = (text: string) => {
    const t0 = performance.now()
    const out = markdownToBlocks(text)
    return { out, ms: performance.now() - t0 }
  }

  it('converts or refuses 500,000 characters well under a second', () => {
    const mixed = ['# Heading *one*', '- item **bold** and `code`', '  - nested [ ] *x*', '1. numbered', '> quote > more', '```', 'code *line*', '```', '', 'para 2 * 3 * 4 snake*case*'].join('\n')
    const cases = [
      mixed.repeat(Math.ceil(500_000 / mixed.length)).slice(0, 500_000),
      // One long line of markers.
      '*a* **b** `c` '.repeat(500_000 / 14).padEnd(500_000, 'x'),
      // Nested pairs that each mark everything before them: quadratic if marked eagerly.
      `${Array.from({ length: 50_000 }, (_, i) => `*${i % 10}`).join(' ')} x${'* y'.repeat(50_000)}`.slice(0, 500_000),
      `${Array.from({ length: 50_000 }, (_, i) => `\`${i % 10}`).join(' ')} x${'` y'.repeat(50_000)}`.slice(0, 500_000),
      // Stars that each look back past many converted pairs.
      `a*${' *b*'.repeat(120_000)}`.slice(0, 500_000),
      // A long run of `>` lines alone, and deep quotes.
      '>\n'.repeat(250_000),
      '> > > > > > > x\n'.repeat(500_000 / 16),
      // Many digits, and a line of spaces before a marker.
      `${'1'.repeat(499_990)}. x`,
      `${' '.repeat(499_990)}- x`,
      // Non-ASCII text, so that characters are found by grapheme.
      '*é🙂* '.repeat(500_000 / 6),
    ]
    for (const text of cases) {
      const { ms } = timed(text)
      expect(ms, text.slice(0, 40)).toBeLessThan(800)
    }
  })

  it('gives the right answer on the nested pairs', () => {
    expect(markdownToBlocks('*1 *2 *3 x* y* z*')).toStrictEqual([p(r('1 2 3 x y z', I))])
    expect(markdownToBlocks('`1 `2 `3 x` y` z`')).toStrictEqual([p('`1 `2 ', r('3 x', C), ' y` z`')])
  })
})

describe('randomised: valid, canonical, characters kept in order, never throws', () => {
  /** Mulberry32: a small seeded generator, so a failure can be replayed. */
  function rng(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  // Words avoid `x` (a checkbox's tick) so that every other letter can be counted; the fence language is in capitals.
  const STARTS = ['', '', '', '# ', '## ', '### ', '#### ', '- ', '-  ', '1. ', '12. ', '0. ', '- [ ] ', '- [x] ', '- [] ', '[ ] ', '[x] ', '> ', '> > ', '>', '  ', '    ', '\t', '  - ', '    - ', '\t- ', '  1. ', '---', '```', '```JS', '- # ', '> - ']
  const PIECES = ['*', '**', '`', ' ', ' ', 'word', 'abc', 'q', '2', '#', '(', '"', '🙂', 'é', 'é', '\t', '-', '>', '[', ']', '\\']
  const ENDS = ['\n', '\n', '\n', '\r\n', '\r', '\n\n']

  const letters = (s: string) => s.replace(/[^a-wyz]/g, '')

  /** True when `small` is a subsequence of `big`. */
  function subsequence(small: string, big: string): boolean {
    let j = 0
    for (let i = 0; i < big.length && j < small.length; i++) if (big[i] === small[j]) j++
    return j === small.length
  }

  it('over a few thousand seeded pastes', () => {
    const next = rng(20261124)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T
    let converted = 0
    for (let n = 0; n < 3000; n++) {
      let text = ''
      const lines = 1 + Math.floor(next() * 8)
      for (let l = 0; l < lines; l++) {
        const start = pick(STARTS)
        let line = start
        // A fence's line keeps only its fixed language (dropped by design): no pieces, and no fence made of pieces.
        const pieces = start.startsWith('```') ? 0 : Math.floor(next() * 10)
        for (let k = 0; k < pieces; k++) line += pick(PIECES)
        if (!start.startsWith('```') && /^[> ]*```/.test(line)) line = line.replace(/`/g, "'")
        text += line
        if (l < lines - 1) text += pick(ENDS)
      }
      let out: BlockNode[] | null = null
      expect(() => (out = markdownToBlocks(text)), JSON.stringify(text)).not.toThrow()
      if (out === null) continue
      converted++
      const blocks = out as BlockNode[]
      expect(parseBlocks(blocks), JSON.stringify(text)).toStrictEqual(blocks)
      const plain = plainTextOf(blocks)
      expect(plain).not.toContain('\r')
      const normal = text.replace(/\r\n|\r/g, '\n')
      expect(subsequence(plain, normal), JSON.stringify(text)).toBe(true)
      expect(letters(plain), JSON.stringify(text)).toBe(letters(normal))
    }
    expect(converted).toBeGreaterThan(1500)
  })
})

describe('randomised: protected spans and blank lines between lists', () => {
  function rng(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('keeps every link, image, tag and table line exactly as written, wherever it sits', () => {
    const next = rng(1124)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T
    const STARTS = ['', '', '# ', '- ', '1. ', '- [ ] ', '> ', '> - ', '  ', '  - ', '\t']
    const PIECES = ['*', '**', '`', ' ', 'word', '#', '(', ')', '[', ']', '!', '"', '🙂', '\\', '-', '>']
    let checked = 0
    for (let n = 0; n < 2000; n++) {
      const payloads: string[] = []
      const lines: string[] = []
      const count = 1 + Math.floor(next() * 6)
      for (let l = 0; l < count; l++) {
        const kind = next()
        if (kind < 0.1) {
          lines.push(pick(['```', '```JS', '']))
          continue
        }
        if (kind < 0.25) {
          const table = `| *T${n}x${l}* | **u** | [*c*](d) |`
          payloads.push(table)
          lines.push(pick(['', '  ', '> ', '\t']) + table)
          continue
        }
        let line = pick(STARTS)
        const pieces = Math.floor(next() * 8)
        for (let k = 0; k < pieces; k++) {
          if (next() < 0.25) {
            const id = `${n}x${l}x${k}`
            // No backtick inside a payload: a code span opened earlier on the line may rightly close on it.
            const payload = pick([`[*P${id}*](u*${id}*)`, `![**P${id}**](i_${id}.png)`, `<b t="*P${id}*" u='**${id}**'>`, `[**P${id}** and *q*](a#*b*)`])
            payloads.push(payload)
            line += ` ${payload}`
          } else line += pick(PIECES)
        }
        if (/^[> ]*```/.test(line)) line = line.replace(/`/g, "'")
        lines.push(line)
      }
      const text = lines.join(pick(['\n', '\r\n']))
      const out = markdownToBlocks(text)
      if (out === null) continue
      expect(parseBlocks(out)).toStrictEqual(out)
      const plain = plainTextOf(out)
      let from = 0
      for (const payload of payloads) {
        const at = plain.indexOf(payload, from)
        expect(at, `${JSON.stringify(payload)} in ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0)
        from = at + payload.length
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1500)
  })

  /** Every empty paragraph in the blocks, at any depth. */
  function emptyParagraphs(blocks: readonly BlockNode[]): number {
    let n = 0
    for (const b of blocks) {
      if (b.type === 'paragraph' && !b.content) n++
      else if (b.type === 'blockquote') n += emptyParagraphs(b.blocks)
      else if (b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'taskList') for (const i of b.items) n += emptyParagraphs(i.blocks)
    }
    return n
  }

  it('drops a blank line only between two items of the same list', () => {
    const next = rng(2026)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T
    const KINDS = [
      ['bullet', '- '],
      ['number', '1. '],
      ['number', '7. '],
      ['task', '- [ ] '],
      ['task', '- [x] '],
      ['task', '[ ] '],
    ] as const
    for (let n = 0; n < 2000; n++) {
      // Lists two levels deep (indent 0 or 2), with runs of blank lines between their lines.
      const lines: string[] = []
      /** The kind of the open list at each level (the model of the rule). */
      const open: Array<string | undefined> = [undefined, undefined]
      /** The indent of the last top-level item: a line two columns further in is one level down. */
      let base = 0
      let expected = 0
      const count = 2 + Math.floor(next() * 8)
      for (let l = 0; l < count; l++) {
        const gap = pick([0, 0, 1, 1, 2])
        for (let g = 0; g < gap; g++) lines.push('')
        const [kind, marker] = pick(KINDS)
        const indent = l > 0 && next() < 0.4 ? 2 : 0
        const listOpen = open[0] !== undefined
        const level = listOpen && indent >= base + 2 ? 1 : 0
        // A blank line is kept unless it is the only one before the next item of a list open at that level.
        if (!(listOpen && gap === 1 && open[level] === kind)) expected += gap
        const ends = !listOpen || gap > 1 || (gap === 1 && level === 0 && open[0] !== kind)
        if (ends || level === 0) {
          // A new list at the top (whatever its indent), or the next top-level item.
          open[0] = kind
          open[1] = undefined
          base = indent
        } else open[1] = kind
        lines.push(`${' '.repeat(indent)}${marker}w${l}`)
      }
      const tail = pick([0, 1, 2])
      for (let g = 0; g < tail; g++) lines.push('')
      expected += tail
      const text = lines.join('\n')
      const out = md(text)!
      expect(emptyParagraphs(out), JSON.stringify(text)).toBe(expected)

    }
  })
})
