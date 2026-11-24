/**
 * The review round on pasting (Y1 to Y8, and the rulings that came with it): undo after a paste,
 * where the halves of a split line go, Yuriful's own copy coming back as it was, inline code at the
 * caret, a cancelled composition at a caret, lists of ordinary and checklist items, the literal
 * fallback, and the sanitizer's smaller cases. Each case is the reviewer's input, with the outcome the
 * rule asks for.
 */
import { describe, expect, it } from 'vitest'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { MAX_TEXT_LENGTH, canonicalTextContent, parseBlocks } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { BlockNode, InlineRun } from '../model/types.ts'
import type { EditSession } from './textSession.ts'
import { htmlToBlocks } from './pasteHtml.ts'
import { textblocksOf } from './textSchema.ts'
import { insert, open, press, type } from './testing/textHarness.ts'

const p = (text?: string, extra: Partial<InlineRun> = {}): BlockNode => (text ? { type: 'paragraph', content: [{ text, ...extra }] } : { type: 'paragraph' })
const h = (level: 1 | 2 | 3, text: string): BlockNode => ({ type: 'heading', level, content: [{ text }] })
const bullets = (...items: BlockNode[][]): BlockNode => ({ type: 'bulletList', items: items.map((blocks) => ({ blocks })) })
const numbered = (start: number, ...items: BlockNode[][]): BlockNode => ({ type: 'orderedList', ...(start !== 1 ? { start } : {}), items: items.map((blocks) => ({ blocks })) })
const tasks = (...items: Array<[boolean, BlockNode[]]>): BlockNode => ({ type: 'taskList', items: items.map(([checked, blocks]) => ({ checked, blocks })) })
const quote = (...blocks: BlockNode[]): BlockNode => ({ type: 'blockquote', blocks })
const code = (text: string): BlockNode => ({ type: 'codeBlock', text })
const hr: BlockNode = { type: 'divider' }

/** The content, checked to be what a load gives back. */
function stored(s: EditSession): TextContent {
  const c = s.content()
  expect(canonicalTextContent(c as unknown as Record<string, unknown>)).toStrictEqual(c)
  if (c.blocks) expect(parseBlocks(c.blocks)).not.toBeNull()
  return c
}
const rec = (blocks: BlockNode[]): TextContent => canonicalTextContent({ text: '', blocks } as unknown as Record<string, unknown>) as TextContent

/** What Yuriful puts on the clipboard for the document positions [from, to) of a text holding `blocks`. */
function copyRange(blocks: BlockNode[], from: number, to: number): { html: string; text: string } {
  const s = open({ text: '', blocks })
  const el = document.body.appendChild(document.createElement('div'))
  s.mount(el)
  s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, from, to)))
  const clip = s.view!.serializeForClipboard(s.state.selection.content())
  s.finish()
  el.remove()
  return { html: clip.dom.innerHTML, text: clip.text }
}
/** The same for the UTF-16 range [a, b) of its plain text. */
function copyText(blocks: BlockNode[], a: number, b: number): { html: string; text: string } {
  const s = open({ text: '', blocks })
  const el = document.body.appendChild(document.createElement('div'))
  s.mount(el)
  s.select(a, b)
  const clip = s.view!.serializeForClipboard(s.state.selection.content())
  s.finish()
  el.remove()
  return { html: clip.dom.innerHTML, text: clip.text }
}

