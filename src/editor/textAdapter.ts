import type { FabricObject } from 'fabric'
import type { Command, Transaction } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import { MAX_FONT_SIZE, MIN_FONT_SIZE, clamp, round, roundPositive } from '../model/doc.ts'
import { ownerAfterManipulation } from '../model/frames.ts'
import type { FrameRecord, FontId } from '../model/types.ts'
import { DEFAULT_TEXT_COLOR, fontOfRange, formatOfText, splitGraphemes } from '../model/richText.ts'
import type { Mark, TextAlign, TextFormatting } from '../model/richText.ts'
import { snapPreview } from './captionSnapLayer.ts'
import type { CaptionSnapPreview } from './captionSnapLayer.ts'
import type { CardSync, DomScene, WidthAnchor } from './domScene.ts'
import type { TextBlockInfo, TextFormatInfo } from './Editor.ts'
import type { FrameCanvas } from './FrameCanvas.ts'
import { ProxyRect, captionOf, captionSideOf, centerOf, createProxy, idOf, isLocked, ownerOf, setOwner, setTextData, textDataOf, toRecord } from './objects.ts'
import type { TextData } from './objects.ts'
import { BLOCK_KINDS, boxBlocks, boxCommandContent, boxFormat, clearRangeFonts, setBoxLevel, toggleBlockKind, toggleBoxMark } from './textRules.ts'
import type { BlockKind } from './textRules.ts'
import { noWrapRanges } from './sceneLayer.ts'
import { boxOf, contentFromDoc, docFromText, plainTextOfDoc, textOffsetAt, textblocksOf } from './textSchema.ts'
import { createEditSession } from './textSession.ts'
import type { EditSession } from './textSession.ts'
import { isBlankTextDoc } from '../model/textDoc.ts'
import { heldFixedHeight, innerText, paperPad, paperToggle } from '../model/paper.ts'
import type { TextContent } from '../model/textDoc.ts'

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
  commit(coalesceKey?: string): void
  /** The autosaver's `markDirty`. */
  markDirty(): void
  syncState(): void
  syncSelection(): void
  syncCaptions(edited?: FabricObject): void
  /** What the history buttons show now (refreshed only when in-edit undo changes them). */
  shownHistory(): { canUndo: boolean; canRedo: boolean }
}

/** A point on the page (a mouse event's `clientX` and `clientY`); `extend`: a Shift-press, which selects from the caret the text kept. */
export interface ClientPoint {
  clientX: number
  clientY: number
  extend?: boolean
}

/**
 * Everything the editor does with text, behind one interface: a text object on the board (a
 * proxy whose card the scene layer draws), and the text being edited. `DomTextAdapter` implements
 * it. The editor calls only this; it never touches a card or the edit session itself.
 */
export interface TextAdapter {
  // ---- a text object on the board
  isText(obj: FabricObject | null | undefined): obj is FabricObject
  /** A text with nothing but white space: never part of the scene. */
  isBlank(obj: FabricObject | null | undefined): boolean
  fontSizeOf(obj: FabricObject): number
  formatInfo(obj: FabricObject): TextFormatInfo
  /** What the block controls show (inline code, lists, quote, code block). */
  blockInfo(obj: FabricObject): TextBlockInfo
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
  /** The text has a fixed height (its bottom handle was dragged): its words scroll inside it. */
  hasFixedHeight(obj: FabricObject): boolean
  /** The text sits on paper (`surface: 'card'`). */
  hasPaper(obj: FabricObject): boolean

  // ---- the text being edited, and the formatting commands
  /** This object is the text being edited. */
  isEditing(obj: FabricObject | null | undefined): boolean
  editedTarget(): FabricObject | null
  /** The element that holds keyboard focus while a text is edited, or null. */
  editedRoot(): HTMLElement | null
  /** Starts editing a text (`at: 'end'`: with the caret at its end; a point: with the caret where it was pressed). */
  startEditing(obj: FabricObject, at?: 'end' | ClientPoint): void
  /** Leaves the edit in progress, if any. */
  finishEditing(): void
  /**
   * Undo or Redo while a text is edited: a step of the edit's own history, the edit staying open
   * (true), or false when no text is edited and undo belongs to the board.
   */
  stepEdit(dir: 'undo' | 'redo'): boolean
  /** What Undo and Redo can do while a text is edited; null when no text is edited. */
  editHistory(): { canUndo: boolean; canRedo: boolean } | null
  /** A press while a text is edited lands in the edited text itself, judged as the canvas judges it. */
  pressInsideEdit(e: MouseEvent): boolean
  /** A primary press inside the edited text that the browser would not route into it: placed here; true when it was one. */
  strayPressInEdit(e: MouseEvent): boolean
  /** The editor is being disposed: an edit in progress ends without committing anything. */
  dispose(): void
  setFontSize(size: number): void
  toggleMark(mark: Mark | 'code'): void
  setHeading(level: 0 | 1 | 2 | 3): void
  /** A bullet list, numbered list, checklist, quote or code block: the selected lines while editing, every line of a selected box. */
  toggleBlock(kind: BlockKind): void
  /** A divider at the caret of the edited text (nothing outside an edit). */
  insertDivider(): void
  setFont(font: FontId): void
  setAlign(align: TextAlign): void
  setColor(color: string): void
  /** Auto height: the selected text grows with its words again (its fixed height goes, its top edge stays). */
  clearHeight(): void
  /** Paper on or off for the selected text: the box grows or shrinks by the padding round its words, which stay where they are. */
  setPaper(on: boolean): void
  revertShortcut(): void
  /** A keydown that reached the window listener and that the edited text claims (Esc or Tab that has just ended it, in-edit Undo and Redo). True when claimed. */
  onKeyDown(e: KeyboardEvent): boolean
  onKeyUp(): void
  /** Records are applied: pending choices and "straight after a shortcut" end. */
  resetTransient(): void
  bindCanvasEvents(): void
}

// ---- the adapter ------------------------------------------------------------------------------------

/** The point of a box that stays put when it changes width: its alignment edge. */
const alignAnchor = (align: TextData['align']): WidthAnchor => (align === 'center' ? 'center' : align === 'right' ? 'right' : 'left')

/** A text's card data with new record content (text, formatting, box font, alignment and colour), everything else kept. */
function withContent(td: TextData, c: TextContent): TextData {
  return {
    text: c.text,
    fontSize: td.fontSize,
    width: td.width,
    ...(td.minHeight !== undefined && { minHeight: td.minHeight }),
    ...(td.height !== undefined && { height: td.height }),
    ...(c.font !== undefined && { font: c.font }),
    ...(c.align !== undefined && { align: c.align }),
    ...(c.color !== undefined && { color: c.color }),
    ...(c.spans !== undefined && { spans: c.spans }),
    ...(c.headings !== undefined && { headings: c.headings }),
    ...(c.blocks !== undefined && { blocks: c.blocks }),
    ...(td.captionBackground && { captionBackground: td.captionBackground }),
    ...(td.surface === 'card' && { surface: 'card' as const }),
  }
}

