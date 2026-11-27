import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, TextRecord } from '../model/types.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { canvasOf, dragBy, press, release, tick } from './testing/drive.ts'
import type { Canvas, FakeObject } from './testing/fakeFabric.ts'
import { boardCanUndo, editSession, editedObject, selectText, startEditing, textAdapterOf } from './testing/editing.ts'
import { insert } from './testing/textHarness.ts'
import { isText, textDataOf } from './objects.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore, deferred, stubTextLayout } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The typing shortcuts in the editor, on the fake canvas with the text engine's real session and
 * view: what fires, the conversion and its revert, when the revert is no longer offered, history
 * and saving, and the guards. Keys are dispatched on the edited text's editable root (the view
 * hands them to the session, then they reach the editor's window listener); the character a key
 * types arrives as the view's input hands it to the session (jsdom has no input of its own). What
 * the browser really does is only accepted on real-browser evidence (e2e/typing.spec.ts).
 */

type Tb = FakeObject

const text = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 't', left: 100, top: 100, angle: 0, text: 'go', fontSize: 20, width: 300, ...patch })
const frame: FrameRecord = { id: 'F', name: 'Spread', left: 0, top: 0, width: 500, height: 400 }

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function setup(objects: BoardDoc['objects'] = [text()], frames: FrameRecord[] = []) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Typing', frames, objects }
  const store = new SpyStore({ doc, assets: new Map() })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets(), undefined, { measurer: new FakeCardMeasurer() })
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const tb = canvas.objects.find((o) => isText(o as never)) as Tb
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects
  const rec = (id = 't') => scene().find((o) => o.id === id) as TextRecord | undefined
  return { editor, store, canvas, tb, scene, rec }
}

/** The editor these tests built last (each test builds one), and the session of the text it edits. */
const current = () => editors.at(-1)!
const session = () => editSession(current())
/** The edited text's plain text. */
const textOf = () => session().content().text
/** Enters editing with the caret at `caret` (default: the end). */
function edit(canvas: Canvas, tb: Tb, caret?: number) {
  canvas.setActiveObject(tb)
  startEditing(current(), tb)
  selectText(current(), caret ?? textOf().length)
}
function selectEnd() {
  selectText(current(), textOf().length)
}
const keyEvent = (type: string, k: string, init: KeyboardEventInit = {}) => new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init })

/**
 * One key typed into the edited text, as the browser does it: the keydown on the editable root
 * (the view hands it to the session, then it reaches the editor's window listener), then, unless
 * it was prevented, the character arriving through the view's input (`handleTextInput`), then
 * the keyup. "\n" is Enter; Backspace is the editing key itself.
 */
function typeKey(_tb: Tb, ch: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const s = session()
  const root = textAdapterOf(current()).editedRoot()!
  const k = ch === '\n' ? 'Enter' : ch
  const down = keyEvent('keydown', k, init)
  root.dispatchEvent(down)
  if (!down.defaultPrevented && !init.ctrlKey && !init.metaKey && k.length === 1 && textAdapterOf(current()).editSession() === s) insert(s, ch, init.isComposing === true)
  root.dispatchEvent(keyEvent('keyup', k, init))
  return down
}
const typeKeys = (tb: Tb, s: string) => {
  for (const ch of s) typeKey(tb, ch)
}
const backspace = (tb: Tb) => typeKey(tb, 'Backspace')
const caretOf = () => {
  const { from, to } = session().selection()
  return { start: from, end: to }
}
const pendingOf = () => session().pending ?? {}

