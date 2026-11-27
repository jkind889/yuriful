import { describe, expect, it, vi } from 'vitest'
import { Textbox } from 'fabric'
import { fillRecord, fitRecord, replaceRecord, storedCrop } from '../model/crop.ts'
import { parseDoc, serializeDoc, createEmptyDoc } from '../model/doc.ts'
import type { FrameRecord, ImageRecord, TextRecord } from '../model/types.ts'
import { FONT_STACKS } from './fonts.ts'
import {
  TEXT_COLOR,
  centerOf,
  createFrame,
  createObject,
  frameNameOf,
  idOf,
  imageSizeOf,
  isFrame,
  isLocked,
  normalizeTextScale,
  ownerOf,
  readTextFormatting,
  reconcileTextFormatting,
  setFrameName,
  setImageCrop,
  setLocked,
  setOwner,
  setTextFontSize,
  toFrameRecord,
  toRecord,
} from './objects.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

type Loose = { scaleX: number; scaleY: number; left: number; top: number; width: number; height: number; fontSize: number }
const loose = (o: unknown) => o as Loose

const el = { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement
const image = (patch: Partial<ImageRecord> = {}): ImageRecord => ({ type: 'image', id: 'i1', left: 5, top: 6, angle: 0, assetId: 'a1', scaleX: 0.5, scaleY: 0.5, ...patch })
const text = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 't1', left: 1, top: 2, angle: 0, text: 'hi', fontSize: 24, width: 200, ...patch })
const frame: FrameRecord = { id: 'f1', name: 'Cover', left: -10, top: -20, width: 640, height: 480 }
const make = (rec: ImageRecord | TextRecord) => createObject(rec, () => el)!

describe('records round-trip through canvas objects', () => {
  it('content keeps its geometry and, when it has one, its owner', () => {
    expect(toRecord(make(image()))).toEqual(image())
    expect(toRecord(make(text()))).toEqual(text())
    expect(toRecord(make(image({ frameId: 'f1' })))).toEqual(image({ frameId: 'f1' }))
    expect(toRecord(make(text({ frameId: 'f1' })))).toEqual(text({ frameId: 'f1' }))
  })

  it('a loose object has no frameId key at all', () => {
    expect(toRecord(make(image()))).not.toHaveProperty('frameId')
    expect(ownerOf(make(text()))).toBeUndefined()
  })

  it('frames keep their id, name and rectangle, and are told apart from content', () => {
    const obj = createFrame(frame)
    expect(toFrameRecord(obj)).toEqual(frame)
    expect(isFrame(obj)).toBe(true)
    expect(idOf(obj)).toBe('f1')
    expect(frameNameOf(obj)).toBe('Cover')
    expect(toRecord(obj)).toBeNull() // a frame is never content
    expect(toFrameRecord(make(image()))).toBeNull()
    expect(isFrame(make(text()))).toBe(false)
  })

  it('a frame scale is folded into its size (frames are stored at scale 1)', () => {
    const obj = createFrame(frame)
    Object.assign(loose(obj), { scaleX: 0.5, scaleY: 2 })
    expect(toFrameRecord(obj)).toEqual({ ...frame, width: 320, height: 960 })
  })

  it('owner and name can be changed without touching anything else', () => {
    const img = make(image())
    setOwner(img, 'f9')
    expect(toRecord(img)).toEqual(image({ frameId: 'f9' }))
    setOwner(img, undefined)
    expect(toRecord(img)).toEqual(image())
    expect(toRecord(img)).not.toHaveProperty('frameId')

    const f = createFrame(frame)
    setFrameName(f, 'Back')
    expect(toFrameRecord(f)?.name).toBe('Back')
    setOwner(f, 'f2') // frames are never owned
    expect(ownerOf(f)).toBeUndefined()
    setFrameName(img, 'nope') // content has no name
    expect(frameNameOf(img)).toBeUndefined()
  })

  it('reports the scene-space centre', () => {
    expect(centerOf(make(image({ left: 100, top: 50, scaleX: 1, scaleY: 1 })))).toEqual({ x: 200, y: 100 })
    expect(centerOf(createFrame(frame))).toEqual({ x: 310, y: 220 })
  })
})

