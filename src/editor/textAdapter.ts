import { ActiveSelection, Textbox } from 'fabric'
import type { FabricObject } from 'fabric'
import { EditorState } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import { MAX_FONT_SIZE, MIN_FONT_SIZE, clamp, round, roundPositive } from '../model/doc.ts'
import { ownerAfterManipulation } from '../model/frames.ts'
import type { FrameRecord, FontId } from '../model/types.ts'
import {
  DEFAULT_TEXT_COLOR,
  applyTypingShortcut,
  fontAtCaret,
  fontOfRange,
  formatAtCaret,
  formatOfRange,
  formatOfText,
  marksAtCaret,
  matchTypingShortcut,
  pendingMarksAt,
  setHeading as setHeadingOfRange,
  setHeadingEverywhere,
  setRangeFont,
  toggleMark as toggleMarkOfRange,
  togglePendingMark,
} from '../model/richText.ts'
import type { Mark, PendingTextStyle, RangeFormat, TextAlign, TextFormatting } from '../model/richText.ts'
import { resolveEditingShortcut, typedCharacter } from '../input/shortcuts.ts'
import { findCaptionSnap, makeSnapCaption } from './captionSnapLayer.ts'
import type { CaptionSnapPreview } from './captionSnapLayer.ts'
import { DrawnTextbox } from './DrawnTextbox.ts'
import type { DomScene, WidthAnchor } from './domScene.ts'
import type { TextFormatInfo } from './Editor.ts'
import type { FrameCanvas } from './FrameCanvas.ts'
import {
  ProxyRect,
  applyTextFormatting,
  captionOf,
  centerOf,
  editTextAtEnd,
  idOf,
  isLocked,
  normalizeTextScale,
  ownerOf,
  readTextFormatting,
  reconcileTextFormatting,
  replaceEditedText,
  selectedRange,
  setOwner,
  setTextData,
  setTextFontSize,
  setTextWrapWidth,
  textDataOf,
} from './objects.ts'
import type { TextData, TextEdit } from './objects.ts'
import { boxFormat, clearRangeFonts, setBoxLevel, toggleBoxMark } from './textRules.ts'
import { boxOf, contentFromDoc, docFromText } from './textSchema.ts'

const NO_FRAMES: ReadonlySet<string> = new Set()

/**
 * What the text adapters need from the editor. Everything here is the editor's own logic,
 * reached through closures so that the adapters change none of it.
 */
export interface TextHost {
  readonly canvas: FrameCanvas
  editable(): boolean
  busy(): boolean
  /** Records are being applied (undo, redo, load, a cancelled gesture). */
  applying(): boolean
  /** Crop mode is open. */
  cropping(): boolean
  disposed(): boolean
  /** History has never held this object (a new text). */
  isNew(obj: FabricObject): boolean
  frameRecords(): FrameRecord[]
  selectByIds(objs: FabricObject[]): void
  commit(coalesceKey?: string): void
  /** The autosaver's `markDirty`. */
  markDirty(): void
  syncState(): void
  syncSelection(): void
  syncCaptions(edited?: FabricObject): void
}

/**
 * Everything the editor does with text, behind one interface (plan Section 12, "Dual-path
 * seam"): a text object on the board, and the text being edited. `FabricTextAdapter` is the
 * shipped behaviour, moved here unchanged from `Editor.ts`; `DomTextAdapter` serves the DOM
 * renderer, where a text is a proxy whose card the scene layer draws. The editor calls only
 * this; it never touches a text box or a card itself.
 */
export interface TextAdapter {
  /** Text can be typed into on this renderer (new texts, captions, double-click to edit). */
  readonly canEdit: boolean

  // ---- a text object on the board
  isText(obj: FabricObject | null | undefined): obj is FabricObject
  /** A text with nothing but white space: never part of the scene. */
  isBlank(obj: FabricObject | null | undefined): boolean
  fontSizeOf(obj: FabricObject): number
  formatInfo(obj: FabricObject): TextFormatInfo
  /** Folds any residual scale into the text's size (no limit of its own); true when there was one. */
  normalizeScale(obj: FabricObject): boolean
  /** A caption's background colour ('' for none). */
  backgroundOf(obj: FabricObject): string
  setBackground(obj: FabricObject, color: string): void
  /** The narrowest width the text allows (its widest word, or grapheme on a drawn box). */
  minWidthOf(obj: FabricObject): number
  /** Changes the wrap width without changing the formatting or moving the caret. */
  setWrapWidth(obj: FabricObject, width: number): void
  /** Where a dragged text would land as a caption, or null (`captionSnapLayer.ts`). */
  findCaptionSnap(obj: FabricObject, objects: readonly FabricObject[], zoom: number, previous: CaptionSnapPreview | null): CaptionSnapPreview | null
  /** The text itself when it already wraps as a caption does (a drawn box), a drawn copy of it, or null. */
  drawnCaptionOf(obj: FabricObject): FabricObject | null