/** Fabric 7.4's word characters for a double-click (ITextBehavior.mjs `reNonWord`, `_reSpace`, `reNewline`). */
const NON_WORD = /[ \n.,;!?-]/
const SPACE = /\s|\r?\n/
const NEWLINE = /\r?\n/

/**
 * The word a double-click selects, as Fabric 7.4 finds it (ITextBehavior.mjs `searchWordBoundary`,
 * `selectWord`) on the text's graphemes: from the grapheme index `at`, out to the nearest space,
 * line break or `.,;!?-` on each side. Returns grapheme indexes.
 */
export function fabricWordAt(graphemes: readonly string[], at: number): { start: number; end: number } {
  const boundary = (from: number, dir: -1 | 1): number => {
    let index = from > 0 && SPACE.test(graphemes[from] as string) && (dir === -1 || !NEWLINE.test(graphemes[from - 1] as string)) ? from - 1 : from
    let char = graphemes[index]
    while (index > 0 && index < graphemes.length && !NON_WORD.test(char as string)) {
      index += dir
      char = graphemes[index]
    }
    if (dir === -1 && NON_WORD.test(char as string)) index++
    return index
  }
  const start = boundary(at, -1)
  return { start, end: Math.max(start, boundary(at, 1)) }
}

/**
 * The middle of the caret at `pos` on the page: the middle of the character before it (after it at
 * the start of a line's text), which is the middle of that character's box however the card is
 * turned; the engine's own caret rectangle where there is no character (an empty line). Null
 * without layout.
 */
function caretCentre(view: EditorView, pos: number): { x: number; y: number } | null {
  try {
    const { node, offset } = view.domAtPos(pos)
    if (node.nodeType === Node.TEXT_NODE && (node as Text).length > 0) {
      const range = node.ownerDocument!.createRange()
      const from = offset > 0 ? offset - 1 : 0
      range.setStart(node, from)
      range.setEnd(node, from + 1)
      const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 || r.height > 0)
      if (rect) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }
    const c = view.coordsAtPos(pos)
    return { x: (c.left + c.right) / 2, y: (c.top + c.bottom) / 2 }
  } catch {
    return null
  }
}

/** The line height (scene units) of the line holding `pos`: its own line box, untransformed. */
function lineHeightAt(view: EditorView, pos: number): number {
  let el: Element | null = view.dom
  try {
    const { node } = view.domAtPos(pos)
    el = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest('p, h1, h2, h3, pre') ?? view.dom
  } catch {
    /* the root's own line height */
  }
  const win = view.dom.ownerDocument.defaultView
  return (win && parseFloat(win.getComputedStyle(el).lineHeight)) || 0
}

/** The document position under a point of the page, in the view's text; null when there is none (or no layout to ask). */
function posAt(view: EditorView, at: ClientPoint): number | null {
  try {
    return view.posAtCoords({ left: at.clientX, top: at.clientY })?.pos ?? null
  } catch {
    return null
  }
}

/** The text being edited. */
interface LiveEdit {
  session: EditSession
  target: FabricObject
  id: string
  /** The card's body, where the view is mounted (its editable root while the edit lasts). */
  body: HTMLElement
  /** The unlocked items in front of the card: they take presses (and show the default pointer) while it is edited. */
  covering: HTMLElement[]
  /** The proxy's own handle and border settings, hidden while it is edited (a Fabric text box hides its handles then too). */
  saved: { hasControls: boolean; hasBorders: boolean }
  /**
   * The text was made for this edit (history did not hold it when the edit began): its owner is
   * decided once more when the edit ends, even if a font size change has put it in history since.
   */
  isNew: boolean
}

/**
 * A text: a proxy (`objects.ts` `createProxy`) whose card the scene layer draws
 * from its data (`textDataOf`). A selected box does everything outside an edit through the pure
 * model and the text engine's whole-box functions (`textRules.ts`), always ending in the canonical
 * compact record (`contentFromDoc`).
 *
 * Editing (plan Section 7): one `EditSession` at a time, its `EditorView` mounted into the card's
 * body (`sceneLayer.ts` `setEditing` then leaves the body's children to it). Every change of the
 * text arrives through the session's `onChange` with the canonical record content: the card's data
 * takes it, the proxy is sized from the card at once (flush point 3), and typing is saved as it
 * happens. Leaving the edit (`finishEditing`, by every route the editor has) puts the static card
 * back, sizes the proxy again (flush point 4), discards a blank text, decides a new text's owner once
 * more and records one board history step, exactly where the Fabric renderer did before it was replaced. While a text is
 * edited, the canvas takes no presses: the card and the unlocked items in front of it do (see
 * `pressInsideEdit` and the editor's routing), and Undo and Redo step the edit's own history.
 */
export class DomTextAdapter implements TextAdapter {
  private edit: LiveEdit | null = null
  /** The edit is being left (`finishEditing`): a last change reported by the session only updates the card's data. */
  private finishing = false
  /** The width and size the live card's decorations were last worked out for (`decorationBasis`). */
  private decorated = ''
  /** A formatting command is running (it saves nothing while the text is blank, as the Fabric renderer did; typing always marks the board dirty). */
  private commanding = false
  /** The editable root of the edit Esc or Tab has just ended: the window listener sees that key next and must leave it alone. */
  private endedByKey: { root: EventTarget; key: string } | null = null
  /**
   * The text a release starts editing (a Fabric text box's own `selected` flag): set by a press on
   * the text while it is already the selected object, not on one of its handles, and kept until it
   * stops being the selected object.
   */
  private armed: FabricObject | null = null
  /** The press on an already selected text, where its caret goes if the release starts editing. */
  private press: { target: FabricObject; at: ClientPoint } | null = null
  /**
   * The caret a text keeps between edits, as Fabric keeps its selection start: where it was last
   * pressed while selected (in its own coordinates, so it follows the text), or the start of the
   * selection when its last edit ended. A text never pressed or edited has its caret at 0.
   */
  private readonly caretMemo = new WeakMap<FabricObject, { offset: number } | { local: { x: number; y: number } }>()
  private syncQueued = false

  constructor(
    private readonly host: TextHost,
    private readonly scene: DomScene,
  ) {}

  /** The live edit's session, for unit tests and the browser probe only. */
  editSession(): EditSession | null {
    return this.edit?.session ?? null
  }

  // ---- a text object on the board

  isText(obj: FabricObject | null | undefined): obj is FabricObject {
    return textDataOf(obj) !== undefined
  }