describe('Y1: every paste is its own undo step, closed off from what came before and after it', () => {
  it('typing straight before a converted paste: the first undo gives the literal paste, the second the text as typed', () => {
    const s = open({ text: '' })
    type(s, 'A')
    s.paste({ text: '**B**' })
    expect(stored(s).text).toBe('AB')
    s.undo()
    expect(stored(s)).toStrictEqual({ text: 'A**B**' })
    s.undo()
    expect(stored(s)).toStrictEqual({ text: 'A' })
  })

  it('two structural HTML pastes one after the other are two steps; typing straight after a paste is its own step', () => {
    const s = open({ text: '' })
    s.paste({ html: '<code>A</code>', text: 'A' })
    s.paste({ html: '<code>B</code>', text: 'B' })
    s.undo()
    expect(stored(s).text).toBe('A')
    const t = open({ text: '' })
    t.paste({ html: '<code>A</code>', text: 'A' })
    type(t, 'B')
    t.undo()
    expect(stored(t).text).toBe('A')
  })

  it('a plain paste between typing, and a composition straight after a paste: each is its own step', () => {
    const s = open({ text: '' })
    type(s, 'a')
    s.paste({ text: 'b' })
    type(s, 'c')
    s.undo()
    expect(stored(s).text).toBe('ab')
    s.undo()
    expect(stored(s).text).toBe('a')
    const t = open({ text: '', blocks: [quote(p('x'))] }, { caret: 1 })
    t.paste({ text: 'y' })
    t.compositionStart()
    insert(t, 'か', true)
    t.compositionEnd()
    t.undo()
    expect(stored(t).text).toBe('xy')
  })
})

