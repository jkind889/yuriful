import { describe, expect, it } from 'vitest'
import {
  createEmptyDoc,
  normalizeFrameName,
  normalizeTitle,
  objectsEqual,
  parseDoc,
  referencedAssetIds,
  round,
  roundPositive,
  sceneEqual,
  serializeDoc,
} from './doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, TextRecord } from './types.ts'

const text: TextRecord = { type: 'text', id: 't1', left: 1, top: 2, angle: 0, text: 'hi', fontSize: 24, width: 200 }
const image: ImageRecord = { type: 'image', id: 'i1', left: 5, top: 6, angle: 15, assetId: 'asset-1', scaleX: 0.5, scaleY: 0.5 }
const frame: FrameRecord = { id: 'f1', name: 'Cover', left: -10, top: -20, width: 640, height: 480 }
const good = (): BoardDoc => ({ ...createEmptyDoc(), title: 'Mine', objects: [image, text], viewport: { zoom: 2, panX: 10, panY: -4 } })
const framed = (): BoardDoc => ({ ...good(), frames: [frame, { ...frame, id: 'f2', name: 'Back' }], objects: [{ ...image, frameId: 'f1' }, text] })
/** A milestone 1 document exactly as that build stored it. */
const wireV1 = () => ({ version: 1, title: 'Mine', objects: [image, text], viewport: { zoom: 2, panX: 10, panY: -4 } })
const wire = (doc: BoardDoc) => JSON.parse(JSON.stringify(serializeDoc(doc))) as Record<string, unknown>

describe('parseDoc: wire version 1 (milestone 1 boards)', () => {
  it('parses a milestone 1 document to the same objects with no frames', () => {
    expect(parseDoc(wireV1())).toEqual(good())
    expect(parseDoc(wireV1())?.frames).toEqual([])
  })

  it('never reads frameId or frames from a version 1 document', () => {
    const parsed = parseDoc({ ...wireV1(), frames: [frame], objects: [{ ...image, frameId: 'f1' }, text] })
    expect(parsed?.frames).toEqual([])
    expect(parsed?.objects[0]).not.toHaveProperty('frameId')
  })

  it('rejects non-objects, unknown versions and bad object lists', () => {
    expect(parseDoc(null)).toBeNull()
    expect(parseDoc('x')).toBeNull()
    expect(parseDoc([])).toBeNull()
    expect(parseDoc({ ...wireV1(), version: 3 })).toBeNull()
    expect(parseDoc({ ...wireV1(), version: 0 })).toBeNull()
    expect(parseDoc({ ...wireV1(), version: '1' })).toBeNull()
    expect(parseDoc({ ...wireV1(), objects: 'nope' })).toBeNull()
  })

  it('rejects the whole document when any object is malformed (never partially loads)', () => {
    expect(parseDoc({ ...wireV1(), objects: [text, { ...image, assetId: 5 }] })).toBeNull()
    expect(parseDoc({ ...wireV1(), objects: [{ ...text, fontSize: 0 }] })).toBeNull()
    expect(parseDoc({ ...wireV1(), objects: [{ ...text, left: Number.NaN }] })).toBeNull()
    expect(parseDoc({ ...wireV1(), objects: [{ ...text, type: 'blob' }] })).toBeNull()
    expect(parseDoc({ ...wireV1(), objects: [text, { ...image, id: 't1' }] })).toBeNull()
  })

  it('strips unknown fields', () => {
    const parsed = parseDoc({ ...wireV1(), objects: [{ ...text, evil: '<script>' }] })
    expect(parsed?.objects[0]).not.toHaveProperty('evil')
  })

  it('falls back to defaults for a bad title or viewport', () => {
    const parsed = parseDoc({ ...wireV1(), title: '   ', viewport: { zoom: 1000, panX: 0, panY: 0 } })
    expect(parsed?.title).toBe('Untitled board')
    expect(parsed?.viewport).toEqual({ zoom: 1, panX: 0, panY: 0 })
    expect(parseDoc({ ...wireV1(), viewport: undefined })?.viewport.zoom).toBe(1)
  })
})

