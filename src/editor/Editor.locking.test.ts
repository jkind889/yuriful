import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, StoredAsset, TextRecord } from '../model/types.ts'
import { CONFLICT_MESSAGE } from '../persistence/autosave.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { idOf, isLocked } from './objects.ts'
import { canvasOf, dragBy, press, release, scaleBy, tick } from './testing/drive.ts'
import { ActiveSelection } from './testing/fakeFabric.ts'
import type { FakeObject, Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * Locking on the fake canvas: the commands, the rule that a selection containing a locked
 * item contains nothing else, what a locked item still does with its frame, and the
 * lifecycle cases. Real hit testing (presses falling through, the marquee, Shift-click on
 * the canvas, double-click) and real multi-selection geometry are proven in the browser
 * (e2e/locking.spec.ts).
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
const txt = (id: string, left: number, top: number, extra: Partial<TextRecord> = {}): TextRecord => ({
  type: 'text',
  id,
  left,
  top,
  angle: 0,
  text: id,
  fontSize: 24,
  width: 200,
  ...extra,
})
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
const LOCK_KEY = () => key('L', { ctrlKey: true, shiftKey: true })

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

function make(frames: FrameRecord[], objects: ObjectRecord[]) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Locking', frames, objects }
  const store = new SpyStore(frames.length + objects.length > 0 ? { doc, assets: new Map([['a1', asset('a1')]]) } : null)
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  return { editor, store, canvas: canvasOf(editor) }
}

async function board(frames: FrameRecord[], objects: ObjectRecord[]) {
  const made = make(frames, objects)
  made.store.holdLoad = false
  await made.editor.init()
  return helpers(made)
}