describe('no legacy clamp in the transform and serialization path', () => {
  it('folding a 500px text at 0.95 yields 475 and width x 0.95', () => {
    const tb = make(text({ fontSize: 500, width: 1000 }))
    Object.assign(loose(tb), { scaleX: 0.95, scaleY: 0.95 })
    expect(normalizeTextScale(tb as never)).toBe(true)
    expect(loose(tb)).toMatchObject({ fontSize: 475, width: 950, scaleX: 1, scaleY: 1 })
  })

  it('folding never pulls an out-of-range font size back into range', () => {
    const big = make(text({ fontSize: 500, width: 1000 }))
    Object.assign(loose(big), { scaleX: 1.2, scaleY: 1.2 })
    normalizeTextScale(big as never)
    expect(loose(big).fontSize).toBe(600)

    const tiny = make(text({ fontSize: 8, width: 100 }))
    Object.assign(loose(tiny), { scaleX: 0.25, scaleY: 0.25 })
    normalizeTextScale(tiny as never)
    expect(loose(tiny).fontSize).toBe(2)
  })

  it('toRecord of a 500px text returns 500, and of a 2px text returns 2', () => {
    expect((toRecord(make(text({ fontSize: 500 }))) as TextRecord).fontSize).toBe(500)
    expect((toRecord(make(text({ fontSize: 2 }))) as TextRecord).fontSize).toBe(2)
  })

  it('toRecord reports an unfolded scale as the font size it shows, unclamped', () => {
    const tb = make(text({ fontSize: 300, width: 600 }))
    Object.assign(loose(tb), { scaleX: 2, scaleY: 2 })
    expect(toRecord(tb)).toMatchObject({ fontSize: 600, width: 1200 })
  })

  it('leaves a text without residual scale alone', () => {
    const tb = make(text())
    expect(normalizeTextScale(tb as never)).toBe(false)
    expect(loose(tb)).toMatchObject({ fontSize: 24, width: 200 })
  })
})

describe('positive values survive serialization', () => {
  it('a tiny image scale is stored as a positive number that the document parser accepts', () => {
    const img = make(image({ scaleX: 0.00001, scaleY: 0.00001 }))
    Object.assign(loose(img), { scaleX: 0.00001 * 0.4, scaleY: 0.00001 * 0.4 })
    const rec = toRecord(img) as ImageRecord
    expect(rec.scaleX).toBe(0.000004) // plain 5-decimal rounding would have stored 0
    expect(rec.scaleY).toBe(0.000004)
    const doc = { ...createEmptyDoc(), objects: [rec] }
    expect(parseDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))).toEqual(doc)
  })

  it('tiny text and frame sizes stay positive too', () => {
    const tb = make(text({ fontSize: 0.001, width: 0.001 }))
    const rec = toRecord(tb) as TextRecord
    expect(rec.fontSize).toBeGreaterThan(0)
    expect(rec.width).toBeGreaterThan(0)
    const f = createFrame({ ...frame, width: 0.0001, height: 0.0001 })
    expect(toFrameRecord(f)!.width).toBeGreaterThan(0)
    expect(toFrameRecord(f)!.height).toBeGreaterThan(0)
  })

  it('ordinary values serialize exactly as before', () => {
    const img = make(image({ scaleX: 0.123456789, scaleY: 0.123456789, left: 1.005, top: 2.004 }))
    expect(toRecord(img)).toMatchObject({ scaleX: 0.12346, scaleY: 0.12346 })
  })
})

describe('locking', () => {
  type Flags = Record<string, unknown>
  const flags = (o: unknown) => {
    const f = o as Flags
    const keys = ['evented', 'selectable', 'hasControls', 'lockMovementX', 'lockMovementY', 'lockScalingX', 'lockScalingY', 'lockRotation', 'editable']
    return Object.fromEntries(keys.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]))
  }
  const LOCKED = { evented: false, selectable: false, hasControls: false, lockMovementX: true, lockMovementY: true, lockScalingX: true, lockScalingY: true, lockRotation: true }
  const OPEN = { evented: true, selectable: true, hasControls: true, lockMovementX: false, lockMovementY: false, lockScalingX: false, lockScalingY: false }

  it('a locked record creates a locked object (not a target, not selectable, no handles, nothing movable, text not editable), and back', () => {
    const img = make(image({ locked: true }))
    expect(isLocked(img)).toBe(true)
    expect(flags(img)).toEqual(LOCKED)
    const tb = make(text({ locked: true }))
    expect(flags(tb)).toEqual({ ...LOCKED, editable: false })
    const fr = createFrame({ ...frame, locked: true })
    expect(flags(fr)).toEqual(LOCKED)
    expect(toRecord(img)).toEqual(image({ locked: true }))
    expect(toRecord(tb)).toEqual(text({ locked: true }))
    expect(toFrameRecord(fr)).toEqual({ ...frame, locked: true })
  })

  it('unlocking restores exactly what creation sets, including a frame’s rotation lock; locking again matches a locked record', () => {
    const kinds = [(locked?: true) => make(image({ locked })), (locked?: true) => make(text({ locked })), (locked?: true) => createFrame({ ...frame, locked })]
    for (const build of kinds) {
      const wasLocked = build(true)
      setLocked(wasLocked, false)
      expect(isLocked(wasLocked)).toBe(false)
      expect(flags(wasLocked)).toEqual(flags(build()))
      const wasOpen = build()
      setLocked(wasOpen, true)
      expect(isLocked(wasOpen)).toBe(true)
      expect(flags(wasOpen)).toEqual(flags(build(true)))
    }
    expect(flags(createFrame(frame))).toEqual({ ...OPEN, lockRotation: true })
    expect(flags(make(image()))).toEqual({ ...OPEN, lockRotation: false })
    expect(flags(make(text()))).toEqual({ ...OPEN, lockRotation: false, editable: true })
  })

  it('an unlocked object has no locked key at all; locking changes nothing else in its record', () => {
    const img = make(image({ frameId: 'f1' }))
    expect(toRecord(img)).not.toHaveProperty('locked')
    expect(toFrameRecord(createFrame(frame))).not.toHaveProperty('locked')
    setLocked(img, true)
    expect(toRecord(img)).toEqual(image({ frameId: 'f1', locked: true }))
    setLocked(img, false)
    expect(toRecord(img)).toEqual(image({ frameId: 'f1' }))
    expect(Object.keys(toRecord(img)!)).not.toContain('locked')
  })

  it('a locked record survives the stored document both ways', () => {
    const doc = { ...createEmptyDoc(), objects: [toRecord(make(image({ locked: true })))!] }
    expect(parseDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))?.objects[0]).toEqual(image({ locked: true }))
  })
})

