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
 *   `data-type="taskList"` or Yuriful's own `ul.yp-tasks`), `blockquote`, `pre` (a code block),
 *   `hr` (a divider), and every other block element (`p`, `div`, table cells...) as a line;
 * - inline: bold, italic, underline and strikethrough (also from inline `style`), `code` (inline
 *   code), `br` (a line break), links unwrapped to their text, and `data-font` on a `span` when it
 *   names one of `FONT_IDS` (what Yuriful itself puts on the clipboard).
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
   * clipboard). Never a ProseMirror copy (`data-pm-slice`), Yuriful's own: that keeps its characters as
   * they are, so a copied line holding `**x**` comes back as `**x**`.
   */
  plain: boolean
}

function marksOf(el: Element, inherited: Marks): Marks {
  const m: Marks = { ...inherited }
  const tag = el.localName
  if (tag === 'b' || tag === 'strong') m.bold = true
  if (tag === 'i' || tag === 'em') m.italic = true
  if (tag === 'u') m.underline = true
  if (tag === 's' || tag === 'del' || tag === 'strike') m.strike = true
  if (tag === 'code' || tag === 'kbd' || tag === 'samp') m.code = true
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
  const font = el.localName === 'span' ? el.getAttribute('data-font') : null
  if (font && (FONT_IDS as readonly string[]).includes(font)) m.font = font as FontId
  return m
}

/** Whether an `li` is a checklist item, and its tick. */
function taskOf(li: Element, inTaskList: boolean): { checked: boolean } | null {
  const data = li.getAttribute('data-checked')
  if (data !== null) return { checked: data === 'true' }
  if (li.getAttribute('data-type') === 'taskItem') return { checked: false }
  const first = Array.from(li.children).find((c) => c.localName !== 'span' || c.textContent !== '')
  const box = first?.localName === 'input' ? first : first?.localName === 'p' || first?.localName === 'label' ? first.querySelector(':scope > input') : null
  if (box && box.getAttribute('type')?.toLowerCase() === 'checkbox') return { checked: box.hasAttribute('checked') || box.getAttribute('aria-checked') === 'true' }
  return inTaskList ? { checked: false } : null
}

/** Reads pasted HTML into blocks (see the module comment). */
export function htmlToBlocks(html: string): PastedHtml {
  const inert = new DOMParser().parseFromString(html, 'text/html')
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
        walk(el, lv, marksOf(el, marks), pre, true)
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
        lv.out.push({ type: 'codeBlock', text: text.replace(/\r\n?/g, '\n').replace(/\n$/, '') })
        return
      }
      const room = lv.depth < MAX_BLOCK_DEPTH
      if ((tag === 'ul' || tag === 'ol') && room) {
        close(lv)
        const taskList = el.classList.contains('yp-tasks') || el.getAttribute('data-type') === 'taskList'
        const items: Array<{ blocks: BlockNode[]; checked: boolean | null }> = []
        el.childNodes.forEach((c) => {
          if (c.nodeType === 1 && DROPPED.has((c as Element).localName)) return
          const li = c.nodeType === 1 && (c as Element).localName === 'li' ? (c as Element) : null
          if (!li && (c.nodeType !== 1 || !BLOCKS.has((c as Element).localName)) && !(c.textContent ?? '').trim()) return
          const inner: Level = { out: [], depth: lv.depth + 1, line: null }
          const task = li ? taskOf(li, taskList) : null
          if (li) walk(li, inner, marksOf(li, marks), false, true)
          else walk({ childNodes: [c] } as unknown as Node, inner, marks, false, true)
          close(inner)
          items.push({ blocks: inner.out.length > 0 ? inner.out : [{ type: 'paragraph' }], checked: task ? task.checked : null })
        })
        if (items.length === 0) return
        if (items.some((it) => it.checked !== null)) lv.out.push({ type: 'taskList', items: items.map((it) => ({ checked: it.checked === true, blocks: it.blocks })) })
        else if (tag === 'ol') {
          const start = Number(el.getAttribute('start') ?? '1')
          lv.out.push({ type: 'orderedList', ...(isListStart(start) && start !== 1 ? { start } : {}), items: items.map((it) => ({ blocks: it.blocks })) })
        } else lv.out.push({ type: 'bulletList', items: items.map((it) => ({ blocks: it.blocks })) })
        return
      }
      if (tag === 'blockquote' && room) {
        close(lv)
        const inner: Level = { out: [], depth: lv.depth + 1, line: null }
        walk(el, inner, marksOf(el, marks), false, true)
        lv.out.push({ type: 'blockquote', blocks: inner.out.length > 0 ? inner.out : [{ type: 'paragraph' }] })
        return
      }
      const block = BLOCKS.has(tag)
      const before = lv.out.length
      if (block) close(lv)
      walk(el, lv, marksOf(el, marks), pre, block ? !CONTAINERS.has(tag) : para)
      if (block && !CONTAINERS.has(tag) && lv.out.length === before) lv.out.push({ type: 'paragraph' }) // an empty block is an empty line
      if (block) close(lv)
    })
  }

  const top: Level = { out: [], depth: 1, line: null }
  walk(inert.body, top, {}, false, false)
  const blocks = top.out.map(clean)

  // What Yuriful copied from inside one line: ProseMirror marks the slice open at both ends.
  const slice = /^(\d+) (\d+)/.exec(inert.body.querySelector('[data-pm-slice]')?.getAttribute('data-pm-slice') ?? '')
  const lines = leaves(blocks)
  let inline = false
  if (blocks.length === 1 && blocks[0]!.type === 'paragraph') inline = true
  else if (slice && Number(slice[1]) > 0 && Number(slice[2]) > 0 && lines.length === 1 && lines[0]!.type !== 'codeBlock' && leafCount(blocks) === 1) {
    inline = true
    fromHeading = lines[0]!.type === 'heading'
  }
  const plain = !slice && blocks.every((b) => b.type === 'paragraph' && (b.content ?? []).every((r) => Object.keys(r).length === 1))
  return { blocks, inline, fromHeading, plain }
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
