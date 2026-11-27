import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, FrameRecord, TextRecord } from '../model/types.ts'
import { BoardConflictError } from '../persistence/boardStore.ts'
import { Editor } from './Editor.ts'
import { canvasOf, dragBy, press, release, tick } from './testing/drive.ts'
import type { Canvas, Textbox } from './testing/fakeFabric.ts'
import { FakeAssets, SpyStore, deferred } from './testing/fakes.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The typing shortcuts on the fake canvas: what fires, the conversion and its revert, when
 * the revert is no longer offered, history and saving, and the guards. The texts here are
 * ASCII, so a grapheme index is a UTF-16 offset. Whether Fabric's object and its textarea
 * really agree afterwards is only accepted on real-browser evidence (e2e/typing.spec.ts).
 */

type Styles = Record<number, Record<number, Record<string, unknown>>>
type Tb = Textbox & { styles: Styles }

const text = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 't', left: 100, top: 100, angle: 0, text: 'go', fontSize: 20, width: 300, ...patch })
const frame: FrameRecord = { id: 'F', name: 'Spread', left: 0, top: 0, width: 500, height: 400 }

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function setup(objects: BoardDoc['objects'] = [text()], frames: FrameRecord[] = []) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Typing', frames, objects }
  const store = new SpyStore({ doc, assets: new Map() })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets())
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const tb = canvas.objects.find((o) => (o as { text?: unknown }).text !== undefined) as Tb
  const scene = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects
  const rec = (id = 't') => scene().find((o) => o.id === id) as TextRecord | undefined
  return { editor, store, canvas, tb, scene, rec }
}

/** Gives the text a hidden textarea, as Fabric does when an edit starts. */
function withTextarea(tb: Tb): HTMLTextAreaElement {
  const ta = document.createElement('textarea')
  document.body.appendChild(ta)
  ta.value = tb.text
  tb.hiddenTextarea = ta
  return ta
}
/** Enters editing with the caret at `caret` (default: the end). */
function edit(canvas: Canvas, tb: Tb, caret = tb.text.length) {
  canvas.setActiveObject(tb)
  tb.enterEditing()
  withTextarea(tb)
  tb.selectionStart = tb.selectionEnd = caret
  canvas.fire('text:selection:changed', { target: tb })
}
const keyEvent = (type: string, k: string, init: KeyboardEventInit = {}) => new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init })

/**
 * One key typed into the edited text, as the browser and Fabric do it: the keydown (which
 * reaches the editor's window listener), then, unless it was prevented, the textarea's input
 * (the character replaces the selection; Fabric takes the textarea's value and fires
 * `text:changed`), then the keyup.
 */
function typeKey(tb: Tb, ch: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ta = tb.hiddenTextarea as HTMLTextAreaElement
  const down = keyEvent('keydown', ch, init)
  ta.dispatchEvent(down)
  if (!down.defaultPrevented && !init.ctrlKey && !init.metaKey) {
    const a = Math.min(tb.selectionStart ?? 0, tb.selectionEnd ?? 0)
    const b = Math.max(tb.selectionStart ?? 0, tb.selectionEnd ?? 0)
    const next = ch === 'Backspace' ? (a === b ? tb.text.slice(0, Math.max(0, a - 1)) + tb.text.slice(b) : tb.text.slice(0, a) + tb.text.slice(b)) : tb.text.slice(0, a) + ch + tb.text.slice(b)
    const caret = ch === 'Backspace' ? (a === b ? Math.max(0, a - 1) : a) : a + 1
    ta.value = next
    tb.type(next, caret)
  }
  ta.dispatchEvent(keyEvent('keyup', ch, init))
  return down
}
const typeKeys = (tb: Tb, s: string) => {
  for (const ch of s) typeKey(tb, ch)
}
const backspace = (tb: Tb) => typeKey(tb, 'Backspace')
const caretOf = (tb: Tb) => ({ start: tb.selectionStart, end: tb.selectionEnd, ta: [tb.hiddenTextarea?.selectionStart, tb.hiddenTextarea?.selectionEnd] })

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

