import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, StoredAsset, TextRecord } from '../model/types.ts'
import { CONFLICT_MESSAGE } from '../persistence/autosave.ts'
import { ABSENT, BoardConflictError, IndexedDbBoardStore } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { idOf } from './objects.ts'
import { canvasOf, dragBy, moveCanvas, press, pressCanvas, release, releaseCanvas, scaleBy, tick } from './testing/drive.ts'
import type { PressOptions } from './testing/drive.ts'
import { ActiveSelection } from './testing/fakeFabric.ts'
import type { FakeObject, Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * Frames on the fake canvas: ownership rules, carrying, drawing, baking and commands as
 * state machines. The fake has no group geometry (a multi-selection is modelled by the
 * absolute result on its members), so anything about real selection geometry, hit
 * testing or Fabric's event order is proven in the browser (e2e/frames.spec.ts).
 *
 * Images are 200 x 100 in the fake, so an image at (left, top) has its centre at
 * (left + 100, top + 50). A text is `width` wide and 30 high at font size 24.
 */
const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([7, 8, 9]).buffer })
const F = (id: string, left: number, top: number, width = 400, height = 300): FrameRecord => ({ id, name: id, left, top, width, height })
const img = (id: string, left: number, top: number, frameId?: string): ImageRecord => ({
  type: 'image',
  id,
  left,
  top,
  angle: 0,
  assetId: 'a1',
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

async function board(frames: FrameRecord[], objects: ObjectRecord[], viewport = { zoom: 1, panX: 0, panY: 0 }) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Frames', frames, objects, viewport }
  const store = new SpyStore(frames.length + objects.length > 0 ? { doc, assets: new Map([['a1', asset('a1')]]) } : null)
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const obj = (id: string): FakeObject => {
    const found = canvas.objects.find((o) => idOf(o as never) === id)
    if (!found) throw new Error(`no object ${id} on the canvas`)
    return found
  }
  const doc_ = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc()
  const rec = (id: string) => {
    const found = doc_().objects.find((o) => o.id === id)
    if (!found) throw new Error(`no record ${id}`)
    return found
  }
  const frame = (id: string) => {
    const found = doc_().frames.find((f) => f.id === id)
    if (!found) throw new Error(`no frame ${id}`)
    return found
  }
  const owner = (id: string) => rec(id).frameId
  const owners = () => Object.fromEntries(doc_().objects.map((o) => [o.id, o.frameId]))
  const select = (...ids: string[]) => {
    const objs = ids.map(obj)
    canvas.setActiveObject(objs.length === 1 ? objs[0]! : new ActiveSelection(objs))
    return canvas.getActiveObject()!
  }
  /** Selects the ids and drags the selection by (dx, dy), through settlement. */
  const move = async (ids: string[], dx: number, dy: number) => {
    const t = press(canvas, select(...ids))
    dragBy(canvas, t, dx, dy)
    release(canvas, t)
    await tick()
  }
  /** Selects the ids and scales the selection from a handle, through settlement. */
  const scale = async (ids: string[], fx: number, fy = fx, opts: PressOptions = {}) => {
    const t = press(canvas, select(...ids), { action: 'scale', corner: 'br', ...opts })
    scaleBy(canvas, t, fx, fy)
    release(canvas, t)
    await tick()
  }
  return { editor, store, canvas, obj, rec, frame, owner, owners, select, move, scale, doc: doc_ }
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

describe('a stored board with frames', () => {
  it('opens editable, restores ownership exactly as stored, and saves frames and owners intact', async () => {
    // "inside" sits inside A without being owned; "owned" is owned by A although it sits outside it.
    const b = await board([F('A', 0, 0)], [img('inside', 50, 50), img('owned', 900, 900, 'A')])
    expect(b.editor.getState().readOnly).toBeNull()
    expect(b.owners()).toEqual({ inside: undefined, owned: 'A' }) // never recomputed on load
    await flush()
    expect(b.store.attempts).toHaveLength(0) // loading writes nothing
    b.editor.setTitle('Edited')
    await flush()
    const saved = b.store.saves[0]!.doc
    expect(saved.frames).toEqual([F('A', 0, 0)])
    expect(saved.objects.map((o) => o.frameId)).toEqual([undefined, 'A'])
  })

  it('clicking a restored object that sits inside a frame without being owned changes nothing', async () => {
    const b = await board([F('A', 0, 0)], [img('inside', 50, 50)])
    const t = press(b.canvas, b.select('inside'))
    release(b.canvas, t)
    await tick()
    await flush()
    expect(b.owner('inside')).toBeUndefined()
    expect(b.editor.getState().canUndo).toBe(false)
    expect(b.store.attempts).toHaveLength(0) // no history entry, no save: the stored row is untouched
  })
})

describe('drawing a frame', () => {
  const draw = async (b: Awaited<ReturnType<typeof board>>, from: [number, number], to: [number, number]) => {
    b.editor.setTool('frame')
    pressCanvas(b.canvas, ...from)
    moveCanvas(b.canvas, ...to)
    releaseCanvas(b.canvas, ...to)
    await tick()
  }

  it('creates the frame below all content in one step, selects it, returns to Select, and adopts nothing', async () => {
    const b = await board([F('A', 0, 0)], [img('loose', 600, 50), img('m1', 50, 50, 'A')])
    await draw(b, [500, 20], [900, 400]) // drawn right round "loose" (centre 700,100)
    const frames = b.doc().frames
    expect(frames).toHaveLength(2)
    const made = frames[1]!
    expect(made).toMatchObject({ name: 'Frame 1', left: 500, top: 20, width: 400, height: 380 })
    // Canvas order: every frame first, then content. The new frame is the front-most frame.
    expect(b.canvas.objects.map((o) => idOf(o as never))).toEqual(['A', made.id, 'loose', 'm1'])
    expect(idOf(b.canvas.getActiveObject() as never)).toBe(made.id)
    expect(b.editor.getState()).toMatchObject({ tool: 'select', canUndo: true })
    expect(b.editor.getState().selection).toMatchObject({ kind: 'frame', frameName: 'Frame 1', memberCount: 0 })
    expect(b.owners()).toEqual({ loose: undefined, m1: 'A' }) // drawing a frame adopts nothing (O5)
    expect(b.canvas.draft).toBeNull()

    await flush()
    const saved = b.store.saves.at(-1)!.doc
    expect(saved.frames).toHaveLength(2)
    expect(saved.objects.find((o) => o.id === 'loose')).not.toHaveProperty('frameId')

    b.editor.undo()
    expect(b.doc().frames).toHaveLength(1)
    expect(b.editor.getState().canUndo).toBe(false) // exactly one step
  })

  it('moving the surrounded objects afterwards makes them members', async () => {
    const b = await board([], [img('one', 520, 40), img('two', 560, 200)])
    await draw(b, [500, 20], [900, 400])
    const id = b.doc().frames[0]!.id
    await b.move(['one', 'two'], 5, 5) // one gesture adopts them all: the frame itself was not transformed
    expect(b.owners()).toEqual({ one: id, two: id })
    expect(b.editor.getState().selection?.kind).toBe('multiple')
  })

  it('shows the rectangle while drawing, in scene units, and nothing is on the board until release', async () => {
    const b = await board([], [img('i', 0, 0)])
    b.editor.setTool('frame')
    pressCanvas(b.canvas, 300, 300)
    moveCanvas(b.canvas, 100, 450) // dragged up-left: normalized
    expect(b.canvas.draft).toEqual({ left: 100, top: 300, width: 200, height: 150 })
    expect(b.canvas.objects).toHaveLength(1)
    expect(b.doc().frames).toEqual([]) // a save now stores no frame
    releaseCanvas(b.canvas, 100, 450)
    expect(b.canvas.objects).toHaveLength(1) // not inside the canvas callback either
    await tick()
    expect(b.doc().frames[0]).toMatchObject({ left: 100, top: 300, width: 200, height: 150 })
  })

  it('a plain click makes a default frame of 640 x 480 screen pixels at the click, at any zoom', async () => {
    const b = await board([], [img('i', 0, 0)], { zoom: 2, panX: 0, panY: 0 })
    b.editor.setTool('frame')
    pressCanvas(b.canvas, 40, 60)
    releaseCanvas(b.canvas, 41, 60) // moved less than the click slop
    await tick()
    expect(b.doc().frames[0]).toMatchObject({ left: 40, top: 60, width: 320, height: 240 })
  })

  it('a small drag gives at least the minimum size', async () => {
    const b = await board([], [img('i', 0, 0)])
    await draw(b, [100, 100], [110, 500])
    expect(b.doc().frames[0]).toMatchObject({ left: 100, top: 100, width: 24, height: 400 })
  })

  it('the minimum size grows away from the press point, in the direction of the drag', async () => {
    const b = await board([], [img('i', 0, 0)])
    await draw(b, [600, 400], [590, 300]) // dragged up and slightly left
    expect(b.doc().frames[0]).toMatchObject({ left: 576, top: 300, width: 24, height: 100 }) // right edge still at the press point
    await draw(b, [900, 900], [905, 890]) // up and slightly right
    expect(b.doc().frames[1]).toMatchObject({ left: 900, top: 876, width: 24, height: 24 })
  })

  it('the Frame tool grabs and selects nothing, and draws no marquee', async () => {
    const b = await board([F('A', 0, 0)], [img('i', 50, 50)])
    b.editor.setTool('frame')
    expect(b.editor.getState().tool).toBe('frame')
    expect(b.canvas).toMatchObject({ skipTargetFind: true, selection: false, defaultCursor: 'crosshair' })
    b.editor.setTool('select')
    expect(b.canvas).toMatchObject({ skipTargetFind: false, selection: true })
  })

  it('a press with another button starts no draft, and its release leaves a draft in place', async () => {
    const b = await board([], [img('i', 0, 0)])
    b.editor.setTool('frame')
    pressCanvas(b.canvas, 100, 100, 2)
    moveCanvas(b.canvas, 400, 400)
    releaseCanvas(b.canvas, 400, 400, 2)
    await tick()
    expect(b.doc().frames).toEqual([])
    expect(b.canvas.draft).toBeNull()
    expect(b.editor.getState()).toMatchObject({ tool: 'frame', canUndo: false })

    pressCanvas(b.canvas, 100, 100) // a primary draft ...
    moveCanvas(b.canvas, 300, 300)
    releaseCanvas(b.canvas, 300, 300, 1) // ... is not ended by another button
    releaseCanvas(b.canvas, 300, 300, 2)
    await tick()
    expect(b.doc().frames).toEqual([])
    expect(b.canvas.draft).not.toBeNull()
    moveCanvas(b.canvas, 500, 400)
    releaseCanvas(b.canvas, 500, 400) // the matching primary release settles it
    await tick()
    expect(b.doc().frames[0]).toMatchObject({ left: 100, top: 100, width: 400, height: 300 })
  })

  it('Esc mid-draft makes no object and no Fabric call, returns to Select, and a new draft then works', async () => {
    const b = await board([], [img('i', 0, 0)])
    b.editor.setTool('frame')
    pressCanvas(b.canvas, 100, 100)
    moveCanvas(b.canvas, 400, 400)
    const callsBefore = b.canvas.calls.length
    const event = key('Escape')
    b.editor.handleKeyDown(event)
    expect(event.defaultPrevented).toBe(true)
    expect(b.canvas.calls.slice(callsBefore)).toEqual([]) // no add/remove/select/endCurrentTransform
    expect(b.canvas.draft).toBeNull()
    expect(b.canvas.objects).toHaveLength(1)
    expect(b.editor.getState()).toMatchObject({ tool: 'select', canUndo: false })

    releaseCanvas(b.canvas, 400, 400) // the late release creates nothing
    await tick()
    await flush()
    expect(b.doc().frames).toEqual([])
    expect(b.store.attempts).toHaveLength(0)

    await draw(b, [0, 0], [200, 200])
    expect(b.doc().frames).toHaveLength(1)
  })

  it('a window blur mid-draft drops it; commands are inert while drawing', async () => {
    const b = await board([], [img('i', 0, 0)])
    b.editor.setTool('frame')
    pressCanvas(b.canvas, 100, 100)
    moveCanvas(b.canvas, 400, 400)
    b.editor.addFrame()
    b.editor.setTool('select')
    b.editor.selectAll()
    expect(b.canvas.objects).toHaveLength(1)
    expect(b.editor.getState().tool).toBe('frame')
    window.dispatchEvent(new Event('blur'))
    expect(b.canvas.draft).toBeNull()
    releaseCanvas(b.canvas, 400, 400)
    await tick()
    expect(b.doc().frames).toEqual([])
  })

  it('with the hand held (Space) a press pans instead of drawing', async () => {
    const b = await board([], [img('i', 0, 0)])
    b.editor.setTool('frame')
    b.editor.handleKeyDown(key(' ', { code: 'Space' }))
    pressCanvas(b.canvas, 100, 100)
    moveCanvas(b.canvas, 400, 400)
    releaseCanvas(b.canvas, 400, 400)
    await tick()
    expect(b.doc().frames).toEqual([])
  })

  it('addFrame adds a default frame in the middle of the view, below content, in one step', async () => {
    const b = await board([], [img('loose', 0, 0)])
    b.editor.addFrame()
    const made = b.doc().frames[0]!
    expect(made).toMatchObject({ name: 'Frame 1', width: 640, height: 480 })
    expect(b.canvas.objects.map((o) => idOf(o as never))).toEqual([made.id, 'loose'])
    expect(b.owner('loose')).toBeUndefined()
    b.editor.addFrame()
    expect(b.doc().frames.map((f) => f.name)).toEqual(['Frame 1', 'Frame 2'])
    b.editor.undo()
    b.editor.undo()
    expect(b.editor.getState().canUndo).toBe(false)
  })
})

describe('moving frames: members are carried, nothing is adopted', () => {
  it('a frame moved over a loose object does not adopt it and leaves it behind on its next move', async () => {
    const b = await board([F('A', 0, 0)], [img('m1', 50, 50, 'A'), img('loose', 600, 50)])
    await b.move(['A'], 550, 0) // A now covers "loose"
    expect(b.frame('A')).toMatchObject({ left: 550, top: 0 })
    expect(b.owners()).toEqual({ m1: 'A', loose: undefined })
    expect(b.rec('m1')).toMatchObject({ left: 600, top: 50 }) // carried
    await b.move(['A'], 0, 400)
    expect(b.rec('loose')).toMatchObject({ left: 600, top: 50 }) // stayed put
    expect(b.rec('m1')).toMatchObject({ left: 600, top: 450 })
    expect(b.editor.getState().selection).toMatchObject({ kind: 'frame', memberCount: 1 })
  })

  it('moving that object itself, even slightly, inside the frame makes it a member that then travels with it', async () => {
    const b = await board([F('A', 0, 0)], [img('loose', 600, 50)])
    await b.move(['A'], 550, 0)
    await b.move(['loose'], 3, 2)
    expect(b.owner('loose')).toBe('A')
    await b.move(['A'], 100, 100)
    expect(b.rec('loose')).toMatchObject({ left: 703, top: 152 })
  })

  it('carries each member exactly once; a selected member is not moved twice', async () => {
    const b = await board([F('A', 0, 0)], [img('sel', 50, 50, 'A'), img('unsel', 150, 150, 'A')])
    await b.move(['A', 'sel'], 40, 30)
    expect(b.frame('A')).toMatchObject({ left: 40, top: 30 })
    expect(b.rec('sel')).toMatchObject({ left: 90, top: 80, frameId: 'A' }) // through the selection, once
    expect(b.rec('unsel')).toMatchObject({ left: 190, top: 180, frameId: 'A' }) // carried, once
  })

  it('followers move during the drag, not only on release, and Esc puts everything back', async () => {
    const b = await board([F('A', 0, 0)], [img('m1', 50, 50, 'A')])
    const before = b.doc()
    const t = press(b.canvas, b.select('A'))
    dragBy(b.canvas, t, 70, 0)
    expect(b.obj('m1')).toMatchObject({ left: 120, top: 50 })
    dragBy(b.canvas, t, 30, 20)
    expect(b.obj('m1')).toMatchObject({ left: 150, top: 70 })
    expect(b.doc().objects).toEqual(before.objects) // a save mid-drag still sees the scene from before
    b.editor.handleKeyDown(key('Escape'))
    expect(b.doc()).toEqual(before)
    expect(b.editor.getState().canUndo).toBe(false)
  })

  it('five moves and back are exact', async () => {
    const b = await board([F('A', 0, 0)], [img('m1', 50, 50, 'A'), txt('m2', 60, 200, 'A')])
    const before = b.doc()
    for (let i = 0; i < 5; i++) await b.move(['A'], 13.37, -7.21)
    for (let i = 0; i < 5; i++) await b.move(['A'], -13.37, 7.21)
    expect(b.doc().frames).toEqual(before.frames)
    expect(b.doc().objects).toEqual(before.objects)
  })

  it('moving A over B and back leaves both frames members unchanged', async () => {
    const b = await board([F('A', 0, 0), F('B', 1000, 0)], [img('a1', 50, 50, 'A'), img('b1', 1050, 50, 'B')])
    await b.move(['A'], 1000, 0) // exactly on top of B
    expect(b.owners()).toEqual({ a1: 'A', b1: 'B' })
    expect(b.rec('b1')).toMatchObject({ left: 1050, top: 50 }) // B's member did not move
    await b.move(['A'], -1000, 0)
    expect(b.owners()).toEqual({ a1: 'A', b1: 'B' })
    expect(b.rec('a1')).toMatchObject({ left: 50, top: 50 })
  })

  it('one undo takes back the frame and everything it carried', async () => {
    const b = await board([F('A', 0, 0)], [img('m1', 50, 50, 'A'), img('m2', 150, 150, 'A')])
    const before = b.doc()
    await b.move(['A'], 300, 200)
    b.editor.undo()
    expect(b.doc()).toEqual(before)
    expect(b.editor.getState().canUndo).toBe(false)
    b.editor.redo()
    expect(b.rec('m2')).toMatchObject({ left: 450, top: 350 })
  })
})

describe('mixed selections: a co-moved frame never adopts', () => {
  it('a frame dragged together with a loose object sitting inside it leaves the object loose', async () => {
    const b = await board([F('A', 0, 0)], [img('loose', 100, 150)]) // centre (200, 200): inside A
    await b.move(['A', 'loose'], 30, 30)
    expect(b.owner('loose')).toBeUndefined()
    await b.move(['A'], 500, 0)
    expect(b.rec('loose')).toMatchObject({ left: 130, top: 180 }) // and so it is left behind
  })

  it('an object owned by an unselected frame keeps that owner while it is still inside it', async () => {
    const b = await board([F('A', 0, 0), F('B', 1000, 0)], [txt('t1', 1050, 50, 'B')])
    await b.move(['A', 't1'], 10, 10)
    expect(b.owner('t1')).toBe('B')
  })

  it('once it leaves that owner it joins only an unselected frame, or becomes loose; never the co-moved frame', async () => {
    // A overlaps the lower part of B; the text is B's and sits in that overlap. C is far below.
    const b = await board([F('A', 1000, 200), F('B', 1000, 0), F('C', 1000, 1000)], [txt('t1', 1050, 250, 'B')])
    // Dragged together with A: the text leaves B but is still inside A, which moved with it.
    await b.move(['A', 't1'], 0, 100) // text centre (1150, 365): outside B (0..300), inside A (now 300..600)
    expect(b.frame('A')).toMatchObject({ top: 300 })
    expect(b.owner('t1')).toBeUndefined() // loose: the co-moved frame is never a candidate
    await b.move(['A', 't1'], 0, 700) // text centre (1150, 1065): inside the unselected C (and still inside A)
    expect(b.owner('t1')).toBe('C')
  })

  it('Ctrl+A and move keeps every owner and adopts nothing', async () => {
    const b = await board(
      [F('A', 0, 0), F('B', 1000, 0)],
      [img('a1', 50, 50, 'A'), img('looseInA', 150, 150), txt('b1', 1050, 50, 'B'), img('farOwned', 3000, 3000, 'A'), img('loose', 600, 600)],
    )
    const before = b.owners()
    b.editor.selectAll()
    const t = press(b.canvas, b.canvas.getActiveObject()!)
    dragBy(b.canvas, t, 77, -33)
    release(b.canvas, t)
    await tick()
    expect(b.owners()).toEqual(before)
    expect(b.owners()).toEqual({ a1: 'A', looseInA: undefined, b1: 'B', farOwned: 'A', loose: undefined })
    expect(b.rec('a1')).toMatchObject({ left: 127, top: 17 }) // moved once
  })
})

describe('moving content: ownership follows the object', () => {
  it('a loose image dragged into a frame is owned by it; dragged out, it is loose; into another, that one', async () => {
    const b = await board([F('A', 0, 0), F('B', 1000, 0)], [img('i', 600, 50)])
    await b.move(['i'], -500, 0) // centre (200, 100)
    expect(b.owner('i')).toBe('A')
    await b.move(['i'], 500, 0)
    expect(b.owner('i')).toBeUndefined()
    await b.move(['i'], 500, 0) // centre (1200, 100)
    expect(b.owner('i')).toBe('B')
    await b.move(['i'], -1000, 0)
    expect(b.owner('i')).toBe('A')
  })

  it('in an overlap it joins the front-most frame and keeps it after the frames are reordered', async () => {
    // A is behind, B in front; they overlap for x in 200..400.
    const b = await board([F('A', 0, 0), F('B', 200, 0)], [img('i', 900, 50)])
    await b.move(['i'], -700, 0) // centre (300, 100): in the overlap
    expect(b.owner('i')).toBe('B')
    b.select('A')
    b.editor.arrange('front')
    expect(b.doc().frames.map((f) => f.id)).toEqual(['B', 'A'])
    expect(b.owner('i')).toBe('B') // reordering frames changes no owner
    await b.move(['i'], 20, 20) // still in the overlap: sticky
    expect(b.owner('i')).toBe('B')
    await b.move(['i'], -200, 0) // centre (120, 120): A only
    expect(b.owner('i')).toBe('A')
  })

  it('scaling or otherwise transforming an owned object re-evaluates it from its final centre', async () => {
    const b = await board([F('A', 0, 0)], [img('i', 250, 150, 'A')]) // centre (350, 200)
    await b.scale(['i'], 3) // grows from its top-left: centre (550, 300), outside A
    expect(b.owner('i')).toBeUndefined()
  })
})

describe('resizing frames', () => {
  it('shrinking a frame releases members it no longer contains to loose, even when another frame contains them', async () => {
    const b = await board([F('D', 100, 0, 300, 300), F('A', 0, 0)], [img('m1', 50, 50, 'A')]) // m1 centre (150, 100): also inside D
    const before = b.rec('m1')
    await b.scale(['A'], 0.3) // A becomes 120 x 90, anchored at its top-left
    expect(b.frame('A')).toMatchObject({ left: 0, top: 0, width: 120, height: 90 })
    expect(b.owner('m1')).toBeUndefined() // loose: not transferred to D
    expect({ ...b.rec('m1'), frameId: 'A' }).toEqual(before) // and it did not move
    expect(b.obj('A')).toMatchObject({ scaleX: 1, scaleY: 1, width: 120, height: 90 }) // baked
    await b.move(['m1'], 1, 1) // only its own movement lets D take it
    expect(b.owner('m1')).toBe('D')
  })

  it('a member still inside the shrunken frame stays', async () => {
    const b = await board([F('A', 0, 0)], [img('near', 10, 10, 'A'), img('far', 190, 190, 'A')])
    await b.scale(['A'], 0.6) // 240 x 180: "near" centre (110, 60) inside, "far" centre (290, 240) outside
    expect(b.owners()).toEqual({ near: 'A', far: undefined })
  })

  it('growing a frame over a loose object adopts nothing, and resizing moves nothing', async () => {
    const b = await board([F('A', 0, 0)], [img('m1', 50, 50, 'A'), img('loose', 600, 50)])
    const before = b.doc().objects
    await b.scale(['A'], 2)
    expect(b.frame('A')).toMatchObject({ width: 800, height: 600 })
    expect(b.doc().objects).toEqual(before)
    expect(b.owner('loose')).toBeUndefined()
  })

  it('a single frame resizes freely per axis', async () => {
    const b = await board([F('A', 0, 0)], [])
    await b.scale(['A'], 2, 0.5)
    expect(b.frame('A')).toMatchObject({ left: 0, top: 0, width: 800, height: 150 })
  })

  it('each side stops at the minimum, with the edge opposite the handle fixed', async () => {
    const b = await board([F('A', 100, 100, 100, 100)], [])
    await b.scale(['A'], 0.1, 0.1, { corner: 'tl', originX: 'right', originY: 'bottom' })
    expect(b.frame('A')).toEqual({ id: 'A', name: 'A', left: 176, top: 176, width: 24, height: 24 }) // right and bottom edges still at 200
    b.editor.undo()
    await b.scale(['A'], 0.1, 3) // only the narrowed axis is limited
    expect(b.frame('A')).toMatchObject({ left: 100, top: 100, width: 24, height: 300 })
  })

  it('a frame already below the minimum can grow, cannot shrink, and is never snapped up', async () => {
    const b = await board([F('A', 0, 0, 10, 200)], [])
    await b.scale(['A'], 0.5)
    expect(b.frame('A')).toMatchObject({ width: 10, height: 100 })
    await b.scale(['A'], 1.5)
    expect(b.frame('A')).toMatchObject({ width: 15, height: 150 })
  })

  it('frame + some members scaled: selected members keep the owner, unselected ones outside are released, none transferred', async () => {
    const b = await board(
      [F('D', 300, 150, 300, 300), F('A', 0, 0)],
      [img('sel', 40, 40, 'A'), img('unsel', 250, 180, 'A')], // unsel centre (350, 230): also inside D
    )
    await b.scale(['A', 'sel'], 0.5) // about the selection's top-left corner (0, 0)
    expect(b.frame('A')).toMatchObject({ left: 0, top: 0, width: 200, height: 150 })
    expect(b.obj('A')).toMatchObject({ scaleX: 1, scaleY: 1 }) // baked to scale 1
    expect(b.rec('sel')).toMatchObject({ left: 20, top: 20, scaleX: 0.5, scaleY: 0.5, frameId: 'A' }) // scaled once, still A's
    expect(b.rec('unsel')).toMatchObject({ left: 250, top: 180, scaleX: 1 }) // untouched ...
    expect(b.owner('unsel')).toBeUndefined() // ... and released, not handed to D
    expect(b.editor.getState().selection).toMatchObject({ kind: 'multiple', count: 2 }) // the selection is re-formed
  })

  it('frame + all members scaled together keeps every owner and bakes the frame', async () => {
    const b = await board([F('A', 0, 0)], [img('m1', 40, 40, 'A'), txt('m2', 100, 200, 'A')])
    await b.scale(['A', 'm1', 'm2'], 2)
    expect(b.frame('A')).toMatchObject({ width: 800, height: 600 })
    expect(b.owners()).toEqual({ m1: 'A', m2: 'A' })
    expect(b.rec('m2')).toMatchObject({ left: 200, top: 400, fontSize: 48, width: 400 }) // text folded, once
    expect(b.obj('m2')).toMatchObject({ scaleX: 1, scaleY: 1 })
    b.editor.undo()
    expect(b.frame('A')).toMatchObject({ width: 400, height: 300 })
    expect(b.editor.getState().canUndo).toBe(false)
  })
})

describe('creating content inside a frame (O4)', () => {
  it('a new text is owned from the moment it exists: the first autosave during typing already stores the owner', async () => {
    const b = await board([F('A', 0, 0)], [img('i', 2000, 2000)])
    b.editor.setTool('text')
    pressCanvas(b.canvas, 40, 40)
    b.canvas.fire('mouse:up', { e: { button: 0, clientX: 40, clientY: 40 }, isClick: true })
    await tick()
    const tb = b.canvas.objects.at(-1) as Textbox
    expect(tb.isEditing).toBe(true)
    tb.type('typing')
    await flush()
    const saved = b.store.saves.at(-1)!.doc.objects.find((o) => o.type === 'text')!
    expect(saved).toMatchObject({ text: 'typing', frameId: 'A' })
    expect(b.editor.getState().canUndo).toBe(false) // assigning the owner touched no history

    // Reloading in the middle of typing: the stored text is A's and travels with A.
    const reloaded = await board(b.store.saves.at(-1)!.doc.frames, b.store.saves.at(-1)!.doc.objects)
    expect(reloaded.owner(saved.id)).toBe('A')
    await reloaded.move(['A'], 100, 0)
    expect(reloaded.rec(saved.id).left).toBe(saved.left + 100)

    tb.exitEditing()
    expect(b.editor.getState().canUndo).toBe(true)
    b.editor.undo()
    expect(b.doc().objects).toHaveLength(1)
    expect(b.editor.getState().canUndo).toBe(false) // creating and typing was exactly one step
  })

  it('ownership goes by the centre of the text box, for a new text as for any other object', async () => {
    // The box of a new text is ten times its font size wide (240 here), whatever is typed.
    const b = await board([F('A', 0, 0)], [img('i', 2000, 2000)])
    const place = async (x: number, y: number) => {
      b.editor.setTool('text')
      pressCanvas(b.canvas, x, y)
      b.canvas.fire('mouse:up', { e: { button: 0, clientX: x, clientY: y }, isClick: true })
      await tick()
      const tb = b.canvas.objects.at(-1) as Textbox
      tb.type('t')
      tb.exitEditing()
      return b.doc().objects.at(-1)!
    }
    expect(await place(40, 100)).toMatchObject({ frameId: 'A' }) // box centre (160, 115): inside A
    expect(await place(279, 100)).toMatchObject({ frameId: 'A' }) // box centre (399, 115): just inside
    // Clicked inside A, 80 units from its right edge: the box centre (440, 115) is outside A, so
    // the text is loose. A known consequence of the centre rule; see the README's known limits.
    expect(await place(320, 100)).not.toHaveProperty('frameId')
    // Moving that text so that its box centre is inside A is what makes it A's.
    const id = b.doc().objects.at(-1)!.id
    await b.move([id], -100, 0)
    expect(b.owner(id)).toBe('A')
  })

  it('a new text outside every frame is loose', async () => {
    const b = await board([F('A', 0, 0)], [img('i', 2000, 2000)])
    b.editor.setTool('text')
    pressCanvas(b.canvas, 900, 900)
    b.canvas.fire('mouse:up', { e: { button: 0, clientX: 900, clientY: 900 }, isClick: true })
    await tick()
    const tb = b.canvas.objects.at(-1) as Textbox
    tb.type('out here')
    tb.exitEditing()
    expect(b.doc().objects.at(-1)).not.toHaveProperty('frameId')
  })

  it('a new text is evaluated once more when its edit ends, because its box grew while typing', async () => {
    const b = await board([F('A', 0, 0)], [img('i', 2000, 2000)])
    b.editor.setTool('text')
    pressCanvas(b.canvas, 40, 260)
    b.canvas.fire('mouse:up', { e: { button: 0, clientX: 40, clientY: 260 }, isClick: true }) // centre (160, 275): inside A
    await tick()
    const tb = b.canvas.objects.at(-1) as Textbox
    tb.type('line\n'.repeat(30))
    tb.height = 900 // many lines: the centre is now far below A
    tb.exitEditing()
    expect(b.doc().objects.at(-1)).not.toHaveProperty('frameId')
  })

  it('re-editing an existing text never changes its owner, even when its box grows past the frame', async () => {
    const b = await board([F('A', 0, 0), F('B', 0, 400)], [txt('t', 40, 260, 'A')])
    const tb = b.obj('t') as Textbox
    b.select('t')
    tb.enterEditing()
    tb.type('line\n'.repeat(30))
    tb.height = 900 // centre now inside B, far outside A
    tb.exitEditing()
    expect(b.owner('t')).toBe('A')
    expect(b.editor.getState().canUndo).toBe(true)
  })

  it('typing and font-size changes leave owners alone', async () => {
    const b = await board([F('A', 0, 0)], [txt('t', 250, 260, 'A')])
    b.select('t')
    b.editor.setFontSize(400)
    ;(b.obj('t') as Textbox).height = 500 // centre well outside A
    b.editor.setFontSize(399)
    expect(b.rec('t')).toMatchObject({ fontSize: 399, frameId: 'A' })
  })

  it('an imported image placed inside a frame is saved owned in its very first save', async () => {
    const b = await board([F('A', 0, 0)], [img('i', 2000, 2000)])
    await b.editor.addImageFiles([new File([new Uint8Array([1])], 'in.png', { type: 'image/png' })], { clientX: 200, clientY: 150 })
    await flush()
    expect(b.store.saves).toHaveLength(1)
    const added = b.store.saves[0]!.doc.objects.at(-1)!
    expect(added).toMatchObject({ type: 'image', frameId: 'A' })
    expect(b.editor.getState().canUndo).toBe(true)

    await b.editor.addImageFiles([new File([new Uint8Array([1])], 'out.png', { type: 'image/png' })], { clientX: 900, clientY: 900 })
    expect(b.doc().objects.at(-1)).not.toHaveProperty('frameId')
  })

  it('an image dropped where two frames overlap is owned by the front-most', async () => {
    const b = await board([F('A', 0, 0), F('B', 200, 0)], [])
    await b.editor.addImageFiles([new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })], { clientX: 300, clientY: 100 })
    expect(b.doc().objects[0]).toMatchObject({ frameId: 'B' })
  })
})