describe('Y2: where a paste lands, the two halves of the split line', () => {
  it("the reviewer's cases: a heading's half after the caret stays a heading; a ticked item's is a new unticked item, which takes the item's later paragraph with it", () => {
    const heading = open({ text: '', blocks: [h(2, 'AB')] }, { caret: 1 })
    heading.paste({ html: '<blockquote>Q</blockquote><p>last</p>', text: 'Q\nlast' })
    expect(stored(heading).blocks).toStrictEqual([h(2, 'A'), quote(p('Q')), h(2, 'lastB')])
    const ticked = open({ text: '', blocks: [tasks([true, [p('AB')]], [true, [p('Z')]])] }, { caret: 1 })
    ticked.paste({ html: '<blockquote>Q</blockquote><p>last</p>', text: 'Q\nlast' })
    expect(stored(ticked).blocks).toStrictEqual([tasks([true, [p('A'), quote(p('Q'))]], [false, [p('lastB')]], [true, [p('Z')]])])
    const note = open({ text: '', blocks: [tasks([true, [p('AB'), p('note')]], [false, [p('end')]])] }, { caret: 1 })
    note.paste({ html: '<h2>H</h2>', text: 'H' })
    expect(stored(note).blocks).toStrictEqual([tasks([true, [p('A'), h(2, 'H')]], [false, [p('B'), p('note')]], [false, [p('end')]])])
  })

  it('a ticked item holding a second paragraph and a nested list: pasted tasks join the list, and the rest of the item stays with its continuation, a new unticked item; a pasted heading stays inside the item', () => {
    const album = () => [tasks([true, [p('Album'), p('Notes'), bullets([p('Voices')])]])]
    const mid = open({ text: '', blocks: album() }, { caret: 2 })
    mid.paste({ text: '- [ ] One\n- [x] Two' })
    expect(stored(mid).blocks).toStrictEqual([tasks([true, [p('Al')]], [false, [p('One')]], [true, [p('Two')]], [false, [p('bum'), p('Notes'), bullets([p('Voices')])]])])
    const end = open({ text: '', blocks: album() }, { caret: 5 })
    end.paste({ text: '- [ ] One\n- [x] Two' })
    expect(stored(end).blocks).toStrictEqual([tasks([true, [p('Album')]], [false, [p('One')]], [true, [p('Two')]], [false, [p('Notes'), bullets([p('Voices')])]])])
    const heading = open({ text: '', blocks: album() }, { caret: 5 })
    heading.paste({ html: '<h2>H</h2>', text: 'H' })
    expect(stored(heading).blocks).toStrictEqual([tasks([true, [p('Album'), h(2, 'H'), p('Notes'), bullets([p('Voices')])]])])
  })

  it('every kind of line, every kind of first and last pasted block: nothing that was not at the caret changes kind, item or tick', () => {
    // The caret line is "AB", the caret after "A"; "pre", "post" and "note" are not at the caret.
    const lines: Array<[string, BlockNode[]]> = [
      ['paragraph', [p('pre'), p('AB'), p('post')]],
      ['heading', [p('pre'), h(2, 'AB'), p('post')]],
      ['bullet item with a second paragraph', [bullets([p('pre')], [p('AB'), p('note')], [p('post')])]],
      ['numbered item with a second paragraph', [numbered(5, [p('pre')], [p('AB'), p('note')], [p('post')])]],
      ['ticked item with a second paragraph', [tasks([false, [p('pre')]], [true, [p('AB'), p('note')]], [true, [p('post')]])]],
      ['heading in a ticked item', [tasks([true, [h(2, 'AB'), p('note')]], [false, [p('post')]])]],
      ['quote', [quote(p('pre'), p('AB'), p('post'))]],
    ]
    const kinds: Record<string, string> = {
      paragraph: '<p>pp</p>',
      heading: '<h2>hh</h2>',
      bullets: '<ul><li>uu</li></ul>',
      numbered: '<ol start="4"><li>oo</li></ol>',
      checklist: '<ul><li data-checked="true">tt</li></ul>',
      quote: '<blockquote><p>qq</p></blockquote>',
      code: '<pre>cc</pre>',
      divider: '<hr>',
    }
    /** Each line of a document: its text, kind, and the containers around it (outermost first), each with where it starts and an item's tick. */
    const describeLines = (doc: PMNode) =>
      textblocksOf(doc).map(({ node, pos }) => {
        const $p = doc.resolve(pos + 1)
        const around: Array<{ kind: string; at: number; checked?: boolean }> = []
        for (let d = 1; d < $p.depth; d++) {
          const n = $p.node(d)
          around.push({ kind: n.type.name, at: $p.before(d), ...(n.type.name === 'taskItem' ? { checked: n.attrs.checked === true } : {}) })
        }
        return { text: node.textContent, kind: node.type.name + (node.type.name === 'heading' ? String(node.attrs.level) : ''), around }
      })
    const shape = (around: Array<{ kind: string; checked?: boolean }>) => around.map((a) => `${a.kind}${a.checked === undefined ? '' : a.checked ? '+' : '-'}`).join('>')
    const failures: string[] = []
    let cases = 0
    for (const [lineName, blocks] of lines) {
      for (const [firstName, first] of Object.entries(kinds)) {
        for (const [lastName, last] of Object.entries(kinds)) {
          // (Two plain paragraphs carry nothing but text: a plain paste, which keeps its earlier behaviour.)
          if (firstName === 'paragraph' && lastName === 'paragraph') continue
          const s = open({ text: '', blocks })
          const was = describeLines(s.state.doc)
          const caretLine = was.find((l) => l.text === 'AB')!
          const at = textblocksOf(s.state.doc).find(({ node }) => node.textContent === 'AB')!.pos + 2
          s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, at)))
          s.paste({ html: first + last, text: 'x' })
          cases++
          const now = describeLines(s.state.doc)
          const where = `${lineName}, pasted ${firstName} then ${lastName}`
          const one = (pred: (l: (typeof now)[number]) => boolean, what: string) => {
            const found = now.filter(pred)
            if (found.length !== 1) failures.push(`${where}: ${found.length} lines hold ${what}`)
            return found[0]
          }
          // Lines not at the caret keep their kind and the shape of what is around them (ticks included).
          for (const l of was.filter((x) => x.text === 'pre' || x.text === 'post')) {
            const n = one((x) => x.text === l.text, l.text)
            if (n && (n.kind !== l.kind || shape(n.around) !== shape(l.around))) failures.push(`${where}: "${l.text}" became ${n.kind} in ${shape(n.around)} (was ${l.kind} in ${shape(l.around)})`)
          }
          const headLine = one((x) => x.text.includes('A'), 'A')
          const tailLine = one((x) => x.text.includes('B'), 'B')
          if (!headLine || !tailLine) continue
          // Both halves keep the caret line's kind; the half before the caret keeps its item and tick.
          if (headLine.kind !== caretLine.kind || shape(headLine.around) !== shape(caretLine.around)) failures.push(`${where}: the half before the caret is ${headLine.kind} in ${shape(headLine.around)}`)
          if (tailLine.kind !== caretLine.kind) failures.push(`${where}: the half after the caret is ${tailLine.kind}, not ${caretLine.kind}`)
          if (tailLine.around.map((a) => a.kind).join('>') !== caretLine.around.map((a) => a.kind).join('>')) failures.push(`${where}: the half after the caret is in ${shape(tailLine.around)}`)
          // In a list: the half after the caret is a new unticked item of the same list, and the item's later paragraph goes with it.
          const itemDepth = caretLine.around.map((a) => a.kind).lastIndexOf(caretLine.around.find((a) => a.kind.endsWith('Item'))?.kind ?? '-')
          if (itemDepth >= 0) {
            const headItem = headLine.around[itemDepth]
            const tailItem = tailLine.around[itemDepth]
            if (!tailItem || !headItem || tailItem.at === headItem.at) failures.push(`${where}: the half after the caret is not a new item`)
            else if (tailItem.checked === true) failures.push(`${where}: the new item is ticked`)
            if (headLine.around[itemDepth - 1]?.at !== tailLine.around[itemDepth - 1]?.at) failures.push(`${where}: the half after the caret left the list`)
            const noteLine = was.find((x) => x.text === 'note') ? one((x) => x.text === 'note', 'note') : undefined
            if (noteLine && noteLine.around[itemDepth]?.at !== tailItem?.at) failures.push(`${where}: "note" is not in the item of the half after the caret`)
          } else if (caretLine.around.length > 0 && headLine.around[0]?.at !== tailLine.around[0]?.at) failures.push(`${where}: the two halves are not in the same quote`)
        }
      }
    }
    expect(failures.slice(0, 10), failures[0]).toEqual([])
    expect(cases).toBe(7 * 63)
  })
})

