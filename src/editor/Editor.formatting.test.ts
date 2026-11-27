import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, ImageRecord, TextRecord } from '../model/types.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { canvasOf, dragBy, press, release, tick } from './testing/drive.ts'
import type { Canvas, Textbox } from './testing/fakeFabric.ts'
import { ActiveSelection } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore, deferred } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

type Styles = Record<number, Record<number, Record<string, unknown>>>
type Tb = Textbox & { styles: Styles; hiddenTextarea?: HTMLTextAreaElement | null }

const text = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 't', left: 100, top: 100, angle: 0, text: 'plain words', fontSize: 20, width: 300, ...patch })
const image: ImageRecord = { type: 'image', id: 'img', left: 600, top: 100, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 }
const frame: FrameRecord = { id: 'F', name: 'Spread', left: 0, top: 0, width: 500, height: 400 }

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })

async function setup(objects: BoardDoc['objects'] = [text()], frames: FrameRecord[] = [], opts: { load?: boolean } = {}) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Fmt', frames, objects }
  const bytes = new Uint8Array([1, 2, 3]).buffer
  const store = new SpyStore({ doc, assets: new Map([['a1', { id: 'a1', name: 'a1.png', type: 'image/png', bytes }]]) })
  store.holdLoad = opts.load === false
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  const ready = editor.init()
  if (opts.load !== false) await ready
  const canvas = canvasOf(editor)
  const tb = canvas.objects.find((o) => (o as { text?: unknown }).text !== undefined) as Tb
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects
  const rec = (id = 't') => scene().find((o) => o.id === id) as TextRecord
  const saved = (id = 't') => store.saves.at(-1)?.doc.objects.find((o) => o.id === id) as TextRecord | undefined
  return { editor, store, canvas, tb, scene, rec, saved, ready }
}

/** Enters editing with the given selection (graphemes, one per line break), as a double-click and a drag would leave it. */
function edit(canvas: Canvas, tb: Tb, start: number, end = start) {
  canvas.setActiveObject(tb)
  tb.enterEditing()
  tb.selectionStart = start
  tb.selectionEnd = end
  canvas.fire('text:selection:changed', { target: tb })
}
/** The caret or range moves for a reason other than typing. */
function moveSelection(canvas: Canvas, tb: Tb, start: number, end = start) {
  tb.selectionStart = start
  tb.selectionEnd = end
  canvas.fire('text:selection:changed', { target: tb })
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
  document.querySelectorAll('textarea').forEach((t) => t.remove())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('formatting a selected box (not being edited)', () => {
  it('each command is its own undo step at once, saved, and undo and redo restore it exactly', async () => {
    const { editor, store, canvas, tb, rec, saved } = await setup()
    canvas.setActiveObject(tb)
    editor.toggleMark('bold')
    expect(rec()).toEqual(text({ spans: [{ start: 0, end: 11, bold: true }] }))
    editor.setTextFont('serif')
    editor.setTextAlign('center')
    editor.setTextColor('#D92D20') // stored lower case
    editor.setHeading(2)
    const all = text({ font: 'serif', align: 'center', color: '#d92d20', headings: [2] }) // bold is implied by the heading
    expect(rec()).toStrictEqual(all)
    await flush()
    expect(saved()).toStrictEqual(all)
    expect(tb.fontFamily).toContain('Georgia')
    expect(tb.textAlign).toBe('center')
    expect(tb.fill).toBe('#d92d20')

    for (let i = 0; i < 5; i++) editor.undo()
    expect(rec()).toStrictEqual(text())
    expect(editor.getState().canUndo).toBe(false)
    for (let i = 0; i < 5; i++) editor.redo()
    expect(rec()).toStrictEqual(all)
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(all)
  })

  it('a whole-box mark is on unless every character already has it', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ spans: [{ start: 0, end: 5, italic: true }] })])
    canvas.setActiveObject(tb)
    editor.toggleMark('italic')
    expect(rec().spans).toEqual([{ start: 0, end: 11, italic: true }])
    editor.toggleMark('italic')
    expect(rec().spans).toBeUndefined()
  })

  it('a command that changes nothing records nothing and saves nothing', async () => {
    const { editor, store, canvas, tb } = await setup([text({ text: 'Title', headings: [1], font: 'mono' })])
    canvas.setActiveObject(tb)
    editor.toggleMark('bold') // a heading is bold already
    editor.setTextFont('mono')
    editor.setTextAlign('left')
    editor.setTextColor('#1d2230') // the default ink, which the text has
    editor.setHeading(1)
    await flush()
    expect(store.saves).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('quick repeats of the same kind on the same text coalesce into one step, like the font size', async () => {
    const { editor, canvas, tb, rec } = await setup()
    canvas.setActiveObject(tb)
    editor.setTextFont('serif')
    editor.setTextFont('mono')
    editor.setTextFont('hand')
    expect(rec().font).toBe('hand')
    editor.undo()
    expect(rec().font).toBeUndefined()
    expect(editor.getState().canUndo).toBe(false)
  })

  it('never changes ownership: an owned text stays owned (even with its centre outside), a loose one inside a frame stays loose', async () => {
    const owned = text({ id: 'o', left: 450, top: 380, frameId: 'F' }) // centre outside the frame
    const loose = text({ id: 'l', left: 50, top: 50 }) // inside the frame, not owned
    const { editor, canvas, rec } = await setup([owned, loose], [frame])
    const [o, l] = canvas.objects.slice(1) as Tb[] // after the frame
    canvas.setActiveObject(o!)
    editor.setHeading(1)
    editor.setTextFont('display')
    canvas.setActiveObject(l!)
    editor.toggleMark('underline')
    editor.setTextAlign('right')
    expect(rec('o')).toStrictEqual({ ...owned, headings: [1], font: 'display' })
    expect(rec('o').frameId).toBe('F')
    expect(rec('l')).not.toHaveProperty('frameId')
    expect(rec('l').spans).toEqual([{ start: 0, end: 11, underline: true }])
  })

  it('a drag cancelled with Esc after formatting restores the formatted box', async () => {
    const { editor, canvas, tb, rec } = await setup()
    canvas.setActiveObject(tb)
    editor.toggleMark('strike')
    const t = press(canvas, tb)
    dragBy(canvas, t, 40, 0)
    editor.handleKeyDown(key('Escape'))
    expect(rec()).toStrictEqual(text({ spans: [{ start: 0, end: 11, strike: true }] }))
    release(canvas, t)
    await tick()
  })
})

