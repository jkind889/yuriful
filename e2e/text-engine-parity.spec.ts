import { expect, test } from '@playwright/test'
import { openBlank } from './helpers.ts'

/**
 * The new text engine (`src/editor/textSession.ts`, not yet wired into the canvas) against
 * today's canvas, edit for edit: typing, Enter, Backspace and Delete over every caret and
 * selection of formatted texts. The expectation is the shipped canvas itself: a real Fabric
 * text built by `createObject`, its hidden textarea changed as the key changes it, Fabric's
 * own `onInput`, then the editor's `reconcileTextFormatting` and `toRecord`. Nothing of the
 * engine is used to compute it.
 */
test('typing, Enter and deletions over every caret and selection give the canvas’s record, marks included', async ({ page }) => {
  test.setTimeout(240_000)
  await openBlank(page)
  const out = await page.evaluate(async () => {
    // Loaded from the dev server, as the other specs load app modules.
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { createObject, reconcileTextFormatting, toRecord } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
    const { canonicalTextContent } = (await load('/src/model/textDoc.ts')) as typeof import('../src/model/textDoc.ts')
    const { splitGraphemes } = (await load('/src/model/richText.ts')) as typeof import('../src/model/richText.ts')
    const { open, press, type } = (await load('/src/editor/testing/textHarness.ts')) as typeof import('../src/editor/testing/textHarness.ts')
    const { docFromText } = (await load('/src/editor/textSchema.ts')) as typeof import('../src/editor/textSchema.ts')
    const texts = ['Ab', 'ab\ncd', 'a\n\nb', 'a\na\n', '😀a\n👩‍💻b', 'x\r\ny', 'áb', '\n\nb', 'AB\nXY\nAB']
    const ops = ['x', 'Enter', 'Backspace', 'Delete'] as const
    let count = 0
    let fails = 0
    let live = 0
    const samples: unknown[] = []
    for (const text of texts) {
      for (const levels of [[0, 2, 1], [1, 0, 3]]) {
        for (const style of [1, 2]) {
          const edges = [0]
          for (const g of splitGraphemes(text)) edges.push(edges[edges.length - 1]! + g.length)
          // Every character styled, three styles in turn, so that every copy of a style shows.
          const spans = edges.slice(1).map((e, i) => ({ start: edges[i]!, end: e, ...((i + style) % 3 === 0 ? { bold: true, font: 'mono' } : (i + style) % 3 === 1 ? { italic: true, underline: true } : { strike: true }) }))
          const src = canonicalTextContent({ text, spans, headings: levels })!
          // Offsets in the "\n" form the engine and the textarea use.
          const n = (o: number) => text.slice(0, o).replace(/\r\n/g, '\n').length
          const flat = text.replace(/\r\n/g, '\n')
          for (let i = 0; i < edges.length; i++) {
            for (let j = i; j < edges.length; j++) {
              for (const op of ops) {
                const a = n(edges[i]!)
                const b = n(edges[j]!)
                // Backspace and Delete with only a caret depend on the browser's own deletion: covered elsewhere.
                if (a === b && (op === 'Backspace' || op === 'Delete')) continue
                const inserted = op === 'x' ? 'x' : op === 'Enter' ? '\n' : ''
                const obj = createObject({ type: 'text', id: 't', left: 0, top: 0, angle: 0, width: 360, fontSize: 24, ...src }, () => undefined) as unknown as {
                  isEditing: boolean
                  hiddenTextarea: HTMLTextAreaElement
                  selectionStart: number
                  selectionEnd: number
                  onInput(e: Event): void
                }
                obj.isEditing = true
                obj.hiddenTextarea = document.createElement('textarea')
                obj.selectionStart = i
                obj.selectionEnd = j
                obj.hiddenTextarea.value = flat.slice(0, a) + inserted + flat.slice(b)
                obj.hiddenTextarea.setSelectionRange(a + inserted.length, a + inserted.length)
                obj.onInput(new InputEvent('input', { inputType: op === 'x' ? 'insertText' : op === 'Enter' ? 'insertLineBreak' : 'deleteContentBackward' }))
                reconcileTextFormatting(obj as never)
                const expected = canonicalTextContent(toRecord(obj as never) as never)
                const s = open(src)
                s.select(a, b)
                if (op === 'x') type(s, 'x')
                else press(s, op)
                const got = s.content()
                count++
                if (JSON.stringify(expected) !== JSON.stringify(got)) {
                  fails++
                  if (samples.length < 8) samples.push({ text, levels, style, i, j, op, expected, got })
                }
                if (!docFromText(got)!.doc.eq(s.state.doc)) live++
              }
            }
          }
        }
      }
    }
    return { count, fails, live, samples }
  })
  console.log(`text engine parity: ${out.count} edits, ${out.fails} differ, ${out.live} live documents off their record`)
  expect(out.samples).toEqual([])
  expect(out.fails).toBe(0)
  expect(out.live).toBe(0)
  expect(out.count).toBe(2024)
})
