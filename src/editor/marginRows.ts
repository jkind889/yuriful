import type { EditorView } from 'prosemirror-view'

/**
 * A press on a paper text's sheet beside its words, while the text is edited (Slice 5, the margin-
 * press rule): the caret goes to the start or end of a visual row of the text, worked out from the
 * rows as laid out, never by hit-testing a point moved toward the words.
 *
 * Coordinates are the card's own (its top-left corner at 0, 0, unturned, unscaled, before
 * scrolling: `SceneLayer.toCard`), so a turned or zoomed card is handled the same as an upright one.
 */

/** A point of the page in the card's own coordinates, or null. */
export type ToCard = (clientX: number, clientY: number) => { x: number; y: number } | null

/** One visual row of a text as laid out. */
export interface Row {
  /** Its vertical extent (one line box, centred on its characters). */
  top: number
  bottom: number
  centre: number
  /** The middles of its first and last characters across (left and right in the card), or both the row's middle when it has none. */
  inkLeft: number
  inkRight: number
  /** The document positions before its first character and after its last (before the wrap, for a row that ends at one), in reading order. */
  start: number
  end: number
}

/** A textblock's element whose text is laid out in rows: a code block's lines are in its `code`, inside the block's padding. */
export function rowElement(dom: HTMLElement): HTMLElement {
  return dom.tagName === 'PRE' && dom.firstElementChild instanceof HTMLElement ? dom.firstElementChild : dom
}

const WHITESPACE = /^\s$/u

interface Glyph {
  x: number
  y: number
  before: number
  after: number
  space: boolean
}

/**
 * The visual rows of one textblock (`blockPos`: the position before it; `el`: its `rowElement`):
 * each wrapped row of a paragraph, heading, list or checklist item's paragraph or quote line, each
 * row of a code block (its lines, and the rows a long one wraps into), and an empty line or an
 * empty code line as a row with no characters.
 *
 * Characters are measured one by one (each one's middle on the page, through `toCard`, which
 * holds however the card is turned) and are on one row while their middles are within half a line
 * of each other. A row that ends at a wrap ends before the white space the browser hangs there, so
 * a caret at its end is drawn at the end of that row, not at the start of the next.
 */
export function rowsOfBlock(view: EditorView, blockPos: number, el: HTMLElement, toCard: ToCard): Row[] {
  const doc = el.ownerDocument
  // A code block's `code` has no line height of its own (zero): its rows are the block's lines.
  const lineBox = el.tagName === 'CODE' && el.parentElement ? el.parentElement : el
  const lineHeight = parseFloat(doc.defaultView?.getComputedStyle(lineBox).lineHeight ?? '') || lineBox.offsetHeight || 1
  const half = lineHeight / 2
  const rows: Array<{ glyphs: Glyph[]; endsAtBreak: boolean; at?: number; centre?: number }> = []
  let current: (typeof rows)[number] | null = null
  let afterBreak = true // a new row starts with the block, and after each line break of a code block
  const range = doc.createRange()
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let lastBreak: { node: Text; after: number } | null = null
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const data = node.data
    for (let i = 0; i < data.length; ) {
      const code = data.codePointAt(i) ?? 0
      const len = code > 0xffff ? 2 : 1
      const ch = data.slice(i, i + len)
      if (ch === '\n') {
        if (current) current.endsAtBreak = true
        else {
          // A line with nothing on it (two breaks in a row, or a break first): a row with no characters.
          rows.push({ glyphs: [], endsAtBreak: true, at: view.posAtDOM(node, i) })
        }
        current = null
        afterBreak = true
        lastBreak = { node, after: i + 1 }
        i += len
        continue
      }
      lastBreak = null
      range.setStart(node, i)
      range.setEnd(node, i + len)
      const r = Array.from(range.getClientRects()).find((x) => x.width > 0 || x.height > 0) ?? range.getBoundingClientRect()
      const c = r.width > 0 || r.height > 0 ? toCard(r.left + r.width / 2, r.top + r.height / 2) : null
      if (c) {
        const glyph: Glyph = { x: c.x, y: c.y, before: view.posAtDOM(node, i), after: view.posAtDOM(node, i + len), space: WHITESPACE.test(ch) }
        const sameRow = current && !afterBreak && Math.abs(c.y - (current.centre ?? c.y)) <= half
        if (!current || !sameRow) {
          current = { glyphs: [], endsAtBreak: false }
          rows.push(current)
        }
        current.glyphs.push(glyph)
        const ink = current.glyphs.filter((g) => !g.space)
        const use = ink.length > 0 ? ink : current.glyphs
        current.centre = use.reduce((sum, g) => sum + g.y, 0) / use.length
        afterBreak = false
      }
      i += len
    }
  }
  // An empty last line, after a final line break.
  if (lastBreak) rows.push({ glyphs: [], endsAtBreak: false, at: view.posAtDOM(lastBreak.node, lastBreak.after) })
  // Rows with no characters take their place from the rows beside them, or, alone, from the element.
  const box = el.getBoundingClientRect()
  const middle = toCard(box.left + box.width / 2, box.top + box.height / 2)
  if (rows.length === 0) {
    if (!middle) return []
    const h = el.offsetHeight || lineHeight
    return [{ top: middle.y - h / 2, bottom: middle.y + h / 2, centre: middle.y, inkLeft: middle.x, inkRight: middle.x, start: blockPos + 1, end: blockPos + 1 }]
  }
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k]!
    if (row.centre !== undefined) continue
    const prev = rows.slice(0, k).reverse().find((r) => r.centre !== undefined)
    const next = rows.slice(k + 1).find((r) => r.centre !== undefined)
    row.centre = prev?.centre !== undefined ? prev.centre + lineHeight * (k - rows.indexOf(prev)) : next?.centre !== undefined ? next.centre - lineHeight * (rows.indexOf(next) - k) : (middle?.y ?? 0)
  }
  return rows.map((row, k) => {
    const centre = row.centre!
    const g = row.glyphs
    if (g.length === 0) {
      const x = middle?.x ?? 0
      return { top: centre - half, bottom: centre + half, centre, inkLeft: x, inkRight: x, start: row.at!, end: row.at! }
    }
    const ink = g.filter((x) => !x.space)
    const xs = (ink.length > 0 ? ink : g).map((x) => x.x)
    // A row that wraps onto the next (neither a line break nor the block's last row) ends before the white space hung at its end.
    const wraps = !row.endsAtBreak && k < rows.length - 1
    let last = g.length - 1
    if (wraps) while (last > 0 && g[last]!.space) last--
    const first = g.reduce((a, x) => (x.before < a.before ? x : a), g[0]!)
    const lastGlyph = g.slice(0, last + 1).reduce((a, x) => (x.after > a.after ? x : a), g[0]!)
    return { top: centre - half, bottom: centre + half, centre, inkLeft: Math.min(...xs), inkRight: Math.max(...xs), start: first.before, end: lastGlyph.after }
  })
}

/** A row is shown when at least half of its height lies inside the words' viewport (`top` to `bottom`). */
export function rowShown(row: Row, top: number, bottom: number): boolean {
  return Math.min(row.bottom, bottom) - Math.max(row.top, top) >= (row.bottom - row.top) / 2
}

/** How far a height is from a row: zero inside it, otherwise to its nearer edge; then from its middle (to break ties). */
export function rowDistance(row: Row, y: number): [number, number] {
  return [y < row.top ? row.top - y : y > row.bottom ? y - row.bottom : 0, Math.abs(y - row.centre)]
}
