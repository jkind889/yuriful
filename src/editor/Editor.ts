import { ActiveSelection, Textbox } from 'fabric'
import type { FabricImage, FabricObject, Transform } from 'fabric'
import { boardAppearance, boardStyle, DEFAULT_BOARD_STYLE, normalizePresetName, sameBoardStyle } from '../model/appearance.ts'
import type { BoardAppearance, BoardStyle } from '../model/appearance.ts'
import {
  DEFAULT_VIEWPORT,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clamp,
  normalizeFrameName,
  normalizeTitle,
  referencedAssetIds,
  round,
  roundPositive,
  sceneEqual,
} from '../model/doc.ts'
import {
  DEFAULT_FRAME_SCREEN,
  MIN_FRAME_SIZE,
  allowedScaleFactor,
  membersToRelease,
  minFrameSide,
  nextFrameName,
  ownerAfterManipulation,
  rectFromDrag,
} from '../model/frames.ts'
import type { Box } from '../model/frames.ts'
import {
  croppedPlacement,
  dragCropRect,
  fillRecord,
  fitRecord,
  replaceRecord,
  hitCropHandle,
  isWholeImage,
  storedCrop,
  minCropSide,
  sceneToSource,
  uncroppedPlacement,
} from '../model/crop.ts'
import type { CropHit, CropRect, Placement } from '../model/crop.ts'
import { History } from '../model/history.ts'
import { layoutOffsets } from '../model/layout.ts'
import type { Layout } from '../model/layout.ts'
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
import type { Mark, MarkState, PendingTextStyle, RangeFormat, TextAlign, TextFormatting } from '../model/richText.ts'
import { canReorderLayered, reorderLayered } from '../model/layers.ts'
import type { LayerDropSide, LayerOp } from '../model/layers.ts'
import { DEFAULT_TITLE, DOC_VERSION } from '../model/types.ts'
import type { BoardDoc, FontId, FrameRecord, ImageRecord, SaveState, Scene, TextRecord, Viewport } from '../model/types.ts'
import { fitImageScale, fitViewport, screenToScene, zoomAround } from '../model/viewport.ts'
import type { Point, Rect, Size } from '../model/viewport.ts'
import { Autosaver } from '../persistence/autosave.ts'
import { ABSENT } from '../persistence/boardStore.ts'
import type { BoardStore } from '../persistence/boardStore.ts'
import { hydrateBoard } from '../persistence/hydrate.ts'
import { isConfirmKey, isPanHoldKey, resolveEditingShortcut, resolveShortcut, typedCharacter } from '../input/shortcuts.ts'
import type { ShortcutAction } from '../input/shortcuts.ts'
import { AssetCache, isImageFile, readImageFile } from './assets.ts'
import { CROP_HIT_TOLERANCE, cropCursor, cropOverlay, drawCropOverlay } from './cropLayer.ts'
import { FrameCanvas } from './FrameCanvas.ts'
import type { AssetSource } from './assets.ts'
import { EMPTY_LAYERS, computeLayers } from './layerList.ts'
import type { LayerItem } from './layerList.ts'
import {
  ACCENT,
  centerOf,
  createFrame,
  createObject,
  frameNameOf,
  hasResidualScale,
  idOf,
  imageSizeOf,
  isFrame,
  isImage,
  isLocked,
  newId,
  normalizeTextScale,
  ownerOf,
  applyTextFormatting,
  readTextFormatting,
  reconcileTextFormatting,
  replaceEditedText,
  selectedRange,
  setFrameName,
  setImageCrop,
  setImageElement,
  setLocked,
  setOwner,
  setTextFontSize,
  toFrameRecord,
  toRecord,
} from './objects.ts'
import type { TextEdit } from './objects.ts'

export type Tool = 'select' | 'hand' | 'text' | 'frame'
export type { LayerItem } from './layerList.ts'

export interface SelectionInfo {
  kind: 'image' | 'text' | 'frame' | 'multiple'
  count: number
  /** Only for a single text object. */
  fontSize: number | null
  /** Only for a single frame. */
  frameName: string | null
  /**
   * Only for a single frame: how many objects it owns. Ownership is not the same as
   * "what sits inside": an object the frame was moved over or drawn round is not owned.
   */
  memberCount: number | null
  /**
   * The selection is one locked object or frame (selected from the layer list). A selection
   * that contains a locked item contains nothing else. Nothing edits it: every `layer` flag
   * is false, and delete, font size, rename and "Select with contents" do nothing.
   */
  locked: boolean
  layer: Record<LayerOp, boolean>
  /** Multi-selection only: which axes have enough room to space its displayed boxes. */
  layout: { spaceX: boolean; spaceY: boolean } | null
  /**
   * Only for a single image: whether it is cropped, and whether Fit and Fill would change
   * anything (both false while it is locked or being cropped).
   */
  image: { cropped: boolean; canFit: boolean; canFill: boolean } | null
  /** Only for a single text: what the formatting controls show. */
  text: TextFormatInfo | null
}

/**
 * The formatting of the one selected text, as the controls show it. While the text is being
 * edited, marks and heading describe the selected range (or, with only a caret, what the
 * next typed character gets, pending choices included); otherwise the whole box.
 */
export interface TextFormatInfo {
  editing: boolean
  font: FontId | 'mixed'
  align: TextAlign
  /** `#rrggbb`; the default ink when the text has no colour of its own. */
  color: string
  marks: Record<Mark, MarkState>
  /** Heading level (0: body text) of every line concerned, or 'mixed'. */
  heading: number | 'mixed'
  /** Bold is the headings' own here and cannot be changed (every character concerned is on a heading line). */
  boldFromHeading: boolean
}

export interface Notice {
  id: number
  kind: 'error' | 'info'
  message: string
}

export interface EditorState {
  ready: boolean
  /**
   * Non-null when the board is shown read-only (it could not be loaded in full, so
   * nothing may be edited or saved). Holds the user-visible reason.
   */
  readOnly: string | null
  /** The read-only state is one that reloading gets out of (another tab changed the board). */
  reloadSuggested: boolean
  tool: Tool
  /** Hand tool is in effect (selected, or Space held). */
  handActive: boolean
  editingText: boolean
  /** Crop mode is open on the selected image (see `startCrop`). */
  cropping: boolean
  selection: SelectionInfo | null
  viewport: Viewport
  objectCount: number
  /**
   * Everything on the board in stacking order, front-most first: content front to back,
   * then frames front to back. Derived from the canvas; selecting from it changes nothing on the board.
   */
  layers: readonly LayerItem[]
  canUndo: boolean
  canRedo: boolean
  save: SaveState
  title: string
  appearance: BoardAppearance
  notice: Notice | null
}

/**
 * One pointer gesture on the canvas, from press to settlement. While it exists the
 * board is "busy": saves see `base` (the scene before the gesture), commands and
 * shortcuts are inert, and Esc or a window blur restores `base`.
 */
interface Gesture {
  /** Fresh per gesture, so a queued settlement can tell that it has been cancelled or replaced. */
  id: number
  kind: 'draft' | 'transform' | 'settling'
  base: Scene
  /** A press on an object: Fabric's own transform record, which identifies the gesture in Fabric's events. */
  transform?: Transform
  /** A drag: the unselected members of the frames being moved, which follow them. */
  carry?: Carry
  /**
   * The Frame tool, or the Text tool (`tool: 'text'`): the rectangle being drawn, in scene
   * coordinates.
   */
  draft?: { start: Point; end: Point; tool?: 'text' }
}

/**
 * Followers of a drag: content owned by a frame that is being moved, but which is not
 * itself in the moved selection. They follow moves only, exactly once, by the same delta.
 */
interface Carry {
  /** Where the dragged target started. */
  left: number
  top: number
  followers: Array<{ obj: FabricObject; left: number; top: number }>
}

/**
 * Crop mode on one image. While it is open the WHOLE original is shown in place (the kept
 * pixels do not move) with the crop rectangle drawn over it, so the canvas temporarily
 * holds an un-cropped image: saves see `base`, nothing is committed, and every command
 * applies the crop first (see `finishEditing`).
 */
interface CropSession {
  /** The scene before the crop opened: what saves see, and what cancelling restores. */
  base: Scene
  target: FabricImage
  /** The image's own Fabric state before the crop opened, restored exactly when nothing changes. */
  before: { left: number; top: number; cropX: number; cropY: number; width: number; height: number; hasControls: boolean; hasBorders: boolean }
  /** The original's size in source pixels. */
  size: Size
  /** Where the whole original lies on the board while cropping (fixed for the session). */
  full: Placement
  /** The crop when the session began (the whole image when there was none). */
  start: CropRect
  /** The crop rectangle as it is now, in source pixels. */
  rect: CropRect
  /** A handle or the box being dragged with the primary button. */
  drag: { startRect: CropRect; end: () => void } | null
}

/** A decoded replacement picture for one image, chosen (by id) when Replace image was pressed. */
interface ReplaceJob {
  targetId: string
  assetId: string
  size: Size
  /** The order in which `replaceImageFile` was called (per editor): the latest request for a target wins. */
  seq: number
}

/** A Frame- or Text-tool press that moves less than this many screen pixels is a click (default-sized frame or text). */
const DRAFT_CLICK_SLOP = 4
/** A Text-tool drag narrower than this many font sizes is no usable width: it gives the default box, as a click does. */
const MIN_TEXT_DRAG_EMS = 2
const NO_FRAMES: ReadonlySet<string> = new Set()

const ZOOM_STEP = 1.25
const MIN_SELECTION_FONT = MIN_FONT_SIZE
const ZOOM_ACTIONS: ReadonlySet<ShortcutAction> = new Set(['zoom-in', 'zoom-out', 'zoom-fit', 'zoom-reset'])
const EMPTY_SCENE: Scene = { frames: [], objects: [] }

/** Bit of `MouseEvent.buttons` for a `MouseEvent.button` (the two number the middle and right buttons differently). */
const buttonMask = (button: number): number => (button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 0)

/** Mouse events carry a button; touch events do not and count as the primary button. */
const isPrimary = (e: Event): boolean => {
  const button = (e as MouseEvent).button
  return button === undefined || button === 0
}

/**
 * Owns the Fabric canvas, history, assets and autosave. React never touches
 * Fabric objects: it renders `getState()` snapshots and calls the methods here.
 * Fabric is the live source of truth for objects; history stores serialized
 * snapshots (see model/) and restores them by rebuilding objects.
 *
 * Fabric event callbacks only record facts and queue one settlement. Nothing that
 * changes selection, objects or history runs inside a Fabric callback: settlement
 * runs in a microtask, after Fabric's own mouse-up handling has returned.
 */
export class Editor {
  private readonly canvas: FrameCanvas
  private readonly canvasEl: HTMLCanvasElement
  private readonly history = new History<Scene>(EMPTY_SCENE, { equals: sceneEqual })
  private readonly autosaver: Autosaver
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: Array<() => void> = []
  private state: EditorState
  private applying = false
  private spaceHeld = false
  private disposed = false
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private noticeSeq = 0
  private gesture: Gesture | null = null
  private gestureSeq = 0
  /** Image batches that finished decoding while a gesture was in progress. */
  private stagedImports: ImageRecord[][] = []
  /** Replacement pictures that finished decoding while a gesture was in progress (applied in request order). */
  private stagedReplacements: ReplaceJob[] = []
  /** Numbers each `replaceImageFile` call, in the order they were made. */
  private replaceSeq = 0
  /**
   * Per image id, the request number of the replacement last applied to it. Kept for the
   * session (ids are never reused, so an entry for an image that is gone is harmless).
   */
  private readonly replaceApplied = new Map<string, number>()
  /** A primary-button press has been passed through to Fabric and not yet released. */
  private primaryDown = false
  private pan: { button: number; end: () => void } | null = null
  private crop: CropSession | null = null
  /** The last press on the canvas applied a crop (so the double-click it may begin does not reopen one). */
  private pressAppliedCrop = false
  /** The press that began the current double-click followed a press that applied a crop. */
  private dblClickAfterCrop = false
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

