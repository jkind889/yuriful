import { DEFAULT_FONT, FONT_IDS, MARKS, canonicalHeadings, canonicalSpans, canonicalTextFormatting, isHeadingLevel, paragraphsOf } from './richText.ts'
import type { TextFormatting } from './richText.ts'
import type { BlockNode, FontId, InlineRun, ListItemNode, ObjectRecord, TaskItemNode, TextMark, TextRecord, TextSpan } from './types.ts'

/**
 * The rich form of a text (`blocks`), as the document stores it. Pure: no Fabric, no DOM,
 * no ProseMirror.
 *
 * A text has exactly one canonical form, so that "a commit that changes nothing records
 * nothing" stays exact:
 * - a text whose blocks are only top-level paragraphs and headings and that uses no `code`
 *   mark is stored in the compact form `{ text, spans?, headings? }` (see richText.ts), with
 *   no `blocks`;
 * - otherwise `blocks` is the authority: `text` is their plain-text projection and there are
 *   no `spans` or `headings`;
 * - inside `blocks`, run keys come in a fixed order, marks are only ever `true`, a heading's
 *   runs never carry `bold`, a run's `font` is never the box font, empty runs are dropped,
 *   neighbouring runs with the same formatting are merged, and an empty `content` is left out.
 *
 * `blocks` is read strictly: an unknown block type, a malformed container or a bound that is
 * exceeded makes the text (and so the board) unreadable instead of silently losing part of it.
 * Formatting values (marks, fonts, an ordered list's start, a task's checkbox) are read
 * leniently, like the rest of a text's formatting.
 */

export const MAX_BLOCK_DEPTH = 6
export const MAX_NODES = 10_000
/** In UTF-16 code units, over every run and code block of one text. */
export const MAX_TEXT_LENGTH = 500_000

/** The fields that only this rich form of a text uses. A board that uses any of them is stored as wire version 3. */
export type RichField = 'blocks' | 'height' | 'surface'
export const RICH_FIELDS: readonly RichField[] = ['blocks', 'height', 'surface']

/**
 * The rich fields this build can draw, edit and save back unchanged. A board that uses any
 * other one opens read-only, as if it came from a newer build, so that nothing in it is
 * dropped by a save. None yet: lists and the rest of `blocks`, a fixed height and paper
 * each join this set with the change that lets the canvas edit them.
 */
export const EDITABLE_RICH_FIELDS: ReadonlySet<RichField> = new Set<RichField>()

const RUN_MARKS: readonly TextMark[] = [...MARKS, 'code']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isFont = (v: unknown): v is FontId => FONT_IDS.includes(v as FontId)

// ---- strict validation into canonical form ------------------------------------------------

interface Budget {
  nodes: number
  chars: number
  baseFont: FontId
}

function spend(budget: Budget, nodes: number, chars = 0): boolean {
  budget.nodes += nodes
  budget.chars += chars
  return budget.nodes <= MAX_NODES && budget.chars <= MAX_TEXT_LENGTH
}

const sameFormat = (a: InlineRun, b: InlineRun) => RUN_MARKS.every((m) => a[m] === b[m]) && a.font === b.font

/** One run in canonical key order, or undefined when it is empty. */
function canonicalRun(text: string, raw: Partial<Record<TextMark, unknown>> & { font?: unknown }, inHeading: boolean, baseFont: FontId): InlineRun | undefined {
  if (text === '') return undefined
  const run: InlineRun = { text }
  for (const m of RUN_MARKS) if (raw[m] === true && !(m === 'bold' && inHeading)) run[m] = true
  if (isFont(raw.font) && raw.font !== baseFont) run.font = raw.font
  return run
}

/** Appends `run`, merging it into the last run when both have the same formatting. */
function pushRun(out: InlineRun[], run: InlineRun | undefined) {
  if (!run) return
  const last = out[out.length - 1]
  if (last && sameFormat(last, run)) last.text += run.text
  else out.push(run)
}

/** A paragraph's or heading's runs; null when `raw` is not a list of runs. */
function parseContent(raw: unknown, inHeading: boolean, budget: Budget): InlineRun[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_NODES) return null
  const out: InlineRun[] = []
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i]
    if (!isObj(r) || typeof r.text !== 'string' || r.text.includes('\n')) return null
    if (!spend(budget, 1, r.text.length)) return null
    pushRun(out, canonicalRun(r.text, r, inHeading, budget.baseFont))
  }
  return out
}

function parseItems(raw: unknown, depth: number, budget: Budget): ListItemNode[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NODES) return null
  const out: ListItemNode[] = []
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i]
    if (!isObj(item) || !spend(budget, 1)) return null
    const blocks = parseBlockList(item.blocks, depth + 1, budget)
    if (!blocks) return null
    out.push({ blocks })
  }
  return out
}

function parseTaskItems(raw: unknown, depth: number, budget: Budget): TaskItemNode[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NODES) return null
  const out: TaskItemNode[] = []
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i]
    if (!isObj(item) || !spend(budget, 1)) return null
    const blocks = parseBlockList(item.blocks, depth + 1, budget)
    if (!blocks) return null
    out.push({ checked: item.checked === true, blocks })
  }
  return out
}

