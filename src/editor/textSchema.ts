import { DOMSerializer, Schema } from 'prosemirror-model'
import type { Mark as PMMark, Node as PMNode } from 'prosemirror-model'
import { DEFAULT_FONT, FONT_IDS, MARKS, canonicalTextFormatting, isHeadingLevel } from '../model/richText.ts'
import type { HeadingLevel, Mark, TextFormatting } from '../model/richText.ts'
import { blocksToLegacy, canonicalTextContent, legacyToBlocks } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { BlockNode, FontId, InlineRun, TextRecord } from '../model/types.ts'

/**
 * The ProseMirror form of a text while it is shown or edited as DOM. Only this file (and the
 * other `text*` files of `src/editor/`) knows ProseMirror; `src/model/` never sees a
 * ProseMirror node or position.
 *
 * Milestone-2 subset: a document is a list of paragraphs and headings (levels 1 to 3) holding
 * text with the marks bold, italic, underline and strikethrough and a per-range font. That is
 * exactly what the compact record form `{ text, spans?, headings? }` can hold, so every
 * document this schema can express is stored compact (never as `blocks`). Lists, quotes,
 * code and dividers join the schema in Slice 3a.
 *
 * A document maps to the record's plain text one block per line: a block boundary is the
 * "\n" between two lines, and inside a block a ProseMirror offset is a UTF-16 offset into
 * the line (the schema has no inline nodes other than text).
 */

const isFont = (v: unknown): v is FontId => FONT_IDS.includes(v as FontId)

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
  },
})

export const nodes = {
  doc: textSchema.nodes.doc!,
  paragraph: textSchema.nodes.paragraph!,
  heading: textSchema.nodes.heading!,
}
export const marks = {
  font: textSchema.marks.font!,
  bold: textSchema.marks.bold!,
  italic: textSchema.marks.italic!,
  underline: textSchema.marks.underline!,
  strike: textSchema.marks.strike!,
}

/** The heading level of a top-level block (0: a paragraph). */
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
export function marksOfRun(run: Partial<Record<Mark, true | undefined>> & { font?: FontId }): readonly PMMark[] {
  let set: readonly PMMark[] = []
  if (run.font) set = marks.font.create({ font: run.font }).addToSet(set)
  for (const m of MARKS) if (run[m]) set = marks[m].create().addToSet(set)
  return set
}

/** One text node as a run (key order as in the record: text, marks, font). */
function runOf(node: PMNode): InlineRun {
  const run: InlineRun = { text: node.text ?? '' }
  for (const m of MARKS) if (marks[m].isInSet(node.marks)) run[m] = true
  const font = fontOf(node.marks)
  if (font) run.font = font
  return run
}

/** A top-level block as a record block (before canonicalization). */
export function blockOf(block: PMNode): BlockNode {
  const content: InlineRun[] = []
  block.forEach((child) => {
    if (child.isText) content.push(runOf(child))
  })
  const level = levelOf(block)
  const withContent = content.length > 0 ? { content } : {}
  return isHeadingLevel(level) ? { type: 'heading', level, ...withContent } : { type: 'paragraph', ...withContent }
}

/** A block of the Milestone-2 subset as a ProseMirror node. */
function blockNode(block: BlockNode): PMNode {
  if (block.type !== 'paragraph' && block.type !== 'heading') throw new RangeError(`block type ${block.type} is not part of the Milestone-2 schema`)
  const content = (block.content ?? []).map((run) => textSchema.text(run.text, marksOfRun(run)))
  const { type, attrs } = blockTypeFor(block.type === 'heading' ? block.level : 0)
  return type.create(attrs, content)
}

/** The ProseMirror document for record blocks that use only paragraphs and headings. */
export function docFromBlocks(blocks: readonly BlockNode[]): PMNode {
  return nodes.doc.create(null, blocks.length > 0 ? blocks.map(blockNode) : [nodes.paragraph.create()])
}

/** The fields of a text record that make up its content. */
export type TextSource = Pick<TextRecord, 'text' | 'font' | 'align' | 'color' | 'spans' | 'headings' | 'blocks'>

/**
 * A stored text as a ProseMirror document and its box formatting (font, alignment, colour),
 * read the way loading reads it (`canonicalTextContent`): "\r\n" is one line break, spans
 * become runs that never split a character, an empty heading line stays a heading, bold
 * inside a heading and a span font equal to the box font are dropped. Null when the record is
 * not readable, or uses rich blocks this schema cannot hold yet.
 */