describe('parseDoc: wire version 2 (frames)', () => {
  it('round-trips frames and a valid frameId through serializeDoc and JSON', () => {
    const doc = framed()
    expect(wire(doc).version).toBe(2)
    expect(parseDoc(wire(doc))).toEqual(doc)
  })

  it('drops a dangling or non-string frameId instead of rejecting', () => {
    const raw = wire(framed())
    raw.objects = [
      { ...image, frameId: 'gone' },
      { ...text, frameId: 7 },
    ]
    const parsed = parseDoc(raw)
    expect(parsed?.objects).toEqual([image, text])
    expect(parsed?.objects[0]).not.toHaveProperty('frameId')
    expect(parsed?.objects[1]).not.toHaveProperty('frameId')
  })

  it('never recomputes membership: an object inside a frame without frameId stays loose', () => {
    const inside = { ...text, left: 0, top: 0 }
    const parsed = parseDoc({ ...wire(framed()), objects: [inside] })
    expect(parsed?.objects[0]).not.toHaveProperty('frameId')
  })

  it('rejects the whole document for a malformed frame', () => {
    const bad = (patch: Record<string, unknown>) => parseDoc({ ...wire(framed()), frames: [{ ...frame, ...patch }] })
    expect(bad({ width: 0 })).toBeNull()
    expect(bad({ height: -1 })).toBeNull()
    expect(bad({ left: Number.NaN })).toBeNull()
    expect(bad({ name: 5 })).toBeNull()
    expect(bad({ id: '' })).toBeNull()
    expect(parseDoc({ ...wire(framed()), frames: 'nope' })).toBeNull()
    expect(parseDoc({ ...wire(framed()), frames: undefined })).toBeNull()
  })

  it('rejects duplicate ids across frames and objects', () => {
    expect(parseDoc({ ...wire(framed()), frames: [frame, frame] })).toBeNull()
    expect(parseDoc({ ...wire(framed()), objects: [{ ...text, id: 'f1' }] })).toBeNull()
  })

  it('falls back to the default name for a blank frame name', () => {
    expect(parseDoc({ ...wire(framed()), frames: [{ ...frame, name: '  ' }] })?.frames[0]?.name).toBe('Frame')
  })

  it('strips unknown frame fields', () => {
    const parsed = parseDoc({ ...wire(framed()), frames: [{ ...frame, angle: 30, evil: 1 }] })
    expect(parsed?.frames[0]).toEqual(frame)
  })
})

describe('serializeDoc', () => {
  it('writes a frameless board in exactly the milestone 1 shape', () => {
    const stored = serializeDoc(good())
    expect(stored).toEqual(wireV1())
    expect(Object.keys(stored)).toEqual(['version', 'title', 'objects', 'viewport'])
  })

  it('never writes frameId when no frame exists', () => {
    const stored = serializeDoc({ ...good(), objects: [{ ...image, frameId: 'stale' }] })
    expect(stored.version).toBe(1)
    expect(stored.objects[0]).not.toHaveProperty('frameId')
  })

  it('round-trips both shapes back to the same in-memory document', () => {
    for (const doc of [good(), framed(), createEmptyDoc()]) expect(parseDoc(wire(doc))).toEqual(doc)
  })

  it('never stores an explicit undefined owner', () => {
    const stored = serializeDoc({ ...framed(), objects: [{ ...image, frameId: undefined }] })
    expect(stored.version).toBe(2)
    expect('frameId' in (stored.objects[0] as object)).toBe(false)
  })

  it('does not alias the document it was given', () => {
    const doc = framed()
    const stored = serializeDoc(doc)
    expect(stored.objects[0]).not.toBe(doc.objects[0])
    expect(stored.viewport).not.toBe(doc.viewport)
  })
})

describe('roundPositive', () => {
  it('rounds ordinary values exactly like round', () => {
    for (const [n, digits] of [
      [0.123456789, 5],
      [1, 5],
      [199.996, 2],
      [0.5, 2],
      [23.456, 2],
      [0.00001, 5],
    ] as const) {
      expect(roundPositive(n, digits)).toBe(round(n, digits))
    }
  })

  it('keeps tiny positive values positive instead of rounding them to zero', () => {
    expect(round(0.000004, 5)).toBe(0)
    expect(roundPositive(0.000004, 5)).toBe(0.000004)
    expect(roundPositive(0.0000001234567, 2)).toBe(1.23457e-7)
    for (let e = 0; e >= -12; e--) {
      const n = 10 ** e
      for (const digits of [2, 5]) expect(roundPositive(n, digits)).toBeGreaterThan(0)
    }
  })

  it('leaves zero and negatives to plain rounding', () => {
    expect(roundPositive(0, 5)).toBe(0)
    expect(roundPositive(-0.000004, 5)).toBe(0)
  })

  it('positive extremes survive a round trip through the stored document', () => {
    for (let e = 0; e >= -12; e--) {
      const n = roundPositive(10 ** e * 0.4, 5)
      const doc: BoardDoc = {
        ...createEmptyDoc(),
        frames: [{ ...frame, width: n, height: n }],
        objects: [
          { ...image, scaleX: n, scaleY: n },
          { ...text, width: n, fontSize: n },
        ],
      }
      const parsed = parseDoc(wire(doc))
      expect(parsed).toEqual(doc)
      expect((parsed?.objects[0] as ImageRecord).scaleX).toBeGreaterThan(0)
    }
  })
})