describe('cropped images', () => {
  // The fake element is 200x100 source pixels.
  const crop = { x: 20, y: 10, width: 100, height: 60 }

  it('a crop round-trips: Fabric shows only that part, and the record keeps it', () => {
    const img = make(image({ crop }))
    expect(img).toMatchObject({ cropX: 20, cropY: 10, width: 100, height: 60 })
    expect(toRecord(img)).toEqual(image({ crop }))
  })

  it('left/top are the displayed box: the centre is the centre of the cropped box', () => {
    const img = make(image({ crop, left: 0, top: 0, scaleX: 2, scaleY: 2 }))
    expect(centerOf(img)).toEqual({ x: 100, y: 60 })
  })

  it('emits a fresh crop object every time, never shared between snapshots', () => {
    const rec = image({ crop })
    const img = make(rec)
    const a = toRecord(img) as ImageRecord
    const b = toRecord(img) as ImageRecord
    expect(a.crop).toEqual(b.crop)
    expect(a.crop).not.toBe(b.crop)
    expect(a.crop).not.toBe(rec.crop)
  })

  it('an uncropped image, or a crop equal to the whole image, has no crop key', () => {
    expect(toRecord(make(image()))).not.toHaveProperty('crop')
    const whole = make(image({ crop: { x: 0, y: 0, width: 200, height: 100 } }))
    expect(toRecord(whole)).not.toHaveProperty('crop')
    expect(toRecord(whole)).toEqual(image())
  })

  it('reads the crop from Fabric with its edges rounded to the stored step (the side follows the rounded edges)', () => {
    const img = make(image())
    Object.assign(img, { cropX: 1.23456, cropY: 0.5, width: 50.004999, height: 20 })
    // Edges 1.23456 -> 1.23 and 51.239559 -> 51.24, so the side is 50.01 (not the side rounded on its own).
    expect((toRecord(img) as ImageRecord).crop).toEqual({ x: 1.23, y: 0.5, width: 50.01, height: 20 })
  })

  it('a stored crop reaching outside the decoded image is clamped to it (C5); nothing left shows the image whole', () => {
    const clamped = make(image({ crop: { x: 150, y: 50, width: 400, height: 400 } }))
    expect(clamped).toMatchObject({ cropX: 150, cropY: 50, width: 50, height: 50 })
    expect((toRecord(clamped) as ImageRecord).crop).toEqual({ x: 150, y: 50, width: 50, height: 50 })
    const outside = make(image({ crop: { x: 500, y: 500, width: 10, height: 10 } }))
    expect(outside).toMatchObject({ cropX: 0, cropY: 0, width: 200, height: 100 })
    expect(toRecord(outside)).toEqual(image()) // same top-left and scale, shown whole
  })

  it('setImageCrop changes only what is shown; undefined shows the whole image', () => {
    const img = make(image({ crop }))
    setImageCrop(img as never, { x: 0, y: 0, width: 50, height: 50 })
    expect(toRecord(img)).toEqual(image({ crop: { x: 0, y: 0, width: 50, height: 50 } }))
    setImageCrop(img as never, undefined)
    expect(toRecord(img)).toEqual(image())
    expect(imageSizeOf(img as never)).toEqual({ width: 200, height: 100 })
  })

  it('survives a full save and load', () => {
    const doc = { ...createEmptyDoc(), objects: [toRecord(make(image({ crop })))!] }
    const loaded = parseDoc(JSON.parse(JSON.stringify(serializeDoc(doc))))
    expect(loaded?.objects).toEqual([image({ crop })])
  })
})