  // ---- the text being edited, and the formatting commands
  /** This object is the text being edited. */
  isEditing(obj: FabricObject | null | undefined): boolean
  editedTarget(): FabricObject | null
  /** The element that holds keyboard focus while a text is edited, or null. */
  editedRoot(): HTMLElement | null
  /** Starts editing a text (`at: 'end'`: with the caret at its end). */
  startEditing(obj: FabricObject, at?: 'end'): void
  /** Leaves the edit in progress, if any (Fabric commits it through its own events). */
  finishEditing(): void
  setFontSize(size: number): void
  toggleMark(mark: Mark): void
  setHeading(level: 0 | 1 | 2 | 3): void
  setFont(font: FontId): void
  setAlign(align: TextAlign): void
  setColor(color: string): void
  revertShortcut(): void
  /** Every keydown, before anything else handles it: what it types into the edited text, observed only. */
  observeKey(e: KeyboardEvent): void
  /** A keydown that the edited text claims (a mark shortcut, Backspace straight after a typing shortcut). True when claimed. */
  onKeyDown(e: KeyboardEvent): boolean
  onKeyUp(): void
  /** The primary release was lost: let go of a range drag inside the edited text. */
  onPrimaryLost(): void
  /** Records are applied: pending choices and "straight after a shortcut" end. */
  resetTransient(): void
  bindCanvasEvents(): void
}

// ---- the shipped renderer ---------------------------------------------------------------------------

/**
 * The Fabric text path, exactly as it was in `Editor.ts`: the pending marks, the typed
 * character, the shortcut revert, the four `text:*` handlers, the formatting commands and the
 * editing keys. Only `this.` became `this.host.` where the code reaches the editor.
 */
export class FabricTextAdapter implements TextAdapter {
  readonly canEdit = true
  /**
   * Marks and font chosen with only a caret in a text being edited, for what is typed next. Dropped
   * when the caret moves for any other reason than typing, and when the edit ends.
   */
  private pending: { target: Textbox; style: PendingTextStyle } | null = null
  /**
   * The character a key is typing into the text being edited (a space or a `*`, see
   * `typedCharacter`), from its keydown until the text change it causes or its keyup. Only a
   * typed character can fire a typing shortcut: pasted, dropped and composed text cannot.
   */
  private typed: string | null = null
  /**
   * The typing shortcut that has just fired, with what puts its literal characters back (the
   * text, formatting, caret and pending choices from just before it fired). Only "straight
   * after": dropped by the next text change, any caret or selection move, any formatting
   * command, the end of the edit and any rebuild from records (undo, redo, a cancelled gesture).
   */
  private shortcutRevert: { target: Textbox; text: string; fmt: TextFormatting; caret: number; pending: PendingTextStyle | null } | null = null
  /** A selection-info refresh is queued (see `queueSelectionSync`). */
  private selectionSyncQueued = false

  constructor(private readonly host: TextHost) {}

  /** The pending caret choices and the shortcut revert, as they are now: read by unit tests only. */
  transientState(): { pending: unknown; shortcutRevert: unknown } {
    return { pending: this.pending, shortcutRevert: this.shortcutRevert }
  }

  // ---- a text object on the board

  isText(obj: FabricObject | null | undefined): obj is FabricObject {
    return obj instanceof Textbox
  }

  isBlank(obj: FabricObject | null | undefined): boolean {
    return obj instanceof Textbox && obj.text.trim() === ''
  }

  fontSizeOf(obj: FabricObject): number {
    return (obj as Textbox).fontSize
  }

  formatInfo(obj: FabricObject): TextFormatInfo {
    return this.textFormatInfo(obj as Textbox)
  }

  normalizeScale(obj: FabricObject): boolean {
    return normalizeTextScale(obj as Textbox)
  }

  backgroundOf(obj: FabricObject): string {
    return obj.backgroundColor
  }

  setBackground(obj: FabricObject, color: string) {
    obj.set({ backgroundColor: color })
  }

  minWidthOf(obj: FabricObject): number {
    return (obj as Textbox).dynamicMinWidth
  }

  setWrapWidth(obj: FabricObject, width: number) {
    setTextWrapWidth(obj as Textbox, width)
  }