const withContent = (content: InlineRun[]) => (content.length > 0 ? { content } : {})

function parseBlock(raw: unknown, depth: number, budget: Budget): BlockNode | null {
  if (!isObj(raw) || !spend(budget, 1)) return null
  switch (raw.type) {
    case 'paragraph': {
      const content = parseContent(raw.content, false, budget)
      return content && { type: 'paragraph', ...withContent(content) }
    }
    case 'heading': {
      if (!isHeadingLevel(raw.level)) return null
      const content = parseContent(raw.content, true, budget)
      return content && { type: 'heading', level: raw.level, ...withContent(content) }
    }
    case 'bulletList': {
      const items = parseItems(raw.items, depth, budget)
      return items && { type: 'bulletList', items }
    }
    case 'orderedList': {
      const items = parseItems(raw.items, depth, budget)
      const start = raw.start
      return items && { type: 'orderedList', ...(Number.isSafeInteger(start) && (start as number) > 1 && { start: start as number }), items }
    }
    case 'taskList': {
      const items = parseTaskItems(raw.items, depth, budget)
      return items && { type: 'taskList', items }
    }
    case 'blockquote': {
      const blocks = parseBlockList(raw.blocks, depth + 1, budget)
      return blocks && { type: 'blockquote', blocks }
    }
    case 'codeBlock':
      if (typeof raw.text !== 'string' || !spend(budget, 0, raw.text.length)) return null
      return { type: 'codeBlock', text: raw.text }
    case 'divider':
      return { type: 'divider' }
    default:
      return null // an unknown block is never dropped: the whole text is unreadable
  }
}

/** A non-empty list of blocks at `depth` (top level is 1). */
function parseBlockList(raw: unknown, depth: number, budget: Budget): BlockNode[] | null {
  if (depth > MAX_BLOCK_DEPTH || !Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NODES) return null
  const out: BlockNode[] = []
  for (let i = 0; i < raw.length; i++) {
    const block = parseBlock(raw[i], depth, budget)
    if (!block) return null
    out.push(block)
  }
  return out
}

/**
 * Validates untrusted `blocks` into canonical form (without collapsing to the compact form;
 * see `canonicalTextContent`). Returns null when they are not valid: never a partial tree.
 */
export function parseBlocks(raw: unknown, baseFont: FontId = DEFAULT_FONT): BlockNode[] | null {
  return parseBlockList(raw, 1, { nodes: 0, chars: 0, baseFont })
}

// ---- projections ----------------------------------------------------------------------------

const runsText = (content: readonly InlineRun[] | undefined) => (content ?? []).map((r) => r.text).join('')

function collectLines(blocks: readonly BlockNode[], out: string[]) {
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'heading':
        out.push(runsText(b.content))
        break
      case 'codeBlock':
        out.push(b.text)
        break
      case 'divider':
        break
      case 'blockquote':
        collectLines(b.blocks, out)
        break
      default:
        for (const item of b.items) collectLines(item.blocks, out)
    }
  }
}

/**
 * The words of a rich text as plain text: every paragraph, heading and code block in
 * document order, one per line. List markers, checkboxes and dividers add nothing.
 */
export function plainTextOf(blocks: readonly BlockNode[]): string {
  const lines: string[] = []
  collectLines(blocks, lines)
  return lines.join('\n')
}

function someBlock(blocks: readonly BlockNode[], test: (b: BlockNode) => boolean, item?: (i: TaskItemNode) => boolean): boolean {
  return blocks.some((b) => {
    if (test(b)) return true
    if (b.type === 'blockquote') return someBlock(b.blocks, test, item)
    if (b.type === 'bulletList' || b.type === 'orderedList') return b.items.some((i) => someBlock(i.blocks, test, item))
    if (b.type === 'taskList') return b.items.some((i) => (item?.(i) ?? false) || someBlock(i.blocks, test, item))
    return false
  })
}

/**
 * A blank text has no visible characters, no divider and no ticked checkbox. A blank text is
 * never part of the scene. Before a build can make dividers and checkboxes this is exactly
 * "only whitespace".
 */
export function isBlankTextDoc(rec: Pick<TextRecord, 'text' | 'blocks'>): boolean {
  if (!rec.blocks) return rec.text.trim() === ''
  if (plainTextOf(rec.blocks).trim() !== '') return false
  return !someBlock(rec.blocks, (b) => b.type === 'divider', (i) => i.checked)
}

/** True when the blocks are only top-level paragraphs and headings with no `code` mark. */
function isCompact(blocks: readonly BlockNode[]): boolean {
  return blocks.every((b) => (b.type === 'paragraph' || b.type === 'heading') && !(b.content ?? []).some((r) => r.code))
}

// ---- legacy (compact) conversion ------------------------------------------------------------

export interface CompactText {
  text: string
  spans?: TextSpan[]
  headings?: number[]
}

/**
 * The blocks of a compact text: one paragraph or heading per line (`paragraphsOf`, so a
 * "\r\n" is one line break and is not kept), with its spans cut into runs per line. The
 * spans are made canonical first, so a run never splits a character such as an emoji.
 * `baseFont` is the box font.
 */