let restoreLayout = () => {}
beforeEach(() => {
  restoreLayout = stubTextLayout()
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
  restoreLayout()
  editors.splice(0).forEach((e) => e.dispose())
  host.remove()
  document.querySelectorAll('textarea').forEach((t) => t.remove())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a conversion', () => {
  it('bold: the markers go, the word is bold, the caret is after it, and what is typed next is plain', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' **bold*')
    expect(textOf()).toBe('go **bold*') // nothing fires at the first closing star
    typeKey(tb, '*')
    expect(textOf()).toBe('go bold')
    expect(rec()).toStrictEqual(text({ text: 'go bold', spans: [{ start: 3, end: 7, bold: true }] }))
    expect(caretOf()).toEqual({ start: 7, end: 7 })
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('off') // the next character is typed plain
    typeKey(tb, '!')
    expect(rec()?.spans).toEqual([{ start: 3, end: 7, bold: true }])
    textAdapterOf(current()).finishEditing()
  })

  it('italic, and a heading on an empty line, at the start of a line with text, and changing a level', async () => {
    const { canvas, tb, rec } = await setup([text({ text: 'one\nTitle\n', headings: [0, 3] })])
    edit(canvas, tb, 4) // start of "Title"
    typeKeys(tb, '## ')
    expect(textOf()).toBe('one\nTitle\n')
    expect(rec()?.headings).toEqual([0, 2])
    expect(caretOf()).toEqual({ start: 4, end: 4 })
    selectText(current(), 10) // the empty last line (as if typed there)
    typeKeys(tb, '# ')
    expect(rec()).toStrictEqual(text({ text: 'one\nTitle\n', headings: [0, 2, 1] }))
    typeKeys(tb, 'it is *so*')
    expect(rec()).toStrictEqual(text({ text: 'one\nTitle\nit is so', spans: [{ start: 16, end: 18, italic: true }], headings: [0, 2, 1] }))
    textAdapterOf(current()).finishEditing()
  })

  it('in a heading line `**x**` still fires: the markers go and no bold is stored', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ text: 'Big', headings: [1] })])
    edit(canvas, tb)
    typeKeys(tb, ' **x**')
    expect(rec()).toStrictEqual(text({ text: 'Big x', headings: [1] }))
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('on') // the heading's own, not a pending choice
    expect(session().pending).toBeNull()
    textAdapterOf(current()).finishEditing()
  })

  for (const s of ['2 * 3 * 4', 'a ** b', '* item', '**', 'snake*case*', '***x***', '#tag ', '#### ', 'a # ', '** x**', '*x *', '#x']) {
    it(`stays as typed: "${s}"`, async () => {
      const { canvas, tb, rec } = await setup([text({ text: 'x' })])
      edit(canvas, tb)
      typeKey(tb, '\n')
      typeKeys(tb, s)
      expect(textOf()).toBe(`x\n${s}`)
      textAdapterOf(current()).finishEditing()
      expect(rec()).toStrictEqual(text({ text: `x\n${s}` }))
    })
  }

  it('a heading line keeps its owner, and so does a text owned by a frame whose centre the heading moves out', async () => {
    const owned = text({ id: 't', frameId: 'F', left: 100, top: 360, text: 'x' })
    const { canvas, tb, rec } = await setup([owned], [frame])
    edit(canvas, tb)
    typeKeys(tb, '\n# Big heading')
    textAdapterOf(current()).finishEditing()
    expect(rec()?.frameId).toBe('F')
    expect(rec()?.headings).toEqual([0, 1])
  })
})

