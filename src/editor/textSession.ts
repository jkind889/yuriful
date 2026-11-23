import { history, redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { DOMParser as PMDOMParser, Fragment, Slice } from 'prosemirror-model'
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { Command, Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { resolveEditingShortcut, typedCharacter } from '../input/shortcuts.ts'
import type { KeyEventLike } from '../input/shortcuts.ts'
import { DEFAULT_FONT } from '../model/richText.ts'
import type { Mark, TextFormatting } from '../model/richText.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { FontId } from '../model/types.ts'
import { boxOf, contentFromDoc, docFromText, fontOf, marks, nodes, posAtTextOffset, renderStaticInto, textOffsetAt, textSchema } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import {
  META,
  applyPending,
  canonicalGuard,
  completesShortcut,
  editKeys,
  lineLevels,
  linesOfSelection,
  normalPending,
  pendingKey,
  pendingMarks,
  pendingOf,
  selectionFormat,
  setLinesLevel,
  setRangeFont,
  shortcutTransaction,
  togglePendingMark,
  toggleRangeMark,
} from './textRules.ts'
import type { FormatReadout, Pending } from './textRules.ts'

/**
 * One edit of one text (plan Section 7): the ProseMirror state of the text being edited, the
 * single guarded way it changes, and what the editor needs to hear about it. Usable headless
 * (tests, and the editor before it mounts a view) and with one `EditorView` mounted into a
 * given element. It knows nothing of the board: the editor decides when a session starts and
 * ends, what to save and what to record, through the hooks.
 *
 * Every change goes through `dispatch`, which refuses it once the session has finished or
 * while `hooks.canEdit` says no (the board went read-only, a gesture is unsettled, the editor
 * moved on to another session). After each change of the text the canonical record content
 * goes to `hooks.onChange`: always the compact `{ text, spans?, headings? }` form with the box
 * formatting, never `blocks`.
 */

export interface EditSessionHooks {
  /** The text changed (typing, a paste, a format command, undo...): its canonical content now. */
  onChange?(content: TextContent, session: EditSession): void
  /** The state changed (a caret move, pending choices, a change of the text): what the controls show may differ. */
  onSelectionChange?(session: EditSession): void
  /** Esc or Tab was pressed in the edited text (not during an IME composition). The session stays open until `finish()`. */
  onWantsFinish?(reason: 'escape' | 'tab', session: EditSession): void
  /** False refuses every change: the board is read-only, a gesture is unsettled, or this is no longer the active session. */
  canEdit?(session: EditSession): boolean
  /** False keeps typing shortcuts from firing (on top of `canEdit`). */
  canFireShortcut?(session: EditSession): boolean
  /** Ctrl/Cmd+B, I or U in the edited text. When absent the session toggles the mark itself. */
  onFormatKey?(mark: Mark, session: EditSession): void
}

export interface PasteData {
  html?: string
  text?: string
  /** A paste that asked for plain text (Ctrl/Cmd+Shift+V): `html` is ignored. */
  plain?: boolean
}

let sessions = 0

export class EditSession {
  /** Distinct for every session, so that late callbacks can tell whether they still belong to the active one. */
  readonly id = ++sessions
  /** Stands for the edited text's element while no view is mounted: headless key events target it. */
  readonly headlessRoot: EventTarget = { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }
  private current: EditorState
  private box: TextFormatting
  private readonly hooks: EditSessionHooks
  private mounted: { view: EditorView; el: HTMLElement; attrs: Array<[string, string]> } | null = null
  private done = false
  /** The character a key is about to type (`typedCharacter`), from its keydown until it arrives or the key comes up. */
  private typed: string | null = null
  /** Straight after a typing shortcut: the pending choices from just before it, for the Backspace revert. */
  private revert: { pending: Pending | null } | null = null
  private cached: { doc: PMNode; box: TextFormatting; content: TextContent } | null = null

  constructor(doc: PMNode, box: TextFormatting, hooks: EditSessionHooks = {}, opts: { caret?: number } = {}) {
    this.box = boxOf(box)
    this.hooks = hooks
    const caret = posAtTextOffset(doc, opts.caret ?? Number.MAX_SAFE_INTEGER)
    this.current = EditorState.create({
      schema: textSchema,
      doc,
      selection: TextSelection.create(doc, caret),
      plugins: [
        this.inputPlugin(),
        keymap(editKeys),
        lineLevels(),
        canonicalGuard({ baseFont: () => this.baseFont, composing: () => this.composing }),
        pendingMarks({ baseFont: () => this.baseFont }),
        history(),
      ],
    })
  }

  get state(): EditorState {
    return this.current
  }
  get view(): EditorView | null {
    return this.mounted?.view ?? null
  }
  /** Where the edited text's keys arrive: the view's editable element, or `headlessRoot`. */
  get root(): EventTarget {
    return this.mounted?.view.dom ?? this.headlessRoot
  }
  get finished(): boolean {
    return this.done
  }
  get baseFont(): FontId {
    return this.box.font ?? DEFAULT_FONT
  }
  get composing(): boolean {
    return this.mounted?.view.composing ?? false
  }
  get canUndo(): boolean {
    return undoDepth(this.current) > 0
  }
  get canRedo(): boolean {
    return redoDepth(this.current) > 0
  }
  /** A typing shortcut has just fired and nothing has happened since: Backspace puts its characters back. */
  get canRevertShortcut(): boolean {
    return this.revert !== null
  }
  get pending(): Pending | null {
    return pendingOf(this.current)
  }

  private get editable(): boolean {
    return !this.done && (this.hooks.canEdit?.(this) ?? true)
  }

  /** The text's canonical record content now (compact form plus the box formatting). */
  content(): TextContent {
    const c = this.cached
    if (c && c.doc === this.current.doc && c.box === this.box) return c.content
    const content = contentFromDoc(this.current.doc, this.box)
    this.cached = { doc: this.current.doc, box: this.box, content }
    return content
  }

  /** What the formatting controls show: the selected range, or with only a caret the next typed character. */
  format(): FormatReadout {
    return selectionFormat(this.current, this.baseFont)
  }

  /** The only way the state changes. */
  dispatch(tr: Transaction) {
    if (!this.editable) return
    const { state, transactions } = this.current.applyTransaction(tr)
    if (transactions.length === 0) return
    this.current = state
    this.mounted?.view.updateState(state)
    // Any change of the text or move of the caret ends "straight after a shortcut" (in-edit
    // undo included), except the shortcut's own conversion.
    if ((tr.docChanged || tr.selectionSet) && tr.getMeta(META.shortcutApplied) !== true) this.revert = null
    if (transactions.some((t) => t.docChanged)) this.hooks.onChange?.(this.content(), this)
    this.hooks.onSelectionChange?.(this)
  }

  /** Runs a ProseMirror command on the session. */
  run(cmd: Command): boolean {
    if (!this.editable) return false
    return cmd(this.current, (tr) => this.dispatch(tr), this.view ?? undefined)
  }

  /** Puts the caret (or a range, `anchor` to `head`) at UTF-16 offsets into the text. */
  select(anchor: number, head = anchor) {
    const doc = this.current.doc
    this.dispatch(this.current.tr.setSelection(TextSelection.create(doc, posAtTextOffset(doc, anchor), posAtTextOffset(doc, head))))
  }

  /** The selection as UTF-16 offsets into the text. */
  selection(): { anchor: number; head: number; from: number; to: number } {
    const { anchor, head, from, to } = this.current.selection
    const doc = this.current.doc
    return { anchor: textOffsetAt(doc, anchor, anchor <= head ? -1 : 1), head: textOffsetAt(doc, head, head < anchor ? -1 : 1), from: textOffsetAt(doc, from, -1), to: textOffsetAt(doc, to, 1) }
  }

  // ---- keys and typing ----------------------------------------------------------------------

  /**
   * A keydown in the edited text. Observes which character it is about to type, then claims
   * only what today's editor claims: Esc and Tab (they ask to finish), Backspace straight
   * after a typing shortcut (the revert), and Ctrl/Cmd+B, I, U (a held key's repeats are
   * claimed and toggle nothing). Returns true when claimed; everything else goes on to the
   * editing keys (`editKeys`) and the browser.
   */
  handleKeyDown(e: KeyEventLike): boolean {
    if (this.done) return false
    const ctx = { editedTextarea: this.root, canRevertShortcut: this.revert !== null && !this.composing }
    this.typed = typedCharacter(e, ctx) // observed only, never claimed
    if (!e.isComposing && !this.composing && (e.key === 'Escape' || e.key === 'Tab') && e.target === this.root) {
      this.hooks.onWantsFinish?.(e.key === 'Escape' ? 'escape' : 'tab', this)
      return true
    }
    const claimed = resolveEditingShortcut(e, ctx)
    if (!claimed) return false
    if (claimed === 'revert-shortcut') this.revertShortcut()
    else if (claimed !== 'ignore') {
      if (this.hooks.onFormatKey) this.hooks.onFormatKey(claimed, this)
      else this.toggleMark(claimed)
    }
    return true
  }

  /** A keyup: what the key typed has arrived by now, if it typed anything. */
  handleKeyUp() {
    this.typed = null
  }

  /**
   * Text about to be inserted by typing (ProseMirror's `handleTextInput`; also called during
   * an IME composition, hence the composing guard). Fires a typing shortcut only for one
   * character a key typed (`typedCharacter` on its keydown), inserted at the caret with
   * nothing replaced, not during a composition, on an editable board with no gesture
   * unsettled. The conversion is two transactions: the literal character, then the shortcut
   * (`shortcutTransaction`, its own history event). Returns true when it handled the input.
   */
  handleTextInput(from: number, to: number, text: string, composing = this.composing): boolean {
    const typed = this.typed
    this.typed = null
    if (!this.editable || composing) return false
    if (typed === null || text !== typed || text.length !== 1 || from !== to) return false
    const sel = this.current.selection
    if (!sel.empty || sel.from !== from) return false
    if (!(this.hooks.canFireShortcut?.(this) ?? true)) return false
    if (!completesShortcut(this.current, from, text)) return false
    this.dispatch(this.current.tr.insertText(text, from, to))
    const pendingBefore = pendingOf(this.current)
    const tr = shortcutTransaction(this.current, text)
    if (tr) {
      this.dispatch(tr)
      this.revert = { pending: pendingBefore }
    }
    return true
  }

  /**
   * Backspace straight after a typing shortcut: the literal characters come back exactly as
   * typed, with their formatting, the caret after them and the pending choices from before
   * it fired. It is the in-edit undo of the conversion (`Ctrl/Cmd+Z` straight after does the
   * same), so nothing is deleted.
   */
  revertShortcut(): boolean {
    const r = this.revert
    this.revert = null
    if (!r || !this.editable) return false
    return undo(this.current, (tr) => this.dispatch(tr.setMeta(pendingKey, r.pending)))
  }

  /** Drops the Backspace revert offer (the font size changed, records were applied...). */
  clearShortcutRevert() {
    this.revert = null
  }

  // ---- formatting -------------------------------------------------------------------------------

  /**
   * Bold, italic, underline or strikethrough: on the selected range (off if every character
   * has it, otherwise on; bold never changes in heading lines), or with only a caret chosen
   * for what is typed next. True when anything changed.
   */
  toggleMark(mark: Mark): boolean {
    this.revert = null // a formatting command ends "straight after a shortcut"
    if (!this.editable) return false
    const sel = this.current.selection
    if (sel instanceof TextSelection && sel.$cursor) return this.setPending(togglePendingMark(this.current, mark))
    const tr = this.current.tr
    if (!toggleRangeMark(tr, sel.from, sel.to, mark)) return false
    this.dispatch(tr)
    return true
  }

  /** Heading level 1 to 3, or 0 for body text, on every line the selection touches (the caret's line). */
  setHeading(level: 0 | 1 | 2 | 3): boolean {
    this.revert = null
    if (!this.editable) return false
    const { from, to } = this.current.selection
    const { first, last } = linesOfSelection(this.current.doc, from, to)
    const tr = this.current.tr
    if (!setLinesLevel(tr, first, last, level)) return false
    this.dispatch(tr)
    return true
  }

  /** The font of the selected range, or with only a caret the font of what is typed next. */
  setFont(font: FontId): boolean {
    this.revert = null
    if (!this.editable) return false
    const sel = this.current.selection
    if (sel instanceof TextSelection && sel.$cursor) return this.setPending({ ...this.pending, font })
    const tr = this.current.tr
    if (!setRangeFont(tr, sel.from, sel.to, font, this.baseFont)) return false
    this.dispatch(tr)
    return true
  }

  private setPending(next: Pending | null): boolean {
    const p = normalPending(next)
    if (JSON.stringify(p) === JSON.stringify(this.pending)) return false
    this.dispatch(this.current.tr.setMeta(pendingKey, p))
    return true
  }

  /**
   * The box formatting (font, alignment, colour) changed outside the document. A font
   * override equal to a new box font is dropped, as loading would.
   */
  setBox(box: TextFormatting) {
    const next = boxOf({ ...this.box, ...box })
    const fontChanged = (next.font ?? DEFAULT_FONT) !== this.baseFont
    this.box = next
    if (!fontChanged) return
    const tr = this.current.tr
    this.current.doc.descendants((node, pos) => {
      if (node.isText && fontOf(node.marks) === this.baseFont) tr.removeMark(pos, pos + node.nodeSize, marks.font)
    })
    if (tr.docChanged) this.dispatch(tr)
  }

  // ---- in-edit undo -------------------------------------------------------------------------------

  /** Steps back through this edit (typing, marks, headings, shortcuts, pastes). Whole-box settings are not part of it. */
  undo(): boolean {
    if (!this.editable) return false
    return undo(this.current, (tr) => this.dispatch(tr))
  }

  redo(): boolean {
    if (!this.editable) return false
    return redo(this.current, (tr) => this.dispatch(tr))
  }

  // ---- clipboard ----------------------------------------------------------------------------------

  /** Pasted plain text: one paragraph per line, literal (markers stay), with the marks of the text at the paste point. */
  plainTextSlice(text: string, $context: ResolvedPos): Slice {
    const set = $context.marks()
    const paras = text.split(/\r\n|\r|\n/).map((line) => nodes.paragraph.create(null, line ? textSchema.text(line, set) : null))
    return new Slice(Fragment.fromArray(paras), 1, 1)
  }

  /** The pending choices applied to every character of a pasted or dropped slice. */
  withPending(slice: Slice): Slice {
    const pending = this.pending
    if (!pending) return slice
    const mapText = (frag: Fragment): Fragment => {
      const out: PMNode[] = []
      frag.forEach((n) => out.push(n.isText ? n.mark(applyPending(n.marks, pending, this.baseFont)) : n.copy(mapText(n.content))))
      return Fragment.fromArray(out)
    }
    return new Slice(mapText(slice.content), slice.openStart, slice.openEnd)
  }

  /**
   * A paste without a view (and the same rules a mounted view applies through its paste
   * props): HTML through `sanitizePastedHTML`, which keeps only bold, italic, underline and
   * strikethrough and arrives headings as bold normal paragraphs; otherwise the plain text
   * literally. Pending choices apply. Never fires a typing shortcut.
   */
  paste(data: PasteData): boolean {
    if (!this.editable) return false
    const $from = this.current.selection.$from
    let slice: Slice
    if (data.html !== undefined && !data.plain) {
      const body = new DOMParser().parseFromString(sanitizePastedHTML(data.html), 'text/html').body
      slice = PMDOMParser.fromSchema(textSchema).parseSlice(body, { context: $from })
    } else if (data.text !== undefined) slice = this.plainTextSlice(data.text, $from)
    else return false
    const tr = this.current.tr.replaceSelection(this.withPending(slice)).scrollIntoView()
    this.dispatch(tr.setMeta('paste', true).setMeta('uiEvent', 'paste'))
    return true
  }

  private inputPlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('yuriful-session-input'),
      props: {
        editable: () => this.editable,
        handleKeyDown: (_view, e) => this.handleKeyDown(e),
        handleTextInput: (view, from, to, text) => this.handleTextInput(from, to, text, view.composing),
        handleDOMEvents: {
          keyup: () => {
            this.handleKeyUp()
            return false
          },
        },
        transformPastedHTML: (html) => sanitizePastedHTML(html),
        clipboardTextParser: (text, $context) => this.plainTextSlice(text, $context),
        transformPasted: (slice) => this.withPending(slice),
      },
    })
  }

  // ---- mounting and finishing ----------------------------------------------------------------------

  /**
   * Mounts the one `EditorView` into `el`, which becomes the editable root (its children are
   * replaced by the live document). `finish()` restores the element's own attributes and
   * leaves the static HTML of the final text in it.
   */
  mount(el: HTMLElement): EditorView {
    if (this.mounted) return this.mounted.view
    if (this.done) throw new Error('a finished session cannot be mounted')
    const attrs = Array.from(el.attributes, (a): [string, string] => [a.name, a.value])
    const view = new EditorView({ mount: el }, { state: this.current, dispatchTransaction: (tr) => this.dispatch(tr) })
    this.mounted = { view, el, attrs }
    return view
  }

  /**
   * Ends the session (idempotent). The view, if any, is destroyed, the element gets back its
   * own attributes (`destroy()` leaves `ProseMirror-focused` and others behind on an in-place
   * mount) and the static HTML of the text. Nothing changes after this.
   */
  finish() {
    if (this.done) return
    this.done = true
    this.revert = null
    this.typed = null
    const m = this.mounted
    this.mounted = null
    if (!m) return
    m.view.destroy()
    for (const a of Array.from(m.el.attributes)) if (!m.attrs.some(([name]) => name === a.name)) m.el.removeAttribute(a.name)
    for (const [name, value] of m.attrs) m.el.setAttribute(name, value)
    renderStaticInto(m.el, this.current.doc)
  }
}

