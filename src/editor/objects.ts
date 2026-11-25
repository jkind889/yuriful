import { Control, Rect, controlsUtils, util } from 'fabric'
import type { FabricObject, TransformActionHandler } from 'fabric'
import { clampCrop, storedCrop } from '../model/crop.ts'
import { round, roundPositive } from '../model/doc.ts'
import { canonicalTextFormatting } from '../model/richText.ts'
import { heldFixedHeight, minFixedHeight } from '../model/paper.ts'
import type { CaptionSide, CropRect, FrameRecord, ImageRecord, ObjectRecord, TextRecord } from '../model/types.ts'
import type { Point, Size } from '../model/viewport.ts'

export const ACCENT = '#6c7bf2'
/** Frame paper: drawn by the scene layer and the frame bitmap. */
export const FRAME_FILL = '#ffffff'

interface Meta {
  id: string
  kind: 'image' | 'text' | 'frame'
  assetId?: string
  /** Content only: the frame that owns it. */
  frameId?: string
  /** Frames only. */
  name?: string
  /** Locked (content and frames). Absent means unlocked. */
  locked?: true
  captionOf?: string
  captionSide?: CaptionSide
  captionPosition?: number
}

/** Fabric objects are plain; our identity lives beside them, not on them. */
const meta = new WeakMap<FabricObject, Meta>()

export const idOf = (obj: FabricObject): string | undefined => meta.get(obj)?.id
export const isFrame = (obj: FabricObject): boolean => meta.get(obj)?.kind === 'frame'
export const ownerOf = (obj: FabricObject): string | undefined => meta.get(obj)?.frameId
export const frameNameOf = (obj: FabricObject): string | undefined => meta.get(obj)?.name
export const captionOf = (obj: FabricObject): string | undefined => meta.get(obj)?.captionOf
export const captionSideOf = (obj: FabricObject): CaptionSide | undefined => meta.get(obj)?.captionSide

export function setCaption(obj: FabricObject, imageId: string | undefined, side?: CaptionSide, position?: number) {
  const m = meta.get(obj)
  if (m?.kind !== 'text') return
  if (imageId === undefined) delete m.captionOf
  else m.captionOf = imageId
  if (imageId === undefined || side === undefined) delete m.captionSide
  else m.captionSide = side
  if (imageId === undefined || position === undefined) delete m.captionPosition
  else m.captionPosition = position
}

/** Sets or clears the owner of a piece of content. Frames have no owner. */
export function setOwner(obj: FabricObject, frameId: string | undefined) {
  const m = meta.get(obj)
  if (!m || m.kind === 'frame') return
  if (frameId === undefined) delete m.frameId
  else m.frameId = frameId
}

export function setFrameName(obj: FabricObject, name: string) {
  const m = meta.get(obj)
  if (m?.kind === 'frame') m.name = name
}

export const isLocked = (obj: FabricObject): boolean => meta.get(obj)?.locked === true

/**
 * The Fabric flags of a locked or an unlocked object of the given kind: the only place
 * they are decided, used when an object is created and when it is locked or unlocked, so
 * that unlocking restores exactly what creation set (a frame keeps `lockRotation`).
 *
 * A locked object is not a target (`evented`: presses, hovering, Alt-presses and
 * double-clicks fall through to what is beneath), is not taken by a marquee or Shift-click
 * (`selectable`), shows no handles, and cannot be moved, scaled, rotated or text-edited.
 */
function applyLockFlags(obj: FabricObject, kind: Meta['kind'], locked: boolean) {
  obj.set({
    evented: !locked,
    selectable: !locked,
    hasControls: !locked,
    lockMovementX: locked,
    lockMovementY: locked,
    lockScalingX: locked,
    lockScalingY: locked,
    lockRotation: locked || kind === 'frame',
  })
}

/** Locks or unlocks an object or frame (identity and flags). Changes nothing else: not its place, size, order or owner. */
export function setLocked(obj: FabricObject, locked: boolean) {
  const m = meta.get(obj)
  if (!m) return
  if (locked) m.locked = true
  else delete m.locked
  applyLockFlags(obj, m.kind, locked)
  obj.setCoords()
}

export { newId } from '../model/id.ts'

const SELECTION_STYLE = {
  originX: 'left',
  originY: 'top',
  borderColor: ACCENT,
  cornerColor: '#ffffff',
  cornerStrokeColor: ACCENT,
  cornerStyle: 'rect',
  cornerSize: 9,
  transparentCorners: false,
  borderScaleFactor: 1.5,
  lockScalingFlip: true,
  padding: 2,
  // Fabric's default stroke width of 1 is part of an object's transformed size,
  // which would make center<->top-left conversion drift by half a pixel per round trip.
  strokeWidth: 0,
} as const

