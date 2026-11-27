import { DOMSerializer, Schema } from 'prosemirror-model'
import type { Mark as PMMark, Node as PMNode, NodeType } from 'prosemirror-model'
import { DEFAULT_FONT, FONT_IDS, MARKS, canonicalTextFormatting, isHeadingLevel } from '../model/richText.ts'
import type { HeadingLevel, Mark, TextFormatting } from '../model/richText.ts'
import { blocksToLegacy, canonicalTextContent, isListStart, legacyToBlocks, parseBlocks, plainTextOf } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { BlockNode, FontId, InlineRun, ListItemNode, TaskItemNode, TextMark, TextRecord } from '../model/types.ts'

/**
 * The ProseMirror form of a text while it is shown or edited as DOM. Only this file (and the
 * other `text*` files of `src/editor/`) knows ProseMirror; `src/model/` never sees a
 * ProseMirror node or position.
 *
 * A document is a list of blocks: paragraphs and headings (levels 1 to 3), bullet, numbered and
 * check lists (whose items hold blocks), quotes (which hold blocks), code blocks and dividers.
 * Text carries the marks bold, italic, underline, strikethrough and inline code, and a per-range
 * font; a code block holds plain text, line breaks included. That is exactly what a record's
 * `blocks` can hold (`src/model/textDoc.ts`). A document of top-level paragraphs and headings
 * without inline code is stored compact (`{ text, spans?, headings? }`), anything else as
 * `blocks`.
 *
 * Lines: every textblock (paragraph, heading, code block) in document order is one line of the
 * record's plain text, with a "\n" between two of them (a code block's own line breaks are
 * characters of its line). Inside a textblock a ProseMirror offset is a UTF-16 offset into it
 * (the schema has no inline nodes other than text). For a compact text the textblocks are the
 * top-level blocks, so its lines are exactly the lines of its text, as before rich blocks.
 */

const isFont = (v: unknown): v is FontId => FONT_IDS.includes(v as FontId)

/** The marks of a run, compact and rich: the four of the compact form, then inline code. */
export const RUN_MARKS: readonly TextMark[] = [...MARKS, 'code']

export const textSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      marks: '_',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    heading: {
      group: 'block',
      content: 'text*',
      marks: '_',
      attrs: {
        level: {
          default: 1,
          validate: (v: unknown) => {
            if (!isHeadingLevel(v)) throw new RangeError(`heading level ${String(v)} is not 1, 2 or 3`)
          },
        },
      },
      parseDOM: [
        { tag: 'h1', attrs: { level: 1 } },
        { tag: 'h2', attrs: { level: 2 } },
        { tag: 'h3', attrs: { level: 3 } },
      ],
      toDOM: (node) => [`h${node.attrs.level as HeadingLevel}`, 0],
    },
    bulletList: {
      group: 'block',
      content: 'listItem+',
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    },
    orderedList: {
      group: 'block',
      content: 'listItem+',
      attrs: {
        start: {
          default: 1,
          validate: (v: unknown) => {
            if (!isListStart(v)) throw new RangeError(`list start ${String(v)} is not a whole number from 1`)
          },
        },
      },
      parseDOM: [{ tag: 'ol', getAttrs: (el) => ({ start: listStart(el.getAttribute('start')) }) }],
      // The numbers are drawn by CSS counters (`.yuriful-prose ol`), which start from the counter reset here.
      toDOM: (node) => {
        const start = node.attrs.start as number
        return ['ol', start > 1 ? { start: String(start), style: `counter-reset: yp-item ${start - 1}` } : {}, 0]
      },
    },
    listItem: {
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: () => ['li', 0],
    },
    taskList: {
      group: 'block',
      content: 'taskItem+',
      parseDOM: [{ tag: 'ul.yp-tasks', priority: 60 }],
      toDOM: () => ['ul', { class: 'yp-tasks' }, 0],
    },
    taskItem: {
      content: 'block+',
      defining: true,
      attrs: { checked: { default: false } },
      parseDOM: [{ tag: 'li.yp-task', priority: 60, contentElement: 'div.yp-task-body', getAttrs: (el) => ({ checked: el.getAttribute('data-checked') === 'true' }) }],
      toDOM: (node) => taskItemDOM(node.attrs.checked === true),
    },
    blockquote: {
      group: 'block',
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },
    codeBlock: {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    },
    divider: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    },
    text: {},
  },
  marks: {
    // A per-range override of the box font; never equal to the box font (see `canonicalGuard`).
    // Parsed back from the editor's own DOM; pasted HTML never carries it (the paste
    // sanitizer drops every attribute), so a paste never brings a font.
    font: {
      attrs: {
        font: {
          validate: (v: unknown) => {
            if (!isFont(v)) throw new RangeError(`font ${String(v)} is not a font id`)
          },
        },
      },
      parseDOM: [{ tag: 'span[data-font]', getAttrs: (el) => (isFont(el.getAttribute('data-font')) ? { font: el.getAttribute('data-font') } : false) }],
      toDOM: (mark) => ['span', { 'data-font': mark.attrs.font as string }, 0],
    },
    bold: { parseDOM: [{ tag: 'strong' }], toDOM: () => ['strong', 0] },
    italic: { parseDOM: [{ tag: 'em' }], toDOM: () => ['em', 0] },
    underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
    strike: { parseDOM: [{ tag: 's' }], toDOM: () => ['s', 0] },
    // Last, so innermost: its monospace font wins over a font override around it. Typing at its
    // end does not carry it on (not inclusive), so what follows inline code is plain text.
    code: { inclusive: false, parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  },
})