  isBlank(obj: FabricObject | null | undefined): boolean {
    const td = textDataOf(obj)
    return td !== undefined && isBlankTextDoc(td)
  }

  fontSizeOf(obj: FabricObject): number {
    return textDataOf(obj)?.fontSize ?? 0
  }

  /** The whole box as the controls show it, or while it is edited the selected range or the caret's next character (the engine's readouts). */
  formatInfo(obj: FabricObject): TextFormatInfo {
    const td = textDataOf(obj)
    if (td && this.edit?.target === obj) {
      const { font, ...state } = this.edit.session.format()
      return { editing: true, font, align: td.align ?? 'left', color: td.color ?? DEFAULT_TEXT_COLOR, ...state }
    }
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

  /** What the block controls show: inline code and each block, over the whole box, or while it is edited the selection or caret. */
  blockInfo(obj: FabricObject): TextBlockInfo {
    const td = textDataOf(obj)
    if (td && this.edit?.target === obj) return this.edit.session.blockFormat()
    const read = td ? docFromText(td) : null
    if (!read) return { code: 'off', blocks: Object.fromEntries(BLOCK_KINDS.map((k) => [k, 'off'])) as TextBlockInfo['blocks'] }
    return boxBlocks(read.doc)
  }

  /**
   * Folds a residual scale into the card exactly once, as `normalizeTextScale` does for a text
   * box: font size and wrap width (and a drawn minimum height and a fixed height) times the scale,
   * the scale back to 1, and the proxy sized from the card again. No limit of its own.
   */
  normalizeScale(obj: FabricObject): boolean {
    const td = textDataOf(obj)
    if (!td) return false
    const sx = Math.abs(obj.scaleX)
    const sy = Math.abs(obj.scaleY)
    if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return false
    const s = (sx + sy) / 2
    const fontSize = roundPositive(td.fontSize * s, 2)
    setTextData(obj, {
      ...td,
      fontSize,
      width: roundPositive(td.width * sx, 2),
      ...(td.minHeight !== undefined && { minHeight: round(td.minHeight * sy) }),
      // Rounding can take a scaled fixed height just under the least one for the scaled size: held to it.
      ...(td.height !== undefined && { height: heldFixedHeight(roundPositive(td.height * sy), fontSize, td.surface) }),
    })
    obj.set({ scaleX: 1, scaleY: 1 })
    // A larger size can make a word wider than the box: it widens, as a text box does, from its left edge.
    this.syncCard(obj, { widen: 'left' })
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
    this.syncCard(obj)
  }

  minWidthOf(obj: FabricObject): number {
    return obj instanceof ProxyRect ? obj.minTextWidth : 0
  }

  setWrapWidth(obj: FabricObject, width: number) {
    const td = textDataOf(obj)
    if (!td) return
    setTextData(obj, { ...td, width })
    this.syncCard(obj)
  }

  /**
   * As the Fabric renderer did (`captionSnapLayer.ts`): the proxy's live position and scaled size, and
   * the size it will have as a caption measured by the scene layer on a drawn copy of its record.
   */
  findCaptionSnap(obj: FabricObject, objects: readonly FabricObject[], zoom: number, previous: CaptionSnapPreview | null): CaptionSnapPreview | null {
    const td = textDataOf(obj)
    const textId = td && idOf(obj)
    // In the Fabric renderer's order: an ineligible text is rejected before anything else is read.
    if (!td || !textId || this.editedTarget() === obj || isLocked(obj) || obj.angle % 360 !== 0 || isBlankTextDoc(td)) return null
    const geometry = () => ({
      center: obj.getCenterPoint(),
      width: obj.getScaledWidth(),
      height: obj.getScaledHeight(),
      side: captionSideOf(obj),
      fontSize: td.fontSize,
    })
    return snapPreview(textId, geometry, objects, zoom, previous, () => this.scene.captionSize(obj))
  }

  /** The proxy itself when it is a drawn box, else a drawn proxy built from its record (sized when it is added). */
  drawnCaptionOf(obj: FabricObject): FabricObject | null {
    const td = textDataOf(obj)
    if (!td) return null
    if (td.minHeight !== undefined) return obj
    const rec = toRecord(obj)
    return rec?.type === 'text' ? createProxy({ ...rec, minHeight: 0 }, () => undefined) : null
  }

  hasFixedHeight(obj: FabricObject): boolean {
    return textDataOf(obj)?.height !== undefined
  }

  hasPaper(obj: FabricObject): boolean {
    return textDataOf(obj)?.surface === 'card'
  }

  /** The scene layer's flush point for a text's card; the edited card's decorations follow a new width or size. */
  private syncCard(obj: FabricObject, sync: CardSync = {}) {
    const edit = this.edit?.target === obj && !this.finishing ? this.edit : null
    // The no-wrap pieces of a drawn box depend on its width and size: lay the live card out with the
    // ones for the data it now has before it is measured, and again if widening changed the width.
    if (edit) this.redecorateIfStale(edit, obj)
    this.scene.syncCard(obj, sync)
    if (edit && this.redecorateIfStale(edit, obj)) this.scene.syncCard(obj)
  }

  /** What the live card's decorations depend on beyond its document: the record fields `noWrapRanges` reads that the document does not hold. */
  private decorationBasis(td: TextData | undefined): string {
    return td ? JSON.stringify([td.width, td.fontSize, td.minHeight, td.font]) : ''
  }

  /** Works the live card's decorations out again when what they depend on changed since they were; true when it did. */
  private redecorateIfStale(edit: LiveEdit, obj: FabricObject): boolean {
    if (this.decorationBasis(textDataOf(obj)) === this.decorated) return false
    edit.session.redecorate()
    return true
  }

  // ---- editing

  isEditing(obj: FabricObject | null | undefined): boolean {
    return !!obj && this.edit?.target === obj
  }

  editedTarget(): FabricObject | null {
    return this.edit?.target ?? null
  }

  editedRoot(): HTMLElement | null {
    return this.edit?.session.view?.dom ?? null
  }

  /**
   * Starts editing a text: an edit session on its card data, its view mounted into the card's
   * body, the caret at the pressed point (`at`), at the end (`'end'`) or, for a new blank text,
   * where it is. Only an unlocked text on the board, while the board is editable, no gesture is
   * unsettled and no crop is open. Any other edit ends first.
   */
  startEditing(obj: FabricObject, at?: 'end' | ClientPoint) {
    const c = this.host.canvas
    if (this.edit?.target === obj) return
    if (!this.host.editable() || this.host.busy() || this.host.cropping() || isLocked(obj) || !textDataOf(obj) || !c.getObjects().includes(obj)) return
    this.finishEditing()
    const td = textDataOf(obj)
    const id = idOf(obj)
    if (!td || !id) return
    if (!this.scene.layer.bodyOf(id)) this.scene.syncCard(obj)
    const body = this.scene.layer.bodyOf(id)
    if (!body) return
    const session = createEditSession(
      td,
      {
        canEdit: (s) => this.host.editable() && !this.host.busy() && this.edit?.session === s,
        canFireShortcut: () => !this.host.busy(),
        onChange: (content, s) => this.onEditChange(content, s),
        onSelectionChange: (s) => {
          if (this.edit?.session === s) this.queueSync()
        },
        onWantsFinish: (reason, s) => {
          if (this.edit?.session !== s) return
          this.endedByKey = { root: s.root, key: reason === 'escape' ? 'Escape' : 'Tab' }
          this.finishEditing()
        },
        // The session would toggle the mark itself; the adapter's command does it once, behind the editor's guards.
        onFormatKey: (mark, s) => {
          if (this.edit?.session === s) this.toggleMark(mark)
        },
      },
      { decorate: (doc) => this.decorations(obj, doc) },
    )
    if (!session) return // rich blocks this build cannot edit yet
    const objects = c.getObjects()
    const covering = objects
      .slice(objects.indexOf(obj) + 1)
      .filter((o) => !isLocked(o) && o.visible)
      .map((o) => this.scene.layer.elementOf(idOf(o) ?? ''))
      .filter((el): el is HTMLElement => el !== undefined)
    this.edit = { session, target: obj, id, body, covering, saved: { hasControls: obj.hasControls, hasBorders: obj.hasBorders }, isNew: this.host.isNew(obj) }
    this.endedByKey = null
    this.scene.layer.setEditing(id)
    const view = session.mount(body)
    // A text with a fixed height stays where it was scrolled: the caret goes on the word pressed.
    this.scene.layer.restoreScroll(id)
    view.setProps({
      // A text box to assistive technology, named as the text is everywhere else (the Text tool, the panel's title).
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Text' },
      handleScrollToSelection: (v) => this.revealCaret(v),
    })
    body.addEventListener('dblclick', this.onCardDblClick)
    body.addEventListener('mousedown', this.onCardMouseDown)
    // The canvas takes no presses now: the card and the items in front of it do (the editor's routing).
    obj.set({ hasControls: false, hasBorders: false })
    c.wrapperEl.style.pointerEvents = 'none'
    for (const el of covering) el.classList.add('is-covering')
    if (at && at !== 'end') {
      const pos = posAt(view, at)
      if (pos !== null) {
        const head = textOffsetAt(session.state.doc, pos, -1)
        // Shift: from the caret the text kept to the press (Fabric `setSelectionStartEndWithShift`).
        if (at.extend) session.select(this.rememberedCaret(obj, view) ?? 0, head)
        else session.select(head)
      }
    }
    view.focus()
    c.requestRenderAll()
    this.host.syncState()
  }

  /**
   * Leaves the edit in progress (idempotent). The view goes and the static card comes back with
   * the final text, the proxy is sized from it (flush point 4), and then, as the Fabric renderer did when
   * a text leaves its edit: nothing more while records are being applied or the board is read-only;
   * a blank text is discarded (out of the selection and the canvas's reach at once, removed from the
   * canvas in a microtask, its removal recorded if history held it); a new text's owner is decided
   * once more from where it ended up; and one board history step is recorded if anything changed.
   */
  finishEditing() {
    const e = this.edit
    if (!e || this.finishing) return
    this.finishing = true
    // Fabric keeps the start of the selection as the text's caret when an edit ends, and forgets that a press armed it.
    this.caretMemo.set(e.target, { offset: e.session.selection().from })
    this.armed = null
    e.body.removeEventListener('dblclick', this.onCardDblClick)
    e.body.removeEventListener('mousedown', this.onCardMouseDown)
    this.endTextDrag()
    // Where a fixed-height text was scrolled to, before its static card replaces the live view.
    this.scene.layer.captureScroll(e.id)
    try {
      e.session.finish()
    } finally {
      this.finishing = false
    }
    this.edit = null
    const c = this.host.canvas
    const obj = e.target
    const td = textDataOf(obj)
    if (td) setTextData(obj, withContent(td, e.session.content()))
    obj.set(e.saved)
    for (const el of e.covering) el.classList.remove('is-covering')
    c.wrapperEl.style.pointerEvents = ''
    this.scene.layer.setEditing(null)
    this.syncCard(obj, { widen: alignAnchor(td?.align) })
    c.requestRenderAll()
    if (!this.host.applying() && this.host.editable()) {
      if (this.isBlank(obj)) {
        // Out of reach at once (a Shift-press that ends the edit must not select it with something
        // else); off the canvas once the editor has finished with it.
        obj.set({ evented: false, selectable: false })
        if (c.getActiveObject() === obj) c.discardActiveObject()
        queueMicrotask(() => {
          if (this.host.disposed() || this.edit?.target === obj || !this.isBlank(obj) || !c.getObjects().includes(obj)) return
          c.remove(obj)
          c.requestRenderAll()
          this.host.syncState()
        })
      } else if (!captionOf(obj) && e.isNew) {
        // A NEW text: its owner is decided once more from where it ended up (its box grew while it was typed).
        setOwner(obj, ownerAfterManipulation(ownerOf(obj), centerOf(obj), this.host.frameRecords(), NO_FRAMES))
      }
      this.host.commit()
    }
    this.host.syncState()
  }

  /**
   * Keeps the caret in view in a text with a fixed height, whenever the edit asks for it (typing,
   * Enter, a paste, keys the engine handles, in-edit undo and redo...): the text scrolls just enough,
   * worked out in the card's own coordinates (the caret's place on the page taken back through the
   * viewport and the card's matrix), so a turned or zoomed card scrolls by the right amount. Nothing
   * else scrolls: not the page, not the board. A text that grows with its words is left to the
   * engine, as before (the editor puts back any ancestor the browser scrolls).
   */
  private revealCaret(view: EditorView): boolean {
    const e = this.edit
    if (!e || e.session.view !== view || textDataOf(e.target)?.height === undefined) return false
    const head = view.state.selection.head
    const at = caretCentre(view, head)
    const local = at && this.scene.layer.toCard(e.id, at.x, at.y)
    if (!local) return true
    const line = lineHeightAt(view, head)
    this.scene.layer.revealSpan(e.id, local.y - line / 2, local.y + line / 2)
    return true
  }

  /** In-edit Undo and Redo (Owner Decision 11): the edit's own history; the edit stays open. Whole-box settings are not steps of it. */
  stepEdit(dir: 'undo' | 'redo'): boolean {
    const e = this.edit
    if (!e) return false
    if (dir === 'undo') e.session.undo()
    else e.session.redo()
    return true
  }

  editHistory(): { canUndo: boolean; canRedo: boolean } | null {
    const s = this.edit?.session
    return s ? { canUndo: s.canUndo, canRedo: s.canRedo } : null
  }

  /**
   * A press while a text is edited lands in the edited text exactly where Fabric would find that
   * text under it (so the decision agrees with the canvas to the pixel, on the box's edge and in its
   * selection padding too): not on a frame's label or outline, which wins over any content; not on an
   * unlocked object in front of it (a locked one lets presses through), unless Alt is held: Fabric
   * then gives a press to the selected object, which the edited text is, even beneath other content
   * (`altSelectionKey`, `FrameCanvas.findTarget`); and within its area.
   */
  pressInsideEdit(e: MouseEvent): boolean {
    const edit = this.edit
    if (!edit) return false
    const c = this.host.canvas
    const objects = c.getObjects()
    const p = c.getScenePoint(e)
    if (e.altKey && !c.frameOverlayAt(objects, p) && c._checkTarget(edit.target, p)) return true
    // Fabric's own search: a frame's label or outline first, then the top-most object whose area
    // (its box and its selection padding) holds the point.
    return c.searchPossibleTargets(objects, p).target === edit.target
  }

  /**
   * A primary press inside the edited text (`pressInsideEdit`) that the browser does not route into
   * its card (its very edge, or where an item in front shows but Fabric does not count it, or one
   * covering it while Alt is held): the caret goes to the nearest place in the text, as Fabric puts
   * it there (with Shift, the range grows from its anchor, as a press inside the text does), and
   * moving the pointer with the button held selects from there, as Fabric does. True when the press was such a one and
   * is handled here; false when the browser and the view handle it.
   */
  strayPressInEdit(e: MouseEvent): boolean {
    const edit = this.edit
    const card = edit && this.scene.layer.elementOf(edit.id)
    const view = edit?.session.view
    // In the text itself, or on its scroll thumb: the browser's and the view's (or the thumb's). On
    // the paper round the words (its padding), or anywhere else the browser would not route into the
    // text: placed here.
    const own = e.target instanceof Node && (edit?.body.contains(e.target) || (e.target instanceof Element && !!e.target.closest('.scene-text-thumb') && !!card?.contains(e.target)))
    if (!edit || !card || !view || own) return false
    const at = this.offsetNear(edit, view, e)
    const anchor = e.shiftKey ? edit.session.selection().anchor : at
    if (anchor !== null && at !== null) edit.session.select(anchor, at)
    view.focus()
    const win = card.ownerDocument.defaultView ?? window
    const move = (m: MouseEvent) => {
      if ((m.buttons & 1) === 0 || this.edit !== edit) return stop()
      const head = this.offsetNear(edit, view, m)
      if (anchor !== null && head !== null) edit.session.select(anchor, head)
    }
    const stop = () => {
      win.removeEventListener('mousemove', move, { capture: true })
      win.removeEventListener('mouseup', stop, { capture: true })
    }
    win.addEventListener('mousemove', move, { capture: true })
    win.addEventListener('mouseup', stop, { capture: true })
    return true
  }

  /**
   * The text offset under a page point, or under the nearest point in the words' own box when it
   * falls outside them (the box's edge, a paper's padding); failing that, under the point moved a
   * little toward the box's centre. Read beneath the items in front of
   * the card, which otherwise take the point.
   */
  private offsetNear(edit: LiveEdit, view: EditorView, at: ClientPoint): number | null {
    for (const el of edit.covering) el.style.pointerEvents = 'none'
    try {
      return this.offsetNearShown(edit, view, at)
    } finally {
      for (const el of edit.covering) el.style.pointerEvents = ''
    }
  }

  private offsetNearShown(edit: LiveEdit, view: EditorView, at: ClientPoint): number | null {
    // The nearest point in the words' own box: beside a line, its start or end; above or below the
    // words, the first or last line shown.
    const near = this.scene.layer.nearestInWords(edit.id, at.clientX, at.clientY)
    const pos = near && posAt(view, near)
    if (pos !== null && pos !== undefined) return textOffsetAt(edit.session.state.doc, pos, -1)
    const ctr = edit.target.getCenterPoint()
    const v = this.host.canvas.viewportTransform
    const r = this.host.canvas.upperCanvasEl.getBoundingClientRect()
    const cx = r.left + v[0] * ctr.x + v[4]
    const cy = r.top + v[3] * ctr.y + v[5]
    const len = Math.hypot(cx - at.clientX, cy - at.clientY) || 1
    // Up to 8 screen pixels in, and across the paper's padding too (on screen) when the text has paper.
    const td = textDataOf(edit.target)
    const pad = td ? paperPad(td) : { x: 0, y: 0 }
    const reach = Math.min(len, 8 + Math.ceil(Math.max(pad.x, pad.y) * Math.abs(v[0])))
    for (let step = 0; step <= reach; step++) {
      const pos = posAt(view, { clientX: at.clientX + ((cx - at.clientX) / len) * step, clientY: at.clientY + ((cy - at.clientY) / len) * step })
      if (pos !== null) return textOffsetAt(edit.session.state.doc, pos, -1)
    }
    return null
  }

  dispose() {
    this.finishEditing() // the board is no longer editable: nothing is committed
  }

  /**
   * The edited text changed (typing, a paste, a command, in-edit undo...): the card's data takes
   * the canonical content, then, unless the edit is ending, the proxy is sized from the card (flush
   * point 3) before anything is saved: a box the text has become too narrow for widens about the
   * alignment edge it had before the change (left, centre or right, as a Fabric text box widens while
   * typed into), a caption is placed again, and the change is saved as it happens. Formatting a
   * blank text saves nothing, as the Fabric renderer did; typing always marks the board dirty there (a
   * blank text is out of the scene, so such a save stores none).
   */
  private onEditChange(content: TextContent, s: EditSession) {
    const e = this.edit
    if (e?.session !== s) return
    const obj = e.target
    const td = textDataOf(obj)
    if (!td) return
    setTextData(obj, withContent(td, content))
    if (this.finishing) return
    this.syncCard(obj, { widen: alignAnchor(td.align) })
    if (!this.host.applying() && this.host.editable()) {
      if (!this.host.busy() && !this.host.cropping() && captionOf(obj)) this.host.syncCaptions(obj)
      if (!this.commanding || !isBlankTextDoc(content)) this.host.markDirty()
    }
    this.host.canvas.requestRenderAll()
    this.host.syncState() // the layer list follows typing; the history buttons follow in-edit undo
  }

  /** What the controls show, after the session's state changed: the selection, and the history buttons when in-edit undo changed them. */
  private queueSync() {
    if (this.syncQueued) return
    this.syncQueued = true
    queueMicrotask(() => {
      this.syncQueued = false
      if (this.host.disposed()) return
      const h = this.editHistory()
      const shown = this.host.shownHistory()
      if (h && (h.canUndo !== shown.canUndo || h.canRedo !== shown.canRedo)) this.host.syncState()
      else this.host.syncSelection()
    })
  }

  /**
   * How the live editor draws what the static card draws beyond the schema (`sceneLayer.ts`
   * `renderCardBody`): each no-wrap range of `noWrapRanges` for the text as it now is, and each tab
   * as a space. The static card wraps a whole word in one span outside its marks; a decoration sits
   * inside them, one span per piece of text with the same marks, so every piece but the last of a
   * word carries a word joiner after it (`yp-join`), and no break can fall where two pieces meet.
   * A `cut` piece (the first piece of a word wider than a drawn box) is a line of its own, as the
   * static card's line-wide inline block makes it: a block break of no height before its first part
   * and after its last (`yp-cut-first`, `yp-cut-last`), however its marks split it; an empty line
   * box takes no room, so a piece already at a line's start gains no line.
   */
  private decorations(obj: FabricObject, doc: PMNode): DecorationSet {
    const td = textDataOf(obj)
    if (!td) return DecorationSet.empty
    this.decorated = this.decorationBasis(td)
    const content = contentFromDoc(doc, boxOf(td))
    // Worked out for the words' own box: inside the paper's padding, as the static card's.
    const ranges = noWrapRanges(innerText({ ...td, text: content.text, spans: content.spans, headings: content.headings, blocks: content.blocks }), this.scene.layer.root.ownerDocument)
    const out: Decoration[] = []
    textblocksOf(doc).forEach(({ node: block, pos }, i) => {
      const start = pos + 1
      const pieces: Array<{ from: number; to: number }> = []
      let at = 0
      block.forEach((child) => {
        const length = child.text?.length ?? 0
        pieces.push({ from: at, to: at + length })
        at += length
      })
      for (const r of ranges[i] ?? []) {
        const parts = pieces.filter((p) => p.to > r.start && p.from < r.end).map((p) => ({ from: Math.max(p.from, r.start), to: Math.min(p.to, r.end) }))
        parts.forEach((p, k) => {
          const cls = `yp-nowrap${k < parts.length - 1 ? ' yp-join' : ''}${r.cut && k === 0 ? ' yp-cut-first' : ''}${r.cut && k === parts.length - 1 ? ' yp-cut-last' : ''}`
          out.push(Decoration.inline(start + p.from, start + p.to, { class: cls }))
        })
      }
      const text = block.textContent
      for (let k = text.indexOf('\t'); k >= 0; k = text.indexOf('\t', k + 1)) out.push(Decoration.inline(start + k, start + k + 1, { class: 'yp-tab' }))
    })
    return DecorationSet.create(doc, out)
  }

  /**
   * A primary press on the selected text of the edited card may start dragging it within the card.
   * ProseMirror gives up on such a drag when the pointer's first movement exceeds 8 px before the
   * browser has started it (prosemirror-view 1.43 `MouseDown.move`): it selects to the pointer
   * instead and prevents the move, so a quick drag leaves the words where they were and a caret
   * where the pointer let go. Fabric drags at any speed. For exactly this press, the moves are kept
   * from ProseMirror until the drag starts or the press ends: the browser starts the drag, and
   * ProseMirror's own `dragstart` carries the selection as for any drag of selected text. Pressed in
   * the selection is judged as ProseMirror judges it (`isInSelection`: the selection the page shows).
   */
  private readonly onCardMouseDown = (e: MouseEvent) => {
    const edit = this.edit
    this.endTextDrag()
    if (!edit || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.detail > 1 || edit.session.state.selection.empty) return
    const range = edit.body.ownerDocument.getSelection()?.rangeCount ? edit.body.ownerDocument.getSelection()!.getRangeAt(0) : null
    if (!range || !Array.from(range.getClientRects()).some((r) => r.left <= e.clientX && r.right >= e.clientX && r.top <= e.clientY && r.bottom >= e.clientY)) return
    const win = edit.body.ownerDocument.defaultView ?? window
    const keep = (m: MouseEvent) => {
      if ((m.buttons & 1) === 0) this.endTextDrag()
      else m.stopPropagation() // the browser still starts its drag: only ProseMirror must not see the move
    }
    const stop = () => this.endTextDrag()
    win.addEventListener('mousemove', keep, { capture: true })
    win.addEventListener('mouseup', stop, { capture: true })
    win.addEventListener('dragstart', stop, { capture: true })
    this.textDrag = () => {
      win.removeEventListener('mousemove', keep, { capture: true })
      win.removeEventListener('mouseup', stop, { capture: true })
      win.removeEventListener('dragstart', stop, { capture: true })
    }
  }

  private textDrag: (() => void) | null = null

  private endTextDrag() {
    const done = this.textDrag
    this.textDrag = null
    done?.()
  }
  /**
   * A double-click in the edited card (both presses in the live view): the word Fabric's rule
   * gives, over whatever the browser selected by its own rule (it splits words elsewhere, at a
   * hyphen or a full stop differently).
   */
  private readonly onCardDblClick = (e: MouseEvent) => {
    if (e.button === 0 && this.edit?.body.contains(e.target as Node)) this.selectWordAt(e)
  }

  /** A page point in an object's own coordinates (its centre at 0, 0). */
  private localPoint(obj: FabricObject, e: MouseEvent): { x: number; y: number } {
    const p = this.host.canvas.getScenePoint(e)
    const [a, b, c, d, tx, ty] = obj.calcTransformMatrix()
    const det = a * d - b * c || 1
    const x = p.x - tx
    const y = p.y - ty
    return { x: (d * x - c * y) / det, y: (a * y - b * x) / det }
  }

  /** The caret a text kept (`caretMemo`), as a UTF-16 offset into it; null when it has none. Needs the mounted view. */
  private rememberedCaret(obj: FabricObject, view: EditorView): number | null {
    const memo = this.caretMemo.get(obj)
    if (!memo) return null
    if ('offset' in memo) return memo.offset
    const [a, b, c, d, tx, ty] = obj.calcTransformMatrix()
    const sx = a * memo.local.x + c * memo.local.y + tx
    const sy = b * memo.local.x + d * memo.local.y + ty
    const v = this.host.canvas.viewportTransform
    const r = this.host.canvas.upperCanvasEl.getBoundingClientRect()
    const pos = posAt(view, { clientX: r.left + v[0] * sx + v[2] * sy + v[4], clientY: r.top + v[1] * sx + v[3] * sy + v[5] })
    return pos === null ? null : textOffsetAt(view.state.doc, pos, -1)
  }

  /** A double-click in the edited text selects a word, as Fabric's does once the click before it has entered the edit. */
  private selectWordAt(e: Event) {
    const edit = this.edit
    const view = edit?.session.view
    if (!edit || !view || !(e instanceof MouseEvent)) return
    const pos = posAt(view, e)
    if (pos === null) return
    const doc = edit.session.state.doc
    const text = plainTextOfDoc(doc)
    const offset = textOffsetAt(doc, pos, -1)
    const graphemes = splitGraphemes(text)
    const starts: number[] = []
    let o = 0
    for (const g of graphemes) {
      starts.push(o)
      o += g.length
    }
    starts.push(o)
    let index = starts.findIndex((s) => s >= offset)
    if (index < 0) index = graphemes.length
    const word = fabricWordAt(graphemes, index)
    edit.session.select(starts[word.start] ?? text.length, starts[word.end] ?? text.length)
  }

  revertShortcut() {
    this.edit?.session.revertShortcut()
  }

  /**
   * A keydown that reached the window listener. The session has had it first (ProseMirror's own
   * listener is on the edited root): typing, the editing keys, Ctrl/Cmd+B, I, U and the Backspace
   * revert are all its own. Claimed here: the Esc or Tab that has just ended the edit (Fabric stops
   * both, so the canvas never sees them), and Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl/Cmd+Y in the
   * edited text, which step the edit's history or do nothing, never the browser's own undo.
   */
  onKeyDown(e: KeyboardEvent): boolean {
    const ended = this.endedByKey
    this.endedByKey = null
    if (ended && !this.edit && e.target === ended.root && e.key === ended.key) return true
    const edit = this.edit
    if (!edit || e.target !== edit.session.root || e.isComposing || e.altKey || !(e.ctrlKey || e.metaKey)) return false
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (key !== 'z' && !(key === 'y' && !e.shiftKey)) return false
    e.preventDefault()
    return true
  }

  onKeyUp() {
    this.edit?.session.handleKeyUp()
  }

  /** Records are applied (undo, redo, a cancelled gesture): an edit in progress ends without committing anything. */
  resetTransient() {
    this.edit?.session.clearShortcutRevert()
    this.armed = null
    this.finishEditing()
  }

  /**
   * What a Fabric text box does on its own with the pointer, for a proxy (fabric 7.4.0,
   * ITextClickBehavior.mjs `_mouseDownHandler`, `mouseUpHandler`): a press on the text while it is
   * already the selected object, not on one of its handles, arms it until it is deselected; a primary
   * release on an armed text that is still the selected one, with no transform performed and no
   * handle under the pointer, starts editing with the caret where it was released, in a microtask,
   * once Fabric and the editor have finished with the release. A double-click in the edited text then
   * selects the word under it (`doubleClickHandler`). An edited text that stops being the selected
   * object leaves its edit, as a Fabric text box does when it is deselected.
   */
  bindCanvasEvents() {
    const c = this.host.canvas
    const handleUnder = (o: FabricObject) => (o as unknown as { __corner?: string }).__corner !== undefined
    c.on('mouse:down', (opt) => {
      const target = opt.target
      const e = opt.e
      this.press = null
      if (!target || !this.isText(target) || isLocked(target) || handleUnder(target) || !(e instanceof MouseEvent) || e.button !== 0) return
      const alreadySelected = (opt as { alreadySelected?: boolean }).alreadySelected === true
      if (alreadySelected || this.isEditing(target)) this.armed = target
      if (!alreadySelected) return
      // Fabric puts the caret where an already selected text is pressed (`setCursorByClick`), whatever
      // the press goes on to do; with Shift it extends from the caret the text kept.
      this.press = { target, at: { clientX: e.clientX, clientY: e.clientY, extend: e.shiftKey } }
      if (!e.shiftKey) this.caretMemo.set(target, { local: this.localPoint(target, e) })
    })
    c.on('mouse:up', (opt) => {
      const target = opt.target
      const e = opt.e
      if (!target || target !== this.armed || !(e instanceof MouseEvent) || e.button !== 0) return
      if (opt.transform?.actionPerformed || handleUnder(target)) return
      if (c.getActiveObject() !== target || isLocked(target) || this.isEditing(target)) return
      // The caret goes where the text was pressed, as Fabric places it on the press.
      const at = this.press?.target === target ? this.press.at : { clientX: e.clientX, clientY: e.clientY }
      this.press = null
      queueMicrotask(() => {
        if (this.host.disposed() || this.edit || c.getActiveObject() !== target) return
        this.startEditing(target, at)
      })
    })
    c.on('mouse:dblclick', (opt) => {
      if (this.edit && opt.target === this.edit.target) this.selectWordAt(opt.e)
    })
    const followSelection = () => {
      if (this.armed && c.getActiveObject() !== this.armed) this.armed = null
      if (this.edit && c.getActiveObject() !== this.edit.target) this.finishEditing()
    }
    c.on('selection:cleared', followSelection)
    c.on('selection:updated', followSelection)
  }

  // ---- font size and formatting
  //
  // As the Fabric renderer did: every command acts on the one selected text, only while the board is
  // editable and no gesture is unsettled, and none changes ownership. While the text is edited,
  // marks, heading and font act on the selected range (with only a caret, on what is typed next)
  // through the session, alignment and colour on the whole box; the change is saved as it happens
  // and is part of the edit's one board step. On a selected box outside an edit, every command acts
  // on the whole box as an undo step of its own, coalesced per kind and text.

  /** As the Fabric renderer did: one undo step per text, coalesced; while the text is edited, also a step (a caption: saved only). Never an ownership change. */
  setFontSize(size: number) {
    this.edit?.session.clearShortcutRevert()
    if (!this.host.editable() || this.host.busy()) return
    const active = this.host.canvas.getActiveObject()
    const td = textDataOf(active)
    if (!active || !td || isLocked(active) || !Number.isFinite(size)) return
    const fontSize = clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE)
    if (fontSize === td.fontSize) return
    // Headings keep their ratio (CSS em). A fixed height a larger size would be below its least one
    // is raised to it, in the same step (undo gives back both).
    setTextData(active, { ...td, fontSize, ...(td.height !== undefined && { height: heldFixedHeight(td.height, fontSize, td.surface) }) })
    this.syncCard(active, { widen: 'left' })
    this.host.canvas.requestRenderAll()
    if (isBlankTextDoc(td)) {
      // A text that is blank right now (new, or emptied in the middle of an edit) is not in the scene:
      // nothing is saved, but the panel shows what it has.
      this.host.syncState()
      return
    }
    if (this.isEditing(active) && captionOf(active)) {
      this.host.syncCaptions(active)
      this.host.markDirty()
      this.host.syncSelection()
    } else this.host.commit(`font-size:${idOf(active) ?? ''}`)
  }