describe('a drifted owner: a text whose centre has left its frame', () => {
  async function drifted() {
    const b = await board([F('A', 0, 0), F('B', 1000, 0)], [txt('t', 40, 260, 'A'), img('loose', 100, 100)])
    const tb = b.obj('t') as Textbox
    b.select('t')
    tb.enterEditing()
    tb.type('grown')
    tb.height = 900 // centre (140, 710): outside A
    tb.exitEditing()
    expect(b.owner('t')).toBe('A')
    return b
  }

  it('Ctrl+A and move: the text is still its frame, and no loose object gained an owner', async () => {
    const b = await drifted()
    b.editor.selectAll()
    const t = press(b.canvas, b.canvas.getActiveObject()!)
    dragBy(b.canvas, t, 25, 25)
    release(b.canvas, t)
    await tick()
    expect(b.owners()).toEqual({ t: 'A', loose: undefined })
    // After that, moving the frame alone carries the text and leaves the loose image.
    const looseBefore = b.rec('loose')
    const textBefore = b.rec('t')
    await b.move(['A'], 200, 0)
    expect(b.rec('t').left).toBe(textBefore.left + 200)
    expect(b.rec('loose')).toEqual(looseBefore)
  })

  it('scaled together with its frame: still its frame', async () => {
    const b = await drifted()
    await b.scale(['A', 't'], 1.5)
    expect(b.owner('t')).toBe('A')
  })

  it('dragged on its own, ending outside its frame: released, or taken by a frame that was not transformed', async () => {
    const b = await drifted()
    await b.move(['t'], 5, 5) // centre still outside A, inside nothing
    expect(b.owner('t')).toBeUndefined()
    b.editor.undo()
    expect(b.owner('t')).toBe('A')
    await b.move(['t'], 1000, -200) // (the fake rebuilt it at its plain size) centre (1140, 75): inside B
    expect(b.owner('t')).toBe('B')
  })
})

