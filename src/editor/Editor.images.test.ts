import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, StoredAsset, TextRecord } from '../model/types.ts'
import { CONFLICT_MESSAGE } from '../persistence/autosave.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { idOf } from './objects.ts'
import { canvasOf, dragBy, press, release, tick } from './testing/drive.ts'
import { ActiveSelection } from './testing/fakeFabric.ts'
import type { Canvas, FakeObject } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore, deferred } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * Crop mode, Fit and Fill on the fake canvas: the crop session's state machine, what a save
 * sees, history, ownership and the lifecycle cases. The fake has no rotation and draws
 * nothing, so where the pixels land on screen (also rotated) is proven in the browser
 * (e2e/images.spec.ts).
 *
 * The fake decodes every image as 200 x 100 source pixels, and the fake canvas reads a mouse
 * event's clientX/clientY as scene coordinates. Image P sits at (100, 50) at scale 1, so a
 * source pixel (u, v) is at scene (100 + u, 50 + v) while it is uncropped.
 */
const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([7, 8, 9]).buffer })
const F = (id: string, left: number, top: number, width = 400, height = 300, extra: Partial<FrameRecord> = {}): FrameRecord => ({ id, name: `Frame ${id}`, left, top, width, height, ...extra })
const img = (id: string, left: number, top: number, extra: Partial<ImageRecord> = {}): ImageRecord => ({
  type: 'image',
  id,
  left,
  top,
  angle: 0,
  assetId: 'a1',
  scaleX: 1,
  scaleY: 1,
  ...extra,
})
const txt = (id: string, left: number, top: number): TextRecord => ({ type: 'text', id, left, top, angle: 0, text: id, fontSize: 24, width: 200 })
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
const png = () => new File([new Uint8Array([1, 2, 3])], 'drop.png', { type: 'image/png' })

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function board(frames: FrameRecord[], objects: ObjectRecord[], opts: { load?: boolean } = {}) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Images', frames, objects }
  const store = new SpyStore(frames.length + objects.length > 0 ? { doc, assets: new Map([['a1', asset('a1')]]) } : null)
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  const canvas = canvasOf(editor)
  if (opts.load !== false) {
    store.holdLoad = false
    await editor.init()
  }
  return helpers(editor, store, canvas)
}

function helpers(editor: Editor, store: SpyStore, canvas: Canvas) {
  const obj = (id: string): FakeObject => {
    const found = canvas.objects.find((o) => idOf(o as never) === id)
    if (!found) throw new Error(`no object ${id} on the canvas`)
    return found
  }
  const doc = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc()
  /** The live canvas as records (not what a save would see while a crop is open). */
  const live = () => (editor as unknown as { snapshot: () => { objects: ObjectRecord[] } }).snapshot()
  const rec = (id: string) => {
    const found = doc().objects.find((o) => o.id === id)
    if (!found) throw new Error(`no record ${id}`)
    return found as ImageRecord
  }
  const cropping = () => editor.getState().cropping
  const canUndo = () => editor.getState().canUndo
  /** Whether history itself holds a step (the Undo button is also enabled for a changed open crop). */
  const committed = () => (editor as unknown as { history: { canUndo: boolean } }).history.canUndo
  const sel = () => editor.getState().selection
  const activeIds = () => canvas.getActiveObjects().map((o) => idOf(o as never))
  const lastSaved = (id: string) => store.saves.at(-1)?.doc.objects.find((o) => o.id === id) as ImageRecord | undefined
  return { editor, store, canvas, obj, doc, live, rec, cropping, canUndo, committed, sel, activeIds, lastSaved }
}

// ---- mouse, as a real browser reports it ------------------------------------------------------