  private formatTarget(): FabricObject | null {
    this.edit?.session.clearShortcutRevert() // a formatting command ends "straight after a shortcut"
    if (!this.host.editable() || this.host.busy()) return null
    const active = this.host.canvas.getActiveObject()
    return active && textDataOf(active) && !isLocked(active) ? active : null
  }

  /** A command on the edited text, through its session. */
  private inEdit(obj: FabricObject, command: (s: EditSession) => unknown): boolean {
    const e = this.edit
    if (e?.target !== obj) return false
    this.commanding = true
    try {
      command(e.session)
    } finally {
      this.commanding = false
    }
    this.host.syncSelection()
    return true
  }

  /**
   * A whole-box formatting command: the card's document changed by the text engine's whole-box
   * function (`change`) and its box formatting by `box`, read back as the canonical compact record
   * (`contentFromDoc`). Nothing changes, records or saves when that is what the text already was.
   * A box that grows keeps its alignment edge where it is; its owner never changes.
   */
  private formatBox(obj: FabricObject, kind: string, change?: (tr: Transaction) => unknown, box?: (fmt: TextFormatting) => TextFormatting, command?: Command) {
    const td = textDataOf(obj)
    // Nothing over a bound is written, and nothing changes, records or saves when the text would stay as it is.
    const after = td ? boxCommandContent(td, { change, box, command }) : null
    if (!td || !after) return
    const anchor = alignAnchor(td.align)
    setTextData(obj, withContent(td, after))
    this.syncCard(obj, { widen: anchor })
    this.host.canvas.requestRenderAll()
    this.host.commit(`format-${kind}:${idOf(obj) ?? ''}`)
  }

