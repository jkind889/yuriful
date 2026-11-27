import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, StoredAsset, TextRecord } from '../model/types.ts'
import { CONFLICT_MESSAGE } from '../persistence/autosave.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { canvasOf, dragBy, mouse, press, release, scaleBy, tick } from './testing/drive.ts'
import type { Canvas, FakeObject, Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore, deferred } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([1, 2, 3]).buffer })
const text = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 'txt-1', left: 300, top: 40, angle: 0, text: 'keep me', fontSize: 24, width: 240, ...patch })

const storedDoc = (): BoardDoc => ({
  ...createEmptyDoc(),
  title: 'Stored',
  objects: [{ type: 'image', id: 'img-1', left: 10, top: 20, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 }, text()],
})

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function setup(doc: BoardDoc | null = storedDoc()) {
  const store = new SpyStore(doc ? { doc, assets: new Map([['a1', asset('a1')]]) } : null)
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const byId = (id: string) => canvas.objects[doc ? doc.objects.findIndex((o) => o.id === id) : -1] as FakeObject
  /** Records as the editor would save them right now (through its own getDoc). */
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects
  const live = () => canvas.objects.map((o) => ({ left: o.left, top: o.top }))
  return { editor, store, canvas, byId, scene, live }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // autosave's debounce; microtasks stay real
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

describe('durable scene: a save never sees an unfinished gesture', () => {
  it('a save during a held drag has the new title and the pre-gesture scene; release saves the final scene; one undo goes back', async () => {
    const { editor, store, canvas, byId } = await setup()
    editor.setTitle('Renamed') // board is dirty before the gesture starts
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 100, 50)
    await flush() // the drag is held well past the autosave debounce
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]!.doc.title).toBe('Renamed')
    expect(store.saves[0]!.doc.objects[0]).toMatchObject({ id: 'img-1', left: 10, top: 20 }) // not the half-dragged position

    dragBy(canvas, t, 5, 5)
    release(canvas, t)
    await tick()
    await flush()
    expect(store.saves).toHaveLength(2)
    expect(store.saves[1]!.doc.objects[0]).toMatchObject({ id: 'img-1', left: 115, top: 75 })

    expect(editor.getState().canUndo).toBe(true)
    editor.undo()
    expect(canvas.objects[0]).toMatchObject({ left: 10, top: 20 })
    expect(editor.getState().canUndo).toBe(false) // exactly one step
  })

  it('a flush when the page is hidden mid-drag also stores the pre-gesture scene', async () => {
    const { editor, store, canvas, byId } = await setup()
    editor.setTitle('Dirty')
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 70, 0)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()
    visibility.mockRestore()
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]!.doc.objects[0]).toMatchObject({ left: 10, top: 20 })
    release(canvas, t)
    await tick()
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toMatchObject({ left: 80, top: 20 })
  })

  it('a save that follows one already in flight still stores the pre-gesture scene', async () => {
    const { editor, store, canvas, byId } = await setup()
    store.saveGate = deferred<void>()
    editor.setTitle('First')
    await flush() // save 1 is now in flight, held by the gate
    expect(store.attempts).toHaveLength(1)

    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 40, 40)
    editor.setTitle('Second') // changed while saving
    store.saveGate.resolve()
    store.saveGate = null
    await flush()
    expect(store.saves).toHaveLength(2)
    expect(store.saves[1]!.doc.title).toBe('Second')
    expect(store.saves[1]!.doc.objects[0]).toMatchObject({ left: 10, top: 20 })

    release(canvas, t)
    await tick()
    await flush()
    expect(store.saves).toHaveLength(3)
    expect(store.saves[2]!.doc.objects[0]).toMatchObject({ left: 50, top: 60 })
  })
})

describe('clicks and text', () => {
  it('a press that never moves leaves no trace: no history entry, no save, not busy afterwards', async () => {
    const { editor, store, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    release(canvas, t)
    await tick()
    await flush()
    expect(editor.getState().canUndo).toBe(false)
    expect(store.attempts).toHaveLength(0)
    editor.addText() // commands work again
    expect(editor.getState().editingText).toBe(true)
  })

  it('a caret press on an editing textbox between typing bursts starts no gesture and adds no history', async () => {
    const { editor, store, canvas } = await setup(null)
    editor.addText()
    const tb = canvas.objects[0] as Textbox
    tb.type('first burst')
    // Clicking inside the text to move the caret: Fabric still fires before:transform and mouse:up.
    const t = press(canvas, tb)
    // While the press is held the board is not busy: typing goes on being saved live. (With a
    // gesture, the save would store the scene from before the press instead.)
    tb.type('first burst!')
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toMatchObject({ text: 'first burst!' })
    release(canvas, t)
    await tick()
    expect(editor.getState().editingText).toBe(true)
    expect(editor.getState().canUndo).toBe(false)
    tb.type('first burst, second burst')
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toMatchObject({ text: 'first burst, second burst' }) // typing saves the live scene

    tb.exitEditing()
    expect(editor.getState().canUndo).toBe(true)
    editor.undo()
    expect(canvas.objects).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false) // creating and typing the text was exactly one step
  })

  it('the text tool places its text after the click has been handled, not inside the canvas callback', async () => {
    const { editor, canvas } = await setup(null)
    editor.setTool('text')
    canvas.fire('mouse:down', { e: mouse(0, 120, 80) })
    canvas.fire('mouse:up', { e: mouse(0, 120, 80), isClick: true })
    expect(canvas.objects).toHaveLength(0)
    await tick()
    expect(canvas.objects).toHaveLength(1)
    expect(canvas.objects[0]).toMatchObject({ left: 120, top: 80, isEditing: true })
    expect(editor.getState().tool).toBe('select')
  })

  it('a non-primary click with the text tool places nothing', async () => {
    const { editor, canvas } = await setup(null)
    editor.setTool('text')
    canvas.fire('mouse:up', { e: mouse(2, 120, 80), isClick: true })
    await tick()
    expect(canvas.objects).toHaveLength(0)
  })
})

