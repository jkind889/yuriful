import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, StoredAsset, TextRecord } from '../model/types.ts'
import { CONFLICT_MESSAGE } from '../persistence/autosave.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { idOf } from './objects.ts'
import { canvasOf, dragBy, press, release, scaleBy, tick } from './testing/drive.ts'
import { ActiveSelection } from './testing/fakeFabric.ts'
import type { Canvas, FakeObject } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore, deferred } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * Replace image on the fake canvas: the target fixed when the button is pressed, every way the
 * decode can finish (at rest, mid-gesture, in crop mode, after the target went away, after
 * the board went read-only or the editor was disposed), history, ownership and what is saved.
 * Where the new picture lands on screen (also rotated) is proven in the browser
 * (e2e/images.spec.ts).
 *
 * The stored image `a1` decodes as 200 x 100; a replacement file named like `wide-400x100.png`
 * decodes at that size (see FakeAssets). Image P sits at (100, 50) at scale 1: a 200 x 100 box
 * centred on (200, 100).
 */
const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([7, 8, 9]).buffer })
const F = (id: string, left: number, top: number, width = 400, height = 300): FrameRecord => ({ id, name: `Frame ${id}`, left, top, width, height })
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
const file = (name: string, type = 'image/png') => new File([new Uint8Array([1, 2, 3])], name, { type })
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function board(frames: FrameRecord[], objects: ObjectRecord[], opts: { load?: boolean } = {}) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Replace', frames, objects }
  const store = new SpyStore(frames.length + objects.length > 0 ? { doc, assets: new Map([['a1', asset('a1')]]) } : null)
  const assets = new FakeAssets(new Set(['broken-10x10.png']))
  const editor = new Editor(host, store, assets)
  editors.push(editor)
  const canvas = canvasOf(editor)
  if (opts.load !== false) {
    store.holdLoad = false
    await editor.init()
  }
  return helpers(editor, store, canvas, assets)
}

function helpers(editor: Editor, store: SpyStore, canvas: Canvas, assets: FakeAssets) {
  const obj = (id: string): FakeObject => {
    const found = canvas.objects.find((o) => idOf(o as never) === id)
    if (!found) throw new Error(`no object ${id} on the canvas`)
    return found
  }
  const doc = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc()
  const rec = (id: string) => {
    const found = doc().objects.find((o) => o.id === id)
    if (!found) throw new Error(`no record ${id}`)
    return found as ImageRecord
  }
  const ids = () => doc().objects.map((o) => o.id)
  const activeIds = () => canvas.getActiveObjects().map((o) => idOf(o as never))
  const canUndo = () => editor.getState().canUndo
  const notice = () => editor.getState().notice
  /** How many undo steps there are (undoes them all, then redoes them all, which marks the board dirty). */
  const undoDepth = () => {
    let n = 0
    while (editor.getState().canUndo) {
      editor.undo()
      n++
    }
    for (let i = 0; i < n; i++) editor.redo()
    return n
  }
  const referenced = () => new Set(store.saves.flatMap((s) => s.doc.objects.flatMap((o) => (o.type === 'image' ? [o.assetId] : []))))
  return { editor, store, canvas, assets, obj, doc, rec, ids, activeIds, canUndo, notice, undoDepth, referenced }
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

describe('the target (P1, P2)', () => {
  it('is the one selected unlocked image; null for anything else, before loading, on a read-only board and mid-gesture', async () => {
    const early = await board([], [img('P', 100, 50)], { load: false })
    expect(early.editor.replaceTarget()).toBeNull()

    const b = await board([F('A', 0, 400)], [img('P', 100, 50), img('Q', 400, 50), img('L', 700, 50, { locked: true }), txt('t', 0, 300)])
    expect(b.editor.replaceTarget()).toBeNull() // nothing selected
    b.editor.selectLayer('P')
    expect(b.editor.replaceTarget()).toBe('P')
    b.editor.selectLayer('Q', { toggle: true })
    expect(b.editor.replaceTarget()).toBeNull()
    b.editor.selectLayer('t')
    expect(b.editor.replaceTarget()).toBeNull()
    b.editor.selectLayer('A')
    expect(b.editor.replaceTarget()).toBeNull()
    b.editor.selectLayer('L')
    expect(b.editor.replaceTarget()).toBeNull()

    b.editor.selectLayer('P')
    const t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 5, 0)
    expect(b.editor.replaceTarget()).toBeNull()
    release(b.canvas, t)
    await tick()

    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    b.canvas.setActiveObject(b.obj('P'))
    expect(b.editor.replaceTarget()).toBeNull()
  })

  it('pressing the button in crop mode applies the crop first, as its own step', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.editor.startCrop()
    ;(b.editor as unknown as { crop: { rect: object } }).crop.rect = { x: 0, y: 0, width: 100, height: 100 }
    expect(b.editor.replaceTarget()).toBe('P')
    expect(b.editor.getState().cropping).toBe(false)
    expect(b.rec('P').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(b.undoDepth()).toBe(1)
  })
})

