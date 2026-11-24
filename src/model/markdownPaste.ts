import { splitGraphemes } from './richText.ts'
import { MAX_BLOCK_DEPTH, isListStart, parseBlocks } from './textDoc.ts'
import type { BlockNode, InlineRun, ListItemNode, TaskItemNode } from './types.ts'

/**
 * Pasted plain Markdown as blocks (plan Section 11, "Markdown conversion of pasted plain text").
 * Pure: no DOM, no ProseMirror. Linear in the length of the text.
 *
 * The markers are the ones the typing shortcuts convert (`src/editor/textRules.ts`), with the
 * same conditions:
 * - at the start of a line: `# `, `## `, `### ` (a heading); `- ` (a bullet); `N. ` for N from 1
 *   to `MAX_LIST_START` (a numbered item); `- [ ] `, `- [] `, `- [x] `, `[ ] ` and `[] ` (a
 *   checklist item); `> ` (a quote); a line that is exactly `---` (a divider); a line starting
 *   with three backticks opens a code block that runs to the next line of only backticks (three
 *   or more) or the end of the paste, and anything after the opening backticks is dropped;
 * - inside a line: `**bold**`, `*italic*` and `` `code` ``, found as typing the line key by key
 *   at its end would find them (`inlineRuns`).
 * Inside a list item, as when typing there, only `[ ] `/`[x] ` (straight after `- `) and the
 * heading markers convert at its start; a heading never stores bold.
 *
 * Lines: every line is one block. A blank line is an empty paragraph, except that a single blank
 * line before a list line that stays in the open list is dropped. A list line indented by two
 * columns or more (a tab counts to the next multiple of four) past the item above nests one level
 * deeper, as deep as `MAX_BLOCK_DEPTH` allows; deeper lines stay at the deepest level. Any other
 * indented line under a list item is a further paragraph of that item. Consecutive `> ` lines (and
 * `>` lines among them) are one quote, whose lines are converted again as a paste of their own.
 *
 * Returns null when nothing converts (the paste is the literal paste) and when the result would
 * not be stored (over `MAX_NODES` or `MAX_TEXT_LENGTH`): the caller then pastes literally.
 */
export function markdownToBlocks(text: string): BlockNode[] | null {
  const lines = text.split(/\r\n|\r|\n/)
  const blocks = convertLines(lines, 1)
  if (isLiteral(blocks, lines)) return null
  // The model's own validator is the bound check: it reads exactly what storage would.
  return parseBlocks(blocks) ? blocks : null
}

// ---- characters ---------------------------------------------------------------------------------

/** Characters, besides whitespace, after which an opening `*`, `**` or backtick starts a word (as `textRules.ts`). */
const OPENERS = '([{"\'“‘«'
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c)
const STAR = 42
const TICK = 96

/** True when the UTF-16 unit at `i` is a whole user-perceived character (`ownCharacter` of `textRules.ts`). */
function ownAt(text: string, i: number): boolean {
  // Plain ASCII on both sides never joins (a line holds no "\r\n").
  if (!(text.charCodeAt(i + 1) >= 0x80) && text.charCodeAt(i) < 0x80 && (i === 0 || text.charCodeAt(i - 1) < 0x80)) return true
  const from = Math.max(0, i - 2)
  let o = from
  for (const g of splitGraphemes(text.slice(from, i + 3))) {
    if (o === i) return g.length === 1
    if (o > i) return false
    o += g.length
  }
  return false
}

/** For every unit of `s`, whether it is a whole character; null when all are (plain ASCII). */
function ownUnits(s: string): Uint8Array | null {
  let ascii = true
  for (let i = 0; i < s.length && ascii; i++) ascii = s.charCodeAt(i) < 0x80
  if (ascii) return null
  const own = new Uint8Array(s.length)
  let at = 0
  for (const g of splitGraphemes(s)) {
    if (g.length === 1) own[at] = 1
    at += g.length
  }
  return own
}