describe('settlement is deferred and guarded', () => {
  it('nothing is committed inside object:modified; the commit happens in a microtask', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 30, 0)
    release(canvas, t)
    expect(editor.getState().canUndo).toBe(false) // still inside "Fabric's" mouse-up handling
    await tick()
    expect(editor.getState().canUndo).toBe(true)
  })

  it('a settlement cancelled before it runs does nothing', async () => {
    const { editor, store, canvas, byId, live } = await setup()
    const before = live()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 30, 0)
    canvas.fire('object:modified', { e: mouse(0), target: t.target, transform: t, action: 'drag' }) // settlement queued
    editor.handleKeyDown(key('Escape')) // cancelled in the same task
    await tick()
    await flush()
    expect(live()).toEqual(before)
    expect(editor.getState().canUndo).toBe(false)
    expect(store.attempts).toHaveLength(0)
  })

  it('a settlement superseded by a newer gesture does nothing', async () => {
    const { editor, canvas, byId } = await setup()
    const first = press(canvas, byId('img-1'))
    dragBy(canvas, first, 30, 0)
    canvas.fire('object:modified', { e: mouse(0), target: first.target, transform: first, action: 'drag' })
    const second = press(canvas, byId('txt-1')) // replaces the gesture before the queued settlement runs
    await tick()
    expect(editor.getState().canUndo).toBe(false)
    editor.addText() // still busy with the second gesture
    expect(canvas.objects).toHaveLength(2)
    release(canvas, second)
    await tick()
    expect(editor.getState().canUndo).toBe(false)
  })

  it('only the gesture own transform settles it, and only once', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 30, 0)
    canvas.fire('object:modified', { e: mouse(0), target: t.target }) // e.g. a text leaving its edit: no transform
    canvas.fire('object:modified', { e: mouse(0), target: t.target, transform: { ...t } }) // some other transform
    await tick()
    expect(editor.getState().canUndo).toBe(false)
    release(canvas, t)
    canvas.fire('object:modified', { e: mouse(0), target: t.target, transform: t, action: 'drag' }) // a duplicate
    await tick()
    expect(editor.getState().canUndo).toBe(true)
    editor.undo()
    expect(editor.getState().canUndo).toBe(false)
  })
})

describe('Esc and window blur cancel an unfinished gesture', () => {
  it('Esc mid-drag restores the board with no history; the late mouse-up changes nothing', async () => {
    const { editor, store, canvas, byId, live } = await setup()
    const before = live()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 200, 100)
    const event = key('Escape')
    editor.handleKeyDown(event)
    expect(event.defaultPrevented).toBe(true)
    expect(canvas.calls).toContain('endCurrentTransform')
    expect(canvas._currentTransform).toBeNull()
    expect(live()).toEqual(before)
    expect(editor.getState().canUndo).toBe(false)

    release(canvas, t) // the button comes up later: Fabric has no transform any more
    await tick()
    await flush()
    expect(live()).toEqual(before)
    expect(editor.getState().canUndo).toBe(false)
    expect(store.attempts).toHaveLength(0)
    editor.addText() // not stuck busy
    expect(editor.getState().editingText).toBe(true)
  })

  it('window blur mid-scale restores the board with no history', async () => {
    const { editor, store, canvas, byId } = await setup()
    const img = byId('img-1')
    const t = press(canvas, img, { action: 'scale', corner: 'br' })
    scaleBy(canvas, t, 3)
    window.dispatchEvent(new Event('blur'))
    expect(canvas.objects[0]).toMatchObject({ left: 10, top: 20, scaleX: 1, scaleY: 1 })
    expect(editor.getState().canUndo).toBe(false)
    release(canvas, t)
    await tick()
    await flush()
    expect(editor.getState().canUndo).toBe(false)
    expect(store.attempts).toHaveLength(0)
  })

  it('keeps the selection by id across the restore', async () => {
    const { editor, canvas, byId } = await setup()
    canvas.setActiveObject(byId('img-1'))
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 10, 10)
    editor.handleKeyDown(key('Escape'))
    expect(canvas.getActiveObject()).toBe(canvas.objects[0]) // the rebuilt image, selected again
    expect(editor.getState().selection?.kind).toBe('image')
  })

  it('does not touch Fabric when the transform is no longer Fabric current one', async () => {
    const { editor, canvas, byId, live } = await setup()
    const before = live()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 10, 10)
    canvas._currentTransform = null // Fabric already dropped it
    editor.handleKeyDown(key('Escape'))
    expect(canvas.calls).not.toContain('endCurrentTransform')
    expect(live()).toEqual(before)
  })

  it('Esc with no gesture keeps its ordinary meaning', async () => {
    const { editor, canvas, byId } = await setup()
    canvas.setActiveObject(byId('img-1'))
    editor.handleKeyDown(key('Escape'))
    expect(canvas.getActiveObject()).toBeNull()
    editor.setTool('text')
    editor.handleKeyDown(key('Escape'))
    expect(editor.getState().tool).toBe('select')
  })
})