  findCaptionSnap(obj: FabricObject, objects: readonly FabricObject[], zoom: number, previous: CaptionSnapPreview | null): CaptionSnapPreview | null {
    return obj instanceof Textbox ? findCaptionSnap(obj, objects, zoom, previous) : null
  }

  drawnCaptionOf(obj: FabricObject): FabricObject | null {
    if (obj instanceof DrawnTextbox) return obj
    return obj instanceof Textbox ? makeSnapCaption(obj) : null
  }

  private textFormatInfo(tb: Textbox): TextFormatInfo {
    const fmt = readTextFormatting(tb)
    const text = tb.text
    const editing = tb.isEditing === true
    const range = editing ? selectedRange(tb) : undefined
    let state: RangeFormat
    let font: TextFormatInfo['font']
    if (range && range.start === range.end) {
      const pending = this.pendingFor(tb)
      state = formatAtCaret(text, fmt, range.start, pending)
      font = pending.font ?? fontAtCaret(text, fmt, range.start)
    } else {
      state = range ? formatOfRange(text, fmt, range.start, range.end) : formatOfText(text, fmt)
      font = fontOfRange(text, fmt, range?.start ?? 0, range?.end ?? text.length)
    }
    return { editing, font, align: fmt.align ?? 'left', color: fmt.color ?? DEFAULT_TEXT_COLOR, ...state }
  }

  private pendingFor(tb: Textbox): PendingTextStyle {
    return this.pending?.target === tb ? this.pending.style : {}
  }

  private setPending(tb: Textbox, style: PendingTextStyle) {
    this.pending = Object.keys(style).length > 0 ? { target: tb, style } : null
  }

  /**
   * A heading line is always bold, so bold is never pending while the caret is on one: called
   * wherever the caret's line can become a heading while marks are pending (the heading
   * command, and every text change, which covers the `# ` shortcut and joining lines). Only a
   * pending bold is dropped; italic, underline and strikethrough stay. It does not come back
   * if the line goes back to body text.
   */
  private dropPendingBoldOnHeading(tb: Textbox) {
    const p = this.pending
    if (!p || p.target !== tb || !tb.isEditing) return
    const caret = selectedRange(tb)?.end
    if (caret === undefined) return
    const style = pendingMarksAt(tb.text, readTextFormatting(tb), caret, p.style)
    if (style !== p.style) this.setPending(tb, style)
  }

  /**
   * After Fabric's own handling has returned: Fabric fires its text selection event before
   * it has stored the new selection in some cases (IText.mjs `_updateAndFire`).
   */
  private queueSelectionSync() {
    if (this.selectionSyncQueued) return
    this.selectionSyncQueued = true
    queueMicrotask(() => {
      this.selectionSyncQueued = false
      if (!this.host.disposed()) this.host.syncSelection()
    })
  }

  // ---- the text being edited

  isEditing(obj: FabricObject | null | undefined): boolean {
    return obj instanceof Textbox && obj.isEditing === true
  }

  editedTarget(): FabricObject | null {
    const active = this.host.canvas.getActiveObject()
    return active instanceof Textbox && active.isEditing ? active : null
  }

  editedRoot(): HTMLElement | null {
    const active = this.host.canvas.getActiveObject()
    return active instanceof Textbox && active.isEditing ? (active.hiddenTextarea ?? null) : null
  }

  startEditing(obj: FabricObject, at?: 'end') {
    if (!(obj instanceof Textbox)) return
    if (at === 'end') editTextAtEnd(obj)
    else obj.enterEditing()
  }

  finishEditing() {
    const active = this.host.canvas.getActiveObject()
    if (active instanceof Textbox && active.isEditing) active.exitEditing()
  }

  private editingKeys() {
    const active = this.host.canvas.getActiveObject()
    const edited = active instanceof Textbox && active.isEditing ? active : null
    return { editedTextarea: edited?.hiddenTextarea ?? null, canRevertShortcut: edited !== null && this.shortcutRevert?.target === edited }
  }

  observeKey(e: KeyboardEvent) {
    this.typed = this.host.busy() ? null : typedCharacter(e, this.editingKeys()) // observed only, never claimed
  }

