import { FONT_IDS } from '../model/richText.ts'
import { MAX_BLOCK_DEPTH, isListStart } from '../model/textDoc.ts'
import type { BlockNode, FontId, InlineRun } from '../model/types.ts'

/**
 * Pasted HTML read into blocks (plan Section 11, the expanded structural allowlist of Slice 3b).
 *
 * The HTML is parsed in an inert document (`DOMParser`): nothing in it loads, runs or is fetched.
 * Dropped with everything inside them: scripts, styles, frames, objects, media, forms, SVG,
 * MathML, templates and the document head. No attribute is read but the few listed here, so a
 * paste never brings a link target, a size, a colour or (from outside Yuriful) a font:
 * - blocks: `h1`–`h3` (`h4`–`h6` become level 3), `ul`, `ol` (`start`, held to the stored range),
 *   `li`, checklist items (an `li` with `data-checked` or `data-type="taskItem"`, or one that starts
 *   with a checkbox `input`, ticked by `data-checked="true"` or `checked`; a list marked
 *   `data-type="taskList"` or Yuriful's own `ul.yp-tasks`; a checkbox after words is no marker, and a
 *   list of ordinary and checklist items is split where they change), `blockquote`, `pre` (a code
 *   block, character for character), `hr` (a divider), and every other block element (`p`, `div`,
 *   table cells...) as a line; comments are nothing;
 * - inline: bold, italic, underline and strikethrough (also from inline `style`, on any element
 *   around the text, a list included), `code` (inline code; `kbd`, `samp` and the like are only
 *   text), `br` (a line break), links unwrapped to their text, and `data-font` on a `span` when it
 *   names one of `FONT_IDS`, only in Yuriful's own copy (`YURIFUL_COPY`): outside text never brings a font.
 * Lists and quotes nested deeper than storage keeps (`MAX_BLOCK_DEPTH`) stay at the deepest level
 * they can. A heading's text never stores bold. Whitespace: runs of spaces are kept; whitespace
 * that runs across a line break of the HTML source becomes one space; inside `pre` line breaks are
 * line breaks.
 */

/** Removed with everything inside them (also by the line-only reading of HTML, `sanitizePastedHTML`). */
export const DROPPED: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'img', 'picture', 'source', 'video', 'audio', 'track', 'svg', 'math', 'canvas',
  'form', 'template', 'noscript', 'title', 'head', 'button', 'select', 'textarea', 'map', 'area', 'frame', 'frameset', 'applet', 'portal',
])
/** Start and end a line. */
const BLOCKS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'figure', 'figcaption', 'address', 'dl', 'dt', 'dd', 'hr', 'details', 'summary',
])
/** Blocks that only hold other blocks: an empty one is not an empty line. */
const CONTAINERS = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'dl', 'hr'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

type Marks = Omit<InlineRun, 'text'>

/** What a paste of HTML brings. */
export interface PastedHtml {
  /** The blocks, not yet checked against the stored bounds. */
  blocks: BlockNode[]
  /** It is a run of text within one line (one paragraph, or what Yuriful copied from inside one line): it joins the line it is pasted into. */
  inline: boolean
  /** That run came from inside a heading (it arrives bold when it does not stay a heading). */
  fromHeading: boolean
  /**
   * It carries nothing a paste keeps: only paragraphs, with no mark at all (as a code editor puts on the
   * clipboard). Never Yuriful's own copy (`own`): that keeps its characters as they are, so a copied
   * line holding `**x**` comes back as `**x**`.
   */
  plain: boolean
  /** It is Yuriful's own copy (`YURIFUL_COPY`): its fonts are read, each character's as it was shown. */
  own: boolean
  /** Yuriful's own copy across lines whose first (last) edge fell inside a line: that partial line joins the line it is pasted into. */
  openStart: boolean
  openEnd: boolean
}

/**
 * The attribute Yuriful puts on what it copies (`YURIFUL_COPY`, set by the session's clipboard
 * serializer). Only with it is a font read (`data-font`), and only with it is HTML that carries no
 * marks still Yuriful's own text rather than plain text to convert. A page that forges it gains no
 * more than that: a font from `FONT_IDS`, and its words pasted as they are.
 */
