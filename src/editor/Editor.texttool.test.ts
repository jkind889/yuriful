import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, TextRecord, Viewport } from '../model/types.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { canvasOf, moveCanvas, press, pressCanvas, release, releaseCanvas, tick } from './testing/drive.ts'
import type { Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore, deferred } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The Text tool's drag on the fake canvas: when a draft starts, what cancels it, what the
 * board does while it is in progress, and the box its release makes (in a microtask, one per
 * press, blank until typed into). Where real Fabric sends its events, and what the box looks
 * like, is only accepted on real-browser evidence (e2e/texttool.spec.ts).
 */

const image: ImageRecord = { type: 'image', id: 'img', left: 900, top: 900, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 }
const frame: FrameRecord = { id: 'F', name: 'Spread', left: 0, top: 0, width: 500, height: 400 }
const UNIT: Viewport = { zoom: 1, panX: 0, panY: 0 }

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
const png = () => new File([new Uint8Array([1, 2, 3])], 'drop.png', { type: 'image/png' })

async function setup(opts: { frames?: FrameRecord[]; viewport?: Viewport; load?: boolean } = {}) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Text tool', frames: opts.frames ?? [], objects: [image], viewport: opts.viewport ?? UNIT }
  const store = new SpyStore({ doc, assets: new Map([['a1', { id: 'a1', name: 'a1.png', type: 'image/png', bytes: new Uint8Array([1]).buffer }]]) })
  store.holdLoad = opts.load === false
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  const ready = editor.init()
  if (opts.load !== false) await ready
  const canvas = canvasOf(editor)
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc()
  const texts = () => canvas.objects.filter((o) => (o as { text?: unknown }).text !== undefined) as Textbox[]
  const busy = () => (editor as unknown as { gesture: unknown }).gesture !== null
  /** A Text-tool drag from one scene point to another, released; settlement has run afterwards. */
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    pressCanvas(canvas, x0, y0)
    moveCanvas(canvas, (x0 + x1) / 2, (y0 + y1) / 2)
    moveCanvas(canvas, x1, y1)
    releaseCanvas(canvas, x1, y1)
    await tick()
    return texts().at(-1)
  }
  return { editor, store, canvas, scene, texts, busy, drag, ready }
}

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

