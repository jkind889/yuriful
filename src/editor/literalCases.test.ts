import { describe, expect, it } from 'vitest'
import { markdownToBlocks } from '../model/markdownPaste.ts'
import { LITERAL_CASES } from '../model/testing/literalCases.ts'
import { canonicalTextContent } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { BlockNode, InlineRun } from '../model/types.ts'
import { open, type } from './testing/textHarness.ts'

/**
 * The typed rules (`textRules.ts`, driven key by key through the edit session) and the pasted
 * rules (`markdownToBlocks`) side by side: the shared literal cases stay literal both ways, and a
 * single line converts to the same stored record whether it is typed or pasted.
 */

/** The stored content after typing `text` key by key into a new, empty text ("\n" is Enter). */
function typed(text: string): TextContent {
  const s = open({ text: '' })
  type(s, text)
  return s.content()
}

/** The stored content after pasting `text` into a new, empty text through the edit session (its real paste path). */
function sessionPasted(text: string): TextContent {
  const s = open({ text: '' })
  s.paste({ text })
  return s.content()
}

/**
 * What the session's paste stores, in a new empty text, for a paste the converter turns into
 * `expected`: the same, except that when the paste ends with a divider the empty line it was pasted
 * on stays after it for the caret (the wiring's own rule; the converter knows nothing of the caret).
 */
function withCaretLine(expected: TextContent): TextContent {
  if (!expected.blocks) return expected
  const lastIsDivider = (blocks: BlockNode[]): boolean => {
    const last = blocks[blocks.length - 1]
    if (!last) return false
    if (last.type === 'divider') return true
    if (last.type === 'blockquote') return lastIsDivider(last.blocks)
    if (last.type === 'bulletList' || last.type === 'orderedList' || last.type === 'taskList') return lastIsDivider(last.items[last.items.length - 1]!.blocks)
    return false
  }
  return lastIsDivider(expected.blocks) ? canonicalTextContent({ text: '', blocks: [...expected.blocks, { type: 'paragraph' }] })! : expected
}

/** The stored content of a new text holding only the paste of `text`. */
function pasted(text: string): TextContent {
  const blocks = markdownToBlocks(text)
  if (!blocks) return { text }
  const c = canonicalTextContent({ text: '', blocks })
  if (!c) throw new Error(`not storable: ${JSON.stringify(text)}`)
  return c
}

describe('markdown-paste-shares-the-typed-literal-cases', () => {
  it.each(LITERAL_CASES.map((c) => [c.text, c.why]))('%j stays literal typed and pasted (%s)', (text) => {
    expect(typed(text)).toStrictEqual({ text })
    const blocks = markdownToBlocks(text)
    if (blocks !== null) {
      // Allowed by the plan, though this converter returns null: plain paragraphs, the characters untouched.
      expect(blocks.every((b) => b.type === 'paragraph' && (b.content ?? []).every((r) => Object.keys(r).length === 1))).toBe(true)
      expect(canonicalTextContent({ text: '', blocks })).toStrictEqual({ text })
    }
    expect(pasted(text)).toStrictEqual({ text })
    expect(sessionPasted(text)).toStrictEqual({ text })
  })
})

describe('a single line converts the same typed and pasted', () => {
  const SAME = [
    // headings
    '# Title', '## Two', '### Three', '# ', '#  two spaces', '# # again', '## # one after two', '# **not bold** *it*', '# - not a list', '# > not a quote', '# `code`',
    // bullets, numbers, checklists
    '- one', '- ', '-  two spaces', '- - not nested', '- 1. not numbered', '- > not a quote', '- ---', '- ```', '- # heading in an item', '- **b** item *i*',
    '1. first', '7. seventh', '01. leading zero', '999999999. largest', '12. `code` item', '1. [ ] not a task', '1. # heading',
    '- [ ] todo', '- [x] done', '- [X] capital x', '- [] empty box', '- [ ]', '- [ ]  two spaces', '- [ ] # heading in a task', '- [x] [ ] box after box',
    '[ ] bare box', '[] bare empty box',
    // quotes
    '> quote', '> ', '> > nested', '> > > three', '> - in a quote', '> 1. numbered in a quote', '> 3. from three', '> [ ] task in a quote', '> - [x] ticked in a quote', '> # heading in a quote', '> **bold** in a quote',
    // inline
    '**bold** and 2 * 3 * 4', '*it* `code` **b**', 'a `b` c', '**a *b* c**', '*x **y** z*', '`*a*`', '*`a`*', '(*x*) "**y**" [`z`]', '*a**b*', '**x*', '*a*b*', 'say **two words**', '`a` `b`', '`a *b` c*', '*a*é', '*é*', 'a*b* *c*', '*🙂*', '`🙂`', '*🇺🇸*🇬🇧', '[*x*] and *y*',
    // code
    '```',
  ]
  it.each(SAME)('%j', (line) => {
    expect(pasted(line)).toStrictEqual(typed(line))
    expect(sessionPasted(line)).toStrictEqual(withCaretLine(pasted(line)))
  })
})