const bit = (button: number) => (button === 0 ? 1 : button === 1 ? 4 : 2)
let held = 0
function down(canvas: Canvas, x: number, y: number, button = 0) {
  held |= bit(button)
  canvas.upperCanvasEl.dispatchEvent(new MouseEvent('mousedown', { button, buttons: held, bubbles: true, cancelable: true, clientX: x, clientY: y }))
}
function moveTo(x: number, y: number) {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: held }))
}
function up(x: number, y: number, button = 0) {
  held &= ~bit(button)
  document.body.dispatchEvent(new MouseEvent('mouseup', { button, buttons: held, bubbles: true, cancelable: true, clientX: x, clientY: y }))
}
function dragCrop(canvas: Canvas, from: [number, number], to: [number, number]) {
  down(canvas, ...from)
  moveTo(...to)
  up(...to)
}
/** The Fabric presses that reached the canvas element (the editor's capture listener did not stop them). */
function fabricSees(canvas: Canvas) {
  const seen: number[] = []
  canvas.upperCanvasEl.addEventListener('mousedown', (e) => seen.push(e.button))
  return seen
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

describe('starting crop mode (M1, M11)', () => {
  it('opens on one selected unlocked image: the whole original is shown in place, with Fabric handles hidden', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 60 } })])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    expect(b.cropping()).toBe(true)
    // The kept pixels stay where they were: the original's (0, 0) moves back by the crop's corner.
    expect(b.obj('P')).toMatchObject({ cropX: 0, cropY: 0, width: 200, height: 100, left: 80, top: 40, hasControls: false, hasBorders: false })
    expect(b.canvas.skipTargetFind).toBe(true)
    expect(b.canvas.selection).toBe(false)
    // Still selected, so the inspector shows the crop panel.
    expect(b.activeIds()).toEqual(['P'])
  })

  it('is inert for a locked image, a multi-selection, a text, a frame, nothing selected, and while a gesture is unsettled', async () => {
    const b = await board([F('A', 0, 400)], [img('L', 0, 0, { locked: true }), img('P', 100, 50), img('Q', 400, 50), txt('t', 0, 300)])
    const tryCrop = () => {
      b.editor.startCrop()
      const was = b.cropping()
      b.editor.cancelCrop()
      return was
    }
    expect(tryCrop()).toBe(false) // nothing selected
    b.editor.selectLayer('L')
    expect(tryCrop()).toBe(false)
    expect(b.sel()?.image).toEqual({ cropped: false, canFit: false, canFill: false })
    b.editor.selectLayer('t')
    expect(tryCrop()).toBe(false)
    expect(b.sel()?.image).toBeNull()
    b.editor.selectLayer('A')
    expect(tryCrop()).toBe(false)
    b.editor.selectLayer('P')
    b.editor.selectLayer('Q', { toggle: true })
    expect(tryCrop()).toBe(false)
    expect(b.sel()?.image).toBeNull()

    b.editor.selectLayer('P')
    const t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 5, 0)
    expect(tryCrop()).toBe(false) // busy
    release(b.canvas, t)
    await tick()
    expect(tryCrop()).toBe(true)
  })

  it('is inert before the stored board has loaded and on a read-only board', async () => {
    const b = await board([], [img('P', 100, 50)], { load: false })
    b.editor.startCrop()
    expect(b.cropping()).toBe(false)
    b.store.releaseLoad()
    await b.editor.init()
    b.editor.selectLayer('P')
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    b.canvas.setActiveObject(b.obj('P'))
    b.editor.startCrop()
    expect(b.cropping()).toBe(false)
  })

  it('switches the Text, Frame or Hand tool to Select', async () => {
    for (const tool of ['text', 'frame', 'hand'] as const) {
      const b = await board([], [img('P', 100, 50)])
      b.editor.selectLayer('P')
      b.editor.setTool(tool)
      b.canvas.setActiveObject(b.obj('P'))
      b.editor.startCrop()
      expect(b.cropping()).toBe(true)
      expect(b.editor.getState().tool).toBe('select')
    }
  })
})