export const YURIFUL_COPY = 'data-yuriful'

function marksOf(el: Element, inherited: Marks, fonts: boolean): Marks {
  const m: Marks = { ...inherited }
  const tag = el.localName
  if (tag === 'b' || tag === 'strong') m.bold = true
  if (tag === 'i' || tag === 'em') m.italic = true
  if (tag === 'u') m.underline = true
  if (tag === 's' || tag === 'del' || tag === 'strike') m.strike = true
  if (tag === 'code') m.code = true
  const style = el.getAttribute('style') !== null ? (el as HTMLElement).style : undefined
  if (style) {
    const weight = style.fontWeight
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) m.bold = true
    else if (weight === 'normal' || weight === 'lighter' || (weight !== '' && Number(weight) < 600)) delete m.bold
    if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') m.italic = true
    else if (style.fontStyle === 'normal') delete m.italic
    const deco = `${style.textDecoration} ${style.textDecorationLine}`
    if (deco.includes('underline')) m.underline = true
    if (deco.includes('line-through')) m.strike = true
  }
  const font = fonts && el.localName === 'span' ? el.getAttribute('data-font') : null
  if (font && (FONT_IDS as readonly string[]).includes(font)) m.font = font as FontId
  return m
}

/** The first thing in `node` that shows: an element, or text other than white space (comments and empty spans are nothing). */
function firstShown(node: Node): Node | null {
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === 3) {
      if ((c.nodeValue ?? '').trim() !== '') return c
    } else if (c.nodeType === 1) {
      const el = c as Element
      if (DROPPED.has(el.localName)) continue
      if (el.localName === 'span' && el.textContent === '' && !el.querySelector('input')) continue
      return el
    }
  }
  return null
}

/** Whether an `li` is a checklist item, and its tick: marked as one, or starting with a checkbox (a checkbox after words is not a marker). */
function taskOf(li: Element, inTaskList: boolean): { checked: boolean } | null {
  const data = li.getAttribute('data-checked')
  if (data !== null) return { checked: data === 'true' }
  let first = firstShown(li)
  while (first && first.nodeType === 1 && ['p', 'label', 'span', 'div'].includes((first as Element).localName)) first = firstShown(first)
  const box = first && first.nodeType === 1 && (first as Element).localName === 'input' ? (first as Element) : null
  if (box && box.getAttribute('type')?.toLowerCase() === 'checkbox') return { checked: box.hasAttribute('checked') || box.getAttribute('aria-checked') === 'true' }
  if (li.getAttribute('data-type') === 'taskItem') return { checked: false }
  return inTaskList ? { checked: false } : null
}