describe('the result (P4, P5)', () => {
  it('a wider picture: same id, box, z-order and angle; centred crop with the box aspect; one undo step; redo; the label follows', async () => {
    const b = await board([], [img('Q', 400, 50), img('P', 100, 50), img('R', 700, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    await b.editor.replaceImageFile(target, file('wide-400x100.png'))
    const after = b.rec('P')
    expect(after.assetId).not.toBe('a1')
    expect(after).toEqual(img('P', 100, 50, { assetId: after.assetId, crop: { x: 100, y: 0, width: 200, height: 100 } }))
    expect(b.ids()).toEqual(['Q', 'P', 'R'])
    expect(b.activeIds()).toEqual(['P'])
    expect(b.editor.getState().layers.find((l) => l.id === 'P')?.label).toBe('wide-400x100.png')
    expect(b.undoDepth()).toBe(1)

    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
    expect(b.editor.getState().layers.find((l) => l.id === 'P')?.label).toBe('a1.png')
    b.editor.redo()
    expect(b.rec('P')).toEqual(after)
  })

  it('same aspect, different resolution: no crop key, only the scale changes', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    await b.editor.replaceImageFile(b.editor.replaceTarget()!, file('big-400x200.png'))
    const after = b.rec('P')
    expect(after).toEqual(img('P', 100, 50, { assetId: after.assetId, scaleX: 0.5, scaleY: 0.5 }))
    expect(after).not.toHaveProperty('crop')
  })

  it('a cropped target loses its old crop; a taller picture is cropped top and bottom', async () => {
    const b = await board([], [img('P', 100, 50, { crop: { x: 20, y: 10, width: 100, height: 50 } })]) // a 100 x 50 box
    b.editor.selectLayer('P')
    await b.editor.replaceImageFile(b.editor.replaceTarget()!, file('tall-100x400.png'))
    const after = b.rec('P')
    expect(after).toEqual(img('P', 100, 50, { assetId: after.assetId, crop: { x: 0, y: 175, width: 100, height: 50 } }))
  })

  it('an owner that does not contain its centre is kept (the box does not move); moving the frame carries it once', async () => {
    const b = await board([F('A', 0, 0, 150, 300)], [img('P', 100, 50, { frameId: 'A' })]) // centre (200, 100) is outside A
    b.editor.selectLayer('P')
    await b.editor.replaceImageFile(b.editor.replaceTarget()!, file('wide-400x100.png'))
    expect(b.rec('P')).toMatchObject({ frameId: 'A', left: 100, top: 50 })
    b.canvas.setActiveObject(b.obj('A'))
    const t = press(b.canvas, b.obj('A'))
    dragBy(b.canvas, t, 30, 20)
    release(b.canvas, t)
    await tick()
    expect(b.rec('P')).toMatchObject({ frameId: 'A', left: 130, top: 70, crop: { x: 100, y: 0, width: 200, height: 100 } })
  })

  it('replace, then Fit: the whole new picture inside the box, centred, no crop', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    await b.editor.replaceImageFile(b.editor.replaceTarget()!, file('wide-400x100.png'))
    b.editor.fitImage()
    const after = b.rec('P')
    expect(after).toEqual(img('P', 100, 75, { assetId: after.assetId, scaleX: 0.5, scaleY: 0.5 })) // 200 x 50, centred on (200, 100)
    expect(b.undoDepth()).toBe(2)
  })

  it('a replaced image in a later multi-selection scale: crop unchanged, one factor', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    b.editor.selectLayer('P')
    await b.editor.replaceImageFile(b.editor.replaceTarget()!, file('wide-400x100.png'))
    const crop = b.rec('P').crop
    b.editor.selectLayer('Q', { toggle: true })
    const t = press(b.canvas, b.canvas.getActiveObject()!, { action: 'scale', corner: 'br' })
    scaleBy(b.canvas, t, 2)
    release(b.canvas, t)
    await tick()
    expect(b.rec('P')).toMatchObject({ crop, scaleX: 2, scaleY: 2 })
    expect(b.rec('Q')).toMatchObject({ scaleX: 2, scaleY: 2 })
  })
})