  onKeyDown(e: KeyboardEvent): boolean {
    // Keys typed into the text being edited reach this window listener from Fabric's hidden
    // textarea; Fabric does nothing with Ctrl/Cmd+B, I or U and lets them bubble (fabric
    // 7.4.0, ITextKeyBehavior.mjs `onKeyDown`, constants.mjs `ctrlKeysMapDown`), so no capture
    // listener is needed. Backspace is not Fabric's either: the textarea deletes and Fabric
    // follows from its input event (constants.mjs `keysMap` has no Backspace), so preventing it
    // here keeps anything from being deleted. Everything else typed there is left alone.
    const claimed = resolveEditingShortcut(e, this.editingKeys())
    if (!claimed) return false
    e.preventDefault()
    if (claimed === 'revert-shortcut') this.revertShortcut()
    else if (claimed !== 'ignore') this.toggleMark(claimed)
    return true
  }

  onKeyUp() {
    this.typed = null // what the key typed has arrived by now, if it typed anything
  }

  onPrimaryLost() {
    // Fabric normally unregisters the range drag on text mouse-up. Keep the edit and
    // range as they are when that release never comes.
    const active = this.host.canvas.getActiveObject()
    if (active instanceof Textbox && active.isEditing) {
      const manager = this.host.canvas.textEditingManager
      // Textbox extends ITextBehavior. Fabric's polymorphic toObject signature makes
      // those types incompatible here even though the manager registers textboxes.
      manager.unregister(active as unknown as Parameters<typeof manager.unregister>[0])
    }
  }

  resetTransient() {
    this.pending = null
    this.shortcutRevert = null
  }

  bindCanvasEvents() {
    const c = this.host.canvas
    c.on('text:editing:entered', () => this.host.syncState())
    c.on('text:changed', ({ target }) => {
      // Fabric fires this after it has changed the text, shifted its character styles and
      // placed the caret, and does nothing to the text afterwards (fabric 7.4.0,
      // ITextKeyBehavior.mjs onInput, DraggableTextDelegate.mjs drop/dragend; a drag also
      // fires it on its source text, which may no longer be the one being edited). So the
      // styles are made canonical right here, before the typing save is scheduled: each
      // line keeps the level it had before the change (never one guessed from the sizes a
      // paste brought), marks come from the styles, and a save can never store formatting
      // that the canvas does not show.
      // Marks and a font chosen with only a caret go to what was just typed (they last through every
      // step of an IME composition, which fires this without moving the caret otherwise).
      // Then a typed character that completes a typing shortcut converts the text, in the same
      // callback, before the save below is scheduled (see `typingShortcut`).
      const typed = this.typed
      this.typed = null
      this.shortcutRevert = null // any change of the text ends "straight after a shortcut"
      if (target instanceof Textbox) {
        let edit = undefined as TextEdit | undefined
        reconcileTextFormatting(target, target.isEditing ? this.pendingFor(target) : undefined, (e) => (edit = e))
        if (edit && typed !== null) this.typingShortcut(target, edit, typed)
        // The change (a `# ` shortcut, or Backspace joining a line into the heading above it)
        // may have left the caret on a heading line: no pending bold there.
        this.dropPendingBoldOnHeading(target)
      }
      if (!this.host.applying() && this.host.editable()) {
        if (!this.host.busy() && !this.host.cropping() && target instanceof Textbox && captionOf(target)) this.host.syncCaptions(target)
        this.host.markDirty() // keep typing durable; history commits on exit
      }
      this.host.syncState() // the layer list follows typing (a text that is blank right now is not listed); marks nothing dirty
      this.queueSelectionSync()
    })
    // The caret or the selected range moved for any other reason than typing (arrow keys, a
    // click or drag in the text, select all). Typing moves it without this event (fabric
    // 7.4.0, ITextBehavior.mjs `updateFromTextArea`), and so does an IME composition.
    c.on('text:selection:changed', ({ target }) => {
      if (this.pending?.target === target) this.pending = null
      if (this.shortcutRevert?.target === target) this.shortcutRevert = null
      this.queueSelectionSync()
    })
    c.on('text:editing:exited', ({ target }) => {
      if (this.pending?.target === target) this.pending = null
      if (this.shortcutRevert?.target === target) this.shortcutRevert = null
      // A press inside the text may still be held (it started no gesture, and the text could
      // not move while it was being edited). End it, or the text would now be dragged with
      // no gesture: visible to saves half-way and impossible to cancel.
      if (c._currentTransform?.target === target) c.endCurrentTransform()
      if (this.host.applying() || !this.host.editable()) return
      if (target instanceof Textbox && target.text.trim() === '') {
        // A blank text is discarded. It is already out of the scene (see snapshot), so the
        // commit below records its removal now. The object itself is taken off the canvas
        // only after Fabric has finished leaving the edit: Fabric still fires events on the
        // text after this callback, and they fail on a text that has no canvas any more.
        queueMicrotask(() => {
          if (this.host.disposed() || target.isEditing || target.text.trim() !== '' || !c.getObjects().includes(target)) return
          // Shift-clicking another object leaves the edit AND puts this text into a new
          // multi-selection. Take it out again, or the selection would keep a member that is
          // no longer on the canvas.
          const active = c.getActiveObject()
          if (active instanceof ActiveSelection && active.getObjects().includes(target) && !c._currentTransform) {
            const rest = active.getObjects().filter((o) => o !== target)
            c.discardActiveObject()
            c.remove(target)
            this.host.selectByIds(rest)
          } else {
            c.remove(target)
          }
          c.requestRenderAll()
          this.host.syncState()
        })
      } else if (target instanceof Textbox && !captionOf(target) && this.host.isNew(target)) {
        // A NEW text (history has never held it): its box grew while it was typed, so its
        // owner is decided once more from where it ended up. Re-editing an existing text
        // never changes its owner, whatever the typing does to its size.
        setOwner(target, ownerAfterManipulation(ownerOf(target), centerOf(target), this.host.frameRecords(), NO_FRAMES))
      }
      this.host.commit()
    })
  }

