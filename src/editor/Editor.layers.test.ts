import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, StoredAsset, TextRecord } from '../model/types.ts'
import { CONFLICT_MESSAGE } from '../persistence/autosave.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import type { LayerItem } from './Editor.ts'
import { idOf } from './objects.ts'
import { canvasOf, dragBy, press, release, tick } from './testing/drive.ts'
import { ActiveSelection } from './testing/fakeFabric.ts'
import type { FakeObject, Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The layer list (EditorState.layers) and selecting from it (Editor.selectLayer) on the
 * fake canvas. Real hit testing, real multi-selection geometry and the panel itself are
 * proven in the browser (e2e/layers.spec.ts).
 */
const asset = (id: string, name = `${id}.png`): StoredAsset => ({ id, name, type: 'image/png', bytes: new Uint8Array([7, 8, 9]).buffer })
const F = (id: string, left: number, top: number, width = 400, height = 300, name = `Frame ${id}`): FrameRecord => ({ id, name, left, top, width, height })
const img = (id: string, left: number, top: number, frameId?: string, assetId = 'a1'): ImageRecord => ({
  type: 'image',
  id,
  left,
  top,
  angle: 0,
  assetId,
  scaleX: 1,
  scaleY: 1,
  ...(frameId !== undefined && { frameId }),
})
const txt = (id: string, left: number, top: number, frameId?: string, patch: Partial<TextRecord> = {}): TextRecord => ({
  type: 'text',
  id,
  left,
  top,
  angle: 0,
  text: id,
  fontSize: 24,
  width: 200,
  ...(frameId !== undefined && { frameId }),
  ...patch,
})
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

const ASSETS = new Map([
  ['a1', asset('a1', 'cover.png')],
  ['a2', asset('a2', '')], // a stored image without a usable file name
])

function make(frames: FrameRecord[], objects: ObjectRecord[]) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Layers', frames, objects }
  const store = new SpyStore(frames.length + objects.length > 0 ? { doc, assets: ASSETS } : null)
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
  const layers = () => editor.getState().layers
  const ids = () => layers().map((l) => l.id)
  const selectedIds = () => layers().filter((l) => l.selected).map((l) => l.id)
  const activeIds = () => canvas.getActiveObjects().map((o) => idOf(o as never))
  const owners = () => Object.fromEntries(doc().objects.map((o) => [o.id, o.frameId]))
  const select = (...list: string[]) => {
    const objs = list.map(obj)
    canvas.setActiveObject(objs.length === 1 ? objs[0]! : new ActiveSelection(objs))
  }
  return { editor, store, canvas, obj, doc, layers, ids, selectedIds, activeIds, owners, select }
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

// A frame A (behind) and B (in front), and content back to front: i1 (owned by A), t1 (loose), i2 (owned by B, no file name).
const FRAMES = [F('A', 0, 0), F('B', 600, 0)]
const OBJECTS: ObjectRecord[] = [img('i1', 50, 50, 'A'), txt('t1', 900, 900), img('i2', 650, 50, 'B', 'a2')]

describe('the layer list', () => {
  it('is empty before the board has loaded, and lists content front to back, then frames front to back', async () => {
    const made = make(FRAMES, OBJECTS)
    const init = made.editor.init()
    expect(made.editor.getState().layers).toEqual([])
    made.store.releaseLoad()
    await init
    const b = helpers(made)
    expect(b.layers()).toEqual<LayerItem[]>([
      { id: 'i2', kind: 'image', label: 'Image', selected: false, frameName: 'Frame B', locked: false },
      { id: 't1', kind: 'text', label: 't1', selected: false, frameName: null, locked: false },
      { id: 'i1', kind: 'image', label: 'cover.png', selected: false, frameName: 'Frame A', locked: false },
      { id: 'B', kind: 'frame', label: 'Frame B', selected: false, frameName: null, locked: false },
      { id: 'A', kind: 'frame', label: 'Frame A', selected: false, frameName: null, locked: false },
    ])
  })

  it('labels a text by its text with whitespace collapsed, cut to about 40 characters', async () => {
    const long = '  The quick brown fox\n\njumps over   the lazy dog and keeps on running far away  '
    const b = await board([], [txt('t', 0, 0, undefined, { text: long }), txt('s', 0, 100, undefined, { text: ' two\nlines ' })])
    const [short, cut] = b.layers()
    expect(short!.label).toBe('two lines')
    expect(cut!.label.length).toBeLessThanOrEqual(40)
    expect(cut!.label).toMatch(/^The quick brown fox jumps over the lazy.*…$/)
  })

  it('names the owning frame from stored ownership, never from position', async () => {
    // "inside" sits inside A without belonging to it; "far" belongs to A although it sits outside it.
    const b = await board([F('A', 0, 0)], [img('inside', 50, 50), img('far', 2000, 2000, 'A')])
    expect(b.layers().map((l) => [l.id, l.frameName])).toEqual([
      ['far', 'Frame A'],
      ['inside', null],
      ['A', null],
    ])
  })

  it('follows a rename, a delete, an import, and undo/redo', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.select('A')
    b.editor.renameFrame('Cover spread')
    expect(b.layers().find((l) => l.id === 'A')!.label).toBe('Cover spread')
    expect(b.layers().find((l) => l.id === 'i1')!.frameName).toBe('Cover spread')

    b.select('t1')
    b.editor.deleteSelection()
    expect(b.ids()).toEqual(['i2', 'i1', 'B', 'A'])
    b.editor.undo()
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    b.editor.redo()
    expect(b.ids()).toEqual(['i2', 'i1', 'B', 'A'])

    await b.editor.addImageFiles([new File([new Uint8Array([1])], 'new.png', { type: 'image/png' })], { clientX: 5000, clientY: 5000 })
    expect(b.layers()[0]).toMatchObject({ kind: 'image', label: 'new.png', selected: true, frameName: null })
  })

  it('shows the selection, and keeps the same array when nothing in it changed (pan and zoom do not touch it)', async () => {
    const b = await board(FRAMES, OBJECTS)
    const before = b.layers()
    b.editor.zoomBy(2)
    b.editor.handleKeyDown(key('0'))
    expect(b.layers()).toBe(before)
    b.select('i1', 'B')
    expect(b.selectedIds()).toEqual(['i1', 'B'])
    const selected = b.layers()
    b.editor.setTitle('Renamed board')
    expect(b.layers()).toBe(selected)
    b.editor.selectLayer('i2')
    const single = b.layers()
    b.editor.selectLayer('i2') // recomputed, unchanged
    expect(b.layers()).toBe(single)
  })

  it('does not list a blank text being typed into; a typed text appears as soon as it has text', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.addText()
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A']) // the new, blank text is not in the scene
    const tb = b.canvas.getActiveObject() as Textbox
    tb.type('Hello\n  world')
    expect(b.layers()[0]).toMatchObject({ kind: 'text', label: 'Hello world', selected: true })
    tb.exitEditing()
    await tick()
    expect(b.layers()[0]).toMatchObject({ kind: 'text', label: 'Hello world', selected: true })
  })

  it('follows typing: the label changes as it is typed, an emptied text leaves the list and comes back; history only when the edit ends', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.select('t1')
    const tb = b.obj('t1') as Textbox
    tb.enterEditing()
    const before = b.layers()
    tb.type('hello')
    expect(b.layers().find((l) => l.id === 't1')).toMatchObject({ label: 'hello', selected: true })
    expect(b.layers()).not.toBe(before)
    tb.type('')
    expect(b.ids()).toEqual(['i2', 'i1', 'B', 'A']) // blank right now: not part of the scene, so not listed (no stale row to click)
    tb.type('hello again')
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    expect(b.layers().find((l) => l.id === 't1')).toMatchObject({ label: 'hello again', selected: true })
    const same = b.layers()
    tb.type('hello again') // nothing in the list changed: the same array
    expect(b.layers()).toBe(same)
    expect(b.editor.getState().canUndo).toBe(false) // typing records no history
    tb.exitEditing()
    await tick()
    expect(b.editor.getState().canUndo).toBe(true)
    b.editor.undo() // one step takes the whole edit back
    expect(b.layers().find((l) => l.id === 't1')!.label).toBe('t1')
    expect(b.editor.getState().canUndo).toBe(false)
  })

  it('clears every selected flag when the board goes read-only (another tab changed it)', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.selectLayer('i1')
    b.editor.selectLayer('A', { toggle: true })
    expect(b.selectedIds()).toEqual(['i1', 'A'])
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    expect(b.selectedIds()).toEqual([])
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A']) // still shows what is there
  })
})