describe('dragging out a text box', () => {
  it('the box takes the drag\'s geometry; blank and being edited; back to Select', async () => {
    const { editor, canvas, scene, texts, busy } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    expect(busy()).toBe(true)
    moveCanvas(canvas, 400, 250)
    expect(canvas.draft).toEqual({ left: 100, top: 100, width: 300, height: 150 }) // drawn while dragging
    releaseCanvas(canvas, 400, 250)
    expect(texts()).toHaveLength(0) // nothing is created inside Fabric's callback
    await tick()
    expect(canvas.draft).toBeNull()
    expect(busy()).toBe(false)
    const tb = texts()[0] as Textbox
    expect(texts()).toHaveLength(1)
    expect(tb).toMatchObject({ left: 100, top: 100, width: 300, fontSize: 24, isEditing: true, text: '' })
    expect(tb.height).toBe(150)
    expect(editor.getState().tool).toBe('select')
    expect(canvas.getActiveObject()).toBe(tb)
    expect(scene().objects).toHaveLength(1) // blank: not in the scene
    tb.type('Hello')
    expect(scene().objects.at(-1)).toMatchObject({ type: 'text', text: 'Hello', left: 100, top: 100, width: 300, minHeight: 150, fontSize: 24 })
  })

  it('runs from the smaller x and y whatever the direction', async () => {
    const { editor, drag } = await setup()
    editor.setTool('text')
    expect(await drag(400, 300, 100, 100)).toMatchObject({ left: 100, top: 100, width: 300 })
    editor.setTool('text')
    expect(await drag(400, 100, 100, 300)).toMatchObject({ left: 100, top: 100, width: 300 })
  })

  it('a drag narrower than two font sizes is no usable width: the default box at the press point, whatever its direction or height', async () => {
    const { editor, drag } = await setup()
    const at = async (x0: number, y0: number, x1: number, y1: number) => {
      editor.setTool('text')
      return drag(x0, y0, x1, y1)
    }
    const DEFAULT = { width: 240, fontSize: 24 }
    expect(await at(300, 300, 304, 303)).toMatchObject({ left: 300, top: 300, ...DEFAULT }) // a wobble past the slop
    expect(await at(100, 100, 110, 300)).toMatchObject({ left: 100, top: 100, ...DEFAULT }) // mostly vertical, down
    expect(await at(100, 300, 110, 100)).toMatchObject({ left: 100, top: 300, ...DEFAULT }) // mostly vertical, up: still at the press point
    expect(await at(100, 100, 100, 300)).toMatchObject({ left: 100, top: 100, ...DEFAULT }) // straight down
    expect(await at(100, 100, 60, 200)).toMatchObject({ left: 100, top: 100, ...DEFAULT }) // narrow, leftward
    expect(await at(100, 100, 147.9, 120)).toMatchObject({ left: 100, top: 100, ...DEFAULT }) // just under the threshold
    expect(await at(100, 100, 148, 120)).toMatchObject({ left: 100, top: 100, width: 48 }) // exactly two font sizes: the dragged width
    expect(await at(100, 100, 52, 80)).toMatchObject({ left: 52, top: 80, width: 48 }) // the same, leftward and upward
  })

  it('a drag shorter than the click slop (in screen pixels) is a click: today\'s default box at the press point', async () => {
    const { editor, drag } = await setup()
    editor.setTool('text')
    expect(await drag(100, 100, 102, 102)).toMatchObject({ left: 100, top: 100, width: 240, fontSize: 24 })
  })

  it('zoomed in and out: the width is in scene units, the slop in screen pixels, the font size as for a click', async () => {
    const zoomedIn = await setup({ viewport: { zoom: 4, panX: 0, panY: 0 } })
    zoomedIn.editor.setTool('text')
    expect(await zoomedIn.drag(10, 10, 10.9, 10.4)).toMatchObject({ width: 120, fontSize: 12 }) // under 4 px on screen: a click
    zoomedIn.editor.setTool('text')
    expect(await zoomedIn.drag(10, 10, 60, 20)).toMatchObject({ left: 10, top: 10, width: 50, fontSize: 12 })
    zoomedIn.editor.setTool('text')
    expect(await zoomedIn.drag(10, 10, 33, 60)).toMatchObject({ left: 10, top: 10, width: 120, fontSize: 12 }) // 23 < 24 units wide: the default box
    zoomedIn.editor.setTool('text')
    expect(await zoomedIn.drag(10, 10, 34, 60)).toMatchObject({ left: 10, top: 10, width: 24 })
    const zoomedOut = await setup({ viewport: { zoom: 0.25, panX: 0, panY: 0 } })
    zoomedOut.editor.setTool('text')
    expect(await zoomedOut.drag(0, 0, 1000, 400)).toMatchObject({ width: 1000, fontSize: 96 })
    zoomedOut.editor.setTool('text')
    expect(await zoomedOut.drag(0, 0, 100, 400)).toMatchObject({ left: 0, top: 0, width: 960 }) // 100 < 192 units wide: the default box
    zoomedOut.editor.setTool('text')
    expect(await zoomedOut.drag(0, 0, 192, 400)).toMatchObject({ left: 0, top: 0, width: 192 })
  })

  it('a click is the press and its release: the default box at the press point; a release with no press in front of it makes nothing', async () => {
    const { editor, canvas, texts } = await setup()
    editor.setTool('text')
    canvas.fire('mouse:up', { e: { button: 0, clientX: 40, clientY: 50 }, isClick: true }) // real Fabric always fires the press first
    await tick()
    expect(texts()).toHaveLength(0)
    pressCanvas(canvas, 40, 50)
    canvas.fire('mouse:up', { e: { button: 0, clientX: 40, clientY: 50 }, isClick: true })
    await tick()
    expect(texts()).toHaveLength(1)
    expect(texts()[0]).toMatchObject({ left: 40, top: 50, width: 240 })
  })

  it('one text per press, and the tool is single-use: a second drag right after selects nothing and makes nothing', async () => {
    const { editor, canvas, texts, busy, drag } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    moveCanvas(canvas, 300, 200)
    canvas.fire('mouse:up', { e: { button: 0, clientX: 300, clientY: 200 }, isClick: true }) // even if Fabric called it a click
    await tick()
    expect(texts()).toHaveLength(1)
    texts()[0]!.exitEditing()
    await tick()
    await drag(100, 100, 300, 200) // the Select tool now
    expect(busy()).toBe(false)
    expect(texts()).toHaveLength(0) // the blank text was discarded, and nothing new
    void editor
  })

  it('a box dragged out inside a frame belongs to it; one whose centre is outside does not', async () => {
    const { editor, scene, drag } = await setup({ frames: [frame] })
    editor.setTool('text')
    const inside = (await drag(300, 100, 450, 150)) as Textbox // centre (375, ...) inside, though a click there would not be
    inside.type('in')
    inside.exitEditing()
    editor.setTool('text')
    const outside = (await drag(300, 200, 800, 250)) as Textbox // centre (550, ...) outside
    outside.type('out')
    outside.exitEditing()
    const recs = scene().objects.filter((o): o is TextRecord => o.type === 'text')
    expect(recs.map((r) => [r.text, r.frameId])).toEqual([
      ['in', 'F'],
      ['out', undefined],
    ])
  })

  it('typing into a dragged box and leaving is one undo step; redo restores it with its width', async () => {
    const { editor, scene, drag } = await setup()
    editor.setTool('text')
    const tb = (await drag(100, 100, 260, 120)) as Textbox
    tb.type('Words')
    tb.exitEditing()
    const made = scene().objects.at(-1)
    expect(made).toMatchObject({ text: 'Words', width: 160 })
    editor.undo()
    expect(scene().objects).toEqual([image])
    expect(editor.getState().canUndo).toBe(false)
    editor.redo()
    expect(scene().objects.at(-1)).toStrictEqual(made)
  })
})

