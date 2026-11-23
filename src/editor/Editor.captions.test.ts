import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, ImageRecord, ObjectRecord, StoredAsset, TextRecord } from '../model/types.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { captionOf, idOf, setCaption } from './objects.ts'
import { canvasOf, dragBy, press, release, tick } from './testing/drive.ts'
import { FakeAssets, SpyStore, deferred } from './testing/fakes.ts'
import { ActiveSelection, Textbox } from './testing/fakeFabric.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

const image: ImageRecord = { type: 'image', id: 'image', left: 20, top: 30, angle: 0, scaleX: 1, scaleY: 1, assetId: 'a1', frameId: 'sleeve' }
const caption: TextRecord = { type: 'text', id: 'caption', left: 20, top: 140, angle: 0, width: 200, minHeight: 0, fontSize: 24, text: 'Cover', captionOf: image.id, frameId: 'sleeve' }
const text: TextRecord = { ...caption, id: 'text', left: 400, top: 30, text: 'Note', captionOf: undefined, frameId: undefined }
const asset: StoredAsset = { id: 'a1', name: 'Cover.png', type: 'image/png', bytes: new Uint8Array([1]).buffer }
const makeKey = (key: string, patch: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...patch })
const durable = () => vi.advanceTimersByTimeAsync(1000)
const editors: Editor[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
})
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.dispose())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function board(objects: ObjectRecord[] = [image, caption, text], holdLoad = false) {
  // The caption centre is below the sleeve; ownership belongs to the image.
  const frame = { id: 'sleeve', name: 'Sleeve', left: 0, top: 10, width: 300, height: 125 }
  const doc = { ...createEmptyDoc(), frames: [frame], objects }
  const store = new SpyStore({ doc, assets: new Map([[asset.id, asset]]) })
  store.holdLoad = holdLoad
  const host = document.createElement('div')
  document.body.append(host)
  const assets = new FakeAssets()
  const editor = new Editor(host, store, assets)
  editors.push(editor)
  const pending = editor.init()
  if (!holdLoad) await pending
  const canvas = canvasOf(editor)
  const find = (id: string) => canvas.getObjects().find((o) => idOf(o as never) === id)!
  const scene = () => (editor as unknown as { getDoc(): BoardDoc }).getDoc().objects
  const select = (...ids: string[]) => {
    canvas.discardActiveObject()
    const objs = ids.map(find)
    canvas.setActiveObject(objs.length === 1 ? objs[0]! : new ActiveSelection(objs))
  }
  const enter = (patch?: KeyboardEventInit) => {
    const e = makeKey('Enter', patch)
    editor.handleKeyDown(e)
    return e.defaultPrevented
  }
  return { editor, store, assets, canvas, pending, scene, find, select, enter }
}

it('creates immediately above the image, saves typing with the image owner, and reopens at the end', async () => {
  const b = await board([image, text])
  b.select('image')
  expect(b.enter({ repeat: true })).toBe(false)
  expect(b.enter()).toBe(true)
  const editing = b.canvas.getActiveObject() as Textbox
  expect(editing.isEditing).toBe(true)
  expect(b.scene()).toEqual([image, text])
  editing.type('The cover 🎵')
  const made = { ...caption, id: idOf(editing as never), text: 'The cover 🎵' }
  await durable()
  expect(b.store.saves.at(-1)?.doc.objects).toEqual([image, made, text])
  expect(b.editor.getState().canUndo).toBe(false)
  editing.exitEditing()
  expect(b.scene()).toEqual([image, made, text])
  b.editor.undo()
  expect(b.scene()).toEqual([image, text])
  b.editor.redo()
  expect(b.scene()).toEqual([image, made, text])
  b.select('image')
  expect(b.enter()).toBe(true)
  const reopened = b.canvas.getActiveObject() as Textbox
  expect(reopened.selectionStart).toBe(reopened.graphemeSplit(reopened.text).length)
  expect(reopened.selectionEnd).toBe(reopened.selectionStart)
})

it('discards a blank caption, does not claim Enter while editing, and gives crop Enter priority', async () => {
  const b = await board([image, text])
  b.select('image')
  b.editor.startCrop()
  expect(b.enter()).toBe(true)
  expect(b.editor.getState().cropping).toBe(false)
  expect(b.editor.getState().editingText).toBe(false)
  expect(b.enter()).toBe(true)
  expect(b.enter()).toBe(false)
  ;(b.canvas.getActiveObject() as Textbox).exitEditing()
  await tick()
  expect(b.scene()).toEqual([image, text])
  expect(b.canvas.getObjects()).toHaveLength(3) // frame plus the two existing objects
  await durable()
  expect(b.store.attempts).toEqual([])
  expect(b.editor.getState().canUndo).toBe(false)
})

