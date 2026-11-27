import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import { PAPER_PAD_X_EM, PAPER_PAD_Y_EM, minFixedHeight } from '../model/paper.ts'
import type { BoardDoc, FrameRecord, TextRecord } from '../model/types.ts'
import { BARE_NEW_TEXT_KEY, Editor } from './Editor.ts'
import { ProxyRect, textDataOf } from './objects.ts'
import { canvasOf, pressCanvas, releaseCanvas, tick } from './testing/drive.ts'
import { insertText, startEditing, textAdapterOf } from './testing/editing.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore, stubTextLayout } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * Paper (Slice 5) as the editor handles it: who gets it, where a new paper box goes, the floors that
 * add the padding, and the Paper command. Layout itself (that the words do not move) is checked in
 * the browser (`e2e/paper.spec.ts`); the fake measurer only stands in for sizes.
 */

const note = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 't', left: 100, top: 80, angle: 0, text: 'one two', fontSize: 20, width: 300, ...patch })
const frame: FrameRecord = { id: 'f1', name: 'Spread', left: 0, top: 0, width: 800, height: 600 }
const padX = (fs: number) => fs * PAPER_PAD_X_EM
const padY = (fs: number) => fs * PAPER_PAD_Y_EM

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function setup(objects: TextRecord[] = [], frames: FrameRecord[] = []) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Paper', frames, objects }
  const store = new SpyStore({ doc, assets: new Map() })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets(), undefined, { measurer: new FakeCardMeasurer() })
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects as TextRecord[]
  return { editor, store, canvas, scene }
}