/** `{ locked: true }` when set, else nothing: never an explicit `false` or `undefined`. */
const lockMeta = (rec: { locked?: true }): { locked?: true } => (rec.locked === true ? { locked: true } : {})

// ---- proxies ------------------------------------------------------------------------------------
//
// The scene layer (`sceneLayer.ts`) draws frame paper, images and text, and every Fabric object
// is a transparent proxy: it paints nothing, but keeps Fabric's selection, handles, hit testing
// and transforms. Its identity is `meta` (`kind` says what it stands for); what it draws lives
// beside it, in `proxyText` and `proxyImage`. A data object is replaced, never changed, whenever
// what it draws changes, so the editor can tell by identity which items the layer must draw again.

/** What a text proxy's card shows: the record's text, size, wrap width, fixed height (if any) and canonical formatting. */
export type TextData = Pick<TextRecord, 'text' | 'fontSize' | 'width' | 'minHeight' | 'height' | 'font' | 'align' | 'color' | 'spans' | 'headings' | 'blocks' | 'captionBackground' | 'surface'>

/** What an image proxy shows: the picture's own size and the crop's top-left (its size is the proxy's). */
export interface ImageData {
  natural: Size
  cropX: number
  cropY: number
}

const proxyText = new WeakMap<FabricObject, TextData>()
const proxyImage = new WeakMap<FabricObject, ImageData>()

/**
 * A Fabric object that paints nothing (`render` is empty, so no fill, background or shadow
 * either) and is otherwise an ordinary rectangle: visible, evented, selectable, transformed and
 * hit like any object. A text proxy stops a side handle at `minTextWidth`, its widest word (the
 * clamp sits in `_set`, so Fabric's fixed-anchor handling sees it).
 */
export class ProxyRect extends Rect {
  /** Texts: the narrowest width the text allows (scene units); 0 for anything else. */
  minTextWidth = 0

  override render() {}

  override _set(key: string, value: unknown) {
    const clamped = key === 'width' && typeof value === 'number' && this.minTextWidth > 0 ? Math.max(value, this.minTextWidth) : value
    return super._set(key, clamped)
  }
}

const PROXY_STYLE = { fill: 'transparent', strokeWidth: 0, objectCaching: false } as const

/** The `action` of a text's bottom-handle drag (`Transform.action`): it fixes the text's height. */
export const FIX_HEIGHT_ACTION = 'resizeHeight'

/**
 * Fabric's own height change (`changeObjectHeight`: the pointer's distance from the top edge, never
 * past it), then held to at least `minFixedHeight` of the text's size (and its paper's padding), so a
 * line always shows.
 */
const changeTextHeight: TransformActionHandler = (e, transform, x, y) => {
  const target = transform.target
  const before = target.height
  controlsUtils.changeObjectHeight(e, transform, x, y)
  const td = proxyText.get(target)
  const min = td ? minFixedHeight(td.fontSize, td.surface) : 1
  if (target.height < min) target.set({ height: min })
  return target.height !== before
}

/**
 * A text's bottom handle (`mb`, plan Section 9): dragging it fixes the box's height, its top edge
 * staying where it is. Fabric fires `object:resizing` as for a side handle; the scene layer tells the
 * two apart by the transform's action (`FIX_HEIGHT_ACTION`) and stores the height (`domScene.ts`).
 */
function textHeightControl(): Control {
  return new Control({
    x: 0,
    y: 0.5,
    actionHandler: controlsUtils.wrapWithFireEvent('resizing', controlsUtils.wrapWithFixedAnchor(changeTextHeight)),
    cursorStyleHandler: controlsUtils.scaleSkewCursorStyleHandler,
    actionName: FIX_HEIGHT_ACTION,
  })
}

/** A text proxy's card, or undefined for anything else. */
export const textDataOf = (obj: FabricObject | null | undefined): TextData | undefined => (obj ? proxyText.get(obj) : undefined)

/** Replaces what a text proxy's card shows (nothing for any other object). */
export function setTextData(obj: FabricObject, data: TextData) {
  if (proxyText.has(obj)) proxyText.set(obj, data)
}

/** An image proxy's picture data, or undefined for anything else. */
export const imageDataOf = (obj: FabricObject): ImageData | undefined => proxyImage.get(obj)

