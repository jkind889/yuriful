import { boardAppearance } from './appearance.ts'
import { canonicalHeight, canonicalSurface, canonicalTextContent, isReadableTextContent, needsRichFence } from './textDoc.ts'
import { DEFAULT_TITLE, DOC_VERSION } from './types.ts'
import type { BoardDoc, CropRect, FrameRecord, ObjectRecord, Scene, StoredDoc, TextRecord, Viewport } from './types.ts'

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 8
export const MIN_FONT_SIZE = 6
export const MAX_FONT_SIZE = 400
export const DEFAULT_FRAME_NAME = 'Frame'
const MAX_FRAME_NAME = 80

export const DEFAULT_VIEWPORT: Viewport = { zoom: 1, panX: 0, panY: 0 }

export function createEmptyDoc(): BoardDoc {
  return { version: DOC_VERSION, title: DEFAULT_TITLE, frames: [], objects: [], viewport: { ...DEFAULT_VIEWPORT } }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

/** `locked` is kept only when it is exactly `true`; anything else is dropped, not fatal. Both wire versions. */
const lockOf = (raw: Record<string, unknown>): { locked?: true } => (raw.locked === true ? { locked: true } : {})

export function captionBackground(value: unknown): string | undefined {
  return isStr(value) && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined
}

type CaptionFields = Pick<TextRecord, 'captionOf' | 'captionSide' | 'captionPosition' | 'captionBackground'>

function captionFields(raw: Partial<Record<keyof CaptionFields, unknown>>): CaptionFields {
  const background = captionBackground(raw.captionBackground)
  const style = background ? { captionBackground: background } : {}
  const captionOf = isStr(raw.captionOf) ? raw.captionOf : ''
  if (!captionOf) return style
  const side = raw.captionSide
  const position = raw.captionPosition
  return {
    ...style,
    captionOf,
    ...((side === 'top' || side === 'left' || side === 'right') && { captionSide: side }),
    ...(isNum(position) && position >= 0 && position <= 1 && { captionPosition: position }),
  }
}

/**
 * An image's `crop`, kept only when it is an object of finite numbers with `x >= 0`,
 * `y >= 0`, `width > 0` and `height > 0`; anything else is dropped (the image is shown
 * whole), not fatal. Both wire versions. Whether it lies inside the image is only known
 * once the image is decoded (see `clampCrop`).
 */
const cropOf = (raw: Record<string, unknown>): { crop?: CropRect } => {
  const c = raw.crop
  if (!isRecord(c)) return {}
  const { x, y, width, height } = c
  if (!isNum(x) || !isNum(y) || !isNum(width) || !isNum(height) || x < 0 || y < 0 || width <= 0 || height <= 0) return {}
  return { crop: { x, y, width, height } }
}

/**
 * How a document is read. `load` builds canonical records. `check` runs exactly the same
 * walk and the same strict checks, but skips building what is read leniently and so can never
 * refuse a document (a compact text's spans and headings): it answers "would `load` refuse
 * this?" cheaply, and only through the very code `load` uses.
 */
type Reading = 'load' | 'check'

/** Allowlist parse: `frameId` is deliberately not read here (see the v2 path in parseDoc). */
function parseObject(raw: unknown, reading: Reading = 'load'): ObjectRecord | null {
  if (!isRecord(raw)) return null
  const { id, type, left, top, angle } = raw
  if (!isStr(id) || id === '' || !isNum(left) || !isNum(top) || !isNum(angle)) return null
  if (type === 'image') {
    const { assetId, scaleX, scaleY } = raw
    if (!isStr(assetId) || !isNum(scaleX) || !isNum(scaleY) || scaleX === 0 || scaleY === 0) return null
    return { type, id, left, top, angle, assetId, scaleX, scaleY, ...cropOf(raw), ...lockOf(raw) }
  }
  if (type === 'text') {
    const { text, fontSize, width, minHeight } = raw
    if (!isStr(text) || !isNum(fontSize) || !isNum(width) || fontSize <= 0 || width <= 0) return null
    if (reading === 'check') return isReadableTextContent(raw) ? { type, id, left, top, angle, text, fontSize, width } : null
    // Formatting is read leniently, like a dangling owner: whatever is malformed is dropped
    // or trimmed, and the text itself still loads. Rich `blocks` are the exception: a tree
    // this build cannot read in full makes the board unreadable rather than losing part of it.
    const content = canonicalTextContent(raw)
    if (!content) return null
    const { text: words, ...formatting } = content
    const floor = isNum(minHeight) && minHeight >= 0 ? { minHeight } : {}
    return {
      type,
      id,
      left,
      top,
      angle,
      text: words,
      fontSize,
      width,
      ...floor,
      ...canonicalHeight(raw.height),
      ...formatting,
      ...canonicalSurface(raw.surface),
      ...lockOf(raw),
      ...captionFields(raw),
    }
  }
  return null
}

function parseFrame(raw: unknown): FrameRecord | null {
  if (!isRecord(raw)) return null
  const { id, name, left, top, width, height } = raw
  if (!isStr(id) || id === '' || !isStr(name)) return null
  if (!isNum(left) || !isNum(top) || !isNum(width) || !isNum(height) || width <= 0 || height <= 0) return null
  // Like a blank title: a blank name falls back instead of making the board unreadable.
  return { id, name: name.trim() === '' ? DEFAULT_FRAME_NAME : name, left, top, width, height, ...lockOf(raw) }
}

/**
 * Validates untrusted stored data (wire versions 1, 2 and 3). Returns null when the shape
 * is wrong or the version is unknown; callers must not overwrite the stored value in
 * that case. Membership (`frameId`) is restored as stored and never recomputed.
 */
export function parseDoc(raw: unknown): BoardDoc | null {
  return readDoc(raw, 'load')
}

/**
 * True exactly when `parseDoc` would read `raw`, at the cost of only what can make it refuse:
 * the structure, ids and geometry, frames, and rich `blocks`. A compact text's formatting is
 * never canonicalized here. The store checks every document with it before writing.
 */
export function isLoadableDoc(raw: unknown): boolean {
  return readDoc(raw, 'check') !== null
}

function readDoc(raw: unknown, reading: Reading): BoardDoc | null {
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) || !Array.isArray(raw.objects)) return null
  const seen = new Set<string>()
  const hasFrames = raw.version !== 1

  const frames: FrameRecord[] = []
  if (hasFrames) {
    if (!Array.isArray(raw.frames)) return null
    for (const f of raw.frames) {
      const frame = parseFrame(f)
      if (!frame || seen.has(frame.id)) return null
      seen.add(frame.id)
      frames.push(frame)
    }
  }
  const frameIds = new Set(seen)

  const objects: ObjectRecord[] = []
  for (const o of raw.objects) {
    const rec = parseObject(o, reading)
    if (!rec || seen.has(rec.id)) return null
    seen.add(rec.id)
    // A dangling or malformed owner is dropped (the object becomes loose), not fatal.
    const owner = hasFrames ? (o as Record<string, unknown>).frameId : undefined
    if (isStr(owner) && frameIds.has(owner)) rec.frameId = owner
    objects.push(rec)
  }

  // Resolve after reading all objects: the image can be above or below the caption.
  const unclaimedImages = new Set(objects.flatMap((o) => o.type === 'image' ? [o.id] : []))
  for (const rec of objects) {
    if (rec.type === 'text' && rec.captionOf && !unclaimedImages.delete(rec.captionOf)) {
      delete rec.captionOf
      delete rec.captionSide
      delete rec.captionPosition
    }
  }

  const title = isStr(raw.title) && raw.title.trim() !== '' ? raw.title : DEFAULT_TITLE
  let viewport = { ...DEFAULT_VIEWPORT }
  if (isRecord(raw.viewport)) {
    const { zoom, panX, panY } = raw.viewport
    if (isNum(zoom) && isNum(panX) && isNum(panY) && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM) {
      viewport = { zoom, panX, panY }
    }
  }
  const appearance = boardAppearance(raw.appearance)
  return { version: DOC_VERSION, title, frames, objects, viewport, ...(appearance && { appearance }) }
}