/** Reads pasted HTML into blocks (see the module comment). */
export function htmlToBlocks(html: string): PastedHtml {
  const inert = new DOMParser().parseFromString(html, 'text/html')
  // Yuriful's own copy (its marker, not ProseMirror's generic `data-pm-slice`, which other editors write too).
  const ownMarker = inert.body.querySelector(`[${YURIFUL_COPY}]`)
  const own = ownMarker !== null
  const edges = (ownMarker?.getAttribute(YURIFUL_COPY) ?? '').split(' ')
  let fromHeading = false

  /** A list of blocks being filled, with the depth its blocks are at (top level 1). */
  interface Level {
    out: BlockNode[]
    depth: number
    /** The line being written into, or null between lines. */
    line: { runs: InlineRun[]; heading: 1 | 2 | 3 | null } | null
  }
  const close = (lv: Level) => {
    lv.line = null
  }
  const ensureLine = (lv: Level) => {
    if (!lv.line) {
      lv.line = { runs: [], heading: null }
      lv.out.push({ type: 'paragraph', content: lv.line.runs })
    }
    return lv.line
  }
  const push = (lv: Level, runs: InlineRun[], text: string, marks: Marks) => {
    if (!text) return
    const run: InlineRun = { text, ...marks }
    if (lv.line?.heading) delete run.bold // a heading never stores bold
    runs.push(run)
  }

  /** `para`: inside a block that holds text, where spaces are content. */
  const walk = (node: Node, lv: Level, marks: Marks, pre: boolean, para: boolean) => {
    const blocksInside = Array.from(node.childNodes).some((c) => c.nodeType === 1 && BLOCKS.has((c as Element).localName))
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const raw = child.nodeValue ?? ''
        if (pre) {
          raw.split('\n').forEach((part, i) => {
            if (i > 0) close(lv)
            if (part) push(lv, ensureLine(lv).runs, part, marks)
            else if (i > 0) ensureLine(lv)
          })
          return
        }
        if (lv.line === null && /^[ \t\n\r\f]*$/.test(raw) && (!para || blocksInside || /[\r\n]/.test(raw))) return
        push(lv, ensureLine(lv).runs, raw.replace(/[ \t\f]*[\r\n][ \t\n\r\f]*/g, ' '), marks)
        return
      }
      if (child.nodeType !== 1) return
      const el = child as Element
      const tag = el.localName
      if (DROPPED.has(tag)) return
      if (tag === 'input') return // a checkbox is read with its list item
      if (tag === 'br') {
        ensureLine(lv)
        close(lv)
        return
      }
      if (HEADINGS.has(tag)) {
        close(lv)
        const level = Math.min(3, Number(tag[1])) as 1 | 2 | 3
        const runs: InlineRun[] = []
        lv.out.push({ type: 'heading', level, content: runs })
        lv.line = { runs, heading: level }
        walk(el, lv, marksOf(el, marks, own), pre, true)
        close(lv)
        return
      }
      if (tag === 'hr') {
        close(lv)
        lv.out.push({ type: 'divider' })
        return
      }
      if (tag === 'pre') {
        close(lv)
        let text = ''
        const read = (n: Node) =>
          n.childNodes.forEach((c) => {
            if (c.nodeType === 3) text += c.nodeValue ?? ''
            else if (c.nodeType === 1 && !DROPPED.has((c as Element).localName)) {
              if ((c as Element).localName === 'br') text += '\n'
              else read(c)
            }
          })
        read(el)
        lv.out.push({ type: 'codeBlock', text: text.replace(/\r\n?/g, '\n') })
        return
      }
      const room = lv.depth < MAX_BLOCK_DEPTH
      if ((tag === 'ul' || tag === 'ol') && room) {
        close(lv)
        const taskList = el.classList.contains('yp-tasks') || el.getAttribute('data-type') === 'taskList'
        // Marks set on the list itself (`<ul style="font-style: italic">`) apply to the text inside it.
        const listMarks = marksOf(el, marks, own)
        const items: Array<{ blocks: BlockNode[]; checked: boolean | null }> = []
        el.childNodes.forEach((c) => {
          if (c.nodeType !== 1 && c.nodeType !== 3) return // a comment between items is nothing
          if (c.nodeType === 1 && DROPPED.has((c as Element).localName)) return
          const li = c.nodeType === 1 && (c as Element).localName === 'li' ? (c as Element) : null
          if (!li && (c.nodeType !== 1 || !BLOCKS.has((c as Element).localName)) && !(c.textContent ?? '').trim()) return
          const inner: Level = { out: [], depth: lv.depth + 1, line: null }
          const task = li ? taskOf(li, taskList) : null
          if (li) walk(li, inner, marksOf(li, listMarks, own), false, true)
          else walk({ childNodes: [c] } as unknown as Node, inner, listMarks, false, true)
          close(inner)
          items.push({ blocks: inner.out.length > 0 ? inner.out : [{ type: 'paragraph' }], checked: task ? task.checked : null })
        })
        if (items.length === 0) return
        // Ordinary items stay ordinary: where they and checklist items change, the list is split, in order.
        const start = Number(el.getAttribute('start') ?? '1')
        let at = 0
        while (at < items.length) {
          const tasks = items[at]!.checked !== null
          let end = at
          while (end < items.length && (items[end]!.checked !== null) === tasks) end++
          const run = items.slice(at, end)
          if (tasks) lv.out.push({ type: 'taskList', items: run.map((it) => ({ checked: it.checked === true, blocks: it.blocks })) })
          else if (tag === 'ol') {
            const first = start + at
            lv.out.push({ type: 'orderedList', ...(isListStart(first) && first !== 1 ? { start: first } : {}), items: run.map((it) => ({ blocks: it.blocks })) })
          } else lv.out.push({ type: 'bulletList', items: run.map((it) => ({ blocks: it.blocks })) })
          at = end
        }
        return
      }
      if (tag === 'blockquote' && room) {
        close(lv)
        const inner: Level = { out: [], depth: lv.depth + 1, line: null }
        walk(el, inner, marksOf(el, marks, own), false, true)
        lv.out.push({ type: 'blockquote', blocks: inner.out.length > 0 ? inner.out : [{ type: 'paragraph' }] })
        return
      }
      const block = BLOCKS.has(tag)
      const before = lv.out.length
      if (block) close(lv)
      walk(el, lv, marksOf(el, marks, own), pre, block ? !CONTAINERS.has(tag) : para)
      if (block && !CONTAINERS.has(tag) && lv.out.length === before) lv.out.push({ type: 'paragraph' }) // an empty block is an empty line
      if (block) close(lv)
    })
  }

  const top: Level = { out: [], depth: 1, line: null }
  walk(inert.body, top, {}, false, false)
  const blocks = top.out.map(clean)

  // What Yuriful copied from inside one line: ProseMirror marks the slice open at both ends. It pastes
  // as words, a code line's too (as plain words: a code block's text has no marks, and inline code is
  // a mark of its own that the copy never had); a selection spanning code lines stays a code block.
  const slice = /^(\d+) (\d+)/.exec(inert.body.querySelector('[data-pm-slice]')?.getAttribute('data-pm-slice') ?? '')
  const lines = leaves(blocks)
  let inline = false
  const oneCodeLine = (b: BlockNode | undefined) => b?.type === 'codeBlock' && !b.text.includes('\n')
  if (blocks.length === 1 && blocks[0]!.type === 'paragraph') inline = true
  else if (slice && Number(slice[1]) > 0 && Number(slice[2]) > 0 && lines.length === 1 && (lines[0]!.type !== 'codeBlock' || oneCodeLine(lines[0])) && leafCount(blocks) === 1) {
    inline = true
    fromHeading = lines[0]!.type === 'heading'
  }
  const plain = !own && blocks.every((b) => b.type === 'paragraph' && (b.content ?? []).every((r) => Object.keys(r).length === 1))
  return { blocks, inline, fromHeading, plain, own, openStart: own && edges.includes('open-start'), openEnd: own && edges.includes('open-end') }
}

