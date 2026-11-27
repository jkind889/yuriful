import { expect, test } from '@playwright/test'
import { openBlank } from './helpers.ts'

/**
 * The text engine (`src/editor/textSession.ts`) against the canvas it replaced, edit for edit:
 * typing, Enter, Backspace and Delete over every caret and selection of formatted texts. The
 * expectation is that canvas: a real Fabric text box, its hidden textarea changed as the key
 * changes it, Fabric's own `onInput`, then the Fabric renderer's reconciling of its styles and
 * reading of its record, from a frozen copy of that renderer's text code
 * (`src/editor/testing/fabricTextOracle.ts`, which agreed with the live renderer on every case
 * here before the renderer was deleted). Nothing of the engine is used to compute it.
 */
test('typing, Enter and deletions over every caret and selection give the canvas’s record, marks included', async ({ page }) => {
  test.setTimeout(240_000)
  await openBlank(page)
  const out = await page.evaluate(async () => {
    // Loaded from the dev server, as the other specs load app modules.
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    // The canvas fed the same input: the frozen copy of the Fabric renderer's text code (`fabricTextOracle.ts`).
    type Oracle = { create: (src: object) => unknown; reconcile: (obj: unknown, pending?: unknown) => unknown; content: (obj: unknown) => unknown }
    const fo = (await load('/src/editor/testing/fabricTextOracle.ts')) as typeof import('../src/editor/testing/fabricTextOracle.ts')
    const frozen: Oracle = {
      create: (src) => fo.createFabricText({ left: 0, top: 0, angle: 0, width: 360, fontSize: 24, ...(src as { text: string }) }),
      reconcile: (obj, pending) => fo.reconcileFabricText(obj as never, pending as never),
      content: (obj) => fo.fabricTextContent(obj as never),
    }
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
                const fed = (oracle: Oracle) => {
                  const obj = oracle.create(src) as {
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
                  oracle.reconcile(obj)
                  return canonicalTextContent(oracle.content(obj) as never)
                }
                const expected = fed(frozen)
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
 * Text that replaces a selection without a key the editor sees, on a mounted view with real
 * browser input. An insertion with no keydown: Fabric's real `onInput` for that replacement,
 * as above. An IME composition: the canvas's text, with rule R5 for its marks (the composed
 * text takes those of the first selected character; levels by today's rule).
 */
test('an IME composition or a keyless insertion over every selection gives the expected record, on a mounted view', async ({ page }) => {
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
      await page.waitForTimeout(60)
      const result = await page.evaluate(async ([src, a, b]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        // The canvas fed the same input: the frozen copy of the Fabric renderer's text code (`fabricTextOracle.ts`).
        type Oracle = { create: (src: object) => unknown; reconcile: (obj: unknown, pending?: unknown) => unknown; content: (obj: unknown) => unknown }
        const fo = (await load('/src/editor/testing/fabricTextOracle.ts')) as typeof import('../src/editor/testing/fabricTextOracle.ts')
        const frozen: Oracle = {
          create: (src) => fo.createFabricText({ left: 0, top: 0, angle: 0, width: 360, fontSize: 24, ...(src as { text: string }) }),
          reconcile: (obj, pending) => fo.reconcileFabricText(obj as never, pending as never),
          content: (obj) => fo.fabricTextContent(obj as never),
        }
        const { canonicalTextContent } = (await load('/src/model/textDoc.ts')) as typeof import('../src/model/textDoc.ts')
        const { docFromText } = (await load('/src/editor/textSchema.ts')) as typeof import('../src/editor/textSchema.ts')
        const { splitGraphemes, canonicalTextFormatting, headingsAfterEdit } = (await load('/src/model/richText.ts')) as typeof import('../src/model/richText.ts')
        const s = (window as unknown as { ss: import('../src/editor/textSession.ts').EditSession }).ss
        const text = (src as { text: string }).text
        const g = (o: number) => splitGraphemes(text.slice(0, o)).length // Fabric's character index
        // Rule R5, from the source record alone.
        const source = src as { text: string; spans?: Array<Record<string, unknown>>; headings?: number[] }
        const newText = text.slice(0, a as number) + 'カ' + text.slice(b as number)
        const delta = newText.length - text.length
        const first = text[a as number] === '\n' ? undefined : (source.spans ?? []).find((sp) => (sp.start as number) <= (a as number) && (sp.end as number) > (a as number))
        const { start: _s, end: _e, ...firstMarks } = first ?? {}
        void _s
        void _e
        const r5Spans: Array<Record<string, unknown>> = []
        for (const sp of source.spans ?? []) {
          if ((sp.start as number) < (a as number)) r5Spans.push({ ...sp, end: Math.min(sp.end as number, a as number) })
          if ((sp.end as number) > (b as number)) r5Spans.push({ ...sp, start: Math.max(sp.start as number, b as number) + delta, end: (sp.end as number) + delta })
        }
        if (Object.keys(firstMarks).length > 0) r5Spans.push({ start: a, end: (a as number) + 1, ...firstMarks })
        const r5 = { text: newText, ...canonicalTextFormatting(newText, { spans: r5Spans, headings: headingsAfterEdit(text, source.headings, newText, (a as number) + 1) }) }
        const fed = (oracle: Oracle) => {
          const obj = oracle.create(src as object) as {
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
          oracle.reconcile(obj)
          return canonicalTextContent(oracle.content(obj) as never)
        }
        const expected = fed(frozen)
        const got = s.content()
        return { expected, r5, got, live: docFromText(got)!.doc.eq(s.state.doc) }
      }, [src, a, b] as const)
      count++
      const want = how === 'ime' ? result.r5 : result.expected
      if (JSON.stringify(want) !== JSON.stringify(result.got) || result.got.text !== result.expected?.text || !result.live) fails.push({ how, src, a, b, ...result })
    }
  }
  console.log(`text engine parity (mounted, IME and keyless insertion): ${count} edits, ${fails.length} differ`)
  expect(fails.slice(0, 6)).toEqual([])
  expect(count).toBe(152)
})

/**
 * Real IME compositions (CDP `Input.imeSetComposition` updates, `Input.insertText` commits) on
 * a mounted view. A composition never starts over a selection: the selection is deleted at
 * `compositionstart`, and given back when the composition delivers nothing. While a composition
 * is open the browser and ProseMirror own the text and session commands are refused; as soon
 * as it has ended they work. Text and caret must equal the Fabric canvas fed the same input
 * (through the frozen copy of its text code, `fabricTextOracle.ts`): each composition update an
 * input of Fabric's real `onInput` (the textarea holding the candidate, its caret after it), keys
 * and pastes likewise, with the Fabric renderer's reconciling of the styles after each. Marks and levels: at a plain caret compared with that
 * same canvas record; over a selection, rule R5 (the composed text takes the marks of the
 * first selected character, levels by today's rule) asserted directly; after input that
 * followed a composition at once, text and caret only. After every scenario: the last record
 * `onChange` reported equals `content()`, equals the canonical form of the live document and
 * has exactly its text; and in-edit undo, step by step, walks back to the record the scenario
 * started from and redo forward to its end, every step's text and caret one the canvas had on
 * the way (its forward records). Every scenario runs twice: each command awaited, and all
 * commands sent at once without awaiting.
 */
test('real IME compositions keep exactly the text and caret the canvas keeps, and a canonical record, on a mounted view', async ({ page }) => {
  test.setTimeout(600_000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openBlank(page)
  const cdp = await page.context().newCDPSession(page)
  type Step =
    | { ime: string; at?: number }
    | { commit: string }
    | { commitKey: [string, string] }
    | { cancel: true }
    | { key: string }
    | { clip: string }
    | { wait: number }
    | { cmd: 'bold' | 'h2' | 'undo' | 'paste' }
    | { finish: true }
    | { start: true }
    | { end: true }
    | { blur: true }
    | { focusOffOnStart: true }
  type Source = { text: string; spans?: Array<Record<string, unknown>>; headings?: number[] }
  type Scenario = { name: string; src: Source; a: number; b: number; steps: Step[]; pending?: { italic?: boolean; font?: string }; marks: 'canvas' | 'r5' | 'none'; caret?: false }
  const compose = (updates: string[], commit: string): Step[] => [...updates.map((u) => ({ ime: u })), { commit }]
  // Shapes of compositions.
  const shapes: Array<[string, Step[]]> = [
    ['shrinks', compose(['かな', 'か'], 'か')],
    ['grows', compose(['k', 'ka', 'kan'], 'かん')],
    ['replaced by another string', compose(['か', 'かな'], 'な')],
    ['Hangul syllables', compose(['ㅎ', '하', '한', '한ㄱ', '한그', '한글'], '한글')],
    ['a syllable carried into the next', [...compose(['ㄱ', '가', '각'], '가'), ...compose(['가'], '각')]],
    ['three in a row', [...compose(['ㅎ', '하', '한'], '한'), ...compose(['ㄱ', '그', '글'], '글'), ...compose(['ㅇ', '이'], '이')]],
  ]
  const bold: Source = { text: 'aBCd', spans: [{ start: 1, end: 3, bold: true }] }
  const heading: Source = { text: 'XY\nAbc', headings: [0, 1], spans: [{ start: 3, end: 4, underline: true }, { start: 5, end: 6, italic: true }] }
  const plain: Source = { text: 'plain text' }
  const twoLines: Source = { text: 'ab\ncd', headings: [0, 2], spans: [{ start: 0, end: 2, italic: true }, { start: 3, end: 4, bold: true }] }
  const places: Array<{ name: string; src: Source; a: number; b: number; marks: Scenario['marks'] }> = [
    { name: 'plain caret', src: plain, a: 5, b: 5, marks: 'canvas' },
    { name: 'caret inside bold text', src: bold, a: 2, b: 2, marks: 'canvas' },
    { name: 'caret inside a heading', src: heading, a: 4, b: 4, marks: 'canvas' },
    { name: 'start of the text', src: bold, a: 0, b: 0, marks: 'none' },
    { name: 'end of the text', src: heading, a: 6, b: 6, marks: 'canvas' },
    { name: 'selection within a line', src: bold, a: 1, b: 3, marks: 'r5' },
    { name: 'selection across a line break', src: twoLines, a: 1, b: 4, marks: 'r5' },
  ]
  // `AbCD`, `Ab` selected: `A` bold and `D` underlined (a selection across marks), or `Ab` italic (inside one mark).
  const mixed: Source = { text: 'AbCD', spans: [{ start: 0, end: 1, bold: true }, { start: 3, end: 4, underline: true }] }
  const sameMark: Source = { text: 'AbCD', spans: [{ start: 0, end: 2, italic: true }] }
  const overSelection: Array<[string, Step[]]> = [
    ['ㄱ → 가 → 각, commit 가', compose(['ㄱ', '가', '각'], '가')],
    ['a candidate, then a direct commit', compose(['ㄱ'], '가')],
    ['two committed compositions', [...compose(['ㄱ'], 'ㄱ'), ...compose(['가'], '가')]],
  ]
  const followers: Array<[string, Step[]]> = [
    ['a typed x', [{ key: 'x' }]],
    ['Enter', [{ key: 'Enter' }]],
    ['Backspace', [{ key: 'Backspace' }]],
    ['Delete', [{ key: 'Delete' }]],
    ['a native clipboard paste', [{ clip: 'P' }]],
    ['another composition', compose(['ㄴ'], '나')],
    ['Ctrl+A, then x', [{ key: 'Control+a' }, { key: 'x' }]],
    ['ArrowLeft, then x', [{ key: 'ArrowLeft' }, { key: 'x' }]],
    ['Ctrl+Z, then Ctrl+Y', [{ key: 'Control+z' }, { key: 'Control+y' }]],
    ['Ctrl+Z, 100 ms, then Ctrl+Y', [{ key: 'Control+z' }, { wait: 100 }, { key: 'Control+y' }]],
    ['Ctrl+Z', [{ key: 'Control+z' }]],
  ]
  const bcD: Source = { text: 'bcD', spans: [{ start: 0, end: 1, bold: true }, { start: 2, end: 3, underline: true }] }
  const after: Array<[string, Step[]]> = [
    ['Enter', [{ key: 'Enter' }]],
    ['Backspace', [{ key: 'Backspace' }]],
    ['Delete', [{ key: 'Delete' }]],
    ['an arrow key, then a typed character', [{ key: 'ArrowLeft' }, { key: 'x' }]],
    ['a typed character', [{ key: 'x' }]],
    ['a native clipboard paste', [{ clip: 'P' }]],
    ['a formatting command, then a typed character', [{ cmd: 'bold' }, { key: 'x' }]],
    ['a heading command', [{ cmd: 'h2' }]],
    ['a paste through the session, then a typed character', [{ cmd: 'paste' }, { key: 'x' }]],
    ['in-edit undo through the session', [{ cmd: 'undo' }]],
    ['finish()', [{ finish: true }]],
  ]
  const korean = Array.from('한국어로음악리뷰를쓰는중입니다오늘은좋아')
  const initial = (syllable: string) => 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'[Math.floor((syllable.charCodeAt(0) - 0xac00) / 588)]!
  const kana = 'きょうはあたらしいれこーどをききながらながいぶんしょう'
  const abcd: Source = { text: 'abcd' }
  const runs3: Step[] = [...compose(['か', 'かな'], '仮名'), { key: 'ArrowLeft' }, { key: 'x' }, { key: 'End' }, ...compose(['ㄱ', '가'], '가'), { key: 'Shift+ArrowLeft' }, ...compose(['な'], '名'), { key: 'y' }]
  const scenarios: Scenario[] = [
    // The reviewers' scenarios.
    { name: 'case 1: `A|なZ`, `か` → `かな`, commit `か`, then a character typed at once', src: { text: 'AなZ' }, a: 1, b: 1, steps: [...compose(['か', 'かな'], 'か'), { key: 'x' }], marks: 'canvas' },
    { name: 'case 3: a heading command during the preedit (refused)', src: bcD, a: 1, b: 2, steps: [{ ime: 'か' }, { cmd: 'h2' }, { ime: 'かな' }, { commit: '仮名' }], marks: 'r5' },
    { name: 'a formatting command during the preedit (refused)', src: bcD, a: 1, b: 2, steps: [{ ime: 'か' }, { cmd: 'bold' }, { ime: 'かな' }, { commit: '仮名' }], marks: 'r5' },
    { name: 'a heading command during the preedit on line one (refused), commit, then ArrowDown', src: { text: 'a\nbc' }, a: 1, b: 1, steps: [{ ime: 'か' }, { cmd: 'h2' }, { commit: '仮' }, { key: 'ArrowDown' }], marks: 'canvas', caret: false },
    { name: '`a|b`, commit `仮`, a paste through the session at once (it runs), then x', src: { text: 'ab' }, a: 1, b: 1, steps: [{ ime: 'か' }, { commit: '仮' }, { cmd: 'paste' }, { key: 'x' }], marks: 'canvas' },
    { name: 'over the selection across marks, commit, Ctrl+A at once, 75 ms, then x', src: mixed, a: 0, b: 2, steps: [...compose(['ㄱ', '가', '각'], '가'), { key: 'Control+a' }, { wait: 75 }, { key: 'x' }], marks: 'none' },
    { name: 'B2 (b): `pqABcd`, `AB` italic monospace selected, `かな` → `か`, commit, Left, x, 75 ms, undo, redo, 75 ms, x', src: { text: 'pqABcd', spans: [{ start: 2, end: 4, italic: true, font: 'mono' }] }, a: 2, b: 4, steps: [...compose(['かな', 'か'], 'か'), { key: 'ArrowLeft' }, { key: 'x' }, { wait: 75 }, { key: 'Control+z' }, { key: 'Control+y' }, { wait: 75 }, { key: 'x' }], marks: 'none' },
    ...(['Control+b', 'Control+i', 'Control+u'] as const).map((k): Scenario => ({ name: `A2: \`ab|cd\`, commit \`가\`, ${k} at once, then x`, src: abcd, a: 2, b: 2, steps: [...compose(['ㄱ', '가'], '가'), { key: k }, { key: 'x' }], marks: 'canvas' })),
    // Committed by a key arriving in the same instant as the commit, as with a real IME.
    ...(['ArrowLeft', 'Enter', 'Space', 'Control+z'] as const).flatMap((k): Scenario[] => [
      { name: `committed by ${k}, at a caret`, src: bold, a: 2, b: 2, steps: [...compose(['か'], ''), { commitKey: ['かな', k] }], marks: k === 'Control+z' ? 'none' : 'canvas' },
      { name: `committed by ${k}, over the selection across marks`, src: mixed, a: 0, b: 2, steps: [{ ime: 'ㄱ' }, { ime: '가' }, { commitKey: ['가', k] }], marks: 'none' },
    ]).map((s) => ({ ...s, steps: s.steps.filter((st) => !('commit' in st && st.commit === '')) })),
    // Undo and redo walks after runs of compositions over selections with keys in between.
    { name: 'compositions over selections with keys between, then Ctrl+Z three times and Ctrl+Y twice', src: mixed, a: 0, b: 2, steps: [...runs3, { key: 'Control+z' }, { key: 'Control+z' }, { key: 'Control+z' }, { key: 'Control+y' }, { key: 'Control+y' }], marks: 'none' },
    { name: 'compositions over selections with keys between', src: twoLines, a: 1, b: 4, steps: runs3, marks: 'none' },
    // A composition that composes nothing.
    { name: 'compositionstart with nothing composed, then the edit loses focus', src: mixed, a: 0, b: 2, steps: [{ start: true }, { blur: true }], marks: 'canvas' },
    { name: 'compositionstart with nothing composed, then finish()', src: mixed, a: 0, b: 2, steps: [{ start: true }, { finish: true }], marks: 'canvas' },
    { name: 'compositionstart and compositionend with nothing composed, then a normal composition', src: mixed, a: 0, b: 2, steps: [{ start: true }, { end: true }, ...compose(['か'], '名')], marks: 'r5' },
    { name: 'a composition whose start moves focus out of the edit', src: mixed, a: 0, b: 2, steps: [{ focusOffOnStart: true }, { ime: 'か' }, { wait: 80 }], marks: 'canvas' },
    // Other compositions.
    { name: '`XY`, `X` selected, `か` → `かな`, commit `な`', src: { text: 'XY' }, a: 0, b: 1, steps: compose(['か', 'かな'], 'な'), marks: 'r5' },
    { name: 'the IME’s caret inside a character of the candidate (`e` and an accent, the caret between)', src: plain, a: 5, b: 5, steps: [{ ime: 'e' }, { ime: 'é', at: 1 }, { ime: 'éx', at: 1 }, { commit: 'éx' }, { key: 'y' }], marks: 'canvas' },
    { name: 'a composition cancelled and restarted', src: bold, a: 2, b: 2, steps: [{ ime: 'か' }, { ime: 'かな' }, { cancel: true }, ...compose(['な'], '名')], marks: 'canvas' },
    { name: 'pending italic and mono at a caret', src: plain, a: 5, b: 5, pending: { italic: true, font: 'mono' }, steps: compose(['か', 'かな'], '仮名'), marks: 'canvas' },
    { name: 'a 20-syllable Korean sentence', src: plain, a: 10, b: 10, steps: korean.flatMap((s) => compose([initial(s), s], s)), marks: 'canvas' },
    { name: 'a 30-character Japanese sentence', src: plain, a: 10, b: 10, steps: compose(Array.from(kana).map((_, i) => kana.slice(0, i + 1)), '今日は新しいレコードを聴きながら長い文章'), marks: 'canvas' },
    ...places.flatMap((p) => shapes.map(([shape, steps]): Scenario => ({ name: `${shape}, ${p.name}`, src: p.src, a: p.a, b: p.b, steps, marks: p.marks }))),
    ...after.map(([what, steps]): Scenario => ({ name: `a composition followed at once by ${what}`, src: bold, a: 2, b: 2, steps: [...compose(['か', 'かな'], '仮名'), ...steps], marks: steps.some((st) => 'cmd' in st) ? 'none' : 'canvas' })),
    ...([['across marks', mixed], ['inside one mark', sameMark]] as const).flatMap(([where, src]) =>
      overSelection.flatMap(([shape, steps]): Scenario[] => [
        { name: `${shape}, over the selection ${where}`, src, a: 0, b: 2, steps, marks: 'r5' },
        ...followers.map(([what, more]): Scenario => ({ name: `${shape}, over the selection ${where}, then ${what} at once`, src, a: 0, b: 2, steps: [...steps, ...more], marks: 'none' })),
      ]),
    ),
  ]

  const fails: unknown[] = []
  let runs = 0
  let refused = 0
  let ran = 0
  const gaps: number[] = []
  for (const scenario of scenarios) {
    for (const mode of ['awaited', 'at once'] as const) {
      const clip = scenario.steps.find((st): st is { clip: string } => 'clip' in st)?.clip
      await page.evaluate(async ([src, a, b, pending, clip]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        const { createEditSession } = (await load('/src/editor/textSession.ts')) as typeof import('../src/editor/textSession.ts')
        const w = window as unknown as { ss?: { finish(): void }; reported?: unknown; commands: unknown[]; times: { end: number; gaps: number[] } }
        w.ss?.finish()
        document.body.replaceChildren()
        const el = document.createElement('div')
        el.style.whiteSpace = 'pre-wrap'
        const outside = document.createElement('textarea')
        outside.id = 'outside'
        document.body.append(el, outside)
        w.reported = undefined
        w.commands = []
        w.times = { end: 0, gaps: [] }
        const s = createEditSession(src as never, { onChange: (c) => (w.reported = c) })!
        ;(window as unknown as { ss: unknown }).ss = s
        s.mount(el).focus()
        // How soon after a commit the next key arrives.
        el.addEventListener('compositionend', () => (w.times.end = performance.now()))
        el.addEventListener('keydown', () => {
          if (w.times.end > 0) w.times.gaps.push(performance.now() - w.times.end)
          w.times.end = 0
        })
        s.select(a as number, b as number)
        const p = pending as { italic?: boolean; font?: string } | undefined
        if (p?.italic) s.toggleMark('italic')
        if (p?.font) s.setFont(p.font as never)
        if (clip !== undefined) await navigator.clipboard.writeText(clip as string)
      }, [scenario.src, scenario.a, scenario.b, scenario.pending, clip] as const)
      // ProseMirror puts its own selection back 20 ms after gaining focus if the browser's is unchanged: no one types that soon.
      await page.waitForTimeout(40)
      const sent: Array<Promise<unknown>> = []
      const send = async (p: Promise<unknown>) => {
        if (mode === 'awaited') await p
        else sent.push(p)
      }
      for (const step of scenario.steps) {
        if ('ime' in step) await send(cdp.send('Input.imeSetComposition', { text: step.ime, selectionStart: step.at ?? step.ime.length, selectionEnd: step.at ?? step.ime.length }))
        else if ('commit' in step) await send(cdp.send('Input.insertText', { text: step.commit }))
        else if ('commitKey' in step) {
          // The commit and the key that ends the composition, in the same instant.
          await Promise.all([...sent.splice(0), cdp.send('Input.insertText', { text: step.commitKey[0] }), page.keyboard.press(step.commitKey[1])])
        } else if ('cancel' in step) {
          // No CDP command cancels a composition: an empty candidate, then an empty commit.
          await send(cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }))
          await send(cdp.send('Input.insertText', { text: '' }))
        } else {
          // Keys and session commands come in order after what was sent before them.
          await Promise.all(sent.splice(0))
          if ('key' in step) await page.keyboard.press(step.key)
          else if ('clip' in step) await page.keyboard.press('Control+v')
          else if ('wait' in step) await page.waitForTimeout(step.wait)
          else
            await page.evaluate((st: Record<string, unknown>) => {
              const w = window as unknown as { ss: import('../src/editor/textSession.ts').EditSession; commands: unknown[] }
              const s = w.ss
              const el = s.view?.dom as HTMLElement | undefined
              if ('finish' in st) return s.finish()
              if ('start' in st || 'end' in st) return void el?.dispatchEvent(new CompositionEvent('start' in st ? 'compositionstart' : 'compositionend', { bubbles: true, data: '' }))
              if ('blur' in st) return document.getElementById('outside')!.focus()
              if ('focusOffOnStart' in st) return el?.addEventListener('compositionstart', () => document.getElementById('outside')!.focus(), { once: true })
              const settling = s.settling
              const before = JSON.stringify(s.content())
              const ret = st.cmd === 'bold' ? s.toggleMark('bold') : st.cmd === 'h2' ? s.setHeading(2) : st.cmd === 'undo' ? s.undo() : s.paste({ text: 'P' })
              w.commands.push({ cmd: st.cmd, settling, ret, changed: JSON.stringify(s.content()) !== before })
            }, step as Record<string, unknown>)
        }
      }
      await Promise.all(sent.splice(0))
      await page.waitForTimeout(40)
      const result = await page.evaluate(async ([src, a, b, steps, pending]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        // The canvas fed the same input: the frozen copy of the Fabric renderer's text code (`fabricTextOracle.ts`).
        type Oracle = { create: (src: object) => unknown; reconcile: (obj: unknown, pending?: unknown) => unknown; content: (obj: unknown) => unknown }
        const fo = (await load('/src/editor/testing/fabricTextOracle.ts')) as typeof import('../src/editor/testing/fabricTextOracle.ts')
        const frozen: Oracle = {
          create: (src) => fo.createFabricText({ left: 0, top: 0, angle: 0, width: 360, fontSize: 24, ...(src as { text: string }) }),
          reconcile: (obj, pending) => fo.reconcileFabricText(obj as never, pending as never),
          content: (obj) => fo.fabricTextContent(obj as never),
        }
        const { canonicalTextContent } = (await load('/src/model/textDoc.ts')) as typeof import('../src/model/textDoc.ts')
        const { docFromText, contentFromDoc, plainTextOfDoc } = (await load('/src/editor/textSchema.ts')) as typeof import('../src/editor/textSchema.ts')
        const { splitGraphemes, canonicalTextFormatting, headingsAfterEdit } = (await load('/src/model/richText.ts')) as typeof import('../src/model/richText.ts')
        const w = window as unknown as { ss: import('../src/editor/textSession.ts').EditSession; reported?: unknown; commands: Array<{ cmd: string; settling: boolean; ret: boolean; changed: boolean }>; times: { gaps: number[] } }
        const s = w.ss
        const source = src as { text: string; spans?: Array<Record<string, unknown>>; headings?: number[] }
        const g = (t: string, o: number) => splitGraphemes(t.slice(0, o)).length
        const off = (t: string, gi: number) => splitGraphemes(t).slice(0, gi).join('').length
        // ---- the canvas fed the same input
        const feed = (oracle: Oracle) => {
        const obj = oracle.create(source) as {
          isEditing: boolean
          inCompositionMode: boolean
          hiddenTextarea: HTMLTextAreaElement
          selectionStart: number
          selectionEnd: number
          onInput(e: Event): void
        }
        let value = source.text
        obj.isEditing = true
        obj.hiddenTextarea = document.createElement('textarea')
        obj.selectionStart = g(value, a as number)
        obj.selectionEnd = g(value, b as number)
        // The editor's pending choices go to what the canvas inserts (the reconciling's \`pending\`); Ctrl+B, I or U at a caret adds to them.
        const p = pending as { italic?: boolean; font?: string } | undefined
        let pend: Record<string, unknown> | undefined = p ? { ...(p.italic ? { italic: true } : {}), ...(p.font ? { font: p.font } : {}) } : undefined
        const input = (next: string, caret: number, type: string) => {
          value = next
          obj.hiddenTextarea.value = next
          obj.hiddenTextarea.setSelectionRange(caret, caret)
          obj.onInput(new InputEvent('input', { inputType: type }))
          oracle.reconcile(obj, pend)
        }
        /** Replaces the selection (or inserts at the caret) as the textarea does. */
        const replace = (text: string, type: string) => {
          const from = off(value, obj.selectionStart)
          const to = off(value, obj.selectionEnd)
          input(value.slice(0, from) + text + value.slice(to), from + text.length, type)
        }
        const records: Array<[string, number]> = [[value, off(value, obj.selectionEnd)]]
        const commands = [...w.commands]
        let comp: { before: string; after: string; first: boolean; selected: boolean } | null = null
        let away = false
        let undos = 0
        const list = (steps as Array<Record<string, unknown>>).flatMap((st) => ('commitKey' in st ? [{ commit: (st.commitKey as string[])[0] }, { key: (st.commitKey as string[])[1] }] : [st]))
        for (const st of list) {
          if ('focusOffOnStart' in st) away = true
          else if (away && ('ime' in st || 'commit' in st)) {
            // The composition went to the element focus moved to.
          } else if ('ime' in st || 'commit' in st || 'cancel' in st) {
            if (!comp) {
              const from = off(value, obj.selectionStart)
              const to = off(value, obj.selectionEnd)
              comp = { before: value.slice(0, from), after: value.slice(to), first: true, selected: from !== to }
              obj.inCompositionMode = true
            }
            const candidate = 'ime' in st ? (st.ime as string) : 'commit' in st ? (st.commit as string) : ''
            const next = comp.before + candidate + comp.after
            if (next !== value || (comp.first && comp.selected)) input(next, comp.before.length + candidate.length, 'insertCompositionText')
            comp.first = false
            if (!('ime' in st)) {
              comp = null
              obj.inCompositionMode = false
            }
          } else if ('key' in st) {
            const from = off(value, obj.selectionStart)
            const to = off(value, obj.selectionEnd)
            const key = st.key as string
            if (key === 'Enter') replace('\n', 'insertLineBreak')
            else if (key === 'Space') replace(' ', 'insertText')
            else if (key === 'Backspace' || key === 'Delete') {
              if (from !== to) replace('', 'deleteContentBackward')
              else if (key === 'Backspace') {
                const gone = splitGraphemes(value.slice(0, from)).pop() ?? ''
                input(value.slice(0, from - gone.length) + value.slice(from), from - gone.length, 'deleteContentBackward')
              } else {
                const gone = splitGraphemes(value.slice(from))[0] ?? ''
                input(value.slice(0, from) + value.slice(from + gone.length), from, 'deleteContentForward')
              }
            } else if (key === 'ArrowLeft') obj.selectionStart = obj.selectionEnd = from !== to ? obj.selectionStart : Math.max(0, obj.selectionEnd - 1)
            else if (key === 'Shift+ArrowLeft') obj.selectionStart = Math.max(0, obj.selectionStart - 1)
            else if (key === 'ArrowDown') obj.selectionStart = obj.selectionEnd = splitGraphemes(value).length
            else if (key === 'End') {
              const lineEnd = value.indexOf('\n', to)
              obj.selectionStart = obj.selectionEnd = g(value, lineEnd < 0 ? value.length : lineEnd)
            } else if (key === 'Control+a') {
              obj.selectionStart = 0
              obj.selectionEnd = splitGraphemes(value).length
            } else if (key === 'Control+b' || key === 'Control+i' || key === 'Control+u') pend = { ...pend, [key === 'Control+b' ? 'bold' : key === 'Control+i' ? 'italic' : 'underline']: true }
            else if (key === 'Control+z') undos++
            else if (key === 'Control+y') undos--
            else replace(key, 'insertText')
          } else if ('clip' in st) replace(st.clip as string, 'insertFromPaste')
          else if ('cmd' in st) {
            const c = commands.shift()
            if (c && !c.settling && st.cmd === 'paste') replace('P', 'insertFromPaste')
            if (c && !c.settling && st.cmd === 'undo') undos++
          }
          const now: [string, number] = [value, off(value, obj.selectionEnd)]
          if (!records.some(([t, c]) => t === now[0] && c === now[1])) records.push(now)
        }
        const canvas = canonicalTextContent(oracle.content(obj) as never)!
        const canvasCaret = off(value, obj.selectionEnd)
        return { canvas, canvasCaret, records, value, undos }
        }
        const { canvas, canvasCaret, records, value, undos } = feed(frozen)
        // ---- rule R5 for a run of compositions over a selection
        const text = source.text
        const r5 = (() => {
          const newText = canvas.text
          const delta = newText.length - text.length
          const first = text[a as number] === '\n' ? undefined : (source.spans ?? []).find((sp) => (sp.start as number) <= (a as number) && (sp.end as number) > (a as number))
          const { start: _s, end: _e, ...firstMarks } = first ?? {}
          void _s
          void _e
          const spans: Array<Record<string, unknown>> = []
          for (const sp of source.spans ?? []) {
            if ((sp.start as number) < (a as number)) spans.push({ ...sp, end: Math.min(sp.end as number, a as number) })
            if ((sp.end as number) > (b as number)) spans.push({ ...sp, start: Math.max(sp.start as number, b as number) + delta, end: (sp.end as number) + delta })
          }
          const composedEnd = (b as number) + delta
          if (Object.keys(firstMarks).length > 0 && composedEnd > (a as number)) spans.push({ start: a, end: composedEnd, ...firstMarks })
          const headings = headingsAfterEdit(text, source.headings, newText, canvasCaret)
          return { text: newText, ...canonicalTextFormatting(newText, { spans, headings }) }
        })()
        const got = s.content()
        const gotCaret = s.selection().head
        const live = docFromText(got)!.doc.eq(s.state.doc)
        // ---- the last record reported, content(), the canonical form of the live document, its text
        const reported = JSON.stringify(w.reported ?? canonicalTextContent(source as never))
        const liveContent = contentFromDoc(s.state.doc, got)
        const n5 = reported === JSON.stringify(got) && JSON.stringify(got) === JSON.stringify(canonicalTextContent(liveContent as never)) && got.text === plainTextOfDoc(s.state.doc)
        // ---- in-edit undo back to the start, redo forward to the end: every step a forward record
        const known = (t: string, c: number) => records.some(([rt, rc]) => rt === t && rc === c)
        const offRecord: string[] = []
        let walk = true
        if (!s.finished && !s.composing) {
          const at = () => [s.content().text, s.selection().head] as const
          for (let i = 0; i < 500 && s.canUndo && s.undo(); i++) if (!known(...at())) offRecord.push(`undo ${JSON.stringify(at())}`)
          walk = s.content().text === source.text
          for (let i = 0; i < 500 && s.canRedo && s.redo(); i++) if (!known(...at())) offRecord.push(`redo ${JSON.stringify(at())}`)
          walk &&= s.content().text === value
        }
        return {
          got,
          gotCaret,
          canvas,
          canvasCaret,
          r5,
          undone: undos > 0,
          onRecord: known(got.text, gotCaret),
          finished: s.finished,
          composing: s.composing,
          settling: s.settling,
          canonical: JSON.stringify(got) === JSON.stringify(canonicalTextContent(got as never)),
          live,
          n5,
          walk,
          offRecord,
          commands: w.commands,
          gaps: w.times.gaps,
        }
      }, [scenario.src, scenario.a, scenario.b, scenario.steps, scenario.pending] as const)
      runs++
      gaps.push(...result.gaps)
      const problems: string[] = []
      if (result.undone) {
        // Undone with the keyboard: some earlier state the canvas had, and redo leads back to the end.
        if (!result.onRecord) problems.push('undo left a state the canvas never had')
      } else {
        if (result.got.text !== result.canvas.text) problems.push('text')
        if (!result.finished && scenario.caret !== false && result.gotCaret !== result.canvasCaret) problems.push('caret')
        if (scenario.marks === 'canvas' && JSON.stringify(result.got) !== JSON.stringify(result.canvas)) problems.push('marks and levels (canvas)')
        if (scenario.marks === 'r5' && JSON.stringify(result.got) !== JSON.stringify(result.r5)) problems.push('marks and levels (R5)')
      }
      for (const c of result.commands) {
        if (c.settling) {
          if (c.ret !== false || c.changed) problems.push(`${c.cmd} not refused during a composition`)
          else refused++
        } else if (c.ret !== true) problems.push(`${c.cmd} refused after the composition had ended`)
        else ran++
      }
      if (result.composing || result.settling) problems.push('still composing')
      if (!result.canonical) problems.push('record not canonical')
      if (!result.live) problems.push('document is not the record')
      if (!result.n5) problems.push('reported record, content() and live document differ')
      if (!result.walk) problems.push('undo/redo walk did not reach both ends')
      if (result.offRecord.length) problems.push(`undo/redo off the forward records: ${result.offRecord.join(' ')}`)
      if (problems.length > 0) fails.push({ scenario: scenario.name, mode, problems, ...result })
    }
  }
  console.log(`text engine compositions (real IME, mounted): ${scenarios.length} scenarios, ${runs} runs, ${fails.length} with problems; ${refused} session commands refused during a composition, ${ran} run straight after one; ${gaps.length} keys straight after a commit, ${gaps.filter((t) => t <= 12).length} within 12 ms (median ${[...gaps].sort((x, y) => x - y)[gaps.length >> 1]?.toFixed(1)} ms)`)
  for (const f of fails as Array<{ scenario: string; mode: string; problems: string[]; got: { text: string }; gotCaret: number; canvas: { text: string }; canvasCaret: number }>)
    console.log(`  ${f.scenario} (${f.mode}): ${f.problems.join(', ')}; engine ${JSON.stringify(f.got.text)}@${f.gotCaret}, canvas ${JSON.stringify(f.canvas.text)}@${f.canvasCaret}`)
  expect(fails.slice(0, 4)).toEqual([])
  expect(runs).toBe(scenarios.length * 2)
})

/**
 * Caret and selection keys on a mounted view, within 200 ms of the view taking focus (ProseMirror
 * takes a caret at the start of the text then for the browser resetting the selection; the
 * session keeps a key's own move there). The rule is the browser's own
 * behaviour: each key is pressed in a plain contenteditable holding the same HTML, then in the
 * engine, from the same starting selection. After each key the engine's selection, the
 * selection the browser shows in it, and the native one must agree; a character typed then
 * must give the native text. Starts: select-all, carets on each line, a backward selection.
 */
test('caret and selection keys do what the browser does, and what is typed lands where the selection is shown', async ({ page }) => {
  test.setTimeout(300_000)
  await openBlank(page)
  const rec = { text: 'ab cd\nHead line\nef gh', headings: [0, 2, 0] }
  const html = '<p>ab cd</p><h2>Head line</h2><p>ef gh</p>'
  const starts: Array<[string, number, number]> = [['select-all', -1, -1], ['caret at the start', 0, 0], ['caret in line one', 4, 4], ['caret at the start of the heading', 6, 6], ['caret in the heading', 11, 11], ['caret at the end', 21, 21], ['backward selection', 13, 3]]
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+Home', 'Shift+End', 'Control+ArrowLeft', 'Control+ArrowRight', 'Control+Shift+ArrowLeft', 'Control+Shift+ArrowRight', 'Control+Home', 'Control+End']
  const sequences: string[][] = [...keys.map((k) => [k]), ['ArrowLeft', 'Shift+ArrowRight'], ['Home', 'Shift+ArrowRight'], ['ArrowUp', 'Shift+End']]
  const setup = (kind: string, anchor: number, head: number) =>
    page.evaluate(
      async ([kind, rec, html, anchor, head]) => {
        const { createEditSession } = (await import(/* @vite-ignore */ '/src/editor/textSession.ts' as string)) as typeof import('../src/editor/textSession.ts')
        const w = window as unknown as { ss?: { finish(): void }; probe: () => { dom: [number, number]; state?: [number, number]; text: string } }
        w.ss?.finish()
        w.ss = undefined
        document.body.replaceChildren()
        const el = document.createElement('div')
        el.style.whiteSpace = 'pre-wrap'
        document.body.append(el)
        /** A DOM point as a UTF-16 offset into the text (lines joined by "\n"). */
        const offsetOf = (node: Node, offset: number): number => {
          const blocks = Array.from(el.children)
          if (node === el) return blocks.slice(0, offset).reduce((n, bl) => n + (bl.textContent ?? '').length + 1, 0) - (offset > 0 && offset === blocks.length ? 1 : 0)
          const i = blocks.findIndex((bl) => bl.contains(node))
          const range = document.createRange()
          range.setStart(blocks[i]!, 0)
          range.setEnd(node, offset)
          return blocks.slice(0, i).reduce((n, bl) => n + (bl.textContent ?? '').length + 1, 0) + range.toString().length
        }
        const dom = (): [number, number] => {
          const sel = getSelection()!
          return [offsetOf(sel.anchorNode!, sel.anchorOffset), offsetOf(sel.focusNode!, sel.focusOffset)]
        }
        const text = () => Array.from(el.children, (c) => c.textContent).join('\n')
        if (kind === 'native') {
          el.contentEditable = 'true'
          el.innerHTML = html as string
          el.focus()
          if ((anchor as number) >= 0) {
            const at = (o: number): [Node, number] => {
              const blocks = Array.from(el.children)
              let rest = o
              for (const bl of blocks) {
                const len = (bl.textContent ?? '').length
                if (rest <= len) return [bl.firstChild ?? bl, rest]
                rest -= len + 1
              }
              return [el, blocks.length]
            }
            getSelection()!.setBaseAndExtent(...at(anchor as number), ...at(head as number))
          }
          w.probe = () => ({ dom: dom(), text: text() })
        } else {
          const s = createEditSession(rec as never)!
          w.ss = s
          s.mount(el).focus()
          if ((anchor as number) >= 0) s.select(anchor as number, head as number)
          w.probe = () => ({ dom: dom(), state: [s.selection().anchor, s.selection().head], text: s.content().text })
        }
      },
      [kind, rec, html, anchor, head] as const,
    )
  const probe = () => page.evaluate(() => (window as unknown as { probe: () => { dom: [number, number]; state?: [number, number]; text: string } }).probe())
  const fails: string[] = []
  let count = 0
  for (const [name, anchor, head] of starts) {
    for (const seq of sequences) {
      const seen: Record<string, Array<{ dom: [number, number]; state?: [number, number]; text: string }>> = {}
      for (const kind of ['native', 'engine']) {
        await setup(kind, anchor, head)
        // ProseMirror puts its own selection back 20 ms after gaining focus if the browser's is unchanged: no one presses a key that soon.
        await page.waitForTimeout(40)
        if (anchor < 0) await page.keyboard.press('Control+a')
        const steps: Array<{ dom: [number, number]; state?: [number, number]; text: string }> = []
        for (const k of seq) {
          await page.keyboard.press(k)
          // The browser reports a key's move by `selectionchange` a moment later; a person's next key comes later than that.
          await page.waitForTimeout(30)
          steps.push(await probe())
        }
        await page.keyboard.press('x')
        steps.push(await probe())
        seen[kind] = steps
      }
      count++
      const n = seen.native!
      const e = seen.engine!
      const where = `${name}, ${seq.join(' ')}`
      seq.forEach((k, i) => {
        if (JSON.stringify(e[i]!.dom) !== JSON.stringify(e[i]!.state)) fails.push(`${where}: after ${k} the engine has ${JSON.stringify(e[i]!.state)} but shows ${JSON.stringify(e[i]!.dom)}`)
        if (JSON.stringify(e[i]!.dom) !== JSON.stringify(n[i]!.dom)) fails.push(`${where}: after ${k} the engine shows ${JSON.stringify(e[i]!.dom)}, the browser ${JSON.stringify(n[i]!.dom)}`)
      })
      if (e[seq.length]!.text !== n[seq.length]!.text) fails.push(`${where}, then x: engine ${JSON.stringify(e[seq.length]!.text)}, browser ${JSON.stringify(n[seq.length]!.text)}`)
    }
  }
  console.log(`selection keys (mounted, within 200 ms of focus): ${count} sequences from ${starts.length} starts, ${fails.length} differences`)
  for (const f of fails.slice(0, 20)) console.log('  ' + f)
  expect(fails).toEqual([])
  expect(count).toBe(starts.length * sequences.length)
})

/** The reviewer's case, against the canvas too: select-all, Left, Shift+Right, x replaces only the first character. */
test('after select-all, Left and Shift+Right select the first character, and typing replaces only it, as on the canvas', async ({ page }) => {
  await openBlank(page)
  const out = await page.evaluate(async () => {
    const { createEditSession } = (await import(/* @vite-ignore */ '/src/editor/textSession.ts' as string)) as typeof import('../src/editor/textSession.ts')
    document.body.replaceChildren(Object.assign(document.createElement('h1'), { textContent: 'other content' }))
    const el = document.createElement('div')
    el.style.whiteSpace = 'pre-wrap'
    document.body.append(el)
    const s = createEditSession({ text: 'ab\nCD\nef', headings: [0, 2, 0] } as never)!
    ;(window as unknown as { ss: unknown }).ss = s
    s.mount(el).focus()
    s.select(0)
    return true
  })
  expect(out).toBe(true)
  for (const k of ['Control+a', 'ArrowLeft', 'Shift+ArrowRight', 'x']) {
    await page.keyboard.press(k)
    await page.waitForTimeout(80)
  }
  const got = await page.evaluate(() => (window as unknown as { ss: import('../src/editor/textSession.ts').EditSession }).ss.content())
  expect(got).toStrictEqual({ text: 'xb\nCD\nef', headings: [0, 2] })
})

/**
 * Focus coming back to the editor: Chromium puts the DOM caret at the start of the text, and
 * ProseMirror gives back the selection the session had (no key moved it). In `ab|cd` type `x`,
 * focus goes away and comes back, then a character or an IME commit: it lands after the `x`,
 * or where the person clicked. Focus returns by Tab from an input before the editor, by a click
 * on the editor's own text (after its last character), by `view.focus()`, and by the window
 * losing and regaining focus; the next input comes at once, 40 or 250 ms later.
 */
test('focus coming back to the editor keeps the caret where it was, or puts it where the click was', async ({ page }) => {
  test.setTimeout(240_000)
  await openBlank(page)
  const cdp = await page.context().newCDPSession(page)
  const fails: string[] = []
  let count = 0
  for (const back of ['Tab', 'a click on the text', 'view.focus()', 'the window regaining focus'] as const) {
    for (const next of ['q', 'an IME commit'] as const) {
      for (const delay of [0, 40, 250]) {
        await page.evaluate(async () => {
          const { createEditSession } = (await import(/* @vite-ignore */ '/src/editor/textSession.ts' as string)) as typeof import('../src/editor/textSession.ts')
          const w = window as unknown as { ss?: { finish(): void } }
          w.ss?.finish()
          const other = document.createElement('input')
          other.id = 'other'
          const el = document.createElement('div')
          el.style.whiteSpace = 'pre-wrap'
          el.style.font = '24px sans-serif'
          document.body.replaceChildren(other, el)
          const s = createEditSession({ text: 'abcd' } as never)!
          ;(window as unknown as { ss: unknown }).ss = s
          s.mount(el).focus()
          s.select(2)
        })
        await page.waitForTimeout(300) // the edit has been open a while
        await page.keyboard.press('x')
        await page.waitForTimeout(40)
        let wantText = 'abx?cd'
        if (back === 'the window regaining focus') {
          const away = await page.context().newPage()
          await away.bringToFront()
          await page.waitForTimeout(40)
          await page.bringToFront()
          await away.close()
        } else {
          await page.click('#other')
          await page.waitForTimeout(40)
          if (back === 'Tab') await page.keyboard.press('Tab')
          else if (back === 'view.focus()') await page.evaluate(() => (window as unknown as { ss: import('../src/editor/textSession.ts').EditSession }).ss.view!.focus())
          else {
            // After the last character: the caret goes there.
            const box = await page.evaluate(() => {
              const p = (window as unknown as { ss: import('../src/editor/textSession.ts').EditSession }).ss.view!.dom.firstElementChild!
              const range = document.createRange()
              range.setStart(p.firstChild!, p.firstChild!.textContent!.length - 1)
              range.setEnd(p.firstChild!, p.firstChild!.textContent!.length)
              const r = range.getBoundingClientRect()
              return { x: r.right - 1, y: r.top + r.height / 2 }
            })
            await page.mouse.click(box.x, box.y)
            wantText = 'abxcd?'
          }
        }
        await page.waitForTimeout(delay)
        const typed = next === 'q' ? 'q' : '火'
        if (next === 'q') await page.keyboard.press('q')
        else {
          await cdp.send('Input.imeSetComposition', { text: 'ひ', selectionStart: 1, selectionEnd: 1 })
          await cdp.send('Input.insertText', { text: '火' })
        }
        await page.waitForTimeout(60)
        const got = await page.evaluate(() => {
          const s = (window as unknown as { ss: import('../src/editor/textSession.ts').EditSession }).ss
          return { text: s.content().text, head: s.selection().head, focused: s.view!.hasFocus() }
        })
        count++
        const want = wantText.replace('?', typed)
        const wantHead = want.indexOf(typed) + typed.length
        if (got.text !== want || got.head !== wantHead) fails.push(`${back}, then ${next} ${delay} ms later: ${JSON.stringify(got.text)}@${got.head}, want ${JSON.stringify(want)}@${wantHead}${got.focused ? '' : ' (editor not focused)'}`)
      }
    }
  }
  console.log(`focus coming back: ${count} runs, ${fails.length} wrong`)
  for (const f of fails) console.log('  ' + f)
  expect(fails).toEqual([])
  expect(count).toBe(24)
})
