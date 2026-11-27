import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, TextRecord } from '../model/types.ts'
import { Editor } from './Editor.ts'
import { canvasOf, press, release, tick } from './testing/drive.ts'
import type { Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

type Styles = Record<number, Record<number, Record<string, unknown>>>

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
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const tb = canvas.objects[0] as Textbox
  /** Records as the editor would save them right now (through its own getDoc). */
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects
  return { editor, store, canvas, tb, scene }
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
    tb.enterEditing()
    tb.exitEditing()
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
    expect((tb as unknown as { styles: Styles }).styles[0]![0]).toEqual({ fontSize: 60, fontWeight: 'bold' })
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
    tb.enterEditing()
    tb.type('Title') // the body line with the bold word is gone
    tb.exitEditing()
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

  it('after a text change the canvas styles are made canonical before the typing save, without moving the text', async () => {
    const { store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    tb.enterEditing()
    // What Fabric leaves after Backspace merged the body line into the heading: the body
    // characters keep their old (body) styles, so one paragraph has two sizes.
    const h1 = { fontSize: 40, fontWeight: 'bold' }
    const t = tb as unknown as { styles: Styles; text: string }
    t.text = 'Titlesome bold words'
    t.styles = { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1, 10: { fontWeight: 'bold' }, 11: { fontWeight: 'bold' }, 12: { fontWeight: 'bold' }, 13: { fontWeight: 'bold' } } }
    const at = { left: tb.left, top: tb.top }
    canvas.fire('text:changed', { target: tb })
    // Every character of the merged paragraph is now drawn at the heading size, and nothing else.
    expect(Object.keys(t.styles[0]!)).toHaveLength(20)
    for (const st of Object.values(t.styles[0]!)) expect(st).toEqual(h1)
    expect({ left: tb.left, top: tb.top }).toEqual(at)
    await flush() // the typing save, mid-edit
    const saved = store.saves.at(-1)!.doc.objects[0]
    const want = rich({ text: 'Titlesome bold words' })
    delete want.spans // "bold" now lies inside the heading, which is bold already
    expect(saved).toStrictEqual(want)
    expect(scene()[0]).toStrictEqual(saved)
    tb.exitEditing()
  })

  it('a paste that brings a larger size: the typing save stores the carried levels, and one undo restores the text exactly', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    tb.enterEditing()
    // "BIG" copied from a 40 px text and pasted at the start of the body line: Fabric gives
    // it the source's complete style, whose size is this text's heading 1 size.
    const big = { fontSize: 40, fontWeight: 'normal', fontFamily: 'Arial', fill: '#000000' }
    const t = tb as unknown as { styles: Styles }
    const h1 = { fontSize: 40, fontWeight: 'bold' }
    t.styles = { 0: { 0: h1, 1: h1, 2: h1, 3: h1, 4: h1 }, 1: { 0: big, 1: big, 2: big, 8: { fontWeight: 'bold' }, 9: { fontWeight: 'bold' }, 10: { fontWeight: 'bold' }, 11: { fontWeight: 'bold' } } }
    tb.type('Title\nBIGsome bold words', 9)
    await flush() // the typing save, mid-edit
    const pasted = rich({ text: 'Title\nBIGsome bold words', spans: [{ start: 14, end: 18, bold: true }] })
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(pasted)
    expect(t.styles[1]![0]).toBeUndefined() // the pasted size is gone from the canvas too
    tb.exitEditing()
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

  it('a text changed while it is not being edited (the source of a dragged selection) is made canonical too', async () => {
    const { store, canvas, tb } = await setup()
    // Fabric removes the dragged characters from the source after the drop (DraggableTextDelegate.mjs
    // dragEndHandler), when the source may already have left its edit.
    const t = tb as unknown as { styles: Styles; text: string; selectionEnd?: number }
    const b = { fontWeight: 'bold' }
    t.text = 'some bold words' // the heading line "Title\n" was dragged away, with its line break
    t.styles = { 0: { 5: b, 6: b, 7: b, 8: b } } // Fabric moved the body line's styles up (removeStyleFromTo)
    t.selectionEnd = 0
    canvas.fire('text:changed', { target: tb })
    await flush()
    const want = rich({ text: 'some bold words', spans: [{ start: 5, end: 9, bold: true }] })
    delete want.headings
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(want)
    expect(t.styles).toEqual({ 0: { 5: b, 6: b, 7: b, 8: b } })
  })

  it('a formatted text that ends blank is still discarded, with its removal as one undo step', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    tb.enterEditing()
    tb.type(' \n ')
    await flush()
    expect(store.saves.at(-1)!.doc.objects.map((o) => o.id)).toEqual(['plain']) // the typing save never holds a blank text
    tb.exitEditing()
    await tick()
    await flush()
    expect(canvas.objects.map((o) => o.constructor.name)).toEqual(['Textbox'])
    expect(scene().map((o) => o.id)).toEqual(['plain'])
    editor.undo()
    await flush()
    expect(scene()[0]).toStrictEqual(rich())
  })
})
