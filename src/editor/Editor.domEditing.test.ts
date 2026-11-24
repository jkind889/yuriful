import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, ObjectRecord, Scene, StoredAsset, TextRecord } from '../model/types.ts'
import { Editor } from './Editor.ts'
import type { EditorOptions } from './Editor.ts'
import { idOf } from './objects.ts'
import { DomTextAdapter, fabricWordAt } from './textAdapter.ts'
import type { EditSession } from './textSession.ts'
import { canvasOf, press, dragBy, release } from './testing/drive.ts'
import type { FakeObject } from './testing/fakeFabric.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The DOM renderer's live text editing (plan Slice 2c-ii), driven through the real editor on the
 * fake Fabric with the text engine's real session and view (jsdom lays nothing out, so changes
 * come through the session's own commands, and card sizes from `FakeCardMeasurer`). What a person
 * does with the pointer and the keyboard, and where things land on screen, is proven in
 * `e2e/dom-editing.spec.ts`.
 */

const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new Uint8Array([7, 8, 9]).buffer })
const F = (id: string, left: number, top: number, width = 400, height = 300): FrameRecord => ({ id, name: `Frame ${id}`, left, top, width, height })
const img = (id: string, left: number, top: number, extra: Partial<ImageRecord> = {}): ImageRecord => ({ type: 'image', id, left, top, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1, ...extra })
const txt = (id: string, left: number, top: number, extra: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id, left, top, angle: 0, text: `${id} words`, fontSize: 20, width: 200, ...extra })

let host: HTMLDivElement
const editors: Editor[] = []

async function open(frames: FrameRecord[], objects: ObjectRecord[], options: EditorOptions = { renderer: 'dom', measurer: new FakeCardMeasurer() }) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Editing', frames, objects }
  const store = new SpyStore({ doc, assets: new Map([['a1', asset('a1')]]) })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets(), undefined, options)
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const obj = (id: string): FakeObject => {
    const found = canvas.objects.find((o) => idOf(o as never) === id)
    if (!found) throw new Error(`no object ${id}`)
    return found
  }
  const internals = editor as unknown as {
    snapshot: () => Scene
    history: { current: Scene; canUndo: boolean; canRedo: boolean }
    text: DomTextAdapter
    enterReadOnly: (message: string) => void
    applyRecords: (scene: Scene) => void
  }
  const scene = () => internals.snapshot()
  const rec = (id: string) => scene().objects.find((o) => o.id === id) as TextRecord | undefined
  const session = (): EditSession => {
    const s = internals.text instanceof DomTextAdapter ? internals.text.editSession() : null
    if (!s) throw new Error('no text is being edited')
    return s
  }
  /** Types at the selection, as the view's input does (through the session). */
  const type = (text: string) => session().run((state, dispatch) => (dispatch?.(state.tr.insertText(text)), true))
  const handlers = (name: string) => ((canvas as unknown as { handlers: Map<string, unknown[]> }).handlers.get(name) ?? []).length
  return { editor, store, canvas, obj, scene, rec, internals, session, type, handlers }
}