describe('Y3: Yuriful\'s own copy comes back as it was', () => {
  it("the reviewer's cases: a numbered list inside a quote keeps the quote; items 8 and 9 come back as 8 and 9; code keeps its last line break", () => {
    const inQuote = [quote(numbered(7, [p('one')], [p('two')], [p('three')]))]
    const a = open({ text: '' })
    a.paste(copyText(inQuote, 0, 13))
    expect(stored(a).blocks).toStrictEqual(inQuote)
    const b = open({ text: '' })
    b.paste(copyText([numbered(7, [p('one')], [p('two')], [p('three')])], 4, 13))
    expect(stored(b).blocks).toStrictEqual([numbered(8, [p('two')], [p('three')])])
    const withCode = [p('start'), code('track\n'), p('end')]
    const c = open({ text: '' })
    c.paste(copyText(withCode, 0, 1000))
    expect(stored(c).blocks).toStrictEqual(withCode)
  })

  it('a copy from within one line, the whole line included, stays inline text (text leaving a heading arrives bold); across two lines the quote comes too', () => {
    const src = [quote(p('quoted words'), p('more'))]
    const inside = open({ text: 'ab' }, { caret: 1 })
    inside.paste(copyText(src, 2, 6))
    expect(stored(inside)).toStrictEqual({ text: 'aotedb' })
    const whole = open({ text: '' })
    whole.paste(copyText(src, 0, 12))
    expect(stored(whole)).toStrictEqual({ text: 'quoted words' })
    const heading = open({ text: 'ab' }, { caret: 2 })
    heading.paste(copyText([h(2, 'Big')], 0, 3))
    expect(stored(heading)).toStrictEqual({ text: 'abBig', spans: [{ start: 2, end: 5, bold: true }] })
    const across = open({ text: '' })
    across.paste(copyText(src, 0, 17))
    expect(stored(across).blocks).toStrictEqual(src)
  })

  it('for a text holding every block, every selection of whole lines pastes into an empty text as exactly the copied blocks (one line as its words)', () => {
    const every: BlockNode[] = [
      h(2, 'Head'),
      { type: 'paragraph', content: [{ text: 'b', bold: true }, { text: 'i', italic: true }, { text: 'u', underline: true }, { text: 's', strike: true }, { text: 'c', code: true }, { text: 'f', font: 'serif' }] },
      bullets([p('a'), bullets([p('n')])], [p('a2')]),
      numbered(7, [p('one')], [p('two')], [p('three')]),
      quote(numbered(7, [p('q1')], [p('q2')], [p('q3')])),
      tasks([true, [p('done'), p('note')]], [false, [p('todo')]]),
      quote(p('q')),
      code('let\ta\n  b\n'),
      hr,
      p('end'),
    ]
    /** The blocks of lines i to j (whole), with what is around them and the dividers between them: what a copy of them is. */
    const copied = (blocks: BlockNode[], i: number, j: number): BlockNode[] => {
      let line = 0
      const walk = (list: BlockNode[]): BlockNode[] => {
        const out: BlockNode[] = []
        for (const b of list) {
          if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'codeBlock') {
            if (line >= i && line <= j) out.push(b)
            line++
          } else if (b.type === 'divider') {
            if (line > i && line <= j) out.push(b)
          } else if (b.type === 'blockquote') {
            const inner = walk(b.blocks)
            if (inner.length > 0) out.push({ type: 'blockquote', blocks: inner })
          } else if (b.type === 'taskList') {
            const items = b.items.map((it) => ({ checked: it.checked, blocks: walk(it.blocks) })).filter((it) => it.blocks.length > 0)
            if (items.length > 0) out.push({ type: 'taskList', items })
          } else {
            const kept = b.items.map((it, n) => ({ n, blocks: walk(it.blocks) })).filter((it) => it.blocks.length > 0)
            if (kept.length === 0) continue
            if (b.type === 'bulletList') out.push({ type: 'bulletList', items: kept.map((it) => ({ blocks: it.blocks })) })
            else {
              const start = (b.start ?? 1) + kept[0]!.n
              out.push({ type: 'orderedList', ...(start !== 1 ? { start } : {}), items: kept.map((it) => ({ blocks: it.blocks })) })
            }
          }
        }
        return out
      }
      return walk(blocks)
    }
    const endsWithDivider = (blocks: BlockNode[]): boolean => {
      const last = blocks[blocks.length - 1]
      if (!last) return false
      if (last.type === 'divider') return true
      if (last.type === 'blockquote') return endsWithDivider(last.blocks)
      if (last.type === 'bulletList' || last.type === 'orderedList' || last.type === 'taskList') return endsWithDivider(last.items[last.items.length - 1]!.blocks)
      return false
    }
    const doc = open({ text: '', blocks: every }).state.doc
    const lines = textblocksOf(doc)
    const failures: string[] = []
    for (let i = 0; i < lines.length; i++) {
      for (let j = i; j < lines.length; j++) {
        const clip = copyRange(every, lines[i]!.pos + 1, lines[j]!.pos + 1 + lines[j]!.node.content.size)
        const s = open({ text: '' })
        s.paste(clip)
        // One line is a copy from within a line: its words (a heading's arrive bold), or its code.
        const line = lines[i]!.node
        const words = (): BlockNode[] => {
          const runs: InlineRun[] = []
          line.forEach((n) => {
            const run: InlineRun = { text: n.text ?? '' }
            for (const m of n.marks) {
              if (m.type.name === 'font') run.font = m.attrs.font as InlineRun['font']
              else (run as unknown as Record<string, boolean>)[m.type.name] = true
            }
            if (line.type.name === 'heading') run.bold = true
            runs.push(run)
          })
          return [runs.length > 0 ? { type: 'paragraph', content: runs } : { type: 'paragraph' }]
        }
        const want = i === j ? (line.type.name === 'codeBlock' ? [code(line.textContent)] : words()) : copied(every, i, j)
        // (A paste ending with a divider keeps the empty line it was pasted on, after it.)
        const expected = rec(endsWithDivider(want) ? [...want, { type: 'paragraph' }] : want)
        const got = stored(s)
        if (JSON.stringify(got) !== JSON.stringify(expected)) failures.push(`lines ${i} to ${j}: ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`)
      }
    }
    expect(failures.slice(0, 5), failures[0]).toEqual([])
  })
})