describe('selecting from the layer list', () => {
  it('a plain click selects exactly that object or frame, even one in a multi-selection', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.selectLayer('i1')
    expect(b.activeIds()).toEqual(['i1'])
    expect(b.editor.getState().selection).toMatchObject({ kind: 'image', count: 1 })
    b.editor.selectLayer('B')
    expect(b.activeIds()).toEqual(['B'])
    expect(b.editor.getState().selection).toMatchObject({ kind: 'frame', frameName: 'Frame B' })
    b.select('i1', 'i2', 't1')
    b.editor.selectLayer('t1')
    expect(b.activeIds()).toEqual(['t1'])
    expect(b.selectedIds()).toEqual(['t1'])
  })

  it('toggle adds and removes; members are in canvas z-order; removing the last clears the selection', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.selectLayer('i2', { toggle: true })
    expect(b.activeIds()).toEqual(['i2'])
    b.editor.selectLayer('A', { toggle: true })
    b.editor.selectLayer('t1', { toggle: true })
    expect(b.canvas.getActiveObject()).toBeInstanceOf(ActiveSelection)
    expect(b.activeIds()).toEqual(['A', 't1', 'i2']) // back to front, as on the canvas
    expect(b.editor.getState().selection).toMatchObject({ kind: 'multiple', count: 3 })
    b.editor.selectLayer('t1', { toggle: true })
    expect(b.activeIds()).toEqual(['A', 'i2'])
    b.editor.selectLayer('A', { toggle: true })
    expect(b.canvas.getActiveObject()).not.toBeInstanceOf(ActiveSelection)
    expect(b.activeIds()).toEqual(['i2'])
    b.editor.selectLayer('i2', { toggle: true })
    expect(b.canvas.getActiveObject()).toBeNull()
    expect(b.editor.getState().selection).toBeNull()
  })

  it('changes nothing on the board: no history entry, no save, no ownership change', async () => {
    const b = await board(FRAMES, OBJECTS)
    const scene = JSON.stringify(b.doc())
    b.editor.selectLayer('i1')
    b.editor.selectLayer('B', { toggle: true })
    b.editor.selectLayer('t1', { toggle: true })
    b.editor.selectLayer('A')
    b.editor.selectLayer('A', { toggle: true })
    await flush()
    expect(b.editor.getState().canUndo).toBe(false)
    expect(b.store.attempts).toHaveLength(0)
    expect(JSON.stringify(b.doc())).toBe(scene)
    expect(b.owners()).toEqual({ i1: 'A', t1: undefined, i2: 'B' })
  })

  it('an unknown id does nothing, not even end a text edit', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.selectLayer('i1')
    b.editor.selectLayer('nope')
    b.editor.selectLayer('nope', { toggle: true })
    expect(b.activeIds()).toEqual(['i1'])
    b.editor.addText()
    const tb = b.canvas.getActiveObject() as Textbox
    tb.type('still typing')
    b.editor.selectLayer('nope')
    expect(tb.isEditing).toBe(true)
  })

  it('is inert before the stored board has loaded', async () => {
    const made = make(FRAMES, OBJECTS)
    const init = made.editor.init()
    made.editor.selectLayer('i1')
    made.editor.selectLayer('A', { toggle: true })
    made.store.releaseLoad()
    await init
    const b = helpers(made)
    expect(b.activeIds()).toEqual([])
    expect(b.selectedIds()).toEqual([])
  })

  it('is inert on a read-only board', async () => {
    const b = await board(FRAMES, OBJECTS)
    ;(b.editor as unknown as { enterReadOnly: (m: string) => void }).enterReadOnly('gone read-only')
    b.editor.selectLayer('i1')
    b.editor.selectLayer('A', { toggle: true })
    expect(b.activeIds()).toEqual([])
    expect(b.selectedIds()).toEqual([])
    expect(b.editor.getState().selection).toBeNull()
  })

  it('is inert while a drag is unsettled, and works once it has settled', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.select('t1')
    const t = press(b.canvas, b.obj('t1'))
    dragBy(b.canvas, t, 10, 0)
    b.editor.selectLayer('i1')
    b.editor.selectLayer('A', { toggle: true })
    expect(b.activeIds()).toEqual(['t1'])
    release(b.canvas, t)
    await tick()
    b.editor.selectLayer('i1')
    expect(b.activeIds()).toEqual(['i1'])
  })

  it('switches the Text and Frame tools back to Select; with the hand tool it selects and keeps the hand', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.setTool('frame')
    b.editor.selectLayer('i1')
    expect(b.editor.getState().tool).toBe('select')
    expect(b.activeIds()).toEqual(['i1'])
    b.editor.setTool('text')
    b.editor.selectLayer('t1')
    expect(b.editor.getState().tool).toBe('select')
    expect(b.activeIds()).toEqual(['t1'])
    b.editor.setTool('hand')
    b.editor.selectLayer('B')
    expect(b.editor.getState().tool).toBe('hand')
    expect(b.activeIds()).toEqual(['B'])
  })

  it('selection by id survives undo and redo straight afterwards; the list stays consistent', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.select('t1')
    b.editor.deleteSelection()
    b.editor.selectLayer('i1')
    b.editor.selectLayer('B', { toggle: true })
    b.editor.undo()
    expect(b.activeIds().sort()).toEqual(['B', 'i1'])
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    expect(b.selectedIds()).toEqual(['i1', 'B'])
    b.editor.redo()
    expect(b.activeIds().sort()).toEqual(['B', 'i1'])
    expect(b.ids()).toEqual(['i2', 'i1', 'B', 'A'])
    expect(b.selectedIds()).toEqual(['i1', 'B'])
  })

  it('an image import that finishes during a drag is added after it settles, and is then listed', async () => {
    const b = await board(FRAMES, OBJECTS)
    const t = press(b.canvas, b.obj('t1'))
    dragBy(b.canvas, t, 10, 0)
    await b.editor.addImageFiles([new File([new Uint8Array([1])], 'late.png', { type: 'image/png' })], { clientX: 5000, clientY: 5000 })
    expect(b.layers()).toHaveLength(5)
    release(b.canvas, t)
    await tick()
    expect(b.layers()).toHaveLength(6)
    expect(b.layers()[0]).toMatchObject({ kind: 'image', label: 'late.png', selected: true })
    b.editor.selectLayer('i1')
    expect(b.selectedIds()).toEqual(['i1'])
  })
})