describe('a conversion', () => {
  it('bold: the markers go, the word is bold, the caret is after it, the textarea agrees, and what is typed next is plain', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' **bold*')
    expect(tb.text).toBe('go **bold*') // nothing fires at the first closing star
    typeKey(tb, '*')
    expect(tb.text).toBe('go bold')
    expect(rec()).toStrictEqual(text({ text: 'go bold', spans: [{ start: 3, end: 7, bold: true }] }))
    expect(tb.hiddenTextarea?.value).toBe('go bold')
    expect(caretOf(tb)).toEqual({ start: 7, end: 7, ta: [7, 7] })
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('off') // the next character is typed plain
    const b = { fontWeight: 'bold' }
    tb.styles = { 0: { 3: b, 4: b, 5: b, 6: b, 7: b } } // Fabric copies the bold of "d" onto the typed "!"
    typeKey(tb, '!')
    expect(rec()?.spans).toEqual([{ start: 3, end: 7, bold: true }])
    tb.exitEditing()
  })

  it('italic, and a heading on an empty line, at the start of a line with text, and changing a level', async () => {
    const { canvas, tb, rec } = await setup([text({ text: 'one\nTitle\n', headings: [0, 3] })])
    edit(canvas, tb, 4) // start of "Title"
    typeKeys(tb, '## ')
    expect(tb.text).toBe('one\nTitle\n')
    expect(rec()?.headings).toEqual([0, 2])
    expect(caretOf(tb)).toEqual({ start: 4, end: 4, ta: [4, 4] })
    tb.selectionStart = tb.selectionEnd = 10 // the empty last line (as if typed there)
    typeKeys(tb, '# ')
    expect(rec()).toStrictEqual(text({ text: 'one\nTitle\n', headings: [0, 2, 1] }))
    typeKeys(tb, 'it is *so*')
    expect(rec()).toStrictEqual(text({ text: 'one\nTitle\nit is so', spans: [{ start: 16, end: 18, italic: true }], headings: [0, 2, 1] }))
    tb.exitEditing()
  })

  it('in a heading line `**x**` still fires: the markers go and no bold is stored', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ text: 'Big', headings: [1] })])
    edit(canvas, tb)
    typeKeys(tb, ' **x**')
    expect(rec()).toStrictEqual(text({ text: 'Big x', headings: [1] }))
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('on') // the heading's own, not a pending choice
    expect((editor as unknown as { pending: unknown }).pending).toBeNull()
    tb.exitEditing()
  })

  for (const s of ['2 * 3 * 4', 'a ** b', '* item', '**', 'snake*case*', '***x***', '#tag ', '#### ', 'a # ', '** x**', '*x *', '#x']) {
    it(`stays as typed: "${s}"`, async () => {
      const { canvas, tb, rec } = await setup([text({ text: 'x' })])
      edit(canvas, tb)
      typeKey(tb, '\n')
      typeKeys(tb, s)
      expect(tb.text).toBe(`x\n${s}`)
      tb.exitEditing()
      expect(rec()).toStrictEqual(text({ text: `x\n${s}` }))
    })
  }

  it('a heading line keeps its owner, and so does a text owned by a frame whose centre the heading moves out', async () => {
    const owned = text({ id: 't', frameId: 'F', left: 100, top: 360, text: 'x' })
    const { canvas, tb, rec } = await setup([owned], [frame])
    edit(canvas, tb)
    typeKeys(tb, '\n# Big heading')
    tb.exitEditing()
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
    expect(tb.text).toBe('go *it*')
    expect(tb.hiddenTextarea?.value).toBe('go *it*')
    expect(caretOf(tb)).toEqual({ start: 7, end: 7, ta: [7, 7] })
    expect(rec()).toStrictEqual(text({ text: 'go *it*', spans: [{ start: 0, end: 2, underline: true }] }))
    typeKey(tb, '*') // typing on does not fire it again
    expect(tb.text).toBe('go *it**')
    expect(backspace(tb).defaultPrevented).toBe(false)
    expect(backspace(tb).defaultPrevented).toBe(false)
    expect(tb.text).toBe('go *it')
    tb.exitEditing()
  })

  it('a heading: the marker and the space come back, and the line its old level', async () => {
    const { canvas, tb, rec } = await setup([text({ text: 'x\nTitle', headings: [0, 3] })])
    edit(canvas, tb, 2)
    typeKeys(tb, '# ')
    expect(rec()?.headings).toEqual([0, 1])
    backspace(tb)
    expect(rec()).toStrictEqual(text({ text: 'x\n# Title', headings: [0, 3] }))
    expect(caretOf(tb)).toEqual({ start: 4, end: 4, ta: [4, 4] })
    tb.exitEditing()
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
    tb.exitEditing()
  })

  const ways: Array<[string, (ctx: Awaited<ReturnType<typeof setup>> & { tb: Tb }) => void]> = [
    ['more typing', ({ tb }) => typeKey(tb, 'z')],
    ['a caret move (arrow key or click)', ({ canvas, tb }) => {
      tb.selectionStart = tb.selectionEnd = 1
      canvas.fire('text:selection:changed', { target: tb })
      tb.selectionStart = tb.selectionEnd = tb.text.length
    }],
    ['a formatting command from the panel', ({ editor }) => editor.toggleMark('strike')],
    ['a heading command that changes nothing', ({ editor }) => editor.setHeading(0)],
    ['the font size field', ({ editor }) => editor.setFontSize(30)],
    ['leaving the edit and entering it again', ({ canvas, tb }) => {
      tb.exitEditing()
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
      const before = tb.text
      const down = backspace(tb)
      expect(down.defaultPrevented).toBe(false)
      expect(tb.text).toBe(before.slice(0, -1))
      tb.exitEditing()
    })
  }

  it('is no longer offered after undo, which rebuilds the board (and ends the edit)', async () => {
    const { editor, canvas, tb, rec } = await setup()
    edit(canvas, tb)
    typeKeys(tb, 'x')
    tb.exitEditing()
    edit(canvas, tb)
    typeKeys(tb, ' *i*')
    editor.undo() // the edit is committed first, then undone
    expect(rec()).toStrictEqual(text({ text: 'gox' }))
    expect((editor as unknown as { shortcutRevert: unknown }).shortcutRevert).toBeNull()
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
    expect(editor.getState().canUndo).toBe(false) // history is recorded when the edit ends
    tb.exitEditing()
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
    tb.exitEditing()
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
    tb.exitEditing()
  })

  it('a new text started with `# ` from the Text tool: blank, so nothing is saved or recorded; left there, it is discarded', async () => {
    const { editor, store, canvas, scene } = await setup([])
    editor.addText()
    const blank = canvas.objects.at(-1) as Tb
    withTextarea(blank)
    blank.selectionStart = blank.selectionEnd = 0
    typeKeys(blank, '# ')
    expect(blank.text).toBe('')
    expect(scene()).toEqual([])
    await flush()
    expect(store.saves.filter((s) => s.doc.objects.length > 0)).toHaveLength(0)
    blank.exitEditing()
    await tick()
    expect(canvas.objects).toHaveLength(0)
    expect(editor.getState().canUndo).toBe(false)
  })

  it('a new text started with `# Title`: one step, a heading', async () => {
    const { editor, canvas, scene } = await setup([])
    editor.addText()
    const tb = canvas.objects.at(-1) as Tb
    withTextarea(tb)
    tb.selectionStart = tb.selectionEnd = 0
    typeKeys(tb, '# Title')
    tb.exitEditing()
    expect(scene()).toHaveLength(1)
    expect(scene()[0]).toMatchObject({ text: 'Title', headings: [1] })
    editor.undo()
    expect(scene()).toEqual([])
  })

  it('the board going read-only mid-edit after a conversion: nothing is committed, and Backspace is not claimed', async () => {
    const { editor, store, canvas, tb } = await setup()
    edit(canvas, tb)
    store.saveError = new BoardConflictError()
    typeKeys(tb, ' *i*')
    await flush()
    expect(editor.getState().readOnly).not.toBeNull()
    expect(tb.isEditing).toBe(false)
    expect(editor.getState().canUndo).toBe(false)
    const down = keyEvent('keydown', 'Backspace')
    tb.hiddenTextarea!.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
  })
})