export function legacyToBlocks(text: string, fmt: { spans?: unknown; headings?: unknown } = {}, baseFont: FontId = DEFAULT_FONT): BlockNode[] {
  const headings = canonicalHeadings(text, fmt.headings)
  const spans = canonicalSpans(text, fmt.spans, headings, baseFont) ?? []
  return paragraphsOf(text).map((p, i): BlockNode => {
    const level = headings?.[i] ?? 0
    const content: InlineRun[] = []
    const cuts = new Set([p.start, p.end])
    for (const s of spans) {
      if (s.start > p.start && s.start < p.end) cuts.add(s.start)
      if (s.end > p.start && s.end < p.end) cuts.add(s.end)
    }
    const sorted = [...cuts].sort((a, b) => a - b)
    for (let k = 0; k + 1 < sorted.length; k++) {
      const a = sorted[k] as number
      const b = sorted[k + 1] as number
      const span = spans.find((s) => s.start < b && s.end > a)
      pushRun(content, canonicalRun(text.slice(a, b), span ?? {}, level > 0, baseFont))
    }
    return isHeadingLevel(level) ? { type: 'heading', level, ...withContent(content) } : { type: 'paragraph', ...withContent(content) }
  })
}

/**
 * The compact form of blocks that are only top-level paragraphs and headings with no `code`
 * mark, in canonical form; null for any other blocks.
 */
export function blocksToLegacy(blocks: readonly BlockNode[], baseFont: FontId = DEFAULT_FONT): CompactText | null {
  if (!isCompact(blocks)) return null
  let text = ''
  const levels: number[] = []
  const rawSpans: TextSpan[] = []
  blocks.forEach((b, i) => {
    if (i > 0) text += '\n'
    levels.push(b.type === 'heading' ? b.level : 0)
    if (b.type !== 'paragraph' && b.type !== 'heading') return
    for (const run of b.content ?? []) {
      const span: TextSpan = { start: text.length, end: text.length + run.text.length }
      text += run.text
      for (const m of MARKS) if (run[m]) span[m] = true
      if (run.font) span.font = run.font
      if (MARKS.some((m) => span[m]) || span.font) rawSpans.push(span)
    }
  })
  const headings = canonicalHeadings(text, levels)
  const spans = canonicalSpans(text, rawSpans, headings, baseFont)
  return { text, ...(spans && { spans }), ...(headings && { headings }) }
}

// ---- a whole text record ----------------------------------------------------------------------

export type TextContent = TextFormatting & Pick<TextRecord, 'text' | 'blocks'>

/**
 * A stored text's words and formatting in canonical form: `text`, `font`, `align`, `color`,
 * then `spans` and `headings` (compact form) or `blocks` (rich form). Null when `text` is not
 * a string or `blocks` is present but not valid.
 */
export function canonicalTextContent(raw: Record<string, unknown>): TextContent | null {
  if (typeof raw.text !== 'string') return null
  if (raw.blocks === undefined) return { text: raw.text, ...canonicalTextFormatting(raw.text, raw) }
  const box = canonicalTextFormatting('', { font: raw.font, align: raw.align, color: raw.color })
  const baseFont = box.font ?? DEFAULT_FONT
  const blocks = parseBlocks(raw.blocks, baseFont)
  if (!blocks) return null
  const compact = blocksToLegacy(blocks, baseFont)
  if (compact) return { text: compact.text, ...canonicalTextFormatting(compact.text, { ...box, spans: compact.spans, headings: compact.headings }) }
  return { text: plainTextOf(blocks), ...box, blocks }
}

/** A fixed height, kept only when it is a finite number above zero. */
export function canonicalHeight(raw: unknown): { height?: number } {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? { height: raw } : {}
}

/** Paper, kept only when it is exactly `'card'`. */
export function canonicalSurface(raw: unknown): { surface?: 'card' } {
  return raw === 'card' ? { surface: 'card' } : {}
}

/** A deep copy of blocks, never sharing a node with the original. */
export function cloneBlocks(blocks: readonly BlockNode[]): BlockNode[] {
  return JSON.parse(JSON.stringify(blocks)) as BlockNode[]
}

// ---- storage fence ----------------------------------------------------------------------------

function richFieldsOf(rec: TextRecord): RichField[] {
  return RICH_FIELDS.filter((f) => rec[f] !== undefined)
}

/** True when any text uses `blocks`, `height` or `surface`: the board must be stored as wire version 3. */
export function needsRichFence(doc: { objects: readonly ObjectRecord[] }): boolean {
  return doc.objects.some((o) => o.type === 'text' && richFieldsOf(o).length > 0)
}

/** The rich fields the board uses that this build cannot edit (see `EDITABLE_RICH_FIELDS`). */
export function uneditableRichFields(doc: { objects: readonly ObjectRecord[] }): Set<RichField> {
  const out = new Set<RichField>()
  for (const o of doc.objects) {
    if (o.type !== 'text') continue
    for (const f of richFieldsOf(o)) if (!EDITABLE_RICH_FIELDS.has(f)) out.add(f)
  }
  return out
}
