import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import { needsRichFence } from '../model/textDoc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, Scene, StoredAsset, TextRecord } from '../model/types.ts'
import { Editor } from './Editor.ts'
import type { EditorOptions } from './Editor.ts'
import { ProxyRect, idOf } from './objects.ts'
import { DomTextAdapter } from './textAdapter.ts'
import { canvasOf, dragBy, press, release, scaleBy, tick } from './testing/drive.ts'
import type { FakeObject } from './testing/fakeFabric.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore } from './testing/fakes.ts'
import { fabricReference } from './testing/fabricReference.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The text seam (`textAdapter.ts`) and the static scene, driven through the real editor on the
 * fake Fabric. The editor must load, size, transform, format and save through proxies, writing
 * only what the Fabric renderer it replaced read (its frozen reference, `testing/fabricReference.ts`)
 * and writes the same way. The fake models state machines, not layout: card sizes come from
 * `FakeCardMeasurer`, and where things land on screen is proven in `e2e/interleaving.spec.ts`.
 */

const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([7, 8, 9]).buffer })
const F = (id: string, left: number, top: number, width = 400, height = 300): FrameRecord => ({ id, name: `Frame ${id}`, left, top, width, height })
const img = (id: string, left: number, top: number, extra: Partial<ImageRecord> = {}): ImageRecord => ({ type: 'image', id, left, top, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1, ...extra })
const txt = (id: string, left: number, top: number, extra: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id, left, top, angle: 0, text: `${id} words`, fontSize: 20, width: 200, ...extra })

/** A measurer whose line height can change, like a web font arriving late. */
class GrowingMeasurer extends FakeCardMeasurer {
  factor = 1
  override measureHeight(el: HTMLElement, rec: TextRecord): number {
    return super.measureHeight(el, rec) * this.factor
  }
}

let host: HTMLDivElement
const editors: Editor[] = []

async function open(frames: FrameRecord[], objects: ObjectRecord[], options: EditorOptions = { measurer: new FakeCardMeasurer() }) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Seam', frames, objects }
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
  const scene = () => (editor as unknown as { snapshot: () => Scene }).snapshot()
  const rec = (id: string) => scene().objects.find((o) => o.id === id) as TextRecord
  const history = () => (editor as unknown as { history: { current: Scene; canUndo: boolean } }).history
  const handlers = (name: string) => ((canvas as unknown as { handlers: Map<string, unknown[]> }).handlers.get(name) ?? []).length
  return { editor, store, canvas, obj, scene, rec, history, handlers, doc }
}

const dom = (measurer = new FakeCardMeasurer()): EditorOptions => ({ measurer })
const flush = () => vi.advanceTimersByTimeAsync(10_000)