/** A text proxy, by identity. */
export const isText = (obj: FabricObject | null | undefined): boolean => !!obj && meta.get(obj)?.kind === 'text'

const naturalSizeOf = (el: HTMLImageElement): Size => ({ width: el.naturalWidth || el.width, height: el.naturalHeight || el.height })

/** A text record's card data, its formatting in canonical form. */
export function textDataFrom(rec: TextRecord): TextData {
  // Rich blocks are canonical already (as loading or the edit session left them), and replaced, never changed.
  const fmt = rec.blocks
    ? { ...canonicalTextFormatting('', { font: rec.font, align: rec.align, color: rec.color }), blocks: rec.blocks }
    : canonicalTextFormatting(rec.text, { font: rec.font, align: rec.align, color: rec.color, spans: rec.spans, headings: rec.headings })
  return {
    text: rec.text,
    fontSize: rec.fontSize,
    width: rec.width,
    ...(rec.minHeight !== undefined && { minHeight: rec.minHeight }),
    ...(rec.height !== undefined && { height: rec.height }),
    ...fmt,
    ...(rec.captionBackground && { captionBackground: rec.captionBackground }),
    ...(rec.surface === 'card' && { surface: 'card' as const }),
  }
}

/**
 * A transparent proxy for an image or a text record. An image
 * proxy is the size of its shown crop, scaled as stored; a text proxy is the stored width and
 * its fixed height (or the drawn minimum height) until the editor sizes it from the scene layer
 * (its effective width and measured height, which is the fixed height when it has one). Null for an image whose picture is not decoded.
 */
export function createProxy(rec: ObjectRecord, getImage: (assetId: string) => HTMLImageElement | undefined): FabricObject | null {
  if (rec.type === 'image') {
    const el = getImage(rec.assetId)
    if (!el) return null
    const natural = naturalSizeOf(el)
    const crop = clampCrop(rec.crop, natural)
    const proxy = new ProxyRect({
      ...SELECTION_STYLE,
      ...PROXY_STYLE,
      left: rec.left,
      top: rec.top,
      angle: rec.angle,
      scaleX: rec.scaleX,
      scaleY: rec.scaleY,
      width: crop?.width ?? natural.width,
      height: crop?.height ?? natural.height,
    })
    proxy.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false })
    meta.set(proxy, { id: rec.id, kind: 'image', assetId: rec.assetId, ...(rec.frameId !== undefined && { frameId: rec.frameId }), ...lockMeta(rec) })
    proxyImage.set(proxy, { natural, cropX: crop?.x ?? 0, cropY: crop?.y ?? 0 })
    applyLockFlags(proxy, 'image', rec.locked === true)
    return proxy
  }
  const proxy = new ProxyRect({ ...SELECTION_STYLE, ...PROXY_STYLE, left: rec.left, top: rec.top, angle: rec.angle, width: rec.width, height: rec.height ?? rec.minHeight ?? 0 })
  // A text box's handles: the sides change the wrap width (Fabric's `changeWidth`), the bottom one
  // fixes the height (`textHeightControl`), the corners scale.
  proxy.controls = { ...controlsUtils.createTextboxDefaultControls(), mb: textHeightControl() }
  proxy.setControlsVisibility({ mt: false })
  meta.set(proxy, { id: rec.id, kind: 'text', ...(rec.frameId !== undefined && { frameId: rec.frameId }), ...lockMeta(rec) })
  setCaption(proxy, rec.captionOf, rec.captionSide, rec.captionPosition)
  proxyText.set(proxy, textDataFrom(rec))
  applyLockFlags(proxy, 'text', rec.locked === true)
  return proxy
}

/** A frame's proxy: the frame's rectangle, painting nothing (the scene layer draws its paper). */
export function createFrameProxy(rec: FrameRecord): FabricObject {
  const rect = new ProxyRect({
    ...SELECTION_STYLE,
    ...PROXY_STYLE,
    padding: 0,
    left: rec.left,
    top: rec.top,
    width: rec.width,
    height: rec.height,
    lockRotation: true,
    lockSkewingX: true,
    lockSkewingY: true,
  })
  rect.setControlsVisibility({ mtr: false })
  meta.set(rect, { id: rec.id, kind: 'frame', name: rec.name, ...lockMeta(rec) })
  applyLockFlags(rect, 'frame', rec.locked === true)
  return rect
}