describe('busy guard: commands and shortcuts wait for the gesture', () => {
  it('everything that edits is inert while a gesture is unsettled, and works after it', async () => {
    const { editor, store, canvas, byId, scene } = await setup()
    // One undo step to begin with, so undo/redo have something to do.
    const first = press(canvas, byId('txt-1'))
    dragBy(canvas, first, 5, 5)
    release(canvas, first)
    await tick()
    expect(editor.getState().canUndo).toBe(true)
    await flush()
    const saves = store.attempts.length

    // A second step, undone, so that redo has something to do; and a text selected, so that
    // setFontSize has something to change.
    const second = press(canvas, byId('txt-1'))
    dragBy(canvas, second, 5, 5)
    release(canvas, second)
    await tick()
    editor.undo()
    await flush()
    expect(editor.getState().canRedo).toBe(true)

    canvas.setActiveObject(byId('txt-1'))
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 50, 0)
    const picker = vi.fn()
    editor.setImagePicker(picker)
    const before = JSON.stringify(scene())
    const zoom = editor.getState().viewport.zoom

    editor.undo()
    editor.redo()
    editor.deleteSelection()
    editor.selectAll()
    editor.arrange('front')
    editor.setTool('text')
    editor.setTool('hand')
    editor.addText()
    editor.setFontSize(99)
    for (const k of ['Delete', 'Backspace', 't', 'h', 'v', 'i', ']', '[']) editor.handleKeyDown(key(k))
    for (const k of ['a', 'z', 'y', ']']) editor.handleKeyDown(key(k, { ctrlKey: true }))
    editor.handleKeyDown(key(' ', { code: 'Space' }))

    expect(canvas.objects).toHaveLength(2)
    expect(canvas.objects[0]).toMatchObject({ left: 60, top: 20 }) // the drag itself is untouched
    expect(canvas.getActiveObject()).toBe(byId('txt-1'))
    expect(byId('txt-1')).toMatchObject({ fontSize: 24, left: 305, top: 45 }) // neither resized nor re-done
    expect(editor.getState().tool).toBe('select')
    expect(editor.getState().handActive).toBe(false)
    expect(editor.getState().canUndo).toBe(true)
    expect(editor.getState().canRedo).toBe(true)
    expect(JSON.stringify(scene())).toBe(before)
    expect(picker).not.toHaveBeenCalled()

    editor.handleKeyDown(key('=')) // zoom still works mid-gesture
    expect(editor.getState().viewport.zoom).toBeGreaterThan(zoom)

    release(canvas, t)
    await tick()
    await flush()
    expect(store.attempts.length).toBeGreaterThan(saves)
    editor.handleKeyDown(key('i'))
    expect(picker).toHaveBeenCalledTimes(1)
    editor.setFontSize(99)
    expect(canvas.getActiveObject()).toMatchObject({ fontSize: 99 })
    editor.undo() // the font size
    editor.undo() // the drag
    expect(canvas.objects[0]).toMatchObject({ left: 10, top: 20 })
    editor.redo()
    expect(canvas.objects[0]).toMatchObject({ left: 60, top: 20 })
    editor.handleKeyDown(key('Delete'))
    expect(canvas.objects).toHaveLength(1)
  })

  it('the title stays editable during a gesture', async () => {
    const { editor, canvas, byId } = await setup()
    press(canvas, byId('img-1'))
    expect(editor.setTitle('Renamed mid-drag')).toBe('Renamed mid-drag')
    expect(editor.getState().title).toBe('Renamed mid-drag')
  })
})

