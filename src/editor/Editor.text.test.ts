import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, TextRecord } from '../model/types.ts'
import { Editor } from './Editor.ts'
import { canvasOf, press, release, tick } from './testing/drive.ts'
import type { FakeObject } from './testing/fakeFabric.ts'
import { editSession, pressKey, replaceText, selectText, startEditing, textAdapterOf } from './testing/editing.ts'
import { textDataOf } from './objects.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore, stubTextLayout } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/** A formatted text: a level 1 heading line, a bold word on the body line, a font, alignment and colour. */
const rich = (patch: Partial<TextRecord> = {}): TextRecord => ({
  type: 'text',
  id: 'rich',
  left: 100,
  top: 40,
  angle: 0,
  text: 'Title\nsome bold words',
  fontSize: 20,
  width: 300,
  font: 'serif',
  align: 'center',
  color: '#c0392b',
  spans: [{ start: 11, end: 15, bold: true }],
  headings: [1],
  ...patch,
})
const plain: TextRecord = { type: 'text', id: 'plain', left: 500, top: 40, angle: 0, text: 'plain', fontSize: 24, width: 240 }
const storedDoc = (): BoardDoc => ({ ...createEmptyDoc(), title: 'Stored', objects: [rich(), plain] })

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function setup(doc: BoardDoc = storedDoc()) {
  const store = new SpyStore({ doc, assets: new Map() })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets(), undefined, { measurer: new FakeCardMeasurer() })
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const tb = canvas.objects[0] as FakeObject
  /** Records as the editor would save them right now (through its own getDoc). */
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects
  return { editor, store, canvas, tb, scene }
}

let restoreLayout = () => {}
beforeEach(() => {
  restoreLayout = stubTextLayout()
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
  restoreLayout()
  editors.splice(0).forEach((e) => e.dispose())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a loaded formatted text', () => {
  it('is on the canvas exactly as stored, and commits that change nothing record and save nothing', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    expect(scene()).toEqual(storedDoc().objects)

    // A click without movement.
    const t = press(canvas, tb)
    release(canvas, t)
    await tick()
    // Entering and leaving an edit without typing (leaving commits).
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    textAdapterOf(editor).finishEditing()
    // Setting the font size it already has (commits under a coalescing key).
    canvas.setActiveObject(tb)
    editor.setFontSize(20)
    canvas.discardActiveObject()
    await flush()

    expect(store.saves).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
    expect(scene()).toEqual(storedDoc().objects)
  })

  it('setting the font size keeps the heading at its ratio, as one undoable step', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    editor.setFontSize(30)
    expect(textDataOf(tb as never)).toMatchObject({ fontSize: 30, headings: [1] }) // the card draws the heading at its ratio to the size
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toEqual(rich({ fontSize: 30 }))
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(rich())
  })
})

describe('editing a formatted text', () => {
  it('undo and redo of an edit restore the text and its formatting exactly', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    replaceText(editor, 'Title') // the body line with the bold word is gone
    textAdapterOf(editor).finishEditing()
    await flush()
    const edited = rich({ text: 'Title', spans: undefined })
    delete edited.spans
    expect(scene()[0]).toEqual(edited)
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(edited)

    editor.undo()
    await flush()
    expect(scene()[0]).toStrictEqual(rich())
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(rich())
    expect(editor.getState().canUndo).toBe(false) // the whole edit was one step
    editor.redo()
    await flush()
    expect(scene()[0]).toStrictEqual(edited)
  })

  it('after a text change the record is canonical before the typing save, without moving the text', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    // Backspace at the start of the body line merges it into the heading.
    selectText(editor, 6)
    const at = { left: tb.left, top: tb.top }
    pressKey(editor, 'Backspace')
    expect(editSession(editor).content()).toMatchObject({ text: 'Titlesome bold words', headings: [1] })
    expect({ left: tb.left, top: tb.top }).toEqual(at)
    await flush() // the typing save, mid-edit
    const saved = store.saves.at(-1)!.doc.objects[0]
    const want = rich({ text: 'Titlesome bold words' })
    delete want.spans // "bold" now lies inside the heading, which is bold already
    expect(saved).toStrictEqual(want)
    expect(scene()[0]).toStrictEqual(saved)
    textAdapterOf(editor).finishEditing()
  })

  it('a paste that brings a larger size: the typing save stores the carried levels, and one undo restores the text exactly', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    // "BIG" copied from a 40 px text and pasted at the start of the body line: it brings no size and no heading.
    selectText(editor, 6)
    editSession(editor).paste({ text: 'BIG', html: '<span style="font-size:40px">BIG</span>' })
    await flush() // the typing save, mid-edit
    const pasted = rich({ text: 'Title\nBIGsome bold words', spans: [{ start: 14, end: 18, bold: true }] })
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(pasted)
    textAdapterOf(editor).finishEditing()
    await tick()
    await flush()
    expect(scene()[0]).toStrictEqual(pasted)
    editor.undo()
    await flush()
    expect(scene()[0]).toStrictEqual(rich())
    expect(editor.getState().canUndo).toBe(false)
    editor.redo()
    await flush()
    expect(scene()[0]).toStrictEqual(pasted)
  })

  it('a formatted text that ends blank is still discarded, with its removal as one undo step', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    replaceText(editor, ' \n ')
    await flush()
    expect(store.saves.at(-1)!.doc.objects.map((o) => o.id)).toEqual(['plain']) // the typing save never holds a blank text
    textAdapterOf(editor).finishEditing()
    await tick()
    await flush()
    expect(canvas.objects.map((o) => o.constructor.name)).toEqual(['ProxyRect'])
    expect(scene().map((o) => o.id)).toEqual(['plain'])
    editor.undo()
    await flush()
    expect(scene()[0]).toStrictEqual(rich())
  })
})