/** Empty runs and empty content arrays go (a paragraph with no text has no `content`). */
function clean(b: BlockNode): BlockNode {
  switch (b.type) {
    case 'paragraph':
    case 'heading': {
      const content = (b.content ?? []).filter((r) => r.text !== '')
      if (b.type === 'heading') return content.length > 0 ? { type: 'heading', level: b.level, content } : { type: 'heading', level: b.level }
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
    }
    case 'bulletList':
    case 'orderedList':
      return { ...b, items: b.items.map((it) => ({ blocks: it.blocks.map(clean) })) }
    case 'taskList':
      return { type: 'taskList', items: b.items.map((it) => ({ checked: it.checked, blocks: it.blocks.map(clean) })) }
    case 'blockquote':
      return { type: 'blockquote', blocks: b.blocks.map(clean) }
    default:
      return b
  }
}

/** The lines (paragraphs, headings, code blocks) of blocks, in order. */
function leaves(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.flatMap((b): BlockNode[] => {
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'codeBlock') return [b]
    if (b.type === 'blockquote') return leaves(b.blocks)
    if (b.type === 'divider') return []
    return b.items.flatMap((it) => leaves(it.blocks))
  })
}

/** Lines and dividers of blocks. */
function leafCount(blocks: readonly BlockNode[]): number {
  return blocks.reduce((n, b) => {
    if (b.type === 'blockquote') return n + leafCount(b.blocks)
    if (b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'taskList') return n + b.items.reduce((m, it) => m + leafCount(it.blocks), 0)
    return n + 1
  }, 0)
}