function helpers({ editor, store, canvas }: ReturnType<typeof make>) {
  const obj = (id: string): FakeObject => {
    const found = canvas.objects.find((o) => idOf(o as never) === id)
    if (!found) throw new Error(`no object ${id} on the canvas`)
    return found
  }
  const doc = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc()
  const rec = (id: string) => {
    const d = doc()
    const found = [...d.objects, ...d.frames].find((o) => o.id === id)
    if (!found) throw new Error(`no record ${id}`)
    return found as ObjectRecord & FrameRecord
  }
  const lockedIds = () => editor.getState().layers.filter((l) => l.locked).map((l) => l.id)
  const activeIds = () => canvas.getActiveObjects().map((o) => idOf(o as never))
  const select = (...list: string[]) => {
    const objs = list.map(obj)
    canvas.setActiveObject(objs.length === 1 ? objs[0]! : new ActiveSelection(objs))
    return canvas.getActiveObject()!
  }
  const move = async (ids: string[], dx: number, dy: number) => {
    const t = press(canvas, select(...ids))
    dragBy(canvas, t, dx, dy)
    release(canvas, t)
    await tick()
  }
  const scale = async (ids: string[], f: number) => {
    const t = press(canvas, select(...ids), { action: 'scale', corner: 'br' })
    scaleBy(canvas, t, f)
    release(canvas, t)
    await tick()
  }
  const sel = () => editor.getState().selection
  const canUndo = () => editor.getState().canUndo
  return { editor, store, canvas, obj, doc, rec, lockedIds, activeIds, select, move, scale, sel, canUndo }
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

describe('loading', () => {
  it('restores locks as stored, with their canvas flags, and writes nothing', async () => {
    const b = await board([F('A', 0, 0, 400, 300, { locked: true })], [img('L', 50, 50, { locked: true, frameId: 'A' }), txt('t', 500, 500)])
    expect(b.lockedIds()).toEqual(['L', 'A'])
    expect(b.obj('L')).toMatchObject({ evented: false, selectable: false, hasControls: false, lockMovementX: true })
    expect(b.obj('A')).toMatchObject({ evented: false, selectable: false, lockRotation: true })
    expect(b.obj('t')).toMatchObject({ evented: true, selectable: true, editable: true })
    expect(b.rec('L')).toEqual(img('L', 50, 50, { locked: true, frameId: 'A' }))
    expect(b.rec('t')).not.toHaveProperty('locked')
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })

  it('a board stored before locking existed loads unchanged and unlocked, and is not rewritten', async () => {
    const b = await board([F('A', 0, 0)], [img('i', 50, 50, { frameId: 'A' })])
    expect(b.lockedIds()).toEqual([])
    expect(JSON.stringify(b.doc())).not.toContain('locked')
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })

  it('locking, unlocking and the shortcut are inert before the stored board has loaded', async () => {
    const made = make([], [img('L', 0, 0, { locked: true }), img('B', 300, 0)])
    const init = made.editor.init()
    made.editor.toggleLayerLock('L')
    made.editor.toggleLayerLock('B')
    made.editor.setSelectionLocked(true)
    made.editor.handleKeyDown(LOCK_KEY())
    made.store.releaseLoad()
    await init
    const b = helpers(made)
    expect(b.lockedIds()).toEqual(['L'])
    expect(b.canUndo()).toBe(false)
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })
})

describe('locking and unlocking', () => {
  it('locking a single selected item keeps it selected, is one undo step and is saved; undo and redo restore the flags', async () => {
    const b = await board([], [img('A', 0, 0), img('B', 300, 0)])
    b.select('A')
    b.editor.setSelectionLocked(true)
    expect(b.activeIds()).toEqual(['A'])
    expect(b.sel()).toMatchObject({ kind: 'image', locked: true, layer: { front: false, forward: false, backward: false, back: false } })
    expect(b.obj('A')).toMatchObject({ evented: false, hasControls: false })
    await flush()
    expect(b.store.saves.at(-1)!.doc.objects.find((o) => o.id === 'A')).toMatchObject({ locked: true })
    expect(b.rec('A')).toEqual(img('A', 0, 0, { locked: true })) // nothing else changed
    b.editor.undo()
    expect(b.obj('A')).toMatchObject({ evented: true, selectable: true, hasControls: true })
    expect(b.activeIds()).toEqual(['A'])
    expect(b.sel()?.locked).toBe(false)
    expect(b.canUndo()).toBe(false) // exactly one step
    b.editor.redo()
    expect(isLocked(b.obj('A') as never)).toBe(true)
    expect(b.activeIds()).toEqual(['A']) // a restored single locked selection is kept
    expect(b.sel()?.locked).toBe(true)
  })

  it('locking a multi-selection clears the selection, in one step; undo and redo', async () => {
    const b = await board([], [img('A', 0, 0), img('B', 300, 0), img('C', 600, 0)])
    b.select('A', 'B')
    b.editor.setSelectionLocked(true)
    expect(b.activeIds()).toEqual([])
    expect(b.lockedIds().sort()).toEqual(['A', 'B'])
    b.editor.undo()
    expect(b.lockedIds()).toEqual([])
    expect(b.canUndo()).toBe(false)
    b.editor.redo()
    expect(b.lockedIds().sort()).toEqual(['A', 'B'])
  })

  it('a lock that changes nothing records nothing and saves nothing; nothing selected does nothing', async () => {
    const b = await board([], [img('A', 0, 0, { locked: true }), img('B', 300, 0)])
    b.editor.setSelectionLocked(true)
    b.editor.handleKeyDown(LOCK_KEY())
    b.editor.selectLayer('A')
    b.editor.setSelectionLocked(true)
    b.select('B')
    b.editor.setSelectionLocked(false)
    expect(b.canUndo()).toBe(false)
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })

  it('locking and unlocking never change position, size, stacking or ownership', async () => {
    const b = await board([F('A', 0, 0)], [img('o', 50, 50, { frameId: 'A' }), txt('t', 100, 100, { frameId: 'A' }), img('x', 600, 0)])
    const before = b.doc()
    for (const id of ['o', 't', 'A', 'x']) b.editor.toggleLayerLock(id)
    const unlocked = <T extends { locked?: true }>(r: T) => {
      const copy = { ...r }
      delete copy.locked
      return copy
    }
    const strip = (d: BoardDoc) => JSON.stringify({ ...d, frames: d.frames.map(unlocked), objects: d.objects.map(unlocked) })
    expect(strip(b.doc())).toBe(strip(before))
    for (const id of ['o', 't', 'A', 'x']) b.editor.toggleLayerLock(id)
    expect(b.doc()).toEqual(before)
  })

  it('Ctrl/Cmd+Shift+L locks the selection, unlocks a single locked selection, and does nothing with nothing selected', async () => {
    const b = await board([], [img('A', 0, 0), img('B', 300, 0)])
    b.editor.handleKeyDown(LOCK_KEY())
    expect(b.lockedIds()).toEqual([])
    b.select('A')
    b.editor.handleKeyDown(LOCK_KEY())
    expect(b.lockedIds()).toEqual(['A'])
    expect(b.activeIds()).toEqual(['A'])
    b.editor.handleKeyDown(LOCK_KEY())
    expect(b.lockedIds()).toEqual([])
    b.editor.handleKeyDown(key('L', { metaKey: true, shiftKey: true }))
    expect(b.lockedIds()).toEqual(['A'])
  })
})

describe('the padlock on a layer row (toggleLayerLock)', () => {
  it('locks an unselected item without touching the selection; unlocking does not select it', async () => {
    const b = await board([], [img('A', 0, 0), img('B', 300, 0)])
    b.select('B')
    b.editor.toggleLayerLock('A')
    expect(b.lockedIds()).toEqual(['A'])
    expect(b.activeIds()).toEqual(['B'])
    b.editor.toggleLayerLock('A')
    expect(b.lockedIds()).toEqual([])
    expect(b.activeIds()).toEqual(['B'])
  })

  it('locked while part of a multi-selection, it leaves it and the rest stays selected; as the single selection it stays selected', async () => {
    const b = await board([], [img('A', 0, 0), img('B', 300, 0), img('C', 600, 0)])
    b.select('A', 'B', 'C')
    b.editor.toggleLayerLock('B')
    expect(b.activeIds()).toEqual(['A', 'C'])
    b.editor.toggleLayerLock('A')
    expect(b.activeIds()).toEqual(['C'])
    b.editor.toggleLayerLock('C')
    expect(b.activeIds()).toEqual(['C'])
    expect(b.sel()?.locked).toBe(true)
    b.editor.toggleLayerLock('C') // unlocked: its handles come back, still selected
    expect(b.activeIds()).toEqual(['C'])
    expect(b.obj('C')).toMatchObject({ hasControls: true })
  })

  it('an unknown id or a blank text does nothing', async () => {
    const b = await board([], [img('A', 0, 0)])
    b.editor.toggleLayerLock('nope')
    b.editor.addText() // a new, blank text being edited
    const blank = b.canvas.getActiveObject()!
    b.editor.toggleLayerLock(idOf(blank as never)!)
    expect(isLocked(blank as never)).toBe(false)
    expect((blank as Textbox).isEditing).toBe(true)
    expect(b.canUndo()).toBe(false)
  })
})

describe('a selection that contains a locked item contains nothing else', () => {
  it('a locked row is selected alone, also with a toggle click; toggling an unlocked row then replaces the selection', async () => {
    const b = await board([], [img('A', 0, 0, { locked: true }), img('B', 300, 0), img('C', 600, 0)])
    b.select('B', 'C')
    b.editor.selectLayer('A', { toggle: true })
    expect(b.activeIds()).toEqual(['A'])
    expect(b.sel()).toMatchObject({ locked: true, count: 1 })
    b.editor.selectLayer('B', { toggle: true })
    expect(b.activeIds()).toEqual(['B'])
    b.editor.selectLayer('C', { toggle: true })
    expect(b.activeIds()).toEqual(['B', 'C'])
    b.editor.selectLayer('A')
    expect(b.activeIds()).toEqual(['A'])
  })

  it('Select all skips locked things', async () => {
    const b = await board([F('LF', 0, 0, 400, 300, { locked: true }), F('U', 500, 0)], [img('A', 0, 0, { locked: true }), img('B', 300, 0)])
    b.editor.selectAll()
    expect(b.activeIds()).toEqual(['U', 'B'])
  })

  it('undo after "unlock A, then select A and B" makes A locked again and leaves only B selected', async () => {
    const b = await board([], [img('A', 0, 0, { locked: true }), img('B', 300, 0)])
    b.editor.toggleLayerLock('A')
    b.editor.selectLayer('A')
    b.editor.selectLayer('B', { toggle: true })
    expect(b.activeIds()).toEqual(['A', 'B'])
    b.editor.undo()
    expect(b.lockedIds()).toEqual(['A'])
    expect(b.activeIds()).toEqual(['B'])
    expect(b.canvas.getActiveObject()).not.toBeInstanceOf(ActiveSelection)
  })

  it('redo into a locked state drops the then-locked item from a multi-selection', async () => {
    const b = await board([], [img('A', 0, 0), img('B', 300, 0)])
    b.select('A', 'B')
    b.editor.toggleLayerLock('A')
    expect(b.activeIds()).toEqual(['B'])
    b.editor.undo()
    expect(b.lockedIds()).toEqual([])
    expect(b.activeIds()).toEqual(['B'])
    b.select('A', 'B')
    b.editor.redo()
    expect(b.lockedIds()).toEqual(['A'])
    expect(b.activeIds()).toEqual(['B'])
  })

  it('a multi-selection with a locked member that some path forms anyway is formed again without it', async () => {
    const b = await board([], [img('A', 0, 0, { locked: true }), img('B', 300, 0), img('C', 600, 0)])
    b.select('A', 'B', 'C')
    await tick()
    expect(b.activeIds()).toEqual(['B', 'C'])
  })
})

describe('nothing edits a locked selection', () => {
  it('delete, the four layer commands, font size, rename and "Select with contents" do nothing, record nothing and save nothing', async () => {
    const b = await board([F('LF', 0, 0, 400, 300, { locked: true })], [txt('t', 50, 50, { locked: true, frameId: 'LF' }), img('B', 600, 0), img('C', 900, 0)])
    const before = b.doc()
    b.editor.selectLayer('t')
    expect(b.sel()).toMatchObject({ kind: 'text', locked: true, layer: { front: false, forward: false, backward: false, back: false } })
    b.editor.deleteSelection()
    for (const op of ['front', 'forward', 'backward', 'back'] as const) b.editor.arrange(op)
    b.editor.setFontSize(80)
    b.editor.handleKeyDown(key('Delete'))
    b.editor.handleKeyDown(key(']'))
    b.editor.selectLayer('LF')
    expect(b.sel()).toMatchObject({ kind: 'frame', locked: true })
    expect(b.editor.renameFrame('Nope')).toBeNull()
    b.editor.selectFrameContents()
    expect(b.activeIds()).toEqual(['LF'])
    b.editor.deleteSelection()
    b.editor.arrange('front')
    expect(b.doc()).toEqual(before)
    expect(b.canUndo()).toBe(false)
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })

  it('a locked text does not enter editing', async () => {
    const b = await board([], [txt('t', 0, 0, { locked: true })])
    const t = b.obj('t') as Textbox
    t.enterEditing()
    expect(t.isEditing).toBe(false)
    b.editor.toggleLayerLock('t')
    t.enterEditing()
    expect(t.isEditing).toBe(true)
  })
})

describe('leaving a text edit', () => {
  it('locking a text being typed commits the text as its own step, then locks it as a second step', async () => {
    const b = await board([], [img('i1', 600, 600)])
    b.editor.addText()
    const t = b.canvas.getActiveObject() as Textbox
    t.type('hello')
    b.editor.setSelectionLocked(true)
    expect(t.isEditing).toBe(false)
    expect(b.editor.getState().editingText).toBe(false)
    expect(b.rec(idOf(t as never)!)).toMatchObject({ text: 'hello', locked: true })
    expect(b.activeIds()).toEqual([idOf(t as never)])
    b.editor.undo()
    expect(b.rec(idOf(t as never)!)).not.toHaveProperty('locked')
    expect(b.doc().objects).toHaveLength(2)
    b.editor.undo()
    expect(b.doc().objects).toHaveLength(1)
    expect(b.canUndo()).toBe(false)
  })

  it('locking a blank text being typed discards it and locks nothing', async () => {
    const b = await board([], [img('i1', 600, 600)])
    b.editor.addText()
    b.editor.handleKeyDown(LOCK_KEY()) // ignored while editing text, as every shortcut
    b.editor.setSelectionLocked(true)
    await tick()
    expect(b.canvas.objects).toHaveLength(1)
    expect(b.lockedIds()).toEqual([])
    expect(b.canUndo()).toBe(false)
  })

  it('a padlock on another row while a text is being typed commits the text, then locks that row', async () => {
    const b = await board([], [img('i1', 600, 600)])
    b.editor.addText()
    const t = b.canvas.getActiveObject() as Textbox
    t.type('note')
    b.editor.toggleLayerLock('i1')
    expect(t.isEditing).toBe(false)
    expect(b.lockedIds()).toEqual(['i1'])
    expect(b.rec(idOf(t as never)!)).toMatchObject({ text: 'note' })
    b.editor.undo()
    expect(b.lockedIds()).toEqual([])
    expect(b.doc().objects).toHaveLength(2)
  })
})

describe('gestures', () => {
  it('lock commands arriving mid-drag are ignored and do not disturb the drag', async () => {
    const b = await board([], [img('A', 0, 0), img('B', 300, 0)])
    const t = press(b.canvas, b.select('A'))
    dragBy(b.canvas, t, 40, 30)
    b.editor.setSelectionLocked(true)
    b.editor.toggleLayerLock('B')
    b.editor.handleKeyDown(LOCK_KEY())
    release(b.canvas, t)
    await tick()
    expect(b.lockedIds()).toEqual([])
    expect(b.rec('A')).toMatchObject({ left: 40, top: 30 })
    b.editor.undo()
    expect(b.rec('A')).toMatchObject({ left: 0, top: 0 })
    expect(b.canUndo()).toBe(false)
  })

  it('a locked member follows its frame exactly once, keeps its owner and stays locked', async () => {
    const b = await board([F('A', 0, 0)], [img('L', 50, 50, { frameId: 'A', locked: true }), img('u', 100, 100, { frameId: 'A' })])
    await b.move(['A'], 40, 30)
    expect(b.rec('L')).toEqual(img('L', 90, 80, { frameId: 'A', locked: true }))
    expect(b.rec('u')).toMatchObject({ left: 140, top: 130, frameId: 'A' })
  })

  it('Esc and a window blur restore a dragged frame’s locked follower exactly, with no step and no save', async () => {
    const b = await board([F('A', 0, 0)], [img('L', 50, 50, { frameId: 'A', locked: true })])
    let t = press(b.canvas, b.select('A'))
    dragBy(b.canvas, t, 40, 30)
    expect(b.obj('L').left).toBe(90)
    b.editor.handleKeyDown(key('Escape'))
    release(b.canvas, t)
    await tick()
    t = press(b.canvas, b.select('A'))
    dragBy(b.canvas, t, 70, 10)
    window.dispatchEvent(new Event('blur'))
    release(b.canvas, t)
    await tick()
    expect(b.rec('L')).toEqual(img('L', 50, 50, { frameId: 'A', locked: true }))
    expect(isLocked(b.obj('L') as never)).toBe(true)
    expect(b.obj('L').evented).toBe(false)
    expect(b.canUndo()).toBe(false)
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })

  it('a save during a drag that carries a locked follower stores the scene from before the drag', async () => {
    const b = await board([F('A', 0, 0)], [img('L', 50, 50, { frameId: 'A', locked: true })])
    const t = press(b.canvas, b.select('A'))
    dragBy(b.canvas, t, 40, 30)
    b.editor.setTitle('Mid-drag')
    await flush()
    const saved = b.store.saves.at(-1)!.doc
    expect(saved.title).toBe('Mid-drag')
    expect(saved.objects[0]).toEqual(img('L', 50, 50, { frameId: 'A', locked: true }))
    expect(saved.frames[0]).toMatchObject({ left: 0, top: 0 })
    release(b.canvas, t)
    await tick()
    await flush()
    expect(b.store.saves.at(-1)!.doc.objects[0]).toEqual(img('L', 90, 80, { frameId: 'A', locked: true }))
  })
})

describe('frames', () => {
  it('"Select with contents" leaves locked members out; a frame that owns only locked things is selected alone', async () => {
    const b = await board([F('A', 0, 0), F('B', 600, 0)], [img('L', 50, 50, { frameId: 'A', locked: true }), img('u', 100, 100, { frameId: 'A' }), img('M', 650, 50, { frameId: 'B', locked: true })])
    b.select('A')
    b.editor.selectFrameContents()
    expect(b.activeIds()).toEqual(['A', 'u'])
    b.select('B')
    b.editor.selectFrameContents()
    expect(b.activeIds()).toEqual(['B'])
  })

  it('scaling a frame with its contents leaves a locked member where it is, and releases it when the frame no longer contains it', async () => {
    // L's centre (350, 200) is inside A (400×300) but outside A scaled by 0.5 from its top-left.
    const b = await board([F('A', 0, 0)], [img('L', 250, 150, { frameId: 'A', locked: true }), img('u', 20, 20, { frameId: 'A' })])
    b.select('A')
    b.editor.selectFrameContents()
    const t = press(b.canvas, b.canvas.getActiveObject()!, { action: 'scale', corner: 'br' })
    scaleBy(b.canvas, t, 0.5)
    release(b.canvas, t)
    await tick()
    expect(b.rec('A')).toMatchObject({ width: 200, height: 150 })
    expect(b.rec('L')).toEqual(img('L', 250, 150, { locked: true })) // not moved, not scaled, now loose
    expect(b.rec('u')).toMatchObject({ frameId: 'A' })
  })

  it('resizing a frame alone releases a locked member it no longer contains; deleting a frame leaves its locked members, loose', async () => {
    const b = await board([F('A', 0, 0), F('B', 600, 0)], [img('L', 250, 150, { frameId: 'A', locked: true }), img('M', 650, 50, { frameId: 'B', locked: true })])
    await b.scale(['A'], 0.5)
    expect(b.rec('L')).toEqual(img('L', 250, 150, { locked: true }))
    b.select('B')
    b.editor.deleteSelection()
    expect(b.rec('M')).toEqual(img('M', 650, 50, { locked: true }))
  })

  it('content moved into a locked frame joins it, and moved out leaves it, by its own movement', async () => {
    const b = await board([F('LF', 0, 0, 400, 300, { locked: true })], [img('i', 600, 0)])
    await b.move(['i'], -550, 50)
    expect(b.rec('i')).toMatchObject({ frameId: 'LF' })
    await b.move(['i'], 800, 0)
    expect(b.rec('i').frameId).toBeUndefined()
    expect(b.rec('LF')).toEqual(F('LF', 0, 0, 400, 300, { locked: true }))
  })
})

describe('other lifecycle cases', () => {
  it('an image import finishing while a locked item is selected selects the new image; the locked one stays locked', async () => {
    const b = await board([], [img('L', 0, 0, { locked: true })])
    b.editor.selectLayer('L')
    await b.editor.addImageFiles([new File([new Uint8Array([1])], 'new.png', { type: 'image/png' })])
    expect(b.activeIds()).toHaveLength(1)
    expect(b.activeIds()[0]).not.toBe('L')
    expect(b.lockedIds()).toEqual(['L'])
  })

  it('another tab making the board read-only while a locked item is selected: the selection goes, the lock stays, padlocks are inert', async () => {
    const b = await board([], [img('L', 0, 0, { locked: true }), img('B', 300, 0)])
    b.editor.selectLayer('L')
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    expect(b.sel()).toBeNull()
    expect(b.lockedIds()).toEqual(['L'])
    b.editor.toggleLayerLock('L')
    b.editor.toggleLayerLock('B')
    b.editor.selectLayer('L')
    b.editor.setSelectionLocked(false)
    expect(b.lockedIds()).toEqual(['L'])
    expect(b.sel()).toBeNull()
  })

  it('a reloaded board keeps its locks', async () => {
    const first = await board([], [img('A', 0, 0), img('B', 300, 0)])
    first.editor.toggleLayerLock('A')
    await flush()
    const saved = first.store.saves.at(-1)!.doc
    const again = await board(saved.frames, saved.objects)
    expect(again.lockedIds()).toEqual(['A'])
    expect(again.obj('A')).toMatchObject({ evented: false, selectable: false })
  })
})