const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
const flush = () => vi.advanceTimersByTimeAsync(10_000)
const microtasks = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // jsdom lays nothing out: the few layout calls the view makes (scrolling the caret into view, a point to a position) find nothing.
  const none = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  const zero = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect
  Object.defineProperty(Range.prototype, 'getClientRects', { value: none, configurable: true })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { value: zero, configurable: true })
  Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true })
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
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects
  delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
  delete (document as { elementFromPoint?: unknown }).elementFromPoint
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('entering and leaving an edit on the DOM renderer', () => {
  it('a new text is edited in its card: the view mounted, the canvas and the items in front out of the way, handles hidden; Esc puts everything back and discards it blank, with no step and no save', async () => {
    const { editor, canvas, internals, store } = await open([], [txt('front', 0, 0, { text: 'in front' }), img('locked', 0, 0, { locked: true })])
    editor.addText()
    const edited = internals.text.editedTarget() as unknown as FakeObject
    expect(edited).not.toBeNull()
    expect(editor.getState().editingText).toBe(true)
    const id = idOf(edited as never)!
    const card = host.querySelector(`.scene-layer [data-id="${id}"]`) as HTMLElement
    const body = card.firstElementChild as HTMLElement
    expect(card.classList.contains('is-editing')).toBe(true)
    expect(body.getAttribute('contenteditable')).toBe('true') // (jsdom has no isContentEditable)
    expect(document.activeElement).toBe(body)
    expect(canvas.wrapperEl.style.pointerEvents).toBe('none')
    expect((edited as unknown as { hasControls: boolean }).hasControls).toBe(false)
    // The new text is the front-most item: nothing covers it.
    expect(host.querySelectorAll('.is-covering')).toHaveLength(0)
    body.dispatchEvent(key('Escape'))
    expect(editor.getState().editingText).toBe(false)
    expect(body.getAttribute('contenteditable')).toBeNull()
    expect(card.classList.contains('is-editing')).toBe(false)
    expect(canvas.wrapperEl.style.pointerEvents).toBe('')
    expect((edited as unknown as { hasControls: boolean }).hasControls).toBe(true)
    expect(canvas.getActiveObject()).toBeNull() // out of the selection at once
    expect(canvas.objects).toContain(edited) // off the canvas only once the editor has finished with it
    await microtasks()
    expect(canvas.objects).not.toContain(edited)
    expect(internals.history.canUndo).toBe(false)
    await flush()
    expect(store.saves.flatMap((s) => s.doc.objects.map((o) => o.id))).not.toContain(id)
  })

  it('the unlocked items in front of an edited text take presses while it is edited; a locked one does not', async () => {
    const { editor, obj, canvas } = await open([], [txt('t', 0, 0), img('i', 10, 10), img('l', 20, 20, { locked: true })])
    canvas.setActiveObject(obj('t'))
    ;(editor as unknown as { text: DomTextAdapter }).text.startEditing(obj('t') as never)
    expect([...host.querySelectorAll('.is-covering')].map((e) => (e as HTMLElement).dataset.id)).toEqual(['i'])
    editor.setTool('select')
    expect(host.querySelectorAll('.is-covering')).toHaveLength(0)
  })

  it('typing changes the card data and sizes the proxy at once, is saved as it happens, and is one board step when the edit ends', async () => {
    const { editor, canvas, obj, rec, type, internals, store, session } = await open([], [txt('t', 0, 0, { text: 'one' })])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    expect(obj('t').height).toBe(25)
    type('\n')
    type('two')
    expect(rec('t')!.text).toBe('one\ntwo')
    expect(obj('t').height).toBe(50) // flush point 3: before anything is saved
    expect(internals.history.canUndo).toBe(false) // history is recorded when the edit ends
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toMatchObject({ text: 'one\ntwo' })
    // In-edit undo, from the editor's own Undo: the edit stays open.
    expect(editor.getState().canUndo).toBe(true)
    editor.undo()
    expect(editor.getState().editingText).toBe(true)
    expect(session().content().text).toBe('one')
    editor.redo()
    expect(session().content().text).toBe('one\ntwo')
    editor.setTool('select') // leaves the edit
    expect(editor.getState().editingText).toBe(false)
    expect(internals.history.current.objects[0]).toMatchObject({ text: 'one\ntwo' })
    editor.undo()
    expect(rec('t')!.text).toBe('one')
  })

  it('a new text`s owner is decided when it is made and once more when its first edit ends; an existing text keeps its owner whatever its typing does', async () => {
    const { editor, canvas, obj, rec, type, internals } = await open([F('F', 0, 0, 400, 40)], [txt('e', 10, 0, { frameId: 'F', text: 'in' })])
    canvas.setActiveObject(obj('e'))
    internals.text.startEditing(obj('e') as never, 'end')
    type('\na\nb\nc')
    editor.setTool('select')
    expect(rec('e')!.frameId).toBe('F') // existing: kept
    // A new text in the frame's top band grows below it: loose once its edit ends.
    ;(editor as unknown as { addTextAt: (p: { x: number; y: number }, a: string) => void }).addTextAt({ x: 10, y: 2 }, 'top-left')
    const made = internals.text.editedTarget()!
    const id = idOf(made as never)!
    expect((made as unknown as { frameId?: string }).frameId ?? rec(id)?.frameId).toBeUndefined() // blank: out of the scene so far
    type('x')
    expect(rec(id)!.frameId).toBe('F') // decided at creation, saved as it is typed
    type('\nsecond\nthird')
    expect(rec(id)!.frameId).toBe('F')
    editor.setTool('select')
    expect(rec(id)!.frameId).toBeUndefined()
  })

  it('a text emptied mid-edit is out of the scene; leaving it discards it as one step, and undo brings it back', async () => {
    const { editor, canvas, obj, rec, internals, session } = await open([], [txt('t', 0, 0, { text: 'gone' })])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    session().run((state, dispatch) => (dispatch?.(state.tr.delete(1, state.doc.content.size - 1)), true))
    expect(rec('t')).toBeUndefined()
    editor.setTool('select')
    await microtasks()
    expect(canvas.objects.some((o) => idOf(o as never) === 't')).toBe(false)
    expect(internals.history.canUndo).toBe(true)
    editor.undo()
    expect(rec('t')!.text).toBe('gone')
  })
})