describe('frame commands', () => {
  it('deleting a frame keeps its contents as loose objects, and undo restores the owners', async () => {
    const b = await board([F('A', 0, 0), F('B', 1000, 0)], [img('a1', 50, 50, 'A'), txt('a2', 60, 200, 'A'), img('b1', 1050, 50, 'B')])
    b.select('A')
    b.editor.deleteSelection()
    expect(b.doc().frames.map((f) => f.id)).toEqual(['B'])
    expect(b.doc().objects.map((o) => o.id)).toEqual(['a1', 'a2', 'b1']) // nothing else was deleted
    expect(b.owners()).toEqual({ a1: undefined, a2: undefined, b1: 'B' })
    b.editor.undo()
    expect(b.doc().frames.map((f) => f.id)).toEqual(['A', 'B'])
    expect(b.owners()).toEqual({ a1: 'A', a2: 'A', b1: 'B' })
    expect(b.editor.getState().canUndo).toBe(false)
  })

  it('deleting a frame together with one of its members deletes exactly those', async () => {
    const b = await board([F('A', 0, 0)], [img('a1', 50, 50, 'A'), img('a2', 150, 150, 'A')])
    b.select('A', 'a1')
    b.editor.deleteSelection()
    expect(b.doc().frames).toEqual([])
    expect(b.doc().objects).toEqual([img('a2', 150, 150)])
  })

  it('the last frame deleted: the board is saved without any frame fields again', async () => {
    const b = await board([F('A', 0, 0)], [img('a1', 50, 50, 'A')])
    b.select('A')
    b.editor.handleKeyDown(key('Delete'))
    await flush()
    const saved = b.store.saves.at(-1)!.doc
    expect(saved.frames).toEqual([])
    expect(saved.objects[0]).not.toHaveProperty('frameId')
  })

  it('renames the selected frame, normalized, as one coalesced undo step', async () => {
    const b = await board([F('A', 0, 0)], [img('a1', 50, 50, 'A')])
    expect(b.editor.renameFrame('nothing selected')).toBeNull()
    b.select('a1')
    expect(b.editor.renameFrame('not a frame')).toBeNull()
    b.select('A')
    expect(b.editor.renameFrame('  Cover   page ')).toBe('Cover page')
    expect(b.frame('A').name).toBe('Cover page')
    expect(b.editor.getState().selection?.frameName).toBe('Cover page')
    expect(b.editor.renameFrame('Cover pages')).toBe('Cover pages') // typed soon after: same step
    expect(b.editor.renameFrame('   ')).toBe('Frame')
    expect(b.owner('a1')).toBe('A') // renaming changes no owner
    b.editor.undo()
    expect(b.frame('A').name).toBe('A')
    expect(b.editor.getState().canUndo).toBe(false)
  })

  it('renaming to the same name records nothing', async () => {
    const b = await board([F('A', 0, 0)], [])
    b.select('A')
    expect(b.editor.renameFrame('A')).toBe('A')
    expect(b.editor.getState().canUndo).toBe(false)
  })

  it('"Select with contents" selects the frame plus exactly what it owns, and records nothing', async () => {
    const b = await board(
      [F('A', 0, 0), F('B', 1000, 0)],
      [img('a1', 50, 50, 'A'), img('looseInA', 150, 150), txt('a2', 3000, 3000, 'A'), img('b1', 1050, 50, 'B')],
    )
    b.select('A')
    expect(b.editor.getState().selection).toMatchObject({ kind: 'frame', memberCount: 2 }) // not the loose image inside it
    b.editor.selectFrameContents()
    expect(b.canvas.getActiveObjects().map((o) => idOf(o as never))).toEqual(['A', 'a1', 'a2'])
    expect(b.editor.getState().selection).toMatchObject({ kind: 'multiple', count: 3 })
    expect(b.editor.getState().canUndo).toBe(false)
    await flush()
    expect(b.store.attempts).toHaveLength(0)

    // Dragging that selection moves everything once (there are no followers left to carry).
    const t = press(b.canvas, b.canvas.getActiveObject()!)
    dragBy(b.canvas, t, 10, 10)
    release(b.canvas, t)
    await tick()
    expect(b.rec('a1')).toMatchObject({ left: 60, top: 60, frameId: 'A' })
    expect(b.rec('a2')).toMatchObject({ left: 3010, top: 3010, frameId: 'A' })
    expect(b.rec('looseInA')).toMatchObject({ left: 150, top: 150 })
  })

  it('"Select with contents" works for several selected frames and does nothing without a frame', async () => {
    const b = await board([F('A', 0, 0), F('B', 1000, 0)], [img('a1', 50, 50, 'A'), img('b1', 1050, 50, 'B'), img('loose', 600, 600)])
    b.select('loose')
    b.editor.selectFrameContents()
    expect(b.canvas.getActiveObjects().map((o) => idOf(o as never))).toEqual(['loose'])
    b.select('A', 'B')
    b.editor.selectFrameContents()
    expect(b.canvas.getActiveObjects().map((o) => idOf(o as never))).toEqual(['A', 'B', 'a1', 'b1'])
  })

  it('frame commands are inert while a gesture is unsettled', async () => {
    const b = await board([F('A', 0, 0)], [img('a1', 50, 50, 'A')])
    b.select('A')
    const t = press(b.canvas, b.obj('A'))
    dragBy(b.canvas, t, 10, 0)
    b.editor.selectFrameContents()
    expect(b.editor.renameFrame('Busy')).toBeNull()
    b.editor.addFrame()
    b.editor.setTool('frame')
    b.editor.handleKeyDown(key('f'))
    expect(b.canvas.getActiveObjects()).toHaveLength(1)
    expect(b.doc().frames).toHaveLength(1)
    expect(b.editor.getState().tool).toBe('select')
    release(b.canvas, t)
    await tick()
    expect(b.frame('A').name).toBe('A')
    b.editor.handleKeyDown(key('f'))
    expect(b.editor.getState().tool).toBe('frame')
  })

  it('frame commands are inert on a read-only board, and its frames cannot be selected through them', async () => {
    const b = await board([F('A', 0, 0)], [img('a1', 50, 50, 'A')])
    b.select('A')
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    b.editor.addFrame()
    b.editor.selectFrameContents()
    expect(b.editor.renameFrame('Nope')).toBeNull()
    b.editor.setTool('frame')
    b.editor.handleKeyDown(key('f'))
    pressCanvas(b.canvas, 500, 500)
    moveCanvas(b.canvas, 800, 800)
    releaseCanvas(b.canvas, 800, 800)
    await tick()
    expect(b.editor.getState()).toMatchObject({ tool: 'hand', selection: null })
    expect(b.canvas.objects).toHaveLength(2)
    expect(b.canvas.draft).toBeNull()

    // Even if a frame were somehow selected on a read-only board, the commands do nothing.
    b.canvas.setActiveObject(b.obj('A'))
    expect(b.editor.renameFrame('Forced')).toBeNull()
    b.editor.selectFrameContents()
    expect(b.frame('A').name).toBe('A')
    expect(b.canvas.getActiveObjects()).toEqual([b.obj('A')])
  })

  it('a name typed and then typed back within one step leaves no undo step', async () => {
    const b = await board([F('A', 0, 0)], [])
    b.select('A')
    b.editor.renameFrame('B')
    expect(b.editor.getState().canUndo).toBe(true)
    b.editor.renameFrame('A')
    expect(b.editor.getState().canUndo).toBe(false)
  })
})

