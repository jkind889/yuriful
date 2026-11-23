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
      await page.waitForTimeout(60) // the follow-up runs 30 ms after a composition ends
      const result = await page.evaluate(async ([src, a, b]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        const { createObject, reconcileTextFormatting, toRecord } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
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
 * `compositionstart` (N1). While a composition is open the browser and ProseMirror own the
 * text, and a session command issued while one is open, or before ProseMirror has finished
 * ending it, is refused and never runs later (N3). Text and caret must equal the shipped canvas
 * fed the same input: each composition update an input of Fabric's real `onInput` (the textarea
 * holding the candidate, its caret after it), keys and pastes likewise, with the editor's
 * `reconcileTextFormatting` after each. Marks and levels: at a plain caret compared with that
 * same canvas record; over a selection, rule R5 (the composed text takes the marks of the
 * first selected character, levels by today's rule) asserted directly; after input that
 * followed a composition at once, text and caret only. After every scenario (N5): the last
 * record `onChange` reported equals `content()`, equals the canonical form of the live document
 * and has exactly its text; and in-edit undo steps back to the record the scenario started from
 * (redo forward to its end). Every scenario runs twice: each command awaited, and all commands
 * sent at once without awaiting.
 */
test('real IME compositions keep exactly the text and caret the canvas keeps, and a canonical record, on a mounted view', async ({ page }) => {
  test.setTimeout(600_000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openBlank(page)
  const cdp = await page.context().newCDPSession(page)
  type Step =
    | { ime: string; at?: number }
    | { commit: string }
    | { cancel: true }
    | { key: string }
    | { clip: string }
    | { wait: number }
    | { cmd: 'bold' | 'h2' | 'undo' | 'paste' }
    | { finish: true }
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
    ['a formatting command (refused), then a typed character', [{ cmd: 'bold' }, { key: 'x' }]],
    ['a heading command (refused)', [{ cmd: 'h2' }]],
    ['a paste through the session (refused), then a typed character', [{ cmd: 'paste' }, { key: 'x' }]],
    ['in-edit undo through the session (refused)', [{ cmd: 'undo' }]],
    ['finish()', [{ finish: true }]],
  ]
  const korean = Array.from('한국어로음악리뷰를쓰는중입니다오늘은좋아')
  const initial = (syllable: string) => 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'[Math.floor((syllable.charCodeAt(0) - 0xac00) / 588)]!
  const kana = 'きょうはあたらしいれこーどをききながらながいぶんしょう'
  const scenarios: Scenario[] = [
    { name: 'case 1: `A|なZ`, `か` → `かな`, commit `か`, then a character typed at once', src: { text: 'AなZ' }, a: 1, b: 1, steps: [...compose(['か', 'かな'], 'か'), { key: 'x' }], marks: 'canvas' },
    { name: 'case 3: a heading command during the preedit (refused)', src: bcD, a: 1, b: 2, steps: [{ ime: 'か' }, { cmd: 'h2' }, { ime: 'かな' }, { commit: '仮名' }], marks: 'r5' },
    { name: 'a formatting command during the preedit (refused)', src: bcD, a: 1, b: 2, steps: [{ ime: 'か' }, { cmd: 'bold' }, { ime: 'かな' }, { commit: '仮名' }], marks: 'r5' },
    { name: 'a heading command during the preedit on line one (refused), commit, then ArrowDown', src: { text: 'a\nbc' }, a: 1, b: 1, steps: [{ ime: 'か' }, { cmd: 'h2' }, { commit: '仮' }, { key: 'ArrowDown' }], marks: 'canvas', caret: false },
    { name: '`a|b`, commit `仮`, a paste through the session (refused), then x before the follow-up', src: { text: 'ab' }, a: 1, b: 1, steps: [{ ime: 'か' }, { commit: '仮' }, { cmd: 'paste' }, { key: 'x' }], marks: 'canvas' },
    { name: 'over the selection across marks, commit, Ctrl+A at once, 75 ms, then x', src: mixed, a: 0, b: 2, steps: [...compose(['ㄱ', '가', '각'], '가'), { key: 'Control+a' }, { wait: 75 }, { key: 'x' }], marks: 'none' },
    { name: '`XY`, `X` selected, `か` → `かな`, commit `な`', src: { text: 'XY' }, a: 0, b: 1, steps: compose(['か', 'かな'], 'な'), marks: 'r5' },
    { name: 'the IME’s caret inside a character of the candidate (`e` and an accent, the caret between)', src: plain, a: 5, b: 5, steps: [{ ime: 'e' }, { ime: 'é', at: 1 }, { ime: 'éx', at: 1 }, { commit: 'éx' }, { key: 'y' }], marks: 'canvas' },
    { name: 'a composition cancelled and restarted', src: bold, a: 2, b: 2, steps: [{ ime: 'か' }, { ime: 'かな' }, { cancel: true }, ...compose(['な'], '名')], marks: 'canvas' },
    { name: 'pending italic and mono at a caret', src: plain, a: 5, b: 5, pending: { italic: true, font: 'mono' }, steps: compose(['か', 'かな'], '仮名'), marks: 'canvas' },
    { name: 'a 20-syllable Korean sentence', src: plain, a: 10, b: 10, steps: korean.flatMap((s) => compose([initial(s), s], s)), marks: 'canvas' },
    { name: 'a 30-character Japanese sentence', src: plain, a: 10, b: 10, steps: compose(Array.from(kana).map((_, i) => kana.slice(0, i + 1)), '今日は新しいレコードを聴きながら長い文章'), marks: 'canvas' },
    ...places.flatMap((p) => shapes.map(([shape, steps]): Scenario => ({ name: `${shape}, ${p.name}`, src: p.src, a: p.a, b: p.b, steps, marks: p.marks }))),
    ...after.map(([what, steps]): Scenario => ({ name: `a composition followed at once by ${what}`, src: bold, a: 2, b: 2, steps: [...compose(['か', 'かな'], '仮名'), ...steps], marks: 'canvas' })),
    ...([['across marks', mixed], ['inside one mark', sameMark]] as const).flatMap(([where, src]) =>
      overSelection.flatMap(([shape, steps]): Scenario[] => [
        { name: `${shape}, over the selection ${where}`, src, a: 0, b: 2, steps, marks: 'r5' },
        ...followers.map(([what, more]): Scenario => {
          // ArrowLeft from the second character of a text to its start is lost in a mounted
          // ProseMirror view on this page whatever came before (no composition needed): those
          // runs start one plain character into the text.
          if (!what.startsWith('ArrowLeft')) return { name: `${shape}, over the selection ${where}, then ${what} at once`, src, a: 0, b: 2, steps: [...steps, ...more], marks: 'none' }
          const shifted = { text: `q${src.text}`, spans: src.spans?.map((sp) => ({ ...sp, start: (sp.start as number) + 1, end: (sp.end as number) + 1 })) }
          return { name: `${shape}, over the selection ${where} (after a q), then ${what} at once`, src: shifted, a: 1, b: 3, steps: [...steps, ...more], marks: 'none' }
        }),
      ]),
    ),
  ]

  const fails: unknown[] = []
  let runs = 0
  let refusedCommands = 0
  const gaps: Array<[number, boolean]> = []
  for (const scenario of scenarios) {
    for (const mode of ['awaited', 'at once'] as const) {
      const clip = scenario.steps.find((st): st is { clip: string } => 'clip' in st)?.clip
      await page.evaluate(async ([src, a, b, pending, clip]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        const { createEditSession } = (await load('/src/editor/textSession.ts')) as typeof import('../src/editor/textSession.ts')
        const w = window as unknown as { ss?: { finish(): void }; reported?: unknown; commands: unknown[]; times: { end: number; gaps: Array<[number, boolean]> } }
        w.ss?.finish()
        document.body.replaceChildren()
        const el = document.createElement('div')
        el.style.whiteSpace = 'pre-wrap'
        document.body.append(el)
        w.reported = undefined
        w.commands = []
        w.times = { end: 0, gaps: [] }
        const s = createEditSession(src as never, { onChange: (c) => (w.reported = c) })!
        ;(window as unknown as { ss: unknown }).ss = s
        s.mount(el).focus()
        // How soon after a commit the next key arrives, and whether the follow-up was still owed then.
        el.addEventListener('compositionend', () => (w.times.end = performance.now()))
        el.addEventListener('keydown', () => {
          if (w.times.end > 0) w.times.gaps.push([performance.now() - w.times.end, (s as { settling?: boolean }).settling ?? true])
          w.times.end = 0
        })
        s.select(a as number, b as number)
        const p = pending as { italic?: boolean; font?: string } | undefined
        if (p?.italic) s.toggleMark('italic')
        if (p?.font) s.setFont(p.font as never)
        if (clip !== undefined) await navigator.clipboard.writeText(clip as string)
      }, [scenario.src, scenario.a, scenario.b, scenario.pending, clip] as const)
      const sent: Array<Promise<unknown>> = []
      const send = async (p: Promise<unknown>) => {
        if (mode === 'awaited') await p
        else sent.push(p)
      }
      for (const step of scenario.steps) {
        if ('ime' in step) await send(cdp.send('Input.imeSetComposition', { text: step.ime, selectionStart: step.at ?? step.ime.length, selectionEnd: step.at ?? step.ime.length }))
        else if ('commit' in step) await send(cdp.send('Input.insertText', { text: step.commit }))
        else if ('cancel' in step) {
          // No CDP command cancels a composition: an empty candidate, then an empty commit.
          await send(cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }))
          await send(cdp.send('Input.insertText', { text: '' }))
        }
        else {
          // Keys and session commands come in order after what was sent before them.
          await Promise.all(sent.splice(0))
          if ('key' in step) await page.keyboard.press(step.key)
          else if ('clip' in step) await page.keyboard.press('Control+v')
          else if ('wait' in step) await page.waitForTimeout(step.wait)
          else
            await page.evaluate((st: Record<string, unknown>) => {
              const w = window as unknown as { ss: import('../src/editor/textSession.ts').EditSession; commands: unknown[] }
              const s = w.ss
              if ('finish' in st) return s.finish()
              const settling = (s as { settling?: boolean }).settling ?? true
              const before = JSON.stringify(s.content())
              const ret = st.cmd === 'bold' ? s.toggleMark('bold') : st.cmd === 'h2' ? s.setHeading(2) : st.cmd === 'undo' ? s.undo() : s.paste({ text: 'P' })
              w.commands.push({ cmd: st.cmd, settling, ret, changed: JSON.stringify(s.content()) !== before })
            }, step as Record<string, unknown>)
        }
      }
      await Promise.all(sent.splice(0))
      await page.waitForTimeout(60) // the follow-up runs 30 ms after the last composition ends
      const result = await page.evaluate(async ([src, a, b, steps, pending]) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        const { createObject, reconcileTextFormatting, toRecord } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
        const { canonicalTextContent } = (await load('/src/model/textDoc.ts')) as typeof import('../src/model/textDoc.ts')
        const { docFromText, contentFromDoc, plainTextOfDoc } = (await load('/src/editor/textSchema.ts')) as typeof import('../src/editor/textSchema.ts')
        const { splitGraphemes, canonicalTextFormatting, headingsAfterEdit } = (await load('/src/model/richText.ts')) as typeof import('../src/model/richText.ts')
        const w = window as unknown as { ss: import('../src/editor/textSession.ts').EditSession; reported?: unknown; commands: Array<{ cmd: string; settling: boolean; ret: boolean; changed: boolean }>; times: { gaps: Array<[number, boolean]> } }
        const s = w.ss
        const source = src as { text: string; spans?: Array<Record<string, unknown>>; headings?: number[] }
        // ---- the canvas fed the same input (session commands are refused: they change nothing)
        const obj = createObject({ type: 'text', id: 't', left: 0, top: 0, angle: 0, width: 360, fontSize: 24, ...source } as never, () => undefined) as unknown as {
          isEditing: boolean
          inCompositionMode: boolean
          hiddenTextarea: HTMLTextAreaElement
          selectionStart: number
          selectionEnd: number
          onInput(e: Event): void
        }
        let value = source.text
        const g = (t: string, o: number) => splitGraphemes(t.slice(0, o)).length
        const off = (t: string, gi: number) => splitGraphemes(t).slice(0, gi).join('').length
        obj.isEditing = true
        obj.hiddenTextarea = document.createElement('textarea')
        obj.selectionStart = g(value, a as number)
        obj.selectionEnd = g(value, b as number)
        // The editor's pending choices go to what the canvas inserts (\`reconcileTextFormatting\`'s \`pending\`).
        const p = pending as { italic?: boolean; font?: string } | undefined
        const pend: Record<string, unknown> | undefined = p ? { ...(p.italic ? { italic: true } : {}), ...(p.font ? { font: p.font } : {}) } : undefined
        const input = (next: string, caret: number, type: string) => {
          value = next
          obj.hiddenTextarea.value = next
          obj.hiddenTextarea.setSelectionRange(caret, caret)
          obj.onInput(new InputEvent('input', { inputType: type }))
          reconcileTextFormatting(obj as never, pend as never)
        }
        /** Replaces the selection (or inserts at the caret) as the textarea does. */
        const replace = (text: string, type: string) => {
          const from = off(value, obj.selectionStart)
          const to = off(value, obj.selectionEnd)
          input(value.slice(0, from) + text + value.slice(to), from + text.length, type)
        }
        let comp: { before: string; after: string; first: boolean; selected: boolean } | null = null
        const list = steps as Array<Record<string, unknown>>
        // Keyboard undo on its own takes back the compositions (one history step): the text and selection from before them.
        const undoneByKey = list.some((st, i) => st.key === 'Control+z' && list[i + 1]?.key !== 'Control+y')
        for (const st of list) {
          if ('ime' in st || 'commit' in st || 'cancel' in st) {
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
            if (st.key === 'Enter') replace('\n', 'insertLineBreak')
            else if (st.key === 'Backspace' || st.key === 'Delete') {
              if (from !== to) replace('', 'deleteContentBackward')
              else if (st.key === 'Backspace') {
                const gone = splitGraphemes(value.slice(0, from)).pop() ?? ''
                input(value.slice(0, from - gone.length) + value.slice(from), from - gone.length, 'deleteContentBackward')
              } else {
                const gone = splitGraphemes(value.slice(from))[0] ?? ''
                input(value.slice(0, from) + value.slice(from + gone.length), from, 'deleteContentForward')
              }
            } else if (st.key === 'ArrowLeft') obj.selectionStart = obj.selectionEnd = from !== to ? obj.selectionStart : Math.max(0, obj.selectionEnd - 1)
            else if (st.key === 'ArrowDown') obj.selectionStart = obj.selectionEnd = splitGraphemes(value).length
            else if (st.key === 'Control+a') {
              obj.selectionStart = 0
              obj.selectionEnd = splitGraphemes(value).length
            } else if (st.key === 'Control+z' || st.key === 'Control+y') {
              // Undo then redo: back where it was.
            } else replace(st.key as string, 'insertText')
          } else if ('clip' in st) replace(st.clip as string, 'insertFromPaste')
        }
        const canvas = undoneByKey ? canonicalTextContent(source as never)! : canonicalTextContent(toRecord(obj as never) as never)!
        const canvasCaret = undoneByKey ? (b as number) : off(value, obj.selectionEnd)
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
        // ---- N5: the last record reported, content(), the canonical form of the live document, its text
        const reported = JSON.stringify(w.reported ?? canonicalTextContent(source as never))
        const liveContent = contentFromDoc(s.state.doc, got)
        const n5 = reported === JSON.stringify(got) && JSON.stringify(got) === JSON.stringify(canonicalTextContent(liveContent as never)) && got.text === plainTextOfDoc(s.state.doc)
        // ---- in-edit undo back to the start, redo forward to the end
        let undoOk = true
        if (!s.finished && !s.composing && !undoneByKey) {
          const end = JSON.stringify(got)
          for (let i = 0; i < 500 && s.canUndo && s.undo(); i++);
          undoOk = JSON.stringify(s.content()) === JSON.stringify(canonicalTextContent(source as never))
          for (let i = 0; i < 500 && s.canRedo && s.redo(); i++);
          undoOk &&= JSON.stringify(s.content()) === end
        }
        return {
          got,
          gotCaret,
          canvas,
          canvasCaret,
          r5,
          finished: s.finished,
          composing: s.composing,
          canonical: JSON.stringify(got) === JSON.stringify(canonicalTextContent(got as never)),
          live,
          n5,
          reported,
          undoOk,
          commands: w.commands,
          gaps: w.times.gaps,
        }
      }, [scenario.src, scenario.a, scenario.b, scenario.steps, scenario.pending] as const)
      runs++
      gaps.push(...result.gaps)
      const problems: string[] = []
      if (result.got.text !== result.canvas.text) problems.push('text')
      if (!result.finished && scenario.caret !== false && result.gotCaret !== result.canvasCaret) problems.push('caret')
      if (scenario.marks === 'canvas' && JSON.stringify(result.got) !== JSON.stringify(result.canvas)) problems.push('marks and levels (canvas)')
      if (scenario.marks === 'r5' && JSON.stringify(result.got) !== JSON.stringify(result.r5)) problems.push('marks and levels (R5)')
      for (const c of result.commands) {
        if (!c.settling) problems.push(`${c.cmd} issued after the composition had settled (timing)`)
        else if (c.ret !== false || c.changed) problems.push(`${c.cmd} not refused`)
        else refusedCommands++
      }
      if (result.composing) problems.push('still composing')
      if (!result.canonical) problems.push('record not canonical')
      if (!result.live) problems.push('document is not the record')
      if (!result.n5) problems.push('N5: reported record, content() and live document differ')
      if (!result.undoOk) problems.push('undo/redo')
      if (problems.length > 0) fails.push({ scenario: scenario.name, mode, problems, ...result })
    }
  }
  console.log(`text engine compositions (real IME, mounted): ${scenarios.length} scenarios, ${runs} runs, ${fails.length} with problems; ${refusedCommands} session commands refused; ${gaps.length} keys straight after a commit, ${gaps.filter(([, owed]) => owed).length} of them before the follow-up, ${gaps.filter(([t]) => t <= 12).length} within 12 ms (median ${[...gaps].sort((x, y) => x[0] - y[0])[gaps.length >> 1]?.[0].toFixed(1)} ms, at most ${Math.max(...gaps.map(([t]) => t)).toFixed(1)} ms)`)
  for (const f of fails as Array<{ scenario: string; mode: string; problems: string[]; got: { text: string }; gotCaret: number; canvas: { text: string }; canvasCaret: number }>)
    console.log(`  ${f.scenario} (${f.mode}): ${f.problems.join(', ')}; engine ${JSON.stringify(f.got.text)}@${f.gotCaret}, canvas ${JSON.stringify(f.canvas.text)}@${f.canvasCaret}`)
  expect(fails.slice(0, 4)).toEqual([])
  expect(runs).toBe(scenarios.length * 2)
})