/**
 * A session on a stored text, with the caret at a UTF-16 offset (default: the end). Null when
 * the record cannot be read or holds rich blocks this build's schema cannot edit yet.
 */
export function createEditSession(source: TextSource, hooks: EditSessionHooks = {}, opts: { caret?: number } = {}): EditSession | null {
  const read = docFromText(source)
  return read && new EditSession(read.doc, read.box, hooks, opts)
}

// ---- pasted HTML ------------------------------------------------------------------------------------

/** Removed with everything inside them. */
const DROPPED = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'img', 'picture', 'source', 'video', 'audio', 'svg', 'canvas', 'form', 'template', 'noscript', 'title', 'head'])
/** Start and end a line. */
const BLOCKS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'figure', 'figcaption', 'address', 'dl', 'dt', 'dd', 'hr', 'details', 'summary',
])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

interface PasteMarks {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

function marksOfElement(el: Element, inherited: PasteMarks): PasteMarks {
  const m = { ...inherited }
  const tag = el.localName
  if (tag === 'b' || tag === 'strong' || HEADINGS.has(tag)) m.bold = true
  if (tag === 'i' || tag === 'em') m.italic = true
  if (tag === 'u') m.underline = true
  if (tag === 's' || tag === 'del' || tag === 'strike') m.strike = true
  const style = el.getAttribute('style') !== null ? (el as HTMLElement).style : undefined
  if (style) {
    const weight = style.fontWeight
    if (weight === 'bold' || weight === 'bolder' || Number(weight) >= 600) m.bold = true
    else if (weight === 'normal' || weight === 'lighter' || (weight !== '' && Number(weight) < 600)) m.bold = false
    if (style.fontStyle === 'italic' || style.fontStyle === 'oblique') m.italic = true
    else if (style.fontStyle === 'normal') m.italic = false
    const deco = `${style.textDecoration} ${style.textDecorationLine}`
    if (deco.includes('underline')) m.underline = true
    if (deco.includes('line-through')) m.strike = true
  }
  return m
}

/**
 * Pasted HTML reduced to what a paste keeps today (plan Section 11, the default allowlist):
 * lines of text with bold, italic, underline and strikethrough. It is read in an inert
 * document (`DOMParser`: nothing in it loads or runs), scripts, styles, frames, media and
 * forms go with everything inside them, every attribute goes (links become their text, a
 * paste never brings a size, a colour or a font), headings become bold normal-size
 * paragraphs, and block elements and `<br>` become line breaks. The result is plain
 * `<p>`, `<strong>`, `<em>`, `<u>`, `<s>` for ProseMirror's parser.
 */
export function sanitizePastedHTML(html: string): string {
  const inert = new DOMParser().parseFromString(html, 'text/html')
  type Run = { text: string; marks: PasteMarks }
  const lines: Run[][] = []
  let line: Run[] | null = null
  const ensureLine = () => {
    if (!line) {
      line = []
      lines.push(line)
    }
    return line
  }
  const walk = (node: Node, inherited: PasteMarks) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? ''
        if (line === null && text.trim() === '') return // whitespace between blocks
        ensureLine().push({ text, marks: inherited })
        return
      }
      if (child.nodeType !== 1) return
      const el = child as Element
      const tag = el.localName
      if (DROPPED.has(tag)) return
      if (tag === 'br') {
        ensureLine()
        line = null
        return
      }
      const block = BLOCKS.has(tag)
      if (block) line = null
      walk(el, marksOfElement(el, inherited))
      if (block) line = null
    })
  }
  walk(inert.body, {})
  const out = inert.createElement('div')
  for (const runs of lines) {
    const p = inert.createElement('p')
    for (const run of runs) {
      let node: Node = inert.createTextNode(run.text)
      for (const [tag, on] of [['s', run.marks.strike], ['u', run.marks.underline], ['em', run.marks.italic], ['strong', run.marks.bold]] as const) {
        if (!on) continue
        const wrap = inert.createElement(tag)
        wrap.appendChild(node)
        node = wrap
      }
      p.appendChild(node)
    }
    out.appendChild(p)
  }
  return out.innerHTML
}