/** A text proxy's record, from its card data and its transform. */
function proxyTextRecord(td: TextData, m: Meta, base: { id: string; left: number; top: number; angle: number }, owner: { frameId?: string; locked?: true }, sx: number, sy: number): TextRecord {
  const s = (sx + sy) / 2
  const { font, align, color, spans, headings, blocks } = td
  const fontSize = roundPositive(td.fontSize * s, 2)
  // A scaled fixed height stays at least the least one for the scaled size (rounding can take it
  // just under); an unscaled one is the record's as it is, even below it (`innerText` draws it there).
  const height = td.height === undefined ? undefined : sx === 1 && sy === 1 ? td.height : heldFixedHeight(roundPositive(td.height * sy), fontSize, td.surface)
  return {
    ...base,
    type: 'text',
    text: td.text,
    fontSize,
    width: roundPositive(td.width * sx),
    ...(td.minHeight !== undefined && { minHeight: round(td.minHeight * sy) }),
    ...(height !== undefined && { height }),
    ...(font !== undefined && { font }),
    ...(align !== undefined && { align }),
    ...(color !== undefined && { color }),
    ...(spans !== undefined && { spans }),
    ...(headings !== undefined && { headings }),
    ...(blocks !== undefined && { blocks }),
    ...owner,
    ...(m.captionOf && {
      captionOf: m.captionOf,
      ...(m.captionSide && { captionSide: m.captionSide }),
      ...(m.captionPosition !== undefined && { captionPosition: m.captionPosition }),
    }),
    ...(td.captionBackground && { captionBackground: td.captionBackground }),
    ...(td.surface === 'card' && { surface: 'card' as const }),
  }
}

function rotate(x: number, y: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [x * c - y * s, x * s + y * c]
}

/**
 * The object's centre in scene coordinates, whether or not it is inside a multi-selection.
 * This is the point the ownership rules test against a frame, and it is the centre of the
 * object's box for every kind of object: for a text, the centre of its wrap box (its
 * width is the wrapping width, not the width of what is typed).
 */
export function centerOf(obj: FabricObject): Point {
  const d = util.qrDecompose(obj.calcTransformMatrix())
  return { x: d.translateX, y: d.translateY }
}

/**
 * Reads a content object's absolute state. Goes through the full transform matrix so
 * objects that are members of a multi-selection (whose own left/top are
 * relative to the selection) serialize to scene coordinates. Returns null for frames.
 *
 * Nothing is clamped here: a value is whatever the canvas shows. Quantities that must
 * be positive are rounded so that they can never become zero.
 */
/**
 * How far from 1 a decomposed scale may be and still be read as exactly 1. Taking a turned object's
 * matrix apart (`qrDecompose`, through a selection's matrix too) leaves a scale a few units in the
 * last place off 1 (0.9999999999999999 at 3° or 70°: about 1e-16, and below 1e-12 through any matrix
 * product here), which would read an unscaled object as scaled and change its record (a fixed height
 * held to its least one). A real scale cannot come that close: Fabric sets it from pointer
 * positions, and the least pointer step over the largest box on screen is still about 1e-7 of its
 * size. Anything a scale this small could change is rounded away in the record anyway.
 */
const UNIT_SCALE_TOLERANCE = 1e-9
const absoluteScale = (v: number) => {
  const a = Math.abs(v)
  return Math.abs(a - 1) < UNIT_SCALE_TOLERANCE ? 1 : a
}

/** An object's absolute scale (its own times its selection's), each read as exactly 1 within `UNIT_SCALE_TOLERANCE`. */
export function absoluteScaleOf(obj: FabricObject): { sx: number; sy: number } {
  const d = util.qrDecompose(obj.calcTransformMatrix())
  return { sx: absoluteScale(d.scaleX), sy: absoluteScale(d.scaleY) }
}

export function toRecord(obj: FabricObject): ObjectRecord | null {
  const m = meta.get(obj)
  if (!m || m.kind === 'frame') return null
  const d = util.qrDecompose(obj.calcTransformMatrix())
  // An object nothing scaled reads as scale 1 exactly, however it is turned: reading it gives back its record.
  const sx = absoluteScale(d.scaleX)
  const sy = absoluteScale(d.scaleY)
  // translateX/Y is the object's centre; convert to its (unrotated) top-left.
  const [ox, oy] = rotate((obj.width * sx) / 2, (obj.height * sy) / 2, d.angle)
  const base = { id: m.id, left: round(d.translateX - ox), top: round(d.translateY - oy), angle: round(d.angle) }
  const owner = { ...(m.frameId !== undefined && { frameId: m.frameId }), ...lockMeta(m) }
  const proxyTextData = proxyText.get(obj)
  if (proxyTextData) return proxyTextRecord(proxyTextData, m, base, owner, sx, sy)
  if (m.assetId === undefined) return null
  // A fresh object every time: snapshots never share a crop.
  const crop = proxyImage.has(obj) ? imageCropOf(obj) : undefined
  const rec: ImageRecord = {
    ...base,
    type: 'image',
    assetId: m.assetId,
    scaleX: roundPositive(sx, 5),
    scaleY: roundPositive(sy, 5),
    ...(crop && { crop }),
    ...owner,
  }
  return rec
}