describe('dragging and applying (M3, M5)', () => {
  it('a corner, then a side: Enter applies one history step, kept pixels stay put, scale unchanged; undo and redo', async () => {
    const b = await board([], [img('P', 100, 50, { frameId: undefined })])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [250, 120]) // bottom-right corner: source (200,100) -> (150,70)
    dragCrop(b.canvas, [100, 90], [130, 90]) // left side: x 0 -> 30
    expect(b.committed()).toBe(false) // nothing in history yet (the Undo button is enabled: it would apply the crop first)
    window.dispatchEvent(key('Enter'))
    expect(b.cropping()).toBe(false)
    const after = b.rec('P')
    expect(after).toEqual(img('P', 130, 50, { crop: { x: 30, y: 0, width: 120, height: 70 } }))
    expect(b.obj('P')).toMatchObject({ hasControls: true, hasBorders: true })
    expect(b.activeIds()).toEqual(['P'])
    expect(b.canUndo()).toBe(true)

    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
    expect(b.rec('P')).not.toHaveProperty('crop')
    expect(b.canUndo()).toBe(false)
    b.editor.redo()
    expect(b.rec('P')).toEqual(after)
  })

  it('a drag inside the box moves it; the rectangle stays inside the image, never flips and keeps 8 units', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 50, y: 25, width: 100, height: 50 } })])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    // The whole original now lies at (50, 25); the box covers scene x 100..200, y 50..100.
    dragCrop(b.canvas, [150, 75], [900, 900]) // move far right/down: clamped to the image
    dragCrop(b.canvas, [250, 100], [-500, 100]) // the right side (now at x 250) past the left one: stops 8 units short
    b.editor.applyCrop()
    expect(b.rec('P').crop).toEqual({ x: 100, y: 50, width: 8, height: 50 })
    expect(b.rec('P')).toMatchObject({ left: 150, top: 75, scaleX: 1, scaleY: 1 })
  })

  it('applying a crop equal to the one it started with records nothing and saves nothing', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 60 } })])
    b.editor.selectLayer('P')
    const before = b.rec('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [150, 80], [170, 80]) // move the box right ...
    dragCrop(b.canvas, [170, 80], [150, 80]) // ... and back
    b.editor.applyCrop()
    expect(b.rec('P')).toEqual(before)
    expect(b.obj('P')).toMatchObject({ cropX: 20, cropY: 10, width: 100, height: 60, left: 100, top: 50 })
    await flush()
    expect(b.canUndo()).toBe(false)
    expect(b.store.attempts).toHaveLength(0)
  })

  it('a press outside the crop box applies it and does nothing else; Fabric never sees a press', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    const seen = fabricSees(b.canvas)
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    down(b.canvas, 450, 100) // on Q
    up(450, 100)
    expect(b.cropping()).toBe(false)
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(b.activeIds()).toEqual(['P']) // the press did not select Q
    expect(seen).toEqual([]) // stopped before Fabric (the listener above runs after the editor's capture one)
    // Back to normal: the next press reaches Fabric.
    down(b.canvas, 450, 100)
    up(450, 100)
    expect(seen).toEqual([0])
  })

  it('Esc and the Cancel command restore the image exactly: no history, no save', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 60 } })])
    b.editor.selectLayer('P')
    const before = b.rec('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [100, 50], [140, 70])
    window.dispatchEvent(key('Escape'))
    expect(b.cropping()).toBe(false)
    expect(b.rec('P')).toEqual(before)
    expect(b.obj('P')).toMatchObject({ cropX: 20, cropY: 10, width: 100, height: 60, left: 100, top: 50, hasControls: true })
    b.editor.startCrop()
    dragCrop(b.canvas, [100, 50], [140, 70])
    b.editor.cancelCrop()
    expect(b.rec('P')).toEqual(before)
    await flush()
    expect(b.canUndo()).toBe(false)
    expect(b.store.attempts).toHaveLength(0)
    expect(b.activeIds()).toEqual(['P'])
  })

  it('three crops in a row (shrink, shift, grow back to whole): exact records, crop key gone at the end', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [100, 50], [140, 70]) // top-left corner in
    b.editor.applyCrop()
    expect(b.rec('P')).toEqual(img('P', 140, 70, { crop: { x: 40, y: 20, width: 160, height: 80 } }))

    b.editor.startCrop() // whole original again, in place
    expect(b.obj('P')).toMatchObject({ left: 100, top: 50, width: 200, height: 100 })
    dragCrop(b.canvas, [200, 100], [180, 90]) // move the box
    b.editor.applyCrop()
    expect(b.rec('P')).toEqual(img('P', 120, 60, { crop: { x: 20, y: 10, width: 160, height: 80 } }))

    b.editor.startCrop()
    dragCrop(b.canvas, [120, 60], [0, 0]) // top-left out to the corner
    dragCrop(b.canvas, [280, 140], [999, 999]) // bottom-right out to the corner
    b.editor.applyCrop()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
    expect(b.rec('P')).not.toHaveProperty('crop')
    await flush()
    expect(b.lastSaved('P')).toEqual(img('P', 100, 50))
    expect(JSON.stringify(b.store.saves.at(-1)!.doc)).not.toContain('crop')

    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 120, 60, { crop: { x: 20, y: 10, width: 160, height: 80 } }))
  })

  it('a scaled image: the minimum side is 8 units on the board, and positions follow the scale', async () => {
    const b = await board([], [img('P', 100, 50, { scaleX: 0.5, scaleY: 0.5 })]) // shown 100 x 50
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [100, 50], [400, 400]) // the top-left corner past the bottom-right one
    b.editor.applyCrop()
    expect(b.rec('P')).toEqual(img('P', 192, 92, { scaleX: 0.5, scaleY: 0.5, crop: { x: 184, y: 84, width: 16, height: 16 } }))
  })
})

describe('what a save sees (M6)', () => {
  it('while a crop is open a save stores the board from before it (title and viewport live); applying stores the crop', async () => {
    // Already cropped, so the temporarily un-cropped canvas differs from the stored record.
    const crop = { x: 20, y: 10, width: 100, height: 60 }
    const b = await board([], [img('P', 100, 50, { crop })])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    expect(b.live().objects).toEqual([img('P', 80, 40)]) // the canvas holds the whole original for now
    dragCrop(b.canvas, [200, 110], [180, 100]) // the box's bottom-right corner (whole original at 80, 40)
    b.editor.setTitle('Renamed mid-crop')
    b.editor.zoomBy(2)
    await flush() // the autosave debounce fires during crop mode
    const saved = b.store.saves.at(-1)!.doc
    expect(saved.title).toBe('Renamed mid-crop')
    expect(saved.viewport.zoom).toBe(2)
    expect(saved.objects).toEqual([img('P', 100, 50, { crop })])
    expect(b.cropping()).toBe(true) // the save did not end crop mode

    b.editor.applyCrop()
    await flush()
    expect(b.lastSaved('P')).toEqual(img('P', 100, 50, { crop: { x: 20, y: 10, width: 80, height: 50 } }))
  })

  it('a save already in flight when the crop is applied: the crop is saved after it', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    b.store.saveGate = deferred<void>()
    b.editor.setTitle('slow')
    await flush()
    expect(b.store.attempts).toHaveLength(1)
    dragCrop(b.canvas, [300, 150], [200, 150])
    b.editor.applyCrop()
    const gate = b.store.saveGate
    b.store.saveGate = null
    gate.resolve()
    await flush()
    expect(b.store.saves[0]!.doc.objects).toEqual([img('P', 100, 50)])
    expect(b.lastSaved('P')?.crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })
})

