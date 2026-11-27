import { afterEach, describe, expect, it } from 'vitest'
import { canonicalTextContent, MAX_BLOCK_DEPTH, MAX_TEXT_LENGTH, parseBlocks } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { BlockNode, InlineRun } from '../model/types.ts'
import type { EditSession } from './textSession.ts'
import { htmlToBlocks } from './pasteHtml.ts'
import { insert, open, press, type } from './testing/textHarness.ts'

/**
 * Paste (plan Section 11, Slice 3b): HTML read through the expanded structural allowlist, plain
 * text through the Markdown converter (two in-edit undo steps), Ctrl/Cmd+Shift+V literal, where the
 * pasted blocks land, the formatting they take, the bounds, and Yuriful's own copy coming back.
 */

const p = (text?: string, extra: Partial<InlineRun> = {}): BlockNode => (text ? { type: 'paragraph', content: [{ text, ...extra }] } : { type: 'paragraph' })
const h = (level: 1 | 2 | 3, text: string): BlockNode => ({ type: 'heading', level, content: [{ text }] })
const bullets = (...items: BlockNode[][]): BlockNode => ({ type: 'bulletList', items: items.map((blocks) => ({ blocks })) })
const numbered = (start: number, ...items: BlockNode[][]): BlockNode => ({ type: 'orderedList', ...(start !== 1 ? { start } : {}), items: items.map((blocks) => ({ blocks })) })
const tasks = (...items: Array<[boolean, BlockNode[]]>): BlockNode => ({ type: 'taskList', items: items.map(([checked, blocks]) => ({ checked, blocks })) })
const quote = (...blocks: BlockNode[]): BlockNode => ({ type: 'blockquote', blocks })
const code = (text: string): BlockNode => ({ type: 'codeBlock', text })
const hr: BlockNode = { type: 'divider' }

/** The content, checked to be what a load gives back (valid, canonical, within bounds). */
function stored(s: EditSession): TextContent {
  const c = s.content()
  expect(canonicalTextContent(c as unknown as Record<string, unknown>)).toStrictEqual(c)
  if (c.blocks) expect(parseBlocks(c.blocks)).not.toBeNull()
  return c
}

/** What a paste of `html` into an empty text stores. */
function pastedHtml(html: string, text = ''): TextContent {
  const s = open({ text: '' })
  s.paste({ html, text })
  return stored(s)
}

/** The stored record of a text holding exactly these blocks. */
const rec = (blocks: BlockNode[]): TextContent => canonicalTextContent({ text: '', blocks } as unknown as Record<string, unknown>) as TextContent

const w = window as unknown as Record<string, unknown>
afterEach(() => {
  delete w.__hit
})

