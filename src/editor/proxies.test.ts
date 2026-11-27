import { describe, expect, it, vi } from 'vitest'
import type { FrameRecord, ImageRecord, ObjectRecord, TextRecord } from '../model/types.ts'
import {
  ProxyRect,
  createFrameProxy,
  createProxy,
  idOf,
  imageCropOf,
  imageSizeOf,
  isFrame,
  isImage,
  isLocked,
  isText,
  setImageCrop,
  setImageElement,
  setTextData,
  textDataOf,
  toFrameRecord,
  toRecord,
} from './objects.ts'
import type { FakeObject } from './testing/fakeFabric.ts'
import { fabricReference } from './testing/fabricReference.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The proxies (`createProxy`, `createFrameProxy`): transparent Fabric objects that stand in for
 * what the scene layer draws. They must read back as exactly the records they were made from (the
 * storage-safety rule of Slice 2c-i), and exactly as a Fabric object made from the same record
 * read back on the Fabric renderer (its frozen reference, `testing/fabricReference.ts`). The fake Fabric has no rotation, so rotated geometry is proven in the
 * browser (`e2e/interleaving.spec.ts`).
 */

const el = (width = 200, height = 100) => ({ naturalWidth: width, naturalHeight: height }) as HTMLImageElement
const getImage = () => el()

const texts: TextRecord[] = [
  { id: 't1', type: 'text', left: 10, top: 20, angle: 0, text: 'plain', fontSize: 24, width: 240 },
  {
    id: 't2', type: 'text', left: 100.25, top: -40.5, angle: 0, text: 'Title\nbody with words', fontSize: 18.5, width: 260.75, font: 'serif', align: 'center', color: '#2f5d8a',
    spans: [{ start: 6, end: 10, bold: true }, { start: 11, end: 15, italic: true, underline: true, font: 'mono' }], headings: [2], frameId: 'F', locked: true,
  },
  { id: 't3', type: 'text', left: 0, top: 0, angle: 0, text: 'drawn', fontSize: 12, width: 80, minHeight: 64.25, align: 'right' },
  { id: 't4', type: 'text', left: 5, top: 6, angle: 0, text: 'cap', fontSize: 24, width: 125.31, minHeight: 0, captionOf: 'img', captionSide: 'left', captionPosition: 0.25, captionBackground: '#fdf3c4', frameId: 'F' },
  { id: 't5', type: 'text', left: 5, top: 6, angle: 0, text: 'styled, not a caption', fontSize: 24, width: 300, captionBackground: '#e0f0ff' },
]
const images: ImageRecord[] = [
  { id: 'i1', type: 'image', left: 10, top: 20, angle: 0, assetId: 'a', scaleX: 1, scaleY: 1 },
  { id: 'i2', type: 'image', left: 1.5, top: 2.25, angle: 0, assetId: 'a', scaleX: 0.75, scaleY: 1.25, crop: { x: 20.5, y: 10, width: 100.25, height: 80 }, frameId: 'F', locked: true },
]
const frames: FrameRecord[] = [
  { id: 'F', name: 'Spread', left: 10, top: 20, width: 400, height: 300 },
  { id: 'G', name: 'Locked', left: -10, top: 0, width: 24, height: 30, locked: true },
]

describe('proxy identity', () => {
  it('a text, an image and a frame proxy are what they stand for, by identity, and paint nothing', () => {
    const t = createProxy(texts[0]!, getImage)!
    const i = createProxy(images[0]!, getImage)!
    const f = createFrameProxy(frames[0]!)
    for (const p of [t, i, f]) {
      expect(p).toBeInstanceOf(ProxyRect)
      expect((p as unknown as { fill: string }).fill).toBe('transparent')
      expect((p as unknown as { objectCaching: boolean }).objectCaching).toBe(false)
      expect(p.render).toBe(ProxyRect.prototype.render)
    }
    expect([isText(t), isImage(t), isFrame(t)]).toEqual([true, false, false])
    expect([isText(i), isImage(i), isFrame(i)]).toEqual([false, true, false])
    expect([isText(f), isImage(f), isFrame(f)]).toEqual([false, false, true])
    expect([idOf(t), idOf(i), idOf(f)]).toEqual(['t1', 'i1', 'F'])
  })

  it('an image proxy is the size of its shown crop; an image whose picture is not decoded gives none', () => {
    const i = createProxy(images[1]!, getImage)!
    expect([i.width, i.height, i.scaleX, i.scaleY]).toEqual([100.25, 80, 0.75, 1.25])
    expect(imageSizeOf(i as never)).toEqual({ width: 200, height: 100 })
    expect(createProxy(images[0]!, () => undefined)).toBeNull()
  })

  it('locks set the same flags as on a Fabric object', async () => {
    const p = createProxy(texts[1]!, getImage) as unknown as FakeObject & { hasControls: boolean }
    const f = await fabricReference<boolean[]>('flags', texts[1])
    expect(isLocked(p as never)).toBe(true)
    expect([p.evented, p.selectable, p.hasControls]).toStrictEqual(f)
  })
})