describe('keys and commands during crop mode (M7, M8)', () => {
  it('only Esc, Enter, the zoom keys and Space respond; every other shortcut is ignored', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    const picker = vi.fn()
    b.editor.setImagePicker(picker)
    for (const k of [
      key('Delete'),
      key('Backspace'),
      key('z', { ctrlKey: true }),
      key('z', { ctrlKey: true, shiftKey: true }),
      key(']'),
      key('[', { ctrlKey: true }),
      key('L', { ctrlKey: true, shiftKey: true }),
      key('a', { ctrlKey: true }),
      key('v'),
      key('t'),
      key('f'),
      key('h'),
      key('i'),
    ]) {
      window.dispatchEvent(k)
    }
    expect(b.cropping()).toBe(true)
    expect(b.editor.getState().tool).toBe('select')
    expect(picker).not.toHaveBeenCalled()
    expect(b.live().objects.map((o) => o.id)).toEqual(['P', 'Q'])
    window.dispatchEvent(key('+'))
    expect(b.editor.getState().viewport.zoom).toBeCloseTo(1.25)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    expect(b.editor.getState().handActive).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))
    expect(b.cropping()).toBe(true)
    expect(b.committed()).toBe(false) // nothing in history yet (the Undo button is enabled: it would apply the crop first)
  })

  it('Enter typed in a field or on a button does not apply the crop; Esc in a field does not cancel it', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    const input = document.createElement('input')
    const button = document.createElement('button')
    document.body.append(input, button)
    input.dispatchEvent(key('Enter'))
    input.dispatchEvent(key('Escape'))
    button.dispatchEvent(key('Enter')) // the button's own click decides (e.g. Cancel)
    input.remove()
    button.remove()
    expect(b.cropping()).toBe(true)
    expect(b.committed()).toBe(false) // nothing in history yet (the Undo button is enabled: it would apply the crop first)
  })

  it('undo during crop mode applies the crop first, then undoes it; redo re-applies', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    b.editor.undo()
    expect(b.cropping()).toBe(false)
    expect(b.rec('P')).toEqual(img('P', 100, 50))
    expect(b.editor.getState().canRedo).toBe(true)
    b.editor.redo()
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('a layer row applies the crop, then selects; a padlock and a tool button apply it first too', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    b.editor.selectLayer('Q')
    expect(b.cropping()).toBe(false)
    expect(b.activeIds()).toEqual(['Q'])
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })

    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [100, 50], [120, 50])
    b.editor.toggleLayerLock('P')
    expect(b.cropping()).toBe(false)
    expect(b.rec('P')).toMatchObject({ locked: true, crop: { x: 20, y: 0, width: 80, height: 100 } })
    b.editor.undo() // the lock
    expect(b.rec('P')).not.toHaveProperty('locked')
    expect(b.rec('P').crop).toEqual({ x: 20, y: 0, width: 80, height: 100 })

    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [120, 50], [140, 50])
    b.editor.setTool('text')
    expect(b.cropping()).toBe(false)
    expect(b.rec('P').crop).toEqual({ x: 40, y: 0, width: 60, height: 100 })
  })

  it('an image import finishing during crop mode applies the crop as its own step, then adds the image', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    await b.editor.addImageFiles([png()])
    expect(b.cropping()).toBe(false)
    expect(b.canvas.objects).toHaveLength(2)
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    b.editor.undo() // the import
    expect(b.canvas.objects).toHaveLength(1)
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    b.editor.undo() // the crop
    expect(b.rec('P')).toEqual(img('P', 100, 50))
  })

  it('an import finishing during a handle drag ends the drag where it is, applies, then adds', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    down(b.canvas, 300, 150)
    moveTo(250, 150)
    await b.editor.addImageFiles([png()])
    expect(b.cropping()).toBe(false)
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 150, height: 100 })
    moveTo(150, 150) // the old drag is over
    up(150, 150)
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 150, height: 100 })
    expect(b.canvas.objects).toHaveLength(2)
  })
})

