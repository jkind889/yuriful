import { history, redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { DOMParser as PMDOMParser, Fragment, Slice } from 'prosemirror-model'
import type { Mark as PMMark, Node as PMNode, ParseOptions } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { Command, Transaction } from 'prosemirror-state'
import { ReplaceStep } from 'prosemirror-transform'
import { EditorView } from 'prosemirror-view'
import { resolveEditingShortcut, typedCharacter } from '../input/shortcuts.ts'
import type { KeyEventLike } from '../input/shortcuts.ts'
import { DEFAULT_FONT, canonicalTextFormatting, splitGraphemes } from '../model/richText.ts'
import type { Mark, TextFormatting } from '../model/richText.ts'
import { legacyToBlocks } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { FontId } from '../model/types.ts'
import { blockOf, boxOf, contentFromDoc, docFromBlocks, docFromText, fontOf, marks, nodes, plainTextOfDoc, posAtTextOffset, renderStaticInto, textOffsetAt, textSchema } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import {
  META,
  SETTLE,
  applyPending,
  canonicalGuard,
  completesShortcut,
  editKeys,
  imposeRuns,
  lineLevels,
  linesOfSelection,
  normalPending,
  owesCanonical,
  pendingKey,
  pendingMarks,
  pendingOf,
  plainPasteContent,
  selectionFormat,
  setLinesLevel,
  setRangeFont,
  shortcutTransaction,
  togglePendingMark,
  toggleRangeMark,
  wholeTextSelection,
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
 * moved on to another session). After each change the canonical record content goes to
 * `hooks.onChange`: always the compact `{ text, spans?, headings? }` form with the box
 * formatting, never `blocks`. Until something has changed, `content()` is the record's own
 * stored content, so entering and leaving an edit changes nothing.
 */

export interface EditSessionHooks {
  /** The text or a box setting changed (typing, a paste, a format command, undo...): its canonical content now. */
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

/** ProseMirror's parser, keeping runs of spaces in pasted HTML (the sanitizer has already dropped layout whitespace). */
class KeepSpacesParser extends PMDOMParser {
  override parseSlice(dom: globalThis.Node, options: ParseOptions = {}): Slice {
    return super.parseSlice(dom, { ...options, preserveWhitespace: true })
  }
}
const pasteParser = new KeepSpacesParser(textSchema, PMDOMParser.fromSchema(textSchema).rules)

/** Pasted plain text with one "\n" per line break, as the canvas's textarea holds it. */
const normalBreaks = (text: string) => text.replace(/\r\n?/g, '\n')

/**
 * `offset` moved off the middle of a character (a surrogate pair or any grapheme cluster) to
 * before it, as the canvas maps an offset to its character positions: a caret is never inside
 * a character, and Backspace never leaves half a surrogate pair.
 */
function onCharacter(text: string, offset: number): number {
  const o = Math.max(0, Math.min(text.length, offset))
  const lineStart = o > 0 ? text.lastIndexOf('\n', o - 1) + 1 : 0
  let at = lineStart
  for (const g of splitGraphemes(text.slice(lineStart, o + 16))) {
    if (at + g.length > o) return at
    at += g.length
  }
  return o
}

/** An offset into the "\n" form of a text whose stored line breaks are "\r\n" (see `EditSession.storedBreaks`), as an offset into the stored text. */
function storedOffset(stored: string, offset: number): number {
  let extra = 0
  for (let i = 0; i < stored.length && i - extra < offset; i++) if (stored[i] === '\r' && stored[i + 1] === '\n') extra++
  return offset + extra
}

/**
 * Text leaving a card by copy, cut or drag: a heading's text goes as bold body text, and no
 * text carries its font (pasted or dropped text never brings its own size, colour or font).
 */
export function copiedSlice(slice: Slice): Slice {
  const map = (frag: Fragment): Fragment => {
    const out: PMNode[] = []
    frag.forEach((n) => {
      if (n.isText) out.push(n.mark(marks.font.removeFromSet(n.marks)))
      else if (n.type === nodes.heading) {
        const children: PMNode[] = []
        n.forEach((c) => children.push(c.mark(marks.bold.create().addToSet(marks.font.removeFromSet(c.marks)))))
        out.push(nodes.paragraph.create(null, children))
      } else out.push(n.copy(map(n.content)))
    })
    return Fragment.fromArray(out)
  }
  return new Slice(map(slice.content), slice.openStart, slice.openEnd)
}

export class EditSession {
  /** Distinct for every session, so that late callbacks can tell whether they still belong to the active one. */
  readonly id = ++sessions
  /** Stands for the edited text's element while no view is mounted: headless key events target it. */
  readonly headlessRoot: EventTarget = { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }
  private current: EditorState
  private box: TextFormatting
  private readonly hooks: EditSessionHooks
  /** The record as the session found it: its content stands until the document or a box setting changes. */
  private readonly initial: { doc: PMNode; box: TextFormatting; content: TextContent }
  private mounted: { view: EditorView; el: HTMLElement; attrs: Array<[string, string]> } | null = null
  private done = false
  private composingHeadless = false
  /** The character a key is about to type (`typedCharacter`), from its keydown until it arrives or the key comes up. */
  private typed: string | null = null
  /** Straight after a typing shortcut: the pending choices from just before it, for the Backspace revert. */
  private revert: { pending: Pending | null } | null = null
  /** Recent typing shortcut conversions: the document each left and its pending choices, for redo. */
  private conversions: Array<{ doc: PMNode; pending: Pending | null }> = []
  /** What ProseMirror is pasting or dropping right now (set by its clipboard hooks, read by `transformPasted`). */
  private incoming: 'text' | 'html' | null = null
  /** A plain-text paste in progress: what it pastes, where, and with which pending choices. */
  private plainPaste: { text: string; from: number; to: number; pending: Pending | null } | null = null
  /** Where a drop in progress lands (from the drop event), for the destination font. */
  private dropPos: number | null = null
  private cached: { doc: PMNode; box: TextFormatting; content: TextContent } | null = null
  /**
   * A stored text with "\r\n" line breaks keeps them until its text is changed: today the
   * editing textarea turns them into "\n" only on the first keystroke, so formatting alone
   * stores the "\r\n" text.
   */
  private storedBreaks: string | null

  constructor(doc: PMNode, box: TextFormatting, hooks: EditSessionHooks = {}, opts: { caret?: number; content?: TextContent } = {}) {
    this.box = boxOf(box)
    this.hooks = hooks
    this.initial = { doc, box: this.box, content: opts.content ?? contentFromDoc(doc, this.box) }
    this.storedBreaks = this.initial.content.text.includes('\r\n') ? this.initial.content.text : null
    const caret = posAtTextOffset(doc, onCharacter(plainTextOfDoc(doc), opts.caret ?? Number.MAX_SAFE_INTEGER))
    this.current = EditorState.create({
      schema: textSchema,
      doc,
      selection: TextSelection.create(doc, caret),
      plugins: [
        this.inputPlugin(),
        keymap(editKeys),
        wholeTextSelection(),
        lineLevels(),
        this.pastePlugin(),
        canonicalGuard({ baseFont: () => this.baseFont, composing: () => this.composing }),
        pendingMarks({ baseFont: () => this.baseFont, afterHistory: (d) => this.conversions.find((c) => c.doc.eq(d))?.pending ?? null }),
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
    return (this.mounted?.view.composing ?? false) || this.composingHeadless
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

  /** The text's canonical record content now (compact form plus the box formatting); the record's own until something changed. */
  content(): TextContent {
    if (this.current.doc === this.initial.doc && JSON.stringify(this.box) === JSON.stringify(this.initial.box)) return this.initial.content
    const c = this.cached
    if (c && c.doc === this.current.doc && c.box === this.box) return c.content
    let content = contentFromDoc(this.current.doc, this.box)
    const stored = this.storedBreaks
    if (stored !== null && stored.replace(/\r\n/g, '\n') === content.text) {
      const spans = content.spans?.map((sp) => ({ ...sp, start: storedOffset(stored, sp.start), end: storedOffset(stored, sp.end) }))
      content = { text: stored, ...canonicalTextFormatting(stored, { ...this.box, spans, headings: content.headings }) }
    }
    this.cached = { doc: this.current.doc, box: this.box, content }
    return content
  }

  /** What the formatting controls show: the selected range, or with only a caret the next typed character. */
  format(): FormatReadout {
    return selectionFormat(this.current, this.baseFont)
  }

  /** The only way the state changes. */
  dispatch(tr: Transaction) {
    if (!this.editable) {
      this.plainPaste = null
      return
    }
    const { state, transactions } = this.current.applyTransaction(tr)
    this.plainPaste = null
    if (transactions.length === 0) return
    this.current = state
    this.mounted?.view.updateState(state)
    if (transactions.some((t) => t.steps.some((st) => st instanceof ReplaceStep))) this.storedBreaks = null // the text was typed into
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

  /** Puts the caret (or a range, `anchor` to `head`) at UTF-16 offsets into the text, never inside a character (see `onCharacter`). */
  select(anchor: number, head = anchor) {
    const doc = this.current.doc
    const text = plainTextOfDoc(doc)
    const at = (o: number) => posAtTextOffset(doc, onCharacter(text, o))
    this.dispatch(this.current.tr.setSelection(TextSelection.create(doc, at(anchor), at(head))))
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
      this.conversions = [...this.conversions.slice(-19), { doc: this.current.doc, pending: pendingOf(this.current) }]
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

  // ---- IME composition ----------------------------------------------------------------------------

  /** A composition starts without a view (a mounted view knows its own). */
  compositionStart() {
    this.composingHeadless = true
  }

  /** A composition ends without a view; what it inserted is made canonical now. */
  compositionEnd() {
    this.composingHeadless = false
    this.settleComposition()
  }

  /** Once no composition is in progress, makes what the last one inserted canonical (`canonicalGuard`). */
  private settleComposition() {
    if (this.done || this.composing || !owesCanonical(this.current)) return
    this.dispatch(this.current.tr.setMeta(SETTLE, true))
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
   * A box setting (font, alignment, colour) changed, as a formatting command: guarded like
   * every change, and it ends "straight after a shortcut". It is not a step of in-edit undo
   * (Section 7): a new box font drops the overrides equal to it, as loading would, without
   * recording a history step. True when anything changed.
   */
  setBox(box: TextFormatting): boolean {
    this.revert = null
    if (!this.editable) return false
    const next = boxOf({ ...this.box, ...box })
    if (JSON.stringify(next) === JSON.stringify(this.box)) return false
    const fontChanged = (next.font ?? DEFAULT_FONT) !== this.baseFont
    this.box = next
    const tr = this.current.tr
    if (fontChanged) {
      this.current.doc.descendants((node, pos) => {
        if (node.isText && fontOf(node.marks) === this.baseFont) tr.removeMark(pos, pos + node.nodeSize, marks.font)
      })
    }
    if (tr.docChanged) this.dispatch(tr.setMeta('addToHistory', false))
    else this.hooks.onChange?.(this.content(), this)
    return true
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

  // ---- clipboard and drops ------------------------------------------------------------------------

  /** Pasted plain text: one paragraph per line, literal (markers stay). Its marks are given afterwards, as today (`plainPasteContent`). */
  plainTextSlice(text: string): Slice {
    const paras = normalBreaks(text).split('\n').map((line) => nodes.paragraph.create(null, line ? textSchema.text(line) : null))
    return new Slice(Fragment.fromArray(paras), 1, 1)
  }

  /** The font of the place text arrives at: the drop point, the first selected character, or the caret's neighbour. */
  private destinationFont(state: EditorState): FontId | undefined {
    if (this.dropPos !== null) return fontOf(state.doc.resolve(Math.min(this.dropPos, state.doc.content.size)).marks())
    const sel = state.selection
    return fontOf(sel.empty ? sel.$from.marks() : (sel.$from.marksAcross(sel.$to) ?? []))
  }

  /**
   * Pasted HTML or dropped text arriving: it keeps its own bold, italic, underline and
   * strikethrough (a heading's text arrives bold), takes the font of the place it arrives at
   * and never its own, and gets the pending choices.
   */
  arriving(slice: Slice, destFont: FontId | undefined): Slice {
    const pending = this.pending
    const base = this.baseFont
    const font: readonly PMMark[] = destFont && destFont !== base ? [marks.font.create({ font: destFont })] : []
    const flat = copiedSlice(slice)
    const map = (frag: Fragment): Fragment => {
      const out: PMNode[] = []
      frag.forEach((n) => {
        if (!n.isText) return out.push(n.copy(map(n.content)))
        let set = n.marks
        for (const m of font) set = m.addToSet(set)
        out.push(n.mark(applyPending(set, pending, base)))
      })
      return Fragment.fromArray(out)
    }
    return new Slice(map(flat.content), flat.openStart, flat.openEnd)
  }

  /**
   * A paste without a view, by the same rules a mounted view applies through its clipboard
   * props: HTML through `sanitizePastedHTML` (only bold, italic, underline and
   * strikethrough; headings arrive as bold normal paragraphs; spaces and empty paragraphs
   * kept), then `arriving`; plain text literally, styled exactly as today's canvas styles it
   * (`plainPasteContent`). Never fires a typing shortcut.
   */
  paste(data: PasteData): boolean {
    if (!this.editable) return false
    const sel = this.current.selection
    let slice: Slice
    if (data.html !== undefined && !data.plain) {
      const body = new DOMParser().parseFromString(sanitizePastedHTML(data.html), 'text/html').body
      slice = this.arriving(pasteParser.parseSlice(body, { context: sel.$from }), this.destinationFont(this.current))
    } else if (data.text !== undefined) {
      this.notePlainPaste(data.text, this.current)
      slice = this.plainTextSlice(data.text)
    } else return false
    this.dispatch(this.current.tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'))
    return true
  }

  /**
   * A drop without a view, as ProseMirror's drop handler does it: `slice` (from `dragSlice`,
   * or pasted-like content) lands at UTF-16 offset `at`, after the dragged range `moveFrom`
   * is removed for a move inside the card.
   */
  drop(slice: Slice, at: number, moveFrom?: { from: number; to: number }): boolean {
    if (!this.editable) return false
    const doc = this.current.doc
    const insertPos = posAtTextOffset(doc, at)
    this.dropPos = insertPos
    const arriving = this.arriving(slice, this.destinationFont(this.current))
    this.dropPos = null
    const tr = this.current.tr
    if (moveFrom) tr.delete(posAtTextOffset(doc, moveFrom.from), posAtTextOffset(doc, moveFrom.to))
    const pos = tr.mapping.map(insertPos)
    tr.replaceRange(pos, pos, arriving)
    tr.setSelection(TextSelection.create(tr.doc, pos, tr.mapping.map(pos, 1)))
    this.dispatch(tr.setMeta('uiEvent', 'drop'))
    return true
  }

  /** What dragging (or copying) the UTF-16 range [from, to) carries: `copiedSlice` of it. */
  dragSlice(from: number, to: number): Slice {
    const doc = this.current.doc
    return copiedSlice(doc.slice(posAtTextOffset(doc, from), posAtTextOffset(doc, to), true))
  }

  private notePlainPaste(text: string, state: EditorState) {
    const { from, to } = state.selection
    this.plainPaste = { text: normalBreaks(text), from: textOffsetAt(state.doc, from, -1), to: textOffsetAt(state.doc, to, 1), pending: pendingOf(state) }
  }

  /** Gives a plain-text paste (or plain text dropped from elsewhere) its marks exactly as today's canvas does. */
  private pastePlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('yuriful-plain-paste'),
      appendTransaction: (trs, oldState, newState) => {
        const rec = this.plainPaste
        const root = trs[0]
        if (!rec || !root) return null
        const drop = root.getMeta('uiEvent') === 'drop'
        if (root.getMeta('paste') !== true && !drop) return null
        this.plainPaste = null
        let { from, to } = rec
        if (drop) {
          const step = root.steps.find((s): s is ReplaceStep => s instanceof ReplaceStep)
          if (!step) return null
          from = textOffsetAt(oldState.doc, step.from, -1)
          to = textOffsetAt(oldState.doc, step.to, 1)
        }
        const old = contentFromDoc(oldState.doc, this.box)
        const want = plainPasteContent({ text: old.text, spans: old.spans, headings: old.headings }, this.baseFont, from, to, rec.text, rec.pending)
        if (want.text !== plainTextOfDoc(newState.doc)) return null
        const expected = docFromBlocks(legacyToBlocks(want.text, want, this.baseFont))
        const tr = newState.tr
        let changed = false
        newState.doc.forEach((block, offset, i) => {
          const b = blockOf(expected.child(i))
          const runs = b.type === 'paragraph' || b.type === 'heading' ? (b.content ?? []) : []
          if (imposeRuns(tr, block, offset + 1, runs)) changed = true
        })
        return changed ? tr : null
      },
    })
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
          drop: (view, e) => {
            this.dropPos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null
            queueMicrotask(() => (this.dropPos = null))
            return false
          },
          compositionend: () => {
            // After ProseMirror has read the composition's last change (a microtask).
            setTimeout(() => this.settleComposition(), 0)
            return false
          },
        },
        transformPastedHTML: (html) => {
          this.incoming = 'html'
          return sanitizePastedHTML(html)
        },
        clipboardParser: pasteParser,
        clipboardTextParser: (text, _$context, _plain, view) => {
          this.incoming = 'text'
          if (this.dropPos === null) this.notePlainPaste(text, view.state)
          else this.plainPaste = { text: normalBreaks(text), from: 0, to: 0, pending: pendingOf(view.state) }
          return this.plainTextSlice(text)
        },
        transformPasted: (slice, view) => {
          const kind = this.incoming
          this.incoming = null
          return kind === 'text' ? slice : this.arriving(slice, this.destinationFont(view.state))
        },
        transformCopied: (slice) => copiedSlice(slice),
        clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n'),
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
  return read && new EditSession(read.doc, read.box, hooks, { caret: opts.caret, content: read.content })
}

// ---- pasted HTML ------------------------------------------------------------------------------------

/** Removed with everything inside them. */
const DROPPED = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'img', 'picture', 'source', 'video', 'audio', 'svg', 'canvas', 'form', 'template', 'noscript', 'title', 'head'])
/** Start and end a line. */
const BLOCKS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'figure', 'figcaption', 'address', 'dl', 'dt', 'dd', 'hr', 'details', 'summary',
])
/** Blocks that only hold other blocks: an empty one is not an empty line. */
const CONTAINERS = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'dl', 'hr'])
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
  if (tag === 'b' || tag === 'strong') m.bold = true
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
  if (HEADINGS.has(tag)) m.bold = true // a heading's text arrives bold, whatever its own weight
  return m
}

/**
 * Pasted HTML reduced to what a paste keeps (plan Section 11, the default allowlist): lines of
 * text with bold, italic, underline and strikethrough. It is read in an inert document
 * (`DOMParser`: nothing in it loads or runs), scripts, styles, frames, media and forms go with
 * everything inside them, every attribute goes (links become their text, a paste never brings
 * a size, a colour or a font), headings become bold normal-size paragraphs, and block elements
 * and `<br>` become line breaks; an empty paragraph stays an empty line. Spaces are kept
 * (ProseMirror parses the result with `preserveWhitespace`); only whitespace that runs across a
 * line break of the HTML source, which a browser shows as one space, becomes one space, and
 * inside `<pre>` line breaks stay line breaks. The result is plain `<p>`, `<strong>`, `<em>`,
 * `<u>`, `<s>` for ProseMirror's parser.
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
  const walk = (node: Node, inherited: PasteMarks, pre: boolean) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const raw = child.nodeValue ?? ''
        if (pre) {
          raw.split('\n').forEach((part, i) => {
            if (i > 0) line = null
            if (part) ensureLine().push({ text: part, marks: inherited })
            else if (i > 0) ensureLine()
          })
          return
        }
        if (line === null && raw.trim() === '') return // whitespace between blocks
        ensureLine().push({ text: raw.replace(/[ \t\f]*[\r\n][\s]*/g, ' '), marks: inherited })
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
      const before = lines.length
      if (block) line = null
      walk(el, marksOfElement(el, inherited), pre || tag === 'pre')
      if (block && !CONTAINERS.has(tag) && lines.length === before) lines.push([]) // an empty paragraph is an empty line
      if (block) line = null
    })
  }
  walk(inert.body, {}, false)
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