describe('Backspace straight after a conversion', () => {
  it('puts the literal characters back exactly (formatting and caret as before), deletes nothing, and the next Backspace deletes', async () => {
    const { canvas, tb, rec } = await setup([text({ text: 'go', spans: [{ start: 0, end: 2, underline: true }] })])
    edit(canvas, tb)
    typeKeys(tb, ' *it*')
    expect(rec()?.text).toBe('go it')
    const down = backspace(tb)
    expect(down.defaultPrevented).toBe(true)
    expect(textOf()).toBe('go *it*')
    expect(caretOf()).toEqual({ start: 7, end: 7 })
    // What was typed next to the underlined word is underlined, as typed.
    expect(rec()).toStrictEqual(text({ text: 'go *it*', spans: [{ start: 0, end: 7, underline: true }] }))
    typeKey(tb, '*') // typing on does not fire it again
    expect(textOf()).toBe('go *it**')
    expect(session().canRevertShortcut).toBe(false)
    backspace(tb)
    backspace(tb)
    expect(textOf()).toBe('go *it')
    textAdapterOf(current()).finishEditing()
  })

  it('a heading: the marker and the space come back, and the line its old level', async () => {
    const { canvas, tb, rec } = await setup([text({ text: 'x\nTitle', headings: [0, 3] })])
    edit(canvas, tb, 2)
    typeKeys(tb, '# ')
    expect(rec()?.headings).toEqual([0, 1])
    backspace(tb)
    expect(rec()).toStrictEqual(text({ text: 'x\n# Title', headings: [0, 3] }))
    expect(caretOf()).toEqual({ start: 4, end: 4 })
    textAdapterOf(current()).finishEditing()
  })

  it('pending marks come back as they were before it fired', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    editor.toggleMark('underline') // pending: what is typed next is underlined
    typeKeys(tb, ' *a*')
    expect(rec()?.spans).toEqual([{ start: 2, end: 3, underline: true }, { start: 3, end: 4, italic: true, underline: true }]) // the space was typed underlined too
    await tick()
    expect(editor.getState().selection?.text?.marks).toMatchObject({ italic: 'off', underline: 'on' })
    backspace(tb)
    expect(rec()?.spans).toEqual([{ start: 2, end: 6, underline: true }])
    await tick()
    expect(editor.getState().selection?.text?.marks).toMatchObject({ italic: 'off', underline: 'on' })
    textAdapterOf(current()).finishEditing()
  })

  const ways: Array<[string, (ctx: Awaited<ReturnType<typeof setup>> & { tb: Tb }) => void]> = [
    ['more typing', ({ tb }) => typeKey(tb, 'z')],
    ['a caret move (arrow key or click)', () => {
      selectText(current(), 1)
      selectEnd()
    }],
    ['a formatting command from the panel', ({ editor }) => editor.toggleMark('strike')],
    ['a heading command that changes nothing', ({ editor }) => editor.setHeading(0)],
    ['the font size field', ({ editor }) => editor.setFontSize(30)],
    ['leaving the edit and entering it again', ({ canvas, tb }) => {
      textAdapterOf(current()).finishEditing()
      edit(canvas, tb)
    }],
  ]
  for (const [what, act] of ways) {
    it(`is no longer offered after ${what}: Backspace deletes normally`, async () => {
      const ctx = await setup()
      const { canvas, tb } = ctx
      edit(canvas, tb)
      typeKeys(tb, ' **b**')
      act({ ...ctx, tb })
      const before = textOf()
      expect(session().canRevertShortcut).toBe(false)
      backspace(tb)
      expect(textOf()).toBe(before.slice(0, -1))
      textAdapterOf(current()).finishEditing()
    })
  }

  it('is no longer offered after leaving and undo, which rebuilds the board', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    typeKeys(tb, 'x')
    textAdapterOf(current()).finishEditing()
    edit(canvas, tb)
    typeKeys(tb, ' *i*')
    textAdapterOf(editor).finishEditing() // (inside the edit, Undo steps the edit's own history)
    editor.undo()
    expect(rec()).toStrictEqual(text({ text: 'gox' }))
    expect(editedObject(editor)).toBeNull()
    expect(textAdapterOf(editor).editSession()?.canRevertShortcut ?? false).toBe(false)
    editor.redo()
    expect(rec()).toStrictEqual(text({ text: 'gox i', spans: [{ start: 4, end: 5, italic: true }] }))
  })
})