describe('what ends an edit without committing', () => {
  it('the board going read-only: the typed text stays shown, nothing is recorded or saved', async () => {
    const { canvas, obj, type, internals, store } = await open([], [txt('t', 0, 0, { text: 'kept' })])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    type('!')
    internals.enterReadOnly('another tab changed it')
    expect(internals.text.editedTarget()).toBeNull()
    expect(host.querySelector('[data-id="t"] .scene-text-body')!.textContent).toBe('kept!')
    expect(internals.history.canUndo).toBe(false)
    const saved = store.saves.length
    await flush()
    expect(store.saves.length).toBe(saved)
    // Nothing starts an edit on a read-only board.
    internals.text.startEditing(obj('t') as never)
    expect(internals.text.editedTarget()).toBeNull()
  })

  it('records applied mid-edit (undo, redo, a cancelled gesture): the session ends, nothing is recorded', async () => {
    const { canvas, obj, type, internals, scene } = await open([], [txt('t', 0, 0, { text: 'base' })])
    const before = scene()
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    type(' more')
    internals.applyRecords(before)
    expect(internals.text.editedTarget()).toBeNull()
    expect(internals.history.canUndo).toBe(false)
    expect(scene()).toEqual(before)
  })

  it('dispose mid-edit ends the session and schedules no save', async () => {
    const { editor, canvas, obj, type, internals, store } = await open([], [txt('t', 0, 0)])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    type('x')
    const saved = store.saves.length
    editor.dispose()
    await flush()
    expect(store.saves.length).toBe(saved)
  })

  it('an edited text that stops being the selected object leaves its edit (as a Fabric text box does when deselected)', async () => {
    const { canvas, obj, type, internals, rec } = await open([], [txt('t', 0, 0, { text: 'a' }), img('i', 300, 300)])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    type('b')
    canvas.setActiveObject(obj('i'))
    expect(internals.text.editedTarget()).toBeNull()
    expect(internals.history.current.objects.find((o) => o.id === 't')).toMatchObject({ text: 'ab' })
    expect(rec('t')!.text).toBe('ab')
  })
})