describe('the sanitizer: what pasted HTML brings', () => {
  it('every allowed block: headings (h4 to h6 as level 3), lists with their start, checklists, quotes, code, dividers', () => {
    expect(pastedHtml('<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h6>Six</h6>')).toStrictEqual(rec([h(1, 'One'), h(2, 'Two'), h(3, 'Three'), h(3, 'Four'), h(3, 'Six')]))
    expect(pastedHtml('<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol start="7"><li>x</li></ol>')).toStrictEqual(rec([bullets([p('a')], [p('b'), bullets([p('c')])]), numbered(7, [p('x')])]))
    expect(pastedHtml('<ol start="0"><li>x</li></ol><ol start="1000000000"><li>y</li></ol><ol start="abc"><li>z</li></ol>')).toStrictEqual(rec([numbered(1, [p('x')]), numbered(1, [p('y')]), numbered(1, [p('z')])]))
    expect(pastedHtml('<ul data-type="taskList"><li data-type="taskItem" data-checked="true">done</li><li data-checked="false">todo</li></ul>')).toStrictEqual(rec([tasks([true, [p('done')]], [false, [p('todo')]])]))
    expect(pastedHtml('<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked disabled> done</li><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>')).toStrictEqual(rec([tasks([true, [p(' done')]], [false, [p(' todo')]])]))
    expect(pastedHtml('<blockquote><p>q</p><blockquote><p>qq</p></blockquote></blockquote>')).toStrictEqual(rec([quote(p('q'), quote(p('qq')))]))
    expect(pastedHtml('<pre><code>let a = 1\n  b()\n</code></pre><hr><p>x</p>')).toStrictEqual(rec([code('let a = 1\n  b()\n'), hr, p('x')]))
  })

  it('marks: bold, italic, underline, strikethrough and inline code, also from inline styles; links become their text; a heading stores no bold', () => {
    expect(pastedHtml('<p><b>b</b><strong>B</strong> <i>i</i><em>I</em> <u>u</u> <s>s</s><del>d</del><strike>k</strike> <code>c</code> <a href="https://x.example/">link</a> <span style="font-weight:700;font-style:italic;text-decoration:underline line-through">all</span></p><h2><b>Head</b></h2>')).toStrictEqual(rec([
      { type: 'paragraph', content: [{ text: 'bB', bold: true }, { text: ' ' }, { text: 'iI', italic: true }, { text: ' ' }, { text: 'u', underline: true }, { text: ' ' }, { text: 'sdk', strike: true }, { text: ' ' }, { text: 'c', code: true }, { text: ' link ' }, { text: 'all', bold: true, italic: true, underline: true, strike: true }] },
      h(2, 'Head'),
    ]))
  })

  it('never a size, a colour, a font from outside, a link target or an image; `data-font` only in Yuriful\'s own copy, and only when it names a font', () => {
    const page = '<p><span style="font-family:serif;color:blue;font-size:30px;background:url(https://x.example/a.png)">a</span><span data-font="mono">b</span><span data-font="evil">c</span><img src="https://x.example/i.png" alt="pic"></p>'
    // Outside text (no marker of Yuriful's own): never a font, `data-font` included.
    expect(pastedHtml('<h1 style="font-size:60px;color:red;font-family:Comic Sans">T</h1>' + page)).toStrictEqual(rec([h(1, 'T'), { type: 'paragraph', content: [{ text: 'abc' }] }]))
    // Yuriful's own copy: its fonts, when they name one.
    expect(pastedHtml('<h1 data-yuriful="">T</h1>' + page)).toStrictEqual(rec([h(1, 'T'), { type: 'paragraph', content: [{ text: 'a' }, { text: 'b', font: 'mono' }, { text: 'c' }] }]))
  })

  it('a page that forges the marker gains nothing but a font from the list and its words pasted as they are', () => {
    const forged = pastedHtml('<p data-yuriful=""><span data-font="hand">**bold** and</span></p><p>- item</p>', '**bold** and\n- item')
    expect(forged).toStrictEqual(rec([{ type: 'paragraph', content: [{ text: '**bold** and', font: 'hand' }] }, p('- item')]))
    // The same page without the marker: no font, and its Markdown is converted (HTML that carries nothing).
    expect(pastedHtml('<p><span data-font="hand">**bold** and</span></p><p>- item</p>', '**bold** and\n- item')).toStrictEqual(rec([{ type: 'paragraph', content: [{ text: 'bold', bold: true }, { text: ' and' }] }, bullets([p('item')])]))
  })

  it('dropped with everything inside them: scripts, styles, frames, objects, media, forms, SVG, MathML, templates, noscript, the head; nothing runs or loads', () => {
    const html = '<head><title>t</title><link rel="stylesheet" href="https://x.example/s.css"><meta http-equiv="refresh" content="0"></head><body><script>window.__hit = 1</script><style>@import url(https://x.example/i.css); p { color: red }</style><iframe src="https://x.example/"></iframe><object data="x"></object><embed src="x"><video src="v"></video><audio src="a"></audio><picture><source srcset="s"></picture><canvas></canvas><form><input value="secret"><button>b</button></form><svg><text>svg</text><script>window.__hit = 2</script></svg><math><mi>x</mi></math><template><p>tpl</p></template><noscript><p>ns</p></noscript><p onclick="window.__hit = 3" style="background:url(javascript:alert(1))">kept</p><img src=x onerror="window.__hit = 4"><a href="javascript:alert(1)">js</a> <a href="data:text/html,<script>1</script>">data</a><!-- a comment --></body>'
    expect(pastedHtml(html)).toStrictEqual(rec([p('kept'), p('js data')]))
    expect(w.__hit).toBeUndefined()
    expect(document.querySelector('img, script, iframe')).toBeNull()
  })

  it('hostile HTML: unclosed tags, entities, lists nested 20 deep held to the depth bound, 20,000 items and a 2 MB string fall back to the literal paste', () => {
    expect(pastedHtml('<p>a <b>b<i>c</p><p>d &amp; &lt;e&gt; &nbsp;f')).toStrictEqual(rec([{ type: 'paragraph', content: [{ text: 'a ' }, { text: 'b', bold: true }, { text: 'c', bold: true, italic: true }] }, { type: 'paragraph', content: [{ text: 'd & <e>  f', bold: true, italic: true }] }])) // an unclosed bold and italic go on, as a browser shows them
    const deep = `${'<ul><li>x'.repeat(20)}${'</li></ul>'.repeat(20)}`
    const read = htmlToBlocks(deep)
    expect(parseBlocks(read.blocks)).not.toBeNull()
    const depthOf = (bs: BlockNode[]): number => Math.max(1, ...bs.map((b) => ('items' in b ? 1 + depthOf(b.items.flatMap((i) => i.blocks)) : 'blocks' in b ? 1 + depthOf(b.blocks) : 1)))
    expect(depthOf(read.blocks)).toBeLessThanOrEqual(MAX_BLOCK_DEPTH)
    const many = `<ul>${'<li>i</li>'.repeat(20000)}</ul>`
    const s = open({ text: '' })
    s.paste({ html: many, text: '' })
    expect(stored(s).blocks).toBeUndefined() // over the node bound: the literal lines
    expect(stored(s).text.split('\n')).toHaveLength(20000)
    const big = `<h1>${'x'.repeat(2_000_000)}</h1>`
    const t = open({ text: '', blocks: [p('a'), hr] }) // a text with blocks has the character bound
    t.paste({ html: big, text: '' })
    expect(stored(t).text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH)
  })

  it('Word, Google Docs, Notion, GitHub and VS Code clipboard HTML', () => {
    const word = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment--><h1 style="mso-style-name:x">Review<o:p></o:p></h1><p class=MsoNormal><b><span style="font-size:14.0pt;font-family:Calibri">Bold</span></b> plain<o:p></o:p></p><p class=MsoListParagraphCxSpFirst style="mso-list:l0 level1 lfo1"><![if !supportLists]><span style="mso-list:Ignore">·<span style="font:7.0pt">&nbsp;&nbsp;</span></span><![endif]>Item<o:p></o:p></p><!--EndFragment--></body></html>'
    expect(pastedHtml(word)).toStrictEqual(rec([h(1, 'Review'), { type: 'paragraph', content: [{ text: 'Bold', bold: true }, { text: ' plain' }] }, p('·  Item')]))
    const docs = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><h2 dir="ltr"><span style="font-size:16pt;font-weight:400">Title</span></h2><ul><li dir="ltr"><p dir="ltr"><span style="font-weight:700">one</span></p></li><li><p><span style="font-style:italic">two</span></p></li></ul></b>'
    expect(pastedHtml(docs)).toStrictEqual(rec([h(2, 'Title'), bullets([p('one', { bold: true })], [p('two', { italic: true })])]))
    const notion = '<h3>Notes</h3><ul><li>a</li></ul><blockquote>quoted</blockquote><pre><code class="language-js">x()</code></pre><hr><ol start="3"><li>c</li></ol>'
    expect(pastedHtml(notion)).toStrictEqual(rec([h(3, 'Notes'), bullets([p('a')]), quote(p('quoted')), code('x()'), hr, numbered(3, [p('c')])]))
    const github = '<h2 dir="auto">Install</h2><div class="highlight"><pre><span class="pl-c1">npm</span> i</pre></div><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled="" checked=""> tests</li></ul>'
    expect(pastedHtml(github)).toStrictEqual(rec([h(2, 'Install'), code('npm i'), tasks([true, [p(' tests')]])]))
    // A code editor's copy of a Markdown file: lines in colour spans only, nothing kept: its plain text, converted.
    const vscode = '<div style="color:#d4d4d4;background-color:#1e1e1e;font-family:Consolas"><div><span style="color:#569cd6;"># </span><span>Title</span></div><div><span style="color:#6796e6;">- </span><span>item</span></div></div>'
    expect(pastedHtml(vscode, '# Title\n- item')).toStrictEqual(rec([h(1, 'Title'), bullets([p('item')])]))
  })

  it('HTML with no words at all is pasted as before, whatever the plain text beside it (U1)', () => {
    for (const html of ['<p></p>', '<p><br></p>']) {
      const s = open({ text: 'AB\nCD\nEF', headings: [2, 0, 1] })
      s.select(3, 6)
      s.paste({ html, text: 'x' })
      expect(s.selection().head).toBe(2)
      expect(stored(s).text).toBe('AB\nEF')
    }
  })
})

