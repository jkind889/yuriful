import { boardAppearance } from './appearance.ts'
import { canonicalTextFormatting } from './richText.ts'
import { DEFAULT_TITLE, DOC_VERSION } from './types.ts'
import type { BoardDoc, CropRect, FrameRecord, ObjectRecord, Scene, StoredDoc, Viewport } from './types.ts'

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

/** Allowlist parse: `frameId` is deliberately not read here (see the v2 path in parseDoc). */
function parseObject(raw: unknown): ObjectRecord | null {
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
    // Formatting is read leniently, like a dangling owner: whatever is malformed is dropped
    // or trimmed, and the text itself still loads.
    const height = isNum(minHeight) && minHeight >= 0 ? { minHeight } : {}
    return { type, id, left, top, angle, text, fontSize, width, ...height, ...canonicalTextFormatting(text, raw), ...lockOf(raw) }
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
 * Validates untrusted stored data (wire versions 1 and 2). Returns null when the shape
 * is wrong or the version is unknown; callers must not overwrite the stored value in
 * that case. Membership (`frameId`) is restored as stored and never recomputed.
 */
export function parseDoc(raw: unknown): BoardDoc | null {
  if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.objects)) return null
  const seen = new Set<string>()

  const frames: FrameRecord[] = []
  if (raw.version === 2) {
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
    const rec = parseObject(o)
    if (!rec || seen.has(rec.id)) return null
    seen.add(rec.id)
    // A dangling or malformed owner is dropped (the object becomes loose), not fatal.
    const owner = raw.version === 2 ? (o as Record<string, unknown>).frameId : undefined
    if (isStr(owner) && frameIds.has(owner)) rec.frameId = owner
    objects.push(rec)
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
  return out
}

/**
 * The document as it is written to storage. A board without frames is written in
 * exactly the milestone 1 shape (wire version 1), so only a board that really has a
 * frame needs the newer format. Optional fields (such as `locked`) are written by both
 * versions, and only when set: a key whose value is undefined is never stored.
 */
export function serializeDoc(doc: BoardDoc): StoredDoc {
  const appearance = boardAppearance(doc.appearance)
  if (doc.frames.length === 0) {
    return {
      version: 1,
      title: doc.title,
      objects: doc.objects.map((o) => {
        const rest = storable(o)
        delete rest.frameId // no frame exists, so there is nothing to own it
        return rest
      }),
      viewport: { ...doc.viewport },
      ...(appearance && { appearance }),
    }
  }
  return {
    version: 2,
    title: doc.title,
    frames: doc.frames.map((f) => storable(f)),
    objects: doc.objects.map((o) => storable(o)), // never stores an explicit undefined owner
    viewport: { ...doc.viewport },
    ...(appearance && { appearance }),
  }
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
 * `undefined` vs absent do not matter), arrays element by element. A text's spans and
 * headings are arrays, and two equal lists must not look like a change on every commit.
 */
function valuesEqual(x: unknown, y: unknown): boolean {
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