describe('formatting while a text is being edited', () => {
  it('a mark on the selected range is saved as it happens and becomes one undo step when the edit ends, with no object:modified', async () => {
    const { editor, store, canvas, tb, rec, saved } = await setup()
    edit(canvas, tb, 6, 11) // "words"
    editor.toggleMark('bold')
    expect(tb.isEditing).toBe(true) // the edit goes on
    expect([tb.selectionStart, tb.selectionEnd]).toEqual([6, 11]) // with its range
    expect(editor.getState().canUndo).toBe(false) // no history yet
    await flush() // the typing save, mid-edit
    const bold = text({ spans: [{ start: 6, end: 11, bold: true }] })
    expect(saved()).toStrictEqual(bold)
    const modified = vi.fn()
    canvas.on('object:modified', modified)
    tb.exitEditing() // the text did not change: Fabric fires no object:modified
    expect(modified).not.toHaveBeenCalled()
    expect(editor.getState().canUndo).toBe(true)
    editor.undo()
    expect(rec()).toStrictEqual(text())
    expect(editor.getState().canUndo).toBe(false)
    editor.redo()
    expect(rec()).toStrictEqual(bold)
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(bold)
  })

  it('typing and formatting in one edit are one step', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb, 0, 5)
    editor.toggleMark('italic')
    tb.type('plain words!', 12)
    editor.setTextColor('#2b8a3e')
    tb.exitEditing()
    expect(rec()).toStrictEqual(text({ text: 'plain words!', color: '#2b8a3e', spans: [{ start: 0, end: 5, italic: true }] }))
    editor.undo()
    expect(rec()).toStrictEqual(text())
    expect(editor.getState().canUndo).toBe(false)
  })

  for (const [how, leave, ownSteps] of [
    ['clicking elsewhere (deselecting)', (_e: Editor, c: Canvas) => c.discardActiveObject(), 0],
    ['a tool switch', (e: Editor) => e.setTool('hand'), 0],
    ['a non-formatting panel button (bring to front, a step of its own)', (e: Editor) => e.arrange('front'), 1],
    // Fabric leaves the edit, then selects the other object (the fake does not do the first by itself).
    [
      'selecting another object',
      (_e: Editor, c: Canvas) => {
        ;(c.getActiveObject() as Tb).exitEditing()
        c.setActiveObject(c.objects.find((o) => !('text' in o))!)
      },
      0,
    ],
  ] as const) {
    it(`a formatting-only edit left by ${how} commits exactly one step`, async () => {
      const { editor, canvas, tb, rec } = await setup([text(), image])
      edit(canvas, tb, 0, 5)
      editor.toggleMark('underline')
      editor.setHeading(3)
      leave(editor, canvas)
      await tick()
      expect(tb.isEditing).toBe(false)
      const formatted = text({ headings: [3], spans: [{ start: 0, end: 5, underline: true }] })
      expect(rec()).toStrictEqual(formatted)
      for (let i = 0; i < ownSteps; i++) editor.undo()
      expect(rec()).toStrictEqual(formatted)
      editor.undo()
      expect(rec()).toStrictEqual(text())
      expect(editor.getState().canUndo).toBe(false)
    })
  }

  it('the undo button straight after a formatting-only edit commits the edit, then undoes exactly it', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb, 0, 11)
    editor.toggleMark('bold')
    editor.undo()
    expect(rec()).toStrictEqual(text())
    expect(editor.getState().canRedo).toBe(true)
    editor.redo()
    expect(rec()).toStrictEqual(text({ spans: [{ start: 0, end: 11, bold: true }] }))
  })

  it('headings: the caret line, the lines a range touches, and back to body text', async () => {
    const t3 = text({ text: 'one\ntwo\nthree' })
    const { editor, canvas, tb, rec } = await setup([t3])
    edit(canvas, tb, 5) // in "two"
    editor.setHeading(1)
    expect(rec().headings).toEqual([0, 1])
    moveSelection(canvas, tb, 2, 9) // "e\ntwo\nt"
    editor.setHeading(2)
    expect(rec().headings).toEqual([2, 2, 2])
    moveSelection(canvas, tb, 4, 7)
    editor.setHeading(0)
    expect(rec().headings).toEqual([2, 0, 2])
    tb.exitEditing()
    canvas.setActiveObject(tb)
    editor.setHeading(3)
    expect(rec().headings).toEqual([3, 3, 3])
  })

  it('font applies to the range, alignment and colour to the box; the edit and its range go on', async () => {
    const { editor, store, canvas, tb, saved } = await setup()
    edit(canvas, tb, 2, 4)
    editor.setTextFont('mono')
    editor.setTextAlign('right')
    editor.setTextColor('#ffffff')
    expect(tb.isEditing).toBe(true)
    expect([tb.selectionStart, tb.selectionEnd]).toEqual([2, 4])
    await flush()
    expect(saved()).toStrictEqual(text({ spans: [{ start: 2, end: 4, font: 'mono' }], align: 'right', color: '#ffffff' }))
    expect(store.saves).toHaveLength(1)
    tb.exitEditing()
  })

  it('alignment keeps the box where it is; a box that changes size keeps its alignment edge', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ align: 'right' })])
    canvas.setActiveObject(tb)
    editor.setTextAlign('center')
    expect(rec()).toMatchObject({ left: 100, width: 300 })
    // The fake does not lay text out: grow the box as Fabric would for a wider font, and check
    // that a centred box grows about its centre.
    const set = tb.set.bind(tb)
    tb.set = (patch: Record<string, unknown>) => {
      set(patch)
      if ('fontFamily' in patch) tb.width = 340
      return tb
    }
    editor.setTextFont('display')
    expect(rec()).toMatchObject({ left: 80, width: 340, font: 'display', align: 'center' })
  })

  it('formatting while a save is in flight is stored by the next save', async () => {
    const { editor, store, canvas, tb } = await setup()
    edit(canvas, tb, 0, 5)
    store.saveGate = deferred<void>()
    tb.type('plain words.', 12)
    await vi.advanceTimersByTimeAsync(600) // the save starts and is held
    expect(store.attempts).toHaveLength(1)
    moveSelection(canvas, tb, 0, 5)
    editor.toggleMark('bold')
    store.saveGate.resolve()
    store.saveGate = null
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(text({ text: 'plain words.', spans: [{ start: 0, end: 5, bold: true }] }))
    tb.exitEditing()
  })

  it('a blank text being typed into: formatting saves nothing, records nothing, and leaving it records no removal', async () => {
    const { editor, store, canvas, rec } = await setup()
    editor.addText()
    const blank = canvas.objects.at(-1) as Tb
    expect(blank.isEditing).toBe(true)
    blank.selectionStart = blank.selectionEnd = 0
    editor.setHeading(1)
    editor.setTextFont('serif')
    editor.toggleMark('bold')
    await flush()
    expect(store.saves).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
    blank.exitEditing()
    await tick()
    await flush()
    expect(store.saves).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
    expect(rec()).toStrictEqual(text())
  })

  it('an existing text emptied mid-edit and then formatted is not removed by the command', async () => {
    const { editor, store, canvas, tb, scene } = await setup()
    edit(canvas, tb, 0, 11)
    tb.type('', 0)
    await flush()
    const before = store.saves.length
    editor.setHeading(2)
    await flush()
    expect(store.saves).toHaveLength(before) // nothing to save: a blank text is not in the scene
    expect(editor.getState().canUndo).toBe(false) // and no "text removed" step while it is typed into
    tb.type('back', 4)
    tb.exitEditing()
    expect(scene()[0]).toStrictEqual(text({ text: 'back', headings: [2] }))
  })

  it('the board going read-only mid-edit: what was formatted is not committed, and commands do nothing after', async () => {
    const { editor, store, canvas, tb } = await setup()
    edit(canvas, tb, 0, 5)
    store.saveError = new BoardConflictError()
    editor.toggleMark('bold')
    await flush()
    expect(editor.getState().readOnly).not.toBeNull()
    expect(tb.isEditing).toBe(false)
    expect(editor.getState().canUndo).toBe(false)
    const styles = JSON.stringify(tb.styles)
    canvas.setActiveObject(tb)
    editor.toggleMark('italic')
    editor.setTextFont('mono')
    editor.setHeading(1)
    expect(JSON.stringify(tb.styles)).toBe(styles)
    expect(tb.fontFamily).not.toContain('Consolas')
    store.saveError = null
    await flush()
    expect(store.saves).toHaveLength(0)
  })
})

