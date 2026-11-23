import { history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
import { keydownHandler } from 'prosemirror-keymap'
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
  replacedRange,
  selectionOnCharacters,
  settledDoc,
} from './textRules.ts'
import type { CompactContent, FormatReadout, Pending } from './textRules.ts'
import { textareaInputContent } from './textRules.ts'

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
  /**
   * The history steps that are typing shortcut conversions, by their undo depth, with the
   * pending choices each left ("plain after the shortcut"): redoing exactly that step brings
   * them back. Kept in line with the history (see `trackHistory`), with no cap of its own.
   */
  private conversions = new Map<number, Pending | null>()
  /** The content last reported to `onChange` (the stored record's before any). */
  private reported: string
  /** What ProseMirror is pasting or dropping right now (set by its clipboard hooks, read by `transformPasted`). */
  private incoming: 'text' | 'html' | null = null
  /**
   * A selection being replaced by text that came some other way than a key the session saw
   * (an IME composition, an insertion with no keydown, the browser's own editing): the text
   * before it, the replaced range and the pending choices. Styled as today's canvas styles it
   * once the text is known (`replacementPlugin`); while a composition is still open,
   * `content()` already gives that final form.
   */
  private replacing: { old: CompactContent; from: number; to: number; pending: Pending | null } | null = null
  /** Between a composition's start and ProseMirror counting it as composing. */
  private compositionStarting = false
  /**
   * The IME composition in progress: the text and selection when it started, the pending
   * choices, and the replay of its updates so far. Today's canvas handles every update of the
   * composed text as an input of its own (Fabric's `onInput`), so each update is applied to
   * the replay as it arrives, one step (`compositionStep`); `content()` gives the replay,
   * and the composition is settled (the replay applied to the document) as soon as it ends,
   * before the next one starts and before anything else changes the text.
   */
  private composition: {
    start: CompactContent
    from: number
    to: number
    pending: Pending | null
    steps: number
    /** The content after the updates applied so far, and the canvas's selection for the next one. */
    replay: { content: CompactContent; from: number; to: number }
  } | null = null
  /** A plain-text paste in progress: what it pastes, where, and with which pending choices. */
  private plainPaste: { text: string; from: number; to: number; pending: Pending | null } | null = null
  /** Where a drop in progress lands (from the drop event), for the destination font. */
  private dropPos: number | null = null
  private cached: { state: EditorState; box: TextFormatting; content: TextContent } | null = null
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
    this.reported = JSON.stringify(this.initial.content)
    const caret = posAtTextOffset(doc, onCharacter(plainTextOfDoc(doc), opts.caret ?? Number.MAX_SAFE_INTEGER))
    this.current = EditorState.create({
      schema: textSchema,
      doc,
      selection: TextSelection.create(doc, caret),
      plugins: [
        this.inputPlugin(),
        this.keysPlugin(),
        // Before the pending choices, which read the new undo depth (`pendingMarks`).
        history(),
        lineLevels(),
        this.pastePlugin(),
        canonicalGuard({ baseFont: () => this.baseFont, composing: () => this.composing }),
        pendingMarks({ baseFont: () => this.baseFont, afterHistory: (redone, depth) => (redone ? (this.conversions.get(depth) ?? null) : null) }),
        selectionOnCharacters({ composing: () => this.composing }),
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

  /**
   * The text's canonical record content now (compact form plus the box formatting); the
   * record's own until something changed. In the middle of an IME composition it is already
   * the form the composition will leave (`settledDoc`), so a save never captures anything
   * else.
   */
  content(): TextContent {
    const replaced = this.compositionResult(this.current) ?? this.replacementResult(this.current)
    if (replaced) return { text: replaced.text, ...canonicalTextFormatting(replaced.text, { ...this.box, spans: replaced.spans, headings: replaced.headings }) }
    const doc = settledDoc(this.current, this.baseFont)
    if (doc === this.initial.doc && JSON.stringify(this.box) === JSON.stringify(this.initial.box)) return this.initial.content
    const c = this.cached
    if (c && c.state === this.current && c.box === this.box) return c.content
    let content = contentFromDoc(doc, this.box)
    const stored = this.storedBreaks
    if (stored !== null && stored.replace(/\r\n/g, '\n') === content.text) {
      const spans = content.spans?.map((sp) => ({ ...sp, start: storedOffset(stored, sp.start), end: storedOffset(stored, sp.end) }))
      content = { text: stored, ...canonicalTextFormatting(stored, { ...this.box, spans, headings: content.headings }) }
    }
    this.cached = { state: this.current, box: this.box, content }
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
    // A composition that has ended is replayed before anything else changes the text.
    if (this.composition && !this.composing && !this.compositionStarting && tr.getMeta(SETTLE) === undefined) this.settleComposition()
    const before = this.current
    const { state, transactions } = this.current.applyTransaction(tr)
    this.plainPaste = null
    if (transactions.length === 0) return
    this.current = state
    this.trackHistory(before, state, transactions)
    if (this.composition && this.composing && transactions.some((t) => t.docChanged) && !transactions.some(isHistoryTransaction)) {
      this.compositionStep(plainTextOfDoc(state.doc), textOffsetAt(state.doc, state.selection.to, 1))
    }
    this.mounted?.view.updateState(state)
    if (transactions.some((t) => t.steps.some((st) => st instanceof ReplaceStep))) this.storedBreaks = null // the text was typed into
    // Any change of the text or move of the caret ends "straight after a shortcut" (in-edit
    // undo included), except the shortcut's own conversion.
    if ((tr.docChanged || tr.selectionSet) && tr.getMeta(META.shortcutApplied) !== true) this.revert = null
    if (transactions.some((t) => t.docChanged)) this.reportChange()
    this.hooks.onSelectionChange?.(this)
  }

  /** Tells `onChange` about the content, only when it differs from what it was last told (or the stored record). */
  private reportChange() {
    const content = this.content()
    const json = JSON.stringify(content)
    if (json === this.reported) return
    this.reported = json
    this.hooks.onChange?.(content, this)
  }

  /**
   * Keeps `conversions` keyed by the undo depth of their history steps: a recorded change
   * forgets every conversion at or above its own depth (it discarded the redo side, and an
   * event it starts or extends no longer ends with a conversion), and when the history drops
   * its oldest events the depths shift down with them.
   */
  private trackHistory(before: EditorState, after: EditorState, transactions: readonly Transaction[]) {
    if (this.conversions.size === 0 || transactions.some(isHistoryTransaction)) return
    if (!transactions.some((t) => t.steps.length > 0 && t.getMeta('addToHistory') !== false)) return
    const was = undoDepth(before) as number
    const now = undoDepth(after) as number
    const shifted = new Map<number, Pending | null>()
    const shift = now < was ? was + 1 - now : 0 // the oldest events were dropped
    for (const [depth, pending] of this.conversions) {
      const d = depth - shift
      // Gone, or at or above the depth of this change: the redo side it discarded (a reverted
      // conversion among it), or the event it starts or extends, which no longer ends with a conversion.
      if (d <= 0 || d >= now) continue
      shifted.set(d, pending)
    }
    this.conversions = shifted
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
    const sel = this.current.selection
    if (!sel.empty && from === sel.from && to === sel.to && text.length > 0) {
      // Typing over a selection: styled exactly as today's canvas styles it (`META.replaced`).
      this.dispatch(this.current.tr.insertText(text, from, to).setMeta(META.replaced, replacedRange(this.current, normalBreaks(text))))
      return true
    }
    if (typed === null || text !== typed || text.length !== 1 || from !== to) return false
    if (!sel.empty || sel.from !== from) return false
    if (!(this.hooks.canFireShortcut?.(this) ?? true)) return false
    if (!completesShortcut(this.current, from, text)) return false
    this.dispatch(this.current.tr.insertText(text, from, to))
    const pendingBefore = pendingOf(this.current)
    const tr = shortcutTransaction(this.current, text)
    if (tr) {
      this.dispatch(tr)
      this.revert = { pending: pendingBefore }
      this.conversions.set(undoDepth(this.current) as number, pendingOf(this.current))
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
    this.beginComposition()
    this.compositionStarting = false // only a mounted view needs it: here the composition counts at once
    this.composingHeadless = true
  }

  /**
   * A composition starts: the text and selection are remembered now, before anything changes
   * (ProseMirror itself deletes a selection that spans lines at this point, before it counts
   * as composing; the canvas sees that as part of the first update, so it is not a step).
   */
  private beginComposition() {
    if (this.composing || this.done) return
    // The previous composition is settled first, with its last change read (an IME commits one
    // syllable and starts the next in the same moment).
    this.flushDom()
    if (this.composition) this.settleComposition()
    const state = this.current
    const old = contentFromDoc(state.doc, this.box)
    const start = { text: old.text, spans: old.spans, headings: old.headings }
    const from = textOffsetAt(state.doc, state.selection.from, -1)
    const to = textOffsetAt(state.doc, state.selection.to, 1)
    this.composition = { start, from, to, pending: pendingOf(state), steps: 0, replay: { content: start, from, to } }
    this.replacing = null
    this.compositionStarting = true
    queueMicrotask(() => (this.compositionStarting = false)) // after ProseMirror's own compositionstart handling
  }

  /**
   * An update that leaves the text as it is (a first candidate equal to the selected text)
   * changes nothing ProseMirror would report, but the canvas still handles it: over a
   * selection it counts as replacing it.
   */
  private sameTextUpdate(data: string) {
    const c = this.composition
    if (!c || c.steps > 0 || c.from === c.to) return
    const text = c.start.text.slice(0, c.from) + data + c.start.text.slice(c.to)
    if (text === c.start.text && plainTextOfDoc(this.current.doc) === text) this.compositionStep(text, c.from + data.length)
  }

  /** A composition ends without a view; what it inserted is made canonical now. */
  compositionEnd() {
    this.composingHeadless = false
    this.settleComposition()
  }

  /**
   * One update of the composition: the text now `text`, the caret at `caret`. Applied to the
   * replay at once, as the canvas handles it (`textareaInputContent`, from the selection the
   * previous update left, collapsed at its caret), so each update costs one step whatever the
   * length of the composition. A first update over a selection counts even when its text is
   * the selected text, as it does on the canvas.
   */
  private compositionStep(text: string, caret: number) {
    const c = this.composition
    if (!c) return
    const r = c.replay
    const content = text !== r.content.text || r.from !== r.to ? textareaInputContent(r.content, this.baseFont, r.from, r.to, text, caret, c.pending) : r.content
    c.replay = { content, from: caret, to: caret }
    c.steps++
  }

  /** ProseMirror's pending reading of the DOM, done now (what an IME put there is a step of its composition). */
  private flushDom() {
    ;(this.mounted?.view as unknown as { domObserver?: { flush(): void } } | undefined)?.domObserver?.flush()
  }

  /** Once no composition is in progress, replays the last one and makes what it inserted canonical (`canonicalGuard`). */
  private settleComposition() {
    if (this.done || this.composing) return
    if (!owesCanonical(this.current) && !this.replacing && !this.composition) return
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
    else this.reportChange()
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
    const steps = tr.mapping.maps.length
    tr.replaceRange(pos, pos, arriving)
    const inserted = tr.mapping.slice(steps)
    tr.setSelection(TextSelection.create(tr.doc, inserted.map(pos, -1), inserted.map(pos, 1)))
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

  /**
   * Gives a plain-text paste (or plain text dropped from elsewhere), and typing, Enter or a
   * deletion over a selection (`META.replaced`), their marks exactly as today's canvas does.
   */
  /** The content the selection replacement in progress (`replacing`) leaves with the text `state` now holds; null when there is none or the text no longer fits it. */
  private replacementResult(state: EditorState): CompactContent | null {
    const rec = this.replacing
    if (!rec) return null
    const text = plainTextOfDoc(state.doc)
    const old = rec.old.text
    if (text === old) return null // nothing replaced yet (or a composition cancelled)
    const length = text.length - (old.length - (rec.to - rec.from))
    if (length < 0 || text.slice(0, rec.from) !== old.slice(0, rec.from) || text.slice(rec.from + length) !== old.slice(rec.to)) return null
    return plainPasteContent(rec.old, this.baseFont, rec.from, rec.to, text.slice(rec.from, rec.from + length), rec.pending)
  }

  /**
   * The content the composition in progress leaves with the text `state` now holds: its
   * updates replayed from the text it started on, each as today's canvas handles it
   * (`textareaInputContent`, the selection collapsed at the end of the previous update).
   * Null when there is none, or the text is back to what it was (a cancelled composition).
   */
  private compositionResult(state: EditorState): CompactContent | null {
    const c = this.composition
    if (!c) return null
    const text = plainTextOfDoc(state.doc)
    if (text === c.start.text) return null
    const r = c.replay
    if (r.content.text === text) return r.content
    // A change the composition has not reported as an update yet (read but not recorded): one more step, not kept.
    return textareaInputContent(r.content, this.baseFont, r.from, r.to, text, textOffsetAt(state.doc, state.selection.to, 1), c.pending)
  }

  /** Gives every block of `doc` the runs of `want` (same text). True when anything changed. */
  private imposeContent(tr: Transaction, doc: PMNode, want: CompactContent): boolean {
    const expected = docFromBlocks(legacyToBlocks(want.text, want, this.baseFont))
    let changed = false
    doc.forEach((block, offset, i) => {
      const b = blockOf(expected.child(i))
      const runs = b.type === 'paragraph' || b.type === 'heading' ? (b.content ?? []) : []
      if (imposeRuns(tr, block, offset + 1, runs)) changed = true
    })
    return changed
  }

  /**
   * Any other change that replaces a non-empty selection with text: an IME composition (the
   * text is known when it ends; `SETTLE` or `finish`), an insertion with no keydown, or the
   * browser's own editing. Not a paste or a drop, which have their own rules, nor in-edit undo.
   */
  private otherReplacement(trs: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
    const root = trs[0]!
    if (trs.some(isHistoryTransaction)) {
      this.replacing = null
      return null
    }
    if (!this.replacing) {
      const sel = oldState.selection
      const insertsText = root.steps.some((st) => st instanceof ReplaceStep) && root.getMeta('paste') !== true && root.getMeta('uiEvent') !== 'drop' && root.getMeta(META.levelsSet) !== true
      if (!insertsText || sel.empty || !(sel instanceof TextSelection)) return null
      if (plainTextOfDoc(oldState.doc) === plainTextOfDoc(newState.doc)) return null
      const old = contentFromDoc(oldState.doc, this.box)
      this.replacing = { old: { text: old.text, spans: old.spans, headings: old.headings }, from: textOffsetAt(oldState.doc, sel.from, -1), to: textOffsetAt(oldState.doc, sel.to, 1), pending: pendingOf(oldState) }
    }
    if ((this.composing || this.compositionStarting) && !trs.some((t) => t.getMeta(SETTLE) === 'force')) return null
    const rec = this.replacing
    const want = this.replacementResult(newState)
    this.replacing = null
    // A composition that changed nothing (cancelled over a selection on one line) replaced nothing.
    if (!want || rec === null || plainTextOfDoc(newState.doc) === rec.old.text) return null
    const tr = newState.tr
    return this.imposeContent(tr, newState.doc, want) ? tr : null
  }

  private pastePlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('yuriful-plain-paste'),
      appendTransaction: (trs, oldState, newState) => {
        const root = trs[0]
        if (!root || root.getMeta('appendedTransaction')) return null
        if (this.composition) {
          const force = trs.some((t) => t.getMeta(SETTLE) === 'force')
          if (!force && (this.composing || this.compositionStarting || trs.some(isHistoryTransaction))) return null
          const want = this.compositionResult(newState)
          this.composition = null
          const tr = newState.tr
          return want && want.text === plainTextOfDoc(newState.doc) && this.imposeContent(tr, newState.doc, want) ? tr : null
        }
        const replaced = root.getMeta(META.replaced) as { text: string; from: number; to: number } | undefined
        const drop = !replaced && root.getMeta('uiEvent') === 'drop'
        const rec = replaced ? { ...replaced, pending: pendingOf(oldState) } : this.plainPaste && (root.getMeta('paste') === true || drop) ? this.plainPaste : null
        if (!rec) return this.otherReplacement(trs, oldState, newState)
        this.replacing = null
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
        const tr = newState.tr
        return this.imposeContent(tr, newState.doc, want) ? tr : null
      },
    })
  }

  /**
   * The editing keys (`editKeys`), for real key presses only. ProseMirror reads some DOM
   * changes, such as an IME removing a character of its candidate, as a Backspace and offers
   * it to the key handlers as a made-up event; the custom Backspace and Delete would then
   * delete a character of their own. Such events, and every key while a composition is open,
   * are left to the browser and the IME: what they put in the text is what is stored.
   */
  private keysPlugin(): Plugin {
    const keys = keydownHandler(editKeys)
    return new Plugin({
      key: new PluginKey('yuriful-edit-keys'),
      props: {
        handleKeyDown: (view, e) => {
          if (view.composing || this.composing || !(e instanceof KeyboardEvent)) return false
          return keys(view, e)
        },
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
          compositionstart: () => {
            this.beginComposition()
            return false
          },
          compositionupdate: (_view, e) => {
            this.sameTextUpdate((e as CompositionEvent).data ?? '')
            return false
          },
          compositionend: () => {
            // The committed text is read now, while ProseMirror still counts the composition as
            // open, so it is the composition's last step; the composition is settled straight
            // after ProseMirror's own handling of this event (a microtask, no timer).
            this.flushDom()
            queueMicrotask(() => this.settleComposition())
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
    // A composition still in progress ends here: its text is made canonical first, exactly as
    // when it ends by itself, so the record and the static HTML are the final ones.
    this.flushDom()
    if ((owesCanonical(this.current) || this.replacing || this.composition) && this.editable) this.dispatch(this.current.tr.setMeta(SETTLE, 'force'))
    this.done = true
    this.revert = null
    this.typed = null
    const m = this.mounted
    this.mounted = null
    if (!m) return
    m.view.destroy()
    for (const a of Array.from(m.el.attributes)) if (!m.attrs.some(([name]) => name === a.name)) m.el.removeAttribute(a.name)
    for (const [name, value] of m.attrs) m.el.setAttribute(name, value)
    renderStaticInto(m.el, docFromText(this.content())?.doc ?? settledDoc(this.current, this.baseFont))
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

function marksOfElement(el: Element, inherited: PasteMarks, inHeading: boolean): PasteMarks {
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
  if (inHeading || HEADINGS.has(tag)) m.bold = true // all of a heading's text arrives bold, whatever weight anything in it declares
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
  /** `para`: inside a block that holds text (not a list, table or the body), where spaces are content. */
  const walk = (node: Node, inherited: PasteMarks, pre: boolean, para: boolean, heading: boolean) => {
    // Whitespace beside block elements is layout between them, even inside a block.
    const blocksInside = Array.from(node.childNodes).some((c) => c.nodeType === 1 && BLOCKS.has((c as Element).localName))
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
        // Whitespace between blocks, or layout whitespace running across a source line break, is not text.
        if (line === null && /^[ \t\n\r\f]*$/.test(raw) && (!para || blocksInside || /[\r\n]/.test(raw))) return
        ensureLine().push({ text: raw.replace(/[ \t\f]*[\r\n][ \t\n\r\f]*/g, ' '), marks: inherited })
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
      const inHeading = heading || HEADINGS.has(tag)
      walk(el, marksOfElement(el, inherited, inHeading), pre || tag === 'pre', block ? !CONTAINERS.has(tag) : para, inHeading)
      if (block && !CONTAINERS.has(tag) && lines.length === before) lines.push([]) // an empty paragraph is an empty line
      if (block) line = null
    })
  }
  walk(inert.body, {}, false, false, false)
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