describe('guards: only a typed character, inserted at the caret, fires', () => {
  it('a pasted or dropped `*` (no keydown typed it) stays literal', async () => {
    const { canvas, tb } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    tb.hiddenTextarea!.value = 'go *i*'
    tb.type('go *i*', 6) // a paste of "*": an input with no key typing it
    expect(tb.text).toBe('go *i*')
    typeKeys(tb, ' **x*')
    const ta = tb.hiddenTextarea as HTMLTextAreaElement
    ta.dispatchEvent(keyEvent('keydown', 'v', { ctrlKey: true }))
    ta.value = 'go *i* **x**'
    tb.type('go *i* **x**', 12) // Ctrl+V of "*"
    ta.dispatchEvent(keyEvent('keyup', 'v', { ctrlKey: true }))
    expect(tb.text).toBe('go *i* **x**')
    tb.exitEditing()
  })

  it('a key whose input never came (its keyup arrived) does not make a later paste fire', async () => {
    const { canvas, tb } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    const ta = tb.hiddenTextarea as HTMLTextAreaElement
    ta.dispatchEvent(keyEvent('keydown', '*'))
    ta.dispatchEvent(keyEvent('keyup', '*'))
    tb.type('go *i*', 6)
    expect(tb.text).toBe('go *i*')
    tb.exitEditing()
  })

  it('nothing fires during an IME composition, nor for a key the IME takes', async () => {
    const { canvas, tb } = await setup()
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    tb.inCompositionMode = true
    typeKey(tb, '*')
    expect(tb.text).toBe('go *i*')
    tb.inCompositionMode = false
    typeKey(tb, '*', { isComposing: true })
    expect(tb.text).toBe('go *i**')
    tb.exitEditing()
  })

  it('a typed `*` that replaces a selection does not fire', async () => {
    const { canvas, tb } = await setup([text({ text: '*i!' })])
    edit(canvas, tb)
    tb.selectionStart = 2 // "!" selected
    typeKey(tb, '*')
    expect(tb.text).toBe('*i*')
    tb.exitEditing()
  })

  it('a typed `*` that did not leave the caret right after it does not fire', async () => {
    const { canvas, tb } = await setup([text({ text: '*i' })])
    edit(canvas, tb)
    const ta = tb.hiddenTextarea as HTMLTextAreaElement
    ta.dispatchEvent(keyEvent('keydown', '*'))
    ta.value = '*i*'
    tb.type('*i*', 0) // the caret is somewhere else
    expect(tb.text).toBe('*i*')
    tb.exitEditing()
  })

  it('while a gesture is unsettled, nothing fires', async () => {
    const { canvas, tb, editor } = await setup([text(), text({ id: 'u', left: 400, text: 'other' })])
    edit(canvas, tb)
    typeKeys(tb, ' *i')
    const other = canvas.objects.find((o) => (o as Tb).text === 'other') as Tb
    const t = press(canvas, other)
    dragBy(canvas, t, 5, 0)
    typeKey(tb, '*')
    expect(tb.text).toBe('go *i*')
    release(canvas, t)
    await tick()
    expect(editor.getState().canUndo).toBe(true) // the drag was recorded; the text stayed literal
  })
})