describe('leaving a text edit by selecting from the list', () => {
  it('a typed new text is committed as one history step; the clicked row ends up selected', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.addText()
    const tb = b.canvas.getActiveObject() as Textbox
    tb.type('fresh note')
    b.editor.selectLayer('i1')
    expect(tb.isEditing).toBe(false)
    expect(b.activeIds()).toEqual(['i1'])
    expect(b.layers()[0]).toMatchObject({ kind: 'text', label: 'fresh note', selected: false })
    expect(b.selectedIds()).toEqual(['i1'])
    expect(b.editor.getState().editingText).toBe(false)
    b.editor.undo() // the text, as one step
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    expect(b.editor.getState().canUndo).toBe(false)
  })

  it('a blank new text is discarded and never listed; the clicked row ends up selected', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.addText()
    const tb = b.canvas.getActiveObject() as Textbox
    b.editor.selectLayer('B')
    await tick() // the blank text is taken off the canvas after the canvas has left the edit
    expect(b.canvas.objects).not.toContain(tb)
    expect(b.activeIds()).toEqual(['B'])
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    expect(b.editor.getState().canUndo).toBe(false)
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })

  it('clicking the row of the text being edited ends the edit and records it, keeping that text selected', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.select('t1')
    const tb = b.obj('t1') as Textbox
    tb.enterEditing()
    tb.type('t1 retyped')
    b.editor.selectLayer('t1')
    expect(tb.isEditing).toBe(false)
    expect(b.editor.getState().editingText).toBe(false)
    expect(b.activeIds()).toEqual(['t1'])
    expect(b.layers().find((l) => l.id === 't1')).toMatchObject({ label: 't1 retyped', selected: true })
    expect(b.editor.getState().canUndo).toBe(true)
  })

  it('toggle while a text is being edited commits it and adds the row to it', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.select('t1')
    const tb = b.obj('t1') as Textbox
    tb.enterEditing()
    tb.type('t1 edited')
    b.editor.selectLayer('i1', { toggle: true })
    expect(tb.isEditing).toBe(false)
    expect(b.activeIds()).toEqual(['i1', 't1']) // canvas z-order, back to front
    expect(b.selectedIds().sort()).toEqual(['i1', 't1'])
    expect(b.layers().find((l) => l.id === 't1')!.label).toBe('t1 edited')
    b.editor.undo()
    expect(b.layers().find((l) => l.id === 't1')!.label).toBe('t1')
  })

  it('toggle while a blank new text is being edited leaves it out of the selection', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.addText()
    const tb = b.canvas.getActiveObject() as Textbox
    b.editor.selectLayer('i1', { toggle: true })
    // Straight away, before the deferred removal of the blank text could tidy the selection up.
    expect(b.activeIds()).toEqual(['i1'])
    expect(b.canvas.getActiveObject()).toBe(b.obj('i1'))
    expect(b.selectedIds()).toEqual(['i1'])
    await tick()
    expect(b.canvas.objects).not.toContain(tb)
    expect(b.activeIds()).toEqual(['i1'])
    expect(b.editor.getState().canUndo).toBe(false)
  })
})