describe('Y4: inline code chosen at the caret means a literal paste, whatever is on the clipboard', () => {
  it('HTML with a heading beside plain text "# Title": the plain text goes in as code', () => {
    const s = open({ text: '' })
    s.toggleMark('code')
    s.paste({ text: '# Title', html: '<h2>Title</h2>' })
    expect(stored(s)).toStrictEqual(rec([{ type: 'paragraph', content: [{ text: '# Title', code: true }] }]))
  })

  it('a literal-mode paste with HTML only, at a code-block caret, pastes nothing, as the mounted view does', () => {
    const s = open({ text: '', blocks: [code('x')] }, { caret: 1 })
    expect(s.paste({ plain: true, html: '<h2>HTML</h2>', text: '' })).toBe(false)
    expect(stored(s).blocks).toStrictEqual([code('x')])
  })
})

describe('Y5: a cancelled composition leaves no undo step', () => {
  it('a candidate cancelled at a plain caret inside a quote: the text and the caret come back, and there is nothing to undo', () => {
    const s = open({ text: '', blocks: [quote(p('Album'))] }, { caret: 2 })
    const before = s.content()
    const selection = s.state.selection.toJSON()
    s.compositionStart()
    insert(s, 'ka', true)
    const end = s.state.selection.head
    s.dispatch(s.state.tr.delete(end - 2, end))
    s.compositionEnd()
    expect(s.content()).toStrictEqual(before)
    expect(s.state.selection.toJSON()).toStrictEqual(selection)
    expect(s.canUndo).toBe(false)
  })
})