/**
 * A copy without keys whose value is `undefined`, with `locked` only when it is `true`, and
 * with a fresh copy of an image's `crop` (never a reference shared with the live document).
 */
function storable<T extends ObjectRecord | FrameRecord>(rec: T): T {
  const out = { ...rec }
  for (const k of Object.keys(out) as Array<keyof T>) if (out[k] === undefined) delete out[k]
  if (out.locked !== true) delete out.locked // never store `locked: false`
  if ('crop' in out && out.crop) out.crop = { ...out.crop }
  if ('spans' in out && out.spans) out.spans = out.spans.map((span) => ({ ...span }))
  if ('headings' in out && out.headings) out.headings = [...out.headings]
  if ('type' in out && out.type === 'text') {
    const caption = captionFields(out)
    if (!caption.captionOf) delete out.captionOf
    if (!caption.captionSide) delete out.captionSide
    if (caption.captionPosition === undefined) delete out.captionPosition
    if (!caption.captionBackground) delete out.captionBackground
    Object.assign(out, caption)
  }
  return out
}

/**
 * A record as it is written. A text with a rich field (`blocks`, `height` or `surface`) goes
 * through the very canonicalization `parseDoc` applies, so its content is written exactly as a
 * load gives it back: blocks that only hold paragraphs and headings are written in the compact
 * form, `text` is their projection, and an invalid `height` or `surface` is left out. The
 * bounded parser builds a fresh tree, so blocks are never copied before they are validated. A
 * text whose rich content cannot be read back (malformed, over the bounds, or not a tree at all)
 * is returned uncopied, still sharing its blocks, so that the store's check refuses to write it.
 */