describe('whose formatting a paste gets: a clipboard that carried HTML never takes the marks around the caret (X1)', () => {
  // Pasted into the middle of the bold Serif word "abcd".
  const boldWord = () => open({ text: 'abcd', spans: [{ start: 0, end: 4, bold: true, font: 'serif' }] }, { caret: 2 })
  const around = (middle: InlineRun[]) => rec([{ type: 'paragraph', content: [{ text: 'ab', bold: true, font: 'serif' }, ...middle, { text: 'cd', bold: true, font: 'serif' }] }])
  const web = '<p><span style="color: rgb(32, 33, 36); font-family: Arial; font-size: 16px; font-weight: 400">xy</span></p>'
  const editor = '<div style="color:#d4d4d4;background-color:#1e1e1e;font-family:Consolas"><div><span>plain </span><span style="color:#ce9178;">*it*</span></div></div>'

  it('an unformatted web paragraph arrives plain, in the font of the place; the same words as plain text only arrive bold, as before', () => {
    const html = boldWord()
    html.paste({ html: web, text: 'xy' })
    expect(stored(html)).toStrictEqual(around([{ text: 'xy', font: 'serif' }]))
    const plain = boldWord()
    plain.paste({ text: 'xy' })
    expect(stored(plain)).toStrictEqual(around([{ text: 'xy', bold: true, font: 'serif' }]))
  })

  it('Markdown copied as a code editor\'s HTML converts with only its own marks; the first undo gives back its literal text, also plain', () => {
    const s = boldWord()
    s.paste({ html: editor, text: 'plain *it*' })
    expect(stored(s)).toStrictEqual(around([{ text: 'plain ', font: 'serif' }, { text: 'it', italic: true, font: 'serif' }]))
    s.undo()
    expect(stored(s)).toStrictEqual(around([{ text: 'plain *it*', font: 'serif' }]))
    s.undo()
    expect(stored(s)).toStrictEqual(around([]))
  })

  it('plain-text Markdown that converts keeps only its own marks too (the Markdown said what is bold); its literal step is the plain paste of before', () => {
    const s = boldWord()
    s.paste({ text: 'plain *it*' })
    expect(stored(s)).toStrictEqual(around([{ text: 'plain ', font: 'serif' }, { text: 'it', italic: true, font: 'serif' }]))
    s.undo()
    expect(stored(s)).toStrictEqual(around([{ text: 'plain *it*', bold: true, font: 'serif' }]))
  })

  it('a mark chosen at the caret applies to a clipboard that carried HTML; the marks around it still do not', () => {
    const s = boldWord()
    s.toggleMark('underline')
    s.paste({ html: web, text: 'xy' })
    expect(stored(s)).toStrictEqual(around([{ text: 'xy', underline: true, font: 'serif' }]))
  })
})