describe('Y6: lists mixing ordinary items and checklist items; where a checkbox counts', () => {
  it('a list with an ordinary item and a ticked item is split where the kind changes, in order', () => {
    expect(htmlToBlocks('<ul><li>album</li><li><input type="checkbox" checked>listen</li></ul>').blocks).toStrictEqual([bullets([p('album')]), tasks([true, [p('listen')]])])
    expect(htmlToBlocks('<ol start="3"><li>a</li><li><input type="checkbox">b</li><li>c</li></ol>').blocks).toStrictEqual([numbered(3, [p('a')]), tasks([false, [p('b')]]), numbered(5, [p('c')])])
  })

  it('a checkbox after words is no marker: the item stays an ordinary item', () => {
    const s = open({ text: '' })
    s.paste({ html: '<ul><li>Lyrics <input type="checkbox" checked> verified</li></ul>', text: 'Lyrics verified' })
    expect(stored(s).blocks).toStrictEqual([bullets([p('Lyrics  verified')])])
  })
})

describe('Y7: the fallback of a paste that does not fit is literal', () => {
  it('a bullet holding "# Title" pasted under five quotes does not fit: "# Title" goes in as it is, never as a heading', () => {
    let wrap = '<p>old</p>'
    for (let d = 0; d < 5; d++) wrap = `<blockquote>${wrap}</blockquote>`
    const s = open({ text: '' })
    s.paste({ html: wrap, text: 'old' })
    s.paste({ html: '<ul><li># Title</li></ul>', text: '# Title' })
    const c = stored(s)
    expect(c.text).toBe('old# Title')
    expect(JSON.stringify(c.blocks)).not.toContain('heading')
  })
})

