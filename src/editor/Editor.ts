import { ActiveSelection, Point as FabricPoint } from 'fabric'
import type { FabricObject, Transform } from 'fabric'
import { boardAppearance, boardStyle, DEFAULT_BOARD_STYLE, normalizePresetName, sameBoardStyle } from '../model/appearance.ts'
import type { BoardAppearance, BoardStyle } from '../model/appearance.ts'
import { captionImageBounds, captionPlacement, followsDrag } from '../model/captions.ts'
import { captionWillDetach } from '../model/feedback.ts'
import { storedSnapSide } from '../model/captionSnap.ts'
import {
  DEFAULT_VIEWPORT,
  MIN_FONT_SIZE,
  clamp,
  normalizeFrameName,
  normalizeTitle,
  referencedAssetIds,
  round,
  roundPositive,
  sceneEqual,
  captionBackground,
  valuesEqual,
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
import { collectFrameDestinations } from '../model/frameDestinations.ts'
import type { FrameDestination } from '../model/frameDestinations.ts'
import { frameTourPath } from '../model/frameTour.ts'
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
import type { Mark, MarkState, TextAlign } from '../model/richText.ts'
import type { BlockKind } from './textRules.ts'
export type { BlockKind } from './textRules.ts'
import { isBlankTextDoc } from '../model/textDoc.ts'
import { canReorderLayered, reorderLayered } from '../model/layers.ts'
import type { LayerDropSide, LayerOp } from '../model/layers.ts'
import { DEFAULT_TITLE, DOC_VERSION } from '../model/types.ts'
import type { BoardDoc, FontId, FrameRecord, ImageRecord, SaveState, Scene, TextRecord, Viewport } from '../model/types.ts'
import type { CanvasPrefs } from '../model/prefs.ts'
import { fitImageScale, fitViewport, screenToScene, zoomAround } from '../model/viewport.ts'
import type { Point, Rect, Size } from '../model/viewport.ts'
import { Autosaver } from '../persistence/autosave.ts'
import { ABSENT } from '../persistence/boardStore.ts'
import type { BoardStore } from '../persistence/boardStore.ts'
import { hydrateBoard } from '../persistence/hydrate.ts'
import { canvasPrefs } from '../persistence/prefsStore.ts'
import { isConfirmKey, isPanHoldKey, resolveShortcut } from '../input/shortcuts.ts'
import type { ShortcutAction } from '../input/shortcuts.ts'
import { AssetCache, isImageFile, readImageFile } from './assets.ts'
import { CROP_HIT_TOLERANCE, cropCursor, cropOverlay, drawCropOverlay } from './cropLayer.ts'
import type { CaptionSnapPreview } from './captionSnapLayer.ts'
import { DomScene } from './domScene.ts'
import { EdgePan } from './edgePan.ts'
import { renderFrameToCanvas } from './renderFrameBitmap.ts'
import { CANVAS_OWNER, WheelLatch, pickWheelOwner } from './wheelGesture.ts'
import type { WheelOwner } from './wheelGesture.ts'
import { FeedbackLayer } from './feedbackLayer.ts'
import { FrameCanvas } from './FrameCanvas.ts'
import type { AssetSource } from './assets.ts'
import { EMPTY_LAYERS, computeLayers } from './layerList.ts'
import type { LayerItem } from './layerList.ts'
import {
  ACCENT,
  captionOf,
  captionSideOf,
  centerOf,
  createFrameProxy,
  createProxy,
  frameNameOf,
  hasResidualScale,
  idOf,
  imageSizeOf,
  isFrame,
  isImage,
  isLocked,
  newId,
  ownerOf,
  setCaption,
  setFrameName,
  setImageCrop,
  setImageElement,
  setLocked,
  setOwner,
  shownCropOf,
  toFrameRecord,
  toRecord,
} from './objects.ts'
import type { CardMeasurer } from './sceneLayer.ts'
import { DomTextAdapter } from './textAdapter.ts'
import type { TextAdapter, TextHost } from './textAdapter.ts'

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
  caption: { edit: 'add' | 'edit' | null; canEdit: boolean; attached: boolean; canDetach: boolean; canMake: boolean; canStyle: boolean; background?: string }
  /** Only for a single text: whether it has a fixed height (its words scroll inside it) or grows with its words. */
  textHeight: 'fixed' | 'auto' | null
  /** Only for a single text: what the formatting controls show. */
  text: TextFormatInfo | null
  /** The block controls of the one selected text (see `TextBlockInfo`), or null. */
  textBlocks: TextBlockInfo | null
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

/**
 * What the block controls show for the one selected text, beside `TextFormatInfo`: inline code over
 * the characters concerned, and each kind of block over the lines concerned (a line is in a list
 * when its nearest list is of that kind). While editing, the selected range or the caret's line and
 * next character; otherwise the whole box.
 */
export interface TextBlockInfo {
  code: MarkState
  blocks: Record<BlockKind, MarkState>
}

export interface Notice {
  id: number
  kind: 'error' | 'info'
  message: string
}

export interface FrameTourSession {
  frames: readonly FrameDestination[]
  renderFrame(id: string, signal: AbortSignal): Promise<string>
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
  canvasSize: Size
  jumpReturns: boolean
  frameDestinations: readonly FrameDestination[]
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
  /** The preview visible when the actual primary release arrived. */
  captionSnap?: CaptionSnapPreview
  /** A drag: the unselected members and captions that follow it. */
  carry?: Carry
  /**
   * The Frame tool, or the Text tool (`tool: 'text'`): the rectangle being drawn, in scene
   * coordinates.
   */
  draft?: { start: Point; end: Point; tool?: 'text' }
}

/**
 * Followers of a drag: unselected members of moved frames and captions of moved images.
 * They follow moves only, exactly once, by the same delta.
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
  target: FabricObject
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

/** How the editor is built: `measurer` sizes text cards (tests inject one; jsdom lays nothing out). */
export interface EditorOptions {
  measurer?: CardMeasurer
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

const suppressesSnap = (e: Event) => e instanceof MouseEvent && (e.ctrlKey || e.metaKey)

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
  private readonly feedback: FeedbackLayer
  private readonly autosaver: Autosaver
  private readonly listeners = new Set<() => void>()
  private readonly cleanups: Array<() => void> = []
  private state: EditorState
  private jumpReturn: Viewport | null = null
  private destinationScene: Scene | null = null
  private layerPressActive = false
  private pendingImageDecodes = 0
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
  /** Who the wheel gesture in progress belongs to: the board, or the fixed-height text it started on (plan Section 4). */
  private readonly wheel = new WheelLatch()
  /** The last press on the canvas applied a crop (so the double-click it may begin does not reopen one). */
  private pressAppliedCrop = false
  /** The press that began the current double-click followed a press that applied a crop. */
  private dblClickAfterCrop = false
  /** Everything the editor does with text (see `textAdapter.ts`). */
  private readonly text: TextAdapter
  /** What draws the board: the scene layer under the canvas, kept in step with the canvas's proxies. */
  private readonly scene: DomScene

  constructor(
    private readonly host: HTMLElement,
    private readonly store: BoardStore,
    private readonly assets: AssetSource = new AssetCache(),
    readonly getPrefs: () => CanvasPrefs = canvasPrefs.get,
    options: EditorOptions = {},
  ) {
    this.canvasEl = document.createElement('canvas')
    host.appendChild(this.canvasEl)
    const { width, height } = host.getBoundingClientRect()
    const canvasSize = { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) }
    this.canvas = new FrameCanvas(this.canvasEl, {
      ...canvasSize,
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
    // The scene layer listens to the canvas before anything else does, so it follows each change
    // before the editor reacts.
    this.scene = new DomScene(this.canvas, host, this.assets, { measurer: options.measurer, gestureActive: () => this.gesture !== null })
    const textHost: TextHost = {
      canvas: this.canvas,
      editable: () => this.editable,
      busy: () => this.busy,
      applying: () => this.applying,
      cropping: () => this.crop !== null,
      disposed: () => this.disposed,
      isNew: (obj) => !this.history.current.objects.some((o) => o.id === idOf(obj)),
      frameRecords: () => this.frameRecords(),
      commit: (coalesceKey) => this.commit(coalesceKey),
      markDirty: () => this.autosaver.markDirty(),
      syncState: () => this.syncState(),
      syncSelection: () => this.syncSelection(),
      syncCaptions: (edited) => this.syncCaptions(edited),
      shownHistory: () => ({ canUndo: this.state.canUndo, canRedo: this.state.canRedo }),
    }
    this.text = new DomTextAdapter(textHost, this.scene)

    this.feedback = new FeedbackLayer(new EdgePan(this.canvas, host, (dx, dy) => {
      const vp = this.getViewport()
      this.setViewport({ ...vp, panX: vp.panX + dx, panY: vp.panY + dy })
    }))
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
      canvasSize,
      jumpReturns: false,
      frameDestinations: [],
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
    this.cleanups.push(canvasPrefs.subscribe(() => {
      const prefs = this.getPrefs()
      const interactionCleared = !prefs.feedback && this.feedback.clearInteraction()
      const snapCleared = !prefs.captionSnap && this.feedback.clearCaptionSnap()
      if (interactionCleared || snapCleared) this.canvas.requestRenderAll()
    }))
    this.applyToolState()
    this.scene.mount()
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
    this.clearFeedback()
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
    this.clearFeedback()
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.gesture = null // invalidates any queued settlement
    this.stagedImports = []
    this.stagedReplacements = []
    this.pan?.end()
    this.crop?.drag?.end()
    this.crop = null
    this.text.dispose() // an edit in progress ends; nothing is committed (the board is no longer editable)
    for (const c of this.cleanups.splice(0)) c()
    this.autosaver.dispose()
    this.listeners.clear()
    this.scene.dispose()
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
      if (this.text.isBlank(obj)) continue
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
   * entry and no save. Attachments settle before the snapshot, as part of the same step.
   */
  private commit(coalesceKey?: string) {
    if (this.applying || !this.editable || this.gesture || this.crop) return
    this.syncCaptions()
    if (this.history.push(this.snapshot(), coalesceKey)) this.autosaver.markDirty()
    this.syncState()
  }

  /** The first caption in back-to-front order is the one that claims the image. */
  private captionFor(image: FabricObject): FabricObject | undefined {
    const id = idOf(image)
    return this.canvas.getObjects().find((o) => this.text.isText(o) && id !== undefined && captionOf(o) === id)
  }

  /** Repair relationships, then place changed pairs or the one caption being edited. */
  private syncCaptions(editedCaption?: FabricObject) {
    const objects = this.canvas.getObjects()
    const captions = objects.filter((o) => this.text.isText(o) && captionOf(o) !== undefined)
    if (captions.length === 0) return
    const images = new Map(objects.filter(isImage).map((image) => [idOf(image), image]))
    const recorded = editedCaption ? undefined : new Map(this.history.current.objects.map((record) => [record.id, record]))
    const groups = new Set<ActiveSelection>()
    let changed = false
    for (const caption of captions) {
      const imageId = captionOf(caption)
      const image = images.get(imageId)
      if (!image) {
        setCaption(caption, undefined)
        continue
      }
      images.delete(imageId)
      if (ownerOf(caption) !== ownerOf(image)) setOwner(caption, ownerOf(image))
      if (editedCaption && editedCaption !== caption) continue
      const rec = toRecord(caption)
      const parent = toRecord(image)
      if (rec?.type !== 'text' || parent?.type !== 'image') continue
      // A newly attached caption differs by its attachment fields, or has no prior record.
      if (recorded && valuesEqual(rec, recorded.get(rec.id)) && valuesEqual(parent, recorded.get(parent.id))) continue
      if (this.positionCaption(caption, image, rec, parent)) {
        changed = true
        if (caption.group instanceof ActiveSelection) groups.add(caption.group)
      }
    }
    for (const group of groups) group.triggerLayout()
    if (changed) this.canvas.requestRenderAll()
  }

  private positionCaption(caption: FabricObject, image: FabricObject, rec: TextRecord, parent: ImageRecord): boolean {
    const bounds = captionImageBounds(parent, imageSizeOf(image))
    const side = captionSideOf(caption)
    const scale = caption.getObjectScaling()
    const box = { width: rec.width, height: caption.height * scale.y, fontSize: rec.fontSize }
    let placement = captionPlacement(bounds, side, box, rec.captionPosition)
    // A single grapheme may require more room than the image. The text box has already
    // measured it using the actual styles. Rewrap before placing a caption above an image.
    const width = Math.max(placement.width / scale.x, this.text.minWidthOf(caption))
    const resized = roundPositive(width * scale.x) !== rec.width
    if (resized) {
      this.text.setWrapWidth(caption, width)
      placement = captionPlacement(bounds, side, { ...box, width: caption.width * scale.x, height: caption.height * scale.y }, rec.captionPosition)
    }
    if (!resized && rec.angle === 0 && rec.left === placement.left && rec.top === placement.top) return false
    if (rec.angle !== 0) caption.set({ angle: -(caption.group?.getTotalAngle() ?? 0) })
    caption.setXY(new FabricPoint(placement.left, placement.top))
    caption.setCoords()
    return true
  }

  /** Rebuilds the canvas from records (frames behind content), preserving selection by id. */
  private applyRecords(scene: Scene) {
    this.applying = true
    this.text.resetTransient()
    try {
      const selected = new Set(this.selectedIds())
      this.canvas.discardActiveObject()
      const existing = this.canvas.getObjects()
      if (existing.length) this.canvas.remove(...existing)
      const built: FabricObject[] = scene.frames.map((rec) => this.buildFrame(rec))
      for (const rec of scene.objects) {
        if (rec.type === 'text' && isBlankTextDoc(rec)) continue // an old board may still store a blank text: invisible, so not shown
        const obj = this.build(rec, (id) => this.assets.get(id))
        if (obj) built.push(obj)
      }
      if (built.length) this.canvas.add(...built)
      this.scene.rebuild() // text proxies take their cards' sizes before a selection is formed
      this.selectByIds(built.filter((o) => selected.has(idOf(o) ?? '')))
    } finally {
      this.applying = false
    }
    this.canvas.requestRenderAll()
  }

  /** A content object for a record: its proxy (the scene layer draws it). */
  private build(rec: Scene['objects'][number], getImage: (assetId: string) => HTMLImageElement | undefined): FabricObject | null {
    return createProxy(rec, getImage)
  }

  /** A frame for a record: its proxy (the scene layer paints its paper). */
  private buildFrame(rec: FrameRecord): FabricObject {
    return createFrameProxy(rec)
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
    const layoutItems = this.layoutItems(objs)
    const bounds = layoutItems.length >= 3 ? this.layoutBounds(layoutItems) : []
    const attached = isImage(single) ? this.captionFor(single) : this.text.isText(single) && captionOf(single) ? single : undefined
    const canDetach = this.captionToDetach(objs) !== undefined
    const styledText = this.detachedTextWithBackground(single)
    const styled = attached ?? styledText
    return {
      kind: objs.length > 1 ? 'multiple' : frame ? 'frame' : this.text.isText(single) ? 'text' : 'image',
      count: objs.length,
      fontSize: this.text.isText(single) ? Math.max(MIN_SELECTION_FONT, Math.round(this.text.fontSizeOf(single) * 10) / 10) : null,
      frameName: frame ? (frameNameOf(frame) ?? '') : null,
      memberCount: frame ? this.canvas.getObjects().filter((o) => ownerOf(o) === frameId).length : null,
      locked,
      layer: {
        front: !locked && canReorderLayered(order, ids, 'front'),
        forward: !locked && canReorderLayered(order, ids, 'forward'),
        backward: !locked && canReorderLayered(order, ids, 'backward'),
        back: !locked && canReorderLayered(order, ids, 'back'),
      },
      layout: layoutItems.length < 2 ? null : { spaceX: layoutOffsets(bounds, 'space-x') !== null, spaceY: layoutOffsets(bounds, 'space-y') !== null },
      image: isImage(single) ? this.imageInfo(single, locked) : null,
      caption: {
        edit: isImage(single) ? (attached ? 'edit' : 'add') : null,
        canEdit: isImage(single) && !locked && !(attached && isLocked(attached)),
        attached: attached !== undefined,
        canDetach,
        canMake: this.captionPair(objs) !== undefined,
        canStyle: canDetach || (styledText !== undefined && !locked),
        background: (styled ? this.text.backgroundOf(styled) : undefined) || undefined,
      },
      textHeight: this.text.isText(single) ? (this.text.hasFixedHeight(single) ? 'fixed' : 'auto') : null,
      text: this.text.isText(single) ? this.text.formatInfo(single) : null,
      textBlocks: this.text.isText(single) ? this.text.blockInfo(single) : null,
    }
  }

  private imageInfo(img: FabricObject, locked: boolean): SelectionInfo['image'] {
    const rec = toRecord(img)
    if (rec?.type !== 'image') return null
    // While cropping the image is shown whole; it counts as cropped if the crop the session began with was.
    if (this.crop?.target === img) return { cropped: !isWholeImage(this.crop.start, this.crop.size), canFit: false, canFill: false }
    if (locked || this.crop) return { cropped: rec.crop !== undefined, canFit: false, canFill: false }
    const size = imageSizeOf(img)
    const changes = (next: ImageRecord) => !sceneEqual({ frames: [], objects: [rec] }, { frames: [], objects: [next] })
    return { cropped: rec.crop !== undefined, canFit: changes(fitRecord(rec, size)), canFill: changes(fillRecord(rec, size)) }
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

  private syncState() {
    const active = this.canvas.getActiveObject()
    // While a text is edited, Undo and Redo step that edit (Owner Decision 11).
    const edit = this.text.editHistory()
    this.setState({
      selection: this.computeSelection(),
      objectCount: this.canvas.getObjects().length,
      layers: computeLayers(this.canvas.getObjects(), this.canvas.getActiveObjects(), (id) => this.assets.bytes(id)?.name, this.state.layers),
      frameDestinations: this.frameDestinations(),
      // An open crop that differs from where it began can be undone too: Undo applies it, then undoes it.
      canUndo: edit ? edit.canUndo : this.history.canUndo || (this.crop !== null && !sameCrop(storedCrop(this.crop.rect, this.crop.size), storedCrop(this.crop.start, this.crop.size))),
      canRedo: edit ? edit.canRedo : this.history.canRedo,
      editingText: this.text.isEditing(active),
      cropping: this.crop !== null,
    })
  }

  // ---- canvas events -----------------------------------------------------------

  /** A read-only view of what the canvas currently draws. No Fabric objects escape. */
  getFeedbackSnapshot() {
    return this.feedback.snapshot()
  }

  canChangeCaptionSnap() {
    return !this.busy
  }

  previewFileDrop(at?: { clientX: number; clientY: number }) {
    if (!at || !this.editable || this.busy || !this.getPrefs().feedback) {
      if (this.feedback.clearDrop()) this.canvas.requestRenderAll()
      return
    }
    const rect = this.host.getBoundingClientRect()
    this.feedback.showDrop(screenToScene(this.getViewport(), { x: at.clientX - rect.left, y: at.clientY - rect.top }), this.frameRecords())
    this.canvas.requestRenderAll()
  }

  private clearFeedback() {
    if (this.feedback.clear() && !this.disposed) this.canvas.requestRenderAll()
  }

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
      if (this.text.isEditing(target)) return
      this.clearFeedback()
      const g: Gesture = { id: ++this.gestureSeq, kind: 'transform', base: this.snapshot(), transform }
      if (transform.action === 'drag') g.carry = this.collectFollowers(target)
      this.gesture = g
      if (transform.action === 'drag') this.feedback.edgePan.start(transform)
    })

    let lastSnapMove: Event | undefined
    const previewTransform = ({ e, transform }: { e: Event; transform: Transform }) => {
      const g = this.gesture
      if (g?.kind !== 'transform' || g.transform !== transform || !(e instanceof MouseEvent)) return
      const prefs = this.getPrefs()
      if (prefs.captionSnap && transform.action === 'drag') {
        lastSnapMove = e
        const { target } = transform
        this.feedback.captionSnap = this.state.tool === 'select' && !suppressesSnap(e)
          ? this.text.findCaptionSnap(target, c.getObjects(), c.getZoom(), this.feedback.captionSnap)
          : null
      }
      if (prefs.feedback) this.feedback.updateTransform(g.base, transform, c.getObjects(), g.carry?.followers ?? [], () => sceneEqual(this.snapshot(), g.base))
    }
    // Unselected frame members and captions follow by the same delta.
    c.on('object:moving', (event) => {
      const { transform } = event
      const g = this.gesture
      if (g?.kind === 'transform' && g.carry && g.transform === transform) this.placeFollowers(g.carry, transform.target)
      previewTransform(event)
    })
    const previewResize = (event: { e: Event; transform: Transform }) => {
      const image = event.transform.target
      if (this.gesture?.transform === event.transform && isImage(image)) {
        const caption = this.captionFor(image)
        const record = caption && toRecord(caption)
        const parent = toRecord(image)
        if (caption && record?.type === 'text' && record.captionPosition !== undefined && parent?.type === 'image') {
          this.positionCaption(caption, image, record, parent)
        }
      }
      previewTransform(event)
    }
    c.on('object:scaling', previewResize)
    c.on('object:rotating', previewResize)
    c.on('object:resizing', previewTransform)

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
      if (g?.kind === 'transform' && g.transform?.action === 'drag') {
        this.feedback.edgePan.update(opt.e, this.getPrefs().feedback)
        // A modifier can change without a Fabric object:moving event.
        if (this.getPrefs().captionSnap && g.transform.actionPerformed && opt.e !== lastSnapMove) {
          previewTransform({ e: opt.e, transform: g.transform })
          c.requestRenderAll()
        }
      }
      if (g?.kind !== 'draft' || !g.draft) return
      const p = c.getScenePoint(opt.e)
      g.draft.end = { x: p.x, y: p.y }
      c.draft = rectFromDrag(g.draft.start, g.draft.end) // drawing only; nothing on the board changes
      c.requestRenderAll()
    })

    c.on('object:modified', ({ e, target, transform }) => {
      if (this.applying || !this.editable) return
      const g = this.gesture
      if (g) {
        // Only the release of this gesture's own transform settles it, and only once.
        if (transform !== undefined && transform === g.transform && g.kind === 'transform') {
          const snap = this.feedback.captionSnap
          if (snap && this.getPrefs().captionSnap && e && !suppressesSnap(e)) g.captionSnap = snap
          g.kind = 'settling'
          const id = g.id
          queueMicrotask(() => this.settle(id))
        }
        return
      }
      // No gesture: a text left its edit with changes, or an editing textbox was resized by
      // a handle. (Fabric 7.4 hides an editing textbox's handles, so the second case is not
      // reachable today; the limit is applied anyway so that it can never bypass it.)
      if (this.text.isText(target)) {
        if (transform && isScaleAction(transform)) this.limitScale(transform, [], [{ fontSize: this.text.fontSizeOf(target) }])
        this.text.normalizeScale(target)
      }
      this.commit()
    })

    this.text.bindCanvasEvents()

    // Double-clicking a frame's label (or outline) is "rename": the UI puts the cursor in the
    // name field. Deferred, like everything else that follows from a canvas event.
    c.on('mouse:dblclick', (opt) => {
      const target = opt.target
      if (!this.editable || this.busy || this.crop || !target) return
      // Double-clicking a text's bottom handle is Auto height: it grows with its words again.
      if (this.text.isText(target) && !isLocked(target) && !this.text.isEditing(target) && c.getActiveObject() === target && this.handleUnder(target, opt.e) === 'mb') {
        queueMicrotask(() => {
          if (this.editable && !this.busy && c.getActiveObject() === target) this.text.clearHeight()
        })
        return
      }
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
      if (ctx !== c.getContext()) return
      this.feedback.draw(ctx, c.getObjects(), c.viewportTransform)
      const s = this.crop
      if (!s) return
      drawCropOverlay(ctx, cropOverlay(s.full, s.size, s.rect, c.viewportTransform), c.getRetinaScaling())
    })

    c.on('mouse:up:before', ({ e }) => {
      if (e instanceof MouseEvent && isPrimary(e)) this.feedback.edgePan.stop(e)
    })
    c.on('mouse:up', (opt) => {
      if (!isPrimary(opt.e)) return // other buttons never start, finish or clear anything
      const g = this.gesture
      if (g?.kind !== 'settling') this.clearFeedback()
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

  /**
   * Who a new wheel gesture belongs to (`pickWheelOwner`): the facts at the pointer. The board is
   * free when no gesture, pan or crop is unsettled and neither the hand tool nor Space is in effect
   * (a read-only board, whose only tool is the hand, still lets a long text be read). The front-most
   * object whose box holds the pointer counts, locked or not: scrolling stores nothing, and a locked
   * image in front still covers the text.
   */
  private wheelOwner(e: WheelEvent): WheelOwner {
    const c = this.canvas
    const free = !this.gesture && !this.pan && !this.crop && !this.spaceHeld && !(this.editable && this.state.tool === 'hand')
    if (!free) return CANVAS_OWNER
    const p = c.getScenePoint(e)
    const objects = c.getObjects()
    let front: FabricObject | undefined
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i]!
      if (o.visible && o.containsPoint(p)) {
        front = o
        break
      }
    }
    const id = front && idOf(front)
    return pickWheelOwner({
      free,
      shiftKey: e.shiftKey,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      frameOverlay: !!c.frameOverlayAt(objects, p),
      front: id ? { id, scroll: this.text.isText(front) ? this.scene.layer.scrollOf(id) : null } : null,
    })
  }

  /** The handle of a selected object under a pointer event (`'mb'`, `'tl'`...), or undefined. */
  private handleUnder(obj: FabricObject, e: Event): string | undefined {
    if (!(e instanceof MouseEvent) || typeof obj.findControl !== 'function') return undefined
    return obj.findControl(this.canvas.getViewportPoint(e))?.key
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
    this.clearFeedback()
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
    const obj = this.buildFrame({
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
    if (g.captionSnap && this.getPrefs().captionSnap && this.text.isText(target)) {
      members[0] = this.attachSnappedCaption(target, g.captionSnap)
    } else this.detachTransformedCaptions(g.base, members)
    this.applyOwnership(g.base, members)
  }

  private attachSnappedCaption(text: FabricObject, snap: CaptionSnapPreview): FabricObject {
    let target = text
    const drawn = this.text.drawnCaptionOf(text) // the text itself when it already wraps as a caption does
    if (!drawn) return text
    if (drawn !== text) {
      const index = this.canvas.getObjects().indexOf(text)
      this.canvas.discardActiveObject()
      this.canvas.remove(text)
      this.canvas.insertAt(index, drawn)
      this.canvas.setActiveObject(drawn)
      target = drawn
    }
    setCaption(target, snap.imageId, storedSnapSide(snap.side), snap.position)
    return target
  }

  /** Direct manipulation detaches before ordinary ownership is decided. */
  private detachTransformedCaptions(base: Scene, members: readonly FabricObject[]) {
    const transformed = new Set(members.map((o) => idOf(o) ?? ''))
    for (const caption of members) {
      const imageId = captionOf(caption)
      if (!imageId) continue
      const rec = toRecord(caption)
      const before = base.objects.find((o) => o.id === rec?.id)
      if (rec?.type !== 'text' || before?.type !== 'text') continue
      if (captionWillDetach(before, rec, transformed)) setCaption(caption, undefined)
    }
  }

  /** Unselected frame members and captions, with where they and the drag target started. */
  private collectFollowers(target: FabricObject): Carry {
    const members = target instanceof ActiveSelection ? target.getObjects() : [target]
    const moved = { direct: new Set<string>(), frames: new Set<string>(), images: new Set<string>() }
    for (const obj of members) {
      const id = idOf(obj)
      if (!id) continue
      moved.direct.add(id)
      if (isFrame(obj)) moved.frames.add(id)
    }
    const objects = this.canvas.getObjects()
    for (const obj of objects) {
      const id = idOf(obj)
      const owner = ownerOf(obj)
      if (id && isImage(obj) && (moved.direct.has(id) || (owner && moved.frames.has(owner)))) moved.images.add(id)
    }
    const followers: Carry['followers'] = []
    for (const obj of objects) {
      const id = idOf(obj)
      if (id && followsDrag({ id, frameId: ownerOf(obj), captionOf: captionOf(obj) }, moved)) {
        followers.push({ obj, left: obj.left, top: obj.top })
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
      if (!isFrame(m) && !captionOf(m)) setOwner(m, ownerAfterManipulation(ownerOf(m), centerOf(m), now.frames, coTransformed))
    }
    for (const id of coTransformed) {
      const before = base.frames.find((f) => f.id === id)
      const after = now.frames.find((f) => f.id === id)
      if (!before || !after || (before.width === after.width && before.height === after.height)) continue
      const rest = this.canvas.getObjects().filter((o) => ownerOf(o) === id && !transformed.has(o) && !captionOf(o))
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
      } else if (this.text.isText(m)) {
        const rec = base.objects.find((o) => o.id === id)
        if (rec?.type === 'text') baseTexts.push({ fontSize: rec.fontSize })
      }
    }
    this.limitScale(transform, baseFrames, baseTexts)

    if (target instanceof ActiveSelection) {
      // Judged per member, on its absolute scale: a selection that returns to scale 1 can
      // still leave a member scaled (one that joined while the selection was scaled).
      if (members.some((o) => (this.text.isText(o) || isFrame(o)) && hasResidualScale(o))) {
        // Fold the scale into member text (font size/width) and bake it into member frames
        // (which are stored at scale 1), which means dissolving and re-forming the selection.
        const keep = members.slice()
        this.canvas.discardActiveObject()
        for (const o of keep) {
          if (this.text.isText(o)) this.text.normalizeScale(o)
          else if (isFrame(o)) bakeFrame(o)
        }
        this.selectByIds(keep)
      }
    } else if (this.text.isText(target)) {
      this.text.normalizeScale(target)
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
    this.clearFeedback()
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

    // The stage holding the scene layer and the canvas: while a text is edited the canvas takes no
    // presses (the card and the items in front of it do), and they must still be routed here.
    const stage = this.host

    // Runs before Fabric (capture phase): decides which presses Fabric may see at all.
    listen(
      stage,
      'mousedown',
      (e) => {
        if (!this.live) {
          // Still hydrating: the board is inert.
          e.preventDefault()
          e.stopPropagation()
          return
        }
        if (this.text.editedTarget()) {
          this.editingPress(e)
          return
        }
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
      this.healPrimaryDown(e.buttons)
      // A primary drag is in progress: this release is not Fabric's business, and letting
      // it through would end Fabric's tracking of the drag.
      if (this.primaryDown) e.stopPropagation()
    }
    // Chromium sends no `mouseup` for a release over a disabled control (a greyed-out panel button),
    // only a `pointerup`: a drag released there would never end for Fabric or for the editor, and the
    // next move would undo it. Such a release is passed on as the `mouseup` it should have been, from
    // the control's enabled parent, so it reaches the window and the document like any other; nothing
    // is clicked (no `mousedown` went with it) and the control does not act.
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || !(e.target instanceof Element)) return
      const disabled = e.target.closest(':disabled')
      if (!disabled) return
      const from = disabled.parentElement ?? disabled.ownerDocument.body
      from.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          button: e.button,
          buttons: e.buttons,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        }),
      )
    }
    // A press on a disabled control gets no `mousedown` either, so nothing can keep its default from
    // taking the keyboard away from the text being edited: its `pointerdown` default is prevented
    // instead (a disabled control does nothing with a press anyway; its hover tip still shows).
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.target instanceof Element && e.target.closest(':disabled')) e.preventDefault()
    }
    // A native drag (e.g. dragging selected text) ends with `dragend` and no `mouseup` at all.
    const onDragEnd = () => this.healPrimaryDown(0)
    const onMouseDown = (e: MouseEvent) => this.healPrimaryDown(e.button === 0 ? 0 : e.buttons)
    const onMouseMove = (e: MouseEvent) => this.healPrimaryDown(e.buttons)
    window.addEventListener('mousedown', onMouseDown, { capture: true })
    window.addEventListener('mouseup', onMouseUp, { capture: true })
    window.addEventListener('mousemove', onMouseMove, { capture: true })
    window.addEventListener('dragend', onDragEnd, { capture: true })
    window.addEventListener('pointerup', onPointerUp, { capture: true })
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    this.cleanups.push(() => {
      window.removeEventListener('pointerup', onPointerUp, { capture: true })
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('mousedown', onMouseDown, { capture: true })
      window.removeEventListener('mouseup', onMouseUp, { capture: true })
      window.removeEventListener('dragend', onDragEnd, { capture: true })
      window.removeEventListener('mousemove', onMouseMove, { capture: true })
    })

    listen(
      stage,
      'wheel',
      (e) => {
        e.preventDefault()
        if (!this.live) return
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.host.clientHeight : 1
        // A wheel gesture belongs to whatever it started on (plan Section 4): a fixed-height text
        // scrolls by as much as the board would have moved, and stops at its end; the board pans.
        const owner = this.wheel.route(e.timeStamp, e.ctrlKey || e.metaKey, () => this.wheelOwner(e))
        if (owner === 'zoom') {
          const rect = this.host.getBoundingClientRect()
          const at = { x: e.clientX - rect.left, y: e.clientY - rect.top }
          this.setViewport(zoomAround(this.getViewport(), at, this.getViewport().zoom * Math.exp((-e.deltaY * unit) / 300)))
        } else if (owner.kind === 'card') {
          this.scene.layer.scrollCardBy(owner.id, (e.deltaY * unit) / this.getViewport().zoom)
        } else {
          const vp = this.getViewport()
          const dx = (e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) * unit
          const dy = (e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY) * unit
          this.setViewport({ ...vp, panX: vp.panX - dx, panY: vp.panY - dy })
        }
      },
      { passive: false },
    )

    // While a text is edited, the browser's own menu opens in the card only (the canvas stops its own).
    listen(this.host, 'contextmenu', (e) => {
      if (this.text.editedTarget() && !this.text.pressInsideEdit(e)) e.preventDefault()
    })
    // The board does not follow a caret typed out of view, as on the canvas (plan Section 7, rule 5):
    // the browser and ProseMirror scroll every ancestor of the edited card that can scroll at all to
    // show the caret, and `.workspace` hides a few pixels of overflow. Put any such ancestor back
    // before it is painted (scroll events come before the frame is drawn).
    const keepStill = (e: Event) => {
      const el = e.target
      if (!(el instanceof HTMLElement) || !el.contains(this.host) || (el.scrollTop === 0 && el.scrollLeft === 0)) return
      el.scrollTop = 0
      el.scrollLeft = 0
    }
    document.addEventListener('scroll', keepStill, { capture: true })
    this.cleanups.push(() => document.removeEventListener('scroll', keepStill, { capture: true }))

    const ro = new ResizeObserver(() => {
      const { width, height } = this.host.getBoundingClientRect()
      const size = { width: Math.floor(width), height: Math.floor(height) }
      if (size.width <= 0 || size.height <= 0) return
      if (size.width === this.canvas.getWidth() && size.height === this.canvas.getHeight()) return
      this.canvas.setDimensions(size)
      this.jumpReturn = null
      this.setState({ canvasSize: size, jumpReturns: false })
      this.canvas.requestRenderAll()
    })
    ro.observe(this.host)
    this.cleanups.push(() => ro.disconnect())

    const onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e)
    const onKeyUp = (e: KeyboardEvent) => {
      this.text.onKeyUp() // what the key typed has arrived by now, if it typed anything
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
      if (this.primaryDown) this.healPrimaryDown(0)
      else if (this.cancelGesture()) this.queueIdle()
      // A crop handle drag returns to where it began; crop mode stays open.
      if (this.crop?.drag) this.endCropDrag(false)
    }
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return
      this.feedback.edgePan.pause()
      void this.autosaver.flush()
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
   * A press while a text is edited (plan Section 4, the editing row of the
   * routing table). Inside the edited text, where nothing covers it (judged as the canvas judges a
   * press, `pressInsideEdit`), it is the browser's and the view's:
   * the caret or a selection, a word on a double-click, the browser's own menu on the right button.
   * The middle button ends the edit and pans. Any other primary press (empty canvas, a frame's
   * interior, label or outline, another object, an unlocked object in front of the card) ends the
   * edit and is then given to the canvas as the same press, so that one press both ends the edit and
   * selects, drags, Shift-selects, marquees or starts a Text-tool box (the Outside path).
   */
  private editingPress(e: MouseEvent) {
    const inside = this.text.pressInsideEdit(e)
    if (e.button !== 0) {
      if (e.button === 2 && inside) return
      e.preventDefault()
      e.stopPropagation()
      if (e.button === 1 && !this.primaryDown) {
        this.finishEditing({ keepCrop: true })
        this.beginPan(e)
      }
      return
    }
    if (inside) {
      // In the edited text: the browser places the caret, unless it would not route this press there.
      if (this.text.strayPressInEdit(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const left = this.text.editedTarget()
    this.finishEditing()
    if (this.text.editedTarget()) return // the edit could not end: nothing else happens
    // Fabric hides an edited text's handles for the whole edit, the press that ends it included:
    // that press never grabs a handle of the text it leaves (they come back once Fabric has taken it).
    const controls = left?.hasControls === true
    if (left && controls) left.hasControls = false
    const { clientX, clientY, screenX, screenY, button, buttons, shiftKey, ctrlKey, altKey, metaKey, detail } = e
    try {
      this.canvas.upperCanvasEl.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, view: window, clientX, clientY, screenX, screenY, button, buttons, shiftKey, ctrlKey, altKey, metaKey, detail }),
      )
    } finally {
      if (left && controls) left.hasControls = true
    }
  }

  /**
   * The primary release can be lost (it went to another window, or a native drag ended
   * without one). The first mouse event that proves the release was lost cancels the old
   * gesture before Fabric can move it again. A new primary press also proves it was lost.
   */
  private healPrimaryDown(buttons: number) {
    if (!this.primaryDown || (buttons & 1) !== 0) return
    this.primaryDown = false
    // A range drag inside the text being edited stays as it is (the edit and its range go on): it is the browser's.
    if (this.cancelGesture()) this.queueIdle()
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
    const ctx = {
      editingText: this.state.editingText,
      textSelected: this.text.isText(active) && !this.text.isEditing(active),
      hasSelection: !!active,
      canEditCaption: e.key === 'Enter' && !e.defaultPrevented && this.captionImage() !== undefined,
    }
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
    // A key the text being edited claims (see the adapter's `onKeyDown`).
    if (this.text.onKeyDown(e)) return
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
      case 'edit-caption':
        return this.editCaption()
      case 'frame-navigator':
        if (this.canNavigateFrames()) this.openFrameNavigator?.()
        return
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

  private openFrameNavigator: (() => void) | null = null

  setFrameNavigator(open: (() => void) | null) {
    this.openFrameNavigator = open
  }

  setLayerPressActive(active: boolean) {
    this.layerPressActive = active
  }

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
    this.text.finishEditing()
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
    // The proxy is un-cropped, and the scene layer then draws the whole original.
    const start = shownCropOf(img)
    const shown: Placement = { left: img.left, top: img.top, angle: img.angle, scaleX: img.scaleX, scaleY: img.scaleY }
    const full = uncroppedPlacement(shown, start)
    this.crop = {
      base: this.snapshot(),
      target: img,
      before: {
        left: img.left,
        top: img.top,
        cropX: start.x,
        cropY: start.y,
        width: start.width,
        height: start.height,
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
      // Its picture data and size, exactly as they were (no rounding).
      setImageCrop(img, { x: b.cropX, y: b.cropY, width: b.width, height: b.height })
      img.set({ left: b.left, top: b.top })
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
      const { asset, el } = await this.decodeImageFile(file)
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

  // ---- captions -----------------------------------------------------------------------

  private captionImage(): FabricObject | undefined {
    if (!this.editable || this.busy || this.crop || this.pan) return
    const image = this.canvas.getActiveObject()
    if (!isImage(image) || isLocked(image)) return
    const caption = this.captionFor(image)
    if (!caption || !isLocked(caption)) return image
  }

  editCaption() {
    const image = this.captionImage()
    if (!image) return
    const imageId = idOf(image)
    const rec = toRecord(image)
    if (!imageId || rec?.type !== 'image') return
    if (this.state.tool !== 'select') this.switchTool('select')
    let caption = this.captionFor(image)
    if (!caption) {
      const fontSize = this.newTextFontSize()
      const placement = captionPlacement(captionImageBounds(rec, imageSizeOf(image)), undefined, { fontSize, width: 0, height: 0 })
      const made = this.build({
        id: newId(), type: 'text', text: '', angle: 0, fontSize, minHeight: 0, ...placement, captionOf: imageId,
        ...(rec.frameId && { frameId: rec.frameId }),
      }, () => undefined)
      if (!this.text.isText(made)) return
      this.canvas.insertAt(this.canvas.getObjects().indexOf(image) + 1, made)
      caption = made
    }
    this.canvas.setActiveObject(caption)
    this.text.startEditing(caption, 'end')
    this.canvas.requestRenderAll()
    this.syncState()
  }

  private captionToDetach(objects: readonly FabricObject[]): FabricObject | undefined {
    if (objects.length !== 1) return
    const selected = objects[0]!
    if (isLocked(selected)) return
    const caption = isImage(selected) ? this.captionFor(selected) : this.text.isText(selected) ? selected : undefined
    if (!caption || isLocked(caption)) return
    const imageId = captionOf(caption)
    if (!imageId) return
    const image = this.canvas.getObjects().find((o) => idOf(o) === imageId)
    if (isImage(image) && !isLocked(image)) return caption
  }

  detachCaption() {
    if (!this.editable || this.busy) return
    const caption = this.captionToDetach(this.canvas.getActiveObjects())
    if (!caption) return
    this.finishEditing()
    if (this.text.isBlank(caption)) return // discarded by the ordinary edit exit
    setCaption(caption, undefined)
    this.commit()
  }

  private detachedTextWithBackground(object: FabricObject | undefined): FabricObject | undefined {
    if (this.text.isText(object) && !captionOf(object) && this.text.backgroundOf(object)) return object
  }

  setCaptionBackground(value?: string) {
    if (!this.editable || this.busy || this.crop || this.pan) return
    const selected = this.canvas.getActiveObjects()
    if (selected.length !== 1) return
    const caption = this.captionToDetach(selected) ?? this.detachedTextWithBackground(selected[0])
    if (!caption || isLocked(caption) || this.text.isBlank(caption)) return
    const color = value === undefined ? '' : captionBackground(value)
    const current = this.text.backgroundOf(caption)
    if (color === undefined || color === current) return
    const coalesce = color && current ? `caption-color:${idOf(caption)}` : undefined
    this.finishEditing()
    this.text.setBackground(caption, color)
    this.canvas.requestRenderAll()
    this.commit(coalesce)
  }

  private captionPair(objects: readonly FabricObject[]): { image: FabricObject; text: FabricObject } | undefined {
    if (objects.length !== 2) return
    const image = objects.find(isImage)
    const text = objects.find((o) => this.text.isText(o))
    if (!image || !text || isLocked(image) || isLocked(text) || captionOf(text) || this.captionFor(image) || this.text.isBlank(text)) return
    return { image, text }
  }

  makeCaption() {
    if (!this.editable || this.busy || !this.captionPair(this.canvas.getActiveObjects())) return
    this.finishEditing()
    const pair = this.captionPair(this.canvas.getActiveObjects())
    if (!pair) return
    const { image, text } = pair
    const imageId = idOf(image)
    const rec = toRecord(text)
    const parent = toRecord(image)
    if (!imageId || rec?.type !== 'text' || parent?.type !== 'image') return
    const width = captionPlacement(captionImageBounds(parent, imageSizeOf(image)), undefined, { ...rec, height: text.height }).width
    // A text made with a click has legacy word wrapping. Rebuild it as a drawn box in its
    // existing stack slot, retaining its id and all its formatting and drawn height.
    const made = this.build({ ...rec, captionOf: imageId, width, minHeight: rec.minHeight ?? 0 }, () => undefined)
    if (!this.text.isText(made)) return
    const index = this.canvas.getObjects().indexOf(text)
    const selected = this.canvas.getActiveObjects().map((o) => o === text ? made : o)
    this.canvas.discardActiveObject()
    this.canvas.remove(text)
    this.canvas.insertAt(index, made)
    this.selectByIds(selected)
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

  private newTextFontSize(): number {
    return Math.round(clamp(24 / this.getViewport().zoom, 12, 160))
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
    const fontSize = this.newTextFontSize()
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
    const obj = this.build(rec, () => undefined)
    if (!this.text.isText(obj)) return
    this.canvas.add(obj)
    // Owner first, in the same step that adds it: typing is saved as it happens, so no
    // save may ever see this text without its owner. (Touches no history.)
    setOwner(obj, this.ownerForNew(obj))
    this.canvas.setActiveObject(obj)
    this.text.startEditing(obj)
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
        const { asset, el } = await this.decodeImageFile(file)
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

  private async decodeImageFile(file: File) {
    this.pendingImageDecodes++
    try {
      const asset = await readImageFile(file)
      const el = await this.assets.load(asset)
      return { asset, el }
    } finally {
      this.pendingImageDecodes--
    }
  }

  /** Adds one imported batch as its own history step. Never called from a Fabric callback. */
  private applyImport(records: readonly ImageRecord[]) {
    if (!this.editable || this.busy) return
    this.finishEditing() // first, so that text being typed is committed as its own step
    const added: FabricObject[] = []
    for (const rec of records) {
      const obj = this.build(rec, (id) => this.assets.get(id))
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
    const listed = (o: FabricObject) => !this.text.isBlank(o)
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
    const deletedImages = new Set(objs.filter(isImage).map(idOf))
    for (const o of this.canvas.getObjects()) {
      const parent = captionOf(o)
      if (parent === undefined || !deletedImages.has(parent)) continue
      if (isLocked(o)) setCaption(o, undefined)
      else doomed.add(o)
    }
    const deletedFrames = new Set<string>()
    for (const o of objs) if (isFrame(o)) deletedFrames.add(idOf(o) ?? '')
    if (deletedFrames.size > 0) {
      for (const o of this.canvas.getObjects()) {
        const owner = ownerOf(o)
        if (owner !== undefined && deletedFrames.has(owner) && !doomed.has(o)) setOwner(o, undefined)
      }
    }
    this.canvas.discardActiveObject()
    this.canvas.remove(...doomed)
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

  /** The font size of the one selected text (headings keep their ratio). One undo step per text, coalesced. */
  setFontSize(size: number) {
    this.text.setFontSize(size)
  }

  // ---- text formatting ----------------------------------------------------------------------
  //
  // Every command acts on the one selected text, and only while the board is editable and no
  // gesture is unsettled (see `textAdapter.ts`). While the text is being edited, marks and
  // headings act on the selected range; on a selected box that is not being edited they act on
  // the whole box, as an undo step of its own. None of them changes ownership.

  /** Bold, italic, underline or strikethrough: the selected range, a caret's next characters, or the whole box. */
  toggleMark(mark: Mark) {
    this.text.toggleMark(mark)
  }

  /** Heading level 1 to 3, or 0 for body text. Editing: every line the selection touches (the caret's line). Not editing: every line. */
  setHeading(level: 0 | 1 | 2 | 3) {
    this.text.setHeading(level)
  }

  /** Inline code: the selected range, a caret's next characters, or the whole box. */
  toggleCode() {
    this.text.toggleMark('code')
  }

  /**
   * Bullet list, numbered list, checklist, quote or code block. Editing: the lines the selection
   * touches. Not editing: every line, as one undo step. Off when every line concerned already is one.
   */
  toggleTextBlock(kind: BlockKind) {
    this.text.toggleBlock(kind)
  }

  /** A divider at the caret of the text being edited; nothing on a box that is not being edited. */
  insertTextDivider() {
    this.text.insertDivider()
  }

  /** The font of the selection or whole box, or the next characters typed at a caret. */
  setTextFont(font: FontId) {
    this.text.setFont(font)
  }

  /** The alignment of the whole box, also while it is being edited. The box keeps its position and width. */
  setTextAlign(align: TextAlign) {
    this.text.setAlign(align)
  }

  /** The colour (`#rrggbb`) of the whole box, also while it is being edited. The default ink is stored as no colour. */
  setTextColor(color: string) {
    this.text.setColor(color)
  }

  /**
   * Auto height: the one selected text, which has a fixed height, grows with its words again (its
   * top edge stays). One undo step on a selected box; part of the edit's step while it is edited.
   */
  setTextAutoHeight() {
    this.text.clearHeight()
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
    const ownersAfterAdding: Array<() => void> = []
    const chosen = (rec: Scene['objects'][number]) => selected.has(rec.id) || (rec.frameId !== undefined && copiedOwners.has(rec.frameId))
    const images = new Set(scene.objects.filter((rec) => rec.type === 'image' && chosen(rec)).map((rec) => rec.id))
    const sources = scene.objects.filter((rec) => chosen(rec) || (rec.type === 'text' && rec.captionOf !== undefined && images.has(rec.captionOf)))
    const copies = new Map(sources.map((rec) => [rec.id, newId()]))

    for (const rec of sources) {
      const copiedOwner = rec.frameId === undefined ? undefined : copiedOwners.get(rec.frameId)
      const copy = { ...rec, id: copies.get(rec.id)!, left: round(rec.left + offset), top: round(rec.top + offset) }
      delete copy.locked
      if (copy.type === 'text' && copy.captionOf) {
        const imageId = copies.get(copy.captionOf)
        if (imageId) copy.captionOf = imageId
        else {
          delete copy.captionOf
          delete copy.captionSide
          delete copy.captionPosition
        }
      }
      const obj = this.build(copy, (id) => this.assets.get(id))
      if (!obj) return // nothing has been added yet
      const decideOwner = () => {
        if (!captionOf(obj)) setOwner(obj, copiedOwner ?? ownerAfterManipulation(rec.frameId, centerOf(obj), scene.frames, NO_FRAMES))
      }
      // A text proxy has its card's size only once it is on the canvas (the scene layer sizes it
      // when it is added), so the owner is decided after adding, from that size.
      ownersAfterAdding.push(decideOwner)
      content.push(obj)
      if (selected.has(rec.id)) selection.push(obj)
    }
    if (frames.length === 0 && content.length === 0) return

    const frameObjects = frames.map((rec) => this.buildFrame(rec))
    this.canvas.discardActiveObject()
    if (frameObjects.length) this.canvas.insertAt(scene.frames.length, ...frameObjects)
    if (content.length) this.canvas.add(...content)
    for (const decide of ownersAfterAdding) decide()
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

  private layoutItems(objects: readonly FabricObject[]): FabricObject[] {
    const ids = new Set(objects.map(idOf))
    return objects.filter((o) => {
      const imageId = captionOf(o)
      return !imageId || !ids.has(imageId)
    })
  }

  /** Translates each selected object independently, leaving its shape and stacking alone. */
  layoutSelection(op: Layout) {
    if (!this.editable || this.busy || this.selectionLocked() || this.canvas.getActiveObjects().length < 2) return
    this.finishEditing()
    const selected = new Set(this.canvas.getActiveObjects())
    const all = this.canvas.getObjects()
    const members = this.layoutItems(all.filter((o) => selected.has(o))) // stable distribution order for tied bounds
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
    const moved = [...moves.keys()]
    this.detachTransformedCaptions(base, moved)
    this.applyOwnership(base, moved)
    this.selectByIds([...selected])
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
    const listed = (o: FabricObject) => !this.text.isBlank(o)
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
    const objs = this.canvas.getActiveObjects().filter((o) => !this.text.isBlank(o))
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
    const listed = (o: FabricObject) => !this.text.isBlank(o)
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
    if (this.text.stepEdit('undo')) return // a step of the text being edited; the edit stays open
    this.finishEditing()
    const scene = this.history.undo()
    if (scene) this.restoreHistory(scene)
  }

  redo() {
    if (!this.editable || this.busy) return
    if (this.text.stepEdit('redo')) return
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

  private setViewport(vp: Viewport, persist = true, jumpReturn?: Viewport | null) {
    const changed = !sameViewport(vp, this.getViewport())
    if (jumpReturn !== undefined || changed) this.jumpReturn = jumpReturn ?? null
    this.canvas.setViewportTransform([vp.zoom, 0, 0, vp.zoom, vp.panX, vp.panY])
    this.feedback.edgePan.replay()
    this.canvas.requestRenderAll()
    this.setState({ viewport: vp, jumpReturns: this.jumpReturn !== null })
    if (changed && persist && this.state.ready) this.autosaver.markDirty()
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
    this.scene.syncAllCards({ keepWidth: true }) // text proxies are their cards' current size; Fit changes no record
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

  private frameDestinations(): readonly FrameDestination[] {
    const scene = this.history.current
    if (scene !== this.destinationScene) {
      this.destinationScene = scene
      const next = collectFrameDestinations(scene)
      if (!valuesEqual(next, this.state.frameDestinations)) return next
    }
    return this.state.frameDestinations
  }

  canNavigateFrames(): boolean {
    return this.live && !this.busy && !this.primaryDown && !this.pan && !this.crop &&
      !this.state.editingText && !this.spaceHeld && !this.layerPressActive
  }

  jumpToFrame(id: string): boolean {
    if (!this.canNavigateFrames()) return false
    const frame = this.state.frameDestinations.find((entry) => entry.id === id)
    if (!frame) return false
    const current = this.getViewport()
    const fitted = fitViewport(frame.bounds, this.state.canvasSize)
    if (sameViewport(current, fitted)) return true
    const start = this.jumpReturn ?? current
    this.setViewport(fitted, true, sameViewport(start, fitted) ? null : start)
    return true
  }

  returnFromJump(): boolean {
    if (!this.canNavigateFrames() || !this.jumpReturn) return false
    this.setViewport(this.jumpReturn, true, null)
    return true
  }

  /** Capture a settled scene. Each stop renders on its own detached canvas. */
  startFrameTour(): FrameTourSession | null {
    const focused = document.activeElement
    if (!this.canNavigateFrames() || this.pendingImageDecodes > 0 || this.stagedImports.length || this.stagedReplacements.length ||
      focused?.closest('input, textarea, select, [contenteditable="true"]')) return null

    const selectedIds = new Set(this.canvas.getActiveObjects().filter(isFrame).flatMap((object) => idOf(object) ?? []))
    const scene = this.history.current
    const host = this.host.getBoundingClientRect()
    const view = window.visualViewport
    const left = (view?.offsetLeft ?? 0) - host.left
    const top = (view?.offsetTop ?? 0) - host.top
    const frames = frameTourPath(this.state.frameDestinations, selectedIds, this.getViewport(), {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(this.state.canvasSize.width, left + (view?.width ?? window.innerWidth)),
      bottom: Math.min(this.state.canvasSize.height, top + (view?.height ?? window.innerHeight)),
    })
    const frameIds = new Set(frames.map(({ id }) => id))
    let rendering = Promise.resolve()
    return {
      frames,
      renderFrame: (id, signal) => {
        const preview = rendering.then(() => {
          signal.throwIfAborted()
          if (this.disposed || !frameIds.has(id)) throw new Error('The tour frame is unavailable.')
          const getImage = (assetId: string) => this.assets.get(assetId)
          // The bitmap comes from the same cards the scene layer draws (plan Section 10). A card that
          // even the box the preview builds for it (as the layer knows it) keeps outside the frame
          // is not laid out again.
          const dom = this.scene
          const cardSize = (rec: TextRecord) => dom.builtCardBound(rec)
          return renderFrameToCanvas(scene, id, { getImage, measurer: dom.layer.measurer, cardSize }).then((canvas) => canvas.toDataURL('image/png'))
        })
        rendering = preview.then(() => undefined, () => undefined)
        return preview
      },
    }
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

const sameViewport = (a: Viewport, b: Viewport) =>
  a.zoom === b.zoom && a.panX === b.panX && a.panY === b.panY

/** Corner (and side) scaling, as opposed to moving, rotating or changing a text's wrap width. */
function isScaleAction(transform: Transform): boolean {
  return transform.action === 'scale' || transform.action === 'scaleX' || transform.action === 'scaleY'
}