  toggleMark(mark: Mark | 'code') {
    const obj = this.formatTarget()
    if (obj && !this.inEdit(obj, (s) => s.toggleMark(mark))) this.formatBox(obj, `mark-${mark}`, (tr) => toggleBoxMark(tr, mark))
  }

  setHeading(level: 0 | 1 | 2 | 3) {
    const obj = this.formatTarget()
    if (obj && !this.inEdit(obj, (s) => s.setHeading(level))) this.formatBox(obj, 'heading', (tr) => setBoxLevel(tr, level))
  }

  /**
   * A block on the selected lines while editing; on a selected box, the same command on every line of
   * the text, empty ones and the last included (what `boxBlocks` reads), as an undo step of its own.
   */
  toggleBlock(kind: BlockKind) {
    const obj = this.formatTarget()
    if (!obj || this.inEdit(obj, (s) => s.toggleBlock(kind))) return
    this.formatBox(obj, `block-${kind}`, undefined, undefined, toggleBlockKind(kind, { wholeBox: true }))
  }

  /** A divider at the caret while editing. A selected box has no caret, so nothing happens there. */
  insertDivider() {
    const obj = this.formatTarget()
    if (obj && this.edit?.target === obj) this.inEdit(obj, (s) => s.insertDivider())
  }

  /** The font of the selection or caret while editing; outside an edit the whole box's font, every font override going. */
  setFont(font: FontId) {
    const obj = this.formatTarget()
    if (obj && !this.inEdit(obj, (s) => s.setFont(font))) this.formatBox(obj, 'font', (tr) => clearRangeFonts(tr), (fmt) => ({ ...fmt, font }))
  }