let restoreLayout = () => {}
beforeEach(() => {
  localStorage.removeItem(BARE_NEW_TEXT_KEY) // paper, as for a person (the setup file makes other tests bare)
  restoreLayout = stubTextLayout()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => {
  restoreLayout()
  editors.splice(0).forEach((e) => e.dispose())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.setItem(BARE_NEW_TEXT_KEY, '1')
})

describe('who gets paper', () => {
  it('a click with the Text tool: paper, the words at the press point, ten font sizes of words', async () => {
    const { editor, canvas, scene } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 300, 200)
    releaseCanvas(canvas, 300, 200)
    await tick()
    insertText(editor, 'hello')
    textAdapterOf(editor).finishEditing()
    const rec = scene()[0]!
    const fs = rec.fontSize
    expect(rec).toMatchObject({ surface: 'card', left: 300 - padX(fs), top: 200 - padY(fs), width: 10 * fs + 2 * padX(fs) })
    expect(rec).not.toHaveProperty('minHeight')
  })

  it('a drawn box: paper, the drawn rectangle is the sheet', async () => {
    const { editor, canvas, scene } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 100, 100)
    releaseCanvas(canvas, 400, 220)
    await tick()
    insertText(editor, 'drawn')
    textAdapterOf(editor).finishEditing()
    expect(scene()[0]).toMatchObject({ surface: 'card', left: 100, top: 100, width: 300, minHeight: 120 })
  })

  it('Add text (the empty board’s button): paper too', async () => {
    const { editor, scene } = await setup()
    editor.addText()
    insertText(editor, 'added')
    textAdapterOf(editor).finishEditing()
    expect(scene()[0]).toMatchObject({ surface: 'card', text: 'added' })
  })

  it('a test from before paper asks for bare boxes (development builds only): then a click makes the bare box it always did', async () => {
    localStorage.setItem(BARE_NEW_TEXT_KEY, '1')
    const { editor, canvas, scene } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 300, 200)
    releaseCanvas(canvas, 300, 200)
    await tick()
    insertText(editor, 'bare')
    textAdapterOf(editor).finishEditing()
    const rec = scene()[0]!
    expect(rec).toMatchObject({ left: 300, top: 200, width: 10 * rec.fontSize })
    expect(rec).not.toHaveProperty('surface')
  })

  it('a production build never reads that switch: the same click there makes paper', async () => {
    localStorage.setItem(BARE_NEW_TEXT_KEY, '1')
    vi.stubEnv('DEV', false) // what `import.meta.env.DEV` is in `npm run build` (Vite then drops the branch)
    try {
      const { editor, canvas, scene } = await setup()
      editor.setTool('text')
      pressCanvas(canvas, 300, 200)
      releaseCanvas(canvas, 300, 200)
      await tick()
      insertText(editor, 'made in production')
      textAdapterOf(editor).finishEditing()
      expect(scene()[0]).toMatchObject({ surface: 'card' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('the floors add the padding', () => {
  it('a paper text’s narrowest width is its widest word plus the padding on both sides', async () => {
    const { canvas } = await setup([note({ id: 'bare' }), note({ id: 'paper', top: 300, surface: 'card' })])
    const [bare, paper] = canvas.objects as unknown as ProxyRect[]
    expect(paper!.minTextWidth).toBe(bare!.minTextWidth + 2 * padX(20))
    // And its height is the words’ height plus the padding above and below.
    expect(paper!.height).toBe(bare!.height + 2 * padY(20))
  })
})

describe('the Paper command', () => {
  it('on: the box grows by the padding about its centre, one undo step, the owner kept; off and undo restore exactly', async () => {
    const rec = note({ frameId: 'f1' })
    const { editor, canvas, scene } = await setup([rec], [frame])
    const tb = canvas.objects.find((o) => textDataOf(o as never))!
    canvas.setActiveObject(tb)
    const h0 = tb.height
    editor.setTextPaper(true)
    await flush()
    expect(scene()[0]).toEqual({ ...rec, surface: 'card', left: 100 - padX(20), top: 80 - padY(20), width: 300 + 2 * padX(20) })
    expect(tb.height).toBe(h0 + 2 * padY(20))
    expect(editor.getState().selection).toMatchObject({ textPaper: true })
    editor.setTextPaper(true) // already on: nothing
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(rec)
    expect(editor.getState().canUndo).toBe(false) // it was one step
    editor.redo()
    await flush()
    editor.setTextPaper(false)
    await flush()
    expect(scene()[0]).toEqual(rec)
  })

  it('a drawn minimum height and a fixed height grow with it; a locked text refuses it', async () => {
    const { editor, canvas, scene } = await setup([note({ minHeight: 50, height: 120 }), note({ id: 'l', top: 400, locked: true })])
    canvas.setActiveObject(canvas.objects[0] as never)
    editor.setTextPaper(true)
    expect(scene()[0]).toMatchObject({ minHeight: 50 + 2 * padY(20), height: 120 + 2 * padY(20), surface: 'card' })
    editor.selectLayer('l')
    editor.setTextPaper(true)
    expect(scene()[1]).not.toHaveProperty('surface')
  })

  it('while the text is edited it is saved at once and part of the edit’s one step', async () => {
    const rec = note()
    const { editor, store, canvas, scene } = await setup([rec])
    const tb = canvas.objects[0]!
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    insertText(editor, ' three')
    editor.setTextPaper(true)
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toMatchObject({ surface: 'card', text: 'one two three' })
    textAdapterOf(editor).finishEditing()
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(rec)
  })

  it('a corner scale keeps the paper and scales its padding through the font size alone', async () => {
    const { editor, canvas, scene } = await setup([note({ surface: 'card', width: 340 })])
    const tb = canvas.objects[0]!
    Object.assign(tb, { scaleX: 1.5, scaleY: 1.5 })
    textAdapterOf(editor).normalizeScale(tb as never)
    expect(scene()[0]).toMatchObject({ surface: 'card', fontSize: 30, width: 510 })
    expect(Object.keys(scene()[0]!).sort()).toEqual(Object.keys(note({ surface: 'card' })).sort())
  })
})

describe('a stored fixed height is never below the least one for the text’s size and paper', () => {
  for (const surface of ['card', undefined] as const) {
    it(`a larger font size from the panel raises it in the same step; undo gives back both (${surface ?? 'bare'})`, async () => {
      const rec = note({ fontSize: 24, height: 72, ...(surface && { surface }) })
      const { editor, canvas, scene } = await setup([rec])
      const tb = canvas.objects[0]!
      canvas.setActiveObject(tb)
      editor.setFontSize(64)
      await flush()
      const least = minFixedHeight(64, surface)
      expect(least).toBe(surface ? 192 : 96)
      expect(scene()[0]).toMatchObject({ fontSize: 64, height: least })
      expect(tb.height).toBe(least) // the proxy (and so the selection box) agrees with the record
      editor.setFontSize(30) // a smaller size never lowers it
      await flush()
      expect(scene()[0]).toMatchObject({ fontSize: 30, height: least })
      editor.undo()
      editor.undo()
      await flush()
      expect(scene()[0]).toEqual(rec)
      expect(canvas.objects[0]!.height).toBe(72) // undo builds the proxy afresh
    })
  }

  it('while the text is edited too: part of the edit’s step', async () => {
    const rec = note({ fontSize: 24, height: 72, surface: 'card' })
    const { editor, store, canvas, scene } = await setup([rec])
    const tb = canvas.objects[0]!
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    editor.setFontSize(64)
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toMatchObject({ fontSize: 64, height: 192 })
    expect(tb.height).toBe(192)
    textAdapterOf(editor).finishEditing()
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(rec)
  })

  it('a stored height below it (an older build) loads as it is and is drawn at it', async () => {
    const rec = note({ fontSize: 64, height: 72 })
    const { canvas, scene, store } = await setup([rec, note({ id: 'p', top: 400, fontSize: 64, height: 72, surface: 'card' })])
    await flush()
    expect(scene()[0]).toEqual(rec)
    expect(store.saves).toHaveLength(0)
    expect(canvas.objects.map((o) => o.height)).toEqual([96, 192])
  })

  it('turning paper on raises a height below it; a corner scale that rounds under it is held to it', async () => {
    const { editor, canvas, scene } = await setup([note({ fontSize: 64, height: 72 }), note({ id: 's', top: 400, fontSize: 24, height: 36 })])
    canvas.setActiveObject(canvas.objects[0] as never)
    editor.setTextPaper(true)
    expect(scene()[0]).toMatchObject({ surface: 'card', height: 192 })
    const tb = canvas.objects[1]!
    Object.assign(tb, { scaleX: 1.0167, scaleY: 1.0167 }) // 24.4 px: 36.6 high, least 37
    textAdapterOf(editor).normalizeScale(tb as never)
    expect(scene()[1]).toMatchObject({ fontSize: 24.4, height: 37 })
  })
})

describe('the Paper button on a new box before anything is typed', () => {
  it('shows what the box has and toggles each time; the box is stored as chosen once it has words; discarded, nothing is written', async () => {
    const { editor, store, canvas, scene } = await setup()
    editor.setTool('text')
    pressCanvas(canvas, 300, 200)
    releaseCanvas(canvas, 300, 200)
    await tick()
    const paper = () => editor.getState().selection?.textPaper
    expect(paper()).toBe(true)
    editor.setTextPaper(false)
    expect(paper()).toBe(false)
    editor.setTextPaper(true)
    expect(paper()).toBe(true)
    editor.setTextPaper(false)
    expect(paper()).toBe(false)
    await flush()
    expect(store.saves).toHaveLength(0)
    insertText(editor, 'bare now')
    textAdapterOf(editor).finishEditing()
    await flush()
    const rec = scene()[0]!
    expect(rec).not.toHaveProperty('surface')
    // The words stayed at the press point: the sheet went from round them.
    expect(rec).toMatchObject({ left: 300, top: 200, width: 10 * rec.fontSize })

    // And one left blank after a toggle writes nothing.
    const before = store.saves.length
    editor.setTool('text')
    pressCanvas(canvas, 300, 500)
    releaseCanvas(canvas, 300, 500)
    await tick()
    editor.setTextPaper(false)
    textAdapterOf(editor).finishEditing()
    await flush()
    expect(store.saves).toHaveLength(before)
    expect(scene()).toHaveLength(1)
  })
})