beforeEach(() => {
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

describe('the editor draws through the scene layer', () => {
  it('an editor built without options draws through the scene layer and edits text with the text adapter', async () => {
    const { editor, canvas } = await open([F('F', 0, 0)], [txt('t', 20, 20), img('i', 100, 100)], {})
    expect((editor as unknown as { text: unknown }).text).toBeInstanceOf(DomTextAdapter)
    expect(host.querySelector('.scene-layer')).not.toBeNull()
    expect(canvas.objects.every((o) => o instanceof ProxyRect)).toBe(true)
  })
})

describe('the DOM renderer, static (Slice 2c-i)', () => {
  it('draws the board through the scene layer under the canvas; every object is a proxy sized from the layer', async () => {
    const records = [txt('t', 20, 20, { frameId: 'F', headings: [1] }), img('i', 100, 100, { crop: { x: 10, y: 0, width: 50, height: 60 } }), txt('d', 30, 200, { minHeight: 90 })]
    const { editor, canvas, obj, scene, handlers } = await open([F('F', 0, 0)], records, dom())
    expect((editor as unknown as { text: unknown }).text).toBeInstanceOf(DomTextAdapter)
    const layer = host.querySelector('.scene-layer')!
    expect(layer).not.toBeNull()
    expect(host.firstElementChild).toBe(layer) // under the canvas
    expect(host.style.isolation).toBe('isolate')
    expect(canvas.wrapperEl.style.zIndex).toBe('2')
    expect(handlers('before:render')).toBe(1)
    expect(canvas.objects.every((o) => o instanceof ProxyRect)).toBe(true)
    canvas.renderAll()
    expect([...layer.querySelectorAll('.scene-frames > [data-id]')].map((e) => (e as HTMLElement).dataset.id)).toEqual(['F'])
    expect([...layer.querySelectorAll('.scene-objects > [data-id]')].map((e) => (e as HTMLElement).dataset.id)).toEqual(['t', 'i', 'd'])
    // Text proxies: the measured height (a heading line is 2 × 1.25 font sizes; a drawn box at least its minimum).
    expect(obj('t').height).toBe(50)
    expect(obj('d').height).toBe(90)
    expect([obj('i').width, obj('i').height]).toEqual([50, 60])
    // Loading changes nothing.
    expect(scene()).toEqual({ frames: [F('F', 0, 0)], objects: records })
  })

  it('every item is placed from its proxy`s matrix on each render, and a drag moves only the matrix', async () => {
    const { canvas, obj } = await open([], [txt('t', 20, 20), img('i', 100, 100)], dom())
    canvas.renderAll()
    const el = host.querySelector('[data-id="t"]') as HTMLElement
    const body = el.firstElementChild!.innerHTML
    expect(el.style.transform).toBe('matrix(1, 0, 0, 1, 20, 20)')
    const t = press(canvas, obj('t'))
    dragBy(canvas, t, 30, 5)
    canvas.renderAll()
    expect(el.style.transform).toBe('matrix(1, 0, 0, 1, 50, 25)')
    expect(el.firstElementChild!.innerHTML).toBe(body)
    release(canvas, t)
    await tick()
    canvas.renderAll()
    expect(el.style.transform).toBe('matrix(1, 0, 0, 1, 50, 25)')
  })

  it('a corner scale folds into the card exactly once and the proxy takes the new measured size', async () => {
    const { canvas, obj, rec, history } = await open([], [txt('t', 0, 0, { minHeight: 40 })], dom())
    const t = press(canvas, obj('t'), { action: 'scale', corner: 'br' })
    scaleBy(canvas, t, 1.5)
    release(canvas, t)
    await tick()
    expect(rec('t')).toMatchObject({ fontSize: 30, width: 300, minHeight: 60 })
    expect([obj('t').scaleX, obj('t').scaleY]).toEqual([1, 1])
    expect([obj('t').width, obj('t').height]).toEqual([300, 60]) // max(minHeight 60, one line of 30 × 1.25)
    expect(history().canUndo).toBe(true)
  })

  it('a side handle changes the wrap width live: the card wraps again and the proxy takes its height', async () => {
    const { canvas, obj, rec } = await open([], [txt('t', 0, 0, { text: 'aa bb cc', fontSize: 10, width: 100 })], dom())
    const minimum = (obj('t') as unknown as ProxyRect).minTextWidth
    expect(minimum).toBe(10) // two characters × 10 × 0.5
    const t = press(canvas, obj('t'), { action: 'resizing', corner: 'mr' })
    obj('t').set({ width: 4 }) // narrower than the widest word: stops there
    expect(obj('t').width).toBe(10)
    obj('t').set({ width: 60 })
    t.actionPerformed = true
    canvas.fire('object:resizing', { e: { button: 0 }, target: obj('t'), transform: t })
    expect((host.querySelector('[data-id="t"]') as HTMLElement).style.width).toBe('60px')
    release(canvas, t)
    await tick()
    expect(rec('t').width).toBe(60)
  })

  it('whole-box formatting gives the same records and history as on the Fabric renderer', async () => {
    const records = [txt('t', 10, 10, { text: 'First line\nsecond line', spans: [{ start: 6, end: 10, italic: true, font: 'mono' }] }), txt('d', 10, 200, { minHeight: 50, align: 'right' })]
    const steps: Array<(e: Editor) => void> = [
      (e) => e.toggleMark('bold'),
      (e) => e.toggleMark('underline'),
      (e) => e.setHeading(2),
      (e) => e.toggleMark('bold'),
      (e) => e.setTextFont('serif'),
      (e) => e.setTextAlign('center'),
      (e) => e.setTextColor('#b33a3a'),
      (e) => e.setHeading(0),
      (e) => e.toggleMark('strike'),
      (e) => e.setTextColor('#1d2230'),
      (e) => e.setTextAlign('left'),
      (e) => e.setFontSize(32),
    ]
    const run = async (options: EditorOptions) => {
      const { editor, canvas, obj, scene, history, store } = await open([], records, options)
      const out: unknown[] = []
      for (const id of ['t', 'd']) {
        canvas.setActiveObject(obj(id))
        for (const step of steps) {
          step(editor)
          out.push(scene().objects, history().current.objects, editor.getState().selection?.text)
        }
      }
      await flush()
      out.push(store.saves.at(-1)?.doc.objects, store.saves.length)
      return out
    }
    expect(await run(dom())).toEqual(await fabricReference('script', { records, steps }))
  })

  it('a whole-box command that changes nothing records and saves nothing; a locked text or a read-only board takes none', async () => {
    const { editor, canvas, obj, history, store } = await open([], [txt('t', 0, 0, { headings: [1] }), txt('l', 0, 100, { locked: true })], dom())
    canvas.setActiveObject(obj('t'))
    editor.toggleMark('bold') // a heading's bold is its own
    editor.setHeading(1)
    editor.setTextAlign('left')
    await flush()
    expect(history().canUndo).toBe(false)
    expect(store.saves).toHaveLength(0)
    canvas.setActiveObject(obj('l'))
    editor.toggleMark('italic')
    editor.setFontSize(40)
    await flush()
    expect(history().canUndo).toBe(false)
  })

  it('a larger font that makes a word wider than the box widens it, as a text box does', async () => {
    const { editor, canvas, obj, rec } = await open([], [txt('t', 50, 0, { text: 'supercalifragilistic', fontSize: 20, width: 150 })], dom())
    canvas.setActiveObject(obj('t'))
    editor.setFontSize(24) // 20 characters × 24 × 0.5 = 240
    expect(rec('t')).toMatchObject({ fontSize: 24, width: 240, left: 50 })
    expect(obj('t').width).toBe(240)
  })

  it('a text proxy added to the canvas (here by Make caption) is sized from its card before it is selected or committed', async () => {
    const { editor, canvas, obj, history } = await open([], [img('i', 0, 0), txt('t', 300, 300, { fontSize: 20 })], dom())
    canvas.setActiveObject(obj('i'))
    editor.selectLayer('t', { toggle: true })
    const heights: number[] = []
    const add = canvas.insertAt.bind(canvas)
    canvas.insertAt = (index: number, ...objs: FakeObject[]) => {
      add(index, ...objs)
      heights.push(...objs.map((o) => o.height)) // as soon as it is on the canvas, before selectByIds and commit
    }
    editor.makeCaption()
    expect(heights).toEqual([25]) // one line of 20 × 1.25, not the stored minimum height 0
    expect(obj('t')).toBeInstanceOf(ProxyRect)
    expect(obj('t').height).toBe(25)
    expect(history().current.objects.find((o) => o.id === 't')).toMatchObject({ captionOf: 'i' })
  })

  it('a late font load re-sizes the cards without touching ownership, history or the save state, and waits for a gesture', async () => {
    const fonts = new EventTarget()
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true })
    try {
      const measurer = new GrowingMeasurer()
      // The text's centre is inside F now; three times taller, it would not be.
      const { canvas, obj, rec, history, store } = await open([F('F', 0, 0, 400, 60)], [txt('t', 0, 0, { frameId: 'F' }), img('i', 200, 200)], dom(measurer))
      expect(obj('t').height).toBe(25)
      measurer.factor = 3
      fonts.dispatchEvent(new Event('loadingdone'))
      expect(obj('t').height).toBe(75)
      expect(rec('t').frameId).toBe('F')
      await flush()
      expect(store.saves).toHaveLength(0)
      expect(history().canUndo).toBe(false)

      // During a gesture: nothing changes size until it has settled.
      const t = press(canvas, obj('i'))
      dragBy(canvas, t, 10, 0)
      measurer.factor = 2
      fonts.dispatchEvent(new Event('loadingdone'))
      canvas.renderAll()
      expect(obj('t').height).toBe(75)
      release(canvas, t)
      await tick()
      canvas.renderAll()
      expect(obj('t').height).toBe(50)
      expect(rec('t').frameId).toBe('F')
    } finally {
      delete (document as unknown as { fonts?: unknown }).fonts
    }
  })

  it('undo, redo and a cancelled gesture rebuild the proxies and the layer from records', async () => {
    const { editor, canvas, obj, scene } = await open([], [txt('t', 0, 0)], dom())
    const start = scene()
    canvas.setActiveObject(obj('t'))
    editor.toggleMark('bold')
    canvas.renderAll()
    expect(host.querySelector('[data-id="t"] strong')).not.toBeNull()
    editor.undo()
    canvas.renderAll()
    expect(scene()).toEqual(start)
    expect(host.querySelector('[data-id="t"] strong')).toBeNull()
    expect(obj('t')).toBeInstanceOf(ProxyRect)
    editor.redo()
    canvas.renderAll()
    expect(host.querySelector('[data-id="t"] strong')).not.toBeNull()
    const t = press(canvas, obj('t'))
    dragBy(canvas, t, 40, 0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    canvas.renderAll()
    expect((host.querySelector('[data-id="t"]') as HTMLElement).style.transform).toBe('matrix(1, 0, 0, 1, 0, 0)')
  })

  it('saves only what the Fabric renderer reads and writes the same way, and never needs the version 3 fence', async () => {
    const records = [txt('t', 0, 0, { frameId: 'F', spans: [{ start: 0, end: 1, bold: true }] }), img('i', 100, 100, { crop: { x: 10, y: 0, width: 50, height: 60 }, locked: true }), txt('c', 100, 170, { captionOf: 'i', captionSide: 'left', minHeight: 0, captionBackground: '#fdf3c4' })]
    const a = await open([F('F', 0, 0)], records, dom())
    a.canvas.setActiveObject(a.obj('t'))
    a.editor.toggleMark('italic')
    a.editor.setFontSize(26)
    const t = press(a.canvas, a.obj('t'), { action: 'scale', corner: 'br' })
    scaleBy(a.canvas, t, 1.25)
    release(a.canvas, t)
    await tick()
    await flush()
    const saved = a.store.saves.at(-1)!.doc
    expect(needsRichFence(saved)).toBe(false)
    expect(saved.objects.filter((o) => 'blocks' in o || 'height' in o || 'surface' in o)).toEqual([])
    // Reopened on the Fabric renderer: the same scene. The reference holds the board Fabric was
    // given (what the DOM renderer saved when it was recorded) and the scene Fabric opened from it.
    const fabric = await fabricReference<{ given: BoardDoc; reopened: Scene }>('reopened', { records })
    expect(fabric.reopened.frames).toEqual(fabric.given.frames)
    expect(fabric.reopened.objects).toEqual(fabric.given.objects)
    expect(saved.frames).toEqual(fabric.given.frames)
    expect(saved.objects).toEqual(fabric.given.objects)
  })
})