  constructor(
    private readonly host: HTMLElement,
    private readonly store: BoardStore,
    private readonly assets: AssetSource = new AssetCache(),
  ) {
    this.canvasEl = document.createElement('canvas')
    host.appendChild(this.canvasEl)
    const { width, height } = host.getBoundingClientRect()
    this.canvas = new FrameCanvas(this.canvasEl, {
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
      preserveObjectStacking: true,
      stopContextMenu: true,
      // Only the primary button edits. Other buttons are also kept from Fabric at DOM level (bindDomEvents).
      fireRightClick: false,
      fireMiddleClick: false,
      // Every scale is proportional: no Shift free-scaling and no Shift skewing, which the document could not store.
      uniScaleKey: null,
      altActionKey: null,
      // A press with Alt held goes to the selected object when it is under the pointer, even if
      // something lies on top of it (a covered object selected from the layer list). Without
      // Alt a press goes to the front-most object (inside a multi-selection's box, to the
      // selection). Frames are still hit only by label or outline, and a locked object is
      // never the target of a press.
      altSelectionKey: 'altKey',
      selectionColor: 'rgba(108, 123, 242, 0.08)',
      selectionBorderColor: ACCENT,
      selectionLineWidth: 1,
    })

    this.state = {
      ready: false,
      readOnly: null,
      reloadSuggested: false,
      tool: 'select',
      handActive: false,
      editingText: false,
      cropping: false,
      selection: null,
      viewport: { ...DEFAULT_VIEWPORT },
      objectCount: 0,
      layers: EMPTY_LAYERS,
      canUndo: false,
      canRedo: false,
      save: { kind: 'loading' },
      title: DEFAULT_TITLE,
      appearance: {},
      notice: null,
    }

    this.autosaver = new Autosaver({
      store,
      getDoc: () => this.getDoc(),
      bytes: (id) => this.assets.bytes(id),
      onConflict: (message) => this.enterReadOnly(message, true),
      onStatus: (save) => {
        const failedNow = save.kind === 'error' && this.state.save.kind !== 'error'
        this.setState({ save })
        if (failedNow) this.notify('error', `Couldn’t save to this device: ${save.message}`)
      },
    })

    this.bindCanvasEvents()
    this.bindDomEvents()
    this.applyToolState()
  }

  // ---- external store for React -------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): EditorState => this.state

  private setState(patch: Partial<EditorState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // ---- lifecycle ------------------------------------------------------------

  /** True once hydration has finished. Until then the board accepts no edits and nothing is saved. */
  private get live(): boolean {
    return this.state.ready && !this.disposed
  }

  /** Hydrated and not read-only: the only state in which the board may change. */
  private get editable(): boolean {
    return this.live && this.state.readOnly === null
  }

  /** A pointer gesture is in progress or being settled: commands and shortcuts wait. */
  private get busy(): boolean {
    return this.gesture !== null
  }

  async init(): Promise<void> {
    const outcome = await hydrateBoard(this.store, (asset) => this.assets.load(asset))
    if (this.disposed) return

    switch (outcome.kind) {
      case 'empty':
        this.autosaver.markLoaded(ABSENT)
        break
      case 'restored':
        this.showStoredBoard(outcome.doc) // ownership is restored exactly as stored, never recomputed
        this.autosaver.markLoaded(outcome.token)
        // Only after a complete, successful restore: drop bytes the stored board never referenced.
        // The store re-checks the token, so a prune that arrives after the board changed does nothing.
        void this.store.pruneAssets(referencedAssetIds(outcome.doc.objects), outcome.token).catch(() => {
          /* cleanup only; unreferenced bytes are harmless */
        })
        break
      case 'blocked':
        // Fail closed: show what could be shown, but never write or prune anything.
        if (outcome.partial) this.showStoredBoard(outcome.partial)
        this.enterReadOnly(outcome.message) // surfaced by a persistent banner
        break
    }
    this.history.reset(this.snapshot())
    this.setState({ ready: true })
    this.applyToolState()
    this.syncState()
  }

  /**
   * Makes the session read-only for good (a board that could not be loaded in full, or
   * one another tab has changed since this tab's last save). Nothing is written from
   * here on. An unfinished gesture is undone, images still being imported are dropped,
   * and any text being typed stays visible but is not committed.
   */
  private enterReadOnly(message: string, reloadSuggested = false) {
    if (this.disposed) return
    this.autosaver.disable(message)
    this.cancelGesture()
    this.cancelCrop() // before leaving the edit below, which would apply it
    this.setState({ readOnly: message, reloadSuggested, tool: 'hand' }) // not editable from here on, so leaving the edit below commits nothing
    this.dropStagedImports()
    this.finishEditing()
    this.canvas.discardActiveObject()
    this.applyToolState()
    this.canvas.upperCanvasEl.style.cursor = this.canvas.defaultCursor // the hand at once, not only after the next mouse move
    this.syncState()
  }

  private showStoredBoard(doc: BoardDoc) {
    this.applyRecords(doc)
    this.setState({ title: doc.title, appearance: doc.appearance ?? {} })
    this.setViewport(doc.viewport, false)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.gesture = null // invalidates any queued settlement
    this.stagedImports = []
    this.stagedReplacements = []
    this.pan?.end()
    this.crop?.drag?.end()
    this.crop = null
    for (const c of this.cleanups.splice(0)) c()
    this.autosaver.dispose()
    this.listeners.clear()
    this.assets.dispose()
    void this.canvas.dispose()
    this.host.replaceChildren()
  }

  // ---- document ---------------------------------------------------------------

  /** Everything on the canvas as records: frames and content, each back to front. */
  private snapshot(): Scene {
    const frames: FrameRecord[] = []
    const objects: Scene['objects'] = []
    for (const obj of this.canvas.getObjects()) {
      const frame = toFrameRecord(obj)
      if (frame) {
        frames.push(frame)
        continue
      }
      // A blank text is not content: it exists on the canvas only while it is being typed
      // into, and is discarded when that edit ends. Keeping it out of the scene means no
      // save (whatever triggered it: typing, a pan, a title edit) and no history step can
      // ever hold one.
      if (obj instanceof Textbox && obj.text.trim() === '') continue
      const rec = toRecord(obj)
      if (rec) objects.push(rec)
    }
    return { frames, objects }
  }

  /**
   * What a save should store right now. A save never sees an unfinished gesture or an open
   * crop: while one exists the scene is the one from before it. Title and viewport are always live.
   */
  private getDoc(): BoardDoc {
    // After dispose the canvas is being cleared: a scene read now would describe an empty board.
    // The autosaver never asks then; refusing makes sure no save can ever store that.
    if (this.disposed) throw new Error('The editor has been disposed.')
    const scene = this.gesture ? this.gesture.base : this.crop ? this.crop.base : this.snapshot()
    const { appearance, title } = this.state
    return { version: DOC_VERSION, title, ...scene, viewport: this.getViewport(), ...((appearance.style || appearance.presets) && { appearance }) }
  }

  /**
   * Records the live board as a history step. A no-op when nothing changed: no history
   * entry and no save. Never changes ownership or anything else on the canvas.
   */
  private commit(coalesceKey?: string) {
    if (this.applying || !this.editable || this.gesture || this.crop) return
    if (this.history.push(this.snapshot(), coalesceKey)) this.autosaver.markDirty()
    this.syncState()
  }

  /** Rebuilds the canvas from records (frames behind content), preserving selection by id. */
  private applyRecords(scene: Scene) {
    this.applying = true
    this.pending = null
    this.shortcutRevert = null
    try {
      const selected = new Set(this.selectedIds())
      this.canvas.discardActiveObject()
      const existing = this.canvas.getObjects()
      if (existing.length) this.canvas.remove(...existing)
      const built: FabricObject[] = scene.frames.map((rec) => createFrame(rec))
      for (const rec of scene.objects) {
        if (rec.type === 'text' && rec.text.trim() === '') continue // an old board may still store a blank text: invisible, so not shown
        const obj = createObject(rec, (id) => this.assets.get(id))
        if (obj) built.push(obj)
      }
      if (built.length) this.canvas.add(...built)
      this.selectByIds(built.filter((o) => selected.has(idOf(o) ?? '')))
    } finally {
      this.applying = false
    }
    this.canvas.requestRenderAll()
  }

  /**
   * Selects exactly these objects. A selection that contains a locked item contains nothing
   * else: locked items are left out of a multi-selection (a single locked item stays
   * selected). Every selection the editor forms goes through here, including the one
   * restored by id after undo and redo.
   */
  private selectByIds(objs: FabricObject[]) {
    if (objs.length > 1) objs = objs.filter((o) => !isLocked(o))
    if (objs.length === 0) return
    if (objs.length === 1) this.canvas.setActiveObject(objs[0] as FabricObject)
    else this.canvas.setActiveObject(new ActiveSelection(objs, { canvas: this.canvas }))
  }

  private selectedIds(): string[] {
    return this.canvas
      .getActiveObjects()
      .map(idOf)
      .filter((id): id is string => id !== undefined)
  }

  /** Every frame as a record, back to front. */
  private frameRecords(): FrameRecord[] {
    const out: FrameRecord[] = []
    for (const o of this.canvas.getObjects()) {
      const rec = toFrameRecord(o)
      if (rec) out.push(rec)
    }
    return out
  }

  /** Rule O4: content that has just been created belongs to the front-most frame its centre is inside. */
  private ownerForNew(obj: FabricObject): string | undefined {
    return ownerAfterManipulation(undefined, centerOf(obj), this.frameRecords(), NO_FRAMES)
  }

  /** Canvas ids split into the two z-bands, each back to front. */
  private layeredOrder(): { frames: string[]; objects: string[] } {
    const frames: string[] = []
    const objects: string[] = []
    for (const o of this.canvas.getObjects()) (isFrame(o) ? frames : objects).push(idOf(o) ?? '')
    return { frames, objects }
  }

  // ---- state derived from the canvas -----------------------------------------

  private computeSelection(): SelectionInfo | null {
    const objs = this.canvas.getActiveObjects()
    if (objs.length === 0) return null
    const ids = new Set(this.selectedIds())
    const order = this.layeredOrder()
    const first = objs[0]
    const single = objs.length === 1 ? first : undefined
    const frame = single && isFrame(single) ? single : undefined
    const frameId = frame ? idOf(frame) : undefined
    const locked = single !== undefined && isLocked(single)
    const bounds = objs.length >= 3 ? this.layoutBounds(objs) : []
    return {
      kind: objs.length > 1 ? 'multiple' : frame ? 'frame' : single instanceof Textbox ? 'text' : 'image',
      count: objs.length,
      fontSize: single instanceof Textbox ? Math.max(MIN_SELECTION_FONT, Math.round(single.fontSize * 10) / 10) : null,
      frameName: frame ? (frameNameOf(frame) ?? '') : null,
      memberCount: frame ? this.canvas.getObjects().filter((o) => ownerOf(o) === frameId).length : null,
      locked,
      layer: {
        front: !locked && canReorderLayered(order, ids, 'front'),
        forward: !locked && canReorderLayered(order, ids, 'forward'),
        backward: !locked && canReorderLayered(order, ids, 'backward'),
        back: !locked && canReorderLayered(order, ids, 'back'),
      },
      layout: objs.length < 2 ? null : { spaceX: layoutOffsets(bounds, 'space-x') !== null, spaceY: layoutOffsets(bounds, 'space-y') !== null },
      image: isImage(single) ? this.imageInfo(single, locked) : null,
      text: single instanceof Textbox ? this.textFormatInfo(single) : null,
    }
  }

  private imageInfo(img: FabricImage, locked: boolean): SelectionInfo['image'] {
    const rec = toRecord(img)
    if (rec?.type !== 'image') return null
    // While cropping the image is shown whole; it counts as cropped if the crop the session began with was.
    if (this.crop?.target === img) return { cropped: !isWholeImage(this.crop.start, this.crop.size), canFit: false, canFill: false }
    if (locked || this.crop) return { cropped: rec.crop !== undefined, canFit: false, canFill: false }
    const size = imageSizeOf(img)
    const changes = (next: ImageRecord) => !sceneEqual({ frames: [], objects: [rec] }, { frames: [], objects: [next] })
    return { cropped: rec.crop !== undefined, canFit: changes(fitRecord(rec, size)), canFill: changes(fillRecord(rec, size)) }
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
   * Refreshes only the selection info, and only tells React when it really changed: the caret
   * moving inside a text being edited fires often, mostly without changing what the
   * formatting controls show.
   */
  private syncSelection() {
    const selection = this.computeSelection()
    if (JSON.stringify(selection) === JSON.stringify(this.state.selection)) return
    this.setState({ selection })
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
      if (!this.disposed) this.syncSelection()
    })
  }

  private syncState() {
    const active = this.canvas.getActiveObject()
    this.setState({
      selection: this.computeSelection(),
      objectCount: this.canvas.getObjects().length,
      layers: computeLayers(this.canvas.getObjects(), this.canvas.getActiveObjects(), (id) => this.assets.bytes(id)?.name, this.state.layers),
      // An open crop that differs from where it began can be undone too: Undo applies it, then undoes it.
      canUndo: this.history.canUndo || (this.crop !== null && !sameCrop(storedCrop(this.crop.rect, this.crop.size), storedCrop(this.crop.start, this.crop.size))),
      canRedo: this.history.canRedo,
      editingText: active instanceof Textbox && active.isEditing === true,
      cropping: this.crop !== null,
    })
  }

