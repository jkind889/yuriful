import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
import { keydownHandler } from 'prosemirror-keymap'
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, Slice } from 'prosemirror-model'
import type { Mark as PMMark, Node as PMNode, ParseOptions, ResolvedPos } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state'
import type { Command, Transaction } from 'prosemirror-state'
import { ReplaceStep } from 'prosemirror-transform'
import { DecorationSet, EditorView } from 'prosemirror-view'
import type { NodeView } from 'prosemirror-view'
import { resolveEditingShortcut, typedCharacter } from '../input/shortcuts.ts'
import type { KeyEventLike } from '../input/shortcuts.ts'
import { DEFAULT_FONT, canonicalTextFormatting, splitGraphemes } from '../model/richText.ts'
import type { Mark, TextFormatting } from '../model/richText.ts'
import { legacyToBlocks } from '../model/textDoc.ts'
import type { TextContent } from '../model/textDoc.ts'
import type { FontId } from '../model/types.ts'
import { blockOf, boxOf, contentFromDoc, docFromBlocks, docFromText, exceedsBounds, fontOf, isCompactDoc, marks, nodes, plainTextOfDoc, posAtTextOffset, renderStaticInto, taskItemDOM, textOffsetAt, textSchema, textblocksOf } from './textSchema.ts'
import type { TextSource } from './textSchema.ts'
import {
  META,
  applyPending,
  canonicalGuard,
  canonicalizeDoc,
  completesShortcut,
  deleteSelected,
  editKeys,
  imposeRuns,
  indentItem,
  inListItem,
  insertDivider,
  insertedRanges,
  lineLevels,
  outdentItem,
  linesOfSelection,
  normalPending,
  pendingKey,
  pendingMarks,
  pendingOf,
  plainPasteContent,
  selectionBlocks,
  selectionFormat,
  setLinesLevel,
  setRangeFont,
  shortcutTransaction,
  toggleCodeBlock,
  toggleList,
  togglePendingMark,
  toggleQuote,
  toggleRangeMark,
  toggleTaskAt,
  typedMarks,
  replacedRange,
  settleReplacement,
  selectionOnCharacters,
} from './textRules.ts'
import type { BlockKind, BlockReadout, CompactContent, FormatReadout, Pending, ReplacementInput } from './textRules.ts'

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
 * IME composition: a composition never starts over a selection. At `compositionstart` a
 * selection is deleted, as an ordinary edit, before the browser puts its first candidate in,
 * so every composition runs at a plain caret (the selection is the one the browser shows then,
 * which the session's own can lag behind); a composition that composes nothing gives the
 * selection back. While it is open the browser and ProseMirror own the text: the session
 * dispatches nothing, reads nothing from the DOM, and its own rules (line levels, canonical
 * marks, selection on whole characters) change nothing; a session command issued then is
 * refused and never runs later. It ends with `compositionend`, the edit losing focus, or
 * `finish()`. The text each composition put in is tracked as a range with the marks it takes
 * (rule R5). Straight after `compositionend`, once ProseMirror has read the composition's last
 * changes and before any other input can arrive, one follow-up gives those ranges their marks
 * and makes the document canonical, never changing a character; it joins the composition's
 * undo step, and is dropped if an undo or redo comes first. `content()` is that follow-up
 * applied to the current document, computed without touching it, so a save taken at any
 * moment stores a canonical record of exactly the text shown.
 */

/** Keys that move the caret (with any modifiers): only they put it at the start of the text as the person's own move (`keepMoveToStart`). */
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

/**
 * How long after a caret-movement key its move to the start of the text is still taken as the
 * person's own (`keepMoveToStart`). The key must also be the last one since the editor gained
 * focus, so a browser reset on focus is never taken for it.
 */
const CARET_KEY_MOVE_MS = 150

/** Transaction metadata of the follow-up (it carries ProseMirror's `composition` metadata too, to join the composition's history step). */
const FOLLOW_UP = 'yuriful-composition-follow-up'

/** The view-only decorations of a mounted session (`EditSessionOptions.decorate`): never part of the document, its history or its record. */
const decorationsKey = new PluginKey<{ set: DecorationSet; stale: boolean }>('yuriful-view-decorations')

/** Text a composition put in, with the marks it takes (rule R5). */
interface ComposedRange {
  from: number
  to: number
  marks: readonly PMMark[]
  /** Its composition is open: the range grows with what it composes. */
  open: boolean
  /** ProseMirror's `composition` metadata on its transactions: its last reading of the DOM, after `compositionend`, still belongs to it. */
  meta: unknown
}

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

export interface EditSessionOptions {
  /** The caret, as a UTF-16 offset into the text (default: its end). */
  caret?: number
  content?: TextContent
  /**
   * How the mounted view draws the document beyond the schema's own DOM (the card's no-wrap words
   * and tabs): decorations only, never part of the document, its history or its record. Worked out
   * again after every change of the document and on `redecorate()`; while an IME composition is
   * open the last ones are kept, mapped through its changes, so nothing is drawn again around it.
   */
  decorate?: (doc: PMNode) => DecorationSet
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

/** The words of pasted HTML as plain text, one line per line it shows (through the same inert sanitizer as an HTML paste). */
function htmlPlainText(html: string): string {
  const body = new DOMParser().parseFromString(sanitizePastedHTML(html), 'text/html').body
  return Array.from(body.children, (p) => p.textContent ?? '').join('\n')
}

/** Pasted plain text with one "\n" per line break, as the canvas's textarea holds it. */
const normalBreaks = (text: string) => text.replace(/\r\n?/g, '\n')

/** A selection from `anchor` to `head` (positions), or the start of a document with no line to put a caret in (only a divider). */
function selectionAt(doc: PMNode, anchor: number, head = anchor): Selection {
  return textblocksOf(doc).length > 0 ? TextSelection.create(doc, anchor, head) : Selection.atStart(doc)
}

/**
 * A checklist item in the live editor: exactly the DOM its `toDOM` gives the static card
 * (`taskItemDOM`), with the box answering a press: the item is checked or unchecked as a change
 * of the edit (`toggle`), and the press does nothing else (no caret move, no focus change).
 */
class TaskItemView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private readonly box: HTMLElement
  constructor(
    node: PMNode,
    private readonly getPos: () => number | undefined,
    private readonly toggle: (pos: number) => void,
  ) {
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, taskItemDOM(node.attrs.checked === true))
    this.dom = dom as HTMLElement
    this.contentDOM = contentDOM as HTMLElement
    this.box = this.dom.firstElementChild as HTMLElement
    this.box.addEventListener('mousedown', this.onPress)
  }

  private readonly onPress = (e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const pos = this.getPos()
    if (pos !== undefined) this.toggle(pos)
  }

  update(node: PMNode): boolean {
    if (node.type !== nodes.taskItem) return false
    this.dom.setAttribute('data-checked', String(node.attrs.checked === true))
    return true
  }

  stopEvent(e: Event): boolean {
    return e.target instanceof Node && this.box.contains(e.target)
  }

  ignoreMutation(m: { type: string; target: Node }): boolean {
    return (m.type === 'attributes' && m.target === this.dom) || this.box.contains(m.target)
  }

  destroy() {
    this.box.removeEventListener('mousedown', this.onPress)
  }
}

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
  /**
   * Everything the session holds that a composition can change (its state, history included, the
   * conversions kept beside the history, the stored line breaks), as it was just before the
   * composition awaiting its follow-up changed anything (`beginComposition`): a composition refused
   * at a bound puts it all back (`followUp`). Until that follow-up.
   */
  private imeStart: { state: EditorState; conversions: Map<number, Pending | null>; storedBreaks: string | null } | null = null
  /** The deletion that starts the composition awaiting its follow-up was refused: the composition is taken back when it ends, and until then never reaches a record. */
  private imeRefused = false
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
   * The text the compositions since the last follow-up put in, each range with the marks it
   * takes (rule R5: at a caret what typed text would get, pending choices included; over a
   * selection those of its first character), mapped through every transaction since.
   */
  private composed: ComposedRange[] = []
  /** The selection deleted at the start of the composition in progress (`beginComposition`): the states before and after, and whether any composed text has arrived since. */
  private deletion: { before: EditorState; after: EditorState; delivered: boolean } | null = null
  /** Counts compositions ending, so that a follow-up queued for one that another has followed does nothing. */
  private endings = 0
  /**
   * When a caret-movement key (`CARET_KEYS`) went down in the edited text, if it is the last key
   * pressed there since the editor last gained focus (`performance.now()`; otherwise -Infinity).
   */
  private caretKeyAt = -Infinity
  /** ProseMirror's `composition` metadata on its last composition transaction (the follow-up joins that history step). */
  private lastComposition: unknown = undefined
  /** What is being pasted (the slice as it arrives), for `settleSelectionReplacement`. */
  private pastedSlice: Slice | null = null
  /** A plain-text paste in progress: what it pastes, where, and with which pending choices. */
  private plainPaste: { text: string; from: number; to: number; pending: Pending | null } | null = null
  /** Where a drop in progress lands (from the drop event), for the destination font. */
  private dropPos: number | null = null
  private cached: { state: EditorState; box: TextFormatting; start: EditSession['imeStart']; content: TextContent } | null = null
  /**
   * A stored text with "\r\n" line breaks keeps them until its text is changed: today the
   * editing textarea turns them into "\n" only on the first keystroke, so formatting alone
   * stores the "\r\n" text.
   */
  private storedBreaks: string | null

  constructor(doc: PMNode, box: TextFormatting, hooks: EditSessionHooks = {}, opts: EditSessionOptions = {}) {
    this.box = boxOf(box)
    this.hooks = hooks
    this.initial = { doc, box: this.box, content: opts.content ?? contentFromDoc(doc, this.box) }
    this.storedBreaks = this.initial.content.text.includes('\r\n') ? this.initial.content.text : null
    this.reported = JSON.stringify(this.initial.content)
    const caret = posAtTextOffset(doc, onCharacter(plainTextOfDoc(doc), opts.caret ?? Number.MAX_SAFE_INTEGER))
    this.current = EditorState.create({
      schema: textSchema,
      doc,
      selection: selectionAt(doc, caret),
      plugins: [
        this.inputPlugin(),
        this.keysPlugin(),
        // Before the pending choices, which read the new undo depth (`pendingMarks`).
        history(),
        this.redoSelectionPlugin(),
        lineLevels({ busy: () => this.busy }),
        this.pastePlugin(),
        canonicalGuard({ baseFont: () => this.baseFont, busy: () => this.busy }),
        pendingMarks({ baseFont: () => this.baseFont, afterHistory: (redone, depth) => (redone ? (this.conversions.get(depth) ?? null) : null), busy: () => this.busy }),
        selectionOnCharacters({ busy: () => this.busy }),
        this.boundsPlugin(),
        ...(opts.decorate ? [this.decorationsPlugin(opts.decorate)] : []),
      ],
    })
  }

  /**
   * Nothing over a bound is ever written (plan Section 5): a change whose result would be stored as
   * `blocks` and go over a bound a load enforces (depth, nodes, characters: `exceedsBounds`) is
   * refused, so the keystroke, paste or command simply does not happen. Not while an IME composition
   * is open, when refusing what the browser already shows would put the page and the session out of
   * step (the store still refuses to write such a text).
   */
  private boundsPlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('yuriful-bounds'),
      filterTransaction: (tr) => !tr.docChanged || this.busy || !exceedsBounds(tr.doc, this.baseFont),
    })
  }

  /**
   * The view-only decorations (`EditSessionOptions.decorate`), held as plugin state so that they
   * map through every transaction: worked out again when the document changed or `redecorate()`
   * asked, except while a composition is open, when they are only mapped (and worked out again by
   * the first transaction after it).
   */
  private decorationsPlugin(decorate: (doc: PMNode) => DecorationSet): Plugin {
    return new Plugin({
      key: decorationsKey,
      state: {
        init: (_config, state) => ({ set: decorate(state.doc), stale: false }),
        apply: (tr, old, _oldState, state) => {
          if (this.busy) return { set: old.set.map(tr.mapping, tr.doc), stale: old.stale || tr.docChanged }
          if (old.stale || tr.docChanged || tr.getMeta(decorationsKey) === true) return { set: decorate(state.doc), stale: false }
          return old
        },
      },
      props: { decorations: (state) => decorationsKey.getState(state)?.set },
    })
  }

  /**
   * Works the view-only decorations out again (what they depend on outside the document changed:
   * the box's width or size). Changes nothing else: not the document, the selection, the history,
   * the pending choices or the shortcut revert. Nothing while a composition is open (they are
   * worked out again after it) or once finished.
   */
  redecorate() {
    if (this.done || this.composing || !decorationsKey.get(this.current)) return
    this.current = this.current.apply(this.current.tr.setMeta(decorationsKey, true).setMeta('addToHistory', false))
    this.mounted?.view.updateState(this.current)
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
    return this.imeOpen || this.composingHeadless
  }
  /** A composition is open: the session's own rules leave the text alone. */
  private get busy(): boolean {
    return this.composing
  }
  /** Session commands are refused: a composition is open (the same as `composing`; a command works as soon as it has ended). */
  get settling(): boolean {
    return this.composing
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
   * record's own until something changed. While composed text awaits its follow-up, it is the
   * record the follow-up leaves (`followUpTransaction`: the same characters, the composed
   * ranges' marks, canonical form), computed without touching the document.
   */
  content(): TextContent {
    const c = this.cached
    if (c && c.state === this.current && c.box === this.box && c.start === this.imeStart) return c.content
    const start = this.imeStart
    let doc = this.composed.length > 0 ? this.followUpTransaction(this.current).doc : this.current.doc
    let stored = this.storedBreaks
    // The one place the session hands its content out: a composition that has the text over a bound
    // the store enforces (open, or ended and not yet followed up) never reaches a record. Until it is
    // taken back, the content is what the session held just before it (`imeStart`).
    if (start && (this.imeRefused || exceedsBounds(doc, this.baseFont))) {
      doc = start.state.doc
      stored = start.storedBreaks
    }
    let content: TextContent
    if (doc === this.initial.doc && JSON.stringify(this.box) === JSON.stringify(this.initial.box)) content = this.initial.content
    else {
      content = contentFromDoc(doc, this.box)
      if (stored !== null && !content.blocks && stored.replace(/\r\n/g, '\n') === content.text) {
        const breaks = stored
        const spans = content.spans?.map((sp) => ({ ...sp, start: storedOffset(breaks, sp.start), end: storedOffset(breaks, sp.end) }))
        content = { text: breaks, ...canonicalTextFormatting(breaks, { ...this.box, spans, headings: content.headings }) }
      }
    }
    this.cached = { state: this.current, box: this.box, start, content }
    return content
  }

  /** What the formatting controls show: the selected range, or with only a caret the next typed character. */
  format(): FormatReadout {
    return selectionFormat(this.current, this.baseFont)
  }

  /** What the block controls show: inline code and each kind of block, for the selection or the caret. */
  blockFormat(): BlockReadout {
    return selectionBlocks(this.current)
  }

  /** The only way the state changes. */
  dispatch(given: Transaction) {
    if (!this.editable) {
      this.plainPaste = null
      return
    }
    const tr = this.settleSelectionReplacement(given)
    if (!tr) {
      // A replacement of the selection that cannot be stored: refused whole, as the bounds refuse any change.
      this.plainPaste = null
      return
    }
    if (this.composingHeadless && tr.getMeta('composition') === undefined) tr.setMeta('composition', `headless-${this.headlessCompositions}`)
    const before = this.current
    const { state, transactions } = this.current.applyTransaction(tr)
    this.plainPaste = null
    if (transactions.length === 0) return
    this.current = state
    if (this.deletion && this.composing && transactions.some((t) => t.docChanged)) this.deletion.delivered = true
    this.mapComposed(transactions)
    this.trackHistory(before, state, transactions)
    for (const t of transactions) if (t.getMeta('composition') !== undefined) this.lastComposition = t.getMeta('composition')
    this.mounted?.view.updateState(state)
    if (this.storedBreaks !== null && transactions.some((t) => t.steps.some((st) => st instanceof ReplaceStep)) && !this.keepsText(tr, before, state)) this.storedBreaks = null // the text was typed into
    // Any change of the text or move of the caret ends "straight after a shortcut" (in-edit
    // undo included), except the shortcut's own conversion.
    if ((tr.docChanged || tr.selectionSet) && tr.getMeta(META.shortcutApplied) !== true) this.revert = null
    if (transactions.some((t) => t.docChanged)) this.reportChange()
    this.hooks.onSelectionChange?.(this)
  }

  /**
   * Maps the composed ranges through applied transactions. A range grows with its own
   * composition's transactions (while it is open, and ProseMirror's last reading after
   * `compositionend`, which carries the same metadata); through anything else (a key typed
   * straight after, a paste) it keeps to the characters it holds. An undo or redo forgets them:
   * the follow-up then changes nothing.
   */
  private mapComposed(transactions: readonly Transaction[]) {
    if (this.composed.length === 0) return
    for (const t of transactions) {
      if (isHistoryTransaction(t)) {
        this.composed = []
        return
      }
      if (!t.docChanged) continue
      const meta = t.getMeta(FOLLOW_UP) === true ? undefined : t.getMeta('composition')
      for (const r of this.composed) {
        if (r.open && meta !== undefined) r.meta = meta
        const grows = meta !== undefined && meta === r.meta
        const from = t.mapping.map(r.from, grows ? -1 : 1)
        r.to = Math.max(from, t.mapping.map(r.to, grows ? 1 : -1))
        r.from = from
      }
    }
  }

  /**
   * Typing, Enter, a deletion or a paste over a selection always ends with exactly the new text in
   * place of the selection and a collapsed caret after it, whatever blocks the selection crossed
   * (`settleReplacement`). An IME composition starts with such a deletion.
   */
  private settleSelectionReplacement(tr: Transaction): Transaction | null {
    const slice = this.pastedSlice
    this.pastedSlice = null
    if (tr.doc === this.current.doc || tr.before !== this.current.doc || this.current.selection.empty) return tr
    const replaced = tr.getMeta(META.replaced) as { text: string } | undefined
    let input: ReplacementInput
    if (replaced) input = replaced.text === '' ? { kind: 'delete' } : replaced.text === '\n' ? { kind: 'enter' } : { kind: 'text', text: replaced.text }
    else if (tr.getMeta('paste') === true && slice) input = { kind: 'slice', slice }
    else return tr
    const settled = settleReplacement(this.current, tr, input, (doc) => !exceedsBounds(doc, this.baseFont))
    if (settled === tr || settled === null) return settled
    // Made again: with the metadata the replacement carried (what it replaced, a paste, a composition id...).
    for (const [key, value] of Object.entries((tr as unknown as { meta: Record<string, unknown> }).meta)) settled.setMeta(key, value)
    if (tr.storedMarks !== this.current.storedMarks) settled.setStoredMarks(tr.storedMarks)
    if (tr.scrolledIntoView) settled.scrollIntoView()
    return settled
  }

  /**
   * A change that leaves every character where it was, so the text was not typed into and keeps its
   * stored line breaks: a block button (`META.keepsText`), or an in-edit undo or redo that gives back
   * the same characters (of a block button: undoing typing gives back other characters).
   */
  private keepsText(tr: Transaction, before: EditorState, after: EditorState): boolean {
    if (tr.getMeta(META.keepsText) === true) return true
    return isHistoryTransaction(tr) && plainTextOfDoc(before.doc) === plainTextOfDoc(after.doc)
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

  /** Runs a session command now, or refuses it (false) while a composition is open: it never runs later. */
  private unlessComposing(command: () => boolean): boolean {
    if (this.done || this.settling) return false
    return command()
  }

  /** Runs a ProseMirror command on the session (refused during a composition, see `unlessComposing`). */
  run(cmd: Command): boolean {
    return this.unlessComposing(() => this.editable && cmd(this.current, (tr) => this.dispatch(tr), this.view ?? undefined))
  }

  /** Puts the caret (or a range, `anchor` to `head`) at UTF-16 offsets into the text, never inside a character (see `onCharacter`). Refused during a composition. */
  select(anchor: number, head = anchor): boolean {
    return this.unlessComposing(() => {
      const doc = this.current.doc
      const text = plainTextOfDoc(doc)
      const at = (o: number) => posAtTextOffset(doc, onCharacter(text, o))
      this.dispatch(this.current.tr.setSelection(selectionAt(doc, at(anchor), at(head))))
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
    if (!e.isComposing && !this.composing && e.key === 'Tab' && e.target === this.root && !e.ctrlKey && !e.metaKey && !e.altKey && inListItem(this.current)) {
      // In a list or checklist item: indent or outdent it (owner decision 8). An item that cannot
      // go deeper (the first of its list) stays where it is, and the edit stays open.
      this.unlessComposing(() => this.runStep(e.shiftKey ? outdentItem : indentItem))
      return true
    }
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
    const beforeTyped = this.current
    this.dispatch(this.typedTransaction(text, from, to))
    if (this.current === beforeTyped) return true // the character itself was refused (a bound)
    const pendingBefore = pendingOf(this.current)
    const tr = shortcutTransaction(this.current, text)
    if (tr) {
      const beforeConversion = this.current
      this.dispatch(tr)
      // Only a conversion that happened can be reverted: one the bounds refused leaves the typed
      // character as ordinary typing, and Backspace deletes it.
      if (this.current !== beforeConversion) {
        this.revert = { pending: pendingBefore }
        this.conversions.set(undoDepth(this.current) as number, pendingOf(this.current))
      }
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
    this.beginComposition(null, `headless-${this.headlessCompositions + 1}`)
    this.headlessCompositions++
    this.composingHeadless = true
  }

  /** A composition ends without a view: nothing reads the DOM after it, so the follow-up runs at once. */
  compositionEnd() {
    this.compositionEnded()
    this.followUp()
  }

  /**
   * A composition starts, before ProseMirror counts the view as composing and before the
   * browser puts in its first candidate. A selection is deleted first, in one ordinary edit
   * styled as deleting it with a key is (`deleteSelected`), so the composition runs at a plain
   * caret; the composed text will take the marks of the selection's first character (rule R5).
   * At a caret it takes what typed text would get. A composition starting where the composed
   * text of the one before ends (Korean syllables back to back) carries that range on. A start
   * while a composition is still open (no `compositionend` between) is the browser starting it
   * again: the same composition goes on.
   *
   * `shown`, on a mounted view, is the selection the browser shows (`domSelection`): the one
   * the composition is about to replace. The session's own can lag behind it, by the
   * selection change ProseMirror reads only on the next `selectionchange` (after a commit the
   * browser has collapsed its selection to a caret after the committed text while the session
   * still has that text selected).
   */
  private beginComposition(shown: { from: number; to: number } | null, composition: unknown) {
    if (this.done || this.imeOpen) return
    let state = this.current
    const { from, to } = shown ?? state.selection
    let composedMarks: readonly PMMark[]
    if (from === to) composedMarks = applyPending(state.doc.resolve(from).marks(), pendingOf(state), this.baseFont)
    else {
      const $from = state.doc.resolve(from)
      const first = $from.parent.isTextblock && $from.parentOffset < $from.parent.content.size ? $from.parent.childAfter($from.parentOffset).node : null
      composedMarks = first?.isText ? first.marks : [] // a selection starting at a line break: no marks, like the break
      if (this.editable) {
        if (state.selection.from !== from || state.selection.to !== to) {
          this.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
          state = this.current
        }
        // Without the marks a deletion stores for what is typed next (`TextSelection.replace`):
        // stored marks at `compositionstart` would send ProseMirror down its mark-cursor path,
        // which a fast IME can break. ProseMirror's own deletion of a selection across blocks at
        // `compositionstart` comes after that check, so stores none either.
        this.imeStart ??= { state, conversions: new Map(this.conversions), storedBreaks: this.storedBreaks }
        // It carries the composition's own `composition` id, so that what the composition puts in
        // joins its in-edit undo step (one undo gives the selection back) wherever the caret then is;
        // how the deletion itself joins what came before it is unchanged.
        // (Only in a text with blocks: a text without them keeps ProseMirror's usual grouping exactly.)
        const id = isCompactDoc(state.doc) ? undefined : composition
        deleteSelected(state, (tr) => this.dispatch(id === undefined ? tr.setStoredMarks(null) : tr.setStoredMarks(null).setMeta('composition', id)))
        if (this.current !== state) this.deletion = { before: state, after: this.current, delivered: false }
        // The deletion was refused (its result could not be stored): so is the composition, taken back when it ends.
        else this.imeRefused = true
      }
    }
    this.imeStart ??= { state, conversions: new Map(this.conversions), storedBreaks: this.storedBreaks }
    const at = from === to ? from : this.current.selection.from
    const carried = from === to ? this.composed.find((r) => r.to === at && r.to > r.from) : undefined
    if (carried) carried.open = true
    else this.composed.push({ from: at, to: at, marks: composedMarks, open: true, meta: undefined })
  }

  /**
   * A composition has ended: by `compositionend`, by the edit losing focus or finishing, or
   * headless. Its ranges grow only with ProseMirror's last reading of it. When it delivered no
   * text at all and the document is exactly as deleting the selection at its start left it,
   * the selection comes back as it was (text, marks, selection), with no undo step left.
   */
  private compositionEnded() {
    this.imeOpen = false
    this.composingHeadless = false
    for (const r of this.composed) r.open = false
    const d = this.deletion
    this.deletion = null
    if (!d || d.delivered || !this.current.doc.eq(d.after.doc)) return
    this.composed = []
    this.current = d.before
    this.mounted?.view.updateState(d.before)
    this.reportChange()
    this.hooks.onSelectionChange?.(this)
  }

  /** The selection the browser shows in the view, as document positions (`EditorView.posAtDOM`); null when it is not in the view. */
  private domSelection(view: EditorView): { anchor: number; head: number; from: number; to: number } | null {
    const root = view.root as Document & { getSelection?: () => Selection | null }
    const sel = root.getSelection?.() ?? view.dom.ownerDocument.getSelection()
    if (!sel || !sel.anchorNode || !sel.focusNode || !view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return null
    try {
      const anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset)
      const head = view.posAtDOM(sel.focusNode, sel.focusOffset)
      const doc = this.current.doc
      const inText = (pos: number) => pos <= doc.content.size && doc.resolve(pos).parent.inlineContent
      if (!inText(anchor) || !inText(head)) return null
      return { anchor, head, from: Math.min(anchor, head), to: Math.max(anchor, head) }
    } catch {
      return null
    }
  }

  /**
   * The follow-up of the composed text, as a transaction on `state`, not dispatched: each
   * composed range gets its marks (rule R5), and the document is made canonical. It never
   * changes a character or moves the selection (the session's selection rule may then move a
   * selection end off the middle of a character). It joins ProseMirror's history step for the
   * composition.
   */
  private followUpTransaction(state: EditorState): Transaction {
    const tr = state.tr.setMeta(META.levelsSet, true).setMeta(FOLLOW_UP, true)
    if (this.lastComposition !== undefined) tr.setMeta('composition', this.lastComposition)
    const size = state.doc.content.size
    const inserted: Array<{ from: number; to: number }> = []
    for (const r of this.composed) {
      const from = Math.min(r.from, size)
      const to = Math.min(r.to, size)
      if (to <= from) continue
      tr.removeMark(from, to)
      for (const m of r.marks) tr.addMark(from, to, m)
      inserted.push({ from, to })
    }
    canonicalizeDoc(tr, this.baseFont, inserted)
    return tr
  }

  /**
   * Once no composition is open: the follow-up (one transaction), and the composed ranges are
   * forgotten. On a read-only board it only brings the session's own document to the canonical
   * form `content()` already gave; nothing is reported. Nothing once an undo or redo has come
   * since the composition (`mapComposed` forgets the ranges then).
   */
  private followUp() {
    if (this.composing) return
    const start = this.imeStart
    const refused = this.imeRefused
    this.imeStart = null
    this.imeRefused = false
    if (this.composed.length === 0) return
    const tr = this.followUpTransaction(this.current)
    if (refused || exceedsBounds(tr.doc, this.baseFont)) {
      // The composition took the text over a bound the store enforces (the bounds filter stands aside
      // while the browser owns the text). Everything it changed is taken back and nothing else: the
      // session is put back as it was just before it (`imeStart`: the text and the selection it
      // replaced, the pending choices, the history), so what was typed before it stays, and it is not
      // on the redo side either, so redo never brings it back. Undo grouping is not touched.
      // Also when the edit can no longer change the board (it went read-only, or is finishing): the
      // session never keeps a text over a bound.
      this.composed = []
      if (start) {
        this.current = start.state
        this.conversions = start.conversions
        this.storedBreaks = start.storedBreaks
        this.mounted?.view.updateState(start.state)
        this.reportChange()
        this.hooks.onSelectionChange?.(this)
      }
      return
    }
    // The selection the browser shows: ProseMirror has not read its last move yet (it collapses
    // the committed text's selection to a caret after it), and showing the follow-up would put
    // the session's older one back on the page.
    const view = this.mounted?.view
    const shown = view?.hasFocus() ? this.domSelection(view) : null
    if (shown && (shown.anchor !== tr.selection.anchor || shown.head !== tr.selection.head)) tr.setSelection(TextSelection.create(tr.doc, shown.anchor, shown.head))
    this.composed = []
    if (this.editable) this.dispatch(tr)
    else {
      this.current = this.current.apply(tr)
      this.mounted?.view.updateState(this.current)
    }
  }

  // ---- formatting -------------------------------------------------------------------------------

  /**
   * Bold, italic, underline or strikethrough: on the selected range (off if every character
   * has it, otherwise on; bold never changes in heading lines), or with only a caret chosen
   * for what is typed next. True when anything changed.
   */
  toggleMark(mark: Mark | 'code'): boolean {
    return this.unlessComposing(() => this.toggleMarkNow(mark))
  }

  private toggleMarkNow(mark: Mark | 'code'): boolean {
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
    return this.unlessComposing(() => this.setHeadingNow(level))
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

  /**
   * A bullet list, numbered list, checklist, quote or code block on the lines the selection touches
   * (`toggleList`, `toggleQuote`, `toggleCodeBlock`): off when they all already are one, on
   * otherwise. True when anything changed.
   */
  toggleBlock(kind: BlockKind): boolean {
    const cmd = kind === 'blockquote' ? toggleQuote : kind === 'codeBlock' ? toggleCodeBlock : toggleList(kind)
    return this.unlessComposing(() => this.runStep(cmd))
  }

  /** A divider at the caret (`insertDivider`). True when it went in. */
  insertDivider(): boolean {
    return this.unlessComposing(() => this.runStep(insertDivider))
  }

  /** Checks or unchecks the checklist item at `pos` (the position before it): a change of the edit like typing, an in-edit undo step of its own. */
  toggleTask(pos: number): boolean {
    return this.unlessComposing(() => this.runStep(toggleTaskAt(pos)))
  }

  /**
   * A block command (a list, quote, code block, divider, checkbox, indent or outdent) as an in-edit
   * undo step of its own: never merged with typing before it, a command just before it, or typing
   * straight after it. It ends "straight after a shortcut". True when the text changed.
   */
  private runStep(cmd: Command): boolean {
    this.revert = null
    if (!this.editable) return false
    const before = this.current
    cmd(this.current, (tr) => this.dispatch(closeHistory(tr)))
    if (this.current === before) return false
    // What comes next starts a step of its own (an empty transaction that only closes the step).
    this.dispatch(closeHistory(this.current.tr))
    return true
  }

  /** The font of the selected range, or with only a caret the font of what is typed next. */
  setFont(font: FontId): boolean {
    return this.unlessComposing(() => this.setFontNow(font))
  }

  private setFontNow(font: FontId): boolean {
    this.revert = null
    if (!this.editable) return false
    const sel = this.current.selection
    // A code block is always Mono: no font is chosen for what is typed there.
    if (sel instanceof TextSelection && sel.$cursor) return sel.$cursor.parent.type.spec.code ? false : this.setPending({ ...this.pending, font })
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
    if (this.done) return false
    // Alignment and colour change no character: they may apply during a composition. A new box font is refused then (it can drop font overrides).
    if (this.settling && (boxOf({ ...this.box, ...box }).font ?? DEFAULT_FONT) !== this.baseFont) return false
    return this.setBoxNow(box)
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
    return this.unlessComposing(() => this.editable && undo(this.current, (tr) => this.dispatch(tr)))
  }

  redo(): boolean {
    return this.unlessComposing(() => this.editable && redo(this.current, (tr) => this.dispatch(tr)))
  }

  // ---- clipboard and drops ------------------------------------------------------------------------

  /**
   * Pasted plain text: one paragraph per line, literal (markers stay). Its marks are given
   * afterwards, as today (`plainPasteContent`). Into a code block (`$at`): the text itself, line
   * breaks and all, as code.
   */
  plainTextSlice(text: string, $at?: ResolvedPos): Slice {
    if ($at?.parent.type.spec.code) {
      const t = normalBreaks(text)
      return t ? new Slice(Fragment.from(textSchema.text(t)), 0, 0) : Slice.empty
    }
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
    return this.unlessComposing(() => this.pasteNow(data))
  }

  private pasteNow(data: PasteData): boolean {
    if (!this.editable) return false
    const sel = this.current.selection
    let slice: Slice
    if (sel.$from.parent.type.spec.code) {
      // Into a code block: plain text, the clipboard's own or the words of its HTML. Nothing at all: nothing changes.
      const text = data.text || (data.html !== undefined ? htmlPlainText(data.html) : '')
      if (!text) return false
      this.notePlainPaste(text, this.current)
      slice = this.plainTextSlice(text, sel.$from)
    } else if (data.html !== undefined && !data.plain) {
      const body = new DOMParser().parseFromString(sanitizePastedHTML(data.html), 'text/html').body
      slice = this.arriving(pasteParser.parseSlice(body, { context: sel.$from }), this.destinationFont(this.current))
      if (slice.size === 0 && !data.text) return false // nothing to paste: the selection stays
    } else if (data.text) {
      this.notePlainPaste(data.text, this.current)
      slice = this.plainTextSlice(data.text, sel.$from)
    } else return false
    this.pastedSlice = slice
    this.dispatch(this.current.tr.replaceSelection(slice).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'))
    return true
  }

  /**
   * A drop without a view, as ProseMirror's drop handler does it: `slice` (from `dragSlice`,
   * or pasted-like content) lands at UTF-16 offset `at`, after the dragged range `moveFrom`
   * is removed for a move inside the card.
   */
  drop(slice: Slice, at: number, moveFrom?: { from: number; to: number }): boolean {
    return this.unlessComposing(() => this.dropNow(slice, at, moveFrom))
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

  /**
   * Gives every block of `doc` the runs of `want` (same text). Only for a compact document, line for
   * line: anything else (a divider or list the change put in) is left as it is. True when anything changed.
   */
  private imposeContent(tr: Transaction, doc: PMNode, want: CompactContent): boolean {
    const expected = docFromBlocks(legacyToBlocks(want.text, want, this.baseFont))
    if (!isCompactDoc(doc) || expected.childCount !== doc.childCount) return false
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
    if (!this.replacing && !isCompactDoc(oldState.doc)) return null // the earlier canvas's styling is for compact texts only
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

  /**
   * Plain text pasted or dropped into a rich text: it takes the formatting of the place it arrives at
   * (the caret's, or the first selected character's), with the pending choices. The earlier canvas's
   * styling (`plainPasteContent`) is kept for compact texts only, which is all it knew.
   */
  private richPasteMarks(root: Transaction, oldState: EditorState, newState: EditorState, pending: Pending | null): Transaction | null {
    const step = root.steps.find((st): st is ReplaceStep => st instanceof ReplaceStep)
    if (!step) return null
    const $at = oldState.doc.resolve(Math.min(step.from, oldState.doc.content.size))
    const first = step.to > step.from && $at.parent.isTextblock && $at.parentOffset < $at.parent.content.size ? $at.parent.childAfter($at.parentOffset).node : null
    const set = applyPending(first?.isText ? first.marks : $at.marks(), pending, this.baseFont)
    const tr = newState.tr
    for (const r of insertedRanges([root])) {
      tr.removeMark(r.from, r.to)
      for (const m of set) tr.addMark(r.from, r.to, m)
    }
    return tr.docChanged ? tr : null
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
        if (!isCompactDoc(oldState.doc) || rec.pending?.code !== undefined) return replaced ? null : this.richPasteMarks(root, oldState, newState, rec.pending)
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
  /**
   * Redo puts back the selection the person had when they undid that step: ProseMirror maps
   * its own through the step's changes, which leaves the caret before text an IME composed
   * (several replace steps) instead of after it, where composing left it. Only when the redone
   * document is exactly the one the selection was taken on.
   */
  private redoSelectionPlugin(): Plugin {
    const taken = new Map<number, { doc: PMNode; anchor: number; head: number }>()
    return new Plugin({
      key: new PluginKey('yuriful-redo-selection'),
      appendTransaction: (trs, oldState, state) => {
        if (!trs.some(isHistoryTransaction)) return null
        const was = undoDepth(oldState) as number
        const now = undoDepth(state) as number
        if (now < was) {
          taken.set(was, { doc: oldState.doc, anchor: oldState.selection.anchor, head: oldState.selection.head })
          return null
        }
        const t = taken.get(now)
        if (now <= was || !t || !t.doc.eq(state.doc) || (state.selection.anchor === t.anchor && state.selection.head === t.head)) return null
        return state.tr.setSelection(TextSelection.create(state.doc, t.anchor, t.head))
      },
    })
  }

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
          keydown: (_view, e) => {
            this.keepMoveToStart()
            this.caretKeyAt = CARET_KEYS.has(e.key) ? performance.now() : -Infinity
            return false
          },
          // Text that arrives with no keydown (an emoji panel, dictation) can come before the
          // `selectionchange` of the caret key just pressed: without this, the session would still
          // hold the selection from before that key and take the insertion for typing over it.
          beforeinput: () => {
            this.keepMoveToStart()
            return false
          },
          focus: () => {
            this.caretKeyAt = -Infinity
            return false
          },
          keyup: () => {
            this.handleKeyUp()
            return false
          },
          drop: (view, e) => {
            this.dropPos = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? null
            queueMicrotask(() => (this.dropPos = null))
            return false
          },
          compositionstart: (view) => {
            // ProseMirror's id for the composition starting now: it moves on only at `compositionend`.
            this.beginComposition(this.domSelection(view), (view as unknown as { input: { compositionID: number } }).input.compositionID)
            this.imeOpen = true
            return false
          },
          compositionend: () => {
            this.compositionEnded()
            // The follow-up right after ProseMirror's own last reading of the composition (a
            // microtask its `compositionend` handler, which runs after this one, queues), before
            // any other input can arrive.
            const ending = ++this.endings
            queueMicrotask(() => queueMicrotask(() => ending === this.endings && this.followUp()))
            return false
          },
          // Focus leaving during a composition ends it: the browser may never send
          // `compositionend` (it does not when focus moves before anything was composed).
          blur: (view) => {
            this.caretKeyAt = -Infinity
            if (this.imeOpen) view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '' }))
            return false
          },
        },
        // Into a code block, a paste is its plain text, whatever else the clipboard holds.
        handlePaste: (view, e, slice) => {
          const data = e.clipboardData
          // A paste with no text at all (an image copied from a page, an empty clipboard) changes nothing, the selection included.
          if (slice.size === 0 && !data?.getData('text/plain')) return true
          if (!view.state.selection.$from.parent.type.spec.code) return false
          const html = data?.getData('text/html')
          this.paste({ text: data?.getData('text/plain') ?? '', ...(html ? { html } : {}) })
          return true // handled, even when there was nothing to paste: the selection stays
        },
        transformPastedHTML: (html) => {
          this.incoming = 'html'
          return sanitizePastedHTML(html)
        },
        clipboardParser: pasteParser,
        clipboardTextParser: (text, $context, _plain, view) => {
          this.incoming = 'text'
          if (this.dropPos === null) this.notePlainPaste(text, view.state)
          else this.plainPaste = { text: normalBreaks(text), from: 0, to: 0, pending: pendingOf(view.state) }
          return this.plainTextSlice(text, $context)
        },
        transformPasted: (slice, view) => {
          const kind = this.incoming
          this.incoming = null
          const out = kind === 'text' ? slice : this.arriving(slice, this.destinationFont(view.state))
          this.pastedSlice = out
          return out
        },
        transformCopied: (slice) => copiedSlice(slice),
        clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n'),
      },
    })
  }

  /**
   * ProseMirror takes a caret at the very start of the text, within 200 ms of the editor
   * gaining focus with no click in it, for the browser resetting the selection on focus, and
   * puts the old selection back without a transaction (`DOMObserver.flush`, run on
   * `selectionchange` and at the start of every keydown). When a caret-movement key pressed in
   * the edited text, the last key since the editor gained focus, has just put it there, it is
   * the person's own move (Ctrl+A then Left, Home, Up...): the session takes it as the
   * selection first, so the browser, the session and what is typed next agree. A caret at the
   * start with no such key (focus coming back by Tab, a click elsewhere and back, `focus()`, the
   * window regaining focus) is the browser's reset, and is left to ProseMirror. Runs before
   * ProseMirror's own `selectionchange` listener (`mount`) and keydown handler (the next key can
   * come before `selectionchange`). The key counts for `CARET_KEY_MOVE_MS` after it went down.
   */
  private readonly keepMoveToStart = () => {
    const view = this.mounted?.view
    if (!view || this.done || this.composing || performance.now() - this.caretKeyAt > CARET_KEY_MOVE_MS || !view.hasFocus()) return
    const shown = this.domSelection(view)
    const start = Selection.atStart(this.current.doc).from
    if (!shown || shown.from !== start || shown.to !== start) return
    const sel = this.current.selection
    if (sel.empty && sel.from === start) return
    this.dispatch(this.current.tr.setSelection(TextSelection.create(this.current.doc, start)))
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
    // Before the view, so that it runs before ProseMirror's own `selectionchange` listener.
    el.ownerDocument.addEventListener('selectionchange', this.keepMoveToStart)
    const view = new EditorView(
      { mount: el },
      {
        state: this.current,
        dispatchTransaction: (tr) => this.dispatch(tr),
        nodeViews: { taskItem: (node, _view, getPos) => new TaskItemView(node, getPos, (pos) => this.toggleTask(pos)) },
      },
    )
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
    // shows stays, as on the canvas (ProseMirror has read every update into the document); one
    // that composed nothing gives back the selection it deleted. Then the follow-up, so the
    // record and the static HTML are final.
    if (m) {
      m.el.ownerDocument.removeEventListener('selectionchange', this.keepMoveToStart)
      m.view.destroy()
      for (const a of Array.from(m.el.attributes)) if (!m.attrs.some(([name]) => name === a.name)) m.el.removeAttribute(a.name)
      for (const [name, value] of m.attrs) m.el.setAttribute(name, value)
    }
    this.compositionEnded()
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
export function createEditSession(source: TextSource, hooks: EditSessionHooks = {}, opts: Pick<EditSessionOptions, 'caret' | 'decorate'> = {}): EditSession | null {
  const read = docFromText(source)
  return read && new EditSession(read.doc, read.box, hooks, { caret: opts.caret, content: read.content, decorate: opts.decorate })
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