  setAlign(align: TextAlign) {
    const obj = this.formatTarget()
    const value = align === 'left' ? undefined : align
    if (obj && !this.inEdit(obj, (s) => s.setBox({ align: value }))) this.formatBox(obj, 'align', undefined, (fmt) => ({ ...fmt, align: value }))
  }

  setColor(color: string) {
    const obj = this.formatTarget()
    if (obj && !this.inEdit(obj, (s) => s.setBox({ color }))) this.formatBox(obj, 'color', undefined, (fmt) => ({ ...fmt, color }))
  }

  /**
   * Auto height (the panel's button, or a double-click on the bottom handle): the one selected text
   * grows with its words again, its top edge where it was, and starts from its top. A whole-box
   * setting like alignment: on a selected box an undo step of its own; while the text is edited it
   * is saved at once and part of the edit's one step. A caption stays against its image. It never
   * changes ownership.
   */
  clearHeight() {
    const obj = this.formatTarget()
    const td = obj ? textDataOf(obj) : undefined
    if (!obj || !td || td.height === undefined) return
    const next: TextData = { ...td }
    delete next.height
    setTextData(obj, next)
    this.syncCard(obj)
    this.host.canvas.requestRenderAll()
    if (!this.isEditing(obj)) {
      this.host.commit()
      return
    }
    if (isBlankTextDoc(td)) {
      // A text that is blank right now is not in the scene: nothing is saved, but the panel shows what it has.
      this.host.syncState()
      return
    }
    if (captionOf(obj)) this.host.syncCaptions(obj)
    this.host.markDirty()
    this.host.syncState()
  }