  // ---- canvas events -----------------------------------------------------------

  private bindCanvasEvents() {
    const c = this.canvas
    const onSelection = () => {
      const active = c.getActiveObject()
      if (active instanceof ActiveSelection) {
        // Frames have no angle, so a selection that contains one cannot be rotated. A
        // content-only selection can. (Set both ways: Shift-click changes a selection in place.)
        const hasFrame = active.getObjects().some(isFrame)
        active.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false, mtr: !hasFrame })
        active.set({
          borderColor: ACCENT,
          cornerColor: '#ffffff',
          cornerStrokeColor: ACCENT,
          cornerStyle: 'rect',
          cornerSize: 9,
          transparentCorners: false,
          borderScaleFactor: 1.5,
          lockScalingFlip: true,
          lockRotation: hasFrame,
        })
      }
      // A selection that already was rotated when a frame joined it (Shift-click) would keep
      // its turned box, with rotation now locked. Re-form it upright; nothing on the board
      // moves, the members keep their own angles. After Fabric's own handling has returned.
      if (active instanceof ActiveSelection && active.angle !== 0 && active.getObjects().some(isFrame)) {
        queueMicrotask(() => {
          if (this.disposed || this.gesture || c.getActiveObject() !== active || c._currentTransform) return
          const members = active.getObjects().slice()
          c.discardActiveObject()
          this.selectByIds(members)
          c.requestRenderAll()
        })
      }
      // A selection that contains a locked item contains nothing else. Fabric's own paths never
      // add one (a locked item is not selectable, and FrameCanvas refuses Shift-click on a
      // locked selection) and the editor's go through selectByIds, so this only guards against
      // a path missed: such a selection is formed again without its locked members.
      if (active instanceof ActiveSelection && active.getObjects().some(isLocked)) {
        queueMicrotask(() => {
          if (this.disposed || this.gesture || c.getActiveObject() !== active || c._currentTransform) return
          const members = active.getObjects().slice()
          c.discardActiveObject()
          this.selectByIds(members)
          c.requestRenderAll()
        })
      }
      // A frame on its own is a container and resizes freely; everything else, including any
      // multi-selection, scales proportionally.
      c.uniformScaling = !(!!active && !(active instanceof ActiveSelection) && isFrame(active))
      this.syncState()
    }
    c.on('selection:created', onSelection)
    c.on('selection:updated', onSelection)
    c.on('selection:cleared', onSelection)

    // A press on an object (Fabric fires this for every such press, moved or not).
    c.on('before:transform', ({ transform }) => {
      if (!this.editable) return
      const target = transform.target
      // Caret and text-selection presses inside an editing textbox stay on the text path.
      if (target instanceof Textbox && target.isEditing) return
      const g: Gesture = { id: ++this.gestureSeq, kind: 'transform', base: this.snapshot(), transform }
      if (transform.action === 'drag') g.carry = this.collectFollowers(target)
      this.gesture = g
    })

    // Members of a moved frame that are not themselves selected follow it, by the same delta.
    c.on('object:moving', ({ transform }) => {
      const g = this.gesture
      if (g?.kind === 'transform' && g.carry && g.transform === transform) this.placeFollowers(g.carry, transform.target)
    })

    // The Frame tool: a primary press starts drawing a frame. Only facts are recorded here.
    c.on('mouse:down', (opt) => {
      if (!this.editable || this.state.tool !== 'frame' || this.state.handActive || !isPrimary(opt.e)) return
      const p = c.getScenePoint(opt.e)
      const start = { x: p.x, y: p.y }
      this.gesture = { id: ++this.gestureSeq, kind: 'draft', base: this.snapshot(), draft: { start, end: start } }
    })
    // The Text tool: a primary press on empty canvas (or a frame's click-through interior)
    // starts dragging out a text box. A press on an object, or on a frame's label or outline,
    // is Fabric's as before (it has a target). A plain click is this draft too, settled as a
    // default box. Only facts are recorded here.
    c.on('mouse:down', (opt) => {
      if (!this.editable || this.gesture || this.state.tool !== 'text' || this.state.handActive || !isPrimary(opt.e) || opt.target) return
      const p = c.getScenePoint(opt.e)
      const start = { x: p.x, y: p.y }
      this.gesture = { id: ++this.gestureSeq, kind: 'draft', base: this.snapshot(), draft: { start, end: start, tool: 'text' } }
    })
    c.on('mouse:move', (opt) => {
      const g = this.gesture
      if (g?.kind !== 'draft' || !g.draft) return
      const p = c.getScenePoint(opt.e)
      g.draft.end = { x: p.x, y: p.y }
      c.draft = rectFromDrag(g.draft.start, g.draft.end) // drawing only; nothing on the board changes
      c.requestRenderAll()
    })

    c.on('object:modified', ({ target, transform }) => {
      if (this.applying || !this.editable) return
      const g = this.gesture
      if (g) {
        // Only the release of this gesture's own transform settles it, and only once.
        if (transform !== undefined && transform === g.transform && g.kind === 'transform') {
          g.kind = 'settling'
          const id = g.id
          queueMicrotask(() => this.settle(id))
        }
        return
      }
      // No gesture: a text left its edit with changes, or an editing textbox was resized by
      // a handle. (Fabric 7.4 hides an editing textbox's handles, so the second case is not
      // reachable today; the limit is applied anyway so that it can never bypass it.)
      if (target instanceof Textbox) {
        if (transform && isScaleAction(transform)) this.limitScale(transform, [], [{ fontSize: target.fontSize }])
        normalizeTextScale(target)
      }
      this.commit()
    })

    c.on('text:editing:entered', () => this.syncState())
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
      if (!this.applying && this.editable) this.autosaver.markDirty() // keep typing durable; history commits on exit
      this.syncState() // the layer list follows typing (a text that is blank right now is not listed); marks nothing dirty
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
      if (this.applying || !this.editable) return
      if (target instanceof Textbox && target.text.trim() === '') {
        // A blank text is discarded. It is already out of the scene (see snapshot), so the
        // commit below records its removal now. The object itself is taken off the canvas
        // only after Fabric has finished leaving the edit: Fabric still fires events on the
        // text after this callback, and they fail on a text that has no canvas any more.
        queueMicrotask(() => {
          if (this.disposed || target.isEditing || target.text.trim() !== '' || !c.getObjects().includes(target)) return
          // Shift-clicking another object leaves the edit AND puts this text into a new
          // multi-selection. Take it out again, or the selection would keep a member that is
          // no longer on the canvas.
          const active = c.getActiveObject()
          if (active instanceof ActiveSelection && active.getObjects().includes(target) && !c._currentTransform) {
            const rest = active.getObjects().filter((o) => o !== target)
            c.discardActiveObject()
            c.remove(target)
            this.selectByIds(rest)
          } else {
            c.remove(target)
          }
          c.requestRenderAll()
          this.syncState()
        })
      } else if (target instanceof Textbox && !this.history.current.objects.some((o) => o.id === idOf(target))) {
        // A NEW text (history has never held it): its box grew while it was typed, so its
        // owner is decided once more from where it ended up. Re-editing an existing text
        // never changes its owner, whatever the typing does to its size.
        setOwner(target, ownerAfterManipulation(ownerOf(target), centerOf(target), this.frameRecords(), NO_FRAMES))
      }
      this.commit()
    })

    // Double-clicking a frame's label (or outline) is "rename": the UI puts the cursor in the
    // name field. Deferred, like everything else that follows from a canvas event.
    c.on('mouse:dblclick', (opt) => {
      const target = opt.target
      if (!this.editable || this.busy || this.crop || !target) return
      if (isFrame(target)) {
        queueMicrotask(() => {
          if (this.editable && !this.busy && c.getActiveObject() === target) this.frameRenamer?.()
        })
        return
      }
      // Double-clicking an unlocked image with the Select tool opens crop mode. (A locked image
      // is never the target: the double-click falls through to what is beneath it.) Not when
      // the double-click began with the press that applied a crop.
      if (!isImage(target) || isLocked(target) || this.state.tool !== 'select' || this.state.handActive || this.dblClickAfterCrop) return
      queueMicrotask(() => {
        if (this.editable && !this.busy && !this.crop && c.getActiveObject() === target) this.startCrop()
      })
    })

    // Crop mode: the whole image dimmed outside the crop rectangle, the box and its handles.
    c.on('after:render', ({ ctx }) => {
      const s = this.crop
      if (!s || ctx !== c.getContext()) return
      drawCropOverlay(ctx, cropOverlay(s.full, s.size, s.rect, c.viewportTransform), c.getRetinaScaling())
    })

    c.on('mouse:up', (opt) => {
      if (!isPrimary(opt.e)) return // other buttons never start, finish or clear anything
      const g = this.gesture
      if (g?.kind === 'transform') {
        // A press that never moved: Fabric fired no `object:modified`. Nothing changed, so
        // nothing is normalized, reconciled, recorded or saved.
        this.gesture = null
      } else if (g?.kind === 'draft' && g.draft) {
        const end = c.getScenePoint(opt.e)
        g.draft.end = { x: end.x, y: end.y }
        g.kind = 'settling'
        const id = g.id
        queueMicrotask(() => this.settle(id))
      }
      this.queueIdle()
    })
  }

  // ---- gestures ----------------------------------------------------------------------

  /**
   * Finishes a performed gesture. Runs in a microtask queued from `object:modified` (or
   * from the release that ends a frame draft), i.e. after Fabric has finished its own
   * mouse-up handling, so dissolving and re-forming a selection here cannot re-enter
   * Fabric's transform finalization.
   */
  private settle(id: number) {
    const g = this.gesture
    if (!g || g.id !== id) return // cancelled or replaced since it was queued
    if (!this.editable) {
      this.gesture = null
      return
    }
    try {
      if (g.draft) this.settleDraft(g.draft)
      else if (g.transform) this.settleTransform(g, g.transform)
    } finally {
      // Whatever happened, the gesture is over: the board must never stay busy.
      this.gesture = null
      this.canvas.requestRenderAll()
      this.commit()
      this.idle()
    }
  }

  /** The Frame tool's release: one new frame, selected, and back to the Select tool. A new frame owns nothing (rule O5). */
  private settleDraft(draft: { start: Point; end: Point; tool?: 'text' }) {
    if (draft.tool === 'text') return this.settleTextDraft(draft)
    this.canvas.draft = null
    const { start, end } = draft
    const zoom = this.getViewport().zoom
    const dragged = Math.hypot(end.x - start.x, end.y - start.y) * zoom >= DRAFT_CLICK_SLOP
    let box: Box
    if (dragged) {
      // At least the minimum size, growing away from the press point in the drag's direction.
      const width = Math.max(Math.abs(end.x - start.x), MIN_FRAME_SIZE)
      const height = Math.max(Math.abs(end.y - start.y), MIN_FRAME_SIZE)
      box = { left: end.x < start.x ? start.x - width : start.x, top: end.y < start.y ? start.y - height : start.y, width, height }
    } else {
      // A plain click: a default frame of a fixed size on screen, its corner at the click.
      box = { left: start.x, top: start.y, width: DEFAULT_FRAME_SCREEN.width / zoom, height: DEFAULT_FRAME_SCREEN.height / zoom }
    }
    this.switchTool('select') // the tool is single-use
    this.insertFrame(box)
  }

  /**
   * The Text tool's release: one new, blank text being edited, and back to the Select tool.
   * Dragged (at least the slop long, in screen pixels): the box takes the drag's smaller x and
   * y, its width and a minimum height, as long as the drag is at least `MIN_TEXT_DRAG_EMS`
   * font sizes wide. A click, a shorter drag or a narrower one: the default
   * box with its top-left at the press point (see `addTextAt`). An image import that
   * finished during the drag is added first, as its own step, because adding it ends any edit
   * and would discard the new text while it is still blank.
   */
  private settleTextDraft(draft: { start: Point; end: Point }) {
    this.canvas.draft = null
    const { start, end } = draft
    const dragged = Math.hypot(end.x - start.x, end.y - start.y) * this.getViewport().zoom >= DRAFT_CLICK_SLOP
    this.gesture = null
    this.idle()
    this.addTextAt(start, 'top-left', dragged ? end : undefined)
  }

  /** Adds a frame in front of every other frame and behind all content, and selects it. */
  private insertFrame(box: Box): FabricObject {
    const frames = this.frameRecords()
    const obj = createFrame({
      id: newId(),
      name: nextFrameName(frames.map((f) => f.name)),
      left: round(box.left),
      top: round(box.top),
      width: roundPositive(box.width),
      height: roundPositive(box.height),
    })
    this.canvas.insertAt(frames.length, obj)
    this.canvas.discardActiveObject()
    this.canvas.setActiveObject(obj)
    this.canvas.requestRenderAll()
    return obj
  }

  /** A performed transform: followers, the scale limit with folding and baking, then ownership. */
  private settleTransform(g: Gesture, transform: Transform) {
    const target = transform.target
    // Taken before anything is dissolved: these objects are "the transformed set".
    const members = target instanceof ActiveSelection ? target.getObjects().slice() : [target]
    if (g.carry) this.placeFollowers(g.carry, target)
    this.settleScale(g.base, transform, members)
    this.applyOwnership(g.base, members)
  }

  /** Unselected members of the frames being dragged, with where they and the target started. */
  private collectFollowers(target: FabricObject): Carry {
    const moved = new Set<FabricObject>(target instanceof ActiveSelection ? target.getObjects() : [target])
    const movedFrames = new Set<string>()
    for (const o of moved) if (isFrame(o)) movedFrames.add(idOf(o) ?? '')
    const followers: Carry['followers'] = []
    if (movedFrames.size > 0) {
      for (const o of this.canvas.getObjects()) {
        const owner = ownerOf(o)
        // A selected member moves through the selection; carrying it too would move it twice.
        if (owner !== undefined && movedFrames.has(owner) && !moved.has(o)) followers.push({ obj: o, left: o.left, top: o.top })
      }
    }
    return { left: target.left, top: target.top, followers }
  }

  private placeObject(obj: FabricObject, left: number, top: number) {
    obj.set({ left, top })
    obj.setCoords()
  }

  private placeFollowers(carry: Carry, target: FabricObject) {
    const dx = target.left - carry.left
    const dy = target.top - carry.top
    for (const f of carry.followers) this.placeObject(f.obj, f.left + dx, f.top + dy)
  }

  /**
   * Ownership follows what the user manipulated. Evaluated from final scene-space centres
   * and frame rectangles, and only when the gesture changed something.
   *  - O1, content in the transformed set: keeps an owner that was transformed with it;
   *    else keeps an owner that still contains it; else joins the front-most frame that
   *    contains it and was NOT transformed in this gesture, or becomes loose.
   *  - O3, a frame in the transformed set whose size changed: members it no longer contains
   *    (and that were not transformed with it) become loose. They are never transferred.
   * A frame never gains a member by being moved, resized or drawn. Followers and
   * everything stationary keep their owner.
   */
  private applyOwnership(base: Scene, members: readonly FabricObject[]) {
    const now = this.snapshot()
    if (sceneEqual(now, base)) return
    const transformed = new Set(members)
    const coTransformed = new Set<string>()
    for (const m of members) if (isFrame(m)) coTransformed.add(idOf(m) ?? '')

    for (const m of members) {
      if (!isFrame(m)) setOwner(m, ownerAfterManipulation(ownerOf(m), centerOf(m), now.frames, coTransformed))
    }
    for (const id of coTransformed) {
      const before = base.frames.find((f) => f.id === id)
      const after = now.frames.find((f) => f.id === id)
      if (!before || !after || (before.width === after.width && before.height === after.height)) continue
      const rest = this.canvas.getObjects().filter((o) => ownerOf(o) === id && !transformed.has(o))
      const released = new Set(membersToRelease(after, rest.map((o) => ({ id: idOf(o) ?? '', centre: centerOf(o) }))))
      for (const o of rest) if (released.has(idOf(o) ?? '')) setOwner(o, undefined)
    }
  }

  /**
   * A proportional scale is limited by one common factor for everything it transforms,
   * computed from pre-gesture values, and only then folded into the members. Folding
   * and baking apply no further limit, so proportions are exact. A frame resized on its
   * own is not proportional and is limited per axis instead.
   */
  private settleScale(base: Scene, transform: Transform, members: readonly FabricObject[]) {
    if (!isScaleAction(transform)) return
    const target = transform.target
    if (!(target instanceof ActiveSelection) && isFrame(target)) {
      this.bakeFrameAlone(base, transform)
      return
    }
    const baseTexts: Array<{ fontSize: number }> = []
    const baseFrames: FrameRecord[] = []
    for (const m of members) {
      const id = idOf(m)
      if (isFrame(m)) {
        const rec = base.frames.find((f) => f.id === id)
        if (rec) baseFrames.push(rec)
      } else if (m instanceof Textbox) {
        const rec = base.objects.find((o) => o.id === id)
        if (rec?.type === 'text') baseTexts.push({ fontSize: rec.fontSize })
      }
    }
    this.limitScale(transform, baseFrames, baseTexts)

    if (target instanceof ActiveSelection) {
      // Judged per member, on its absolute scale: a selection that returns to scale 1 can
      // still leave a member scaled (one that joined while the selection was scaled).
      if (members.some((o) => (o instanceof Textbox || isFrame(o)) && hasResidualScale(o))) {
        // Fold the scale into member text (font size/width) and bake it into member frames
        // (which are stored at scale 1), which means dissolving and re-forming the selection.
        const keep = members.slice()
        this.canvas.discardActiveObject()
        for (const o of keep) {
          if (o instanceof Textbox) normalizeTextScale(o)
          else if (isFrame(o)) bakeFrame(o)
        }
        this.selectByIds(keep)
      }
    } else if (target instanceof Textbox) {
      normalizeTextScale(target)
    }
  }

  /**
   * A frame resized on its own: its scale becomes its size. Each side may not go below
   * the minimum, or below its own pre-gesture length if that was already smaller (it may
   * grow, and is never snapped up). The edge opposite the dragged handle stays fixed.
   */
  private bakeFrameAlone(base: Scene, transform: Transform) {
    const frame = transform.target
    const before = base.frames.find((f) => f.id === idOf(frame))
    const anchor = frame.translateToOriginPoint(frame.getCenterPoint(), transform.originX, transform.originY)
    let width = frame.width * Math.abs(frame.scaleX)
    let height = frame.height * Math.abs(frame.scaleY)
    if (before) {
      width = Math.max(width, minFrameSide(before.width))
      height = Math.max(height, minFrameSide(before.height))
    }
    frame.set({ width: roundPositive(width), height: roundPositive(height), scaleX: 1, scaleY: 1 })
    frame.setPositionByOrigin(anchor, transform.originX, transform.originY)
    frame.setCoords()
  }

  /**
   * Replaces the requested scale factor of a finished scale gesture by the allowed one,
   * keeping the gesture's own anchor (the corner opposite the dragged handle) fixed.
   */
  private limitScale(transform: Transform, baseFrames: readonly FrameRecord[], baseTexts: ReadonlyArray<{ fontSize: number }>) {
    const target = transform.target
    const original = transform.original
    if (!original.scaleX || !original.scaleY) return
    const requested = target.scaleX / original.scaleX
    const allowed = allowedScaleFactor(requested, baseFrames, baseTexts)
    if (Math.abs(allowed - requested) <= 1e-9) return
    const anchor = target.translateToOriginPoint(target.getCenterPoint(), transform.originX, transform.originY)
    target.set({ scaleX: original.scaleX * allowed, scaleY: original.scaleY * allowed })
    target.setPositionByOrigin(anchor, transform.originX, transform.originY)
    target.setCoords()
  }

  /**
   * Abandons the gesture in progress (Esc, window blur, going read-only) and restores
   * the board from before it. No history entry and no save. Returns false when there
   * was nothing to cancel.
   */
  private cancelGesture(): boolean {
    const g = this.gesture
    if (!g) return false
    if (g.draft) {
      // Nothing on the board has changed yet: just drop the rectangle being drawn.
      this.gesture = null
      this.canvas.draft = null
      this.canvas.requestRenderAll()
      return true
    }
    this.applying = true // Fabric may fire `object:modified` while its transform is ended; it must not settle
    try {
      if (g.transform && this.canvas._currentTransform === g.transform) this.canvas.endCurrentTransform()
    } finally {
      this.applying = false
    }
    this.applyRecords(g.base)
    this.gesture = null // also invalidates a queued settlement
    this.syncState()
    return true
  }

  private queueIdle() {
    queueMicrotask(() => this.idle())
  }

  /** The board is at rest: apply what had to wait for a gesture to end. */
  private idle() {
    if (this.gesture || !this.editable) return
    for (const batch of this.stagedImports.splice(0)) this.applyImport(batch)
    // In the order they were requested, so the latest request for an image is the one left showing.
    for (const job of this.stagedReplacements.splice(0).sort((a, b) => a.seq - b.seq)) this.applyReplace(job)
  }

  private dropStagedImports() {
    const dropped = this.stagedImports.reduce((n, batch) => n + batch.length, 0)
    this.stagedImports = []
    const replacements = this.stagedReplacements.length
    this.stagedReplacements = []
    // One notice slot: both facts go in one message.
    const why = 'because the board became read-only.'
    if (dropped > 0 && replacements > 0) {
      const images = (n: number) => `${n} image${n === 1 ? '' : 's'}`
      this.notify('error', `${images(dropped)} ${dropped === 1 ? 'was' : 'were'} not added and ${images(replacements)} ${replacements === 1 ? 'was' : 'were'} not replaced ${why}`)
    } else if (dropped > 0) {
      this.notify('error', `${dropped} image${dropped === 1 ? ' was' : 's were'} not added ${why}`)
    } else if (replacements > 0) {
      this.notify('error', `${replacements === 1 ? 'An image was' : `${replacements} images were`} not replaced ${why}`)
    }
  }

  private bindDomEvents() {
    const wrapper = this.canvas.wrapperEl
    const listen = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      el.addEventListener(type, fn, opts)
      this.cleanups.push(() => el.removeEventListener(type, fn, opts))
    }

    // Runs before Fabric (capture phase): decides which presses Fabric may see at all.
    listen(
      wrapper,
      'mousedown',
      (e) => {
        if (!this.live) {
          // Still hydrating: the board is inert.
          e.preventDefault()
          e.stopPropagation()
          return
        }
        this.healPrimaryDown(e)
        if (e.button !== 0) {
          // Fabric must never observe a non-primary button: its handlers would drop the
          // document listeners of a primary drag that is still in progress.
          e.preventDefault()
          e.stopPropagation()
          if (e.button === 1 && !this.primaryDown && !this.crop?.drag) {
            this.finishEditing({ keepCrop: true }) // panning keeps crop mode open
            this.beginPan(e)
          }
          return
        }
        if (this.state.handActive) {
          e.preventDefault()
          e.stopPropagation()
          this.finishEditing({ keepCrop: true })
          this.beginPan(e)
          return
        }
        if (this.crop) {
          // Crop mode: Fabric never sees a primary press, so no Fabric gesture can begin.
          e.preventDefault()
          e.stopPropagation()
          this.cropPress(e)
          return
        }
        this.dblClickAfterCrop = this.pressAppliedCrop
        this.pressAppliedCrop = false
        this.primaryDown = true
      },
      { capture: true },
    )

    // Crop mode: the cursor says what a press would grab (Fabric applies `defaultCursor`, as nothing is a target).
    listen(
      wrapper,
      'mousemove',
      (e) => {
        const s = this.crop
        if (!s || s.drag || this.state.handActive) return
        const hit = this.cropHitAt(s, e)
        this.canvas.defaultCursor = hit ? cropCursor(hit, s.full.angle) : 'default'
      },
      { capture: true },
    )

    // One permanent release listener. Capture on window runs before Fabric's own
    // (bubble-phase, document) listener, so it can keep non-primary releases from it.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        this.primaryDown = false
        if (this.pan?.button === 0) this.pan.end()
        return // Fabric finishes its drag with this event
      }
      if (this.pan?.button === e.button) this.pan.end()
      this.healPrimaryDown(e)
      // A primary drag is in progress: this release is not Fabric's business, and letting
      // it through would end Fabric's tracking of the drag.
      if (this.primaryDown) e.stopPropagation()
    }
    // A native drag (e.g. dragging selected text) ends with `dragend` and no `mouseup` at all.
    const onDragEnd = () => {
      this.primaryDown = false
    }
    window.addEventListener('mouseup', onMouseUp, { capture: true })
    window.addEventListener('dragend', onDragEnd, { capture: true })
    this.cleanups.push(() => {
      window.removeEventListener('mouseup', onMouseUp, { capture: true })
      window.removeEventListener('dragend', onDragEnd, { capture: true })
    })

    listen(
      wrapper,
      'wheel',
      (e) => {
        e.preventDefault()
        if (!this.live) return
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.host.clientHeight : 1
        if (e.ctrlKey || e.metaKey) {
          const rect = this.host.getBoundingClientRect()
          const at = { x: e.clientX - rect.left, y: e.clientY - rect.top }
          this.setViewport(zoomAround(this.getViewport(), at, this.getViewport().zoom * Math.exp((-e.deltaY * unit) / 300)))
        } else {
          const vp = this.getViewport()
          const dx = (e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) * unit
          const dy = (e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY) * unit
          this.setViewport({ ...vp, panX: vp.panX - dx, panY: vp.panY - dy })
        }
      },
      { passive: false },
    )

    const ro = new ResizeObserver(() => {
      const { width, height } = this.host.getBoundingClientRect()
      if (width > 0 && height > 0) {
        this.canvas.setDimensions({ width: Math.floor(width), height: Math.floor(height) })
        this.canvas.requestRenderAll()
      }
    })
    ro.observe(this.host)
    this.cleanups.push(() => ro.disconnect())

    const onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e)
    const onKeyUp = (e: KeyboardEvent) => {
      this.typed = null // what the key typed has arrived by now, if it typed anything
      if (e.code === 'Space' && this.spaceHeld) {
        this.spaceHeld = false
        this.applyToolState()
      }
    }
    const onBlur = () => {
      if (this.spaceHeld) {
        this.spaceHeld = false
        this.applyToolState()
      }
      // The release of whatever was held may never arrive: undo the unfinished gesture.
      this.pan?.end()
      if (this.cancelGesture()) this.queueIdle()
      // A crop handle drag returns to where it began; crop mode stays open.
      if (this.crop?.drag) this.endCropDrag(false)
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') void this.autosaver.flush()
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (this.autosaver.hasUnsavedChanges) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    this.cleanups.push(() => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
    })
  }

  /**
   * The primary release can be lost (it went to another window, or a native drag ended
   * without one). Every later mouse event says which buttons are really held, so the flag
   * corrects itself instead of swallowing non-primary releases indefinitely.
   */
  private healPrimaryDown(e: MouseEvent) {
    if (this.primaryDown && (e.buttons & 1) === 0) this.primaryDown = false
  }

  /**
   * Starts a pan owned by the button that started it. That button's release ends it (or a
   * blur, or a move that shows the button is no longer held, in case the release was lost).
   */
  private beginPan(start: MouseEvent) {
    this.pan?.end()
    let last = { x: start.clientX, y: start.clientY }
    const held = buttonMask(start.button)
    this.canvas.upperCanvasEl.style.cursor = 'grabbing'
    const move = (e: MouseEvent) => {
      if ((e.buttons & held) === 0) {
        end()
        return
      }
      const vp = this.getViewport()
      this.setViewport({ ...vp, panX: vp.panX + (e.clientX - last.x), panY: vp.panY + (e.clientY - last.y) })
      last = { x: e.clientX, y: e.clientY }
    }
    const end = () => {
      window.removeEventListener('mousemove', move)
      this.canvas.upperCanvasEl.style.cursor = ''
      this.pan = null
    }
    window.addEventListener('mousemove', move)
    this.pan = { button: start.button, end }
  }

  handleKeyDown(e: KeyboardEvent) {
    if (!this.live) return
    const active = this.canvas.getActiveObject()
    const edited = active instanceof Textbox && active.isEditing ? active : null
    const ctx = { editingText: this.state.editingText, textSelected: active instanceof Textbox && !active.isEditing, hasSelection: !!active }
    const editing = { editedTextarea: edited?.hiddenTextarea ?? null, canRevertShortcut: edited !== null && this.shortcutRevert?.target === edited }
    this.typed = this.busy ? null : typedCharacter(e, editing) // observed only, never claimed
    if (this.busy) {
      // Mid-gesture: Esc cancels it, zoom still works, everything else waits.
      const action = resolveShortcut(e, ctx)
      if (action === 'escape') {
        e.preventDefault()
        const drawing = this.gesture?.draft !== undefined
        this.cancelGesture()
        if (drawing) this.switchTool('select') // Esc while drawing a frame also leaves the Frame tool
        this.queueIdle()
      } else if (action && ZOOM_ACTIONS.has(action)) {
        e.preventDefault()
        this.run(action)
      } else if (action) {
        e.preventDefault() // a shortcut that is ignored: the browser must not act on it either (Ctrl+A would select the page's text)
      }
      return
    }
    // Keys typed into the text being edited reach this window listener from Fabric's hidden
    // textarea; Fabric does nothing with Ctrl/Cmd+B, I or U and lets them bubble (fabric
    // 7.4.0, ITextKeyBehavior.mjs `onKeyDown`, constants.mjs `ctrlKeysMapDown`), so no capture
    // listener is needed. Backspace is not Fabric's either: the textarea deletes and Fabric
    // follows from its input event (constants.mjs `keysMap` has no Backspace), so preventing it
    // here keeps anything from being deleted. Everything else typed there is left alone.
    const claimed = resolveEditingShortcut(e, editing)
    if (claimed) {
      e.preventDefault()
      if (claimed === 'revert-shortcut') this.revertShortcut()
      else if (claimed !== 'ignore') this.toggleMark(claimed)
      return
    }
    if (isPanHoldKey(e, ctx)) {
      e.preventDefault()
      if (!this.spaceHeld) {
        this.spaceHeld = true
        this.applyToolState()
      }
      return
    }
    const action = resolveShortcut(e, ctx)
    if (this.crop) {
      // Crop mode: Esc cancels, Enter applies, zoom works (and Space pans, above); nothing else.
      if (action === 'escape') {
        e.preventDefault()
        this.cancelCrop()
      } else if (isConfirmKey(e, ctx)) {
        e.preventDefault()
        this.applyCrop()
      } else if (action && ZOOM_ACTIONS.has(action)) {
        e.preventDefault()
        this.run(action)
      } else if (action) {
        e.preventDefault() // a shortcut that is ignored: the browser must not act on it either
      }
      return
    }
    if (!action) return
    e.preventDefault()
    this.run(action)
  }

  /** Single dispatch point for shortcuts; UI buttons call the methods directly. */
  run(action: ShortcutAction) {
    switch (action) {
      case 'undo':
        return this.undo()
      case 'redo':
        return this.redo()
      case 'delete':
        return this.deleteSelection()
      case 'select-all':
        return this.selectAll()
      case 'duplicate':
        return this.duplicateSelection()
      case 'tool-select':
        return this.setTool('select')
      case 'tool-hand':
        return this.setTool('hand')
      case 'tool-text':
        return this.setTool('text')
      case 'tool-frame':
        return this.setTool('frame')
      case 'add-image':
        return this.editable && !this.busy ? this.imagePicker?.() : undefined
      case 'zoom-in':
        return this.zoomBy(ZOOM_STEP)
      case 'zoom-out':
        return this.zoomBy(1 / ZOOM_STEP)
      case 'zoom-fit':
        return this.fit()
      case 'zoom-reset':
        return this.resetZoom()
      case 'layer-forward':
        return this.arrange('forward')
      case 'layer-backward':
        return this.arrange('backward')
      case 'layer-front':
        return this.arrange('front')
      case 'layer-back':
        return this.arrange('back')
      case 'toggle-lock':
        return this.toggleSelectionLock()
      case 'format-bold':
        return this.toggleMark('bold')
      case 'format-italic':
        return this.toggleMark('italic')
      case 'format-underline':
        return this.toggleMark('underline')
      case 'ignore':
        return
      case 'escape':
        if (this.busy) return
        if (this.state.tool !== 'select') this.setTool('select')
        else {
          this.canvas.discardActiveObject()
          this.canvas.requestRenderAll()
        }
    }
  }

  private imagePicker: (() => void) | null = null

  /** The UI registers the file picker it owns so the `i` shortcut can open it. */
  setImagePicker(open: (() => void) | null) {
    this.imagePicker = open
  }

  private frameRenamer: (() => void) | null = null

  /** The UI registers how to put the cursor in the selected frame's name field (double-click on a label). */
  setFrameRenamer(focus: (() => void) | null) {
    this.frameRenamer = focus
  }

  // ---- tools ----------------------------------------------------------------------

  setTool(tool: Tool) {
    if (!this.live || this.busy) return
    this.switchTool(tool)
  }

  /** Unguarded tool change, for the editor's own use (it never runs while a gesture is unsettled). */
  private switchTool(tool: Tool) {
    if (tool !== 'hand' && !this.editable) tool = 'hand' // read-only boards can only be panned and zoomed
    this.finishEditing()
    this.setState({ tool })
    this.applyToolState()
  }

  private applyToolState() {
    const { tool } = this.state
    const hand = tool === 'hand' || this.spaceHeld
    const editable = this.state.ready && this.state.readOnly === null
    const cropping = this.crop !== null
    this.canvas.selection = editable && tool === 'select' && !hand && !cropping
    // The Frame tool draws over whatever is there: it must not grab or select anything. Nor
    // does anything while cropping (the editor handles those presses itself).
    this.canvas.skipTargetFind = hand || !editable || tool === 'frame' || cropping
    this.canvas.defaultCursor = hand ? 'grab' : tool === 'text' ? 'text' : tool === 'frame' ? 'crosshair' : 'default'
    this.canvas.hoverCursor = hand ? 'grab' : tool === 'text' ? 'text' : tool === 'frame' ? 'crosshair' : 'move'
    this.canvas.requestRenderAll()
    this.setState({ handActive: hand })
  }

  /**
   * Leaves the current edit before a command runs: an open crop is applied (its own history
   * step if it changed anything) and a text being edited is left (typed text is committed as
   * its own step). Every command calls this first, so none can run against a temporarily
   * un-cropped image. Panning keeps crop mode open (`keepCrop`).
   */
  private finishEditing(opts: { keepCrop?: boolean } = {}) {
    if (!opts.keepCrop) this.applyCrop()
    const active = this.canvas.getActiveObject()
    if (active instanceof Textbox && active.isEditing) active.exitEditing()
  }

  // ---- image tools: crop, Fit and Fill -------------------------------------------------------

  /**
   * Opens crop mode on the selected image. Only for one unlocked image, on an editable board
   * that is not busy. The whole original is shown in place (the kept pixels do not move) with
   * the crop box over it; Fabric's own handles are hidden and Fabric sees no presses.
   */
  startCrop() {
    if (!this.editable || this.busy || this.crop) return
    const img = this.canvas.getActiveObject()
    if (!isImage(img) || isLocked(img) || img.group) return
    this.finishEditing()
    if (this.state.tool !== 'select') this.switchTool('select')
    if (this.canvas.getActiveObject() !== img) return
    const size = imageSizeOf(img)
    const start = { x: img.cropX, y: img.cropY, width: img.width, height: img.height }
    const shown: Placement = { left: img.left, top: img.top, angle: img.angle, scaleX: img.scaleX, scaleY: img.scaleY }
    const full = uncroppedPlacement(shown, start)
    this.crop = {
      base: this.snapshot(),
      target: img,
      before: {
        left: img.left,
        top: img.top,
        cropX: img.cropX,
        cropY: img.cropY,
        width: img.width,
        height: img.height,
        hasControls: img.hasControls,
        hasBorders: img.hasBorders,
      },
      size,
      full,
      start,
      rect: { ...start },
      drag: null,
    }
    img.set({ hasControls: false, hasBorders: false })
    setImageCrop(img, undefined)
    img.set({ left: full.left, top: full.top })
    img.setCoords()
    this.applyToolState()
    this.canvas.requestRenderAll()
    this.syncState()
  }

  /** Done, Enter, or a press outside the crop box: applies the crop. Nothing when crop mode is not open. */
  applyCrop() {
    this.closeCrop(true)
  }

  /** Cancel or Esc: restores the image exactly as it was. No history entry and no save. */
  cancelCrop() {
    this.closeCrop(false)
  }

  /**
   * Ends crop mode. A drag in flight ends with the rectangle as it is. Applying a changed crop
   * places the image so that the kept pixels stay where they were shown, decides its owner as
   * after a resize, and records one history step. Applying an unchanged crop, or cancelling,
   * restores the image's own state exactly and records nothing.
   */
  private closeCrop(apply: boolean) {
    const s = this.crop
    if (!s) return
    if (s.drag) this.endCropDrag(true)
    this.crop = null
    const img = s.target
    // The crop as it will be stored (undefined: the whole image), compared with the one it began with.
    const stored = storedCrop(s.rect, s.size)
    const unchanged = sameCrop(stored, storedCrop(s.start, s.size))
    img.set({ hasControls: s.before.hasControls, hasBorders: s.before.hasBorders })
    const onCanvas = this.canvas.getObjects().includes(img)
    if (!apply || unchanged || !onCanvas) {
      const b = s.before
      img.set({ cropX: b.cropX, cropY: b.cropY, width: b.width, height: b.height, left: b.left, top: b.top, dirty: true })
      img.setCoords()
    } else {
      const at = croppedPlacement(s.full, stored ?? { x: 0, y: 0 })
      setImageCrop(img, stored)
      img.set({ left: at.left, top: at.top })
      img.setCoords()
      // A crop changes the image's box, so it counts as resizing it.
      setOwner(img, ownerAfterManipulation(ownerOf(img), centerOf(img), this.frameRecords(), NO_FRAMES))
    }
    this.applyToolState()
    // The element keeps the last resize or move cursor until Fabric next sets one (on a mouse move): reset it now.
    this.canvas.upperCanvasEl.style.cursor = this.canvas.defaultCursor
    this.canvas.requestRenderAll()
    if (apply && !unchanged && onCanvas) this.commit()
    this.syncState()
  }

  /** What a press at this mouse event would grab in crop mode, or null (outside the crop box). */
  private cropHitAt(s: CropSession, e: MouseEvent): CropHit | null {
    const p = sceneToSource(this.canvas.getScenePoint(e), s.full)
    const zoom = this.getViewport().zoom
    const tolX = CROP_HIT_TOLERANCE / (zoom * Math.abs(s.full.scaleX))
    const tolY = CROP_HIT_TOLERANCE / (zoom * Math.abs(s.full.scaleY))
    return hitCropHandle(p, s.rect, tolX, tolY)
  }

  /** A primary press in crop mode: a handle or the box starts a drag; anywhere else applies the crop. */
  private cropPress(e: MouseEvent) {
    const s = this.crop
    if (!s) return
    if (s.drag) this.endCropDrag(true) // its release was lost
    const hit = this.cropHitAt(s, e)
    if (!hit) {
      this.pressAppliedCrop = true
      this.applyCrop() // like clicking away from a text: the press does nothing else
      return
    }
    const from = sceneToSource(this.canvas.getScenePoint(e), s.full)
    const startRect = { ...s.rect }
    const minW = minCropSide(s.full.scaleX, s.size.width, startRect.width)
    const minH = minCropSide(s.full.scaleY, s.size.height, startRect.height)
    const move = (ev: MouseEvent) => {
      if (this.crop !== s || !s.drag) return
      if ((ev.buttons & 1) === 0) {
        this.endCropDrag(true) // the primary release was lost: the drag ends where it is
        return
      }
      const p = sceneToSource(this.canvas.getScenePoint(ev), s.full)
      s.rect = dragCropRect(startRect, hit, p.x - from.x, p.y - from.y, s.size, minW, minH)
      this.canvas.requestRenderAll()
    }
    const up = (ev: MouseEvent) => {
      if (ev.button === 0 && this.crop === s && s.drag) this.endCropDrag(true) // other buttons never end it
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    s.drag = {
      startRect,
      end: () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        s.drag = null
      },
    }
  }

  /** Ends a crop drag, keeping the rectangle or (`keep` false: a window blur) returning it to where the drag began. */
  private endCropDrag(keep: boolean) {
    const s = this.crop
    if (!s?.drag) return
    if (!keep) s.rect = { ...s.drag.startRect }
    s.drag.end()
    this.canvas.requestRenderAll()
    this.syncState() // Undo availability follows the rectangle (see syncState)
  }

  /**
   * Fit: the whole original, at the largest uniform scale at which it fits inside the image's
   * current box, centred on it, same angle. One history step, or nothing when nothing changes.
   * The box changes, so its owner is decided as after a resize.
   */
  fitImage() {
    this.reshapeImage(fitRecord, true)
  }

  /**
   * Fill: the box stays exactly as it is and the image covers it, with the largest centred
   * crop of the original that has the box's aspect ratio. One history step, or nothing.
   * Never changes ownership.
   */
  fillImage() {
    this.reshapeImage(fillRecord, false)
  }

  private reshapeImage(next: (rec: ImageRecord, size: Size) => ImageRecord, decidesOwner: boolean) {
    if (!this.editable || this.busy) return
    this.finishEditing() // an open crop is applied first, as its own step
    const img = this.canvas.getActiveObject()
    if (!isImage(img) || isLocked(img) || img.group) return
    const rec = toRecord(img)
    if (rec?.type !== 'image') return
    const out = next(rec, imageSizeOf(img))
    if (sceneEqual({ frames: [], objects: [rec] }, { frames: [], objects: [out] })) return
    setImageCrop(img, out.crop)
    img.set({ left: out.left, top: out.top, scaleX: out.scaleX, scaleY: out.scaleY })
    img.setCoords()
    if (decidesOwner) setOwner(img, ownerAfterManipulation(ownerOf(img), centerOf(img), this.frameRecords(), NO_FRAMES))
    this.canvas.requestRenderAll()
    this.commit()
  }

  /**
   * Replace image, step 1 (the button): leaves the current edit (an open crop is applied as
   * its own step) and returns the id of the image to replace: the selected image, if it is one
   * unlocked image on an editable board that is not busy; otherwise null. The target is fixed
   * here, not when a file is chosen: the file dialog may stay open while other things happen.
   */
  replaceTarget(): string | null {
    if (!this.editable || this.busy) return null
    this.finishEditing()
    const img = this.canvas.getActiveObject()
    if (!isImage(img) || isLocked(img) || img.group) return null
    return idOf(img) ?? null
  }

  /**
   * Replace image, step 2 (a file was chosen): decodes it, then shows it in the target's box.
   * Applied at once when the board is at rest, otherwise as soon as the gesture in progress has
   * settled; never from a Fabric callback. Nothing changes when the file is not a usable image,
   * the board went read-only, or the target is gone or locked by then.
   */
  async replaceImageFile(targetId: string, file: File): Promise<void> {
    if (this.disposed) return
    if (!this.editable) {
      if (this.live) this.notify('error', `This board is read-only. ${this.state.readOnly ?? ''}`.trim())
      return
    }
    const name = file.name || 'The file'
    const seq = ++this.replaceSeq // taken before decoding: requests are ordered by when they were made
    let job: ReplaceJob
    try {
      if (!isImageFile(file)) throw new Error('not an image')
      const asset = await readImageFile(file)
      const el = await this.assets.load(asset) // kept for the session; stored by the first save that references it
      job = { targetId, assetId: asset.id, size: { width: el.naturalWidth, height: el.naturalHeight }, seq }
    } catch {
      if (!this.disposed) this.notify('error', `${name} could not be used to replace the image: it is not an image, or it could not be read.`)
      return
    }
    if (this.disposed) return
    if (!this.editable) {
      this.notify('error', 'The image was not replaced because the board became read-only.')
      return
    }
    if (this.busy) this.stagedReplacements.push(job) // applied by idle() once the gesture has settled
    else this.applyReplace(job)
  }

  /**
   * Shows the decoded picture in the target's box, as it is now: same id, owner, stacking,
   * angle and lock, and the same box (centre and displayed size, to stored precision), covered
   * like Fill. Ownership is not re-decided, because the box does not move. One history step.
   */
  private applyReplace(job: ReplaceJob) {
    if (!this.editable || this.busy) return
    // The last pick wins: a picture that arrives after a newer request for the same image has
    // already been applied is dropped silently (its decoded image just stays unreferenced). Undo
    // and redo do not reset this, so an old decode arriving after the newer replacement was
    // undone is still dropped: the simplest rule that never shows a superseded pick.
    if ((this.replaceApplied.get(job.targetId) ?? 0) > job.seq) return
    this.finishEditing() // an open crop is applied first, as its own step
    const img = this.canvas.getObjects().find((o) => idOf(o) === job.targetId)
    const el = this.assets.get(job.assetId)
    if (!isImage(img) || !el) {
      this.notify('error', 'The image could not be replaced: it is no longer on the board.')
      return
    }
    if (isLocked(img)) {
      this.notify('error', 'The image could not be replaced: it is locked. Unlock it and try again.')
      return
    }
    // A member of a multi-selection has coordinates relative to it: take it out while it changes.
    const active = this.canvas.getActiveObject()
    const members = img.group && active instanceof ActiveSelection ? active.getObjects().slice() : null
    if (members) this.canvas.discardActiveObject()
    const rec = toRecord(img)
    if (rec?.type === 'image') {
      const next = replaceRecord(rec, imageSizeOf(img), job.assetId, job.size)
      setImageElement(img, job.assetId, el)
      setImageCrop(img, next.crop)
      img.set({ left: next.left, top: next.top, scaleX: next.scaleX, scaleY: next.scaleY })
      img.setCoords()
      this.replaceApplied.set(job.targetId, job.seq)
    }
    if (members) this.selectByIds(members)
    this.canvas.requestRenderAll()
    this.commit()
  }

  // ---- adding content ----------------------------------------------------------------

  private viewCenterScene(): Point {
    return screenToScene(this.getViewport(), { x: this.canvas.getWidth() / 2, y: this.canvas.getHeight() / 2 })
  }

  addText() {
    if (!this.editable || this.busy) return
    this.addTextAt(this.viewCenterScene(), 'center')
  }

  /**
   * `dragTo`: the Text tool's box was dragged out from `at` to here: it takes the drag's
   * width and minimum height and starts at the drag's smaller x and y, unless the drag is narrower than
   * `MIN_TEXT_DRAG_EMS` font sizes, which is no usable width: then, as without `dragTo`, the
   * default box (ten font sizes wide) at `at`.
   */
  private addTextAt(at: Point, anchor: 'center' | 'top-left', dragTo?: Point) {
    if (!this.editable || this.busy) return
    // Placement is single-use. Switch tools first: switching ends any editing.
    if (this.state.tool !== 'select') this.switchTool('select')
    this.finishEditing()
    const zoom = this.getViewport().zoom
    const fontSize = Math.round(clamp(24 / zoom, 12, 160))
    const box = dragTo ? rectFromDrag(at, dragTo) : undefined
    const drag = box && box.width >= fontSize * MIN_TEXT_DRAG_EMS ? box : undefined
    const width = drag?.width ?? fontSize * 10
    const rec: TextRecord = {
      id: newId(),
      type: 'text',
      text: '',
      fontSize,
      width,
      ...(drag && { minHeight: drag.height }),
      angle: 0,
      left: drag?.left ?? (anchor === 'center' ? at.x - width / 2 : at.x),
      top: drag?.top ?? (anchor === 'center' ? at.y - fontSize * 0.625 : at.y),
    }
    const obj = createObject(rec, () => undefined)
    if (!(obj instanceof Textbox)) return
    this.canvas.add(obj)
    // Owner first, in the same step that adds it: typing is saved as it happens, so no
    // save may ever see this text without its owner. (Touches no history.)
    setOwner(obj, this.ownerForNew(obj))
    this.canvas.setActiveObject(obj)
    obj.enterEditing()
    this.canvas.requestRenderAll()
    this.syncState()
  }

  /**
   * Decodes the files into image records without touching the canvas, then adds them:
   * at once when the board is at rest, otherwise as soon as the gesture in progress
   * has settled. `at` is in client (screen) coordinates, e.g. a drop position.
   */
  async addImageFiles(files: readonly File[], at?: { clientX: number; clientY: number }) {
    if (!this.editable) {
      if (this.live) this.notify('error', `This board is read-only. ${this.state.readOnly ?? ''}`.trim())
      else if (!this.disposed) this.notify('info', 'The board is still loading. Try again in a moment.')
      return
    }
    const images = files.filter(isImageFile)
    const skipped = files.length - images.length
    const failed: string[] = []
    const prepared: ImageRecord[] = []
    const rect = this.host.getBoundingClientRect()
    const zoom = this.getViewport().zoom
    const center = at ? screenToScene(this.getViewport(), { x: at.clientX - rect.left, y: at.clientY - rect.top }) : this.viewCenterScene()
    const maxSide = 480 / zoom

    for (const file of images) {
      try {
        const asset = await readImageFile(file)
        const el = await this.assets.load(asset) // the cache keeps the bytes; the save stores any that are not stored yet
        if (this.disposed) return
        const scale = fitImageScale(el.naturalWidth, el.naturalHeight, maxSide)
        const offset = prepared.length * (24 / zoom)
        prepared.push({
          id: newId(),
          type: 'image',
          assetId: asset.id,
          angle: 0,
          scaleX: scale,
          scaleY: scale,
          left: center.x - (el.naturalWidth * scale) / 2 + offset,
          top: center.y - (el.naturalHeight * scale) / 2 + offset,
        })
      } catch {
        failed.push(file.name || 'image')
      }
    }
    if (this.disposed) return

    if (prepared.length > 0) {
      if (!this.editable) {
        // The board became read-only while the files were being read.
        this.stagedImports.push(prepared)
        this.dropStagedImports()
      } else if (this.busy) {
        this.stagedImports.push(prepared) // applied by idle() once the gesture has settled
      } else {
        this.applyImport(prepared)
      }
    }
    const problems: string[] = []
    if (skipped > 0) problems.push(`${skipped} file${skipped === 1 ? ' is' : 's are'} not an image`)
    if (failed.length > 0) problems.push(`could not read ${failed.join(', ')}`)
    if (problems.length > 0) {
      const text = problems.join('; ')
      this.notify('error', `${text.charAt(0).toUpperCase()}${text.slice(1)}.`)
    }
  }

  /** Adds one imported batch as its own history step. Never called from a Fabric callback. */
  private applyImport(records: readonly ImageRecord[]) {
    if (!this.editable || this.busy) return
    this.finishEditing() // first, so that text being typed is committed as its own step
    const added: FabricObject[] = []
    for (const rec of records) {
      const obj = createObject(rec, (id) => this.assets.get(id))
      if (!obj) continue
      this.canvas.add(obj)
      setOwner(obj, this.ownerForNew(obj)) // same synchronous step as the add and the commit
      added.push(obj)
    }
    if (added.length === 0) return
    this.canvas.discardActiveObject()
    this.selectByIds(added.slice(-1))
    this.canvas.requestRenderAll()
    this.commit()
  }

  // ---- editing ----------------------------------------------------------------------------

  /** Adds a default-sized frame in the middle of the view (the Frame tool draws one instead). */
  addFrame() {
    if (!this.editable || this.busy) return
    this.finishEditing()
    if (this.state.tool !== 'select') this.switchTool('select')
    const zoom = this.getViewport().zoom
    const width = DEFAULT_FRAME_SCREEN.width / zoom
    const height = DEFAULT_FRAME_SCREEN.height / zoom
    const centre = this.viewCenterScene()
    this.insertFrame({ left: centre.x - width / 2, top: centre.y - height / 2, width, height })
    this.commit()
  }

  /** Renames the selected frame. Returns the name actually set, or null when no single frame is selected. */
  renameFrame(raw: string): string | null {
    if (!this.editable || this.busy) return null
    const active = this.canvas.getActiveObject()
    if (!active || active instanceof ActiveSelection || !isFrame(active) || isLocked(active)) return null
    const name = normalizeFrameName(raw)
    if (name === frameNameOf(active)) return name
    setFrameName(active, name)
    this.canvas.requestRenderAll()
    this.commit(`frame-name:${idOf(active) ?? ''}`)
    return name
  }

  /**
   * Replaces the selection by the selected frames plus the unlocked things they own, so
   * that frame and contents can be moved or scaled together as one multi-selection. A
   * locked member is left out: it follows a move as an unselected member, and a scale
   * leaves it where it is. Nothing for a locked frame. Changes nothing on the board and
   * records no history.
   */
  selectFrameContents() {
    if (!this.editable || this.busy || this.selectionLocked()) return
    const frames = new Set<string>()
    for (const o of this.canvas.getActiveObjects()) if (isFrame(o)) frames.add(idOf(o) ?? '')
    if (frames.size === 0) return
    this.finishEditing()
    const objs = this.canvas.getObjects().filter((o) => !isLocked(o) && (frames.has(idOf(o) ?? '') || frames.has(ownerOf(o) ?? '\u0000')))
    this.canvas.discardActiveObject()
    this.selectByIds(objs)
    this.canvas.requestRenderAll()
  }

  /**
   * Selects an object or frame from the layer list: exactly that one, or (`toggle`) adds it
   * to or removes it from the selection. Changes nothing on the board and records no
   * history, except that leaving a text edit commits what was typed, as everywhere. Inert
   * before the board has loaded, on a read-only board and while a gesture is unsettled.
   * Called from UI handlers, never from a Fabric callback.
   */
  selectLayer(id: string, opts: { toggle?: boolean } = {}) {
    if (!this.editable || this.busy) return
    // A blank text is not part of the scene and is not listed, so it cannot be selected from the list.
    const listed = (o: FabricObject) => !(o instanceof Textbox && o.text.trim() === '')
    const target = this.canvas.getObjects().find((o) => idOf(o) === id && listed(o))
    if (!target) return
    this.finishEditing() // commits typed text as its own step; a blank text is discarded
    if (this.state.tool === 'text' || this.state.tool === 'frame') this.switchTool('select')
    // A selection that contains a locked item contains nothing else: a locked row is always
    // selected alone (a toggle click acts as a plain one), and toggling an unlocked row while
    // a locked item is selected replaces the selection.
    const toggle = opts.toggle === true && !isLocked(target)
    const current = this.canvas.getActiveObjects().filter((o) => listed(o) && !isLocked(o))
    const wanted = new Set(toggle ? (current.includes(target) ? current.filter((o) => o !== target) : [...current, target]) : [target])
    const next = this.canvas.getObjects().filter((o) => wanted.has(o)) // members in canvas z-order
    const active = this.canvas.getActiveObject()
    if (!(next.length === 1 && active === next[0])) {
      // A multi-selection is formed afresh (upright), as everywhere else.
      this.canvas.discardActiveObject()
      this.selectByIds(next)
      this.canvas.requestRenderAll()
    }
    this.syncState()
  }

  deleteSelection() {
    if (!this.editable || this.busy || this.selectionLocked()) return
    this.finishEditing()
    const objs = this.canvas.getActiveObjects()
    if (objs.length === 0) return
    // Deleting a frame keeps its contents: they become loose (rule O6).
    const doomed = new Set<FabricObject>(objs)
    const deletedFrames = new Set<string>()
    for (const o of objs) if (isFrame(o)) deletedFrames.add(idOf(o) ?? '')
    if (deletedFrames.size > 0) {
      for (const o of this.canvas.getObjects()) {
        const owner = ownerOf(o)
        if (owner !== undefined && deletedFrames.has(owner) && !doomed.has(o)) setOwner(o, undefined)
      }
    }
    this.canvas.discardActiveObject()
    this.canvas.remove(...objs)
    this.canvas.requestRenderAll()
    this.commit()
  }

  /** Selects everything that is not locked. */
  selectAll() {
    if (!this.editable || this.busy) return
    const objs = this.canvas.getObjects().filter((o) => !isLocked(o))
    this.finishEditing()
    this.canvas.discardActiveObject()
    this.selectByIds(objs)
    this.canvas.requestRenderAll()
  }

  setFontSize(size: number) {
    this.shortcutRevert = null
    if (!this.editable || this.busy) return
    const active = this.canvas.getActiveObject()
    if (!(active instanceof Textbox) || isLocked(active) || !Number.isFinite(size)) return
    setTextFontSize(active, clamp(size, MIN_FONT_SIZE, MAX_FONT_SIZE)) // headings keep their ratio
    active.setCoords()
    this.canvas.requestRenderAll()
    // A text that is blank right now (emptied in the middle of an edit) is not in the scene:
    // committing would record "text removed" while it is still being typed into.
    if (active.text.trim() === '') return
    this.commit(`font-size:${idOf(active) ?? ''}`)
  }

  // ---- text formatting ----------------------------------------------------------------------
  //
  // Every command acts on the one selected text, and only while the board is editable and no
  // gesture is unsettled. While the text is being edited, marks and headings act on the
  // selected range (marks with only a caret: on what is typed next), and the change is saved
  // as it happens and becomes part of the single undo step recorded when the edit ends; the
  // edit, its caret and its selected range go on. On a selected box that is not being edited
  // they act on the whole box, as an undo step of its own (quick repeats of the same kind
  // coalesce, like the font size). None of them changes ownership.

  /** The text a formatting command acts on, or null when there is none or the board may not change now. */
  private formatTarget(): Textbox | null {
    this.shortcutRevert = null // a formatting command ends "straight after a shortcut"
    if (!this.editable || this.busy) return null
    const active = this.canvas.getActiveObject()
    return active instanceof Textbox && !isLocked(active) ? active : null
  }

  /** Applies a formatting change through the one canvas path, then saves or records it. */
  private formatText(tb: Textbox, kind: string, change: (fmt: TextFormatting, text: string) => TextFormatting) {
    if (!applyTextFormatting(tb, change)) return // nothing changed: nothing recorded, nothing saved
    this.canvas.requestRenderAll()
    if (tb.isEditing) {
      // Saved as it happens, like typing. A blank text being typed into is not in the scene,
      // so there is nothing to save (and a commit would record its removal).
      if (tb.text.trim() !== '') this.autosaver.markDirty()
      this.syncSelection()
      return
    }
    this.commit(`format-${kind}:${idOf(tb) ?? ''}`)
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
      this.syncSelection()
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
      this.syncSelection()
    }
  }

  /** The font of the selection or whole box, or the next characters typed at a caret. */
  setTextFont(font: FontId) {
    const tb = this.formatTarget()
    if (!tb) return
    const range = tb.isEditing ? selectedRange(tb) : undefined
    if (tb.isEditing && !range) return
    if (range && range.start === range.end) {
      this.setPending(tb, { ...this.pendingFor(tb), font })
      this.syncSelection()
      return
    }
    this.formatText(tb, 'font', (fmt, text) => setRangeFont(text, fmt, font, range))
  }

  /** The alignment of the whole box, also while it is being edited. The box keeps its position and width. */
  setTextAlign(align: TextAlign) {
    const tb = this.formatTarget()
    if (tb) this.formatText(tb, 'align', (fmt) => ({ ...fmt, align: align === 'left' ? undefined : align }))
  }

  /** The colour (`#rrggbb`) of the whole box, also while it is being edited. The default ink is stored as no colour. */
  setTextColor(color: string) {
    const tb = this.formatTarget()
    if (tb) this.formatText(tb, 'color', (fmt) => ({ ...fmt, color }))
  }

  // ---- typing shortcuts ----------------------------------------------------------------------
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
    if (this.applying || !this.editable || this.busy || !tb.isEditing || this.canvas.getActiveObject() !== tb) return
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
  private revertShortcut() {
    const r = this.shortcutRevert
    this.shortcutRevert = null
    if (!r || !this.editable || this.busy || !r.target.isEditing || this.canvas.getActiveObject() !== r.target) return
    replaceEditedText(r.target, r.text, r.fmt, r.caret)
    this.setPending(r.target, r.pending ?? {})
    this.canvas.requestRenderAll()
    this.autosaver.markDirty() // like typing (a blank text is out of the scene, so a save stores none)
    this.syncSelection()
  }

  /** Duplicates selected objects and the contents of selected frames as one undo step. */
  duplicateSelection() {
    if (!this.editable || this.busy || this.selectionLocked() || this.canvas.getActiveObjects().length === 0) return
    this.finishEditing()
    const selected = new Set(this.selectedIds())
    const scene = this.snapshot()
    const offset = 24 / this.getViewport().zoom
    const copiedOwners = new Map<string, string>()
    const frames = scene.frames.filter((rec) => selected.has(rec.id)).map((rec) => {
      const id = newId()
      copiedOwners.set(rec.id, id)
      const copy = { ...rec, id, name: normalizeFrameName(rec.name.slice(0, 75) + ' copy'), left: round(rec.left + offset), top: round(rec.top + offset) }
      delete copy.locked
      return copy
    })
    const content: FabricObject[] = []
    const selection: FabricObject[] = []

    for (const rec of scene.objects) {
      const copiedOwner = rec.frameId === undefined ? undefined : copiedOwners.get(rec.frameId)
      const explicit = selected.has(rec.id)
      if (!explicit && copiedOwner === undefined) continue
      const copy = { ...rec, id: newId(), left: round(rec.left + offset), top: round(rec.top + offset) }
      delete copy.locked
      const obj = createObject(copy, (id) => this.assets.get(id))
      if (!obj) return // nothing has been added yet
      setOwner(obj, copiedOwner ?? ownerAfterManipulation(rec.frameId, centerOf(obj), scene.frames, NO_FRAMES))
      content.push(obj)
      if (explicit) selection.push(obj)
    }
    if (frames.length === 0 && content.length === 0) return

    const frameObjects = frames.map(createFrame)
    this.canvas.discardActiveObject()
    if (frameObjects.length) this.canvas.insertAt(scene.frames.length, ...frameObjects)
    if (content.length) this.canvas.add(...content)
    this.selectByIds([...frameObjects, ...selection])
    this.canvas.requestRenderAll()
    this.commit()
  }

  private layoutBounds(objects: readonly FabricObject[]) {
    return objects.map((o) => {
      const { left, top, width, height } = o.getBoundingRect()
      return { left, top, right: left + width, bottom: top + height }
    })
  }

  /** Translates each selected object independently, leaving its shape and stacking alone. */
  layoutSelection(op: Layout) {
    if (!this.editable || this.busy || this.selectionLocked() || this.canvas.getActiveObjects().length < 2) return
    this.finishEditing()
    const selected = new Set(this.canvas.getActiveObjects())
    const all = this.canvas.getObjects()
    const members = all.filter((o) => selected.has(o)) // stable distribution order for tied bounds
    const offsets = layoutOffsets(this.layoutBounds(members), op)
    if (!offsets) return
    const moves = new Map<FabricObject, number>()
    const frameMoves = new Map<string, number>()
    members.forEach((o, i) => {
      const delta = offsets.amounts[i]!
      if (delta === 0) return
      moves.set(o, delta)
      if (isFrame(o)) frameMoves.set(idOf(o) ?? '', delta)
    })
    if (moves.size === 0) return

    const base = this.snapshot()
    this.canvas.discardActiveObject() // members now have absolute coordinates
    for (const o of all) {
      const owner = ownerOf(o)
      const delta = moves.get(o) ?? (selected.has(o) || owner === undefined ? undefined : frameMoves.get(owner))
      if (delta === undefined) continue
      this.placeObject(o, o.left + (offsets.axis === 'x' ? delta : 0), o.top + (offsets.axis === 'y' ? delta : 0))
    }
    this.applyOwnership(base, [...moves.keys()])
    this.selectByIds(members)
    this.canvas.requestRenderAll()
    this.commit()
  }

  arrange(op: LayerOp) {
    if (!this.editable || this.busy || this.selectionLocked()) return
    this.finishEditing()
    const objs = this.canvas.getActiveObjects()
    if (objs.length === 0) return
    const all = this.canvas.getObjects()
    const byId = new Map(all.map((o) => [idOf(o) ?? '', o] as const))
    // Frames and content are reordered within their own bands: a frame never rises above content.
    const next = reorderLayered(this.layeredOrder(), new Set(this.selectedIds()), op)
    this.canvas.discardActiveObject()
    ;[...next.frames, ...next.objects].forEach((id, index) => {
      const o = byId.get(id)
      if (o) this.canvas.moveObjectTo(o, index)
    })
    this.selectByIds(objs.filter((o) => this.canvas.getObjects().includes(o)))
    this.canvas.requestRenderAll()
    this.commit()
  }

  /** Re-checks the live stack for both the insertion preview and the eventual drop. */
  private layerMove(sourceId: string, targetId: string, side: LayerDropSide) {
    if (!this.editable || this.busy || sourceId === targetId) return null
    const all = this.canvas.getObjects()
    const listed = (o: FabricObject) => !(o instanceof Textbox && o.text.trim() === '')
    const sourceIndex = all.findIndex((o) => idOf(o) === sourceId && listed(o))
    const targetIndex = all.findIndex((o) => idOf(o) === targetId && listed(o))
    const source = all[sourceIndex]
    const target = all[targetIndex]
    if (!source || !target || isLocked(source) || isFrame(source) !== isFrame(target)) return null
    // The canvas stack is back-to-front, and moveObjectTo removes the source before inserting.
    const index = targetIndex + (side === 'before' ? 1 : 0) - (sourceIndex < targetIndex ? 1 : 0)
    return index === sourceIndex ? null : { source, index }
  }

  canMoveLayer(sourceId: string, targetId: string, side: LayerDropSide): boolean {
    return this.layerMove(sourceId, targetId, side) !== null
  }

  /** Moves just the grabbed row. Selection and ownership are independent of stacking. */
  moveLayer(sourceId: string, targetId: string, side: LayerDropSide) {
    if (!this.canMoveLayer(sourceId, targetId, side)) return
    this.finishEditing()
    const move = this.layerMove(sourceId, targetId, side)
    if (!move) return
    const active = this.canvas.getActiveObject()
    const members = active instanceof ActiveSelection && active.getObjects().includes(move.source) ? new Set(active.getObjects()) : null
    if (members) this.canvas.discardActiveObject()
    this.canvas.moveObjectTo(move.source, move.index)
    if (members) this.selectByIds(this.canvas.getObjects().filter((o) => members.has(o)))
    this.canvas.requestRenderAll()
    this.commit()
  }

  /** The selection holds a locked item (and so, by the selection rule, only that item). */
  private selectionLocked(): boolean {
    return this.canvas.getActiveObjects().some(isLocked)
  }

  /**
   * Locks (or unlocks) every selected item. Leaving a text edit comes first and commits typed
   * text as its own step (a blank text is discarded, and then there may be nothing left to
   * lock). One history step when something changes; none, and no save, when nothing does.
   * A single item stays selected (its handles go or come back); a locked multi-selection is
   * cleared, because a selection that contains a locked item contains nothing else. Never
   * changes position, size, stacking or ownership.
   */
  setSelectionLocked(locked: boolean) {
    if (!this.editable || this.busy) return
    this.finishEditing()
    const objs = this.canvas.getActiveObjects().filter((o) => !(o instanceof Textbox && o.text.trim() === ''))
    const changing = objs.filter((o) => isLocked(o) !== locked)
    if (changing.length === 0) return
    for (const o of changing) setLocked(o, locked)
    if (locked && this.canvas.getActiveObject() instanceof ActiveSelection) this.canvas.discardActiveObject()
    this.canvas.requestRenderAll()
    this.commit()
  }

  /** `Ctrl/Cmd+Shift+L`: a single locked selection is unlocked; any other selection is locked. */
  private toggleSelectionLock() {
    const objs = this.canvas.getActiveObjects()
    if (objs.length === 0) return
    this.setSelectionLocked(!(objs.length === 1 && isLocked(objs[0] as FabricObject)))
  }

  /**
   * The padlock on a layer row: locks or unlocks that one item, whether or not it is selected.
   * Locked while part of a multi-selection, it leaves the selection and the rest stays
   * selected; as the single selection it stays selected. Unlocking never changes the
   * selection. Ends a text edit first, like every command. One history step.
   */
  toggleLayerLock(id: string) {
    if (!this.editable || this.busy) return
    // A blank text is not part of the scene and is not listed, so it has no padlock.
    const listed = (o: FabricObject) => !(o instanceof Textbox && o.text.trim() === '')
    const target = this.canvas.getObjects().find((o) => idOf(o) === id && listed(o))
    if (!target) return
    this.finishEditing() // commits typed text as its own step
    const locked = !isLocked(target)
    setLocked(target, locked)
    const active = this.canvas.getActiveObject()
    if (locked && active instanceof ActiveSelection && active.getObjects().includes(target)) {
      const rest = active.getObjects().filter((o) => o !== target && listed(o))
      this.canvas.discardActiveObject()
      this.selectByIds(rest)
    }
    this.canvas.requestRenderAll()
    this.commit()
  }

  undo() {
    if (!this.editable || this.busy) return
    this.finishEditing()
    const scene = this.history.undo()
    if (scene) this.restoreHistory(scene)
  }

  redo() {
    if (!this.editable || this.busy) return
    this.finishEditing()
    const scene = this.history.redo()
    if (scene) this.restoreHistory(scene)
  }

  private restoreHistory(scene: Scene) {
    this.applyRecords(scene)
    this.autosaver.markDirty()
    this.syncState()
  }

  /** Opening a panel with its own fields leaves a canvas edit, like other chrome commands. */
  prepareAppearance(): boolean {
    if (!this.editable || this.busy) return false
    this.finishEditing()
    return true
  }

  /** Appearance is live board metadata, independent of object undo and redo. */
  setBoardStyle(style: BoardStyle) {
    if (!this.editable || this.busy) return
    const next = boardStyle(style)
    const current = this.state.appearance
    if (!next || sameBoardStyle(next, current.style ?? DEFAULT_BOARD_STYLE)) return
    this.saveAppearance(boardAppearance({ ...current, style: next }))
  }

  addAppearancePreset(rawName: string): boolean {
    if (!this.editable || this.busy) return false
    const name = normalizePresetName(rawName)
    const current = this.state.appearance
    const presets = current.presets ?? []
    if (!name || presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) return false
    this.saveAppearance(boardAppearance({ ...current, presets: [...presets, { name, style: current.style ?? DEFAULT_BOARD_STYLE }] }))
    return true
  }

  removeAppearancePreset(name: string) {
    if (!this.editable || this.busy) return
    const current = this.state.appearance
    if (!current.presets?.some((p) => p.name === name)) return
    this.saveAppearance(boardAppearance({ ...current, presets: current.presets.filter((p) => p.name !== name) }))
  }

  private saveAppearance(appearance: BoardAppearance | undefined) {
    this.setState({ appearance: appearance ?? {} })
    this.autosaver.markDirty()
  }

  setTitle(raw: string) {
    if (!this.editable) return this.state.title
    const title = normalizeTitle(raw)
    if (title === this.state.title) return title
    this.setState({ title })
    this.autosaver.markDirty()
    return title
  }

  // ---- viewport ------------------------------------------------------------------------------

  getViewport(): Viewport {
    const v = this.canvas.viewportTransform
    return { zoom: v[0], panX: v[4], panY: v[5] }
  }

  private setViewport(vp: Viewport, persist = true) {
    this.canvas.setViewportTransform([vp.zoom, 0, 0, vp.zoom, vp.panX, vp.panY])
    this.canvas.requestRenderAll()
    this.setState({ viewport: vp })
    if (persist && this.state.ready) this.autosaver.markDirty()
  }

  zoomBy(factor: number) {
    if (!this.live) return
    const vp = this.getViewport()
    const center = { x: this.canvas.getWidth() / 2, y: this.canvas.getHeight() / 2 }
    this.setViewport(zoomAround(vp, center, vp.zoom * factor))
  }

  resetZoom() {
    if (!this.live) return
    const center = { x: this.canvas.getWidth() / 2, y: this.canvas.getHeight() / 2 }
    this.setViewport(zoomAround(this.getViewport(), center, 1))
  }

  fit() {
    if (!this.live) return
    let bounds: Rect | null = null
    for (const obj of this.canvas.getObjects()) {
      for (const p of obj.getCoords()) {
        bounds = bounds
          ? { left: Math.min(bounds.left, p.x), top: Math.min(bounds.top, p.y), right: Math.max(bounds.right, p.x), bottom: Math.max(bounds.bottom, p.y) }
          : { left: p.x, top: p.y, right: p.x, bottom: p.y }
      }
    }
    this.setViewport(fitViewport(bounds, { width: this.canvas.getWidth(), height: this.canvas.getHeight() }))
  }

  // ---- save / notices ---------------------------------------------------------------------------

  retrySave() {
    void this.autosaver.retry()
  }

  notify(kind: Notice['kind'], message: string) {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    const id = ++this.noticeSeq
    this.setState({ notice: { id, kind, message } })
    this.noticeTimer = setTimeout(() => {
      if (this.state.notice?.id === id) this.setState({ notice: null })
    }, kind === 'error' ? 10000 : 5000)
  }

  dismissNotice() {
    this.setState({ notice: null })
  }

  /** True when `files` is a drag payload we can import. */
  static hasFiles(dt: DataTransfer | null): boolean {
    return !!dt && Array.from(dt.types ?? []).includes('Files')
  }
}

/** Folds a frame's scale into its size: frames are always at scale 1 between gestures. */
function bakeFrame(frame: FabricObject) {
  frame.set({
    width: roundPositive(frame.width * Math.abs(frame.scaleX)),
    height: roundPositive(frame.height * Math.abs(frame.scaleY)),
    scaleX: 1,
    scaleY: 1,
  })
  frame.setCoords()
}

/** Two stored crops (undefined: the whole image) are the same. */
const sameCrop = (a: CropRect | undefined, b: CropRect | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

/** Corner (and side) scaling, as opposed to moving, rotating or changing a text's wrap width. */
function isScaleAction(transform: Transform): boolean {
  return transform.action === 'scale' || transform.action === 'scaleX' || transform.action === 'scaleY'
}