describe('reordering, seen through the list', () => {
  it('forward, backward, front and back reorder the list; frames stay below content; owners never change', async () => {
    const b = await board(FRAMES, OBJECTS)
    const owners = b.owners()
    b.editor.selectLayer('i1')
    b.editor.arrange('forward')
    expect(b.ids()).toEqual(['i2', 'i1', 't1', 'B', 'A'])
    b.editor.arrange('front')
    expect(b.ids()).toEqual(['i1', 'i2', 't1', 'B', 'A'])
    b.editor.selectLayer('A', { toggle: true }) // a frame and content together: each moves within its own band
    b.editor.arrange('front')
    expect(b.ids()).toEqual(['i1', 'i2', 't1', 'A', 'B'])
    b.editor.arrange('back')
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    b.editor.selectLayer('B')
    b.editor.arrange('front')
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A']) // already in front of the frames; never above content
    expect(b.owners()).toEqual(owners)
    expect(b.layers().map((l) => l.frameName)).toEqual(['Frame B', null, 'Frame A', null, null])
    b.editor.undo()
    b.editor.undo()
    expect(b.ids()).toEqual(['i1', 'i2', 't1', 'B', 'A'])
    expect(b.owners()).toEqual(owners)
  })
})

describe('moving a layer relative to another row', () => {
  it('moves just the grabbed row in display order and preserves records and a mixed selection through history', async () => {
    const b = await board(FRAMES, OBJECTS)
    const original = b.doc()
    b.editor.selectLayer('i1')
    b.editor.selectLayer('A', { toggle: true })
    b.editor.selectLayer('t1', { toggle: true })

    expect(b.editor.canMoveLayer('i1', 'i2', 'before')).toBe(true)
    b.editor.moveLayer('i1', 'i2', 'before')
    expect(b.ids()).toEqual(['i1', 'i2', 't1', 'B', 'A'])
    expect(b.activeIds()).toEqual(['A', 't1', 'i1'])
    expect(b.doc()).toEqual({ ...original, objects: [OBJECTS[1], OBJECTS[2], OBJECTS[0]] })
    expect(b.editor.canMoveLayer('i1', 'i2', 'before')).toBe(false)
    await flush()
    expect(b.store.attempts).toHaveLength(1)

    b.editor.undo()
    expect(b.doc()).toEqual(original)
    expect(b.activeIds()).toEqual(['A', 'i1', 't1'])
    expect(b.editor.getState().canUndo).toBe(false)
    b.editor.redo()
    expect(b.ids()).toEqual(['i1', 'i2', 't1', 'B', 'A'])
    expect(b.activeIds()).toEqual(['A', 't1', 'i1'])

    b.editor.moveLayer('i1', 't1', 'after')
    expect(b.doc()).toEqual(original)
    b.editor.moveLayer('A', 'B', 'before')
    expect(b.doc()).toEqual({ ...original, frames: [FRAMES[1], FRAMES[0]] })
  })

  it('rejects missing, locked, cross-band, same-row and same-place moves without saving', async () => {
    const b = await board(FRAMES, [OBJECTS[0]!, OBJECTS[1]!, { ...OBJECTS[2]!, locked: true }])
    const original = b.doc()
    const invalid = [
      ['i1', 'missing', 'before'],
      ['missing', 'i1', 'before'],
      ['i2', 'i1', 'after'],
      ['i1', 'A', 'before'],
      ['A', 't1', 'after'],
      ['i1', 'i1', 'before'],
      ['i1', 't1', 'after'],
    ] as const
    for (const [source, target, side] of invalid) {
      expect(b.editor.canMoveLayer(source, target, side)).toBe(false)
      b.editor.moveLayer(source, target, side)
    }
    await flush()
    expect(b.doc()).toEqual(original)
    expect(b.editor.getState().canUndo).toBe(false)
    expect(b.store.attempts).toHaveLength(0)
  })

  it('only moves on an editable, idle board', async () => {
    const made = make(FRAMES, OBJECTS)
    const init = made.editor.init()
    expect(made.editor.canMoveLayer('i1', 'i2', 'before')).toBe(false)
    made.editor.moveLayer('i1', 'i2', 'before')
    made.store.releaseLoad()
    await init
    const b = helpers(made)
    const order = b.ids()

    b.select('i1')
    const transform = press(b.canvas, b.obj('i1'))
    expect(b.editor.canMoveLayer('i1', 'i2', 'before')).toBe(false)
    b.editor.moveLayer('i1', 'i2', 'before')
    release(b.canvas, transform)
    await tick()
    expect(b.ids()).toEqual(order)
    expect(b.editor.canMoveLayer('i1', 'i2', 'before')).toBe(true)

    ;(b.editor as unknown as { enterReadOnly: (m: string) => void }).enterReadOnly('gone read-only')
    expect(b.editor.canMoveLayer('i1', 'i2', 'before')).toBe(false)
    b.editor.moveLayer('i1', 'i2', 'before')
    expect(b.ids()).toEqual(order)
    await flush()
    expect(b.store.attempts).toHaveLength(0)
  })

  it('leaves an edit open for a no-op and commits typed text separately before a valid drop', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.select('t1')
    const text = b.obj('t1') as Textbox
    text.enterEditing()
    text.type('edited text')
    b.editor.moveLayer('i1', 't1', 'after')
    expect(text.isEditing).toBe(true)

    b.editor.moveLayer('i1', 't1', 'before')
    expect(text.isEditing).toBe(false)
    expect(b.selectedIds()).toEqual(['t1'])
    expect(b.ids()).toEqual(['i2', 'i1', 't1', 'B', 'A'])
    b.editor.undo()
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    expect(b.layers()[1]?.label).toBe('edited text')
    b.editor.undo()
    expect(b.layers()[1]?.label).toBe('t1')
    expect(b.editor.getState().canUndo).toBe(false)
  })
})