describe('record -> Fabric -> record identity for what Fill, Fit and Replace produce', () => {
  /** Seeded (mulberry32), so a failure can be reproduced. */
  function rng(seed: number) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const TINY = [
    { width: 10, height: 100 },
    { width: 3, height: 3850 },
    { width: 1, height: 1 },
    { width: 3850, height: 3 },
  ]
  const elOf = (s: { width: number; height: number }) => ({ naturalWidth: s.width, naturalHeight: s.height }) as HTMLImageElement
  // The fake has no rotation, so these records are unrotated; rotated round trips are proven by the e2e reload tests.
  function cases(seed: number, n: number) {
    const r = rng(seed)
    const out: Array<{ rec: ImageRecord; size: { width: number; height: number }; next: { width: number; height: number } }> = []
    const anySize = () => (r() < 0.3 ? TINY[Math.floor(r() * TINY.length)]! : { width: Math.max(1, Math.round(Math.exp(r() * Math.log(9000)))), height: Math.max(1, Math.round(Math.exp(r() * Math.log(9000)))) })
    for (let i = 0; i < n; i++) {
      const size = anySize()
      const s = Math.max(0.00001, Math.round(Math.exp((r() * 2 - 1) * Math.log(200)) * 1e5) / 1e5)
      const rec = image({ left: Math.round((r() * 2 - 1) * 5e5) / 100, top: Math.round((r() * 2 - 1) * 5e5) / 100, scaleX: s, scaleY: r() < 0.5 ? s : Math.max(0.00001, Math.round(s * (0.2 + r() * 5) * 1e5) / 1e5) })
      if (r() < 0.5) {
        const crop = storedCrop({ x: r() * size.width * 0.5, y: r() * size.height * 0.5, width: r() * size.width * 0.5 + 0.001, height: r() * size.height * 0.5 + 0.001 }, size)
        if (crop) rec.crop = crop
      }
      out.push({ rec, size, next: anySize() })
    }
    // Astra's case: a 10 x 100 source at scales 99.8 x 100 (a 998-unit-wide box).
    out.push({ rec: image({ left: 0, top: 0, scaleX: 99.8, scaleY: 100 }), size: { width: 10, height: 100 }, next: { width: 10, height: 100 } })
    return out
  }
  const roundTrip = (rec: ImageRecord, size: { width: number; height: number }) => toRecord(createObject(rec, () => elOf(size))!)

  it('Fill, Fit and Replace results come back from the canvas exactly as they were computed (3000 records each)', () => {
    for (const { rec, size, next } of cases(5, 3000)) {
      const filled = fillRecord(rec, size)
      expect(roundTrip(filled, size)).toEqual(filled)
      const fitted = fitRecord(rec, size)
      expect(roundTrip(fitted, size)).toEqual(fitted)
      const replaced = replaceRecord(rec, size, 'a1', next)
      expect(roundTrip(replaced, next)).toEqual(replaced)
    }
  })

  it("Astra's case: Fill of a 10 x 100 image at 99.8 x 100 keeps its centred crop through the canvas, and the box stays 998 wide", () => {
    const size = { width: 10, height: 100 }
    const filled = fillRecord(image({ left: 0, top: 0, scaleX: 99.8, scaleY: 100 }), size)
    expect(filled.crop).toEqual({ x: 0.01, y: 0, width: 9.98, height: 100 })
    const back = roundTrip(filled, size) as ImageRecord
    expect(back.crop).toEqual({ x: 0.01, y: 0, width: 9.98, height: 100 })
    expect(back.crop!.width * back.scaleX).toBeCloseTo(998, 6)
  })
})