  // ---- font size and formatting
  //
  // Every command acts on the one selected text, and only while the board is editable and no
  // gesture is unsettled. While the text is being edited, marks and headings act on the
  // selected range (marks with only a caret: on what is typed next), and the change is saved
  // as it happens and becomes part of the single undo step recorded when the edit ends; the
  // edit, its caret and its selected range go on. On a selected box that is not being edited
  // they act on the whole box, as an undo step of its own (quick repeats of the same kind
  // coalesce, like the font size). None of them changes ownership.

  setFontSize(size: number) {
    this.shortcutRevert = null
    if (!this.host.editable() || this.host.busy()) return
    const active = this.host.canvas.getActiveObject()
    if (!(active instanceof Textbox) || isLocked(active) || !Number.isFinite(size)) return
    const fontSize = clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE)
    if (fontSize === active.fontSize) return
    setTextFontSize(active, fontSize) // headings keep their ratio
    active.setCoords()
    this.host.canvas.requestRenderAll()
    // A text that is blank right now (emptied in the middle of an edit) is not in the scene:
    // committing would record "text removed" while it is still being typed into.
    if (active.text.trim() === '') return
    if (active.isEditing && captionOf(active)) {
      this.host.syncCaptions(active)
      this.host.markDirty()
      this.host.syncSelection()
    } else this.host.commit(`font-size:${idOf(active) ?? ''}`)
  }

  /** The text a formatting command acts on, or null when there is none or the board may not change now. */
  private formatTarget(): Textbox | null {
    this.shortcutRevert = null // a formatting command ends "straight after a shortcut"
    if (!this.host.editable() || this.host.busy()) return null
    const active = this.host.canvas.getActiveObject()
    return active instanceof Textbox && !isLocked(active) ? active : null
  }

  /** Applies a formatting change through the one canvas path, then saves or records it. */
  private formatText(tb: Textbox, kind: string, change: (fmt: TextFormatting, text: string) => TextFormatting) {
    if (!applyTextFormatting(tb, change)) return // nothing changed: nothing recorded, nothing saved
    this.host.canvas.requestRenderAll()
    if (tb.isEditing) {
      // Saved as it happens, like typing. A blank text being typed into is not in the scene,
      // so there is nothing to save (and a commit would record its removal).
      if (captionOf(tb) && !this.host.cropping()) this.host.syncCaptions(tb)
      if (tb.text.trim() !== '') this.host.markDirty()
      this.host.syncSelection()
      return
    }
    this.host.commit(`format-${kind}:${idOf(tb) ?? ''}`)
  }

  /**
   * Bold, italic, underline or strikethrough. Editing: toggled on the selected range (off if
   * every character has it, otherwise on), or with only a caret, chosen for what is typed
   * next. Not editing: the whole box. Bold never changes in heading lines.
   */
  toggleMark(mark: Mark) {
    const tb = this.formatTarget()
    if (!tb) return
    const range = tb.isEditing ? (selectedRange(tb) ?? { start: 0, end: tb.text.length }) : { start: 0, end: tb.text.length }
    if (tb.isEditing && range.start === range.end) {
      this.setPending(tb, togglePendingMark(tb.text, readTextFormatting(tb), range.start, this.pendingFor(tb), mark))
      this.host.syncSelection()
      return
    }
    this.formatText(tb, `mark-${mark}`, (fmt, text) => toggleMarkOfRange(text, fmt, mark, range.start, range.end))
  }

  /** Heading level 1 to 3, or 0 for body text. Editing: every line the selection touches (the caret's line). Not editing: every line. */
  setHeading(level: 0 | 1 | 2 | 3) {
    const tb = this.formatTarget()
    if (!tb) return
    const range = tb.isEditing ? selectedRange(tb) : undefined
    this.formatText(tb, 'heading', (fmt, text) => (range ? setHeadingOfRange(text, fmt, level, range.start, range.end) : setHeadingEverywhere(text, fmt, level)))
    if (tb.isEditing) {
      this.dropPendingBoldOnHeading(tb) // the caret's line may now be a heading
      this.host.syncSelection()
    }
  }

  /** The font of the selection or whole box, or the next characters typed at a caret. */
  setFont(font: FontId) {
    const tb = this.formatTarget()
    if (!tb) return
    const range = tb.isEditing ? selectedRange(tb) : undefined
    if (tb.isEditing && !range) return
    if (range && range.start === range.end) {
      this.setPending(tb, { ...this.pendingFor(tb), font })
      this.host.syncSelection()
      return
    }
    this.formatText(tb, 'font', (fmt, text) => setRangeFont(text, fmt, font, range))
  }

  /** The alignment of the whole box, also while it is being edited. The box keeps its position and width. */
  setAlign(align: TextAlign) {
    const tb = this.formatTarget()
    if (tb) this.formatText(tb, 'align', (fmt) => ({ ...fmt, align: align === 'left' ? undefined : align }))
  }

  /** The colour (`#rrggbb`) of the whole box, also while it is being edited. The default ink is stored as no colour. */
  setColor(color: string) {
    const tb = this.formatTarget()
    if (tb) this.formatText(tb, 'color', (fmt) => ({ ...fmt, color }))
  }

  // ---- typing shortcuts
  //
  // While a text is typed into, `# `, `## `, `### ` at the start of a line make it a heading,
  // and a closing `**` or `*` makes the text since the opening marker bold or italic; the
  // markers go (see `matchTypingShortcut`). Backspace straight afterwards puts the literal
  // characters back. Like typing, a conversion is saved as it happens and is part of the one
  // undo step recorded when the edit ends; it never changes ownership.

  /**
   * After a text change, in the `text:changed` callback, once its styles are canonical: when
   * the change is exactly one character typed at the caret (`typed`, seen on its keydown),
   * with nothing replaced, and it completes a typing shortcut, the text and its formatting are
   * changed together in one step. Fabric 7.4 does nothing to the text after this callback
   * (ITextKeyBehavior.mjs `onInput`: `updateAndFire` only asks for a render afterwards), and
   * the save that typing schedules is scheduled after this returns, so no save can see the
   * marker typed but not yet converted.
   */
  private typingShortcut(tb: Textbox, edit: TextEdit, typed: string) {
    if (this.host.applying() || !this.host.editable() || this.host.busy() || !tb.isEditing || this.host.canvas.getActiveObject() !== tb) return
    if ((tb as unknown as { inCompositionMode?: boolean }).inCompositionMode) return
    const { start, prevEnd, nextEnd } = edit.change
    if (prevEnd !== start || nextEnd !== start + 1 || edit.text[start] !== typed) return
    const caret = selectedRange(tb)
    if (!caret || caret.start !== nextEnd || caret.end !== nextEnd) return
    const sc = matchTypingShortcut(edit.text, nextEnd, typed)
    if (!sc) return
    const fmt = readTextFormatting(tb) // canonical: the reconcile has just remembered it
    const pendingBefore = this.pending?.target === tb ? this.pending.style : null
    const out = applyTypingShortcut(edit.text, fmt, sc)
    replaceEditedText(tb, out.text, out.fmt, out.caret)
    if (sc.kind !== 'heading') {
      // What is typed next is plain again: a pending "off" (none where typing would not carry
      // the mark anyway, nor for bold on a heading line, where it cannot change).
      const mark = sc.kind
      const style = { ...pendingBefore }
      if (marksAtCaret(out.text, out.fmt, out.caret)[mark] && !(mark === 'bold' && formatAtCaret(out.text, out.fmt, out.caret).boldFromHeading)) style[mark] = false
      else delete style[mark]
      this.setPending(tb, style)
    }
    this.shortcutRevert = { target: tb, text: edit.text, fmt, caret: nextEnd, pending: pendingBefore }
  }

  /** Backspace straight after a typing shortcut fired: its literal characters come back, exactly as typed, and nothing is deleted. */
  revertShortcut() {
    const r = this.shortcutRevert
    this.shortcutRevert = null
    if (!r || !this.host.editable() || this.host.busy() || !r.target.isEditing || this.host.canvas.getActiveObject() !== r.target) return
    replaceEditedText(r.target, r.text, r.fmt, r.caret)
    this.setPending(r.target, r.pending ?? {})
    if (captionOf(r.target)) this.host.syncCaptions(r.target)
    this.host.canvas.requestRenderAll()
    this.host.markDirty() // like typing (a blank text is out of the scene, so a save stores none)
    this.host.syncSelection()
  }
}