describe('helpers', () => {
  it('collects referenced asset ids', () => {
    expect([...referencedAssetIds([image, text, { ...image, id: 'i2' }])]).toEqual(['asset-1'])
  })

  it('compares object lists structurally', () => {
    const list: ObjectRecord[] = [text]
    expect(objectsEqual(list, [{ ...text }])).toBe(true)
    expect(objectsEqual(list, [{ ...text, left: 2 }])).toBe(false)
    expect(objectsEqual([text, image], [image, text])).toBe(false)
  })

  it('compares scenes structurally, including order, frames and ownership', () => {
    const a = { frames: [frame], objects: [image, text] }
    expect(sceneEqual(a, { frames: [{ ...frame }], objects: [{ ...image }, { ...text }] })).toBe(true)
    expect(sceneEqual(a, { frames: [frame], objects: [text, image] })).toBe(false)
    expect(sceneEqual(a, { frames: [{ ...frame, name: 'Other' }], objects: [image, text] })).toBe(false)
    expect(sceneEqual(a, { frames: [], objects: [image, text] })).toBe(false)
    expect(sceneEqual(a, { frames: [frame], objects: [{ ...image, frameId: 'f1' }, text] })).toBe(false)
    expect(sceneEqual(a, { frames: [frame], objects: [image] })).toBe(false)
  })

  it('scene equality ignores key order and an explicit undefined owner', () => {
    const reordered = { angle: 15, scaleY: 0.5, scaleX: 0.5, assetId: 'asset-1', top: 6, left: 5, id: 'i1', type: 'image' } as ImageRecord
    expect(sceneEqual({ frames: [], objects: [image] }, { frames: [], objects: [reordered] })).toBe(true)
    expect(sceneEqual({ frames: [], objects: [image] }, { frames: [], objects: [{ ...image, frameId: undefined }] })).toBe(true)
  })

  it('scene equality treats NaN as equal to itself', () => {
    const broken = { frames: [], objects: [{ ...image, left: Number.NaN }] }
    expect(sceneEqual(broken, { frames: [], objects: [{ ...image, left: Number.NaN }] })).toBe(true)
    expect(sceneEqual(broken, { frames: [], objects: [image] })).toBe(false)
  })

  it('normalizes titles', () => {
    expect(normalizeTitle('  My   board ')).toBe('My board')
    expect(normalizeTitle('')).toBe('Untitled board')
    expect(normalizeTitle('x'.repeat(500))).toHaveLength(120)
  })

  it('normalizes frame names', () => {
    expect(normalizeFrameName('  Cover   page ')).toBe('Cover page')
    expect(normalizeFrameName('   ')).toBe('Frame')
    expect(normalizeFrameName('x'.repeat(500))).toHaveLength(80)
  })
})