describe('held formatting keys (auto-repeat)', () => {
  it('while editing: the first press toggles, repeats are claimed and toggle nothing', async () => {
    const { editor, canvas, tb, rec } = await setup([text({ text: 'abc' })])
    edit(canvas, tb, 0)
    tb.selectionEnd = 3
    const ta = tb.hiddenTextarea as HTMLTextAreaElement
    const first = keyEvent('keydown', 'b', { ctrlKey: true })
    ta.dispatchEvent(first)
    const repeats = [1, 2, 3].map(() => keyEvent('keydown', 'b', { ctrlKey: true, repeat: true }))
    for (const r of repeats) ta.dispatchEvent(r)
    expect(first.defaultPrevented).toBe(true)
    expect(repeats.every((r) => r.defaultPrevented)).toBe(true)
    expect(rec()?.spans).toEqual([{ start: 0, end: 3, bold: true }])
    tb.exitEditing()
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
    withTextarea(tb)
    tb.selectionStart = tb.selectionEnd = 0
    const pending = () => (ctx.editor as unknown as { pending: { style: Record<string, boolean> } | null }).pending?.style ?? {}
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
    tb.exitEditing()
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
      tb.exitEditing()
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
    tb.exitEditing()
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
      tb.exitEditing()
      expect(made()).toStrictEqual({ ...made(), text: 'Title\nBody', headings: [1], spans: [{ start: 0, end: 10, italic: true }] })
    })
  }

  it('a pending "bold off" next to bold text, then a heading: only the bold is dropped', async () => {
    const { editor, canvas, tb } = await setup([text({ text: 'ab', spans: [{ start: 0, end: 2, bold: true }] })])
    edit(canvas, tb)
    editor.toggleMark('bold') // off, for what is typed next
    editor.toggleMark('underline')
    const pending = () => (editor as unknown as { pending: { style: Record<string, boolean> } | null }).pending?.style
    expect(pending()).toStrictEqual({ bold: false, underline: true })
    editor.setHeading(2)
    expect(pending()).toStrictEqual({ underline: true })
    tb.exitEditing()
  })

  it('Backspace straight after `# ` restores the literal text and the pending bold; what is typed next is bold on that normal line', async () => {
    const { editor, tb, pending, made } = await blank()
    editor.toggleMark('bold')
    typeKeys(tb, '# ')
    expect(pending()).toStrictEqual({})
    backspace(tb)
    expect(tb.text).toBe('# ')
    expect(pending()).toStrictEqual({ bold: true })
    await tick()
    expect(editor.getState().selection?.text?.marks.bold).toBe('on')
    typeKeys(tb, 'x')
    tb.exitEditing()
    expect(made()).toStrictEqual({ ...made(), text: '# x', spans: [{ start: 0, end: 3, bold: true }] })
    expect(made().headings).toBeUndefined()
  })
})
