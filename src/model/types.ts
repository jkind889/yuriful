import type { BoardAppearance } from './appearance.ts'

/** In-memory document version. The wire format may be older; see `StoredDoc`. */
export const DOC_VERSION = 3
export const DEFAULT_TITLE = 'Untitled board'

export interface RecordBase {
  /** Stable identity across undo/redo and reloads. */
  id: string
  /** Top-left of the object in scene coordinates (before rotation). */
  left: number
  top: number
  /** Degrees, clockwise. */
  angle: number
  /**
   * The frame that owns this object, if any. Ownership is stored, never recomputed:
   * an owner need not contain the object, and an object inside a frame need not be owned by it.
   */
  frameId?: string
  /**
   * Locked: it cannot be grabbed, selected on the canvas or changed until it is unlocked
   * (from the layer list or the inspector). Only ever `true`; absent means unlocked.
   */
  locked?: true
}

/** A rectangle of an original image, in its source pixels ((0, 0) is its top-left). */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageRecord extends RecordBase {
  type: 'image'
  /** Key into the asset store; bytes are never inlined in the document. */
  assetId: string
  scaleX: number
  scaleY: number
  /**
   * The visible part of the original image, in source pixels. Absent: the whole image. The
   * original bytes are never changed. With a crop, `left`/`top` are the top-left of the
   * displayed (cropped) box and the displayed size is `crop.width * scaleX` by
   * `crop.height * scaleY`. Never stored when it is the whole image.
   */
  crop?: CropRect
}

/** A named font choice. The board stores the id, never a font name (see src/editor/fonts.ts). */
export type FontId = 'sans' | 'serif' | 'mono' | 'hand' | 'display'

/** An attached caption's side. The default (below the image) has no stored value. */
export type CaptionSide = 'top' | 'left' | 'right'

/**
 * Formatting on a range of a text's characters. Offsets are UTF-16 code units into the
 * text; a span may cross a line break. Marks are present only when on, and a font only
 * when different from the box font. See src/model/richText.ts for the
 * canonical form every stored and in-memory span list is in.
 */
export interface TextSpan {
  start: number
  end: number
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  font?: FontId
}

/** An inline mark of a rich text run. `code` exists only in the rich (`blocks`) form. */
export type TextMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code'

/** A run of characters with the same formatting, inside a paragraph or heading of `blocks`. */
export interface InlineRun {
  /** Non-empty text; never contains '\n'. */
  text: string
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  code?: true
  /** Present only when different from the box's base font. */
  font?: FontId
}

export interface ListItemNode {
  /** Non-empty. */
  blocks: BlockNode[]
}

export interface TaskItemNode {
  checked: boolean
  /** Non-empty. */
  blocks: BlockNode[]
}

/** A block of a rich text. See src/model/textDoc.ts for validation and the canonical form. */
export type BlockNode =
  /** `content` is omitted when the paragraph is empty. */
  | { type: 'paragraph'; content?: InlineRun[] }
  | { type: 'heading'; level: 1 | 2 | 3; content?: InlineRun[] }
  | { type: 'bulletList'; items: ListItemNode[] }
  /** `start` is omitted when it is 1. */
  | { type: 'orderedList'; start?: number; items: ListItemNode[] }
  | { type: 'taskList'; items: TaskItemNode[] }
  | { type: 'blockquote'; blocks: BlockNode[] }
  | { type: 'codeBlock'; text: string }
  | { type: 'divider' }

/**
 * Formatting fields are absent when they have their default, so a plain text has exactly
 * the milestone 1 keys.
 */
export interface TextRecord extends RecordBase {
  type: 'text'
  /** Always a string. With `blocks`, it is their plain-text projection (`plainTextOf`). */
  text: string
  /** The box's own size; headings are drawn larger (see HEADING_SCALE). */
  fontSize: number
  /** Wrapping width in scene units. */
  width: number
  /** Drawn minimum height in scene units, possibly zero for a flat drag. Absent on click-created and older boxes. */
  minHeight?: number
  /** A fixed, scrollable height in scene units. Absent: the box grows with its text. */
  height?: number
  /** Absent: 'sans'. */
  font?: FontId
  /** Absent: left. */
  align?: 'center' | 'right'
  /** `#rrggbb`, lower case. Absent: the default ink. */
  color?: string
  /** Present only when `blocks` is absent (the compact form). */
  spans?: TextSpan[]
  /** Heading level (0 to 3) per paragraph (`text.split('\n')`), trailing zeros trimmed. Present only when `blocks` is absent. */
  headings?: number[]
  /** Present only when the text uses blocks other than paragraphs and headings, or the inline `code` mark. */
  blocks?: BlockNode[]
  /** Paper background and padding. Absent: bare text. */
  surface?: 'card'
  captionOf?: string
  captionSide?: CaptionSide
  /** Fraction along the edge at the center of the caption. Absent uses legacy alignment. */
  captionPosition?: number
  /** A text-box fill that survives detaching the caption. */
  captionBackground?: string
}

export type ObjectRecord = ImageRecord | TextRecord

/** A named, unrotated rectangle in scene coordinates. */
export interface FrameRecord {
  id: string
  name: string
  left: number
  top: number
  width: number
  height: number
  /** As on content: only ever `true`; absent means unlocked. */
  locked?: true
}

export interface Viewport {
  zoom: number
  panX: number
  panY: number
}

/**
 * The board as the app holds it. `frames` and `objects` are each in z-order, back to
 * front; every frame sits behind every object.
 */
export interface BoardDoc {
  version: typeof DOC_VERSION
  title: string
  frames: FrameRecord[]
  objects: ObjectRecord[]
  viewport: Viewport
  appearance?: BoardAppearance
}

/** What undo/redo and gestures snapshot: everything on the canvas, nothing about the view. */
export type Scene = Pick<BoardDoc, 'frames' | 'objects'>

/** Exactly the shape milestone 1 wrote. Still written for any board without frames. */
export interface StoredDocV1 {
  version: 1
  title: string
  objects: Array<Omit<ImageRecord, 'frameId'> | Omit<TextRecord, 'frameId'>>
  viewport: Viewport
  appearance?: BoardAppearance
}

export interface StoredDocV2 {
  version: 2
  title: string
  frames: FrameRecord[]
  objects: ObjectRecord[]
  viewport: Viewport
  appearance?: BoardAppearance
}

/** Written only for a board with a text that uses `blocks`, `height` or `surface`. `frames` is always present. */
export interface StoredDocV3 {
  version: 3
  title: string
  frames: FrameRecord[]
  objects: ObjectRecord[]
  viewport: Viewport
  appearance?: BoardAppearance
}

/** The document as stored on disk. */
export type StoredDoc = StoredDocV1 | StoredDocV2 | StoredDocV3

export interface StoredAsset {
  id: string
  name: string
  type: string
  bytes: ArrayBuffer
}

export type SaveState =
  | { kind: 'loading' }
  /** Fresh board, nothing has been written yet. */
  | { kind: 'new' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  /** Saving is switched off (storage unavailable or stored board unreadable). */
  | { kind: 'unavailable'; message: string }
