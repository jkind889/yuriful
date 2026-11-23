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
import { DEFAULT_FONT, canonicalTextFormatting, headingsAfterEdit, splitGraphemes } from '../model/richText.ts'
import type { Mark, TextFormatting } from '../model/richText.ts'
import { legacyToBlocks } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { FontId } from '../model/types.ts'
import { blockOf, boxOf, contentFromDoc, docFromBlocks, docFromText, fontOf, marks, nodes, plainTextOfDoc, posAtTextOffset, renderStaticInto, textOffsetAt, textSchema } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import {
  META,
  applyPending,
  canonicalGuard,
  canonicalizeDoc,
  completesShortcut,
  editKeys,
  imposeRuns,
  lineLevels,
  linesOfSelection,
  normalPending,
  pendingKey,
  pendingMarks,
  pendingOf,
  plainPasteContent,
  selectionFormat,
  setLevels,
  setLinesLevel,
  setRangeFont,
  shortcutTransaction,
  togglePendingMark,
  toggleRangeMark,
  typedMarks,
  replacedRange,
  selectionOnCharacters,
} from './textRules.ts'
import type { CompactContent, FormatReadout, Pending } from './textRules.ts'

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
 *
 * IME composition: while a composition is open the browser and ProseMirror own the text. The
 * session dispatches nothing, reads nothing from the DOM and leaves the selection alone; its
 * own rules (line levels, canonical marks, selection on whole characters) and every command
 * issued meanwhile wait. Once a composition, or a run of them back to back, has ended, one
 * follow-up brings the document to canonical form (`followUp`), then the waiting commands
 * run in order. `content()` always gives the record that follow-up leaves, computed without
 * touching the document, so a save taken at any moment stores a canonical record.
 */