describe('formatted text on the canvas', () => {
  type Styles = Record<number, Record<number, Record<string, unknown>>>
  type Tb = Loose & { styles: Styles; fontFamily: string; textAlign: string; fill: unknown; text: string }
  const tbOf = (o: unknown) => o as Tb
  const PLAIN_KEYS = ['id', 'left', 'top', 'angle', 'type', 'text', 'fontSize', 'width']

  it('a plain text is drawn as before and reads back with exactly the old keys', () => {
    const tb = tbOf(make(text()))
    expect(tb.fontFamily).toBe(FONT_STACKS.sans)
    expect(tb.fill).toBe(TEXT_COLOR)
    expect(tb.textAlign).toBe('left')
    expect(tb.styles).toEqual({})
    expect(Object.keys(toRecord(tb as never)!)).toEqual(PLAIN_KEYS)
    expect(Object.keys(toRecord(make(text({ frameId: 'f1' })))!)).toEqual([...PLAIN_KEYS, 'frameId'])
  })

  it('font, alignment and colour round-trip; defaults read back as no key', () => {
    for (const font of ['serif', 'mono', 'hand', 'display'] as const) expect(toRecord(make(text({ font })))).toEqual(text({ font }))
    expect(tbOf(make(text({ font: 'mono' }))).fontFamily).toBe(FONT_STACKS.mono)
    expect(toRecord(make(text({ align: 'center' })))).toEqual(text({ align: 'center' }))
    expect(toRecord(make(text({ align: 'right' })))).toEqual(text({ align: 'right' }))
    expect(tbOf(make(text({ color: '#c0392b' }))).fill).toBe('#c0392b')
    expect(toRecord(make(text({ color: '#c0392b' })))).toEqual(text({ color: '#c0392b' }))
    const odd = tbOf(make(text()))
    Object.assign(odd, { fontFamily: 'Papyrus', textAlign: 'justify', fill: 'rgb(1,2,3)' }) // nothing the app writes
    expect(Object.keys(toRecord(odd as never)!)).toEqual(PLAIN_KEYS)
  })

  it('marks become per-character styles and read back exactly, including after an emoji', () => {
    // "😀 bold it": the emoji is code units 0..2 but ONE character on the canvas.
    const rec = text({ text: '😀 bold it', spans: [{ start: 3, end: 7, bold: true, underline: true }, { start: 8, end: 10, italic: true, strike: true }] })
    const tb = tbOf(make(rec))
    const b = { fontWeight: 'bold', underline: true }
    const i = { fontStyle: 'italic', linethrough: true }
    expect(tb.styles).toEqual({ 0: { 2: b, 3: b, 4: b, 5: b, 7: i, 8: i } })
    expect(toRecord(tb as never)).toEqual(rec)
  })

  it('a span across a line break is keyed by paragraph, not by offset', () => {
    const rec = text({ text: 'ab\ncd', spans: [{ start: 1, end: 4, italic: true }] })
    const tb = tbOf(make(rec))
    expect(tb.styles).toEqual({ 0: { 1: { fontStyle: 'italic' } }, 1: { 0: { fontStyle: 'italic' } } })
    expect(toRecord(tb as never)).toEqual(rec)
  })

  it('headings: every character of the line, and a placeholder on an empty heading line, at the heading size and bold', () => {
    const rec = text({ text: 'Hi\n\nbody\nSub', headings: [1, 2, 0, 3], spans: [{ start: 4, end: 8, italic: true }] })
    const tb = tbOf(make(rec))
    const h = (size: number) => ({ fontSize: size, fontWeight: 'bold' })
    const ital = { fontStyle: 'italic' }
    expect(tb.styles).toEqual({
      0: { 0: h(48), 1: h(48) },
      1: { 0: h(36) }, // the empty line: Fabric takes its height, and the first typed character's style, from here
      2: { 0: ital, 1: ital, 2: ital, 3: ital },
      3: { 0: h(30), 1: h(30), 2: h(30) },
    })
    expect(toRecord(tb as never)).toEqual(rec)
  })

  it('an empty heading line at the end and a heading only on a later paragraph round-trip', () => {
    for (const rec of [text({ text: 'a\n', headings: [0, 1] }), text({ text: 'a\nb\nc', headings: [0, 0, 2] })]) {
      expect(toRecord(make(rec))).toEqual(rec)
    }
  })

  it('a line is a heading only at exactly its heading size (the app writes no other), not at a size a hair off it', () => {
    const tb = tbOf(make(text({ text: 'ab\ncd' })))
    tb.styles = { 0: { 0: { fontSize: 48.01, fontWeight: 'bold' } }, 1: { 0: { fontSize: 29.99, fontWeight: 'bold' } } }
    expect(toRecord(tb as never)).toEqual(text({ text: 'ab\ncd', spans: [{ start: 0, end: 1, bold: true }, { start: 3, end: 4, bold: true }] }))
  })

  it('a font-size style that matches no heading level is not a heading; bold in a heading line is implied', () => {
    const tb = tbOf(make(text({ text: 'ab\ncd' })))
    const h1 = { fontSize: 48, fontWeight: 'bold' }
    tb.styles = { 0: { 0: { fontSize: 40 }, 1: { fontSize: 40 } }, 1: { 0: h1, 1: h1 } }
    expect(toRecord(tb as never)).toEqual(text({ text: 'ab\ncd', headings: [0, 1] }))
  })

  it('folding a scale and setting the font size redraw headings at their ratio and keep the record', () => {
    const rec = text({ text: 'Big\nsmall', headings: [2], spans: [{ start: 4, end: 9, bold: true }] })
    const tb = tbOf(make(rec))
    Object.assign(tb, { scaleX: 1.5, scaleY: 1.5 })
    expect(toRecord(tb as never)).toEqual({ ...rec, fontSize: 36, width: 300 }) // mid-gesture: read at the scale shown
    normalizeTextScale(tb as never)
    expect(tb.fontSize).toBe(36)
    const h2 = { fontSize: 54, fontWeight: 'bold' }
    expect(tb.styles[0]).toEqual({ 0: h2, 1: h2, 2: h2 })
    expect(toRecord(tb as never)).toEqual({ ...rec, fontSize: 36, width: 300 })

    setTextFontSize(tb as never, 10)
    expect(tb.styles[0]![0]).toEqual({ fontSize: 15, fontWeight: 'bold' })
    expect(toRecord(tb as never)).toEqual({ ...rec, fontSize: 10, width: 300 })
  })

  it('reconciling rewrites non-canonical styles (two sizes in one paragraph, stray entries) and nothing else', () => {
    const tb = tbOf(make(text({ text: 'Titlebody', headings: [1] })))
    // What Fabric leaves after Backspace merged a body line into a heading line, plus a stale entry past the end.
    const h1 = { fontSize: 48, fontWeight: 'bold' }
    tb.styles = { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1, 12: { fontStyle: 'italic' } } }
    const before = { left: tb.left, top: tb.top, text: tb.text }
    expect(reconcileTextFormatting(tb as never)).toBe(true)
    expect(Object.keys(tb.styles[0]!)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8'])
    for (const st of Object.values(tb.styles[0]!)) expect(st).toEqual(h1)
    expect({ left: tb.left, top: tb.top, text: tb.text }).toEqual(before)
    expect(reconcileTextFormatting(tb as never)).toBe(false) // canonical now: nothing to do
    expect(reconcileTextFormatting(make(text()) as never)).toBe(false)
  })
})

