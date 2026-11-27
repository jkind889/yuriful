import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, StoredAsset } from '../model/types.ts'
import { CONFLICT_MESSAGE } from '../persistence/autosave.ts'
import { ABSENT, BoardConflictError, IndexedDbBoardStore } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { canvasOf } from './testing/drive.ts'
import type { Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

const bytes = (...n: number[]) => new Uint8Array(n).buffer
const asset = (id: string, ...b: number[]): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: bytes(...b) })

const storedDoc = (): BoardDoc => ({
  ...createEmptyDoc(),
  title: 'My stored board',
  objects: [
    { type: 'image', id: 'img-1', left: 10, top: 20, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 },
    { type: 'text', id: 'txt-1', left: 300, top: 40, angle: 0, text: 'keep me', fontSize: 24, width: 240 },
    { type: 'image', id: 'img-2', left: 50, top: 200, angle: 0, assetId: 'a2', scaleX: 1, scaleY: 1 },
  ],
  viewport: { zoom: 1.5, panX: 12, panY: 34 },
})
const storedAssets = () => new Map([asset('a1', 1, 2, 3), asset('a2', 4, 5, 6)].map((a) => [a.id, a] as const))

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })

let host: HTMLDivElement
const editors: Editor[] = []
const make = (store: ConstructorParameters<typeof Editor>[1], assets: ConstructorParameters<typeof Editor>[2]) => {
  const e = new Editor(host, store, assets)
  editors.push(e)
  return e
}
/** Canvas objects as the editor sees them (the fake canvas exposes them via the host's editor). */
const flush = () => vi.advanceTimersByTimeAsync(10_000)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // autosave's debounce; leave setImmediate to fake-indexeddb
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

describe('Editor: nothing is editable or saved before hydration finishes', () => {
  it('ignores every edit path while the stored board is still loading, and never saves', async () => {
    const store = new SpyStore({ doc: storedDoc(), assets: storedAssets() })
    const assets = new FakeAssets()
    const editor = make(store, assets)
    const init = editor.init() // load() is held open: hydration is in flight

    // Everything a user (or a stray event) could do early.
    editor.addText()
    await editor.addImageFiles([new File([new Uint8Array([1, 2, 3])], 'early.png', { type: 'image/png' })])
    editor.handleKeyDown(key('Delete'))
    editor.handleKeyDown(key('t'))
    editor.handleKeyDown(key('z', { ctrlKey: true }))
    editor.handleKeyDown(key('a', { ctrlKey: true }))
    editor.handleKeyDown(key(' ', { code: 'Space' }))
    editor.setTool('hand')
    editor.setTool('frame')
    editor.handleKeyDown(key('f'))
    editor.addFrame()
    editor.renameFrame('Early frame')
    editor.selectFrameContents()
    editor.setTitle('Hijacked title')
    editor.setFontSize(60)
    editor.arrange('front')
    editor.deleteSelection()
    editor.selectAll()
    editor.undo()
    editor.redo()
    editor.zoomBy(2)
    editor.resetZoom()
    editor.fit()
    await flush() // far past any autosave debounce

    const early = editor.getState()
    expect(early.ready).toBe(false)
    expect(early.save).toEqual({ kind: 'loading' })
    expect(early.title).toBe('Untitled board')
    expect(early.tool).toBe('select')
    expect(early.objectCount).toBe(0)
    expect(early.viewport).toEqual({ zoom: 1, panX: 0, panY: 0 })
    expect(store.saves).toHaveLength(0)
    expect(assets.loaded).toEqual([]) // the early image was not even decoded

    // Hydration completes: the stored board appears intact, nothing early leaked in.
    store.releaseLoad()
    await init
    const state = editor.getState()
    expect(state.ready).toBe(true)
    expect(state.title).toBe('My stored board')
    expect(state.objectCount).toBe(3)
    expect(state.viewport).toEqual({ zoom: 1.5, panX: 12, panY: 34 })
    expect(state.save.kind).toBe('saved')
    expect(store.saves).toHaveLength(0) // restoring is not an edit

    // Edits work now, and the first save carries the restored board, not an empty one.
    editor.setTitle('Renamed after load')
    await flush()
    expect(store.saves).toHaveLength(1)
    const saved = store.saves[0]!.doc
    expect(saved.title).toBe('Renamed after load')
    expect(saved.objects.map((o) => o.id)).toEqual(['img-1', 'txt-1', 'img-2'])
    expect(saved.viewport).toEqual({ zoom: 1.5, panX: 12, panY: 34 })
  })

  it('does not let an early edit overwrite the stored board when hydration is slow and then fails', async () => {
    const store = new SpyStore(null)
    const editor = make(store, new FakeAssets())
    const init = editor.init()
    editor.addText()
    editor.setTitle('early')
    await flush()
    store.failLoad(new Error('database locked'))
    await init
    const state = editor.getState()
    expect(state.save).toMatchObject({ kind: 'unavailable' })
    expect(state.readOnly).toMatch(/Local storage is unavailable \(database locked\).*read-only/)
    editor.setTitle('after failure')
    editor.addText()
    await flush()
    expect(editor.getState().title).toBe('Untitled board')
    expect(editor.getState().objectCount).toBe(0) // not even a volatile edit
    expect(store.saves).toHaveLength(0)
    expect(store.prunes).toHaveLength(0)
  })

  it('a brand-new board becomes editable and saves only after init completes', async () => {
    const store = new SpyStore(null)
    const editor = make(store, new FakeAssets())
    const init = editor.init()
    editor.setTitle('too early')
    await flush()
    expect(store.saves).toHaveLength(0)
    store.releaseLoad()
    await init
    expect(editor.getState().save).toEqual({ kind: 'new' })
    editor.setTitle('on time')
    await flush()
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0]!.doc.title).toBe('on time')
  })
})