describe('marks with only a caret (pending)', () => {
  it('apply to what is typed next, without saving or recording anything by themselves', async () => {
    const { editor, store, canvas, tb, rec } = await setup()
    edit(canvas, tb, 5) // after "plain"
    editor.toggleMark('bold')
    editor.toggleMark('italic')
    expect(editor.getState().selection?.text?.marks).toMatchObject({ bold: 'on', italic: 'on' })
    await flush()
    expect(store.saves).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
    tb.type('plainXY words', 7) // Fabric gives the typed characters no style here (nothing to copy)
    expect(rec().spans).toEqual([{ start: 5, end: 7, bold: true, italic: true }])
    tb.exitEditing()
    expect(rec()).toStrictEqual(text({ text: 'plainXY words', spans: [{ start: 5, end: 7, bold: true, italic: true }] }))
  })

  it('a pending "off" next to a bold character types plain text, whatever style Fabric copied', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ text: 'ab', spans: [{ start: 0, end: 2, bold: true }] })])
    edit(canvas, tb, 2)
    expect(editor.getState().selection?.text?.marks.bold).toBe('on') // typing here would be bold
    editor.toggleMark('bold')
    expect(editor.getState().selection?.text?.marks.bold).toBe('off')
    const b = { fontWeight: 'bold' }
    tb.styles = { 0: { 0: b, 1: b, 2: b } } // Fabric copied the bold of "b" onto the typed "c"
    tb.type('abc', 3)
    expect(rec().spans).toEqual([{ start: 0, end: 2, bold: true }])
    expect(tb.styles).toEqual({ 0: { 0: b, 1: b } })
    tb.exitEditing()
  })

  it('last through every step of an IME composition, and are dropped when the caret moves or the edit ends', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ text: 'ab' })])
    edit(canvas, tb, 2)
    editor.toggleMark('underline')
    tb.type('abk', 3) // composition steps: the text changes, the caret moves with it, no selection event
    tb.type('abka', 4)
    tb.type('abカ', 3)
    expect(rec().spans).toEqual([{ start: 2, end: 3, underline: true }])
    moveSelection(canvas, tb, 0) // an arrow key: the choice is dropped
    await tick()
    expect(editor.getState().selection?.text?.marks.underline).toBe('off')
    tb.styles = { 0: { 3: { underline: true } } } // Fabric shifts the styles along with the text
    tb.type('Zabカ', 1)
    expect(rec().spans).toEqual([{ start: 3, end: 4, underline: true }])
    moveSelection(canvas, tb, 4)
    editor.toggleMark('strike')
    expect(editor.getState().selection?.text?.marks.strike).toBe('on')
    tb.exitEditing()
    edit(canvas, tb, 4)
    await tick()
    expect(editor.getState().selection?.text?.marks.strike).toBe('off') // dropped when the edit ended
    tb.styles = { 0: { 3: { underline: true }, 4: { underline: true } } } // and copies the underline of the character before
    tb.type('Zabカ!', 5)
    expect(rec().spans).toEqual([{ start: 3, end: 5, underline: true }]) // no strikethrough
    tb.exitEditing()
  })

  it('bold on a heading line cannot be pending: shown pressed, and the command does nothing', async () => {
    const { editor, store, canvas, tb } = await setup([text({ text: 'Title', headings: [1] })])
    edit(canvas, tb, 5)
    expect(editor.getState().selection?.text).toMatchObject({ boldFromHeading: true, marks: { bold: 'on' } })
    editor.toggleMark('bold')
    expect(editor.getState().selection?.text?.marks.bold).toBe('on')
    tb.exitEditing()
    await flush()
    expect(store.saves).toHaveLength(0)
  })
})