function listStart(raw: string | null): number {
  const n = raw === null ? 1 : Number(raw)
  return isListStart(n) ? n : 1
}

/**
 * A checklist item's DOM: its box (not editable, drawn by CSS, toggled by a click while the text
 * is edited) and a body holding its blocks. The live editor's node view builds exactly this.
 */
export function taskItemDOM(checked: boolean): [string, Record<string, string>, [string, Record<string, string>], [string, Record<string, string>, 0]] {
  return ['li', { class: 'yp-task', 'data-checked': String(checked) }, ['span', { class: 'yp-check', contenteditable: 'false' }], ['div', { class: 'yp-task-body' }, 0]]
}

export const nodes = {
  doc: textSchema.nodes.doc!,
  paragraph: textSchema.nodes.paragraph!,
  heading: textSchema.nodes.heading!,
  bulletList: textSchema.nodes.bulletList!,
  orderedList: textSchema.nodes.orderedList!,
  listItem: textSchema.nodes.listItem!,
  taskList: textSchema.nodes.taskList!,
  taskItem: textSchema.nodes.taskItem!,
  blockquote: textSchema.nodes.blockquote!,
  codeBlock: textSchema.nodes.codeBlock!,
  divider: textSchema.nodes.divider!,
}
export const marks = {
  font: textSchema.marks.font!,
  bold: textSchema.marks.bold!,
  italic: textSchema.marks.italic!,
  underline: textSchema.marks.underline!,
  strike: textSchema.marks.strike!,
  code: textSchema.marks.code!,
}

/** A list node type (bullet, numbered or check). */
export const isListType = (t: NodeType): boolean => t === nodes.bulletList || t === nodes.orderedList || t === nodes.taskList
/** A list item node type (of a bullet or numbered list, or of a checklist). */
export const isItemType = (t: NodeType): boolean => t === nodes.listItem || t === nodes.taskItem

/** The heading level of a block (0: a paragraph, or anything that is not a heading). */
export function levelOf(block: PMNode): number {
  return block.type === nodes.heading ? (block.attrs.level as number) : 0
}

/** The node type and attributes that give a block this level (0: paragraph). */
export function blockTypeFor(level: number): { type: typeof nodes.paragraph; attrs: { level: number } | null } {
  return isHeadingLevel(level) ? { type: nodes.heading, attrs: { level } } : { type: nodes.paragraph, attrs: null }
}

/** The font override a mark set carries, if any. */
export function fontOf(set: readonly PMMark[]): FontId | undefined {
  return set.find((m) => m.type === marks.font)?.attrs.font as FontId | undefined
}

/** The marks of a run, as a ProseMirror mark set. */
export function marksOfRun(run: Partial<Record<TextMark, true | undefined>> & { font?: FontId }): readonly PMMark[] {
  let set: readonly PMMark[] = []
  if (run.font) set = marks.font.create({ font: run.font }).addToSet(set)
  for (const m of RUN_MARKS) if (run[m]) set = marks[m].create().addToSet(set)
  return set
}

/** One text node as a run (key order as in the record: text, marks, font). */
function runOf(node: PMNode): InlineRun {
  const run: InlineRun = { text: node.text ?? '' }
  for (const m of RUN_MARKS) if (marks[m].isInSet(node.marks)) run[m] = true
  const font = fontOf(node.marks)
  if (font) run.font = font
  return run
}

function childBlocks(node: PMNode): BlockNode[] {
  const out: BlockNode[] = []
  node.forEach((child) => {
    out.push(blockOf(child))
  })
  return out
}