describe('Editor: a stored image that fails to decode fails closed', () => {
  it('never saves or prunes, and shows only what loaded', async () => {
    const store = new SpyStore({ doc: storedDoc(), assets: storedAssets() })
    store.holdLoad = false
    const editor = make(store, new FakeAssets(new Set(['a2']))) // a2's bytes will not decode
    await editor.init()

    const state = editor.getState()
    expect(state.ready).toBe(true)
    expect(state.save.kind).toBe('unavailable')
    expect(state.save).toMatchObject({ message: expect.stringContaining('1 saved image could not be loaded') })
    expect(state.readOnly).toContain('1 saved image could not be loaded') // explicit, persistent reason
    expect(state.tool).toBe('hand')
    expect(state.objectCount).toBe(2) // img-1 + text; img-2 is not shown, but not forgotten either
    expect(state.title).toBe('My stored board')

    // Read-only: no edit path changes anything, and none can reach storage.
    const picker = vi.fn()
    editor.setImagePicker(picker)
    editor.setTitle('edited')
    editor.addText()
    editor.setFontSize(80)
    editor.arrange('front')
    editor.undo()
    editor.redo()
    editor.setTool('text')
    editor.setTool('select')
    editor.setTool('frame')
    editor.handleKeyDown(key('f'))
    editor.addFrame()
    editor.renameFrame('Read-only frame')
    editor.selectFrameContents()
    editor.handleKeyDown(key('a', { ctrlKey: true }))
    editor.handleKeyDown(key('Delete'))
    editor.handleKeyDown(key('i')) // add-image shortcut must not open the picker
    editor.handleKeyDown(key('t'))
    await editor.addImageFiles([new File([new Uint8Array([1])], 'x.png', { type: 'image/png' })])
    const notice = editor.getState().notice // read before the (fake) clock auto-dismisses it
    await flush()
    const after = editor.getState()
    expect(after.title).toBe('My stored board')
    expect(after.objectCount).toBe(2)
    expect(after.tool).toBe('hand')
    expect(after.selection).toBeNull()
    expect(after.canUndo).toBe(false)
    expect(picker).not.toHaveBeenCalled()
    expect(notice).toMatchObject({ kind: 'error', message: expect.stringContaining('read-only') })
    expect(store.saves).toHaveLength(0)
    expect(store.prunes).toHaveLength(0) // original asset bytes are never pruned
  })

  it('stays navigable while read-only: zoom, fit and pan still work', async () => {
    const store = new SpyStore({ doc: storedDoc(), assets: storedAssets() })
    store.holdLoad = false
    const editor = make(store, new FakeAssets(new Set(['a2'])))
    await editor.init()
    const z0 = editor.getState().viewport.zoom
    editor.zoomBy(2)
    expect(editor.getState().viewport.zoom).toBeCloseTo(z0 * 2)
    editor.resetZoom()
    expect(editor.getState().viewport.zoom).toBe(1)
    editor.handleKeyDown(key('=')) // keyboard zoom
    expect(editor.getState().viewport.zoom).toBeGreaterThan(1)
    editor.fit()
    await flush()
    expect(store.saves).toHaveLength(0) // navigating a read-only board never writes
  })

  it('a missing asset record is treated the same as a decode failure', async () => {
    const assets = storedAssets()
    assets.delete('a1')
    const store = new SpyStore({ doc: storedDoc(), assets })
    store.holdLoad = false
    const editor = make(store, new FakeAssets())
    await editor.init()
    expect(editor.getState().save.kind).toBe('unavailable')
    expect(editor.getState().readOnly).not.toBeNull()
    editor.setTitle('x')
    await flush()
    expect(editor.getState().title).toBe('My stored board')
    expect(store.saves).toHaveLength(0)
    expect(store.prunes).toHaveLength(0)
  })

  it('leaves the original document and image bytes intact in IndexedDB', async () => {
    const factory = new IDBFactory()
    const seed = new IndexedDbBoardStore(factory)
    const original = storedDoc()
    const seedAssets = [asset('a1', 1, 2, 3), asset('a2', 4, 5, 6)]
    await seed.save(original, ABSENT, (id) => seedAssets.find((a) => a.id === id))

    const store = new IndexedDbBoardStore(factory)
    const editor = make(store, new FakeAssets(new Set(['a2'])))
    await editor.init()
    editor.setTitle('attempted overwrite')
    editor.addText()
    editor.handleKeyDown(key('a', { ctrlKey: true }))
    editor.handleKeyDown(key('Delete'))
    await flush()
    expect(editor.getState().save.kind).toBe('unavailable')
    expect(editor.getState().readOnly).not.toBeNull()
    editor.dispose() // also exercises the page-hide style flush path

    const after = await new IndexedDbBoardStore(factory).load()
    expect(after?.doc).toEqual(original) // document unchanged, both image records still present
    expect([...(after?.assets.keys() ?? [])].sort()).toEqual(['a1', 'a2'])
    expect([...new Uint8Array(after!.assets.get('a2')!.bytes)]).toEqual([4, 5, 6]) // failed asset's bytes preserved
    expect([...new Uint8Array(after!.assets.get('a1')!.bytes)]).toEqual([1, 2, 3])
  })

  it('a fully successful restore still prunes, using the original document references', async () => {
    const store = new SpyStore({ doc: storedDoc(), assets: storedAssets() })
    store.holdLoad = false
    const editor = make(store, new FakeAssets())
    await editor.init()
    expect(editor.getState().save.kind).toBe('saved')
    expect(editor.getState().readOnly).toBeNull() // a healthy board stays editable
    expect(store.prunes).toEqual([{ keep: ['a1', 'a2'], expected: { kind: 'rev', rev: 'stored' } }]) // guarded by the loaded token
  })

  it('restoring is not an edit: the first save expects exactly the token that was loaded', async () => {
    const token = { kind: 'legacy', updatedAt: 7, docJson: '{}' } as const
    const store = new SpyStore({ doc: storedDoc(), assets: storedAssets(), token })
    store.holdLoad = false
    const editor = make(store, new FakeAssets())
    await editor.init()
    await flush()
    expect(store.attempts).toHaveLength(0)
    expect(store.prunes[0]?.expected).toEqual(token)
    editor.setTitle('First edit')
    await flush()
    editor.setTitle('Second edit')
    await flush()
    expect(store.saves.map((s) => s.expected)).toEqual([token, { kind: 'rev', rev: 'spy-1' }])
    expect(store.saves[0]!.assets).toEqual(['a1', 'a2']) // bytes of every restored image stay available to saves
  })

  it('a brand-new board saves against "nothing stored"', async () => {
    const store = new SpyStore(null)
    store.holdLoad = false
    const editor = make(store, new FakeAssets())
    await editor.init()
    editor.setTitle('New')
    await flush()
    expect(store.saves[0]?.expected).toEqual(ABSENT)
    expect(store.prunes).toHaveLength(0)
  })
})