export function docFromText(rec: TextSource): { doc: PMNode; box: TextFormatting } | null {
  const content = canonicalTextContent(rec as unknown as Record<string, unknown>)
  if (!content || content.blocks) return null
  const box = boxOf(content)
  const blocks = legacyToBlocks(content.text, { spans: content.spans, headings: content.headings }, box.font ?? DEFAULT_FONT)
  return { doc: docFromBlocks(blocks), box }
}

/** Only the box-wide fields of a text's formatting, in canonical form. */
export function boxOf(fmt: TextFormatting): TextFormatting {
  return canonicalTextFormatting('', { font: fmt.font, align: fmt.align, color: fmt.color })
}

/**
 * The record content of a document, in canonical form: the compact `{ text, spans?, headings? }`
 * together with the box formatting, keys in the order `canonicalTextContent` gives them. This
 * schema can only express compact texts, so `blocks` is never present.
 */
export function contentFromDoc(doc: PMNode, box: TextFormatting): TextContent {
  const baseFont = box.font ?? DEFAULT_FONT
  const blocks: BlockNode[] = []
  doc.forEach((block) => {
    blocks.push(blockOf(block))
  })
  const compact = blocksToLegacy(blocks, baseFont)
  if (!compact) throw new Error('a Milestone-2 document is always compact')
  return { text: compact.text, ...canonicalTextFormatting(compact.text, { ...boxOf(box), spans: compact.spans, headings: compact.headings }) }
}

// ---- text offsets ----------------------------------------------------------------------------

/** The text of each top-level block (each line of the record's text). */
export function linesOf(doc: PMNode): string[] {
  const out: string[] = []
  doc.forEach((block) => {
    out.push(block.textContent)
  })
  return out
}

/** The plain text of a document: its lines joined by "\n". */
export function plainTextOfDoc(doc: PMNode): string {
  return linesOf(doc).join('\n')
}

/**
 * The UTF-16 offset in the plain text of the position `pos`. A position between two blocks
 * stands for the line break between them: `bias` -1 gives the end of the line before it,
 * 1 the start of the line after it.
 */
export function textOffsetAt(doc: PMNode, pos: number, bias: -1 | 1 = -1): number {
  const $pos = doc.resolve(pos)
  let offset = 0
  const index = $pos.index(0)
  for (let i = 0; i < index; i++) offset += doc.child(i).content.size + 1
  if ($pos.depth > 0) return offset + $pos.parentOffset
  // Between blocks (or at either end of the document).
  if (bias < 0) return index > 0 ? offset - 1 : 0
  return index < doc.childCount ? offset : Math.max(0, offset - 1)
}

/** The position of a UTF-16 offset into the plain text (clamped to the text). */
export function posAtTextOffset(doc: PMNode, offset: number): number {
  let rest = Math.max(0, offset)
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i)
    const size = block.content.size
    if (rest <= size || i === doc.childCount - 1) return pos + 1 + Math.min(rest, size)
    rest -= size + 1
    pos += block.nodeSize
  }
  return 1
}

/** The position just before the top-level block `index`. */
export function posOfBlock(doc: PMNode, index: number): number {
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return pos
}

// ---- static rendering ------------------------------------------------------------------------

/**
 * The static HTML of a document (an idle card): the same `toDOM` as the live editor, with a
 * `<br>` in every empty block, standing in for the trailing break ProseMirror puts there, so
 * an empty line has the same height shown and edited (Section 7, rules 1 and 2; the matching
 * CSS is rule 4, in Slice 2b).
 */
export function renderStatic(doc: PMNode, ownerDocument: Document = document): DocumentFragment {
  const frag = ownerDocument.createDocumentFragment()
  DOMSerializer.fromSchema(textSchema).serializeFragment(doc.content, { document: ownerDocument }, frag)
  for (const el of Array.from(frag.children)) {
    if (el.childNodes.length === 0) el.appendChild(ownerDocument.createElement('br'))
  }
  return frag
}

/** Replaces the children of `el` with the static HTML of `doc`. */
export function renderStaticInto(el: HTMLElement, doc: PMNode) {
  el.replaceChildren(renderStatic(doc, el.ownerDocument))
}