describe('guards', () => {
  it('before the board has loaded, commands do nothing', async () => {
    const { editor, store, canvas, ready } = await setup([text()], [], { load: false })
    editor.toggleMark('bold')
    editor.setHeading(1)
    editor.setTextFont('serif')
    store.releaseLoad()
    await ready
    const tb = canvas.objects[0] as Tb
    expect(JSON.stringify(tb.styles)).toBe('{}')
    await flush()
    expect(store.saves).toHaveLength(0)
  })

  it('while a gesture is unsettled, commands and their keys do nothing', async () => {
    const { editor, store, canvas, tb, rec } = await setup()
    canvas.setActiveObject(tb)
    const t = press(canvas, tb)
    dragBy(canvas, t, 10, 0)
    editor.toggleMark('bold')
    editor.setTextAlign('center')
    const k = key('b', { ctrlKey: true })
    document.body.dispatchEvent(k)
    expect(k.defaultPrevented).toBe(true) // the held canvas gesture claims recognised shortcuts
    release(canvas, t)
    await tick()
    expect(rec()).toStrictEqual(text({ left: 110 }))
    await flush()
    expect(store.saves.at(-1)!.doc.objects[0]).toStrictEqual(text({ left: 110 }))
  })

  it('with no selection, an image, a frame or several objects, commands do nothing', async () => {
    const { editor, store, canvas, tb } = await setup([text(), image], [frame])
    const img = canvas.objects.find((o) => !('text' in o) && o !== canvas.objects[0])!
    for (const select of [() => canvas.discardActiveObject(), () => canvas.setActiveObject(img), () => canvas.setActiveObject(canvas.objects[0]!), () => canvas.setActiveObject(new ActiveSelection([tb, img]))]) {
      select()
      editor.toggleMark('bold')
      editor.setHeading(1)
      editor.setTextFont('serif')
      editor.setTextAlign('center')
      editor.setTextColor('#d92d20')
    }
    await flush()
    expect(store.saves).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
  })
})