// ---- the DOM renderer (static in this slice) ---------------------------------------------------------

/** The point of a box that stays put when it changes width: its alignment edge (as `applyTextFormatting` keeps it). */
const alignAnchor = (align: TextData['align']): WidthAnchor => (align === 'center' ? 'center' : align === 'right' ? 'right' : 'left')

/**
 * The DOM renderer's text: a proxy (`objects.ts` `createProxy`) whose card the scene layer
 * draws from its data (`textDataOf`). In this slice a text is static: everything a selected box
 * can do outside an edit works (font size, whole-box marks, heading, font, alignment and colour,
 * scale folding, wrap width, caption background), each through the pure model and the text
 * engine's whole-box functions (`textRules.ts`) and always ending in the canonical compact
 * record (`contentFromDoc`). Live editing is the next slice (2c-ii): until then nothing is ever
 * being edited here, and the editing members do nothing.
 */
export class DomTextAdapter implements TextAdapter {
  readonly canEdit = false

  constructor(
    private readonly host: TextHost,
    private readonly scene: DomScene,
  ) {}

  // ---- a text object on the board

  isText(obj: FabricObject | null | undefined): obj is FabricObject {
    return textDataOf(obj) !== undefined
  }

  isBlank(obj: FabricObject | null | undefined): boolean {
    const td = textDataOf(obj)
    return td !== undefined && td.text.trim() === ''
  }