/**
 * An image proxy, which stands in for the picture the scene layer draws (`imageSizeOf`,
 * `imageCropOf`, `shownCropOf`, `setImageCrop` and `setImageElement` read and change it).
 */
export const isImage = (obj: FabricObject | undefined | null): obj is FabricObject => !!obj && proxyImage.has(obj)

/** The original image's size in source pixels. */
export function imageSizeOf(img: FabricObject): Size {
  const proxy = proxyImage.get(img)
  return proxy ? { ...proxy.natural } : { width: img.width, height: img.height }
}

/**
 * The visible part of the original as it is stored (`storedCrop`: rounded, inside the image),
 * or undefined when that is the whole image. A fresh object.
 */
export function imageCropOf(img: FabricObject): CropRect | undefined {
  const proxy = proxyImage.get(img)
  return proxy ? storedCrop({ x: proxy.cropX, y: proxy.cropY, width: img.width, height: img.height }, proxy.natural) : undefined
}

/**
 * The part of the original an image shows right now, unrounded (crop mode starts from and
 * restores exactly this): from the image proxy's data and size.
 */
export function shownCropOf(img: FabricObject): CropRect {
  const proxy = proxyImage.get(img)
  return { x: proxy?.cropX ?? 0, y: proxy?.cropY ?? 0, width: img.width, height: img.height }
}

/** The plain text of a text proxy, or undefined for anything else. */
export const plainTextOf = (obj: FabricObject): string | undefined => proxyText.get(obj)?.text

/**
 * Replace image: the same object (identity, owner, lock, stacking) now shows another decoded
 * picture, whole and uncropped. The caller then crops and places it (see `replaceRecord`).
 */
export function setImageElement(img: FabricObject, assetId: string, el: HTMLImageElement) {
  const m = meta.get(img)
  if (!m || m.kind !== 'image' || !proxyImage.has(img)) return
  // A new data object tells the scene layer to draw the new picture.
  m.assetId = assetId
  const natural = naturalSizeOf(el)
  proxyImage.set(img, { natural, cropX: 0, cropY: 0 })
  img.set({ width: natural.width, height: natural.height })
  img.setCoords()
}

/**
 * Shows only `crop` of the original (undefined: all of it). Changes nothing else: the caller
 * places the image (see `model/crop.ts`) so that the kept pixels do not move.
 */
export function setImageCrop(img: FabricObject, crop: CropRect | undefined) {
  const proxy = proxyImage.get(img)
  if (!proxy) return
  const c = crop ?? { x: 0, y: 0, width: proxy.natural.width, height: proxy.natural.height }
  proxyImage.set(img, { ...proxy, cropX: c.x, cropY: c.y })
  img.set({ width: c.width, height: c.height })
  img.setCoords()
}

/** Reads a frame's absolute rectangle (any scale is folded into its size). Returns null for content. */
export function toFrameRecord(obj: FabricObject): FrameRecord | null {
  const m = meta.get(obj)
  if (!m || m.kind !== 'frame') return null
  const d = util.qrDecompose(obj.calcTransformMatrix())
  const width = obj.width * absoluteScale(d.scaleX)
  const height = obj.height * absoluteScale(d.scaleY)
  return {
    id: m.id,
    name: m.name ?? '',
    left: round(d.translateX - width / 2),
    top: round(d.translateY - height / 2),
    width: roundPositive(width),
    height: roundPositive(height),
    ...lockMeta(m),
  }
}

/** True when the object's absolute scale (its own times its selection's) is not 1. */
export function hasResidualScale(obj: FabricObject): boolean {
  const d = util.qrDecompose(obj.calcTransformMatrix())
  return Math.abs(Math.abs(d.scaleX) - 1) > 0.001 || Math.abs(Math.abs(d.scaleY) - 1) > 0.001
}