  /**
   * Paper on or off for the one selected text (`paperToggle`): the box keeps its centre and grows by
   * the padding on every side, or shrinks by it, so the words keep their own box and do not move or
   * re-wrap (a drawn minimum height and a fixed height follow; a fixed-height text stays where it was
   * scrolled, as its words' box has not changed). A whole-box setting like alignment: on a selected
   * box an undo step of its own; while the text is edited it is saved at once and part of the edit's
   * one step. It never changes ownership.
   */
  setPaper(on: boolean) {
    const obj = this.formatTarget()
    const td = obj ? textDataOf(obj) : undefined
    const rec = obj ? toRecord(obj) : null
    if (!obj || !td || rec?.type !== 'text' || (td.surface === 'card') === on) return
    const next = paperToggle({ left: rec.left, top: rec.top, angle: rec.angle, width: td.width, minHeight: td.minHeight, height: td.height, fontSize: td.fontSize }, on)
    const data: TextData = { ...td, width: next.width }
    if (next.minHeight !== undefined) data.minHeight = next.minHeight
    if (next.height !== undefined) data.height = next.height
    if (on) data.surface = 'card'
    else delete data.surface
    setTextData(obj, data)
    // The proxy's origin is its (turned) top-left corner: the toggle's corner, then the card's new size.
    obj.set({ left: next.left, top: next.top })
    this.syncCard(obj)
    this.host.canvas.requestRenderAll()
    if (!this.isEditing(obj)) {
      this.host.commit()
      return
    }
    if (isBlankTextDoc(td)) {
      // A text that is blank right now is not in the scene: nothing is saved, but the panel shows what it has.
      this.host.syncState()
      return
    }
    if (captionOf(obj)) this.host.syncCaptions(obj)
    this.host.markDirty()
    this.host.syncState()
  }
}
