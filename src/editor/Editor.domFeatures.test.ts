import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, Scene, StoredAsset, TextRecord } from '../model/types.ts'
import { Editor } from './Editor.ts'
import type { EditorOptions } from './Editor.ts'
import { computeLayers } from './layerList.ts'
import { ProxyRect, createObject, createProxy, idOf, imageDataOf } from './objects.ts'
import { canvasOf } from './testing/drive.ts'
import type { Canvas, FakeObject } from './testing/fakeFabric.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The base branch's features on the DOM renderer (plan Slice 2c-iii), on the fake Fabric: crop
 * mode's session on an image proxy and duplicate run the same script as on the default renderer
 * and must give the same records and state after every step; what only the DOM renderer has (a
 * proxy's picture data, a text proxy sized from its card before its owner is decided, the layer
 * list reading a text proxy) is checked directly. Where things land on screen, and the pairing
 * of text geometry, is in `e2e/interleaving.spec.ts`.
 *
 * The fake decodes every image as 200 x 100 source pixels and reads a mouse event's clientX and
 * clientY as scene coordinates.
 */

const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([7, 8, 9]).buffer })
const F = (id: string, left: number, top: number, width = 400, height = 300): FrameRecord => ({ id, name: `Frame ${id}`, left, top, width, height })
const img = (id: string, left: number, top: number, extra: Partial<ImageRecord> = {}): ImageRecord => ({ type: 'image', id, left, top, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1, ...extra })
const txt = (id: string, left: number, top: number, extra: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id, left, top, angle: 0, text: `${id} words`, fontSize: 20, width: 200, ...extra })
const key = (k: string) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
const dom = (): EditorOptions => ({ renderer: 'dom', measurer: new FakeCardMeasurer() })

let host: HTMLDivElement
const editors: Editor[] = []

async function open(frames: FrameRecord[], objects: ObjectRecord[], options: EditorOptions = {}) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Features', frames, objects }
  const store = new SpyStore({ doc, assets: new Map([['a1', asset('a1')]]) })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets(), undefined, options)
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const obj = (id: string): FakeObject => {
    const found = canvas.objects.find((o) => idOf(o as never) === id)
    if (!found) throw new Error(`no object ${id}`)
    return found
  }
  const internals = editor as unknown as { snapshot: () => Scene; getDoc: () => BoardDoc; history: { current: Scene; canUndo: boolean } }
  return { editor, store, canvas, obj, internals }
}

// ---- mouse, as a real browser reports it (crop mode listens to the DOM, not to Fabric) ----------

let held = 0
function down(canvas: Canvas, x: number, y: number) {
  held |= 1
  canvas.upperCanvasEl.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: held, bubbles: true, cancelable: true, clientX: x, clientY: y }))
}
function moveTo(x: number, y: number) {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: held }))
}
function up(x: number, y: number) {
  held &= ~1
  document.body.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: held, bubbles: true, cancelable: true, clientX: x, clientY: y }))
}

beforeEach(() => {
  held = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  editors.splice(0).forEach((e) => e.dispose())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

type Step = (b: Awaited<ReturnType<typeof open>>) => void

/** Runs a script on one renderer: after every step, the live scene, what a save would store, history and the state flags. */
async function run(options: EditorOptions, frames: FrameRecord[], objects: ObjectRecord[], steps: Step[]) {
  const b = await open(frames, objects, options)
  const out: unknown[] = []
  for (const step of steps) {
    step(b)
    await Promise.resolve()
    const s = b.editor.getState()
    out.push({ live: b.internals.snapshot(), saved: b.internals.getDoc().objects, history: b.internals.history.current, cropping: s.cropping, canUndo: s.canUndo, selected: b.canvas.getActiveObjects().map((o) => idOf(o as never)) })
  }
  return { out, b }
}

describe('crop mode on an image proxy', () => {
  // P at (100, 50), cropped to source (20, 10, 100 x 60): source pixel (u, v) is at scene (80 + u, 40 + v) uncropped.
  const objects = (): ObjectRecord[] => [img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 60 } }), img('Q', 560, 300, { frameId: 'G' })]
  const frames = (): FrameRecord[] => [F('G', 400, 200, 300, 250)]
  const select = (id: string): Step => (b) => b.editor.selectLayer(id)
  const script: Step[] = [
    select('P'),
    (b) => b.editor.startCrop(),
    (b) => {
      down(b.canvas, 200, 110) // the crop's bottom-right corner (source 120, 70)
      moveTo(170, 90)
      up(170, 90)
    },
    () => window.dispatchEvent(key('Enter')),
    (b) => b.editor.startCrop(),
    (b) => {
      down(b.canvas, 110, 60) // inside the box: moves it
      moveTo(120, 70)
      window.dispatchEvent(new Event('blur')) // returns this drag to where it began
      up(120, 70)
    },
    (b) => b.editor.cancelCrop(),
    (b) => b.editor.startCrop(),
    (b) => {
      down(b.canvas, 100, 60) // the left edge
      moveTo(130, 60)
      up(130, 60)
    },
    (b) => b.editor.applyCrop(),
    (b) => b.editor.undo(),
    (b) => b.editor.redo(),
    (b) => b.editor.fillImage(),
    (b) => b.editor.fitImage(),
    select('Q'),
    (b) => b.editor.startCrop(),
    (b) => {
      down(b.canvas, 560, 350) // Q's left edge: the crop moves its centre out of G
      moveTo(700, 350)
      up(700, 350)
    },
    () => window.dispatchEvent(key('Enter')),
  ]

  it('gives the same records, saves, history and state after every step as the Fabric renderer', async () => {
    const fabric = await run({}, frames(), objects(), script)
    const domRun = await run(dom(), frames(), objects(), script)
    expect(domRun.b.obj('P')).toBeInstanceOf(ProxyRect)
    expect(domRun.out).toEqual(fabric.out)
    const last = domRun.out.at(-1) as { saved: ImageRecord[] }
    expect(last.saved.find((o) => o.id === 'Q')!.frameId).toBeUndefined() // the crop moved it out of G
  })

  it('un-crops the proxy while open, so the layer draws the whole original, and restores its picture data exactly', async () => {
    const b = await open(frames(), objects(), dom())
    b.editor.selectLayer('P')
    const before = { data: { ...imageDataOf(b.obj('P') as never)! }, width: b.obj('P').width, height: b.obj('P').height, left: b.obj('P').left, top: b.obj('P').top }
    expect(before).toMatchObject({ data: { cropX: 20, cropY: 10 }, width: 100, height: 60 })
    b.editor.startCrop()
    expect(imageDataOf(b.obj('P') as never)).toMatchObject({ cropX: 0, cropY: 0 })
    expect(b.obj('P')).toMatchObject({ width: 200, height: 100, left: 80, top: 40 })
    expect(b.internals.getDoc().objects[0]).toEqual(objects()[0]) // a save never sees the open crop
    b.editor.cancelCrop()
    expect({ data: { ...imageDataOf(b.obj('P') as never)! }, width: b.obj('P').width, height: b.obj('P').height, left: b.obj('P').left, top: b.obj('P').top }).toEqual(before)
  })
})