describe('pointer buttons: only the primary button edits', () => {
  it('creates the canvas with other buttons and modifier scaling switched off', async () => {
    const { canvas } = await setup()
    expect(canvas.options).toMatchObject({ fireRightClick: false, fireMiddleClick: false, uniScaleKey: null, altActionKey: null })
  })

  it('a mouse:up from button 1 or 2 leaves an unperformed transform in place; the primary release clears it', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    release(canvas, t, 2)
    release(canvas, t, 1)
    await tick()
    editor.addText()
    expect(canvas.objects).toHaveLength(2) // still busy: the primary button is still down
    release(canvas, t, 0)
    await tick()
    editor.addText()
    expect(canvas.objects).toHaveLength(3)
    expect(editor.getState().canUndo).toBe(false) // the click itself recorded nothing
  })

  it('an event without a button (touch) counts as primary, so a tap cannot leave the editor busy', async () => {
    const { editor, canvas, byId } = await setup()
    press(canvas, byId('img-1'))
    canvas.fire('mouse:up', { e: { type: 'touchend' }, isClick: true })
    await tick()
    editor.addText()
    expect(canvas.objects).toHaveLength(3)
  })

  it('a mouse:up from another button does not settle or clear a performed drag', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 20, 0)
    release(canvas, t, 2)
    await tick()
    expect(editor.getState().canUndo).toBe(false)
    dragBy(canvas, t, 20, 0) // the drag is still live
    release(canvas, t, 0)
    await tick()
    expect(editor.getState().canUndo).toBe(true)
    expect(canvas.objects[0]).toMatchObject({ left: 50, top: 20 })
    editor.undo()
    expect(editor.getState().canUndo).toBe(false) // one step for the whole drag
  })

  describe('at DOM level', () => {
    const fabricSees = (canvas: Canvas) => {
      const seen: number[] = []
      canvas.upperCanvasEl.addEventListener('mousedown', (e) => seen.push(e.button)) // where Fabric listens for presses
      return seen
    }
    const documentSees = () => {
      const seen: number[] = []
      const fn = (e: MouseEvent) => seen.push(e.button)
      document.addEventListener('mouseup', fn) // where Fabric listens for releases during a drag
      return { seen, off: () => document.removeEventListener('mouseup', fn) }
    }
    const bit = (button: number) => (button === 0 ? 1 : button === 1 ? 4 : 2)
    /** Buttons currently held, as a real browser reports them in `MouseEvent.buttons`. */
    let held = 0
    beforeEach(() => {
      held = 0
    })
    const down = (canvas: Canvas, button: number) => {
      held |= bit(button)
      canvas.upperCanvasEl.dispatchEvent(new MouseEvent('mousedown', { button, buttons: held, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    }
    const up = (button: number, target: EventTarget = document.body) => {
      held &= ~bit(button)
      target.dispatchEvent(new MouseEvent('mouseup', { button, buttons: held, bubbles: true, cancelable: true }))
    }
    const moveTo = (x: number, y: number) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: held }))

    it('a non-primary mousedown never reaches the canvas element; a primary one does', async () => {
      const { canvas } = await setup()
      const seen = fabricSees(canvas)
      down(canvas, 2)
      up(2)
      down(canvas, 1)
      up(1)
      expect(seen).toEqual([])
      down(canvas, 0)
      expect(seen).toEqual([0])
      up(0)
    })

    it('a non-primary mouseup reaches the document only when no primary press is outstanding', async () => {
      const { canvas } = await setup()
      const doc = documentSees()
      try {
        down(canvas, 2)
        up(2)
        down(canvas, 1)
        up(1)
        expect(doc.seen).toEqual([2, 1]) // nothing held: harmless, Fabric is not listening

        down(canvas, 0) // primary press passed through to Fabric
        down(canvas, 2)
        up(2)
        down(canvas, 1)
        up(1)
        expect(doc.seen).toEqual([2, 1]) // swallowed, so Fabric keeps tracking the primary drag
        up(0)
        expect(doc.seen).toEqual([2, 1, 0]) // the primary release always gets through

        down(canvas, 2)
        up(2)
        expect(doc.seen).toEqual([2, 1, 0, 2]) // and afterwards nothing is swallowed any more
      } finally {
        doc.off()
      }
    })

    it('a lost primary release does not leave other buttons swallowed, or panning disabled', async () => {
      const { editor, canvas } = await setup()
      const doc = documentSees()
      try {
        down(canvas, 0)
        held = 0 // the release went to another window: no mouseup ever arrives here
        down(canvas, 1) // the next event shows the primary button is not held
        moveTo(40, 10)
        expect(editor.getState().viewport.panX).toBe(30) // so the middle button pans again
        up(1)
        down(canvas, 2)
        up(2)
        expect(doc.seen).toEqual([1, 2]) // and non-primary releases get through again
      } finally {
        doc.off()
      }
    })

    it('a native drag that ends without a mouseup clears the outstanding primary press', async () => {
      const { editor, canvas } = await setup()
      down(canvas, 0)
      window.dispatchEvent(new Event('dragend'))
      held = 4 // (stale state on purpose: only the dragend may have cleared the flag)
      canvas.upperCanvasEl.dispatchEvent(new MouseEvent('mousedown', { button: 1, buttons: 5, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      moveTo(40, 10)
      expect(editor.getState().viewport.panX).toBe(30)
      up(1)
    })

    it('a middle-button pan ends only on the middle release', async () => {
      const { editor, canvas } = await setup()
      const panX = () => editor.getState().viewport.panX
      down(canvas, 1)
      moveTo(40, 10)
      expect(panX()).toBe(30)
      down(canvas, 2)
      up(2)
      down(canvas, 0) // a primary press and release in the middle must not end the pan
      up(0)
      moveTo(60, 10)
      expect(panX()).toBe(50) // still panning
      up(1)
      moveTo(100, 10)
      expect(panX()).toBe(50) // ended by its own button
    })

    it('a pan whose release was lost ends as soon as a move shows the button is up', async () => {
      const { editor, canvas } = await setup()
      down(canvas, 1)
      moveTo(40, 10)
      held = 0 // released outside the window
      moveTo(70, 10)
      moveTo(120, 10)
      expect(editor.getState().viewport.panX).toBe(30)
      // A later primary drag must not pan either.
      down(canvas, 0)
      moveTo(200, 10)
      up(0)
      expect(editor.getState().viewport.panX).toBe(30)
    })

    it('a middle press during a primary drag starts no pan and is swallowed', async () => {
      const { editor, canvas } = await setup()
      const seen = fabricSees(canvas)
      down(canvas, 0)
      down(canvas, 1)
      moveTo(80, 10)
      expect(editor.getState().viewport.panX).toBe(0)
      expect(seen).toEqual([0])
      up(1)
      up(0)
    })

    it('a hand-tool pan started by the primary button ends on the primary release and never reaches Fabric', async () => {
      const { editor, canvas } = await setup()
      const seen = fabricSees(canvas)
      editor.setTool('hand')
      down(canvas, 0)
      moveTo(25, 10)
      expect(editor.getState().viewport.panX).toBe(15)
      down(canvas, 2)
      up(2)
      moveTo(35, 10)
      expect(editor.getState().viewport.panX).toBe(25)
      up(0)
      moveTo(95, 10)
      expect(editor.getState().viewport.panX).toBe(25)
      expect(seen).toEqual([])
    })

    it('a window blur ends a pan whose release never arrived', async () => {
      const { editor, canvas } = await setup()
      down(canvas, 1)
      moveTo(30, 10)
      window.dispatchEvent(new Event('blur'))
      moveTo(90, 10)
      expect(editor.getState().viewport.panX).toBe(20)
    })
  })
})

describe('imports that finish during a gesture', () => {
  const png = () => new File([new Uint8Array([1, 2, 3])], 'drop.png', { type: 'image/png' })

  it('are applied after settlement as their own undo step', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 100, 0)
    await editor.addImageFiles([png()]) // decoding ends while the pointer is still held
    expect(canvas.objects).toHaveLength(2) // nothing touched the canvas mid-gesture
    expect(canvas.getActiveObject()).toBeNull()

    release(canvas, t)
    await tick()
    expect(canvas.objects).toHaveLength(3)
    expect(canvas.objects[0]).toMatchObject({ left: 110 })

    editor.undo() // first undo: the import only
    expect(canvas.objects).toHaveLength(2)
    expect(canvas.objects[0]).toMatchObject({ left: 110 })
    editor.undo() // second undo: the drag
    expect(canvas.objects[0]).toMatchObject({ left: 10 })
    expect(editor.getState().canUndo).toBe(false)
  })

  it('are applied after a click that performed nothing', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    await editor.addImageFiles([png()])
    expect(canvas.objects).toHaveLength(2)
    release(canvas, t)
    await tick()
    expect(canvas.objects).toHaveLength(3)
    editor.undo()
    expect(canvas.objects).toHaveLength(2)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('are applied after a cancelled gesture too', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 100, 0)
    await editor.addImageFiles([png()])
    editor.handleKeyDown(key('Escape'))
    await tick()
    expect(canvas.objects).toHaveLength(3)
    expect(canvas.objects[0]).toMatchObject({ left: 10 })
    editor.undo()
    expect(canvas.objects).toHaveLength(2)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('are applied after a gesture cancelled by a window blur', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 100, 0)
    await editor.addImageFiles([png()])
    window.dispatchEvent(new Event('blur'))
    await tick()
    expect(canvas.objects).toHaveLength(3)
    expect(canvas.objects[0]).toMatchObject({ left: 10 })
  })

  it('commit text that was being typed as its own step before adding the images', async () => {
    const { editor, canvas } = await setup(null)
    editor.addText()
    ;(canvas.objects[0] as Textbox).type('typed first')
    await editor.addImageFiles([png()])
    expect(canvas.objects).toHaveLength(2)
    editor.undo() // the import only
    expect(canvas.objects).toHaveLength(1)
    expect(canvas.objects[0]).toMatchObject({ text: 'typed first' })
    editor.undo() // the text
    expect(canvas.objects).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('are dropped with a notice when the board became read-only meanwhile', async () => {
    const { editor, store, canvas, byId } = await setup()
    store.saveError = new BoardConflictError()
    editor.setTitle('This save will conflict')
    const t = press(canvas, byId('img-1'))
    dragBy(canvas, t, 100, 0)
    await editor.addImageFiles([png(), png()])
    await flush() // the conflicting save lands: read-only, gesture undone
    expect(editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    expect(editor.getState().notice).toMatchObject({ kind: 'error', message: expect.stringContaining('2 images were not added') })
    expect(canvas.objects).toHaveLength(2)
    expect(canvas.objects[0]).toMatchObject({ left: 10 }) // the unfinished drag was undone
    release(canvas, t)
    await tick()
    expect(canvas.objects).toHaveLength(2)
  })

  it('says so when it drops them', async () => {
    const { editor, canvas, byId } = await setup()
    const t = press(canvas, byId('img-1'))
    await editor.addImageFiles([png(), png()])
    ;(editor as unknown as { enterReadOnly: (m: string) => void }).enterReadOnly('gone read-only')
    expect(editor.getState().notice).toMatchObject({ kind: 'error', message: expect.stringContaining('2 images were not added') })
    release(canvas, t)
    await tick()
    expect(canvas.objects).toHaveLength(2)
  })
})

describe('text left while a press on it is still held', () => {
  it('ends the transform, so the text cannot be dragged without a gesture', async () => {
    const { editor, canvas } = await setup(null)
    editor.addText()
    const tb = canvas.objects[0] as Textbox
    tb.type('held')
    press(canvas, tb) // inside the editing text: no gesture
    expect(canvas._currentTransform).not.toBeNull()
    tb.exitEditing() // e.g. Esc in the text, while the button is still down
    expect(canvas._currentTransform).toBeNull()
    expect(canvas.calls).toContain('endCurrentTransform')
    expect(editor.getState().canUndo).toBe(true) // the typed text was committed as usual
  })
})

describe('a text that is emptied after having been saved', () => {
  it('is removed from the stored board too, although history never held it', async () => {
    const { editor, store, canvas } = await setup(null)
    editor.addText()
    const tb = canvas.objects[0] as Textbox
    tb.type('a')
    await flush()
    expect(store.saves.at(-1)!.doc.objects).toHaveLength(1) // typing is saved live
    tb.type('')
    await flush()
    tb.exitEditing() // the empty text is discarded
    await tick()
    expect(canvas.objects).toHaveLength(0)
    await flush()
    expect(store.saves.at(-1)!.doc.objects).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
  })
})

describe('a new text that is abandoned untouched', () => {
  it('writes nothing: no save attempt on a stored board, and a new board stays "not saved yet"', async () => {
    const stored = await setup()
    stored.editor.addText()
    ;(stored.canvas.objects[2] as Textbox).exitEditing() // clicked away without typing
    await flush()
    expect(stored.canvas.objects).toHaveLength(2)
    expect(stored.store.attempts).toHaveLength(0)

    const fresh = await setup(null)
    fresh.editor.addText()
    ;(fresh.canvas.objects[0] as Textbox).exitEditing()
    await flush()
    expect(fresh.store.attempts).toHaveLength(0)
    expect(fresh.editor.getState().save).toEqual({ kind: 'new' })
  })

  it('is never stored, even when something else saves the board while it is open', async () => {
    const { editor, store, canvas } = await setup()
    editor.addText()
    editor.zoomBy(1.2) // marks the board dirty for a reason that has nothing to do with the text
    await flush()
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]!.doc.objects.map((o) => o.id)).toEqual(['img-1', 'txt-1']) // the blank text is not in it
    ;(canvas.objects[2] as Textbox).exitEditing()
    await flush()
    expect(canvas.objects).toHaveLength(2)
    expect(store.saves.at(-1)!.doc.objects.map((o) => o.id)).toEqual(['img-1', 'txt-1'])
    expect(editor.getState().canUndo).toBe(false)
  })

  it('a text emptied in the middle of an edit drops out of the stored board at once', async () => {
    const { editor, store, canvas } = await setup(null)
    editor.addText()
    const tb = canvas.objects[0] as Textbox
    tb.type('a')
    await flush()
    expect(store.saves.at(-1)!.doc.objects).toHaveLength(1)
    tb.type('   ') // whitespace only counts as blank, as it does when the edit ends
    await flush()
    expect(store.saves.at(-1)!.doc.objects).toHaveLength(0)
    tb.type('back')
    await flush()
    expect(store.saves.at(-1)!.doc.objects).toHaveLength(1)
  })

  it('is taken off the canvas only after the canvas has finished leaving the edit', async () => {
    const { editor, canvas } = await setup(null)
    editor.addText()
    const tb = canvas.objects[0] as Textbox
    tb.type('   ')
    const removedDuring: boolean[] = []
    canvas.on('object:modified', (() => removedDuring.push(!canvas.objects.includes(tb))) as never) // Fabric fires this right after the exit event
    tb.exitEditing()
    expect(removedDuring).toEqual([false]) // still on the canvas while Fabric finishes: no event on a detached text
    expect(canvas.objects).toHaveLength(1)
    await tick()
    expect(canvas.objects).toHaveLength(0)
    expect(editor.getState()).toMatchObject({ objectCount: 0, canUndo: false })
  })

  it('Shift-clicked into a selection as it is left, it is taken out of that selection again', async () => {
    const { editor, canvas, byId } = await setup()
    const { ActiveSelection } = await import('./testing/fakeFabric.ts')
    const tb = canvas.objects[1] as Textbox
    canvas.setActiveObject(tb)
    tb.enterEditing()
    tb.type('')
    // What Fabric does on a Shift-click: leave the edit, then group the text with the clicked object.
    tb.exitEditing()
    canvas.setActiveObject(new ActiveSelection([tb, byId('img-1')]))
    expect(editor.getState().selection).toMatchObject({ kind: 'multiple', count: 2 })
    await tick()
    expect(canvas.objects).toEqual([byId('img-1')])
    expect(canvas.getActiveObject()).toBe(byId('img-1')) // the image alone, not a selection with a ghost in it
    expect(editor.getState().selection).toMatchObject({ kind: 'image', count: 1 })
  })

  it('an existing text emptied and left is removed as one undoable step, with its owner restored by undo', async () => {
    const { editor, store, canvas } = await setup()
    const tb = canvas.objects[1] as Textbox
    canvas.setActiveObject(tb)
    tb.enterEditing()
    tb.type('')
    tb.exitEditing()
    await tick()
    expect(canvas.objects).toHaveLength(1)
    expect(editor.getState().canUndo).toBe(true)
    await flush()
    expect(store.saves.at(-1)!.doc.objects.map((o) => o.id)).toEqual(['img-1'])
    editor.undo()
    expect(canvas.objects).toHaveLength(2)
    expect(canvas.objects[1]).toMatchObject({ text: 'keep me' })
    expect(editor.getState().canUndo).toBe(false)
  })

  it('a text emptied and then retyped in the same edit is not removed by the deferred cleanup', async () => {
    const { editor, canvas } = await setup(null)
    editor.addText()
    const tb = canvas.objects[0] as Textbox
    tb.type('')
    tb.exitEditing() // blank: cleanup is queued ...
    tb.enterEditing() // ... but the user is straight back in it
    tb.type('kept after all')
    await tick()
    expect(canvas.objects).toHaveLength(1)
    tb.exitEditing()
    await tick()
    expect(canvas.objects).toHaveLength(1)
  })

  it('changing the font size while an existing text is blank mid-edit records nothing and keeps it an existing text', async () => {
    const { editor, canvas } = await setup()
    const tb = canvas.objects[1] as Textbox
    canvas.setActiveObject(tb)
    tb.enterEditing()
    tb.type('')
    editor.setFontSize(40)
    expect(tb.fontSize).toBe(40)
    expect(editor.getState().canUndo).toBe(false) // not "text removed" while it is still being edited
    tb.type('back')
    tb.exitEditing()
    await tick()
    expect(canvas.objects).toHaveLength(2)
    editor.undo()
    expect(canvas.objects[1]).toMatchObject({ text: 'keep me', fontSize: 24 })
    expect(editor.getState().canUndo).toBe(false) // one step for the whole edit
  })

  it('a blank text left in an old stored board is not shown and is gone after the next save', async () => {
    const doc = { ...createEmptyDoc(), objects: [text({ id: 'ghost', text: '' }), text({ id: 'real', text: 'kept' })] }
    const { editor, store, canvas } = await setup(doc)
    expect(canvas.objects).toHaveLength(1)
    await flush()
    expect(store.attempts).toHaveLength(0) // loading still writes nothing
    editor.setTitle('Edited')
    await flush()
    expect(store.saves[0]!.doc.objects.map((o) => o.id)).toEqual(['real'])
  })

  it('the typed-something memory does not leak from one edit into the next', async () => {
    const { editor, store, canvas } = await setup(null)
    editor.addText()
    const first = canvas.objects[0] as Textbox
    first.type('kept')
    first.exitEditing()
    await flush()
    const saves = store.attempts.length
    editor.addText()
    ;(canvas.objects[1] as Textbox).exitEditing() // untouched
    await flush()
    expect(store.attempts).toHaveLength(saves)
  })
})