describe('Ctrl/Cmd+B, I, U', () => {
  it('while editing: act on the range when the key comes from the edited text; other keys and modifiers are left alone', async () => {
    const { canvas, tb, rec } = await setup()
    const ta = document.body.appendChild(document.createElement('textarea'))
    edit(canvas, tb, 0, 5)
    tb.hiddenTextarea = ta
    const press = (k: string, init: KeyboardEventInit = {}, target: EventTarget = ta) => {
      const e = key(k, { ctrlKey: true, ...init })
      target.dispatchEvent(e)
      return e.defaultPrevented
    }
    expect(press('b')).toBe(true)
    expect(press('I', { ctrlKey: false, metaKey: true })).toBe(true) // Cmd, and Caps Lock
    expect(press('u')).toBe(true)
    expect(rec().spans).toEqual([{ start: 0, end: 5, bold: true, italic: true, underline: true }])
    expect(press('b', { altKey: true })).toBe(false)
    expect(press('b', { shiftKey: true })).toBe(false)
    expect(press('b', { isComposing: true } as KeyboardEventInit)).toBe(false)
    expect(press('a')).toBe(false) // select all inside the text stays Fabric's
    expect(press('z')).toBe(false) // as does the textarea's own undo
    expect(press('b', {}, document.body)).toBe(false) // not from the edited text
    expect(rec().spans).toEqual([{ start: 0, end: 5, bold: true, italic: true, underline: true }])
    tb.exitEditing()
  })

  it('with a caret they choose marks for what is typed next', async () => {
    const { canvas, tb, rec } = await setup()
    const ta = document.body.appendChild(document.createElement('textarea'))
    edit(canvas, tb, 11)
    tb.hiddenTextarea = ta
    ta.dispatchEvent(key('b', { ctrlKey: true }))
    tb.type('plain words!', 12)
    expect(rec().spans).toEqual([{ start: 11, end: 12, bold: true }])
    tb.exitEditing()
  })

  it('a selected text (not editing): the whole box; claimed only for one selected text', async () => {
    const { editor, canvas, tb, rec } = await setup([text(), image], [frame])
    const fire = () => {
      const e = key('b', { ctrlKey: true })
      document.body.dispatchEvent(e)
      return e.defaultPrevented
    }
    canvas.setActiveObject(tb)
    expect(fire()).toBe(true)
    expect(rec().spans).toEqual([{ start: 0, end: 11, bold: true }])
    const u = key('u', { metaKey: true })
    document.body.dispatchEvent(u)
    expect(u.defaultPrevented).toBe(true)
    expect(rec().spans).toEqual([{ start: 0, end: 11, bold: true, underline: true }])
    const img = canvas.objects.find((o) => !('text' in o) && o !== canvas.objects[0])!
    canvas.setActiveObject(img)
    expect(fire()).toBe(false)
    canvas.setActiveObject(canvas.objects[0]!) // the frame
    expect(fire()).toBe(false)
    canvas.setActiveObject(new ActiveSelection([tb, img]))
    expect(fire()).toBe(false)
    canvas.discardActiveObject()
    expect(fire()).toBe(false)
    expect(editor.getState().canUndo).toBe(true)
  })
})