function writable(rec: ObjectRecord): ObjectRecord {
  const out = storable(rec)
  if (out.type !== 'text' || (out.blocks === undefined && out.height === undefined && out.surface === undefined)) return out
  const canonical = parseObject(out)
  if (!canonical) return out
  if (out.frameId !== undefined) canonical.frameId = out.frameId
  return canonical
}

/**
 * The document as it is written to storage. A board with a text that uses `blocks`,
 * `height` or `surface` (after canonicalization: see `writable`) is written as wire
 * version 3, which builds that do not know those fields cannot open; `frames` is then always
 * present, even when empty. Otherwise a board without frames is written in exactly the
 * milestone 1 shape (wire version 1), so only a board that really has a frame needs version 2.
 * Optional fields (such as `locked`) are written by every version, and only when set: a key
 * whose value is undefined is never stored.
 */
export function serializeDoc(doc: BoardDoc): StoredDoc {
  const appearance = boardAppearance(doc.appearance)
  const objects = doc.objects.map(writable) // never stores an explicit undefined owner
  const framed = doc.frames.length > 0
  if (!framed) for (const o of objects) delete o.frameId // no frame exists, so there is nothing to own it
  const meta = { title: doc.title }
  const tail = { viewport: { ...doc.viewport }, ...(appearance && { appearance }) }
  if (needsRichFence({ objects })) return { version: 3, ...meta, frames: doc.frames.map((f) => storable(f)), objects, ...tail }
  if (!framed) return { version: 1, ...meta, objects, ...tail }
  return { version: 2, ...meta, frames: doc.frames.map((f) => storable(f)), objects, ...tail }
}

export function referencedAssetIds(objects: readonly ObjectRecord[]): Set<string> {
  const ids = new Set<string>()
  for (const o of objects) if (o.type === 'image') ids.add(o.assetId)
  return ids
}

export function objectsEqual(a: readonly ObjectRecord[], b: readonly ObjectRecord[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Structural equality of record values: plain objects field by field (key order and
 * `undefined` vs absent do not matter), arrays element by element. A text's spans, headings and
 * blocks are nested values, and two equal ones must not look like a change on every commit.
 */
export function valuesEqual(x: unknown, y: unknown): boolean {
  if (x === y) return true
  // NaN equals NaN here, so a broken number can never look like an endless stream of changes.
  if (Number.isNaN(x) && Number.isNaN(y)) return true
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false
    return x.every((v, i) => valuesEqual(v, y[i]))
  }
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false
  const a = x as Record<string, unknown>
  const b = y as Record<string, unknown>
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!valuesEqual(a[k], b[k])) return false
  return true
}

function recordsEqual(a: readonly object[], b: readonly object[]): boolean {
  return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]))
}

/** Structural equality of everything on the canvas, including z-order and ownership. */
export function sceneEqual(a: Scene, b: Scene): boolean {
  return recordsEqual(a.frames, b.frames) && recordsEqual(a.objects, b.objects)
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits
  const scaled = n * f
  // A finite value too large to scale (e.g. 1e307) is returned as it is: it has no decimals to
  // round, and Infinity would make the stored document unreadable.
  if (!Number.isFinite(scaled)) return n
  const r = Math.round(scaled) / f
  return Object.is(r, -0) ? 0 : r
}

/**
 * Rounding for quantities that must stay positive (scales, widths, heights, font
 * sizes). Ordinary values round exactly like `round`; a positive value that would
 * round to zero keeps six significant digits instead, because a stored zero makes the
 * whole document unreadable.
 */
export function roundPositive(n: number, digits = 2): number {
  const r = round(n, digits)
  if (r > 0 || !(n > 0)) return r
  return Number(n.toPrecision(6))
}

export function normalizeTitle(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t === '' ? DEFAULT_TITLE : t.slice(0, 120)
}

export function normalizeFrameName(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t === '' ? DEFAULT_FRAME_NAME : t.slice(0, MAX_FRAME_NAME)
}