/** A block as a record block (before canonicalization). A textblock gives its runs as they are. */
export function blockOf(block: PMNode): BlockNode {
  const t = block.type
  if (t === nodes.codeBlock) return { type: 'codeBlock', text: block.textContent }
  if (t === nodes.divider) return { type: 'divider' }
  if (t === nodes.blockquote) return { type: 'blockquote', blocks: childBlocks(block) }
  if (t === nodes.bulletList || t === nodes.orderedList) {
    const items: ListItemNode[] = []
    block.forEach((item) => {
      items.push({ blocks: childBlocks(item) })
    })
    const start = block.attrs.start as number | undefined
    return t === nodes.bulletList ? { type: 'bulletList', items } : { type: 'orderedList', ...(start !== undefined && start > 1 && { start }), items }
  }
  if (t === nodes.taskList) {
    const items: TaskItemNode[] = []
    block.forEach((item) => {
      items.push({ checked: item.attrs.checked === true, blocks: childBlocks(item) })
    })
    return { type: 'taskList', items }
  }
  const content: InlineRun[] = []
  block.forEach((child) => {
    if (child.isText) content.push(runOf(child))
  })
  const level = levelOf(block)
  const withContent = content.length > 0 ? { content } : {}
  return isHeadingLevel(level) ? { type: 'heading', level, ...withContent } : { type: 'paragraph', ...withContent }
}

/** Every block of a document as record blocks (before canonicalization). */
export function blocksOfDoc(doc: PMNode): BlockNode[] {
  return childBlocks(doc)
}

/** A record block as a ProseMirror node. */
function blockNode(block: BlockNode): PMNode {
  switch (block.type) {
    case 'paragraph':
    case 'heading': {
      const content = (block.content ?? []).map((run) => textSchema.text(run.text, marksOfRun(run)))
      const { type, attrs } = blockTypeFor(block.type === 'heading' ? block.level : 0)
      return type.create(attrs, content)
    }
    case 'codeBlock':
      return nodes.codeBlock.create(null, block.text ? textSchema.text(block.text) : null)
    case 'divider':
      return nodes.divider.create()
    case 'blockquote':
      return nodes.blockquote.create(null, block.blocks.map(blockNode))
    case 'bulletList':
      return nodes.bulletList.create(null, block.items.map((i) => nodes.listItem.create(null, i.blocks.map(blockNode))))
    case 'orderedList':
      return nodes.orderedList.create({ start: block.start ?? 1 }, block.items.map((i) => nodes.listItem.create(null, i.blocks.map(blockNode))))
    case 'taskList':
      return nodes.taskList.create(null, block.items.map((i) => nodes.taskItem.create({ checked: i.checked }, i.blocks.map(blockNode))))
  }
}

/** The ProseMirror document for record blocks. */
export function docFromBlocks(blocks: readonly BlockNode[]): PMNode {
  return nodes.doc.create(null, blocks.length > 0 ? blocks.map(blockNode) : [nodes.paragraph.create()])
}

/** The fields of a text record that make up its content. */
export type TextSource = Pick<TextRecord, 'text' | 'font' | 'align' | 'color' | 'spans' | 'headings' | 'blocks'>

/**
 * A stored text as a ProseMirror document and its box formatting (font, alignment, colour),
 * read the way loading reads it (`canonicalTextContent`): "\r\n" is one line break, spans
 * become runs that never split a character, an empty heading line stays a heading, bold
 * inside a heading and a span font equal to the box font are dropped; rich `blocks` are read
 * strictly. `content` is the record's own canonical content (what loading stores, a "\r\n"
 * kept). Null when the record is not readable.
 */
export function docFromText(rec: TextSource): { doc: PMNode; box: TextFormatting; content: TextContent } | null {
  const content = canonicalTextContent(rec as unknown as Record<string, unknown>)
  if (!content) return null
  const box = boxOf(content)
  const blocks = content.blocks ?? legacyToBlocks(content.text, { spans: content.spans, headings: content.headings }, box.font ?? DEFAULT_FONT)
  return { doc: docFromBlocks(blocks), box, content }
}

/** Only the box-wide fields of a text's formatting, in canonical form. */
export function boxOf(fmt: TextFormatting): TextFormatting {
  return canonicalTextFormatting('', { font: fmt.font, align: fmt.align, color: fmt.color })
}

/** True when the document is stored compact: top-level paragraphs and headings only, no inline code. */
export function isCompactDoc(doc: PMNode): boolean {
  let compact = true
  doc.forEach((block) => {
    if (!compact) return
    if (block.type !== nodes.paragraph && block.type !== nodes.heading) compact = false
    else
      block.forEach((child) => {
        if (marks.code.isInSet(child.marks)) compact = false
      })
  })
  return compact
}

/**
 * True when the document would be stored as `blocks` and goes over a bound a load enforces
 * (depth 6, 10,000 nodes, 500,000 characters: `parseBlocks`). A compact text has no bounds.
 */
export function exceedsBounds(doc: PMNode, baseFont: FontId): boolean {
  return !isCompactDoc(doc) && parseBlocks(blocksOfDoc(doc), baseFont) === null
}