describe('duplicate on the DOM renderer', () => {
  it('gives the same images, frames, ownership, captions, selection and history as the Fabric renderer', async () => {
    const frames = [F('F', 100, 100, 400, 300)]
    const objects: ObjectRecord[] = [
      img('A', 150, 150, { frameId: 'F', crop: { x: 10, y: 5, width: 120, height: 60 }, angle: 10 }),
      img('L', 300, 200, { frameId: 'F', locked: true }),
      img('B', 600, 150),
      img('C', 470, 380, { frameId: 'F' }), // its copy's centre leaves F
    ]
    const select = (...ids: string[]): Step => (b) => ids.forEach((id, i) => b.editor.selectLayer(id, { toggle: i > 0 }))
    const script: Step[] = [
      select('F'),
      (b) => b.editor.duplicateSelection(),
      (b) => b.editor.undo(),
      (b) => b.editor.redo(),
      select('B', 'C'),
      (b) => b.editor.duplicateSelection(),
      select('L'),
      (b) => b.editor.duplicateSelection(), // a locked selection: inert
    ]
    const norm = (v: unknown) => {
      const seen = new Map<string, string>()
      return JSON.parse(JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
        if (!seen.has(id)) seen.set(id, `~${seen.size + 1}`)
        return seen.get(id)!
      })) as unknown
    }
    const fabric = await run({}, frames, objects, script)
    const domRun = await run(dom(), frames, objects, script)
    expect(norm(domRun.out)).toEqual(norm(fabric.out))
    expect((fabric.out[1] as { live: Scene }).live.frames).toHaveLength(2)
  })

  it('a text copy is sized from its card before its owner is decided', async () => {
    // Just above F: the copy (24 lower) has its centre inside F only once its two lines count.
    const b = await open([F('F', 0, 100, 400, 300)], [txt('t', 20, 60, { text: 'two\nlines', fontSize: 20 })], dom())
    b.editor.selectLayer('t')
    b.editor.duplicateSelection()
    const copy = b.canvas.objects.at(-1)!
    expect(copy).toBeInstanceOf(ProxyRect)
    expect(copy.height).toBe(50) // two lines of 20 × 1.25
    const rec = b.internals.snapshot().objects.find((o) => o.id === idOf(copy as never))!
    expect(rec).toMatchObject({ top: 84, frameId: 'F' })
    expect(b.internals.snapshot().objects.find((o) => o.id === 't')!.frameId).toBeUndefined()
  })
})

describe('the layer list on proxies', () => {
  it('lists a text proxy as text with its words, leaves out a blank one, and lists images and Fabric objects as before', () => {
    const el = { naturalWidth: 200, naturalHeight: 100 } as HTMLImageElement
    const proxies = [
      createProxy(img('i', 0, 0), () => el)!,
      createProxy(txt('t', 0, 0, { text: '  A   note\nwith lines  ' }), () => undefined)!,
      createProxy(txt('blank', 0, 0, { text: '   ' }), () => undefined)!,
    ]
    const fabric = [createObject(img('fi', 0, 0), () => el)!, createObject(txt('ft', 0, 0, { text: 'Fabric words' }), () => undefined)!]
    const rows = computeLayers([...fabric, ...proxies], [proxies[1]!], (id) => (id === 'a1' ? 'photo.png' : undefined), [])
    expect(rows.map((r) => [r.id, r.kind, r.label, r.selected])).toEqual([
      ['t', 'text', 'A note with lines', true],
      ['i', 'image', 'photo.png', false],
      ['ft', 'text', 'Fabric words', false],
      ['fi', 'image', 'photo.png', false],
    ])
  })
})