// ---- inline marks -------------------------------------------------------------------------------

const BOLD = 1
const ITALIC = 2
const CODE = 4

function runOf(text: string, key: number): InlineRun {
  const run: InlineRun = { text }
  if (key & BOLD) run.bold = true
  if (key & ITALIC) run.italic = true
  if (key & CODE) run.code = true
  return run
}

/**
 * The runs of `line` from `from`: the line typed key by key (one character, a grapheme cluster,
 * at a time) at its end, with `matchShortcut` and `matchCodeShortcut` applied after each `*` and
 * backtick. So a pair of markers converts exactly when typing it would: the closing marker pairs
 * with the nearest live marker before it, the marked text is not empty, has no whitespace just
 * inside either marker and no marker of its kind, the opener starts a word, no marker character is
 * joined to a mark or is inline code, and a marker removed by an earlier conversion is gone.
 * Characters typed after a conversion never carry its mark (the pending "off", and inline code is
 * not inclusive), so only the marked text of a conversion gets a mark; conversions can nest.
 * In a heading, bold markers go but bold is not stored.
 *
 * Linear: live characters are a linked list, live `*`s and backticks are stacks (a conversion only
 * ever removes the top ones), marks are recorded as ranges and swept once at the end, and inline
 * code is a sorted list of disjoint ranges.
 */
function inlineRuns(line: string, from: number, heading: boolean): InlineRun[] {
  if (from >= line.length) return []
  const s = from === 0 ? line : line.slice(from)
  if (!s.includes('*') && !s.includes('`')) return [{ text: s }]
  const len = s.length
  const own = ownUnits(s)
  const isOwn = (u: number) => own === null || own[u] === 1
  const prev = new Int32Array(len)
  const next = new Int32Array(len)
  const gone = new Uint8Array(len)
  const marks = [new Int32Array(len + 1), new Int32Array(len + 1), new Int32Array(len + 1)] as const
  const [bold, italic, code] = marks
  const stars: number[] = []
  const ticks: number[] = []
  const codeFrom: number[] = []
  const codeTo: number[] = []
  let last = -1

  const prevOf = (u: number) => prev[u] as number
  const nextOf = (u: number) => next[u] as number
  const remove = (u: number) => {
    gone[u] = 1
    const p = prevOf(u)
    const q = nextOf(u)
    if (p >= 0) next[p] = q
    if (q >= 0) prev[q] = p
    if (u === last) last = p
  }
  const isCode = (u: number) => {
    let lo = 0
    let hi = codeFrom.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((codeFrom[mid] as number) <= u) lo = mid + 1
      else hi = mid - 1
    }
    return hi >= 0 && u < (codeTo[hi] as number)
  }
  const addCode = (a: number, b: number) => {
    let start = a
    while (codeTo.length > 0 && (codeTo[codeTo.length - 1] as number) >= start) {
      codeTo.pop()
      start = Math.min(start, codeFrom.pop() as number)
    }
    codeFrom.push(start)
    codeTo.push(b)
  }
  /** A word starts after `before` (a live unit, or -1 for the start of the line). */
  const startsWord = (before: number) => before < 0 || isSpace(s[before]) || OPENERS.includes(s[before] as string)

  const star = (u: number) => {
    const p1 = prevOf(u)
    const n = p1 >= 0 && s.charCodeAt(p1) === STAR ? 2 : 1
    const close = n === 2 ? p1 : u
    const k = stars.length - 1 - n
    if (k < 0) return
    const j = stars[k] as number
    const start = nextOf(j)
    if (start === close || isSpace(s[start]) || isSpace(s[prevOf(close)])) return
    let open = j
    if (n === 2) {
      open = prevOf(j)
      if (open < 0 || s.charCodeAt(open) !== STAR) return
    }
    if (!startsWord(prevOf(open))) return
    if (!isOwn(open) || !isOwn(j) || !isOwn(close)) return
    if (isCode(open) || isCode(j) || isCode(close) || isCode(u)) return
    const range = n === 2 ? bold : italic
    range[start] = (range[start] as number) + 1
    range[close] = (range[close] as number) - 1
    remove(u)
    if (n === 2) remove(close)
    remove(j)
    if (n === 2) remove(open)
    stars.length = n === 2 ? k - 1 : k
  }

  const tick = (u: number) => {
    const k = ticks.length - 2
    if (k < 0) return
    const j = ticks[k] as number
    const start = nextOf(j)
    if (start === u || isSpace(s[start]) || isSpace(s[prevOf(u)])) return
    if (!startsWord(prevOf(j)) || !isOwn(j) || isCode(j) || isCode(u)) return
    code[start] = (code[start] as number) + 1
    code[u] = (code[u] as number) - 1
    addCode(start, u)
    remove(u)
    remove(j)
    ticks.length = k
  }

  for (let u = 0; u < len; u++) {
    prev[u] = last
    next[u] = -1
    if (last >= 0) next[last] = u
    last = u
    const c = s.charCodeAt(u)
    if (c === STAR) {
      stars.push(u)
      if (isOwn(u)) star(u)
    } else if (c === TICK) {
      ticks.push(u)
      if (isOwn(u)) tick(u)
    }
  }

  const runs: InlineRun[] = []
  let b = 0
  let i = 0
  let cd = 0
  let key = -1
  let text = ''
  let pieceFrom = -1
  const flushPiece = (to: number) => {
    if (pieceFrom >= 0) text += s.slice(pieceFrom, to)
    pieceFrom = -1
  }
  for (let u = 0; u < len; u++) {
    b += bold[u] as number
    i += italic[u] as number
    cd += code[u] as number
    if (gone[u]) {
      flushPiece(u)
      continue
    }
    const k = (b > 0 && !heading ? BOLD : 0) | (i > 0 ? ITALIC : 0) | (cd > 0 ? CODE : 0)
    if (k !== key) {
      flushPiece(u)
      if (text) runs.push(runOf(text, key))
      text = ''
      key = k
    }
    if (pieceFrom < 0) pieceFrom = u
  }
  flushPiece(len)
  if (text) runs.push(runOf(text, key))
  return runs
}