describe('Editor: a save conflict makes the tab read-only', () => {
  it('never overwrites: the board becomes read-only with the conflict reason and stops saving', async () => {
    const store = new SpyStore({ doc: storedDoc(), assets: storedAssets() })
    store.holdLoad = false
    const editor = make(store, new FakeAssets())
    await editor.init()
    editor.handleKeyDown(key('a', { ctrlKey: true }))

    store.saveError = new BoardConflictError()
    editor.setTitle('Edited in a stale tab')
    await flush()
    const state = editor.getState()
    expect(state.readOnly).toBe(CONFLICT_MESSAGE)
    expect(state.save).toEqual({ kind: 'unavailable', message: CONFLICT_MESSAGE })
    expect(state.tool).toBe('hand')
    expect(state.selection).toBeNull()
    expect(store.attempts).toHaveLength(1)

    // Nothing can be edited or saved afterwards, even once the store would accept a write.
    store.saveError = null
    editor.setTitle('again')
    editor.addText()
    editor.setTool('select')
    editor.handleKeyDown(key('a', { ctrlKey: true }))
    editor.handleKeyDown(key('Delete'))
    editor.retrySave()
    await flush()
    expect(editor.getState().title).toBe('Edited in a stale tab')
    expect(editor.getState().objectCount).toBe(3)
    expect(editor.getState().tool).toBe('hand')
    expect(store.attempts).toHaveLength(1)
    expect(store.saves).toHaveLength(0)
  })

  it('leaves a text edit without committing it', async () => {
    const store = new SpyStore(null)
    store.holdLoad = false
    const editor = make(store, new FakeAssets())
    await editor.init()
    editor.setTitle('Saved once')
    await flush()
    store.saveError = new BoardConflictError()
    editor.addText() // enters editing on a new textbox
    expect(editor.getState().editingText).toBe(true)
    const typing = canvasOf(editor).objects[0] as Textbox
    typing.type('half a thought') // typed text, so leaving the edit WOULD commit if the board were still editable
    await flush() // the save triggered by typing conflicts
    const state = editor.getState()
    expect(state.readOnly).toBe(CONFLICT_MESSAGE)
    expect(typing.isEditing).toBe(false)
    expect(state.editingText).toBe(false)
    expect(state.canUndo).toBe(false) // the half-typed text was not committed to history
    expect(canvasOf(editor).objects).toHaveLength(1) // it stays visible
    expect(store.saves).toHaveLength(1) // only the save from before the conflict
  })
})