describe('locked: an optional field on both wire versions', () => {
  it('is read from version 1 and version 2 documents, for objects and frames, only when exactly true', () => {
    const v1 = parseDoc({ ...wireV1(), objects: [{ ...image, locked: true }, text] })
    expect(v1?.objects[0]).toEqual({ ...image, locked: true })
    expect(v1?.objects[1]).not.toHaveProperty('locked')
    const v2 = parseDoc({
      version: 2,
      title: 'Mine',
      frames: [{ ...frame, locked: true }, { ...frame, id: 'f2', name: 'Back' }],
      objects: [{ ...image, frameId: 'f1' }, { ...text, locked: true }],
      viewport: { zoom: 2, panX: 10, panY: -4 },
    })
    expect(v2?.frames[0]).toEqual({ ...frame, locked: true })
    expect(v2?.frames[1]).not.toHaveProperty('locked')
    expect(v2?.objects[1]).toEqual({ ...text, locked: true })
    expect(v2?.objects[0]).not.toHaveProperty('locked')
  })

  it('drops false and garbage values instead of rejecting the board', () => {
    for (const bad of [false, 'true', 1, null, {}, []]) {
      const parsed = parseDoc({ ...wireV1(), objects: [{ ...image, locked: bad }, { ...text, locked: bad }] })
      expect(parsed).not.toBeNull()
      expect(parsed!.objects[0]).not.toHaveProperty('locked')
      expect(parsed!.objects[1]).not.toHaveProperty('locked')
      const framedRaw = wire(framed())
      ;(framedRaw.frames as Array<Record<string, unknown>>)[0]!.locked = bad
      expect(parseDoc(framedRaw)!.frames[0]).not.toHaveProperty('locked')
    }
  })

  it('a frameless board with a locked object is still written as wire version 1, with the field', () => {
    const out = wire({ ...good(), objects: [{ ...image, locked: true }, text] })
    expect(out.version).toBe(1)
    expect(out).not.toHaveProperty('frames')
    expect(out.objects).toEqual([{ ...image, locked: true }, text])
    expect(parseDoc(out)).toEqual({ ...good(), objects: [{ ...image, locked: true }, text] })
  })

  it('a framed board writes it on frames and objects, and round-trips', () => {
    const doc: BoardDoc = { ...framed(), frames: [{ ...frame, locked: true }, { ...frame, id: 'f2', name: 'Back' }], objects: [{ ...image, frameId: 'f1', locked: true }, text] }
    const out = wire(doc)
    expect(out.version).toBe(2)
    expect((out.frames as unknown[])[0]).toEqual({ ...frame, locked: true })
    expect((out.objects as unknown[])[0]).toEqual({ ...image, frameId: 'f1', locked: true })
    expect(parseDoc(out)).toEqual(doc)
  })

  it('is never written unless it is true: no locked key, no explicit undefined, no false', () => {
    const sloppy = {
      ...framed(),
      frames: [{ ...frame, locked: undefined }, { ...frame, id: 'f2', name: 'Back', locked: false as unknown as true }],
      objects: [{ ...image, frameId: 'f1', locked: undefined }, { ...text, locked: false as unknown as true }],
    } as BoardDoc
    const v2 = serializeDoc(sloppy)
    for (const rec of [...(v2 as { frames: object[] }).frames, ...v2.objects]) expect(Object.keys(rec)).not.toContain('locked')
    const v1 = serializeDoc({ ...sloppy, frames: [] })
    for (const rec of v1.objects) expect(Object.keys(rec)).not.toContain('locked')
    expect(JSON.stringify(serializeDoc(framed()))).not.toContain('locked')
    expect(JSON.stringify(serializeDoc(good()))).not.toContain('locked')
  })

  it('a lock change is a scene change (so it is an undo step and is saved); absent and undefined are the same', () => {
    const scene = { frames: [frame], objects: [image, text] as ObjectRecord[] }
    expect(sceneEqual(scene, { ...scene, objects: [{ ...image, locked: true }, text] })).toBe(false)
    expect(sceneEqual(scene, { ...scene, frames: [{ ...frame, locked: true }] })).toBe(false)
    expect(sceneEqual(scene, { ...scene, objects: [{ ...image, locked: undefined }, text] })).toBe(true)
  })
})