/**
 * The record content of a document, in canonical form, keys in the order
 * `canonicalTextContent` gives them: the compact `{ text, spans?, headings? }` together with the
 * box formatting when the document is compact, otherwise `{ text, ...box, blocks }` with `text`
 * the plain-text projection of the canonical blocks.
 */
export function contentFromDoc(doc: PMNode, box: TextFormatting): TextContent {
  const baseFont = box.font ?? DEFAULT_FONT
  const raw = blocksOfDoc(doc)
  const compact = blocksToLegacy(raw, baseFont)
  if (compact) return { text: compact.text, ...canonicalTextFormatting(compact.text, { ...boxOf(box), spans: compact.spans, headings: compact.headings }) }
  // Over a bound (never reached through an edit session, which refuses such a change): the
  // blocks as they are, which the store refuses to write rather than writing what a load refuses.
  const blocks = parseBlocks(raw, baseFont) ?? raw
  return { text: plainTextOf(blocks), ...boxOf(box), blocks }
}

// ---- lines (textblocks) and text offsets --------------------------------------------------------

/** A textblock of a document and the position just before it. */
export interface Textblock {
  node: PMNode
  pos: number
}

const textblockCache = new WeakMap<PMNode, Textblock[]>()

/** Every textblock (paragraph, heading, code block) of a document, in order: its lines. */
export function textblocksOf(doc: PMNode): Textblock[] {
  const hit = textblockCache.get(doc)
  if (hit) return hit
  const out: Textblock[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    out.push({ node, pos })
    return false
  })
  textblockCache.set(doc, out)
  return out
}

/** The text of each textblock (each line of the record's text). */
export function linesOf(doc: PMNode): string[] {
  return textblocksOf(doc).map((t) => t.node.textContent)
}

/** The plain text of a document: its lines joined by "\n". */
export function plainTextOfDoc(doc: PMNode): string {
  return linesOf(doc).join('\n')
}

/**
 * The UTF-16 offset in the plain text of the position `pos`. A position outside every textblock
 * (between two blocks, around a divider, between list items) stands for the line break between
 * the lines around it: `bias` -1 gives the end of the line before it, 1 the start of the line
 * after it.
 */
export function textOffsetAt(doc: PMNode, pos: number, bias: -1 | 1 = -1): number {
  let offset = 0
  for (const { node, pos: at } of textblocksOf(doc)) {
    const start = at + 1
    const end = start + node.content.size
    if (pos < start) return bias < 0 ? Math.max(0, offset - 1) : offset
    if (pos <= end) return offset + (pos - start)
    offset += node.content.size + 1
  }
  return Math.max(0, offset - 1)
}

/** The position of a UTF-16 offset into the plain text (clamped to the text); 0 for a document with no textblock. */
export function posAtTextOffset(doc: PMNode, offset: number): number {
  let rest = Math.max(0, offset)
  const tbs = textblocksOf(doc)
  for (let i = 0; i < tbs.length; i++) {
    const { node, pos } = tbs[i]!
    const size = node.content.size
    if (rest <= size || i === tbs.length - 1) return pos + 1 + Math.min(rest, size)
    rest -= size + 1
  }
  return 0
}

/** The position just before the textblock (line) `index`. */
export function posOfBlock(doc: PMNode, index: number): number {
  return textblocksOf(doc)[index]?.pos ?? 0
}

// ---- static rendering ------------------------------------------------------------------------

/**
 * The static HTML of a document (an idle card): the same `toDOM` as the live editor, with a
 * `<br>` where ProseMirror puts its trailing break (`addTextblockHacks`): in every empty
 * textblock, and after a code block's text that ends with a line break. So an empty line, or a
 * code block's empty last line, has the same height shown and edited (Section 7, rules 1 and 2).
 */
export function renderStatic(doc: PMNode, ownerDocument: Document = document): DocumentFragment {
  const frag = ownerDocument.createDocumentFragment()
  DOMSerializer.fromSchema(textSchema).serializeFragment(doc.content, { document: ownerDocument }, frag)
  const tbs = textblocksOf(doc)
  // Each textblock's content element, in document order (a code block's is its `code`).
  const els = frag.querySelectorAll('p, h1, h2, h3, pre > code')
  tbs.forEach(({ node }, i) => {
    const el = els[i]
    if (el && (node.content.size === 0 || /\n$/.test(node.textContent))) el.appendChild(ownerDocument.createElement('br'))
  })
  return frag
}

/** Replaces the children of `el` with the static HTML of `doc`. */
export function renderStaticInto(el: HTMLElement, doc: PMNode) {
  el.replaceChildren(renderStatic(doc, el.ownerDocument))
}

/** The record's run marks as a mark readout key (for comparing runs). */
export function runKey(run: Partial<Record<Mark | 'code', true | undefined>> & { font?: FontId }): string {
  return `${RUN_MARKS.map((m) => (run[m] ? 1 : 0)).join('')}|${run.font ?? ''}`
}