describe('keys and commands while editing on the DOM renderer', () => {
  it('Esc ends the edit and the canvas does not see it: the text stays selected', async () => {
    const { editor, canvas, obj, internals } = await open([], [txt('t', 0, 0)])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never)
    internals.text.editedRoot()!.dispatchEvent(key('Escape'))
    expect(editor.getState().editingText).toBe(false)
    expect(canvas.getActiveObject()).toBe(obj('t'))
    // A later Esc reaches the canvas as usual.
    window.dispatchEvent(key('Escape'))
    expect(canvas.getActiveObject()).toBeNull()
  })

  it('Ctrl/Cmd+B toggles bold once (the session and the window listener do not both act)', async () => {
    const { canvas, obj, internals, session } = await open([], [txt('t', 0, 0, { text: 'abc' })])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    session().select(0, 3)
    internals.text.editedRoot()!.dispatchEvent(key('b', { ctrlKey: true }))
    expect(session().content()).toMatchObject({ text: 'abc', spans: [{ start: 0, end: 3, bold: true }] })
  })

  it('Ctrl/Cmd+Z with nothing to undo in the edit is kept from the browser', async () => {
    const { canvas, obj, internals } = await open([], [txt('t', 0, 0)])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never)
    const e = key('z', { ctrlKey: true })
    internals.text.editedRoot()!.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(true)
  })

  it('the font size while editing is a step of its own, as on the Fabric renderer, and ends "straight after a shortcut"', async () => {
    const { editor, canvas, obj, internals, session, rec } = await open([], [txt('t', 0, 0, { text: 'go' })])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    expect(session().handleTextInput(3, 3, ' ')).toBe(false) // a plain character: ProseMirror's own path
    session().run((state, dispatch) => (dispatch?.(state.tr.insertText(' *x')), true))
    session().handleKeyDown(key('*', { target: undefined } as never))
    editor.setFontSize(30)
    expect(rec('t')!.fontSize).toBe(30)
    expect(internals.history.canUndo).toBe(true)
    expect(session().canRevertShortcut).toBe(false)
    expect(editor.getState().editingText).toBe(true)
  })

  it('formatting while editing acts on the range through the session and is saved, not recorded, until the edit ends', async () => {
    const { editor, canvas, obj, internals, session, rec } = await open([], [txt('t', 0, 0, { text: 'abc' })])
    canvas.setActiveObject(obj('t'))
    internals.text.startEditing(obj('t') as never, 'end')
    session().select(1, 2)
    editor.toggleMark('italic')
    editor.setTextAlign('center')
    expect(rec('t')).toMatchObject({ align: 'center', spans: [{ start: 1, end: 2, italic: true }] })
    expect(editor.getState().selection?.text).toMatchObject({ editing: true, align: 'center', marks: { italic: 'on' } })
    expect(internals.history.canUndo).toBe(false)
    editor.undo() // the range mark only: alignment is a whole-box setting, not a step of in-edit undo
    expect(rec('t')).toMatchObject({ align: 'center' })
    expect(rec('t')!.spans).toBeUndefined()
  })
})