describe('interruptions (M9)', () => {
  it('a window blur during a handle drag returns that drag to where it began; crop mode stays open', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [250, 150]) // a finished drag: kept
    down(b.canvas, 100, 50)
    moveTo(150, 80)
    window.dispatchEvent(new Event('blur'))
    expect(b.cropping()).toBe(true)
    moveTo(180, 90) // the drag is over
    up(180, 90)
    window.dispatchEvent(new Event('blur')) // no drag in flight: changes nothing
    expect(b.cropping()).toBe(true)
    b.editor.applyCrop()
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 150, height: 100 })
  })

  it('other buttons never start, move or end a handle drag; a middle press mid-drag does not pan', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    down(b.canvas, 300, 150, 2) // right button on a handle: nothing
    moveTo(200, 150)
    up(200, 150, 2)
    down(b.canvas, 300, 150) // primary drag
    moveTo(280, 150)
    down(b.canvas, 280, 150, 1) // middle pressed mid-drag
    moveTo(260, 150)
    up(260, 150, 1) // and released: the drag goes on
    moveTo(250, 150)
    expect(b.editor.getState().viewport.panX).toBe(0)
    up(250, 150)
    moveTo(100, 150) // over: no effect
    b.editor.applyCrop()
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 150, height: 100 })
  })

  it('a primary release that never arrives: the next move without the button ends the drag where it is', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    down(b.canvas, 300, 150)
    moveTo(250, 150)
    held = 0 // released outside the window
    moveTo(150, 150)
    moveTo(120, 150)
    b.editor.applyCrop()
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 150, height: 100 })
  })

  it('a press while a drag still believes the button is held ends that drag first', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    down(b.canvas, 300, 150)
    moveTo(250, 150)
    held = 0 // the release was lost and no move has told us yet
    down(b.canvas, 100, 100) // on the left side: a new drag
    moveTo(120, 100)
    up(120, 100)
    b.editor.applyCrop()
    expect(b.rec('P').crop).toEqual({ x: 20, y: 0, width: 130, height: 100 })
  })

  it('the board going read-only mid-crop (and mid-drag) cancels it: the pre-crop scene, nothing saved', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 60 } })])
    b.editor.selectLayer('P')
    b.editor.startCrop() // the whole original at (80, 40); the box spans scene x 100..200, y 50..110
    dragCrop(b.canvas, [200, 110], [180, 100]) // a finished drag of the bottom-right corner
    down(b.canvas, 100, 50) // the top-left corner, held
    moveTo(120, 60)
    expect(b.cropping()).toBe(true)
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    expect(b.cropping()).toBe(false)
    expect(b.live().objects).toEqual([img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 60 } })])
    moveTo(150, 150) // the drag is gone
    up(150, 150)
    expect(b.obj('P')).toMatchObject({ cropX: 20, cropY: 10, width: 100, height: 60, left: 100, top: 50 })
    expect(b.store.saves).toHaveLength(0)
    expect(b.canUndo()).toBe(false)
  })

  it('dispose during a drag removes its listeners', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    down(b.canvas, 300, 150)
    moveTo(250, 150)
    b.editor.dispose()
    expect(() => {
      moveTo(150, 150)
      up(150, 150)
    }).not.toThrow()
  })

  it('Space-pan and the middle button pan during crop mode without changing the rectangle or ending crop mode', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [250, 150])
    down(b.canvas, 10, 10, 1)
    moveTo(40, 10)
    up(40, 10, 1)
    expect(b.editor.getState().viewport.panX).toBe(30)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    down(b.canvas, 10, 10)
    moveTo(30, 10)
    up(30, 10)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))
    expect(b.editor.getState().viewport.panX).toBe(50)
    expect(b.cropping()).toBe(true)
    b.editor.applyCrop()
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 150, height: 100 })
  })
})

describe('double-click', () => {
  const dbl = (b: Awaited<ReturnType<typeof board>>, target: FakeObject | undefined) => b.canvas.fire('mouse:dblclick', { e: {}, target })

  it('on a selected unlocked image with the Select tool opens crop mode (after Fabric has finished)', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    dbl(b, b.obj('P'))
    expect(b.cropping()).toBe(false)
    await tick()
    expect(b.cropping()).toBe(true)
    expect(b.canUndo()).toBe(false)
  })

  it('does nothing with the hand tool or Space held, on a locked image, on a multi-selection, or while cropping', async () => {
    const b = await board([], [img('P', 100, 50), img('L', 400, 50, { locked: true })])
    b.editor.selectLayer('P')
    b.editor.setTool('hand')
    b.canvas.setActiveObject(b.obj('P'))
    dbl(b, b.obj('P'))
    await tick()
    expect(b.cropping()).toBe(false)
    b.editor.setTool('select')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
    dbl(b, b.obj('P'))
    await tick()
    expect(b.cropping()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }))

    b.editor.selectLayer('L')
    dbl(b, b.obj('L'))
    await tick()
    expect(b.cropping()).toBe(false)

    const sel = new ActiveSelection([b.obj('P')])
    b.canvas.setActiveObject(sel)
    dbl(b, sel)
    await tick()
    expect(b.cropping()).toBe(false)
  })

  it('a double-click whose first press applied a crop does not reopen it', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    down(b.canvas, 250, 100) // in the dimmed part of the image: applies
    up(250, 100)
    down(b.canvas, 150, 100) // second press of the double-click reaches Fabric
    up(150, 100)
    dbl(b, b.obj('P'))
    await tick()
    expect(b.cropping()).toBe(false)
    // A later, ordinary double-click does.
    down(b.canvas, 150, 100)
    up(150, 100)
    down(b.canvas, 150, 100)
    up(150, 100)
    dbl(b, b.obj('P'))
    await tick()
    expect(b.cropping()).toBe(true)
  })
})

