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

/**
 * Text that replaces a selection without a key the editor sees (an IME composition's commit,
 * an insertion with no keydown), on a mounted view with real browser input. The expectation
 * is Fabric's real `onInput` for that replacement, as above, with the composition's committed
 * text as one replacement.
 */
test('an IME composition or a keyless insertion over every selection gives the canvas’s record, on a mounted view', async ({ page }) => {
  test.setTimeout(240_000)
  await openBlank(page)
  const cdp = await page.context().newCDPSession(page)
  const cases = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { splitGraphemes } = (await load('/src/model/richText.ts')) as typeof import('../src/model/richText.ts')
    const { canonicalTextContent } = (await load('/src/model/textDoc.ts')) as typeof import('../src/model/textDoc.ts')
    const style = (i: number, k: number) => ((i + k) % 3 === 0 ? { bold: true, font: 'mono' } : (i + k) % 3 === 1 ? { italic: true, underline: true } : { strike: true })
    const sources = [
      { text: 'ab\ncd', spans: [{ start: 1, end: 2, bold: true }] },
      ...(['ab\ncd', 'a\n\nb', 'AB\nXY\nAB'] as const).flatMap((text, t) => {
        const edges = [0]
        for (const g of splitGraphemes(text)) edges.push(edges[edges.length - 1]! + g.length)
        return [{ text, headings: t % 2 ? [0, 2] : [1], spans: edges.slice(1).map((e, i) => ({ start: edges[i]!, end: e, ...style(i, t) })) }]
      }),
    ]
    const out: Array<{ src: unknown; a: number; b: number }> = []
    for (const raw of sources) {
      const src = canonicalTextContent(raw)!
      const edges = [0]
      for (const g of splitGraphemes(src.text)) edges.push(edges[edges.length - 1]! + g.length)
      for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) out.push({ src, a: edges[i]!, b: edges[j]! })
    }
    return out
  })
  let count = 0
  const fails: unknown[] = []
  for (const { src, a, b } of cases) {
    for (const how of ['ime', 'insert'] as const) {
      await page.evaluate(async ([src, a, b]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        const { createEditSession } = (await load('/src/editor/textSession.ts')) as typeof import('../src/editor/textSession.ts')
        const w = window as unknown as { ss?: { finish(): void } }
        w.ss?.finish()
        document.body.replaceChildren()
        const el = document.createElement('div')
        el.style.whiteSpace = 'pre-wrap'
        document.body.append(el)
        const s = createEditSession(src as never)!
        ;(window as unknown as { ss: unknown }).ss = s
        s.mount(el).focus()
        s.select(a as number, b as number)
      }, [src, a, b] as const)
      if (how === 'ime') {
        await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 })
        await cdp.send('Input.imeSetComposition', { text: 'ka', selectionStart: 2, selectionEnd: 2 })
        await cdp.send('Input.insertText', { text: 'カ' })
      } else await cdp.send('Input.insertText', { text: 'カ' })
      await page.waitForTimeout(40) // ProseMirror ends a composition 20 ms after compositionend
      const result = await page.evaluate(async ([src, a, b]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        const { createObject, reconcileTextFormatting, toRecord } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
        const { canonicalTextContent } = (await load('/src/model/textDoc.ts')) as typeof import('../src/model/textDoc.ts')
        const { docFromText } = (await load('/src/editor/textSchema.ts')) as typeof import('../src/editor/textSchema.ts')
        const { splitGraphemes } = (await load('/src/model/richText.ts')) as typeof import('../src/model/richText.ts')
        const s = (window as unknown as { ss: import('../src/editor/textSession.ts').EditSession }).ss
        const text = (src as { text: string }).text
        const g = (o: number) => splitGraphemes(text.slice(0, o)).length // Fabric's character index
        const obj = createObject({ type: 'text', id: 't', left: 0, top: 0, angle: 0, width: 360, fontSize: 24, ...(src as object) } as never, () => undefined) as unknown as {
          isEditing: boolean
          hiddenTextarea: HTMLTextAreaElement
          selectionStart: number
          selectionEnd: number
          onInput(e: Event): void
        }
        obj.isEditing = true
        obj.hiddenTextarea = document.createElement('textarea')
        obj.selectionStart = g(a as number)
        obj.selectionEnd = g(b as number)
        obj.hiddenTextarea.value = text.slice(0, a as number) + 'カ' + text.slice(b as number)
        obj.hiddenTextarea.setSelectionRange((a as number) + 1, (a as number) + 1)
        obj.onInput(new InputEvent('input', { inputType: 'insertText' }))
        reconcileTextFormatting(obj as never)
        const expected = canonicalTextContent(toRecord(obj as never) as never)
        const got = s.content()
        return { expected, got, live: docFromText(got)!.doc.eq(s.state.doc) }
      }, [src, a, b] as const)
      count++
      if (JSON.stringify(result.expected) !== JSON.stringify(result.got) || !result.live) fails.push({ how, src, a, b, ...result })
    }
  }
  console.log(`text engine parity (mounted, IME and keyless insertion): ${count} edits, ${fails.length} differ`)
  expect(fails.slice(0, 6)).toEqual([])
  expect(count).toBe(152)
})