describe('records round-trip through a proxy exactly', () => {
  it('every text field, as stored', () => {
    for (const rec of texts) expect(toRecord(createProxy(rec, getImage)!)).toStrictEqual(rec)
  })

  it('every image field, crop and lock included; a crop that reaches outside the picture is clamped like a Fabric image', async () => {
    for (const rec of images) expect(toRecord(createProxy(rec, getImage)!)).toStrictEqual(rec)
    const outside: ImageRecord = { ...images[0]!, crop: { x: 150, y: 0, width: 100, height: 100 } }
    expect(toRecord(createProxy(outside, getImage)!)).toStrictEqual(await fabricReference('clamped', outside))
  })

  it('every frame field', () => {
    for (const rec of frames) expect(toFrameRecord(createFrameProxy(rec))).toStrictEqual(rec)
  })

  it('reads back as a Fabric object made from the same record does, also for formatting that is not canonical', async () => {
    const odd: ObjectRecord[] = [
      ...texts,
      ...images,
      // Bold inside a heading line, a span font equal to the box font, the default colour, left alignment spelled out.
      { id: 'n1', type: 'text', left: 0, top: 0, angle: 0, text: 'Head\nbody', fontSize: 20, width: 200, headings: [1, 0], font: 'serif', color: '#1d2230', spans: [{ start: 0, end: 4, bold: true }, { start: 5, end: 9, font: 'serif' }] },
    ]
    const fabric = await fabricReference<unknown[]>('records', odd)
    expect(fabric, 'one recorded record for each').toHaveLength(odd.length)
    odd.forEach((rec, i) => expect(toRecord(createProxy(rec, getImage)!), rec.id).toStrictEqual(fabric[i]))
  })

  it('a scaled text folds its scale into font size, width and drawn height when read, as a Fabric text box does', async () => {
    const rec = texts[2]!
    const p = createProxy(rec, getImage)!
    p.set({ scaleX: 1.5, scaleY: 1.5 })
    const a = toRecord(p) as TextRecord
    const b = await fabricReference<TextRecord>('scaled', rec)
    expect([a.fontSize, a.width, a.minHeight]).toEqual([18, 120, 96.38])
    expect([a.fontSize, a.width, a.minHeight]).toStrictEqual([b.fontSize, b.width, b.minHeight])
  })
})

describe('changing what a proxy shows', () => {
  it('replacing a text proxy`s data is what it reads back', () => {
    const p = createProxy(texts[0]!, getImage)!
    const before = textDataOf(p)!
    setTextData(p, { ...before, text: 'changed', fontSize: 30 })
    expect(toRecord(p)).toMatchObject({ text: 'changed', fontSize: 30 })
    expect(textDataOf(p)).not.toBe(before)
    // Any other object has no data to replace.
    const i = createProxy(images[0]!, getImage)!
    setTextData(i, before)
    expect(textDataOf(i)).toBeUndefined()
  })

  it('crop and replace on an image proxy: a new data object each time, the crop read back as stored', () => {
    const i = createProxy(images[1]!, getImage)!
    setImageCrop(i as never, { x: 0, y: 0, width: 50, height: 40 })
    expect([i.width, i.height]).toEqual([50, 40])
    expect(imageCropOf(i as never)).toEqual({ x: 0, y: 0, width: 50, height: 40 })
    setImageCrop(i as never, undefined)
    expect(imageCropOf(i as never)).toBeUndefined()
    expect((toRecord(i) as ImageRecord).crop).toBeUndefined()
    setImageElement(i as never, 'b', el(320, 160))
    expect(toRecord(i)).toMatchObject({ assetId: 'b' })
    expect(imageSizeOf(i as never)).toEqual({ width: 320, height: 160 })
    expect([i.width, i.height]).toEqual([320, 160])
  })

  it('a text proxy`s width stops at its narrowest width, as a text box stops at its widest word', () => {
    const p = createProxy(texts[0]!, getImage) as ProxyRect
    p.minTextWidth = 90
    p.set({ width: 30 })
    expect(p.width).toBe(90)
    p.set({ width: 150 })
    expect(p.width).toBe(150)
    // An image or frame proxy has no such floor.
    const i = createProxy(images[0]!, getImage)!
    i.set({ width: 3 })
    expect(i.width).toBe(3)
  })
})