describe('frames: a crop counts as a resize (F5)', () => {
  it('an owned image cropped with its centre still inside keeps its owner', async () => {
    const b = await board([F('A', 0, 0, 400, 300)], [img('P', 100, 50, { frameId: 'A' })])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150])
    b.editor.applyCrop()
    expect(b.rec('P')).toMatchObject({ frameId: 'A', crop: { x: 0, y: 0, width: 100, height: 100 } })
  })

  it('cropped so that its centre leaves the frame: loose; into a frame in front: joins it', async () => {
    // Frame A covers x 0..220; frame B (in front) covers x 220..600.
    const b = await board([F('A', 0, 0, 220, 300), F('B', 220, 0, 380, 300)], [img('P', 100, 50, { frameId: 'A' }), img('Q', 700, 50, { frameId: 'A' })])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [100, 100], [260, 100]) // keep source x 160..200: centre x = 280, inside B
    b.editor.applyCrop()
    expect(b.rec('P')).toMatchObject({ frameId: 'B', left: 260 })
    // Q is outside every frame: cropped, it becomes loose.
    b.editor.selectLayer('Q')
    b.editor.startCrop()
    dragCrop(b.canvas, [900, 150], [800, 150])
    b.editor.applyCrop()
    expect(b.rec('Q')).not.toHaveProperty('frameId')
    b.editor.undo()
    expect(b.rec('Q')).toMatchObject({ frameId: 'A' })
  })

  it('cancelling, or applying an unchanged crop, never changes the owner', async () => {
    const b = await board([F('A', 0, 0, 400, 300)], [img('Q', 700, 50, { frameId: 'A' })])
    b.editor.selectLayer('Q')
    b.editor.startCrop()
    b.editor.applyCrop()
    expect(b.rec('Q')).toMatchObject({ frameId: 'A' })
    b.editor.startCrop()
    dragCrop(b.canvas, [900, 150], [800, 150])
    b.editor.cancelCrop()
    expect(b.rec('Q')).toMatchObject({ frameId: 'A' })
  })
})

describe('Fit and Fill (F1-F5)', () => {
  it('Fill keeps the box and covers it with a centred maximal crop; one history step', async () => {
    // A 50 x 50 box showing the left square of the 200 x 100 original at 0.5.
    const b = await board([], [img('P', 100, 50, { crop: { x: 0, y: 0, width: 100, height: 100 }, scaleX: 0.5, scaleY: 0.5 })])
    b.editor.selectLayer('P')
    expect(b.sel()?.image).toEqual({ cropped: true, canFit: true, canFill: true })
    b.editor.fillImage()
    expect(b.rec('P')).toEqual(img('P', 100, 50, { crop: { x: 50, y: 0, width: 100, height: 100 }, scaleX: 0.5, scaleY: 0.5 }))
    expect(b.sel()?.image).toEqual({ cropped: true, canFit: true, canFill: false })
    b.editor.fillImage() // nothing would change: nothing at all
    b.editor.undo()
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(b.canUndo()).toBe(false)
  })

  it('Fit shows the whole image inside the old box, centred; crop removed; one step', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 50, y: 0, width: 100, height: 100 } })]) // a 100 x 100 box
    b.editor.selectLayer('P')
    b.editor.fitImage()
    expect(b.rec('P')).toEqual(img('P', 100, 75, { scaleX: 0.5, scaleY: 0.5 })) // 100 x 50, centred on (150, 100)
    expect(b.rec('P')).not.toHaveProperty('crop')
    expect(b.sel()?.image).toEqual({ cropped: false, canFit: false, canFill: false })
    b.editor.undo()
    expect(b.rec('P').crop).toEqual({ x: 50, y: 0, width: 100, height: 100 })
  })

  it('when nothing would change: no history entry and no save', async () => {
    const b = await board([], [img('P', 100, 50, { scaleX: 0.3, scaleY: 0.3 })])
    b.editor.selectLayer('P')
    expect(b.sel()?.image).toEqual({ cropped: false, canFit: false, canFill: false })
    b.editor.fitImage()
    b.editor.fillImage()
    await flush()
    expect(b.canUndo()).toBe(false)
    expect(b.store.attempts).toHaveLength(0)
  })

  it('inert for a locked image, a multi-selection, and while a gesture is unsettled', async () => {
    const crop = { x: 0, y: 0, width: 100, height: 100 }
    const b = await board([], [img('L', 0, 0, { locked: true, crop }), img('P', 300, 0, { crop }), img('Q', 600, 0, { crop })])
    b.editor.selectLayer('L')
    b.editor.fitImage()
    b.editor.fillImage()
    b.editor.selectLayer('P')
    b.editor.selectLayer('Q', { toggle: true })
    b.editor.fitImage()
    b.editor.fillImage()
    b.editor.selectLayer('P')
    const t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 5, 0)
    b.editor.fitImage()
    b.editor.fillImage()
    release(b.canvas, t)
    await tick()
    expect(b.rec('L').crop).toEqual(crop)
    expect(b.rec('Q').crop).toEqual(crop)
    expect(b.rec('P')).toMatchObject({ crop, left: 305 })
  })

  it('during crop mode: the crop is applied first as its own step', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    dragCrop(b.canvas, [300, 150], [200, 150]) // a 100 x 100 box
    b.editor.fitImage()
    expect(b.cropping()).toBe(false)
    expect(b.rec('P')).toEqual(img('P', 100, 75, { scaleX: 0.5, scaleY: 0.5 }))
    b.editor.undo()
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
  })

  it('Fit decides the owner as after a resize; Fill never changes it', async () => {
    // Frame A covers x 0..170; the image's box is x 100..300 (centre 200, outside A).
    const b = await board([F('A', 0, 0, 170, 300)], [img('P', 100, 50, { frameId: 'A', crop: { x: 0, y: 0, width: 200, height: 50 } })])
    b.editor.selectLayer('P')
    b.editor.fillImage() // the box stays: still owned, though its centre is outside
    expect(b.rec('P')).toMatchObject({ frameId: 'A' })
    expect(b.rec('P').crop).toEqual({ x: 0, y: 25, width: 200, height: 50 })
    b.editor.undo()
    b.editor.fitImage() // the whole image inside a 200 x 50 box: 100 x 50, centred on (200, 75): outside A
    expect(b.rec('P')).not.toHaveProperty('frameId')
    expect(b.rec('P')).toMatchObject({ left: 150, top: 50, scaleX: 0.5 })
  })
})