describe('when a draft starts', () => {
  it('only with the Text tool, the primary button, on empty canvas, the hand not in effect, and the board loaded', async () => {
    const { editor, canvas, busy } = await setup()
    pressCanvas(canvas, 100, 100) // the Select tool
    expect(busy()).toBe(false)
    editor.setTool('text')
    pressCanvas(canvas, 100, 100, 2) // another button
    pressCanvas(canvas, 100, 100, 1)
    expect(busy()).toBe(false)
    canvas.fire('mouse:down', { e: { button: 0, clientX: 905, clientY: 905 }, target: canvas.objects[0] }) // on an object: Fabric's as before
    expect(busy()).toBe(false)
    window.dispatchEvent(key(' ', { code: 'Space' })) // Space held: the hand
    pressCanvas(canvas, 100, 100)
    expect(busy()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space' }))
    pressCanvas(canvas, 100, 100)
    expect(busy()).toBe(true)
  })

  it('a press on an object with the Text tool still starts Fabric\'s own transform, and creates no text', async () => {
    const { editor, canvas, texts } = await setup()
    editor.setTool('text')
    const t = press(canvas, canvas.objects[0]!)
    release(canvas, t)
    await tick()
    expect(texts()).toHaveLength(0)
    expect(editor.getState().tool).toBe('text')
  })

  it('before the board has loaded: nothing starts', async () => {
    const { editor, canvas, busy, texts, ready, store } = await setup({ load: false })
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    releaseCanvas(canvas, 300, 200)
    await tick()
    expect(busy()).toBe(false)
    expect(texts()).toHaveLength(0)
    store.gate.resolve(null) // let the load finish (as an empty board)
    await ready
  })
})

describe('while a draft is in progress, and cancelling it', () => {
  it('the board is busy: saves see the scene from before, commands wait, other buttons neither finish nor cancel it', async () => {
    const { editor, store, canvas, texts, busy } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    moveCanvas(canvas, 300, 200)
    editor.setTitle('Renamed') // the title stays editable and is saved
    editor.addFrame() // commands wait
    editor.addText()
    window.dispatchEvent(key('f'))
    releaseCanvas(canvas, 300, 200, 2) // a right-button release
    releaseCanvas(canvas, 300, 200, 1)
    await flush()
    expect(busy()).toBe(true)
    expect(store.saves.at(-1)?.doc).toMatchObject({ title: 'Renamed', frames: [], objects: [image] })
    expect(canvas.objects).toHaveLength(1)
    releaseCanvas(canvas, 300, 200)
    await tick()
    expect(texts()).toHaveLength(1)
  })

  it('a save in flight when the draft starts stores nothing of it', async () => {
    const { editor, store, canvas, texts } = await setup()
    editor.setTitle('A')
    store.saveGate = deferred<void>()
    await vi.advanceTimersByTimeAsync(600)
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    moveCanvas(canvas, 300, 200)
    store.saveGate.resolve()
    store.saveGate = null
    await flush()
    expect(store.attempts.every((a) => a.doc.objects.length === 1)).toBe(true)
    releaseCanvas(canvas, 300, 200)
    await tick()
    texts()[0]!.type('typed')
    await flush()
    expect(store.saves.at(-1)?.doc.objects).toHaveLength(2)
  })

  for (const [how, cancel] of [
    ['Esc', () => window.dispatchEvent(key('Escape'))],
    ['a window blur', () => window.dispatchEvent(new Event('blur'))],
  ] as const) {
    it(`${how} cancels it: no text, no history, no save; Esc also leaves the Text tool`, async () => {
      const { editor, store, canvas, texts, busy } = await setup()
      editor.setTool('text')
      pressCanvas(canvas, 100, 100)
      moveCanvas(canvas, 300, 200)
      cancel()
      expect(busy()).toBe(false)
      expect(canvas.draft).toBeNull()
      releaseCanvas(canvas, 300, 200) // the release that follows does nothing
      await tick()
      await flush()
      expect(texts()).toHaveLength(0)
      expect(editor.getState().canUndo).toBe(false)
      expect(store.saves).toHaveLength(0)
      expect(editor.getState().tool).toBe(how === 'Esc' ? 'select' : 'text')
    })
  }

  it('the board going read-only cancels it', async () => {
    const { editor, store, canvas, texts, busy } = await setup()
    editor.setTitle('A')
    store.saveError = new BoardConflictError()
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    moveCanvas(canvas, 300, 200)
    await flush() // the title save meets the conflict
    expect(editor.getState().readOnly).not.toBeNull()
    expect(busy()).toBe(false)
    expect(canvas.draft).toBeNull()
    releaseCanvas(canvas, 300, 200)
    await tick()
    expect(texts()).toHaveLength(0)
  })

  it('an image import that finishes during the drag is added first, as its own step; the new box is still being edited', async () => {
    const { editor, canvas, texts, scene } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    moveCanvas(canvas, 300, 200)
    await editor.addImageFiles([png()])
    expect(canvas.objects).toHaveLength(1) // waits
    releaseCanvas(canvas, 300, 200)
    await tick()
    expect(scene().objects.filter((o) => o.type === 'image')).toHaveLength(2)
    const tb = texts()[0] as Textbox
    expect(tb.isEditing).toBe(true)
    expect(canvas.getActiveObject()).toBe(tb)
    tb.type('note')
    tb.exitEditing()
    editor.undo() // the text
    expect(scene().objects.filter((o) => o.type === 'text')).toHaveLength(0)
    expect(scene().objects).toHaveLength(2)
    editor.undo() // the import
    expect(scene().objects).toEqual([image])
  })

  it('a dragged box left blank is discarded with no trace', async () => {
    const { editor, store, texts, drag, canvas } = await setup()
    editor.setTool('text')
    const tb = (await drag(100, 100, 300, 200)) as Textbox
    tb.exitEditing()
    await tick()
    await flush()
    expect(texts()).toHaveLength(0)
    expect(canvas.objects).toHaveLength(1)
    expect(editor.getState().canUndo).toBe(false)
    expect(store.saves).toHaveLength(0)
  })
})