// ---- one line -----------------------------------------------------------------------------------

const paragraphOf = (text: string): BlockNode => (text ? { type: 'paragraph', content: [{ text }] } : { type: 'paragraph' })

/**
 * A paragraph or heading holding `line` from `from`. Heading markers at its start convert as typing
 * them would, each one replacing the level of the last (`# ## x` is a level-2 heading `x`).
 */
function leafOf(line: string, from: number): BlockNode {
  let level = 0
  let p = from
  for (;;) {
    let k = 0
    while (k < 4 && line.charCodeAt(p + k) === 35 /* # */) k++
    if (k < 1 || k > 3 || line[p + k] !== ' ' || !ownAt(line, p + k)) break
    level = k
    p += k + 1
  }
  const content = inlineRuns(line, p, level > 0)
  const withContent = content.length > 0 ? { content } : {}
  return level === 1 || level === 2 || level === 3 ? { type: 'heading', level, ...withContent } : { type: 'paragraph', ...withContent }
}

type ListKind = 'bulletList' | 'orderedList' | 'taskList'

interface ListLine {
  /** Columns of leading whitespace (a tab reaches the next multiple of four). */
  indent: number
  kind: ListKind
  start: number
  checked: boolean
  /** Where the item's own text starts. */
  rest: number
}

function indentOf(line: string): { width: number; end: number } {
  let width = 0
  let end = 0
  for (; end < line.length; end++) {
    const c = line.charCodeAt(end)
    if (c === 32) width++
    else if (c === 9) width += 4 - (width % 4)
    else break
  }
  return { width, end }
}