/** A paragraph of runs: a string is a plain run, a pair is a run and its marks. */
const para = (...runs: Array<string | [string, Partial<InlineRun>]>): BlockNode => ({ type: 'paragraph', content: runs.map((r) => (typeof r === 'string' ? { text: r } : { text: r[0], ...r[1] })) })
const I = { italic: true } as const
const C = { code: true } as const
const bullet = (...items: BlockNode[][]): BlockNode => ({ type: 'bulletList', items: items.map((blocks) => ({ blocks })) })

/**
 * Every place where pasting a line gives something other than typing it key by key, on purpose
 * (plan Section 11 and the rules settled in the review of the converter). Each row states the
 * pasted result (null: the paste is literal) and checks that typing really differs, so a row goes
 * stale loudly if the two rules ever come to agree.
 */
const DECLARED: Array<[string, BlockNode[] | null, string]> = [
  // Lines and fences
  ['---x', null, 'a divider is a line that is exactly `---`; typed, the third `-` converts while the line is still `---`'],
  ['---', [{ type: 'divider' }], 'every pasted line is one block; typed, a divider brings an empty line to type on'],
  ['> ---', [{ type: 'blockquote', blocks: [{ type: 'divider' }] }], 'the same, in a quote'],
  ['```js', [{ type: 'codeBlock', text: '' }], 'pasted, what follows the opening backticks is a language and goes; typed, it is the code'],
  ['  - x', [bullet([para('x')])], 'pasted, leading spaces before a list marker are nesting; typed, the marker must start the line'],
  // P4: one numbered list
  ['1. a\n1. b', [{ type: 'orderedList', items: [{ blocks: [para('a')] }, { blocks: [para('b')] }] }], 'consecutive numbered items are one list; typed, Enter continues the list and the second `1. ` stays as typed'],
  ['3. a\n7. b', [{ type: 'orderedList', start: 3, items: [{ blocks: [para('a')] }, { blocks: [para('b')] }] }], 'numbered from the first item, whatever the later numbers'],
  // P2: code spans first
  ['`echo *demo*`', [para(['echo *demo*', C])], 'nothing converts inside a code span; typed, the stars convert before the closing backtick is typed'],
  ['*a `b* c`', [para('*a ', ['b* c', C])], 'the code span is found first'],
  ['`x `a` y`', [para('`x ', ['a', C], ' y`')], 'code spans are found left to right'],
  // P1: kept as written inside too
  ['[*mix*](u)', null, 'nothing converts inside a link'],
  ['![*cover*](u)', null, 'nothing converts inside an image'],
  ['<b title="*mix*">x</b>', null, 'nothing converts inside an HTML tag'],
  ['| *mix* |', null, 'a table line stays as written'],
  ['*a\\*', null, 'an escaped marker is no marker'],
  ['**a\\*b**', [para(['a\\*b', { bold: true }])], 'an escaped `*` is a character, not the nearest marker'],
  // Paste decides the block before the inline markers; typing re-checks the line after each conversion
  ['*>* x', [para(['>', I], ' x')], 'typed, the italic `>` and the space make a quote'],
  ['*3.* x', [para(['3.', I], ' x')], 'typed, a numbered list'],
  ['*[]* x', [para(['[]', I], ' x')], 'typed, a checklist'],
  ['- *[x]* x', [bullet([para(['[x]', I], ' x')])], 'typed, a ticked checklist item'],
  ['*--*-', [para(['--', I], '-')], 'typed, a divider'],
  ['*#* x', [para(['#', I], ' x')], 'typed, a heading'],
  ['*-* x', [para(['-', I], ' x')], 'typed, a bullet'],
  ['*``*`', [para(['``', I], '`')], 'typed, a code block'],
  // A character that joins the one before it
  ['# \u0301x', null, 'pasted, a combining mark joins the space of `# `, so it is no marker; typed, the space converts before the mark is typed'],
  ['- \u0301x', null, 'the same for a bullet'],
  ['> \u0301x', null, 'for a quote'],
  ['1. \u0301x', null, 'for a numbered item'],
  ['[] \u0301x', null, 'for a checkbox'],
  ['- [ ] \u0301x', [bullet([para('[ ] \u0301x')])], 'for a checkbox after a bullet: the bullet converts, the box stays as written'],
  ['```\u0301x', null, 'for a fence'],
  ['`x`\u0301', null, 'for a closing backtick'],
  ['*a*\u0301', null, 'for a closing `*`'],
  ['- *🇺*🇸', [bullet([para('*🇺*🇸')])], 'removing the stars would join two regional indicators into one flag; typed, they go and the flag is plain'],
]

describe('declared differences from typing', () => {
  it.each(DECLARED)('%j', (text, blocks) => {
    const expected = blocks ? canonicalTextContent({ text: '', blocks }) : { text }
    expect(pasted(text)).toStrictEqual(expected)
    expect(sessionPasted(text)).toStrictEqual(withCaretLine(expected!))
    expect(typed(text)).not.toStrictEqual(expected)
  })
})