describe('when the decode finishes (P3)', () => {
  it('a file that is not an image, or cannot be decoded: a notice naming it; nothing changes', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    await b.editor.replaceImageFile(target, file('notes.txt', 'text/plain'))
    expect(b.notice()?.message).toContain('notes.txt')
    await b.editor.replaceImageFile(target, file('broken-10x10.png'))
    expect(b.notice()?.message).toContain('broken-10x10.png')
    expect(b.rec('P')).toEqual(img('P', 100, 50))
    await flush()
    expect(b.canUndo()).toBe(false)
    expect(b.store.attempts).toHaveLength(0)
  })

  it('during a drag: waits, then is applied as its own step after the drag settles; also after an Esc-cancelled drag', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    let t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 40, 0)
    await b.editor.replaceImageFile(target, file('wide-400x100.png'))
    expect(b.obj('P')).toMatchObject({ cropX: 0, width: 200 }) // untouched mid-gesture
    release(b.canvas, t)
    await tick()
    expect(b.rec('P')).toMatchObject({ left: 140, crop: { x: 100, y: 0, width: 200, height: 100 } })
    expect(b.undoDepth()).toBe(2) // the move, then the replacement
    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 140, 50))

    t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 40, 0)
    await b.editor.replaceImageFile(target, file('tall-100x400.png'))
    window.dispatchEvent(key('Escape'))
    await tick()
    expect(b.rec('P')).toMatchObject({ left: 140, crop: { x: 0, y: 175, width: 100, height: 50 } })
    release(b.canvas, t)
  })

  it('in crop mode on the same image: the crop is applied first (its own step), then the picture fills the box after the crop', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const decode = b.assets.hold('wide-400x100.png')
    const pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.editor.startCrop()
    ;(b.editor as unknown as { crop: { rect: object } }).crop.rect = { x: 0, y: 0, width: 100, height: 100 } // a 100 x 100 box
    decode.resolve()
    await pending
    expect(b.editor.getState().cropping).toBe(false)
    const after = b.rec('P')
    expect(after).toEqual(img('P', 100, 50, { assetId: after.assetId, crop: { x: 150, y: 0, width: 100, height: 100 } }))
    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 100, 50, { crop: { x: 0, y: 0, width: 100, height: 100 } }))
    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
  })

  it('in crop mode on another image: that crop is applied, the target is replaced', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const decode = b.assets.hold('big-400x200.png')
    const pending = b.editor.replaceImageFile(target, file('big-400x200.png'))
    b.editor.selectLayer('Q')
    b.editor.startCrop()
    ;(b.editor as unknown as { crop: { rect: object } }).crop.rect = { x: 0, y: 0, width: 100, height: 100 }
    decode.resolve()
    await pending
    expect(b.rec('Q').crop).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    expect(b.rec('P')).toMatchObject({ scaleX: 0.5 })
    expect(b.activeIds()).toEqual(['Q'])
  })

  it('the target was deleted, undone away, or locked meanwhile: a notice; nothing changes, nothing recorded or saved; the new bytes are never stored', async () => {
    // Deleted.
    let b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    b.editor.selectLayer('P')
    let target = b.editor.replaceTarget()!
    let decode = b.assets.hold('wide-400x100.png')
    let pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.editor.deleteSelection()
    await flush()
    let attempts = b.store.attempts.length
    decode.resolve()
    await pending
    expect(b.notice()?.message).toBe('The image could not be replaced: it is no longer on the board.')
    expect(b.ids()).toEqual(['Q'])
    await flush()
    expect(b.store.attempts).toHaveLength(attempts)
    expect(b.undoDepth()).toBe(1) // the delete only

    // Undone away: a freshly imported image, its import undone.
    b = await board([], [img('Q', 400, 50)])
    await b.editor.addImageFiles([file('fresh.png')])
    target = b.editor.replaceTarget()!
    expect(target).not.toBeNull()
    decode = b.assets.hold('wide-400x100.png')
    pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.editor.undo()
    decode.resolve()
    await pending
    expect(b.notice()?.message).toBe('The image could not be replaced: it is no longer on the board.')
    expect(b.ids()).toEqual(['Q'])
    expect(b.editor.getState().canRedo).toBe(true) // the redo of the import is still there

    // Locked.
    b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    target = b.editor.replaceTarget()!
    decode = b.assets.hold('wide-400x100.png')
    pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.editor.toggleLayerLock('P')
    await flush()
    attempts = b.store.attempts.length
    decode.resolve()
    await pending
    expect(b.notice()?.message).toBe('The image could not be replaced: it is locked. Unlock it and try again.')
    expect(b.rec('P')).toEqual(img('P', 100, 50, { locked: true }))
    await flush()
    expect(b.store.attempts).toHaveLength(attempts)
    expect([...b.referenced()]).toEqual(['a1'])
  })

  it('the board went read-only meanwhile: a notice; nothing changes and nothing is written', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const decode = b.assets.hold('wide-400x100.png')
    const pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.editor.getState().readOnly).toBe(CONFLICT_MESSAGE)
    decode.resolve()
    await pending
    expect(b.notice()?.message).toMatch(/not replaced because the board became read-only/)
    expect(b.rec('P')).toEqual(img('P', 100, 50))
    expect(b.store.saves).toHaveLength(0)
  })

  it('a replacement staged behind a gesture when the board goes read-only is dropped with a notice', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 40, 0)
    await b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.notice()?.message).toMatch(/not replaced because the board became read-only/)
    release(b.canvas, t)
    await tick()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
  })

  it('the editor was disposed meanwhile: nothing, and no error', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const decode = b.assets.hold('wide-400x100.png')
    const pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.editor.dispose()
    decode.resolve()
    await expect(pending).resolves.toBeUndefined()
  })

  it('a different selection, or none: the target is still replaced, the selection is left as it is', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50), img('R', 700, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    let decode = b.assets.hold('wide-400x100.png')
    let pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.editor.selectLayer('Q')
    decode.resolve()
    await pending
    expect(b.rec('P').crop).toEqual({ x: 100, y: 0, width: 200, height: 100 })
    expect(b.activeIds()).toEqual(['Q'])

    // In a multi-selection when it lands: replaced, and the multi-selection stays.
    decode = b.assets.hold('big-400x200.png')
    pending = b.editor.replaceImageFile(target, file('big-400x200.png'))
    b.canvas.setActiveObject(new ActiveSelection([b.obj('P'), b.obj('R')]))
    decode.resolve()
    await pending
    expect(b.rec('P')).toMatchObject({ scaleX: 0.5, left: 100, top: 50 })
    expect(b.rec('P')).not.toHaveProperty('crop')
    expect(b.activeIds()).toEqual(['P', 'R'])

    b.canvas.discardActiveObject()
    await b.editor.replaceImageFile(target, file('tall-100x400.png'))
    expect(b.rec('P').crop).toEqual({ x: 0, y: 175, width: 100, height: 50 })
    expect(b.activeIds()).toEqual([])
  })

  it('the last pick wins: a slow first pick that finishes after a faster second one is dropped silently', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const first = b.assets.hold('wide-400x100.png')
    const second = b.assets.hold('big-400x200.png')
    const p1 = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    const p2 = b.editor.replaceImageFile(target, file('big-400x200.png'))
    second.resolve()
    await p2
    await flush()
    const attempts = b.store.attempts.length
    expect(b.rec('P')).toMatchObject({ scaleX: 0.5 })
    first.resolve()
    await p1
    await flush()
    expect(b.rec('P')).toMatchObject({ scaleX: 0.5 }) // still the second pick
    expect(b.rec('P')).not.toHaveProperty('crop')
    expect(b.editor.getState().layers[0]?.label).toBe('big-400x200.png')
    expect(b.notice()).toBeNull() // silently
    expect(b.store.attempts).toHaveLength(attempts) // nothing saved
    expect(b.undoDepth()).toBe(1)
    // Undo does not reset this: the dropped pick stays dropped.
    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
  })

  it('a newer pick that is refused (the image was locked meanwhile) supersedes nothing: the older one still lands once it is unlocked', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const first = b.assets.hold('wide-400x100.png')
    const second = b.assets.hold('big-400x200.png')
    const p1 = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    const p2 = b.editor.replaceImageFile(target, file('big-400x200.png'))
    b.editor.toggleLayerLock('P')
    second.resolve()
    await p2
    expect(b.notice()?.message).toBe('The image could not be replaced: it is locked. Unlock it and try again.')
    await flush()
    expect(b.rec('P')).toMatchObject({ assetId: 'a1', locked: true }) // refused: only an applied request supersedes older ones
    b.editor.toggleLayerLock('P')
    first.resolve()
    await p1
    await flush()
    expect(b.rec('P')).toMatchObject({ scaleX: 1, crop: { x: 100, y: 0, width: 200, height: 100 } }) // the older pick, applied
    expect(b.rec('P').assetId).not.toBe('a1')
    expect(b.editor.getState().layers[0]?.label).toBe('wide-400x100.png')
  })

  it('a superseded pick that arrives during crop mode is dropped before anything else: the crop stays open, no step, no notice', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const first = b.assets.hold('wide-400x100.png')
    const second = b.assets.hold('big-400x200.png')
    const p1 = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    const p2 = b.editor.replaceImageFile(target, file('big-400x200.png'))
    second.resolve()
    await p2
    await flush()
    b.editor.startCrop()
    expect(b.editor.getState().cropping).toBe(true)
    first.resolve()
    await p1
    await flush()
    expect(b.editor.getState().cropping).toBe(true) // it did not leave the edit
    expect(b.notice()).toBeNull()
    b.editor.cancelCrop()
    expect(b.rec('P')).toMatchObject({ scaleX: 0.5 }) // still the second pick
    expect(b.undoDepth()).toBe(1)
  })

  it('a fast first pick and a slow second one: both applied in order, each its own step, the second showing', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const first = b.assets.hold('wide-400x100.png')
    const second = b.assets.hold('big-400x200.png')
    const p1 = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    const p2 = b.editor.replaceImageFile(target, file('big-400x200.png'))
    first.resolve()
    await p1
    expect(b.rec('P').crop).toEqual({ x: 100, y: 0, width: 200, height: 100 })
    second.resolve()
    await p2
    expect(b.rec('P')).toMatchObject({ scaleX: 0.5 })
    expect(b.undoDepth()).toBe(2)
    b.editor.undo()
    expect(b.rec('P').crop).toEqual({ x: 100, y: 0, width: 200, height: 100 })
    b.editor.undo()
    expect(b.rec('P')).toEqual(img('P', 100, 50))
  })

  it('both waiting behind a drag, finished in reverse order: the latest request ends up showing, never followed by the older one', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const first = b.assets.hold('wide-400x100.png')
    const second = b.assets.hold('big-400x200.png')
    const p1 = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    const p2 = b.editor.replaceImageFile(target, file('big-400x200.png'))
    const t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 40, 0)
    second.resolve()
    await p2
    first.resolve()
    await p1
    release(b.canvas, t)
    await tick()
    expect(b.rec('P')).toMatchObject({ left: 140, scaleX: 0.5 }) // the second (latest) pick
    expect(b.rec('P')).not.toHaveProperty('crop')
    // History, newest first: second pick, then (applied before it) the first pick, then the move.
    const steps: Array<ImageRecord['crop'] | 'none'> = []
    while (b.canUndo()) {
      b.editor.undo()
      steps.push(b.rec('P').crop ?? 'none')
    }
    expect(steps).toEqual([{ x: 100, y: 0, width: 200, height: 100 }, 'none', 'none'])
  })

  it('replacements of two different images are independent', async () => {
    const b = await board([], [img('P', 100, 50), img('Q', 400, 50)])
    b.editor.selectLayer('P')
    const p = b.editor.replaceTarget()!
    b.editor.selectLayer('Q')
    const q = b.editor.replaceTarget()!
    const slowP = b.assets.hold('wide-400x100.png')
    const pp = b.editor.replaceImageFile(p, file('wide-400x100.png'))
    await b.editor.replaceImageFile(q, file('big-400x200.png')) // requested later, for another image
    slowP.resolve()
    await pp
    expect(b.rec('P').crop).toEqual({ x: 100, y: 0, width: 200, height: 100 })
    expect(b.rec('Q')).toMatchObject({ scaleX: 0.5 })
    expect(b.undoDepth()).toBe(2)
  })

  it('an import and a replacement both waiting when the board goes read-only: one notice states both', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const t = press(b.canvas, b.obj('P'))
    dragBy(b.canvas, t, 40, 0)
    await b.editor.addImageFiles([file('a.png'), file('b.png')])
    await b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.store.saveError = new BoardConflictError()
    b.editor.setTitle('conflict')
    await flush()
    expect(b.notice()?.message).toBe('2 images were not added and 1 image was not replaced because the board became read-only.')
    release(b.canvas, t)
    await tick()
  })
})