describe('crop: an optional image field on both wire versions', () => {
  const crop = { x: 10, y: 20.5, width: 100, height: 60.25 }
  const cropped: ImageRecord = { ...image, crop }

  it('parses and round-trips a crop on wire version 1 (no frames) and version 2', () => {
    const v1 = wire({ ...good(), objects: [cropped, text] })
    expect(v1.version).toBe(1)
    expect(parseDoc(v1)?.objects[0]).toEqual(cropped)
    const v2 = wire({ ...framed(), objects: [{ ...cropped, frameId: 'f1' }, text] })
    expect(v2.version).toBe(2)
    expect(parseDoc(v2)?.objects[0]).toEqual({ ...cropped, frameId: 'f1' })
  })

  it('a crop does not need a newer wire version: a frameless cropped board is still version 1', () => {
    expect(serializeDoc({ ...good(), objects: [cropped] }).version).toBe(1)
  })

  it('drops a malformed crop (the image is shown whole) without rejecting the board', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      [1, 2, 3, 4],
      { x: 1, y: 2, width: 3 },
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: -0.5, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: -1 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
      { x: '0', y: 0, width: 10, height: 10 },
    ]
    for (const c of bad) {
      const parsed = parseDoc({ ...wireV1(), objects: [{ ...image, crop: c }, text] })
      expect(parsed).not.toBeNull()
      expect(parsed?.objects[0]).toEqual(image)
      expect(parsed?.objects[0]).not.toHaveProperty('crop')
    }
  })

  it('keeps only the four crop fields', () => {
    const parsed = parseDoc({ ...wireV1(), objects: [{ ...image, crop: { ...crop, junk: true } }] })
    expect((parsed?.objects[0] as ImageRecord).crop).toEqual(crop)
  })

  it('a text never gets a crop', () => {
    const parsed = parseDoc({ ...wireV1(), objects: [{ ...text, crop }] })
    expect(parsed?.objects[0]).not.toHaveProperty('crop')
  })

  it('serializes a fresh copy of the crop, and never stores an undefined crop', () => {
    const doc: BoardDoc = { ...good(), objects: [cropped, { ...image, id: 'i2', crop: undefined }] }
    const out = serializeDoc(doc)
    const [first, second] = out.objects as ImageRecord[]
    expect(first!.crop).toEqual(crop)
    expect(first!.crop).not.toBe(crop)
    expect(Object.keys(second!)).not.toContain('crop')
    expect(JSON.stringify(out)).not.toContain('undefined')
  })

  it('sceneEqual compares crops by content: two snapshots of the same cropped image are equal; a changed crop is a change', () => {
    const a = { frames: [], objects: [{ ...image, crop: { ...crop } }] }
    const b = { frames: [], objects: [{ ...image, crop: { height: 60.25, width: 100, y: 20.5, x: 10 } }] }
    expect(sceneEqual(a, b)).toBe(true)
    expect(sceneEqual(a, { frames: [], objects: [{ ...image, crop: { ...crop, x: 11 } }] })).toBe(false)
    expect(sceneEqual(a, { frames: [], objects: [image] })).toBe(false)
    expect(sceneEqual({ frames: [], objects: [image] }, { frames: [], objects: [{ ...image, crop: undefined }] })).toBe(true)
    expect(sceneEqual({ frames: [], objects: [{ ...image, crop: { ...crop, x: Number.NaN } }] }, { frames: [], objects: [{ ...image, crop: { ...crop, x: Number.NaN } }] })).toBe(true)
  })
})