describe('what the controls show', () => {
  it('a selected box: its font, alignment, colour, and each mark and heading over all of it', async () => {
    const rec = text({ text: 'Title\nbody', font: 'hand', align: 'right', color: '#7048e8', headings: [1], spans: [{ start: 6, end: 8, italic: true }] })
    const { editor, canvas, tb } = await setup([rec])
    canvas.setActiveObject(tb)
    expect(editor.getState().selection?.text).toStrictEqual({
      editing: false,
      font: 'hand',
      align: 'right',
      color: '#7048e8',
      marks: { bold: 'mixed', italic: 'mixed', underline: 'off', strike: 'off' },
      heading: 'mixed',
      boldFromHeading: false,
    })
    canvas.discardActiveObject()
    canvas.setActiveObject(canvas.objects[0]!)
    expect(editor.getState().selection?.text?.color).toBe('#7048e8')
  })

  it('a plain box shows the defaults; an image or several objects show no text controls', async () => {
    const { editor, canvas, tb } = await setup([text(), image])
    canvas.setActiveObject(tb)
    expect(editor.getState().selection?.text).toMatchObject({ font: 'sans', align: 'left', color: '#1d2230', heading: 0 })
    canvas.setActiveObject(canvas.objects[1]!)
    expect(editor.getState().selection?.text).toBeNull()
    canvas.setActiveObject(new ActiveSelection([tb, canvas.objects[1]!]))
    expect(editor.getState().selection?.text).toBeNull()
  })

  it('while editing: follows the range as it moves, after Fabric has stored it, without telling React about identical states', async () => {
    const { editor, canvas, tb } = await setup([text({ text: 'Title\nbody bold', headings: [1], spans: [{ start: 11, end: 15, bold: true }] })])
    edit(canvas, tb, 0, 5)
    await tick()
    expect(editor.getState().selection?.text).toMatchObject({ editing: true, heading: 1, boldFromHeading: true })
    const notified = vi.fn()
    editor.subscribe(notified)
    // Fabric fires the event before it stores the new value in some paths (IText.mjs _updateAndFire).
    canvas.fire('text:selection:changed', { target: tb })
    tb.selectionStart = 6
    tb.selectionEnd = 15
    await tick()
    expect(editor.getState().selection?.text).toMatchObject({ heading: 0, marks: { bold: 'mixed' }, boldFromHeading: false })
    expect(notified).toHaveBeenCalledTimes(1)
    moveSelection(canvas, tb, 7, 15) // the same state: no new snapshot
    moveSelection(canvas, tb, 8, 15)
    await tick()
    expect(notified).toHaveBeenCalledTimes(1)
    moveSelection(canvas, tb, 11, 15)
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('on')
    expect(notified).toHaveBeenCalledTimes(2)
    tb.exitEditing()
  })
})