  fontSizeOf(obj: FabricObject): number {
    return textDataOf(obj)?.fontSize ?? 0
  }

  /** The whole box, as the controls show it (nothing is edited here yet): the engine's readout of its document. */
  formatInfo(obj: FabricObject): TextFormatInfo {
    const td = textDataOf(obj)
    const read = td ? docFromText(td) : null
    if (!td || !read) {
      // Not readable by this build's schema (never on a board this build can edit): the plain model.
      const text = td?.text ?? ''
      const fmt: TextFormatting = td ?? {}
      return { editing: false, font: fontOfRange(text, fmt, 0, text.length), align: fmt.align ?? 'left', color: fmt.color ?? DEFAULT_TEXT_COLOR, ...formatOfText(text, fmt) }
    }
    const { font, ...state } = boxFormat(read.doc, read.box.font ?? 'sans')
    return { editing: false, font, align: read.box.align ?? 'left', color: read.box.color ?? DEFAULT_TEXT_COLOR, ...state }
  }

  /**
   * Folds a residual scale into the card exactly once, as `normalizeTextScale` does for a text
   * box: font size and wrap width (and a drawn minimum height) times the scale, the scale back to
   * 1, and the proxy sized from the card again. No limit of its own.
   */
  normalizeScale(obj: FabricObject): boolean {
    const td = textDataOf(obj)
    if (!td) return false
    const sx = Math.abs(obj.scaleX)
    const sy = Math.abs(obj.scaleY)
    if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return false
    const s = (sx + sy) / 2
    setTextData(obj, {
      ...td,
      fontSize: roundPositive(td.fontSize * s, 2),
      width: roundPositive(td.width * sx, 2),
      ...(td.minHeight !== undefined && { minHeight: round(td.minHeight * sy) }),
    })
    obj.set({ scaleX: 1, scaleY: 1 })
    // A larger size can make a word wider than the box: it widens, as a text box does, from its left edge.
    this.scene.syncCard(obj, 'left')
    return true
  }

  backgroundOf(obj: FabricObject): string {
    return textDataOf(obj)?.captionBackground ?? ''
  }

  setBackground(obj: FabricObject, color: string) {
    const td = textDataOf(obj)
    if (!td) return
    const next: TextData = { ...td }
    if (color) next.captionBackground = color
    else delete next.captionBackground
    setTextData(obj, next)
    this.scene.syncCard(obj)
  }

  minWidthOf(obj: FabricObject): number {
    return obj instanceof ProxyRect ? obj.minTextWidth : 0
  }

  setWrapWidth(obj: FabricObject, width: number) {
    const td = textDataOf(obj)
    if (!td) return
    setTextData(obj, { ...td, width })
    this.scene.syncCard(obj)
  }