describe('a text change: levels carried over, marks from the canvas', () => {
  type Styles = Record<number, Record<number, Record<string, unknown>>>
  type Tb = Loose & { styles: Styles; text: string; textAlign: string; selectionStart?: number; selectionEnd?: number }
  const h1 = { fontSize: 48, fontWeight: 'bold' }
  /** A complete style declaration, as Fabric's copy and drag store it (the source's size, font and colour). */
  const pasted = (patch: Record<string, unknown> = {}) => ({ fontSize: 48, fontWeight: 'normal', fontStyle: 'normal', underline: false, linethrough: false, fontFamily: 'Arial', fill: '#ff0000', ...patch })
  /** What Fabric leaves after a change: the new text, its styles as Fabric shifted them, the caret (graphemes). */
  function change(tb: Tb, next: string, styles: Styles, caret?: number) {
    tb.text = next
    tb.styles = styles
    tb.selectionStart = tb.selectionEnd = caret
  }
  const mk = (patch: Partial<TextRecord>) => make(text(patch)) as unknown as Tb

  it('P1: plain text pasted from a larger text into a normal line brings neither a heading nor its size', () => {
    const tb = mk({ text: 'Title\nbody' })
    change(tb, 'Title\nBIGbody', { 1: { 0: pasted(), 1: pasted(), 2: pasted() } }, 9)
    expect(reconcileTextFormatting(tb as never)).toBe(true)
    expect(tb.styles).toEqual({})
    expect(toRecord(tb as never)).toEqual(text({ text: 'Title\nBIGbody' }))
  })

  it('P1b: the same from a 30 px text (the size of a level 3 heading here) at the start of a one-line text', () => {
    const tb = mk({ text: 'body' })
    change(tb, 'MIDbody', { 0: { 0: pasted({ fontSize: 30 }), 1: pasted({ fontSize: 30 }), 2: pasted({ fontSize: 30 }) } }, 3)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'MIDbody' }))
  })

  it('Q2: normal text pasted at the start of a heading line leaves one heading, and no bold mark anywhere', () => {
    const tb = mk({ text: 'Title\nbody', headings: [1] })
    const row: Styles[number] = { 0: pasted({ fontSize: 24 }), 1: pasted({ fontSize: 24 }), 2: pasted({ fontSize: 24 }), 3: pasted({ fontSize: 24 }) }
    for (let i = 4; i < 9; i++) row[i] = h1
    change(tb, 'bodyTitle\nbody', { 0: row }, 4)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'bodyTitle\nbody', headings: [1] }))
    expect(Object.values(tb.styles[0]!)).toEqual(Array.from({ length: 9 }, () => h1))
    expect(tb.styles[1]).toBeUndefined()
  })

  it('pasted marks stay: a bold word stays bold, heading text arrives bold at the normal size; nothing else of the source stays', () => {
    const tb = mk({ text: 'ab' })
    change(tb, 'aXYb', { 0: { 1: pasted({ fontWeight: 'bold', fontSize: 24 }), 2: pasted({ fontStyle: 'italic', underline: true, linethrough: true }) } }, 3)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'aXYb', spans: [{ start: 1, end: 2, bold: true }, { start: 2, end: 3, italic: true, underline: true, strike: true }] }))
    expect(tb.styles).toEqual({ 0: { 1: { fontWeight: 'bold' }, 2: { fontStyle: 'italic', underline: true, linethrough: true } } })
    const h = mk({ text: 'ab' })
    change(h, 'aHb', { 0: { 1: pasted({ fontWeight: 'bold' }) } }, 2)
    reconcileTextFormatting(h as never)
    expect(toRecord(h as never)).toEqual(text({ text: 'aHb', spans: [{ start: 1, end: 2, bold: true }] }))
  })

  it('the bold of a heading does not become a mark when its characters join a normal line', () => {
    const tb = mk({ text: 'body\nTitle', headings: [0, 1] })
    // Fabric moves the heading characters' styles onto line 0 (ITextBehavior.mjs removeStyleFromTo).
    change(tb, 'bodyTitle', { 0: { 4: h1, 5: h1, 6: h1, 7: h1, 8: h1 } }, 4)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'bodyTitle' }))
    expect(tb.styles).toEqual({})
  })

  it('nor when Fabric copies the style of a heading character onto text pasted or typed on a new normal line', () => {
    const tb = mk({ text: 'Title', headings: [1] })
    // "A\nB" pasted at the end: Fabric copies the last heading character's style onto "A",
    // onto the new line, and from there onto "B" (insertNewlineStyleObject, insertCharStyleObject).
    change(tb, 'TitleA\nB', { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1, 5: h1 }, 1: { 0: h1 } }, 8)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'TitleA\nB', headings: [1] }))
    expect(tb.styles[1]).toBeUndefined()
  })

  it('nor when the line break after a heading is replaced by Enter (the same text, the heading style copied onto the next line)', () => {
    const tb = mk({ text: 'Title\nbody', headings: [1] })
    // Shift+ArrowRight selected the line break, Enter replaced it: Fabric copied the style of
    // the first selected character (the break, i.e. the heading's last character) onto "b"
    // (ITextKeyBehavior.mjs onInput, getSelectionStyles then insertNewStyleBlock).
    change(tb, 'Title\nbody', { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1 }, 1: { 0: h1 } }, 6)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'Title\nbody', headings: [1] }))
    expect(tb.styles[1]).toBeUndefined()
  })

  it('a real bold mark that moves onto a heading is implied there, and stays a mark on a normal line', () => {
    const tb = mk({ text: 'Title\nbold', headings: [1], spans: [{ start: 6, end: 10, bold: true }] })
    const b = { fontWeight: 'bold' }
    change(tb, 'Titlebold', { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1, 5: b, 6: b, 7: b, 8: b } }, 5)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'Titlebold', headings: [1] }))
    const keep = mk({ text: 'ab\nbold', spans: [{ start: 3, end: 7, bold: true }] })
    change(keep, 'abbold', { 0: { 2: b, 3: b, 4: b, 5: b } }, 2)
    reconcileTextFormatting(keep as never)
    expect(toRecord(keep as never)).toEqual(text({ text: 'abbold', spans: [{ start: 2, end: 6, bold: true }] }))
  })

  it('an emptied heading line gets its placeholder back, even when Fabric cleared every style', () => {
    const tb = mk({ text: 'Title\nbody', headings: [1] })
    change(tb, '\nbody', {}, 0)
    expect(reconcileTextFormatting(tb as never)).toBe(true)
    expect(tb.styles).toEqual({ 0: { 0: h1 } })
    expect(toRecord(tb as never)).toEqual(text({ text: '\nbody', headings: [1] }))
    const all = mk({ text: 'Title', headings: [1] })
    change(all, '', {}, 0) // the textarea emptied: Fabric sets styles to {} (ITextKeyBehavior.mjs onInput)
    reconcileTextFormatting(all as never)
    expect(all.styles).toEqual({ 0: { 0: h1 } })
  })

  it('the caret picks the line Enter was pressed on', () => {
    // The same new text from Enter at the end of "body" (caret 5) or at the start of "Title" (caret 6).
    for (const [caret, headings] of [
      [5, [0, 0, 1]],
      [6, [0, 1, 1]],
    ] as const) {
      const tb = mk({ text: 'body\nTitle', headings: [0, 1] })
      change(tb, 'body\n\nTitle', { 1: { 0: h1 }, 2: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1 } }, caret)
      reconcileTextFormatting(tb as never)
      expect(toRecord(tb as never)).toEqual(text({ text: 'body\n\nTitle', headings: [...headings] }))
    }
  })

  it('a paste that leaves the same text: a word from a larger text pasted over the same word brings no heading', () => {
    const tb = mk({ text: 'BIG\nbody' })
    change(tb, 'BIG\nbody', { 0: { 0: pasted(), 1: pasted(), 2: pasted() } }, 3) // 48 px: a level 1 size here
    expect(reconcileTextFormatting(tb as never)).toBe(true)
    expect(tb.styles).toEqual({})
    expect(toRecord(tb as never)).toEqual(text({ text: 'BIG\nbody' }))
  })

  it('a paste that leaves the same text: normal text pasted over a heading line keeps the heading, with its bold implied', () => {
    const tb = mk({ text: 'Title\nbody', headings: [1] })
    const plain = pasted({ fontSize: 24 })
    change(tb, 'Title\nbody', { 0: { 0: plain, 1: plain, 2: plain, 3: plain, 4: plain } }, 5)
    expect(reconcileTextFormatting(tb as never)).toBe(true)
    expect(Object.values(tb.styles[0]!)).toEqual(Array.from({ length: 5 }, () => h1))
    expect(toRecord(tb as never)).toEqual(text({ text: 'Title\nbody', headings: [1] }))
    // Bold pasted over the heading is the heading's own; bold pasted over the normal line is a mark.
    const bold = pasted({ fontSize: 24, fontWeight: 'bold' })
    change(tb, 'Title\nbody', { 0: { 0: bold, 1: bold, 2: bold, 3: bold, 4: bold }, 1: { 0: bold, 1: bold, 2: bold, 3: bold } }, 10)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'Title\nbody', headings: [1], spans: [{ start: 6, end: 10, bold: true }] }))
  })

  it('a text with no remembered state has nothing to carry over: a change reads its levels from the sizes', () => {
    const tb = new Textbox('Title\nbody', { fontSize: 24, width: 200, selectionEnd: 5 }) as unknown as Tb
    tb.styles = { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1 } }
    expect(reconcileTextFormatting(tb as never)).toBe(false)
    expect(readTextFormatting(tb as never, { caret: 5 }).headings).toEqual([1])
  })

  it('the record read in the middle of a change (before its rewrite) already carries the levels, not the pasted sizes', () => {
    const tb = mk({ text: 'Title\nbody' })
    change(tb, 'Title\nBIGbody', { 1: { 0: pasted(), 1: pasted(), 2: pasted() } })
    expect(toRecord(tb as never)).toEqual(text({ text: 'Title\nBIGbody' }))
  })

  it('a stored "\\r\\n" text keeps its marks and levels, and keeps them when typing turns its break into "\\n"', () => {
    const tb = mk({ text: 'Title\r\nbody bold', headings: [1], spans: [{ start: 12, end: 16, bold: true }] })
    const b = { fontWeight: 'bold' }
    expect(toRecord(tb as never)).toEqual(text({ text: 'Title\r\nbody bold', headings: [1], spans: [{ start: 12, end: 16, bold: true }] }))
    change(tb, 'Title\nbody bold!', { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1 }, 1: { 5: b, 6: b, 7: b, 8: b, 9: b } }, 16)
    reconcileTextFormatting(tb as never)
    expect(toRecord(tb as never)).toEqual(text({ text: 'Title\nbody bold!', headings: [1], spans: [{ start: 11, end: 16, bold: true }] }))
  })
})