describe('plain text: converted Markdown, literal Ctrl/Cmd+Shift+V, the contexts that never convert', () => {
  it('a converted paste is two undo steps: the literal lines, then the conversion; redo brings each back', () => {
    const s = open({ text: '' })
    s.paste({ text: '# Title\n\n- one\n- [x] two\n> quote\n**bold** and 2 * 3 * 4' })
    expect(stored(s).blocks).toStrictEqual([h(1, 'Title'), p(), bullets([p('one')]), tasks([true, [p('two')]]), quote(p('quote')), { type: 'paragraph', content: [{ text: 'bold', bold: true }, { text: ' and 2 * 3 * 4' }] }])
    s.undo()
    expect(stored(s)).toStrictEqual({ text: '# Title\n\n- one\n- [x] two\n> quote\n**bold** and 2 * 3 * 4' })
    s.undo()
    expect(stored(s)).toStrictEqual({ text: '' })
    s.redo()
    s.redo()
    expect(stored(s).blocks?.[0]).toStrictEqual(h(1, 'Title'))
  })

  it('Ctrl/Cmd+Shift+V, a caret in a code block, inline code pending, and plain text with no marker stay literal; a drop never converts', () => {
    const lit = open({ text: 'x' }, { caret: 1 })
    lit.paste({ text: '# a\n- b', plain: true })
    expect(stored(lit)).toStrictEqual({ text: 'x# a\n- b' })
    const inCode = open({ text: '', blocks: [code('ab')] }, { caret: 1 })
    inCode.paste({ text: '# a', html: '<h1>a</h1>' })
    expect(stored(inCode).blocks).toStrictEqual([code('a# ab')])
    const pending = open({ text: 'x' }, { caret: 1 })
    pending.toggleMark('code')
    pending.paste({ text: '**b**' })
    expect(stored(pending).blocks).toStrictEqual([{ type: 'paragraph', content: [{ text: 'x' }, { text: '**b**', code: true }] }])
    const prose = open({ text: 'x' }, { caret: 1 })
    prose.paste({ text: 'just words, 2 * 3' })
    expect(stored(prose)).toStrictEqual({ text: 'xjust words, 2 * 3' })
    const drop = open({ text: 'ab' })
    drop.drop(drop.plainTextSlice('# c'), 1)
    expect(stored(drop)).toStrictEqual({ text: 'a# cb' })
  })

  it('a paste never arms the Backspace revert: Backspace after it deletes a character', () => {
    const s = open({ text: '' })
    s.paste({ text: '**b**' })
    expect(s.canRevertShortcut).toBe(false)
    press(s, 'Backspace')
    expect(stored(s).text).toBe('')
  })

  it('pending marks apply to converted text; a composition straight after a paste lands after it', () => {
    const s = open({ text: 'x' }, { caret: 1 })
    s.toggleMark('italic')
    s.paste({ text: '**b** c' })
    expect(stored(s)).toStrictEqual(rec([{ type: 'paragraph', content: [{ text: 'x' }, { text: 'b', bold: true, italic: true }, { text: ' c', italic: true }] }]))
    s.compositionStart()
    insert(s, 'か', true)
    s.compositionEnd()
    expect(stored(s).text).toBe('xb cか')
  })

  it('at the bounds: a conversion over a bound stays the literal paste; a literal paste over it changes nothing', () => {
    const near = 'x'.repeat(MAX_TEXT_LENGTH - 10)
    const s = open({ text: '', blocks: [code(near), p()] })
    s.select(near.length + 1)
    s.paste({ text: '# abc' })
    expect(stored(s).text).toBe(`${near}\nabc`)
    const t = open({ text: '', blocks: [code(near), p()] })
    t.select(near.length + 1)
    t.paste({ text: '- 12345678' }) // literal 10 characters fit; the conversion leaves 8
    expect(stored(t).blocks?.[1]).toStrictEqual(bullets([p('12345678')]))
    const u = open({ text: '', blocks: [code(near), p()] })
    u.select(near.length + 1)
    u.paste({ text: '# '.repeat(20) })
    expect(stored(u).text).toBe(`${near}\n`)
  })
})

