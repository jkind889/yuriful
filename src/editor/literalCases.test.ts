import { describe, expect, it } from 'vitest'
import { markdownToBlocks } from '../model/markdownPaste.ts'
import { LITERAL_CASES } from '../model/testing/literalCases.ts'
import { canonicalTextContent } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
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
    '**bold** and 2 * 3 * 4', '*it* `code` **b**', 'a `b` c', '**a *b* c**', '*x **y** z*', '`*a*`', '*`a`*', '(*x*) "**y**" [`z`]', '*a**b*', '**x*', '*a*b*', 'say **two words**', '`a` `b`', '`x `a` y`', '*a `b* c`', '`a *b` c*', '*a*é', '*é*', 'a*b* *c*', '*🙂*', '`🙂`',
    // code
    '```',
  ]
  it.each(SAME)('%j', (line) => {
    expect(pasted(line)).toStrictEqual(typed(line))
  })

  it('differs where the plan settled the pasted rule: `---x`, a language after the fence, and the line a divider leaves', () => {
    // Typed, the third `-` converts while the line is still `---`; pasted, a divider is a line that is exactly `---`.
    expect(pasted('---x')).toStrictEqual({ text: '---x' })
    expect(typed('---x').blocks).toStrictEqual([{ type: 'divider' }, { type: 'paragraph', content: [{ text: 'x' }] }])
    // Typed, what follows the third backtick is the code; pasted, it is the fence's language and goes.
    expect(typed('```js').blocks).toStrictEqual([{ type: 'codeBlock', text: 'js' }])
    expect(pasted('```js').blocks).toStrictEqual([{ type: 'codeBlock', text: '' }])
    // Typed, a divider brings an empty line to go on typing in; pasted, every line is one block.
    expect(typed('---').blocks).toStrictEqual([{ type: 'divider' }, { type: 'paragraph' }])
    expect(pasted('---').blocks).toStrictEqual([{ type: 'divider' }])
    expect(typed('> ---').blocks).toStrictEqual([{ type: 'blockquote', blocks: [{ type: 'divider' }, { type: 'paragraph' }] }])
    expect(pasted('> ---').blocks).toStrictEqual([{ type: 'blockquote', blocks: [{ type: 'divider' }] }])
  })

  it('differs for an indented list line, which a paste reads as a list and typing leaves as typed', () => {
    expect(typed('  - x')).toStrictEqual({ text: '  - x' })
    expect(pasted('  - x').blocks).toStrictEqual([{ type: 'bulletList', items: [{ blocks: [{ type: 'paragraph', content: [{ text: 'x' }] }] }] }])
  })
})