describe('the wrap width after a rewrite', () => {
  type Tb = Loose & { styles: Record<number, Record<number, Record<string, unknown>>>; text: string; selectionEnd?: number }
  const h1 = { fontSize: 48, fontWeight: 'bold' }
  const joined = (tb: Tb, grownTo: number) => {
    // Backspace at the start of "WWW": Fabric laid "abWWW" out with the heading's size on
    // "WWW" and widened the box to fit, keeping its alignment edge (updateFromTextArea).
    const cx = tb.left + tb.width / 2
    tb.text = 'abWWW'
    tb.styles = { 0: { 2: h1, 3: h1, 4: h1 } }
    tb.selectionEnd = 2
    tb.width = grownTo
    tb.left = cx - grownTo / 2
  }

  it('goes back to the width from before the change, keeping a centred box centred', () => {
    const tb = make(text({ text: 'ab\nWWW', headings: [0, 1], align: 'center', width: 150 })) as unknown as Tb
    const centre = tb.left + tb.width / 2
    joined(tb, 161)
    reconcileTextFormatting(tb as never)
    expect(tb.width).toBe(150)
    expect(tb.left + tb.width / 2).toBe(centre)
    expect(toRecord(tb as never)).toMatchObject({ width: 150, left: 1, text: 'abWWW' })
  })

  it('keeps a width set by a side handle since the last write (picked up by the commit that reads the scene)', () => {
    const tb = make(text({ text: 'ab\nWWW', headings: [0, 1], width: 150 })) as unknown as Tb
    tb.width = 300 // a side handle
    toRecord(tb as never)
    joined(tb, 400)
    reconcileTextFormatting(tb as never)
    expect(tb.width).toBe(300)
  })

  it('never uses a remembered width that cannot be from before the change', () => {
    const narrowed = make(text({ text: 'ab\nWWW', headings: [0, 1], width: 150 })) as unknown as Tb
    narrowed.width = 100 // narrowed without a read in between: the remembered 150 is larger than the box
    joined(narrowed, 120)
    reconcileTextFormatting(narrowed as never)
    expect(narrowed.width).toBe(120)
    const resized = make(text({ text: 'ab\nWWW', headings: [0, 1], width: 150 })) as unknown as Tb
    resized.fontSize = 30 // a base size the remembered width was not taken at
    joined(resized, 200)
    reconcileTextFormatting(resized as never)
    expect(resized.width).toBe(200)
  })

  it('setting the font size and folding a scale refresh the remembered width', () => {
    const tb = make(text({ text: 'ab\nWWW', headings: [0, 1], width: 150 })) as unknown as Tb
    Object.assign(tb, { scaleX: 2, scaleY: 2 })
    normalizeTextScale(tb as never) // width 300, size 48
    joined(tb, 500)
    tb.styles = { 0: { 2: { fontSize: 96, fontWeight: 'bold' } } }
    reconcileTextFormatting(tb as never)
    expect(tb.width).toBe(300)
  })

  it('a change whose styles were already canonical keeps the width Fabric gave it (a long word widens the box)', () => {
    const tb = make(text({ text: 'ab', width: 150 })) as unknown as Tb
    tb.text = 'abWWWWWWWWWWWW'
    tb.selectionEnd = 14
    tb.width = 260
    expect(reconcileTextFormatting(tb as never)).toBe(false)
    expect(tb.width).toBe(260)
  })
})