describe('reload', () => {
  it('a reload during crop mode loads the board from before it', async () => {
    const first = await board([], [img('P', 100, 50)])
    first.editor.selectLayer('P')
    first.editor.startCrop()
    dragCrop(first.canvas, [300, 150], [200, 150])
    first.editor.setTitle('mid-crop')
    await flush()
    const saved = first.store.saves.at(-1)!.doc
    first.editor.dispose()
    const again = await board(saved.frames, saved.objects)
    expect(again.rec('P')).toEqual(img('P', 100, 50))
    expect(again.cropping()).toBe(false)
  })

  it('a reloaded board shows the crop exactly as applied', async () => {
    const first = await board([], [img('P', 100, 50)])
    first.editor.selectLayer('P')
    first.editor.startCrop()
    dragCrop(first.canvas, [100, 50], [130, 70])
    first.editor.applyCrop()
    await flush()
    const saved = first.store.saves.at(-1)!.doc
    const again = await board(saved.frames, saved.objects)
    expect(again.rec('P')).toEqual(img('P', 130, 70, { crop: { x: 30, y: 20, width: 170, height: 80 } }))
    expect(again.obj('P')).toMatchObject({ cropX: 30, cropY: 20, width: 170, height: 80, left: 130, top: 70 })
    await flush()
    expect(again.store.attempts).toHaveLength(0) // loading never rewrites
  })
})