describe('folding text scale in a multi-selection', () => {
  it('folds a member that is still scaled even when the selection itself ends at scale 1', async () => {
    const { canvas } = await setup({ ...createEmptyDoc(), objects: [text({ fontSize: 40, width: 400 })] })
    const tb = canvas.objects[0] as Textbox
    // A text that joined a selection scaled 1.6 carries the inverse scale itself; the
    // selection is then dragged back to exactly 1.
    const { ActiveSelection } = await import('./testing/fakeFabric.ts')
    const selection = new ActiveSelection([tb])
    Object.assign(selection, { scaleX: 1.6, scaleY: 1.6, width: 400, height: 50 })
    canvas.setActiveObject(selection)
    const t = press(canvas, selection, { action: 'scale', corner: 'br' })
    Object.assign(tb, { scaleX: 0.625, scaleY: 0.625 }) // absolute scale after the drag back
    Object.assign(selection, { scaleX: 1, scaleY: 1 })
    t.actionPerformed = true
    release(canvas, t)
    await tick()
    expect(tb).toMatchObject({ fontSize: 25, width: 250, scaleX: 1, scaleY: 1 })
  })
})

describe('scene plumbing with frames', () => {
  const frames = [
    { id: 'f1', name: 'Back', left: 0, top: 0, width: 400, height: 300 },
    { id: 'f2', name: 'Front', left: 50, top: 50, width: 400, height: 300 },
  ]
  type Internals = {
    applyRecords: (scene: { frames: unknown[]; objects: unknown[] }) => void
    getDoc: () => BoardDoc
    commit: () => void
    history: { reset: (s: unknown) => void }
    snapshot: () => { frames: unknown[]; objects: unknown[] }
  }
  /** An editable editor showing a framed scene (frames are not creatable through the UI yet). */
  async function framed() {
    const ctx = await setup()
    const internals = ctx.editor as unknown as Internals
    const objects = storedDoc().objects.map((o, i) => (i === 0 ? { ...o, frameId: 'f1' } : o))
    internals.applyRecords({ frames, objects })
    internals.history.reset(internals.snapshot())
    return { ...ctx, internals, objects }
  }

  it('builds frames behind all content and reads them back, with ownership', async () => {
    const { canvas, internals, objects } = await framed()
    expect(canvas.objects).toHaveLength(4)
    const doc = internals.getDoc()
    expect(doc.frames).toEqual(frames)
    expect(doc.objects).toEqual(objects)
    expect(doc.objects[0]).toMatchObject({ id: 'img-1', frameId: 'f1' })
    expect(doc.objects[1]).not.toHaveProperty('frameId')
  })

  it('a save during a gesture stores the frames from before it', async () => {
    const { canvas, internals } = await framed()
    const t = press(canvas, canvas.objects[0]!)
    dragBy(canvas, t, 500, 500)
    expect(internals.getDoc().frames).toEqual(frames)
    release(canvas, t)
    await tick()
    expect(internals.getDoc().frames[0]).toMatchObject({ id: 'f1', left: 500, top: 500 })
  })

  it('a change to a frame alone is a history step, and undo restores the frame', async () => {
    const { editor, canvas, internals } = await framed()
    const t = press(canvas, canvas.objects[1]!)
    dragBy(canvas, t, 30, 0)
    release(canvas, t)
    await tick()
    expect(editor.getState().canUndo).toBe(true)
    editor.undo()
    expect(internals.getDoc().frames).toEqual(frames)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('a frame selected on its own resizes freely; anything else scales proportionally', async () => {
    const { canvas } = await framed()
    expect(canvas.uniformScaling).toBe(true)
    canvas.setActiveObject(canvas.objects[0]!) // a frame
    expect(canvas.uniformScaling).toBe(false)
    canvas.setActiveObject(canvas.objects[2]!) // an image
    expect(canvas.uniformScaling).toBe(true)
    canvas.setActiveObject(canvas.objects[1]!)
    expect(canvas.uniformScaling).toBe(false)
    canvas.discardActiveObject()
    expect(canvas.uniformScaling).toBe(true)
  })

  it('a multi-selection that contains a frame cannot rotate; a content-only one can', async () => {
    const { canvas } = await framed()
    const { ActiveSelection } = await import('./testing/fakeFabric.ts')
    const mixed = new ActiveSelection([canvas.objects[0]!, canvas.objects[2]!])
    canvas.setActiveObject(mixed)
    expect(mixed.lockRotation).toBe(true)
    expect(mixed.controls).toMatchObject({ mtr: false, ml: false, mr: false, mt: false, mb: false })
    expect(canvas.uniformScaling).toBe(true) // even with a frame in it, a selection is proportional

    const content = new ActiveSelection([canvas.objects[2]!, canvas.objects[3]!])
    canvas.setActiveObject(content)
    expect(content.lockRotation).toBe(false)
    expect(content.controls).toMatchObject({ mtr: true, ml: false })

    // Shift-click changes a selection in place: the rule follows its current members, both ways.
    const members = (content as unknown as { members: unknown[] }).members
    members.push(canvas.objects[1]!)
    canvas.fire('selection:updated', {})
    expect(content.lockRotation).toBe(true)
    expect(content.controls.mtr).toBe(false)
    members.pop() // the frame is Shift-clicked out again
    canvas.fire('selection:updated', {})
    expect(content.lockRotation).toBe(false)
    expect(content.controls.mtr).toBe(true)
  })

  it('a rotated selection that a frame joins is re-formed upright, after the canvas callback', async () => {
    const { canvas } = await framed()
    const { ActiveSelection } = await import('./testing/fakeFabric.ts')
    const turned = new ActiveSelection([canvas.objects[2]!, canvas.objects[3]!])
    turned.angle = 30
    canvas.setActiveObject(turned)
    await tick()
    expect(canvas.getActiveObject()).toBe(turned) // content only: a turned selection is fine

    ;(turned as unknown as { members: unknown[] }).members.push(canvas.objects[0]!) // a frame is Shift-clicked in
    canvas.fire('selection:updated', {})
    expect(canvas.getActiveObject()).toBe(turned) // not inside the callback
    await tick()
    const reformed = canvas.getActiveObject()!
    expect(reformed).not.toBe(turned)
    expect(reformed.angle).toBe(0)
    expect(canvas.getActiveObjects()).toEqual([canvas.objects[2], canvas.objects[3], canvas.objects[0]])
    expect(reformed.lockRotation).toBe(true)
  })

  it('layer commands move frames among frames and content among content, never across', async () => {
    const { editor, canvas, internals } = await framed()
    const ids = () => [...internals.getDoc().frames.map((f) => f.id), ...internals.getDoc().objects.map((o) => o.id)]
    canvas.setActiveObject(canvas.objects[0]!) // the back frame
    expect(editor.getState().selection?.layer).toEqual({ front: true, forward: true, backward: false, back: false })
    editor.arrange('front')
    expect(ids()).toEqual(['f2', 'f1', 'img-1', 'txt-1']) // front-most frame, still behind all content

    canvas.setActiveObject(canvas.objects[1]!) // f1, now the front-most frame
    expect(editor.getState().selection?.layer).toEqual({ front: false, forward: false, backward: true, back: true })

    canvas.setActiveObject(canvas.objects[2]!) // the image, the back-most content
    expect(editor.getState().selection?.layer).toEqual({ front: true, forward: true, backward: false, back: false })
    editor.arrange('back') // already the back-most content: it must not sink below a frame
    expect(ids()).toEqual(['f2', 'f1', 'img-1', 'txt-1'])
    editor.arrange('front')
    expect(ids()).toEqual(['f2', 'f1', 'txt-1', 'img-1'])
  })
})

describe('one scale factor per gesture (single text)', () => {
  const big = (fontSize: number) => ({ ...createEmptyDoc(), objects: [text({ fontSize, width: 1000, left: 100, top: 100 })] })

  it('limits an enlargement by the pre-gesture font size and keeps the anchor fixed', async () => {
    const { editor, canvas } = await setup(big(300))
    const tb = canvas.objects[0] as Textbox
    const t = press(canvas, tb, { action: 'scale', corner: 'br' }) // anchor: top-left
    scaleBy(canvas, t, 2)
    release(canvas, t)
    await tick()
    expect(tb.fontSize).toBe(400) // 300 x 400/300, not 300 x 2 clamped per member
    expect(tb.width).toBeCloseTo((1000 * 400) / 300, 1)
    expect(tb).toMatchObject({ scaleX: 1, scaleY: 1, left: 100, top: 100 })
    editor.undo()
    expect(canvas.objects[0]).toMatchObject({ fontSize: 300, width: 1000, left: 100, top: 100 })
  })

  it('keeps the opposite corner fixed when the limit is re-applied from another handle', async () => {
    const { canvas } = await setup(big(300))
    const tb = canvas.objects[0] as Textbox
    const right = tb.left + tb.width
    const bottom = tb.top + tb.height
    const t = press(canvas, tb, { action: 'scale', corner: 'tl', originX: 'right', originY: 'bottom' })
    scaleBy(canvas, t, 2)
    release(canvas, t)
    await tick()
    expect(tb.fontSize).toBe(400)
    expect(tb.left + tb.width).toBeCloseTo(right, 1)
    expect(tb.top + tb.height * (400 / 300)).toBeCloseTo(bottom, 1) // the fake keeps its unscaled height
  })

  it('an out-of-range text may shrink toward the range and is never snapped into it', async () => {
    const { canvas } = await setup(big(500))
    const tb = canvas.objects[0] as Textbox
    let t = press(canvas, tb, { action: 'scale', corner: 'br' })
    scaleBy(canvas, t, 0.95)
    release(canvas, t)
    await tick()
    expect(tb.fontSize).toBe(475)
    expect(tb.width).toBe(950)

    t = press(canvas, tb, { action: 'scale', corner: 'br' })
    scaleBy(canvas, t, 1.2) // further out of range: not allowed at all
    release(canvas, t)
    await tick()
    expect(tb.fontSize).toBe(475) // unchanged, and not snapped to 400
    expect(tb.width).toBe(950)
  })

  it('a blocked scale is a no-op: no history entry and no save', async () => {
    const { editor, store, canvas } = await setup(big(500))
    const t = press(canvas, canvas.objects[0]!, { action: 'scale', corner: 'br' })
    scaleBy(canvas, t, 1.5)
    release(canvas, t)
    await tick()
    await flush()
    expect(editor.getState().canUndo).toBe(false)
    expect(store.attempts).toHaveLength(0)
  })

  it('a textbox scaled by a handle while it is being edited (no gesture) gets the same limit before folding', async () => {
    const { editor, canvas } = await setup(big(300))
    const tb = canvas.objects[0] as Textbox
    canvas.setActiveObject(tb)
    tb.enterEditing()
    const t = press(canvas, tb, { action: 'scale', corner: 'br' }) // ignored as a gesture: the text is being edited
    scaleBy(canvas, t, 2)
    release(canvas, t)
    expect(tb.fontSize).toBe(400)
    expect(tb).toMatchObject({ scaleX: 1, scaleY: 1, left: 100, top: 100 })
    expect(editor.getState().canUndo).toBe(true) // committed on the spot, as before
  })

  it('changing the wrap width of an out-of-range text keeps its font size and is recorded', async () => {
    const { editor, canvas } = await setup(big(500))
    const tb = canvas.objects[0] as Textbox
    const t = press(canvas, tb, { action: 'resizing', corner: 'mr' })
    tb.width = 1400
    t.actionPerformed = true
    release(canvas, t)
    await tick()
    expect(tb).toMatchObject({ width: 1400, fontSize: 500 })
    expect(editor.getState().canUndo).toBe(true)
  })
})