describe('history and saving', () => {
  it('a conversion and the rest of the edit are one undo step; undo and redo restore text and formatting exactly; the typing save stores the converted state', async () => {
    const { editor, store, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' **b** and')
    await flush()
    const converted = text({ text: 'go b and', spans: [{ start: 3, end: 4, bold: true }] })
    expect(store.saves.at(-1)?.doc.objects[0]).toStrictEqual(converted)
    expect(boardCanUndo(editor)).toBe(false) // history is recorded when the edit ends
    textAdapterOf(current()).finishEditing()
    expect(rec()).toStrictEqual(converted)
    editor.undo()
    expect(rec()).toStrictEqual(text())
    expect(editor.getState().canUndo).toBe(false)
    editor.redo()
    expect(rec()).toStrictEqual(converted)
  })

  it('a conversion then a revert then leaving: one step, with the literal text', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' **b**')
    backspace(tb)
    textAdapterOf(current()).finishEditing()
    expect(rec()).toStrictEqual(text({ text: 'go **b**' }))
    editor.undo()
    expect(rec()).toStrictEqual(text())
  })

  it('no save ever holds the marker typed but not converted, also with a save in flight and the debounce firing in between', async () => {
    const { store, canvas, tb } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' **b*')
    store.saveGate = deferred<void>()
    await vi.advanceTimersByTimeAsync(600) // a save of "go **b*" starts and is held
    expect(store.attempts.at(-1)?.doc.objects[0]).toMatchObject({ text: 'go **b*' })
    typeKey(tb, '*')
    store.saveGate.resolve()
    store.saveGate = null
    await flush()
    const texts = store.attempts.map((a) => (a.doc.objects[0] as TextRecord).text)
    expect(texts).not.toContain('go **b**')
    expect(store.saves.at(-1)?.doc.objects[0]).toStrictEqual(text({ text: 'go b', spans: [{ start: 3, end: 4, bold: true }] }))
    textAdapterOf(current()).finishEditing()
  })

  it('a new text started with `# ` from the Text tool: blank, so nothing is saved or recorded; left there, it is discarded', async () => {
    const { editor, store, canvas, scene } = await setup([])
    editor.addText()
    const blank = canvas.objects.at(-1) as Tb
    typeKeys(blank, '# ')
    expect(textOf()).toBe('')
    expect(scene()).toEqual([])
    await flush()
    expect(store.saves.filter((s) => s.doc.objects.length > 0)).toHaveLength(0)
    textAdapterOf(current()).finishEditing()
    await tick()
    expect(canvas.objects).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('a new text started with `# Title`: one step, a heading', async () => {
    const { editor, canvas, scene } = await setup([])
    editor.addText()
    const tb = canvas.objects.at(-1) as Tb
    typeKeys(tb, '# Title')
    textAdapterOf(current()).finishEditing()
    expect(scene()).toHaveLength(1)
    expect(scene()[0]).toMatchObject({ text: 'Title', headings: [1] })
    editor.undo()
    expect(scene()).toEqual([])
  })

  it('the board going read-only mid-edit after a conversion: nothing is committed, and Backspace is not claimed', async () => {
    const { editor, store, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    const root = textAdapterOf(editor).editedRoot()!
    store.saveError = new BoardConflictError()
    typeKeys(tb, ' *i*')
    await flush()
    expect(editor.getState().readOnly).not.toBeNull()
    expect(editedObject(editor)).toBeNull()
    expect(editor.getState().canUndo).toBe(false)
    const before = rec()
    root.dispatchEvent(keyEvent('keydown', 'Backspace')) // no revert: the edit is over, and nothing writes
    expect(rec()).toStrictEqual(before)
  })
})

describe('guards: only a typed character, inserted at the caret, fires', () => {
  it('a pasted or dropped `*` (no keydown typed it) stays literal', async () => {
    const { canvas, tb } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    insert(session(), '*') // a dropped "*": an input with no key typing it
    expect(textOf()).toBe('go *i*')
    typeKeys(tb, ' **x*')
    const root = textAdapterOf(current()).editedRoot()!
    root.dispatchEvent(keyEvent('keydown', 'v', { ctrlKey: true }))
    session().paste({ text: '*' }) // Ctrl+V of "*"
    root.dispatchEvent(keyEvent('keyup', 'v', { ctrlKey: true }))
    expect(textOf()).toBe('go *i* **x**')
    textAdapterOf(current()).finishEditing()
  })

  it('a key whose input never came (its keyup arrived) does not make a later paste fire', async () => {
    const { canvas, tb } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    const root = textAdapterOf(current()).editedRoot()!
    root.dispatchEvent(keyEvent('keydown', '*'))
    root.dispatchEvent(keyEvent('keyup', '*'))
    insert(session(), '*')
    expect(textOf()).toBe('go *i*')
    textAdapterOf(current()).finishEditing()
  })

  it('nothing fires during an IME composition, nor for a key the IME takes', async () => {
    const { canvas, tb } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    const root = textAdapterOf(current()).editedRoot()!
    root.dispatchEvent(keyEvent('keydown', '*'))
    insert(session(), '*', true) // arrives composed
    root.dispatchEvent(keyEvent('keyup', '*'))
    expect(textOf()).toBe('go *i*')
    typeKey(tb, '*', { isComposing: true })
    expect(textOf()).toBe('go *i**')
    textAdapterOf(current()).finishEditing()
  })

  it('a typed `*` that replaces a selection does not fire', async () => {
    const { canvas, tb } = await setup([text({ text: '*i!' })])
    edit(canvas, tb)
    selectText(current(), 2, 3) // "!" selected
    typeKey(tb, '*')
    expect(textOf()).toBe('*i*')
    textAdapterOf(current()).finishEditing()
  })

  it('a typed `*` that did not leave the caret right after it does not fire', async () => {
    const { canvas, tb } = await setup([text({ text: '*i' })])
    edit(canvas, tb, 0)
    const root = textAdapterOf(current()).editedRoot()!
    root.dispatchEvent(keyEvent('keydown', '*'))
    // The "*" arrives at the end of the text, the caret somewhere else (at its start).
    const s = session()
    if (!s.handleTextInput(3, 3, '*')) s.dispatch(s.state.tr.insertText('*', 3, 3))
    root.dispatchEvent(keyEvent('keyup', '*'))
    expect(textOf()).toBe('*i*')
    textAdapterOf(current()).finishEditing()
  })

  it('while a gesture is unsettled, nothing fires (the edited text takes no input then)', async () => {
    const { canvas, tb, editor } = await setup([text(), text({ id: 'u', left: 400, text: 'other' })])
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    const other = canvas.objects.find((o) => textDataOf(o as never)?.text === 'other') as Tb
    const t = press(canvas, other)
    dragBy(canvas, t, 5, 0)
    typeKey(tb, '*')
    expect(textOf()).toBe('go *i')
    release(canvas, t)
    await tick()
    expect(boardCanUndo(editor)).toBe(true) // the drag was recorded; the text stayed literal
    expect(textOf()).toBe('go *i')
  })
})

describe('held formatting keys (auto-repeat)', () => {
  it('while editing: the first press toggles, repeats are claimed and toggle nothing', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ text: 'abc' })])
    edit(canvas, tb, 0)
    selectText(current(), 0, 3)
    const root = textAdapterOf(current()).editedRoot()!
    const first = keyEvent('keydown', 'b', { ctrlKey: true })
    root.dispatchEvent(first)
    const repeats = [1, 2, 3].map(() => keyEvent('keydown', 'b', { ctrlKey: true, repeat: true }))
    for (const r of repeats) root.dispatchEvent(r)
    expect(first.defaultPrevented).toBe(true)
    expect(repeats.every((r) => r.defaultPrevented)).toBe(true)
    expect(rec()?.spans).toEqual([{ start: 0, end: 3, bold: true }])
    textAdapterOf(current()).finishEditing()
    void editor
  })

  it('on a selected box: the same', async () => {
    const { canvas, tb, rec } = await setup([text({ text: 'abc' })])
    canvas.setActiveObject(tb)
    const first = keyEvent('keydown', 'u', { ctrlKey: true })
    document.body.dispatchEvent(first)
    const repeat = keyEvent('keydown', 'u', { ctrlKey: true, repeat: true })
    document.body.dispatchEvent(repeat)
    expect([first.defaultPrevented, repeat.defaultPrevented]).toEqual([true, true])
    expect(rec()?.spans).toEqual([{ start: 0, end: 3, underline: true }])
  })
})

