import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc, parseDoc, serializeDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, TextRecord } from '../model/types.ts'
import { Editor } from './Editor.ts'
import { FIX_HEIGHT_ACTION, createProxy, textDataOf, toRecord } from './objects.ts'
import { canvasOf, press, release, scaleBy, tick } from './testing/drive.ts'
import type { FakeObject, FakeTransform } from './testing/fakeFabric.ts'
import { replaceText, startEditing, textAdapterOf } from './testing/editing.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore, stubTextLayout } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * A text with a fixed height (Slice 4): the record field, the bottom handle's gesture as the editor
 * settles it, scale folding, Auto height and storage. The fake Fabric models the state machines,
 * not the layout or the wheel: scrolling, the fades, the thumb and wheel ownership are covered in
 * the browser (`e2e/card-height.spec.ts`) and the ownership rule itself in `wheelGesture.test.ts`.
 */

const review = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 'rev', left: 100, top: 50, angle: 0, text: 'one\ntwo\nthree\nfour', fontSize: 20, width: 300, ...patch })
const frame: FrameRecord = { id: 'f1', name: 'Spread', left: 0, top: 0, width: 600, height: 300 }

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function setup(objects: TextRecord[] = [review()], frames: FrameRecord[] = []) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Heights', frames, objects }
  const store = new SpyStore({ doc, assets: new Map() })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets(), undefined, { measurer: new FakeCardMeasurer() })
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const tb = canvas.objects.find((o) => textDataOf(o as never)) as FakeObject
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects as TextRecord[]
  return { editor, store, canvas, tb, scene }
}

/** The bottom handle dragged until the box is `height` tall: Fabric's `changeHeight` sets the proxy's height and fires `object:resizing`. */
function dragBottomHandle(canvas: ReturnType<typeof canvasOf>, tb: FakeObject, height: number): FakeTransform {
  const t = press(canvas, tb, { action: FIX_HEIGHT_ACTION, corner: 'mb', originX: 'center', originY: 'top' })
  tb.height = height
  t.actionPerformed = true
  canvas.fire('object:resizing', { e: { button: 0 }, target: tb, transform: t })
  return t
}

let restoreLayout = () => {}
beforeEach(() => {
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
})

describe('the record: a fixed height on the proxy and back', () => {
  it('round-trips, sizes the proxy, and is absent when the text grows with its words', () => {
    const fixed = createProxy(review({ height: 64.5 }), () => undefined)!
    expect(fixed.height).toBe(64.5)
    expect(toRecord(fixed)).toEqual(review({ height: 64.5 }))
    const auto = createProxy(review({ minHeight: 30 }), () => undefined)!
    expect(toRecord(auto)).not.toHaveProperty('height')
  })

  it('a residual scale is reported in the height as in the width (a corner scale is uniform)', () => {
    const tb = createProxy(review({ height: 100 }), () => undefined)!
    Object.assign(tb, { scaleX: 1.5, scaleY: 1.5 })
    expect(toRecord(tb)).toMatchObject({ fontSize: 30, width: 450, height: 150 })
  })

  it('the bottom handle is shown and fixes the height; the top handle stays hidden', () => {
    // (The fake keeps the handles and their visibility in one record.)
    const tb = createProxy(review(), () => undefined)! as unknown as { controls: Record<string, unknown> }
    expect(tb.controls.mb).toMatchObject({ actionName: FIX_HEIGHT_ACTION, y: 0.5 })
    expect(tb.controls.mt).toBe(false)
  })

  it('the bottom handle never makes a box shorter than one and a half font sizes', () => {
    const tb = createProxy(review({ fontSize: 20 }), () => undefined)! as unknown as FakeObject & { controls: Record<string, { actionHandler: (...a: unknown[]) => boolean }> }
    tb.height = 4 // as Fabric's own height change would leave it, dragged up to the top edge
    expect(tb.controls.mb!.actionHandler({}, { target: tb }, 0, 0)).toBe(true)
    expect(tb.height).toBe(30)
  })

  it('a stored fixed height is written as wire version 3, and a board whose last one went is written in its older form', () => {
    const fixed: BoardDoc = { ...createEmptyDoc(), objects: [review({ height: 120 })] }
    expect(serializeDoc(fixed).version).toBe(3)
    expect(parseDoc(serializeDoc(fixed))?.objects[0]).toEqual(review({ height: 120 }))
    expect(serializeDoc({ ...fixed, objects: [review()] }).version).toBe(1)
    // An invalid height is never written, so it cannot be what makes the board version 3.
    expect(serializeDoc({ ...fixed, objects: [review({ height: -4 })] }).version).toBe(1)
  })
})