describe('round never turns a finite value into Infinity', () => {
  it('huge finite values come back as they are; ordinary values and -0 as before', () => {
    for (const n of [1e307, -1e307, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      expect(round(n)).toBe(n)
      expect(Number.isFinite(round(n, 5))).toBe(true)
    }
    expect(roundPositive(Number.MAX_VALUE)).toBe(Number.MAX_VALUE)
    expect(round(1.235)).toBe(1.24)
    expect(round(-2.345, 1)).toBe(-2.3)
    expect(Object.is(round(-0.001), 0)).toBe(true)
    expect(Object.is(round(-0), 0)).toBe(true)
    expect(Number.isNaN(round(Number.NaN))).toBe(true)
  })

  it('a board with a huge coordinate survives a save and a load', () => {
    const doc: BoardDoc = { ...good(), objects: [{ ...text, left: 1e307, top: -1e307 }] }
    const saved = JSON.parse(JSON.stringify(serializeDoc({ ...doc, objects: doc.objects.map((o) => ({ ...o, left: round(o.left), top: round(o.top) })) })))
    expect(parseDoc(saved)?.objects[0]).toMatchObject({ left: 1e307, top: -1e307 })
  })
})


describe('formatted text', () => {
  /** A text with every formatting field, in canonical form. */
  const rich: TextRecord = {
    ...text,
    id: 'r1',
    text: 'Title\n\nsome bold 😀 tail',
    font: 'serif',
    align: 'center',
    color: '#c0392b',
    spans: [
      { start: 12, end: 16, bold: true },
      { start: 20, end: 24, italic: true, underline: true, strike: true },
    ],
    headings: [1, 2],
  }

  it('a plain text and a plain board are written in exactly the pre-existing shape, in both versions', () => {
    const v1 = serializeDoc(good())
    expect(Object.keys(v1.objects[1]!)).toEqual(['type', 'id', 'left', 'top', 'angle', 'text', 'fontSize', 'width'])
    expect(JSON.stringify(v1)).toBe(JSON.stringify(wireV1()))
    const v2 = serializeDoc(framed())
    expect(Object.keys(v2.objects[1]!)).toEqual(['type', 'id', 'left', 'top', 'angle', 'text', 'fontSize', 'width'])
    // Parsed from storage, a plain text gains no keys either.
    expect(Object.keys(parseDoc(wireV1())!.objects[1]!)).toEqual(['type', 'id', 'left', 'top', 'angle', 'text', 'fontSize', 'width'])
  })

  it('never writes a formatting field that is undefined', () => {
    const blankFields = { ...text, font: undefined, align: undefined, color: undefined, spans: undefined, headings: undefined }
    for (const doc of [{ ...good(), objects: [blankFields] }, { ...framed(), objects: [blankFields] }]) {
      expect(Object.keys(serializeDoc(doc).objects[0]!)).toEqual(['type', 'id', 'left', 'top', 'angle', 'text', 'fontSize', 'width'])
    }
  })

  it('round-trips through storage in version 1 (no frames) and version 2 (with frames)', () => {
    const v1 = { ...good(), objects: [image, rich] }
    expect(serializeDoc(v1).version).toBe(1)
    expect(parseDoc(wire(v1))).toEqual(v1)
    const v2 = { ...framed(), objects: [image, { ...rich, frameId: 'f2' }] }
    expect(serializeDoc(v2).version).toBe(2)
    expect(parseDoc(wire(v2))).toEqual(v2)
  })

  it('reads formatting leniently: malformed fields are dropped or trimmed and the text still loads', () => {
    const raw = {
      ...text,
      text: 'ab\ncd',
      font: 'wingdings',
      align: 'justify',
      color: 'red',
      spans: [{ start: 3, end: 99, italic: true }, { start: 0, end: 0, italic: true }, 'junk'],
      headings: [7, 2, 1], // an invalid level, and one more than there are lines
    }
    const parsed = parseDoc({ ...wireV1(), objects: [raw] })
    expect(parsed?.objects[0]).toStrictEqual({ ...text, text: 'ab\ncd', spans: [{ start: 3, end: 5, italic: true }], headings: [0, 2] })
    const junk = parseDoc({ ...wireV1(), objects: [{ ...text, font: 3, align: null, color: {}, spans: 'bold', headings: { 0: 1 } }] })
    expect(junk?.objects[0]).toStrictEqual(text)
    // The same in a version 2 document.
    const v2 = parseDoc({ ...wire(framed()), objects: [{ ...raw, frameId: 'f1' }] })
    expect(v2?.objects[0]).toStrictEqual({ ...text, text: 'ab\ncd', spans: [{ start: 3, end: 5, italic: true }], headings: [0, 2], frameId: 'f1' })
  })

  it('everything that was strict about a text is still strict', () => {
    for (const bad of [{ ...rich, text: 3 }, { ...rich, fontSize: 0 }, { ...rich, width: -1 }, { ...rich, id: '' }, { ...rich, angle: 'x' }]) {
      expect(parseDoc({ ...wireV1(), objects: [bad] })).toBeNull()
    }
  })

  it('scene equality compares spans and headings structurally', () => {
    const scene = (o: TextRecord) => ({ frames: [], objects: [o] })
    const copy = JSON.parse(JSON.stringify(rich)) as TextRecord
    expect(copy.spans).not.toBe(rich.spans)
    expect(sceneEqual(scene(rich), scene(copy))).toBe(true)
    expect(sceneEqual(scene(rich), scene({ ...copy, spans: [{ ...copy.spans![0]!, end: 15 }, copy.spans![1]!] }))).toBe(false)
    expect(sceneEqual(scene(rich), scene({ ...copy, spans: [copy.spans![0]!] }))).toBe(false)
    expect(sceneEqual(scene(rich), scene({ ...copy, spans: [{ ...copy.spans![0]!, italic: true }, copy.spans![1]!] }))).toBe(false)
    expect(sceneEqual(scene(rich), scene({ ...copy, headings: [1] }))).toBe(false)
    expect(sceneEqual(scene(rich), scene({ ...copy, headings: [1, 3] }))).toBe(false)
    expect(sceneEqual(scene(rich), scene({ ...copy, headings: undefined }))).toBe(false)
    expect(sceneEqual(scene({ ...rich, headings: undefined }), scene({ ...copy, headings: undefined }))).toBe(true)
  })
})