describe('duplicating layers', () => {
  it('duplicates mixed selections once per record and shares image bytes', async () => {
    const b = await board(FRAMES, OBJECTS)
    b.editor.selectLayer('A')
    b.editor.selectLayer('i1', { toggle: true })
    b.editor.selectLayer('t1', { toggle: true })
    b.editor.duplicateSelection()
    const doc = b.doc()
    expect(doc.frames[2]).toMatchObject({ name: 'Frame A copy', left: 24, top: 24 })
    const [i, t] = doc.objects.slice(3)
    expect(i).toMatchObject({ type: 'image', assetId: 'a1', frameId: doc.frames[2]!.id, left: 74, top: 74 })
    expect(t).toMatchObject({ type: 'text', text: 't1', left: 924, top: 924 })
    expect(new Set([...doc.frames, ...doc.objects].map((record) => record.id)).size).toBe(8)
    b.editor.undo()
    expect(b.doc().objects).toEqual(OBJECTS)
    expect(b.editor.getState().canUndo).toBe(false)
    b.editor.redo()
    expect(b.doc()).toEqual(doc)
  })

  it('never duplicates a locked selection or runs during a canvas gesture', async () => {
    const b = await board(FRAMES, [{ ...OBJECTS[0]!, locked: true }, ...OBJECTS.slice(1)])
    b.editor.selectLayer('i1')
    b.editor.duplicateSelection()
    b.editor.selectLayer('i2')
    const transform = press(b.canvas, b.obj('i2'))
    b.editor.duplicateSelection()
    release(b.canvas, transform)
    await tick()
    await flush()
    expect(b.ids()).toEqual(['i2', 't1', 'i1', 'B', 'A'])
    expect(b.store.attempts).toHaveLength(0)
  })
})