describe('the bottom handle as the editor settles it', () => {
  it('stores the height (rounded), keeps the top edge and the width, records one step and saves it', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    canvas.setActiveObject(tb)
    const t = dragBottomHandle(canvas, tb, 61.237)
    expect(textDataOf(tb as never)).toMatchObject({ height: 61.24, width: 300 })
    release(canvas, t)
    await tick()
    await flush()
    expect(scene()[0]).toEqual(review({ height: 61.24 }))
    expect(store.saves.at(-1)!.doc.objects[0]).toEqual(review({ height: 61.24 }))
    expect(editor.getState().selection).toMatchObject({ kind: 'text', textHeight: 'fixed' })
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(review())
    expect(editor.getState().selection?.textHeight ?? 'auto').toBe('auto')
    expect(editor.getState().canUndo).toBe(false) // the drag was one step
    editor.redo()
    await flush()
    expect(scene()[0]).toEqual(review({ height: 61.24 }))
  })

  it('Esc mid-drag puts the text back as it was: no step, no save', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    dragBottomHandle(canvas, tb, 40)
    editor.handleKeyDown(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(scene()[0]).toEqual(review())
    expect(store.saves).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('ownership is decided by the fixed box’s centre, as for any resize', async () => {
    // The text's centre is inside the frame; a box made taller moves its centre out of it.
    const { canvas, tb, scene } = await setup([review({ frameId: 'f1', top: 200 })], [frame])
    const t = dragBottomHandle(canvas, tb, 300)
    release(canvas, t)
    await tick()
    expect(scene()[0]).toMatchObject({ height: 300 })
    expect(scene()[0]).not.toHaveProperty('frameId')
  })
})

describe('a corner scale folds a fixed height once', () => {
  it('font size, width and height all times the factor; undo restores exactly', async () => {
    const { editor, canvas, tb, scene } = await setup([review({ height: 80 })])
    canvas.setActiveObject(tb)
    const t = press(canvas, tb, { action: 'scale', corner: 'br' })
    scaleBy(canvas, t, 1.5)
    release(canvas, t)
    await tick()
    expect(scene()[0]).toMatchObject({ fontSize: 30, width: 450, height: 120 })
    expect(tb.scaleX).toBe(1)
    expect(tb.height).toBe(120)
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(review({ height: 80 }))
  })
})

describe('Auto height', () => {
  it('takes the fixed height away as one step, the top edge staying; undo and redo', async () => {
    const { editor, store, canvas, tb, scene } = await setup([review({ height: 40 })])
    canvas.setActiveObject(tb)
    expect(editor.getState().selection?.textHeight).toBe('fixed')
    editor.setTextAutoHeight()
    await flush()
    expect(scene()[0]).toEqual(review())
    expect(tb.top).toBe(50)
    expect(tb.height).toBe(100) // four lines of the fake measurer
    expect(store.saves.at(-1)!.doc.objects[0]).toEqual(review())
    expect(serializeDoc(store.saves.at(-1)!.doc).version).toBe(1)
    expect(editor.getState().selection?.textHeight).toBe('auto')
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(review({ height: 40 }))
    editor.redo()
    await flush()
    expect(scene()[0]).toEqual(review())
  })

  it('does nothing on a text that grows with its words, a locked text, or a read-only board', async () => {
    const auto = await setup()
    auto.canvas.setActiveObject(auto.tb)
    auto.editor.setTextAutoHeight()
    await flush()
    expect(auto.editor.getState().canUndo).toBe(false)
    expect(auto.store.saves).toHaveLength(0)

    const locked = await setup([review({ height: 40, locked: true })])
    locked.editor.selectLayer('rev')
    locked.editor.setTextAutoHeight()
    await flush()
    expect(locked.scene()[0]).toEqual(review({ height: 40, locked: true }))
    expect(locked.store.saves).toHaveLength(0)
  })

  it('while the text is edited it is saved at once and part of the edit’s one step', async () => {
    const { editor, store, canvas, tb, scene } = await setup([review({ height: 40 })])
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    replaceText(editor, 'one\ntwo')
    editor.setTextAutoHeight()
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toEqual(review({ text: 'one\ntwo' }))
    expect(textAdapterOf(editor).editedTarget()).toBe(tb) // the edit stays open
    textAdapterOf(editor).finishEditing()
    await flush()
    editor.undo()
    await flush()
    expect(scene()[0]).toEqual(review({ height: 40 })) // text and height come back together
    expect(editor.getState().canUndo).toBe(false)
  })
})

describe('a fixed-height text through the rest of the canvas', () => {
  it('typing never changes a fixed height', async () => {
    const { editor, canvas, tb, scene } = await setup([review({ height: 40 })])
    canvas.setActiveObject(tb)
    startEditing(editor, tb)
    replaceText(editor, 'one\ntwo\nthree\nfour\nfive\nsix\nseven')
    textAdapterOf(editor).finishEditing()
    expect(tb.height).toBe(40)
    expect(scene()[0]).toMatchObject({ height: 40 })
  })

  it('duplicate copies it', async () => {
    const { editor, canvas, tb, scene } = await setup([review({ height: 40 })])
    canvas.setActiveObject(tb)
    editor.duplicateSelection()
    expect(scene()).toHaveLength(2)
    expect(scene()[1]).toMatchObject({ height: 40, width: 300, fontSize: 20 })
  })
})