describe('hooks for the UI', () => {
  it('double-clicking a frame asks the UI to rename it, after the canvas callback, and only for a selected frame on an editable board', async () => {
    const b = await board([F('A', 0, 0)], [img('a1', 50, 50, 'A')])
    const focus = vi.fn()
    b.editor.setFrameRenamer(focus)
    b.select('A')
    b.canvas.fire('mouse:dblclick', { e: { button: 0 }, target: b.obj('A') })
    expect(focus).not.toHaveBeenCalled() // not inside the callback
    await tick()
    expect(focus).toHaveBeenCalledTimes(1)

    b.select('a1')
    b.canvas.fire('mouse:dblclick', { e: { button: 0 }, target: b.obj('a1') }) // content: Fabric's own text editing, not ours
    b.canvas.fire('mouse:dblclick', { e: { button: 0 } }) // empty board
    b.canvas.fire('mouse:dblclick', { e: { button: 0 }, target: b.obj('A') }) // a frame that is not the selection
    await tick()
    expect(focus).toHaveBeenCalledTimes(1)

    b.select('A')
    const t = press(b.canvas, b.obj('A'))
    b.canvas.fire('mouse:dblclick', { e: { button: 0 }, target: b.obj('A') }) // mid-gesture
    await tick()
    release(b.canvas, t)
    await tick()
    expect(focus).toHaveBeenCalledTimes(1)

    b.editor.setFrameRenamer(null)
    b.canvas.fire('mouse:dblclick', { e: { button: 0 }, target: b.obj('A') })
    await tick()
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('suggests a reload only when another tab changed the board, not for a board that failed to load', async () => {
    const b = await board([F('A', 0, 0)], [img('a1', 50, 50, 'A')])
    expect(b.editor.getState().reloadSuggested).toBe(false)
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState()).toMatchObject({ readOnly: CONFLICT_MESSAGE, reloadSuggested: true })

    const store = new SpyStore({ doc: { ...createEmptyDoc(), objects: [img('gone', 0, 0)] }, assets: new Map() }) // its image bytes are missing
    store.holdLoad = false
    const broken = new Editor(host, store, new FakeAssets())
    editors.push(broken)
    await broken.init()
    expect(broken.getState().readOnly).not.toBeNull()
    expect(broken.getState().reloadSuggested).toBe(false)
  })
})

describe('undoing an image deletion after another tab pruned its bytes', () => {
  it('stores the bytes again with the next save', async () => {
    const factory = new IDBFactory()
    const seed = new IndexedDbBoardStore(factory)
    const original = asset('a1')
    const doc: BoardDoc = { ...createEmptyDoc(), frames: [F('A', 0, 0)], objects: [img('i', 50, 50, 'A')] }
    await seed.save(doc, ABSENT, () => original)

    const store = new IndexedDbBoardStore(factory)
    const editor = new Editor(host, store, new FakeAssets())
    editors.push(editor)
    await editor.init()
    const canvas = canvasOf(editor)
    canvas.setActiveObject(canvas.objects[1]!)
    editor.deleteSelection()
    await flush()

    const other = new IndexedDbBoardStore(factory) // another tab opens that revision and prunes
    const seen = await other.load()
    expect(seen!.doc.objects).toHaveLength(0)
    await other.pruneAssets(new Set(), seen!.token)
    expect((await new IndexedDbBoardStore(factory).load())!.assets.size).toBe(0)

    editor.undo() // the image is back on the canvas; its bytes are not in storage
    await flush()
    // Let the real (fake-indexeddb) write finish: it runs on setImmediate, which the fake clock leaves alone.
    const immediate = (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate
    for (let i = 0; i < 30; i++) await new Promise<void>((r) => immediate(r))
    expect(editor.getState().save.kind).toBe('saved')
    const after = await new IndexedDbBoardStore(factory).load()
    expect(after!.doc.objects).toEqual([img('i', 50, 50, 'A')])
    expect([...new Uint8Array(after!.assets.get('a1')!.bytes)]).toEqual([7, 8, 9])
  })
})