/** A checkbox `[ ] `, `[] ` or `[x] ` at `at`: its length and whether it is ticked. */
function checkboxAt(line: string, at: number): { length: number; checked: boolean } | null {
  for (const [box, checked] of [['[ ] ', false], ['[] ', false], ['[x] ', true]] as const) {
    if (line.startsWith(box, at) && ownAt(line, at + box.length - 1)) return { length: box.length, checked }
  }
  return null
}

/** The list marker that starts `line` after its indent, or null. */
function listLineOf(line: string): ListLine | null {
  const { width, end } = indentOf(line)
  const item = (kind: ListKind, rest: number, start = 1, checked = false): ListLine => ({ indent: width, kind, start, checked, rest })
  if (line.startsWith('- ', end) && ownAt(line, end + 1)) {
    // A bullet whose item starts with a checkbox becomes a checklist item, as typed.
    const box = checkboxAt(line, end + 2)
    return box ? item('taskList', end + 2 + box.length, 1, box.checked) : item('bulletList', end + 2)
  }
  // A ticked box alone is no marker: typed, `[x] ` converts only straight after `- `.
  const box = checkboxAt(line, end)
  if (box && !box.checked) return item('taskList', end + box.length)
  let d = end
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++
  if (d > end && line[d] === '.' && line[d + 1] === ' ' && ownAt(line, d + 1)) {
    const start = Number(line.slice(end, d))
    if (isListStart(start)) return item('orderedList', d + 2, start)
  }
  return null
}