describe('Y8: the sanitizer', () => {
  it('only `code` is inline code: `kbd`, `samp`, `tt` and `var` are their text', () => {
    for (const tag of ['kbd', 'samp', 'tt', 'var']) {
      const s = open({ text: '' })
      s.paste({ html: `<p>Use <${tag}>Tab</${tag}></p>`, text: 'Use Tab' })
      expect(stored(s)).toStrictEqual({ text: 'Use Tab' })
    }
  })

  it('a comment between two items is nothing', () => {
    expect(htmlToBlocks('<ol start="7"><li>A</li><!-- end A --><li>B</li></ol>').blocks).toStrictEqual([numbered(7, [p('A')], [p('B')])])
  })

  it('a mark set on a list, or on an element around it, applies to the text inside it', () => {
    expect(htmlToBlocks('<ul style="font-style:italic"><li>A</li></ul>').blocks).toStrictEqual([bullets([p('A', { italic: true })])])
    expect(htmlToBlocks('<em><ul><li>A</li></ul></em>').blocks).toStrictEqual([bullets([p('A', { italic: true })])])
    expect(htmlToBlocks('<blockquote style="font-weight:bold"><p>q</p></blockquote>').blocks).toStrictEqual([quote(p('q', { bold: true }))])
  })
})

describe('rulings that came with the review (pinned, no change)', () => {
  it('two separate numbered lists pasted into a numbered list join it as one run of items (joining the caret\'s list comes first)', () => {
    const s = open({ text: '', blocks: [numbered(3, [p('A')], [p('Z')])] }, { caret: 1 })
    s.paste({ html: '<ol start="20"><li>X</li></ol><ol start="30"><li>Y</li></ol>', text: 'X\nY' })
    expect(stored(s).blocks).toStrictEqual([numbered(3, [p('A')], [p('X')], [p('Y')], [p('Z')])])
  })

  it('a converted paste whose literal first step would not fit inserts nothing, although the converted result would', () => {
    const s = open({ text: '', blocks: [quote(p('a'.repeat(MAX_TEXT_LENGTH - 1)))] })
    s.select(MAX_TEXT_LENGTH - 1, MAX_TEXT_LENGTH - 1)
    const before = s.content()
    s.paste({ text: '**B**' })
    expect(s.content()).toStrictEqual(before)
  })
})

describe('Z1: a copy made in Yuriful keeps the font each character was shown in', () => {
  /** What a copy of all of a text in a box of font `font` puts on the clipboard. */
  const copyAll = (font: 'sans' | 'serif', blocks: BlockNode[]) => {
    const s = open({ text: '', font, blocks })
    const el = document.body.appendChild(document.createElement('div'))
    s.mount(el)
    s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, 1, s.state.doc.content.size - 1)))
    const clip = s.view!.serializeForClipboard(s.state.selection.content())
    s.finish()
    el.remove()
    return { html: clip.dom.innerHTML, text: clip.text }
  }
  const twoLines = (first: InlineRun[], second: InlineRun[]): BlockNode[] => [{ type: 'paragraph', content: first }, { type: 'paragraph', content: second }]

  it('from a Serif box into a Sans box: the ordinary text stays Serif, the Handwritten range stays Handwritten', () => {
    const clip = copyAll('serif', twoLines([{ text: 'plain ' }, { text: 'hand', font: 'hand' }], [{ text: 'more' }]))
    const s = open({ text: '', font: 'sans' })
    s.paste(clip)
    expect(stored(s)).toStrictEqual(rec(twoLines([{ text: 'plain ', font: 'serif' }, { text: 'hand', font: 'hand' }], [{ text: 'more', font: 'serif' }])))
  })

  it('from a Sans box into a Serif box: the ordinary text stays Sans, and Serif text, now the box\'s own font, needs no font of its own', () => {
    const clip = copyAll('sans', twoLines([{ text: 'plain ' }, { text: 'serif', font: 'serif' }], [{ text: 'more' }]))
    const s = open({ text: '', font: 'serif' })
    s.paste(clip)
    expect(stored(s)).toStrictEqual({ font: 'serif', text: 'plain serif\nmore', spans: [{ start: 0, end: 6, font: 'sans' }, { start: 12, end: 16, font: 'sans' }] })
  })

  it('into a box of the same font nothing gains a font, and words from inside one line keep theirs too', () => {
    const blocks = twoLines([{ text: 'plain ' }, { text: 'hand', font: 'hand' }], [{ text: 'more' }])
    const same = open({ text: '', font: 'serif' })
    same.paste(copyAll('serif', blocks))
    expect(stored(same)).toStrictEqual({ font: 'serif', text: 'plain hand\nmore', spans: [{ start: 6, end: 10, font: 'hand' }] })
    const from = open({ text: '', font: 'serif', blocks })
    const el = document.body.appendChild(document.createElement('div'))
    from.mount(el)
    from.select(2, 9)
    const clip = from.view!.serializeForClipboard(from.state.selection.content())
    from.finish()
    el.remove()
    const into = open({ text: 'ab', font: 'sans' }, { caret: 1 })
    into.paste({ html: clip.dom.innerHTML, text: clip.text })
    expect(stored(into)).toStrictEqual({ text: 'aain hanb', spans: [{ start: 1, end: 5, font: 'serif' }, { start: 5, end: 8, font: 'hand' }] })
  })
})