it('leaves a canonical board untouched on an unchanged edit, before and after reload', async () => {
  const first = await board()
  first.select('image')
  expect(first.enter()).toBe(true)
  first.editor.setFontSize(24)
  const move = vi.spyOn(first.find('caption'), 'setXY')
  ;(first.canvas.getActiveObject() as Textbox).exitEditing()
  await durable()
  expect(first.scene()).toEqual([image, caption, text])
  expect(move).not.toHaveBeenCalled()
  expect(first.store.attempts).toHaveLength(0)
  expect(first.editor.getState().canUndo).toBe(false)

  const second = await board(first.scene())
  second.select('image')
  second.enter()
  ;(second.canvas.getActiveObject() as Textbox).exitEditing()
  await durable()
  expect(second.scene()).toEqual([image, caption, text])
  expect(second.store.attempts).toHaveLength(0)
})

it('makes an upright caption with its image owner and detaches it in place, as separate steps', async () => {
  const b = await board([image, text])
  b.select('image', 'text')
  expect(b.editor.getState().selection?.caption.canMake).toBe(true)
  b.editor.makeCaption()
  const attached = { ...caption, id: text.id, text: text.text }
  expect(b.scene()).toEqual([image, attached])
  expect(b.editor.getState().selection?.count).toBe(2)
  b.editor.makeCaption() // already attached
  b.select('image')
  b.editor.detachCaption()
  expect(b.scene()).toEqual([image, { ...attached, captionOf: undefined }])
  b.editor.detachCaption() // no attachment
  b.editor.undo()
  expect(b.scene()).toEqual([image, attached])
  b.editor.undo()
  expect(b.scene()).toEqual([image, text])
  b.editor.redo()
  expect(b.scene()).toEqual([image, attached])
  b.editor.redo()
  expect(b.scene()).toEqual([image, { ...attached, captionOf: undefined }])
})

it('commits the edit before detaching and keeps the attachment through the first undo', async () => {
  const b = await board()
  b.select('image')
  b.enter()
  ;(b.canvas.getActiveObject() as Textbox).type('Edited')
  b.editor.detachCaption()
  expect(b.scene()[1]).toMatchObject({ text: 'Edited' })
  expect(b.scene()[1]).not.toHaveProperty('captionOf')
  b.editor.undo()
  expect(b.scene()[1]).toMatchObject({ text: 'Edited', captionOf: image.id })
  b.editor.undo()
  expect(b.scene()[1]).toEqual(caption)
})

it('deletes an image and caption in one step, or deletes only the caption when selected alone', async () => {
  const b = await board()
  b.select('image')
  b.editor.deleteSelection()
  expect(b.scene()).toEqual([text])
  b.editor.undo()
  expect(b.scene()).toEqual([image, caption, text])
  expect(b.editor.getState().canUndo).toBe(false)
  b.editor.redo()
  expect(b.scene()).toEqual([text])
  b.editor.undo()
  b.select('caption')
  b.editor.deleteSelection()
  expect(b.scene()).toEqual([image, text])
  b.editor.undo()
  expect(b.scene()).toEqual([image, caption, text])
})

it('duplicates a caption only once with its image and keeps the fill on a caption-only copy', async () => {
  const original = { ...caption, captionSide: 'left' as const, left: -190, top: 30, captionBackground: '#b52d42' }
  const b = await board([original, image, text]) // exercise allocation when the caption is below the image in the stack
  b.select('caption', 'image')
  b.editor.duplicateSelection()
  const [copiedCaption, copy] = b.scene().slice(3)
  expect(b.scene()).toHaveLength(5)
  expect(copiedCaption).toMatchObject({ type: 'text', captionOf: copy!.id, captionSide: 'left', captionBackground: original.captionBackground })
  expect(b.editor.getState().selection?.count).toBe(2)
  b.editor.undo()
  expect(b.scene()).toEqual([original, image, text])
  b.editor.redo()
  expect(b.scene().slice(3)).toEqual([copiedCaption, copy])
  b.select('caption')
  b.editor.duplicateSelection()
  expect(b.scene().at(-1)).not.toHaveProperty('captionOf')
  expect(b.scene().at(-1)).not.toHaveProperty('captionSide')
  expect(b.scene().at(-1)).toHaveProperty('captionBackground', original.captionBackground)
})