describe('a release on the selected text starts editing, as a Fabric text box does', () => {
  const pressRelease = (canvas: ReturnType<typeof canvasOf>, target: FakeObject, opts: { alreadySelected: boolean; moved?: boolean }) => {
    const e = new MouseEvent('mousedown', { button: 0, clientX: 5, clientY: 5 })
    canvas.fire('mouse:down', { e, target, alreadySelected: opts.alreadySelected })
    canvas.fire('mouse:up', { e: new MouseEvent('mouseup', { button: 0, clientX: 5, clientY: 5 }), target, transform: opts.moved ? { actionPerformed: true } : null })
  }

  it('only a press on the text already selected, not moved, starts it, once the release has been handled', async () => {
    const { canvas, obj, internals } = await open([], [txt('t', 0, 0), txt('l', 300, 0, { locked: true })])
    pressRelease(canvas, obj('t'), { alreadySelected: false })
    await microtasks()
    expect(internals.text.editedTarget()).toBeNull()
    canvas.setActiveObject(obj('t'))
    pressRelease(canvas, obj('t'), { alreadySelected: true, moved: true })
    await microtasks()
    expect(internals.text.editedTarget()).toBeNull()
    pressRelease(canvas, obj('t'), { alreadySelected: true })
    expect(internals.text.editedTarget()).toBeNull() // not inside Fabric's handling
    await microtasks()
    expect(internals.text.editedTarget()).toBe(obj('t'))
    // A locked text never.
    internals.text.finishEditing()
    canvas.setActiveObject(obj('l'))
    pressRelease(canvas, obj('l'), { alreadySelected: true })
    await microtasks()
    expect(internals.text.editedTarget()).toBeNull()
  })

  it('a press on one of its handles does not arm it (a side handle that could not narrow the box any more); an armed text stays armed until it is deselected', async () => {
    const { canvas, obj, internals } = await open([], [txt('t', 0, 0), txt('o', 300, 0)])
    const t = obj('t') as unknown as FakeObject & { __corner?: string }
    canvas.setActiveObject(t)
    t.__corner = 'mr' // Fabric found a handle under the press
    canvas.fire('mouse:down', { e: new MouseEvent('mousedown', { button: 0 }), target: t, alreadySelected: true })
    t.__corner = undefined // and none under the release (the handle did not move)
    canvas.fire('mouse:up', { e: new MouseEvent('mouseup', { button: 0 }), target: t, transform: { actionPerformed: false } })
    await microtasks()
    expect(internals.text.editedTarget()).toBeNull()
    // Armed by a press on the text itself that became a drag, then released again without one: editing.
    canvas.fire('mouse:down', { e: new MouseEvent('mousedown', { button: 0 }), target: t, alreadySelected: true })
    canvas.fire('mouse:up', { e: new MouseEvent('mouseup', { button: 0 }), target: t, transform: { actionPerformed: true } })
    await microtasks()
    expect(internals.text.editedTarget()).toBeNull()
    canvas.fire('mouse:up', { e: new MouseEvent('mouseup', { button: 0 }), target: t, transform: null })
    await microtasks()
    expect(internals.text.editedTarget()).toBe(t)
    // Deselected: no longer armed.
    internals.text.finishEditing()
    canvas.setActiveObject(obj('o'))
    canvas.setActiveObject(t)
    canvas.fire('mouse:up', { e: new MouseEvent('mouseup', { button: 0 }), target: t, transform: null })
    await microtasks()
    expect(internals.text.editedTarget()).toBeNull()
  })

  it('a real drag of the selected text does not start an edit', async () => {
    const { canvas, obj, internals } = await open([], [txt('t', 0, 0)])
    canvas.setActiveObject(obj('t'))
    const t = press(canvas, obj('t'))
    dragBy(canvas, t, 30, 0)
    release(canvas, t)
    await microtasks()
    expect(internals.text.editedTarget()).toBeNull()
  })
})

describe('the Fabric renderer binds none of this', () => {
  it('no live-editing listener on the canvas, no edit history of its own', async () => {
    const fabric = await open([], [txt('t', 0, 0)], {})
    const domEditor = await open([], [txt('t', 0, 0)])
    expect(['mouse:down', 'mouse:up', 'mouse:dblclick', 'selection:cleared', 'selection:updated'].map((n) => fabric.handlers(n))).toEqual([2, 1, 1, 1, 1])
    expect(['mouse:down', 'mouse:up', 'mouse:dblclick', 'selection:cleared', 'selection:updated'].map((n) => domEditor.handlers(n))).toEqual([3, 2, 2, 2, 2])
    const t = fabric.internals.text as unknown as { stepEdit: (d: string) => boolean; editHistory: () => unknown }
    expect(t.stepEdit('undo')).toBe(false)
    expect(t.editHistory()).toBeNull()
  })
})

describe("Fabric 7.4's double-click word", () => {
  it('stops at spaces, line breaks and . , ; ! ? -', () => {
    const g = (s: string) => Array.from(s)
    expect(fabricWordAt(g('state-of-the-art now'), 7)).toEqual({ start: 6, end: 8 })
    expect(fabricWordAt(g('one two'), 1)).toEqual({ start: 0, end: 3 })
    expect(fabricWordAt(g('one two'), 3)).toEqual({ start: 0, end: 3 })
    expect(fabricWordAt(g('a.b'), 2)).toEqual({ start: 2, end: 3 })
    expect(fabricWordAt(g('x'), 1)).toEqual({ start: 1, end: 1 })
  })
})