describe('where a paste lands', () => {
  const at = (src: Parameters<typeof open>[0], caret: number, text: string) => {
    const s = open(src, { caret })
    s.paste({ text })
    return { blocks: stored(s).blocks ?? stored(s).text, caret: s.selection().head }
  }
  it('one paragraph or a run of text joins the caret\'s line', () => {
    expect(at({ text: 'abcd' }, 2, '**b** text')).toStrictEqual({ blocks: 'abb textcd', caret: 8 })
  })

  it('a first block that is not a paragraph, mid-line: the line is split around the paste and keeps its kind', () => {
    expect(at({ text: 'abcd', headings: [2] }, 2, '- one\n- two')).toStrictEqual({ blocks: [h(2, 'ab'), bullets([p('one')], [p('two')]), h(2, 'cd')], caret: 10 })
    expect(at({ text: 'abcd' }, 2, '# T')).toStrictEqual({ blocks: 'ab\nT\ncd', caret: 4 })
  })

  it('at the start of a line no empty line is left before the paste; on an empty line the blocks take its place', () => {
    expect(at({ text: 'abcd' }, 0, '> q')).toStrictEqual({ blocks: [quote(p('q')), p('abcd')], caret: 1 })
    expect(at({ text: 'x\n\ny' }, 2, '```\ncode\n```')).toStrictEqual({ blocks: [p('x'), code('code'), p('y')], caret: 6 })
  })

  it('a first paragraph joins the text before the caret, a last one the text after it', () => {
    expect(at({ text: 'abcd' }, 2, 'intro\n- one')).toStrictEqual({ blocks: [p('abintro'), bullets([p('one')]), p('cd')], caret: 11 })
    expect(at({ text: 'abcd' }, 2, '- one\nend')).toStrictEqual({ blocks: [p('ab'), bullets([p('one')]), p('endcd')], caret: 10 })
    expect(at({ text: 'abcd' }, 2, 'intro\n- one\nend')).toStrictEqual({ blocks: [p('abintro'), bullets([p('one')]), p('endcd')], caret: 15 })
  })

  it('in a list item: items of the same kind join the list (numbered on), another kind nests in the item; in a quote a quote joins it', () => {
    expect(at({ text: '', blocks: [numbered(1, [p('abcd')], [p('z')])] }, 4, '1. one\n2. two')).toStrictEqual({ blocks: [numbered(1, [p('abcd')], [p('one')], [p('two')], [p('z')])], caret: 12 })
    expect(at({ text: '', blocks: [bullets([p('abcd')], [p('z')])] }, 2, '- one\n- two').blocks).toStrictEqual([bullets([p('ab')], [p('one')], [p('two')], [p('cd')], [p('z')])])
    expect(at({ text: '', blocks: [bullets([p('abcd')])] }, 4, '1. one').blocks).toStrictEqual([bullets([p('abcd'), numbered(1, [p('one')])])])
    expect(at({ text: '', blocks: [quote(p('abcd'))] }, 2, '> q').blocks).toStrictEqual([quote(p('ab'), p('q'), p('cd'))])
  })

  it('a divider: no empty line after it, unless it ends the text or was pasted on an empty line (which stays after it); two lists the paste keeps apart stay apart', () => {
    expect(at({ text: 'abcd' }, 2, '---')).toStrictEqual({ blocks: [p('ab'), hr, p('cd')], caret: 3 })
    expect(at({ text: 'abcd' }, 4, '---')).toStrictEqual({ blocks: [p('abcd'), hr, p()], caret: 5 })
    expect(at({ text: 'x\n\ny' }, 2, '---')).toStrictEqual({ blocks: [p('x'), hr, p(), p('y')], caret: 2 })
    expect(at({ text: '' }, 0, '- a\n\n\n- b').blocks).toStrictEqual([bullets([p('a')]), p(), p(), bullets([p('b')])])
  })

  it('over a selection: the joined line is the line the selection started on (here a ticked item, the pasted heading going inside it); nothing unselected changes', () => {
    const s = open({ text: '', blocks: [tasks([true, [p('Album')]], [false, [p('Cover')]]), p('Tail', { italic: true })] })
    s.select(2, 8)
    s.paste({ text: '# T' })
    expect(stored(s).blocks).toStrictEqual([tasks([true, [p('Al'), h(1, 'T')]], [false, [p('ver')]]), p('Tail', { italic: true })])
  })
})