it('lock guards the commands and leaves a locked caption behind when its image is deleted', async () => {
  const locked = { ...caption, locked: true as const, captionBackground: '#b52d42' }
  const b = await board([image, locked, text])
  b.select('image')
  expect(b.enter()).toBe(false)
  b.editor.editCaption()
  b.editor.detachCaption()
  expect(b.editor.getState().selection?.caption).toMatchObject({ edit: 'edit', canEdit: false, canDetach: false })
  const t = press(b.canvas, b.find('image'))
  dragBy(b.canvas, t, 10, 0)
  release(b.canvas, t)
  await tick()
  expect(b.scene()[1]).toEqual({ ...locked, left: 30 })
  b.editor.deleteSelection()
  expect(b.scene()[0]).toEqual({ ...locked, left: 30, captionOf: undefined })
  b.editor.undo()
  expect(b.scene()[1]).toEqual({ ...locked, left: 30 })
  b.editor.redo()
  expect(b.scene()[0]).not.toHaveProperty('captionOf')

  const other = await board([{ ...image, locked: true }, text])
  other.select('image')
  expect(other.enter()).toBe(false)
  other.select('image', 'text')
  other.editor.makeCaption()
  expect(other.editor.getState().canUndo).toBe(false)

  const lockedImage = await board([{ ...image, locked: true }, caption, text])
  lockedImage.select('caption')
  lockedImage.editor.detachCaption()
  expect(lockedImage.scene()[1]).toEqual(caption)
  expect(lockedImage.editor.getState().canUndo).toBe(false)
})

it('Enter and caption commands are inert before load, while busy, and after a revision conflict', async () => {
  const b = await board([image, caption, text], true)
  expect(b.enter()).toBe(false)
  b.editor.editCaption()
  b.editor.makeCaption()
  b.editor.detachCaption()
  await durable()
  expect(b.store.attempts).toEqual([])
  b.store.releaseLoad()
  await b.pending
  b.select('image')
  const t = press(b.canvas, b.find('image'))
  dragBy(b.canvas, t, 20, 20)
  expect(b.enter()).toBe(false)
  b.editor.editCaption()
  b.editor.detachCaption()
  b.editor.makeCaption()
  expect(captionOf(b.find('caption') as never)).toBe('image')
  b.store.saveError = new BoardConflictError()
  b.editor.setTitle('New title')
  await durable() // save sees the base and the conflict cancels the held drag
  expect(b.store.attempts[0]?.doc.objects).toEqual([image, caption, text])
  expect(b.editor.getState().readOnly).toBeTruthy()
  expect(b.scene()).toEqual([image, caption, text])
  expect(b.enter()).toBe(false)
  b.editor.detachCaption()
  b.editor.editCaption()
  b.editor.makeCaption()
  release(b.canvas, t)
  await durable()
  expect(b.store.attempts).toHaveLength(1)
  expect(b.editor.getState().canUndo).toBe(false)
})

it('only the first caption can claim an image at commit, and a broken attachment detaches in place', async () => {
  const b = await board()
  setCaption(b.find('text') as never, 'image', 'right')
  b.select('image')
  b.enter()
  ;(b.canvas.getActiveObject() as Textbox).exitEditing()
  expect(b.scene()).toEqual([image, caption, text])
  setCaption(b.find('caption') as never, 'missing', 'top')
  b.select('text')
  b.editor.setFontSize(30)
  expect(b.scene()[1]).toEqual({ ...caption, captionOf: undefined })
  expect(b.scene()[1]).not.toHaveProperty('captionSide')
})

it('an import waits behind a held caption gesture and can be undone separately', async () => {
  const b = await board()
  b.select('caption')
  const t = press(b.canvas, b.find('caption'))
  const decode = b.assets.hold('new.png')
  const adding = b.editor.addImageFiles([new File(['png'], 'new.png', { type: 'image/png' })])
  dragBy(b.canvas, t, 30, 20)
  decode.resolve()
  await adding
  expect(b.scene()).toEqual([image, caption, text])
  release(b.canvas, t)
  await tick()
  expect(b.scene()).toHaveLength(4)
  expect(b.scene()[1]).not.toHaveProperty('captionOf')
  b.editor.undo()
  expect(b.scene()).toHaveLength(3)
  expect(b.scene()[1]).not.toHaveProperty('captionOf')
  b.editor.undo()
  expect(b.scene()).toEqual([image, caption, text])
})

it('a save already in flight and a queued save persist each completed scene', async () => {
  const b = await board()
  b.store.saveGate = deferred<void>()
  b.editor.setTitle('Before')
  await durable()
  b.select('image')
  const t = press(b.canvas, b.find('image'))
  dragBy(b.canvas, t, 20, 10)
  b.editor.setTitle('During')
  expect(b.store.attempts[0]?.doc.objects).toEqual([image, caption, text])
  release(b.canvas, t)
  await tick()
  b.store.saveGate.resolve()
  await durable()
  expect(b.store.saves).toHaveLength(2)
  expect(b.store.saves[1]?.doc.objects.slice(0, 2)).toEqual([{ ...image, left: 40, top: 40 }, { ...caption, left: 40, top: 150 }])
})