describe('Editor: a stored board with frames', () => {
  const framedDoc = (): BoardDoc => ({
    ...storedDoc(),
    frames: [{ id: 'f1', name: 'Cover', left: 0, top: 0, width: 400, height: 300 }],
    objects: storedDoc().objects.map((o) => ({ ...o, frameId: 'f1' })),
  })

  it('restores editable; restoring is not an edit, and the first save keeps frames and owners', async () => {
    const store = new SpyStore({ doc: framedDoc(), assets: storedAssets() })
    store.holdLoad = false
    const editor = make(store, new FakeAssets())
    await editor.init()
    expect(editor.getState().readOnly).toBeNull()
    expect(editor.getState().save.kind).toBe('saved')
    expect(editor.getState().objectCount).toBe(4) // the frame and its three objects
    expect(editor.getState().canUndo).toBe(false)
    await flush()
    expect(store.attempts).toHaveLength(0)
    expect(store.prunes).toEqual([{ keep: ['a1', 'a2'], expected: { kind: 'rev', rev: 'stored' } }])

    editor.setTitle('Edited')
    await flush()
    expect(store.saves[0]!.doc.frames).toEqual(framedDoc().frames)
    expect(store.saves[0]!.doc.objects.map((o) => o.frameId)).toEqual(['f1', 'f1', 'f1'])
  })

  it('that cannot be fully restored is read-only: frames are shown but nothing can be selected, moved or written', async () => {
    const store = new SpyStore({ doc: framedDoc(), assets: storedAssets() })
    store.holdLoad = false
    const editor = make(store, new FakeAssets(new Set(['a2'])))
    await editor.init()
    expect(editor.getState().readOnly).toContain('1 saved image could not be loaded')
    expect(editor.getState().objectCount).toBe(3) // the frame, one image and the text
    const canvas = canvasOf(editor)
    expect(canvas).toMatchObject({ skipTargetFind: true, selection: false })
    editor.setTool('frame')
    editor.addFrame()
    editor.selectFrameContents()
    editor.renameFrame('Nope')
    editor.handleKeyDown(key('a', { ctrlKey: true }))
    editor.handleKeyDown(key('Delete'))
    await flush()
    expect(editor.getState()).toMatchObject({ tool: 'hand', selection: null, objectCount: 3 })
    expect(store.attempts).toHaveLength(0)
    expect(store.prunes).toHaveLength(0)
  })
})