describe('what is saved (P6)', () => {
  it('the debounce firing between press and decode stores the old record; the replacement then stores the new asset with its bytes', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    const decode = b.assets.hold('wide-400x100.png')
    const pending = b.editor.replaceImageFile(target, file('wide-400x100.png'))
    b.editor.setTitle('waiting')
    await flush()
    expect(b.store.saves.at(-1)!.doc.objects).toEqual([img('P', 100, 50)])
    decode.resolve()
    await pending
    await flush()
    const saved = b.store.saves.at(-1)!
    const newId = (saved.doc.objects[0] as ImageRecord).assetId
    expect(newId).not.toBe('a1')
    expect(saved.assets).toEqual([newId]) // the bytes were there to be written with the document
  })

  it('a save in flight when the replacement lands: the replacement is saved after it', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    b.store.saveGate = deferred<void>()
    b.editor.setTitle('slow')
    await flush()
    expect(b.store.attempts).toHaveLength(1)
    await b.editor.replaceImageFile(b.editor.replaceTarget()!, file('wide-400x100.png'))
    const gate = b.store.saveGate
    b.store.saveGate = null
    gate.resolve()
    await flush()
    expect(b.store.saves[0]!.doc.objects).toEqual([img('P', 100, 50)])
    expect((b.store.saves.at(-1)!.doc.objects[0] as ImageRecord).crop).toEqual({ x: 100, y: 0, width: 200, height: 100 })
  })

  it('replace twice, undo both, save: only the original asset is referenced, with its bytes; reloading prunes the rest', async () => {
    const b = await board([], [img('P', 100, 50)])
    b.editor.selectLayer('P')
    const target = b.editor.replaceTarget()!
    await b.editor.replaceImageFile(target, file('wide-400x100.png'))
    await flush()
    await b.editor.replaceImageFile(target, file('big-400x200.png'))
    await flush()
    b.editor.undo()
    b.editor.undo()
    await flush()
    const saved = b.store.saves.at(-1)!
    expect(saved.doc.objects).toEqual([img('P', 100, 50)])
    expect(saved.assets).toEqual(['a1']) // the old picture's bytes are still in the session, so they can be stored again
    expect(b.store.saves.length).toBeGreaterThanOrEqual(3)

    const again = await board(saved.doc.frames, saved.doc.objects)
    expect(again.rec('P')).toEqual(img('P', 100, 50))
    expect(again.store.prunes.at(-1)?.keep).toEqual(['a1'])
  })
})