describe('review fixes', () => {
  it('straight after Fill (or Fit) its button is disabled, and a second one records nothing and saves nothing', async () => {
    // Crops whose Fill used to land 0.01 px away the second time (the fake image is 200 x 100).
    const crops = [
      { x: 0, y: 0, width: 20, height: 62 },
      { x: 3, y: 1, width: 7, height: 93 },
      { x: 10, y: 5, width: 33.33, height: 71 },
      { x: 0, y: 0, width: 199, height: 3 },
      { x: 50, y: 20, width: 13, height: 17 },
    ]
    for (const [i, crop] of crops.entries()) {
      for (const scale of [1, 0.37, 2.5]) {
        const b = await board([], [img('P', 100, 50, { crop, scaleX: scale, scaleY: scale })])
        b.editor.selectLayer('P')
        b.editor.fillImage()
        await flush()
        const attempts = b.store.attempts.length
        const once = b.rec('P')
        expect(b.sel()?.image?.canFill, `crop ${i} at ${scale}`).toBe(false)
        b.editor.fillImage()
        await flush()
        expect(b.rec('P')).toEqual(once)
        expect(b.store.attempts).toHaveLength(attempts)
        expect(b.editor.getState().save.kind).toBe('saved')
        b.editor.undo()
        expect(b.canUndo(), `crop ${i} at ${scale}: one step only`).toBe(false)

        b.editor.redo()
        b.editor.fitImage()
        await flush()
        const fitAttempts = b.store.attempts.length
        expect(b.sel()?.image?.canFit).toBe(false)
        b.editor.fitImage()
        await flush()
        expect(b.store.attempts).toHaveLength(fitAttempts)
        b.editor.dispose()
      }
    }
  })

  it('an ignored shortcut in crop mode or mid-gesture is kept from the browser (Ctrl+A would select the page); other keys and keys in fields are not', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    const send = (k: KeyboardEvent, target: EventTarget = window) => {
      target.dispatchEvent(k)
      return k.defaultPrevented
    }
    b.editor.selectLayer('P')
    b.editor.startCrop()
    expect(send(key('a', { ctrlKey: true }))).toBe(true)
    expect(send(key('Delete'))).toBe(true)
    expect(send(key('x'))).toBe(false) // not a shortcut: left alone
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(send(key('a', { ctrlKey: true }), input)).toBe(false) // typed in a field: the field's own
    expect(b.cropping()).toBe(true)
    expect(b.activeIds()).toEqual(['P'])
    b.editor.cancelCrop()

    const t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 5, 0)
    expect(send(key('a', { ctrlKey: true }))).toBe(true)
    expect(send(key('x'))).toBe(false)
    expect(send(key('a', { ctrlKey: true }), input)).toBe(false)
    release(b.canvas, t)
    await tick()
    input.remove()
  })

  it('the canvas cursor is reset as soon as crop mode ends, by any path', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const el = b.canvas.upperCanvasEl
    for (const end of [() => window.dispatchEvent(key('Enter')), () => window.dispatchEvent(key('Escape')), () => b.editor.applyCrop(), () => b.editor.cancelCrop()]) {
      b.editor.startCrop()
      el.style.cursor = 'nwse-resize' // what Fabric shows over a handle
      end()
      expect(b.cropping()).toBe(false)
      expect(el.style.cursor).toBe('default')
    }
  })

  it('while cropping, the selection counts as cropped if the crop it began with was', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 60 } }), img('Q', 400, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    expect(b.sel()?.image).toEqual({ cropped: true, canFit: false, canFill: false })
    b.editor.cancelCrop()
    b.editor.selectLayer('Q')
    b.editor.startCrop()
    expect(b.sel()?.image).toEqual({ cropped: false, canFit: false, canFill: false })
  })
})

describe('re-review fixes', () => {
  it('the board going read-only during a crop shows the hand cursor at once, not the arrow until the mouse moves', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    b.canvas.upperCanvasEl.style.cursor = 'nwse-resize' // what Fabric shows over a handle
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    expect(b.editor.getState().tool).toBe('hand')
    expect(b.canvas.upperCanvasEl.style.cursor).toBe('grab')
  })
})

describe('final review fixes', () => {
  it('disposed while a save is in flight and something changed: no further save is ever made (pre-existing data-loss path)', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.store.saveGate = deferred<void>()
    b.editor.setTitle('first')
    await flush() // the save starts and is held
    expect(b.store.attempts).toHaveLength(1)
    b.editor.setTitle('second') // changed while saving
    b.editor.dispose()
    const gate = b.store.saveGate
    b.store.saveGate = null
    gate.resolve()
    await flush()
    await flush()
    expect(b.store.attempts).toHaveLength(1)
    expect(b.store.saves[0]!.doc.objects).toHaveLength(1)
  })
})

describe('Undo while a crop is open', () => {
  it('is available as soon as the rectangle differs from where it began (even with no history yet), and goes back when it returns', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    expect(b.canUndo()).toBe(false)
    dragCrop(b.canvas, [300, 150], [250, 150]) // the right side in
    expect(b.canUndo()).toBe(true)
    expect(b.committed()).toBe(false)
    dragCrop(b.canvas, [250, 150], [300, 150]) // and back out: unchanged again
    expect(b.canUndo()).toBe(false)
    dragCrop(b.canvas, [300, 150], [250, 150])
    b.editor.undo() // applies the crop, then undoes it
    expect(b.cropping()).toBe(false)
    expect(b.rec('P')).toEqual(img('P', 100, 50))
    expect(b.editor.getState().canRedo).toBe(true)
    expect(b.canUndo()).toBe(false)
  })
})

describe('stored crops never reach outside the original', () => {
  it('a left side dragged 3 scene units at scale 8 (0.375 source px) stores x 0.38 and width 199.62, not 199.63 (right edge 200.01)', async () => {
    const b = await board([], [img('W', 100, 50, { scaleX: 8, scaleY: 8 })]) // the fake image is 200 x 100: the same half-step at its right edge
    b.editor.selectLayer('W')
    b.editor.startCrop()
    dragCrop(b.canvas, [100, 300], [103, 300])
    b.editor.applyCrop()
    expect(b.rec('W').crop).toEqual({ x: 0.38, y: 0, width: 199.62, height: 100 })
    const c = b.rec('W').crop!
    expect(c.x + c.width).toBeLessThanOrEqual(200)
  })
})