const isFenceOpen = (line: string) => line.startsWith('```') && ownAt(line, 2)
const isFenceClose = (line: string) => /^`{3,}[ \t]*$/.test(line)
const isQuoteLine = (line: string) => line.startsWith('> ') && ownAt(line, 1)
const isBlank = (line: string) => /^[ \t]*$/.test(line)

/** True when the blocks are the lines as plain paragraphs: nothing converted. */
function isLiteral(blocks: readonly BlockNode[], lines: readonly string[]): boolean {
  if (blocks.length !== lines.length) return false
  return blocks.every((b, i) => {
    if (b.type !== 'paragraph') return false
    const runs = b.content ?? []
    if (runs.length === 0) return lines[i] === ''
    const run = runs[0] as InlineRun
    return runs.length === 1 && Object.keys(run).length === 1 && run.text === lines[i]
  })
}

// ---- lines into blocks ----------------------------------------------------------------------------

type ListNode = Extract<BlockNode, { type: ListKind }>

interface Level {
  /** The indent of the line that opened this level. */
  indent: number
  list: ListNode
  item: ListItemNode | TaskItemNode
  /** The blocks the list is the last of. */
  container: BlockNode[]
}

function newItem(m: ListLine, leaf: BlockNode): ListItemNode | TaskItemNode {
  return m.kind === 'taskList' ? { checked: m.checked, blocks: [leaf] } : { blocks: [leaf] }
}

function newList(m: ListLine, item: ListItemNode | TaskItemNode): ListNode {
  if (m.kind === 'taskList') return { type: 'taskList', items: [item as TaskItemNode] }
  if (m.kind === 'orderedList') return { type: 'orderedList', ...(m.start > 1 && { start: m.start }), items: [item] }
  return { type: 'bulletList', items: [item] }
}

/** Whether an item of `m` continues `list`: the same kind, and for a numbered list the number that follows on. */
function continues(list: ListNode, m: ListLine): boolean {
  if (list.type !== m.kind) return false
  return list.type !== 'orderedList' || (list.start ?? 1) + list.items.length === m.start
}

/** The blocks of `lines`, at `depth` (top level is 1, as `parseBlocks` counts). */
function convertLines(lines: readonly string[], depth: number): BlockNode[] {
  const out: BlockNode[] = []
  let stack: Level[] = []
  /** Blank lines met while a list is open, not yet placed. */
  let blanks: string[] = []
  /** Lines before this index are known to start no quote. */
  let noQuoteBefore = 0
  const canList = depth < MAX_BLOCK_DEPTH

  /** Ends the open list; the waiting blank lines become paragraphs after it, as they were. */
  const settle = () => {
    stack = []
    for (const b of blanks) out.push(paragraphOf(b))
    blanks = []
  }

  const openList = (m: ListLine, line: string, container: BlockNode[]): Level => {
    const item = newItem(m, leafOf(line, m.rest))
    const list = newList(m, item)
    container.push(list)
    return { indent: m.indent, list, item, container }
  }

  const placeItem = (m: ListLine, line: string) => {
    if (stack.length === 0) {
      stack.push(openList(m, line, out))
      return
    }
    let at = stack.length - 1
    while (at > 0 && (stack[at] as Level).indent > m.indent) at--
    let nest = false
    if (m.indent >= (stack[at] as Level).indent + 2) {
      if (at < stack.length - 1) at++ // between two levels: beside the deeper one
      else if (depth + stack.length + 1 <= MAX_BLOCK_DEPTH) nest = true
    }
    const level = stack[at] as Level
    const joins = !nest && continues(level.list, m)
    if (blanks.length > 0) {
      // One blank line inside the list is dropped; anything else ends it.
      if (blanks.length === 1 && (nest || at > 0 || joins)) blanks = []
      else {
        settle()
        stack.push(openList(m, line, out))
        return
      }
    }
    stack.length = at + 1
    if (nest) stack.push(openList(m, line, level.item.blocks))
    else if (joins) {
      const item = newItem(m, leafOf(line, m.rest))
      ;(level.list.items as Array<ListItemNode | TaskItemNode>).push(item)
      level.item = item
    } else {
      const fresh = openList(m, line, level.container)
      level.list = fresh.list
      level.item = fresh.item
    }
  }

  /** An indented line under a list item: a further paragraph of the item it is indented under. False when it is under none. */
  const continueItem = (line: string): boolean => {
    const { width, end } = indentOf(line)
    let at = stack.length - 1
    while (at >= 0 && (stack[at] as Level).indent >= width) at--
    if (at < 0) return false
    const level = stack[at] as Level
    for (let n = blanks.length; n > 0; n--) level.item.blocks.push({ type: 'paragraph' })
    blanks = []
    level.item.blocks.push(leafOf(line, end))
    stack.length = at + 1
    return true
  }

  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as string
    if (isFenceOpen(line)) {
      settle()
      let j = i + 1
      while (j < lines.length && !isFenceClose(lines[j] as string)) j++
      out.push({ type: 'codeBlock', text: lines.slice(i + 1, j).join('\n') })
      i = j < lines.length ? j + 1 : j
      continue
    }
    if (i >= noQuoteBefore && depth < MAX_BLOCK_DEPTH && (line === '>' || isQuoteLine(line))) {
      let j = i
      let quoted = false
      for (; j < lines.length; j++) {
        const l = lines[j] as string
        if (isQuoteLine(l)) quoted = true
        else if (l !== '>') break
      }
      if (quoted) {
        settle()
        const inner = lines.slice(i, j).map((l) => (l === '>' ? '' : l.slice(2)))
        out.push({ type: 'blockquote', blocks: convertLines(inner, depth + 1) })
        i = j
        continue
      }
      noQuoteBefore = j // a run of `>` lines alone stays literal
    }
    if (isBlank(line)) {
      if (stack.length > 0) blanks.push(line)
      else out.push(paragraphOf(line))
      i++
      continue
    }
    const m = canList ? listLineOf(line) : null
    if (m) {
      placeItem(m, line)
      i++
      continue
    }
    const c = line.charCodeAt(0)
    if (stack.length > 0 && (c === 32 || c === 9) && continueItem(line)) {
      i++
      continue
    }
    settle()
    out.push(line === '---' ? { type: 'divider' } : leafOf(line, 0))
    i++
  }
  settle()
  return out
}