/** After a composition ends, how long to wait for ProseMirror to finish ending it (it does so 20 ms later) and for another composition to start straight after, before the follow-up. */
const FOLLOW_UP_MS = 30

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
  /** Headless compositions are numbered like ProseMirror's (its `composition` transaction metadata), so that each one and its follow-up are one history step. */
  private headlessCompositions = 0
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
   * (an insertion with no keydown, the browser's own editing; never a composition): the text
   * before it, the replaced range and the pending choices. Styled as today's canvas styles it
   * once the text is known (`otherReplacement`).
   */
  private replacing: { old: CompactContent; from: number; to: number; pending: Pending | null } | null = null
  /** Between `compositionstart` and `compositionend` (ProseMirror's own `composing` starts a little later). */
  private imeOpen = false
  /**
   * The run of compositions whose follow-up is owed: the text, line levels and selection
   * before the first of them, and the marks composed text takes (rule R5: at a caret what
   * typed text would get, pending choices included; over a selection those of its first
   * character).
   */
  private imeRun: {
    text: string
    levels: number[]
    from: number
    to: number
    marks: readonly PMMark[]
    /** What the compositions of the run committed, in order (`compositionend` data). */
    commits: string
    /** Only compositions, each starting where the previous one's commit ended: the committed text is known exactly. */
    plain: boolean
  } | null = null
  private followUpTimer: ReturnType<typeof setTimeout> | null = null
  /** Commands issued while a composition is open, run in order by the follow-up. */
  private queued: Array<() => void> = []
  /** ProseMirror's `composition` metadata on its last composition transaction (the follow-up joins that history step). */
  private lastComposition: unknown = undefined
  /** A plain-text paste in progress: what it pastes, where, and with which pending choices. */  /** A plain-text paste in progress: what it pastes, where, and with which pending choices. */
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
        lineLevels({ busy: () => this.busy }),
        this.pastePlugin(),
        canonicalGuard({ baseFont: () => this.baseFont, busy: () => this.busy }),
        pendingMarks({ baseFont: () => this.baseFont, afterHistory: (redone, depth) => (redone ? (this.conversions.get(depth) ?? null) : null), busy: () => this.busy }),
        selectionOnCharacters({ busy: () => this.busy }),
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
  /** An IME composition is open. */
  get composing(): boolean {
    return this.imeOpen || (this.mounted?.view.composing ?? false) || this.composingHeadless
  }
  /** A composition is open, or the follow-up of the last run of them is still owed: the session's own rules wait. */
  private get busy(): boolean {
    return this.composing || this.imeRun !== null
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
   * record's own until something changed. During a composition, or while its follow-up is
   * owed, it is the record the follow-up will leave (`followUpTransaction`), computed
   * without touching the document.
   */
  content(): TextContent {
    const doc = this.imeRun ? this.followUpTransaction(this.current).doc : this.current.doc
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
    if (this.composingHeadless && tr.getMeta('composition') === undefined) tr.setMeta('composition', `headless-${this.headlessCompositions}`)
    const before = this.current
    const { state, transactions } = this.current.applyTransaction(tr)
    this.plainPaste = null
    if (transactions.length === 0) return
    this.current = state
    this.trackHistory(before, state, transactions)
    for (const t of transactions) if (t.getMeta('composition') !== undefined) this.lastComposition = t.getMeta('composition')
    this.mounted?.view.updateState(state)
    if (transactions.some((t) => t.steps.some((st) => st instanceof ReplaceStep))) this.storedBreaks = null // the text was typed into
    // Any change of the text or move of the caret ends "straight after a shortcut" (in-edit
    // undo included), except the shortcut's own conversion.
    if ((tr.docChanged || tr.selectionSet) && tr.getMeta(META.shortcutApplied) !== true) this.revert = null
    if (transactions.some((t) => t.docChanged)) this.reportChange()
    this.hooks.onSelectionChange?.(this)
    // A change during a run that is not part of a composition (a key typed straight after a
    // commit): the committed text alone no longer says what the text should be.
    if (this.imeRun && !this.composing && transactions.some((t) => t.docChanged && t.getMeta('composition') === undefined)) this.imeRun.plain = false
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

  /**
   * Runs a session command now, or, while a composition is open or its follow-up is still
   * owed, queues it to run (in order) right after the follow-up; a queued command returns
   * false. Nothing of the session touches the document until ProseMirror has finished ending
   * the composition (it reads the selection back from the DOM 20 ms after it ends).
   */
  private whenSettled(command: () => boolean): boolean {
    if (this.done) return false
    if (this.busy) {
      this.queued.push(() => void command())
      return false
    }
    return command()
  }

  /** Runs a ProseMirror command on the session (waits for a composition, see `whenSettled`). */
  run(cmd: Command): boolean {
    return this.whenSettled(() => this.editable && cmd(this.current, (tr) => this.dispatch(tr), this.view ?? undefined))
  }

  /** Puts the caret (or a range, `anchor` to `head`) at UTF-16 offsets into the text, never inside a character (see `onCharacter`). Waits for a composition. */
  select(anchor: number, head = anchor) {
    this.whenSettled(() => {
      const doc = this.current.doc
      const text = plainTextOfDoc(doc)
      const at = (o: number) => posAtTextOffset(doc, onCharacter(text, o))
      this.dispatch(this.current.tr.setSelection(TextSelection.create(doc, at(anchor), at(head))))
      return true
    })
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
    if (!this.editable || composing || this.busy) return false
    const sel = this.current.selection
    if (!sel.empty && from === sel.from && to === sel.to && text.length > 0) {
      // Typing over a selection: styled exactly as today's canvas styles it (`META.replaced`).
      this.dispatch(this.current.tr.insertText(text, from, to).setMeta(META.replaced, replacedRange(this.current, normalBreaks(text))))
      return true
    }
    if (!sel.empty || sel.from !== from || from !== to) return false
    const shortcut = typed !== null && text === typed && text.length === 1 && (this.hooks.canFireShortcut?.(this) ?? true) && completesShortcut(this.current, from, text)
    if (!shortcut) {
      // Pending choices go to what is typed (they are not ProseMirror's stored marks).
      if (!typedMarks(this.current, this.baseFont)) return false
      this.dispatch(this.typedTransaction(text, from, to))
      return true
    }
    this.dispatch(this.typedTransaction(text, from, to))
    const pendingBefore = pendingOf(this.current)
    const tr = shortcutTransaction(this.current, text)
    if (tr) {
      this.dispatch(tr)
      this.revert = { pending: pendingBefore }
      this.conversions.set(undoDepth(this.current) as number, pendingOf(this.current))
    }
    return true
  }

  /** `text` typed at the caret, with the pending choices (`typedMarks`). */
  private typedTransaction(text: string, from: number, to: number): Transaction {
    const tr = this.current.tr
    const set = typedMarks(this.current, this.baseFont)
    if (set) tr.setStoredMarks(set)
    return tr.insertText(text, from, to)
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

  /** A composition starts without a view (a mounted view reports its own). */
  compositionStart() {
    this.beginComposition()
    this.headlessCompositions++
    this.composingHeadless = true
  }

  /**
   * A composition ends without a view: the follow-up runs at once. `committed` is what it
   * committed (a mounted view takes it from `compositionend`); without it the committed text is
   * not known and the follow-up never repairs the text.
   */
  compositionEnd(committed?: string) {
    this.composingHeadless = false
    if (this.imeRun) {
      if (committed === undefined) this.imeRun.plain = false
      else this.imeRun.commits += committed
    }
    this.followUp()
  }

  /**
   * A composition starts. Only plain state is remembered, and only for the first of a run of
   * compositions back to back: the text, line levels and selection before it, and the marks
   * its text will take. Nothing in the document or the DOM is touched.
   */
  private beginComposition() {
    if (this.done) return
    if (this.followUpTimer !== null) {
      clearTimeout(this.followUpTimer)
      this.followUpTimer = null
    }
    // A start while a composition is still open (no compositionend between) is the browser
    // starting it again (Chromium does so when the first candidate replaces a selection that
    // crosses formatting): the same composition goes on.
    if (this.imeRun && this.imeOpen) return
    if (this.imeRun) {
      // Back to back: the run goes on, its follow-up after the last. It stays plain only when
      // this composition starts with nothing selected where the previous commit ended.
      const run = this.imeRun
      const sel = this.current.selection
      if (!sel.empty || textOffsetAt(this.current.doc, sel.head, 1) !== run.from + run.commits.length) run.plain = false
      return
    }
    const state = this.current
    const doc = state.doc
    const levels: number[] = []
    doc.forEach((block) => {
      levels.push(block.type === nodes.heading ? (block.attrs.level as number) : 0)
    })
    const sel = state.selection
    let composedMarks: readonly PMMark[]
    if (sel instanceof TextSelection && sel.$cursor) composedMarks = applyPending(sel.$cursor.marks(), pendingOf(state), this.baseFont)
    else {
      const $from = sel.$from
      const first = $from.parent.isTextblock && $from.parentOffset < $from.parent.content.size ? $from.parent.childAfter($from.parentOffset).node : null
      composedMarks = first?.isText ? first.marks : [] // a selection starting at a line break: no marks, like the break
    }
    this.imeRun = { text: plainTextOfDoc(doc), levels, from: textOffsetAt(doc, sel.from, -1), to: textOffsetAt(doc, sel.to, 1), marks: composedMarks, commits: '', plain: true }
  }

  /**
   * The follow-up of the run of compositions in progress, as a transaction on `state`, not
   * dispatched: every line gets today's level for the change from the text and levels before
   * the run to the text and caret now (`headingsAfterEdit`); the composed text, when the
   * change is a clean replacement of the selection the run started on, takes the run's marks
   * (rule R5); the touched blocks are made canonical. It joins ProseMirror's history step for
   * the composition. A run that left the text as it was restores the levels and nothing else.
   */
  private followUpTransaction(state: EditorState): Transaction {
    const run = this.imeRun
    const tr = state.tr.setMeta(META.levelsSet, true)
    if (this.lastComposition !== undefined) tr.setMeta('composition', this.lastComposition)
    if (!run) return tr
    let text = plainTextOfDoc(state.doc)
    // Repair: ProseMirror can keep a stale candidate when a composition replaces a selection
    // that crosses formatting (`AbCD`, `Ab` selected, `ㄱ` → `가` → `각`, commit `가`
    // leaves `ㄱ가CD`). When the run was compositions only and the browser reported what they
    // committed, the text must be the text before the run with the selection replaced by that;
    // the composed region is set to it, the caret after it, as the canvas has them.
    const prefix = run.text.slice(0, run.from)
    const suffix = run.text.slice(run.to)
    const wanted = prefix + run.commits + suffix
    if (run.plain && !this.composing && text !== wanted && text.startsWith(prefix) && text.endsWith(suffix) && text.length >= prefix.length + suffix.length) {
      const from = posAtTextOffset(tr.doc, prefix.length)
      const to = posAtTextOffset(tr.doc, text.length - suffix.length)
      tr.insertText(run.commits, from, to)
      tr.setSelection(TextSelection.create(tr.doc, posAtTextOffset(tr.doc, prefix.length + run.commits.length)))
      text = wanted
    }
    setLevels(tr, headingsAfterEdit(run.text, run.levels, text, textOffsetAt(tr.doc, tr.selection.to, 1)))
    const length = text.length - (run.text.length - (run.to - run.from))
    const clean = text !== run.text && length >= 0 && text.slice(0, run.from) === run.text.slice(0, run.from) && text.slice(run.from + length) === run.text.slice(run.to)
    if (!clean) {
      canonicalizeDoc(tr, this.baseFont, [])
      return tr
    }
    const from = posAtTextOffset(tr.doc, run.from)
    const to = posAtTextOffset(tr.doc, run.from + length)
    if (to > from) {
      tr.removeMark(from, to)
      for (const m of run.marks) tr.addMark(from, to, m)
    }
    canonicalizeDoc(tr, this.baseFont, to > from ? [{ from, to }] : [], { from, to })
    return tr
  }

  /** After a composition ends: the follow-up once ProseMirror has finished ending it, unless another composition starts first. */
  private scheduleFollowUp() {
    if (this.followUpTimer !== null) clearTimeout(this.followUpTimer)
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = null
      this.followUp()
    }, FOLLOW_UP_MS)
  }

  /**
   * Once no composition is open: the follow-up of the last run (one transaction; the session's
   * own plugins then snap the selection and sync the pending marks), then the commands queued
   * meanwhile, in order. On a read-only board the follow-up only brings the session's own
   * document to the canonical form `content()` already gave; nothing is reported.
   */
  private followUp() {
    if (this.followUpTimer !== null) {
      clearTimeout(this.followUpTimer)
      this.followUpTimer = null
    }
    if (this.composing || !this.imeRun) return
    const tr = this.followUpTransaction(this.current)
    this.imeRun = null
    if (this.editable) this.dispatch(tr)
    else {
      this.current = this.current.apply(tr)
      this.mounted?.view.updateState(this.current)
    }
    const queued = this.queued
    this.queued = []
    for (const command of queued) command()
  }

  // ---- formatting -------------------------------------------------------------------------------

  /**
   * Bold, italic, underline or strikethrough: on the selected range (off if every character
   * has it, otherwise on; bold never changes in heading lines), or with only a caret chosen
   * for what is typed next. True when anything changed.
   */
  toggleMark(mark: Mark): boolean {
    return this.whenSettled(() => this.toggleMarkNow(mark))
  }

  private toggleMarkNow(mark: Mark): boolean {
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
    return this.whenSettled(() => this.setHeadingNow(level))
  }

  private setHeadingNow(level: 0 | 1 | 2 | 3): boolean {
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
    return this.whenSettled(() => this.setFontNow(font))
  }

  private setFontNow(font: FontId): boolean {
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
    return this.whenSettled(() => this.setBoxNow(box))
  }

  private setBoxNow(box: TextFormatting): boolean {
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
    return this.whenSettled(() => this.editable && undo(this.current, (tr) => this.dispatch(tr)))
  }

  redo(): boolean {
    return this.whenSettled(() => this.editable && redo(this.current, (tr) => this.dispatch(tr)))
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
    return this.whenSettled(() => this.pasteNow(data))
  }

  private pasteNow(data: PasteData): boolean {
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
    return this.whenSettled(() => this.dropNow(slice, at, moveFrom))
  }

  private dropNow(slice: Slice, at: number, moveFrom?: { from: number; to: number }): boolean {
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
   * Any other change that replaces a non-empty selection with text: an insertion with no
   * keydown, or the browser's own editing. Not a composition (its follow-up applies rule R5),
   * a paste or a drop, which have their own rules, nor in-edit undo.
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
    const rec = this.replacing
    const want = this.replacementResult(newState)
    this.replacing = null
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
        if (this.busy) {
          this.replacing = null
          return null
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
            this.imeOpen = true
            return false
          },
          compositionend: (_view, e) => {
            this.imeOpen = false
            if (this.imeRun) this.imeRun.commits += (e as CompositionEvent).data ?? ''
            this.scheduleFollowUp()
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
    const m = this.mounted
    this.mounted = null
    // A composition still open ends with the view (`EditorView.destroy`): what the candidate
    // shows stays, as on the canvas (ProseMirror has read every update into the document).
    // Then the follow-up and any queued commands, so the record and the static HTML are final.
    if (this.composing && this.imeRun) this.imeRun.plain = false // nothing committed: the candidate stays as shown
    this.imeOpen = false
    this.composingHeadless = false
    if (m) {
      m.view.destroy()
      for (const a of Array.from(m.el.attributes)) if (!m.attrs.some(([name]) => name === a.name)) m.el.removeAttribute(a.name)
      for (const [name, value] of m.attrs) m.el.setAttribute(name, value)
    }
    this.followUp()
    this.done = true
    this.revert = null
    this.typed = null
    if (!m) return
    renderStaticInto(m.el, docFromText(this.content())?.doc ?? this.current.doc)
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
