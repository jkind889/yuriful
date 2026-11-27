import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, TextRecord } from '../model/types.ts'
import { Editor } from './Editor.ts'
import { canvasOf } from './testing/drive.ts'
import type { FakeObject } from './testing/fakeFabric.ts'
import { editSession, selectText, startEditing, textAdapterOf } from './testing/editing.ts'
import { isText } from './objects.ts'
import { FakeAssets, FakeCardMeasurer, SpyStore, stubTextLayout } from './testing/fakes.ts'
import { BLOCK_KINDS } from './textRules.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The block buttons through the editor: on a selected box (the whole-box command, then the board's
 * Undo) and in an edit (in-edit Undo, then leaving), a stored text comes back byte for byte (S1),
 * and a selected box's buttons cover every line, its empty last line included (S2).
 */

const text = (patch: Partial<TextRecord> = {}): TextRecord => ({ type: 'text', id: 't', left: 100, top: 100, angle: 0, text: 'plain words', fontSize: 20, width: 300, ...patch })

let host: HTMLDivElement
const editors: Editor[] = []
const flush = () => vi.advanceTimersByTimeAsync(10_000)

async function setup(rec: TextRecord) {
  const doc: BoardDoc = { ...createEmptyDoc(), title: 'Blocks', objects: [rec] }
  const store = new SpyStore({ doc, assets: new Map() })
  store.holdLoad = false
  const editor = new Editor(host, store, new FakeAssets(), undefined, { measurer: new FakeCardMeasurer() })
  editors.push(editor)
  await editor.init()
  const canvas = canvasOf(editor)
  const tb = canvas.objects.find((o) => isText(o as never)) as FakeObject
  const stored = () => (editor as unknown as { getDoc: () => BoardDoc }).getDoc().objects.find((o) => o.id === rec.id) as TextRecord
  const saved = () => store.saves.at(-1)?.doc.objects.find((o) => o.id === rec.id) as TextRecord | undefined
  return { editor, canvas, tb, stored, saved, store }
}

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

/** An old board's text with "\r\n" line breaks, a Serif override on `B` and a heading. */
const crlf = () => text({ text: 'A\r\nB', spans: [{ start: 3, end: 4, font: 'serif' }], headings: [2, 0] })

describe('S1: a block button and Undo give back a stored text byte for byte', () => {
  for (const kind of BLOCK_KINDS) {
    it(`${kind} on a selected box, then the board's Undo`, async () => {
      const { editor, canvas, tb, stored, saved } = await setup(crlf())
      const before = structuredClone(stored())
      canvas.setActiveObject(tb)
      editor.toggleTextBlock(kind)
      expect(stored().blocks).toBeDefined()
      editor.undo()
      expect(stored()).toStrictEqual(before)
      await flush()
      expect(saved()).toStrictEqual(before)
    })

    it(`${kind} on the first line in an edit, in-edit Undo, then leaving`, async () => {
      const { editor, canvas, tb, stored, saved } = await setup(crlf())
      const before = structuredClone(stored())
      canvas.setActiveObject(tb)
      startEditing(editor, tb)
      selectText(editor, 0)
      editor.toggleTextBlock(kind)
      expect(editSession(editor).content().blocks).toBeDefined()
      editSession(editor).undo()
      textAdapterOf(editor).finishEditing()
      expect(stored()).toStrictEqual(before)
      await flush()
      expect(saved() ?? before).toStrictEqual(before)
    })
  }
})

describe('S2: a selected box whose text ends with an empty line', () => {
  for (const kind of BLOCK_KINDS) {
    it(`${kind}: every line, the empty last one included, and the button reads on`, async () => {
      const { editor, canvas, tb, stored } = await setup(text({ text: 'a\n' }))
      canvas.setActiveObject(tb)
      expect(editor.getState().selection?.textBlocks?.blocks[kind]).toBe('off')
      editor.toggleTextBlock(kind)
      expect(stored().blocks).toBeDefined()
      expect(editor.getState().selection?.textBlocks?.blocks[kind]).toBe('on')
      // Pressed again, every line leaves it: the text is as it was.
      editor.toggleTextBlock(kind)
      expect(editor.getState().selection?.textBlocks?.blocks[kind]).toBe('off')
      if (kind !== 'codeBlock') expect(stored()).toStrictEqual(text({ text: 'a\n' }))
    })
  }
})