describe('Z1: the place does not restyle it', () => {
  it('plain words copied from a Sans box, pasted inside a Mono range of a Sans box, stay in Sans: their font as shown, not the font of the place', () => {
    const from = open({ text: '', blocks: [p('xy and'), p('zw')] })
    const el = document.body.appendChild(document.createElement('div'))
    from.mount(el)
    from.select(0, 2)
    const clip = from.view!.serializeForClipboard(from.state.selection.content())
    from.finish()
    el.remove()
    const into = open({ text: 'ab', spans: [{ start: 0, end: 2, font: 'mono' }] }, { caret: 1 })
    into.paste({ html: clip.dom.innerHTML, text: clip.text })
    expect(stored(into)).toStrictEqual({ text: 'axyb', spans: [{ start: 0, end: 1, font: 'mono' }, { start: 3, end: 4, font: 'mono' }] })
  })
})

describe('Z2: Yuriful recognises its own copy by its own marker', () => {
  it('what Yuriful copies carries the marker', () => {
    expect(copyText([p('one'), p('two')], 0, 7).html).toContain('data-yuriful')
    expect(copyText([p('one')], 0, 2).html).toContain('data-yuriful')
  })

  it('unformatted Markdown copied from another ProseMirror editor (its generic marker only) is converted', () => {
    const s = open({ text: '' })
    s.paste({ html: '<p data-pm-slice="1 1 []">**bright**</p>', text: '**bright**' })
    expect(stored(s)).toStrictEqual(rec([{ type: 'paragraph', content: [{ text: 'bright', bold: true }] }]))
  })

  it('an outside page with a `data-font` span brings no font', () => {
    const s = open({ text: '' })
    s.paste({ html: '<p>a <span data-font="mono">b</span></p>', text: 'a b' })
    expect(stored(s)).toStrictEqual({ text: 'a b' })
  })
})

describe('Z3: Shift+Left and Shift+Right with a clicked divider selected extend from it', () => {
  const withDivider = (blocks: BlockNode[]) => {
    const s = open({ text: '', blocks })
    let at = -1
    s.state.doc.descendants((n, pos) => {
      if (at < 0 && n.type.name === 'divider') at = pos
      return at < 0
    })
    s.dispatch(s.state.tr.setSelection(NodeSelection.create(s.state.doc, at)))
    return s
  }
  it('from the line before it to the line after it, either way; with no line on one side, from just past it', () => {
    const right = withDivider([p('Album'), hr, p('Cover')])
    press(right, 'ArrowRight', { shiftKey: true })
    expect(right.selection()).toMatchObject({ anchor: 5, head: 6 })
    expect(right.state.selection).toBeInstanceOf(TextSelection)
    const left = withDivider([p('Album'), hr, p('Cover')])
    press(left, 'ArrowLeft', { shiftKey: true })
    expect(left.selection()).toMatchObject({ anchor: 6, head: 5 })
    const first = withDivider([hr, p('Cover')])
    press(first, 'ArrowRight', { shiftKey: true })
    expect(first.selection()).toMatchObject({ anchor: 0, head: 1 })
    const last = withDivider([p('Album'), hr])
    press(last, 'ArrowRight', { shiftKey: true })
    expect(last.state.selection).toBeInstanceOf(NodeSelection)
  })
})