  /** Caption snapping on the DOM path is Slice 2c-iii: never offered here. */
  findCaptionSnap(): CaptionSnapPreview | null {
    return null
  }

  drawnCaptionOf(): FabricObject | null {
    return null
  }

  // ---- editing (Slice 2c-ii): nothing is ever being edited yet

  isEditing(): boolean {
    return false
  }

  editedTarget(): FabricObject | null {
    return null
  }

  editedRoot(): HTMLElement | null {
    return null
  }

  startEditing() {}

  finishEditing() {}

  revertShortcut() {}

  observeKey() {}

  onKeyDown(): boolean {
    return false
  }

  onKeyUp() {}

  onPrimaryLost() {}

  resetTransient() {}

  bindCanvasEvents() {}

  // ---- font size and whole-box formatting

  /** As the Fabric path: one undo step per text, coalesced; never an ownership change. */
  setFontSize(size: number) {
    if (!this.host.editable() || this.host.busy()) return
    const active = this.host.canvas.getActiveObject()
    const td = textDataOf(active)
    if (!active || !td || isLocked(active) || !Number.isFinite(size)) return
    const fontSize = clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE)
    if (fontSize === td.fontSize) return
    setTextData(active, { ...td, fontSize }) // headings keep their ratio (CSS em)
    this.scene.syncCard(active, 'left')
    this.host.canvas.requestRenderAll()
    if (td.text.trim() === '') return
    this.host.commit(`font-size:${idOf(active) ?? ''}`)
  }

  private formatTarget(): FabricObject | null {
    if (!this.host.editable() || this.host.busy()) return null
    const active = this.host.canvas.getActiveObject()
    return active && textDataOf(active) && !isLocked(active) ? active : null
  }

  /**
   * A whole-box formatting command: the card's document changed by the text engine's whole-box
   * function (`change`) and its box formatting by `box`, read back as the canonical compact record
   * (`contentFromDoc`). Nothing changes, records or saves when that is what the text already was.
   * A box that grows keeps its alignment edge where it is; its owner never changes.
   */
  private formatBox(obj: FabricObject, kind: string, change?: (tr: Transaction) => unknown, box?: (fmt: TextFormatting) => TextFormatting) {
    const td = textDataOf(obj)
    const read = td ? docFromText(td) : null
    if (!td || !read) return
    const before = contentFromDoc(read.doc, read.box)
    let doc = read.doc
    if (change) {
      const tr = EditorState.create({ doc: read.doc }).tr
      change(tr)
      doc = tr.doc
    }
    const after = contentFromDoc(doc, box ? boxOf(box(read.box)) : read.box)
    if (JSON.stringify(after) === JSON.stringify(before)) return
    const next: TextData = {
      text: after.text,
      fontSize: td.fontSize,
      width: td.width,
      ...(td.minHeight !== undefined && { minHeight: td.minHeight }),
      ...(after.font !== undefined && { font: after.font }),
      ...(after.align !== undefined && { align: after.align }),
      ...(after.color !== undefined && { color: after.color }),
      ...(after.spans !== undefined && { spans: after.spans }),
      ...(after.headings !== undefined && { headings: after.headings }),
      ...(td.captionBackground && { captionBackground: td.captionBackground }),
    }
    const anchor = alignAnchor(td.align)
    setTextData(obj, next)
    this.scene.syncCard(obj, anchor)
    this.host.canvas.requestRenderAll()
    this.host.commit(`format-${kind}:${idOf(obj) ?? ''}`)
  }

  toggleMark(mark: Mark) {
    const obj = this.formatTarget()
    if (obj) this.formatBox(obj, `mark-${mark}`, (tr) => toggleBoxMark(tr, mark))
  }

  setHeading(level: 0 | 1 | 2 | 3) {
    const obj = this.formatTarget()
    if (obj) this.formatBox(obj, 'heading', (tr) => setBoxLevel(tr, level))
  }

  /** A whole-box font: the box font changes and every font override goes. */
  setFont(font: FontId) {
    const obj = this.formatTarget()
    if (obj) this.formatBox(obj, 'font', (tr) => clearRangeFonts(tr), (fmt) => ({ ...fmt, font }))
  }

  setAlign(align: TextAlign) {
    const obj = this.formatTarget()
    if (obj) this.formatBox(obj, 'align', undefined, (fmt) => ({ ...fmt, align: align === 'left' ? undefined : align }))
  }

  setColor(color: string) {
    const obj = this.formatTarget()
    if (obj) this.formatBox(obj, 'color', undefined, (fmt) => ({ ...fmt, color }))
  }
}