describe('copying out: Yuriful\'s own copy comes back as the same blocks', () => {
  it('a selection holding every block, copied from one text and pasted into another, gives the same blocks; its plain text is one line per line', () => {
    const blocks: BlockNode[] = [h(2, 'Head'), { type: 'paragraph', content: [{ text: 'b', bold: true }, { text: 'i', italic: true }, { text: 'u', underline: true }, { text: 's', strike: true }, { text: 'c', code: true }, { text: 'f', font: 'serif' }] }, bullets([p('a'), bullets([p('n')])]), numbered(7, [p('x')]), tasks([true, [p('done')]], [false, [p('todo')]]), quote(p('q')), code('let a'), hr, p('end')]
    const el = document.createElement('div')
    document.body.appendChild(el)
    const from = open({ text: '', blocks })
    from.mount(el)
    from.select(0, from.content().text.length)
    const copy = from.view!.serializeForClipboard(from.state.selection.content())
    expect(copy.text).toBe(from.content().text)
    const to = open({ text: '' })
    to.paste({ html: copy.dom.innerHTML, text: copy.text })
    expect(stored(to).blocks).toStrictEqual(blocks)
    from.finish()
    el.remove()
  })

  it('a run copied from inside one heading pasted into a body line arrives inline and bold, keeping its font', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const from = open({ text: '', blocks: [{ type: 'heading', level: 1, content: [{ text: 'Head', font: 'mono' }] }] })
    from.mount(el)
    from.select(1, 3)
    const copy = from.view!.serializeForClipboard(from.state.selection.content())
    const to = open({ text: 'ab' }, { caret: 1 })
    to.paste({ html: copy.dom.innerHTML, text: copy.text })
    expect(stored(to)).toStrictEqual({ text: 'aeab', spans: [{ start: 1, end: 3, bold: true, font: 'mono' }] })
    from.finish()
    el.remove()
  })

  it('a copied line holding Markdown markers comes back as it was, and plain words copied beside bold text stay plain', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const copyOf = (src: Parameters<typeof open>[0], a: number, b: number) => {
      const from = open(src)
      from.mount(el)
      from.select(a, b)
      const copy = from.view!.serializeForClipboard(from.state.selection.content())
      from.finish()
      return { html: copy.dom.innerHTML, text: copy.text }
    }
    // Not converted: a Yuriful copy is never "HTML that carries nothing", even with no marks at all.
    const markers = open({ text: '' })
    markers.paste(copyOf({ text: '**x** and\n- item' }, 0, 16))
    expect(stored(markers)).toStrictEqual({ text: '**x** and\n- item' })
    markers.undo() // one step: nothing was converted
    expect(stored(markers)).toStrictEqual({ text: '' })
    // Its own formatting (none), not the place's: "go" pasted after a bold word stays plain.
    const beside = open({ text: 'go bOd', spans: [{ start: 3, end: 6, bold: true }] }, { caret: 6 })
    beside.paste(copyOf({ text: 'go bOd', spans: [{ start: 3, end: 6, bold: true }] }, 0, 2))
    expect(stored(beside)).toStrictEqual({ text: 'go bOdgo', spans: [{ start: 3, end: 6, bold: true }] })
    el.remove()
  })
})

describe('typed after a paste', () => {
  it('typing straight after a converted paste is its own step', () => {
    const s = open({ text: '' })
    s.paste({ text: '- a' })
    type(s, 'b')
    s.undo()
    expect(stored(s).blocks).toStrictEqual([bullets([p('a')])])
  })
})