describe('a pending bold and a heading line (a heading is always bold, so bold is never pending on one)', () => {
  /** A new blank text from the Text tool's command, being typed into at its start. */
  async function blank() {
    const ctx = await setup([])
    ctx.editor.addText()
    const tb = ctx.canvas.objects.at(-1) as Tb
    const pending = pendingOf
    return { ...ctx, tb, pending, made: () => ctx.scene()[0] as TextRecord }
  }

  it('the panel\'s heading: a pending bold is dropped, so the normal line after Enter is plain', async () => {
    const { editor, tb, pending, made } = await blank()
    editor.toggleMark('bold')
    editor.setHeading(1)
    expect(pending()).toStrictEqual({})
    await tick()
    expect(editor.getState().selection?.text).toMatchObject({ heading: 1, boldFromHeading: true })
    typeKeys(tb, 'Title\nBody')
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('off')
    textAdapterOf(current()).finishEditing()
    expect(made()).toMatchObject({ text: 'Title\nBody', headings: [1] })
    expect(made().spans).toBeUndefined()
  })

  for (const [marker, level] of [['# ', 1], ['## ', 2]] as const) {
    it(`the \`${marker.trim()}\` shortcut: a pending bold is dropped, and the normal line after Enter is plain`, async () => {
      const { editor, tb, pending, made } = await blank()
      editor.toggleMark('bold')
      typeKeys(tb, marker)
      expect(pending()).toStrictEqual({})
      typeKeys(tb, 'Title\nBody')
      textAdapterOf(current()).finishEditing()
      expect(made()).toMatchObject({ text: 'Title\nBody', headings: [level] })
      expect(made().spans).toBeUndefined()
    })
  }

  it('a line joined into the heading above it (Backspace at its start): a pending bold is dropped', async () => {
    const { editor, tb, pending, made } = await blank()
    editor.setHeading(1)
    typeKeys(tb, 'Title\n')
    editor.toggleMark('bold') // on the new, normal line
    expect(pending()).toStrictEqual({ bold: true })
    backspace(tb) // joins it into "Title"
    expect(pending()).toStrictEqual({})
    typeKeys(tb, 'A\nBody')
    textAdapterOf(current()).finishEditing()
    expect(made()).toMatchObject({ text: 'TitleA\nBody', headings: [1] })
    expect(made().spans).toBeUndefined()
  })

  for (const how of ['panel', 'shortcut'] as const) {
    it(`italic pending before the heading (${how}) still applies, to the heading and to the line after it; only bold is dropped`, async () => {
      const { editor, tb, pending, made } = await blank()
      editor.toggleMark('italic')
      editor.toggleMark('bold')
      if (how === 'panel') editor.setHeading(1)
      else typeKeys(tb, '# ')
      expect(pending()).toStrictEqual({ italic: true })
      typeKeys(tb, 'Title\nBody')
      textAdapterOf(current()).finishEditing()
      expect(made()).toStrictEqual({ ...made(), text: 'Title\nBody', headings: [1], spans: [{ start: 0, end: 10, italic: true }] })
    })
  }

  it('a pending "bold off" next to bold text, then a heading: only the bold is dropped', async () => {
    const { editor, canvas, tb } = await setup([text({ text: 'ab', spans: [{ start: 0, end: 2, bold: true }] })])
    edit(canvas, tb)
    editor.toggleMark('bold') // off, for what is typed next
    editor.toggleMark('underline')
    const pending = pendingOf
    expect(pending()).toStrictEqual({ bold: false, underline: true })
    editor.setHeading(2)
    expect(pending()).toStrictEqual({ underline: true })
    textAdapterOf(current()).finishEditing()
  })

  it('Backspace straight after `# ` restores the literal text and the pending bold; what is typed next is bold on that normal line', async () => {
    const { editor, tb, pending, made } = await blank()
    editor.toggleMark('bold')
    typeKeys(tb, '# ')
    expect(pending()).toStrictEqual({})
    backspace(tb)
    expect(textOf()).toBe('# ')
    expect(pending()).toStrictEqual({ bold: true })
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('on')
    typeKeys(tb, 'x')
    textAdapterOf(current()).finishEditing()
    expect(made()).toStrictEqual({ ...made(), text: '# x', spans: [{ start: 0, end: 3, bold: true }] })
    expect(made().headings).toBeUndefined()
  })
})
