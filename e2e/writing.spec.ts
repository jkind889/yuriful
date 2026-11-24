/**
 * Real-browser tests (real Fabric, real IndexedDB, the real text engine) for the writing blocks of
 * Slice 3a: bullet, numbered and check lists, quotes, dividers, inline code and code blocks, typed
 * with their Markdown-style shortcuts or made with the panel; Tab in lists; what is kept and what is
 * discarded; the storage upgrade; that entering and leaving an edit moves nothing; what the page and
 * a frame preview paint; transforms, captions and a board going read-only mid-edit. There is no
 * earlier canvas to compare these with: every expectation is stated here.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  AUTOSAVE_QUIET_MS,
  dbVersion,
  decodePng,
  drag,
  editedText,
  openApp,
  openBlank,
  paintedAt,
  sceneToPage,
  pagePixels,
  screenPixels,
  seedMilestone1,
  seedRaw,
  snapshotIdb,
  status,
  storedDoc,
  undoButton,
  redoButton,
} from './helpers.ts'
import type { StoredBoard, StoredObject } from './helpers.ts'

const UNIT = { zoom: 1, panX: 0, panY: 0 }

type Block = Record<string, unknown>
const p = (text?: string, extra: Record<string, unknown> = {}): Block => (text ? { type: 'paragraph', content: [{ text, ...extra }] } : { type: 'paragraph' })
const bullets = (...items: Block[][]): Block => ({ type: 'bulletList', items: items.map((blocks) => ({ blocks })) })
const tasks = (...items: Array<[boolean, Block[]]>): Block => ({ type: 'taskList', items: items.map(([checked, blocks]) => ({ checked, blocks })) })

/** Every block, for the drawing tests. */
const EVERY_BLOCK: Block[] = [
  { type: 'heading', level: 2, content: [{ text: 'Blue Lines' }] },
  { type: 'paragraph', content: [{ text: 'A review with ' }, { text: 'inline code', code: true }, { text: ' and more.' }] },
  bullets([p('Warm bassline'), bullets([p('nested'), bullets([p('third level')])])], [p('Second bullet that wraps onto a second line of text')]),
  { type: 'orderedList', start: 9, items: [{ blocks: [p('nine')] }, { blocks: [p('ten')] }] },
  tasks([true, [p('Check the 2012 remaster')]], [false, [p('Listen to side B')]]),
  { type: 'blockquote', blocks: [p('A record that sounds like a city at night.')] },
  { type: 'divider' },
  { type: 'codeBlock', text: 'const side = "B"\nplay(side)\nhttps://example.com/averyveryverylongunbrokenwordthatwraps' },
  p('The end.'),
]

const textRec = (id: string, left: number, top: number, extra: Record<string, unknown>) => ({ type: 'text', id, left, top, angle: 0, text: '', fontSize: 18, width: 420, ...extra })

interface WritingProbe {
  preview: (frameId: string) => Promise<string>
  select: (id: string) => void
  controls: () => Record<string, { x: number; y: number }> | null
}
declare global {
  interface Window {
    __writing: WritingProbe
  }
}

/** A probe on the app's editor (this test route only): frame previews, selecting by id, the selected object's handles. */
async function installProbe(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: `
      import { Editor as WritingEditor } from '/src/editor/Editor.ts'
      const writingInit = WritingEditor.prototype.init
      WritingEditor.prototype.init = function () {
        const ed = this
        window.__writing = {
          select: (id) => ed.selectLayer(id),
          controls: () => {
            const a = ed.canvas.getActiveObject()
            if (!a) return null
            const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
            const out = {}
            for (const [k, c] of Object.entries(a.oCoords)) out[k] = { x: r.left + c.x, y: r.top + c.y }
            return out
          },
          preview: async (frameId) => {
            ed.selectLayer(frameId)
            const tour = ed.startFrameTour()
            if (!tour) throw new Error('no tour')
            return tour.renderFrame(frameId, new AbortController().signal)
          },
        }
        return writingInit.call(this)
      }
      ${source}
    `,
    })
  })
}

/** Opens a board: a version 1 database for plain texts (as milestone 1 wrote it), version 3 when a text has blocks. */
async function open(page: Page, objects: unknown[], frames: unknown[] = []) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openBlank(page)
  const rich = objects.some((o) => (o as { blocks?: unknown }).blocks !== undefined)
  if (rich) await seedRaw(page, 3, { version: 3, title: 'Writing', frames, objects, viewport: UNIT })
  else if (frames.length > 0) await seedRaw(page, 2, { version: 2, title: 'Writing', frames, objects, viewport: UNIT })
  else await seedMilestone1(page, { version: 1, title: 'Writing', objects, viewport: UNIT })
  await installProbe(page)
  await openApp(page)
  return { errors, at: await sceneToPage(page, UNIT) }
}

const byId = (doc: StoredBoard, id: string): StoredObject & Record<string, unknown> => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no object ${id}`)
  return found as StoredObject & Record<string, unknown>
}
const texts = (doc: StoredBoard) => doc.objects.filter((o) => o.type === 'text') as Array<StoredObject & Record<string, unknown>>
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}

/** A new text with the Text tool, clicked at scene point `(x, y)`, being edited. */
async function newText(page: Page, at: (x: number, y: number) => { x: number; y: number }, x: number, y: number) {
  await page.keyboard.press('t')
  await page.mouse.click(at(x, y).x, at(x, y).y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
}

/** Enters editing of the text under `pt` and puts the caret at its very end. */
async function editAtEnd(page: Page, pt: { x: number; y: number }) {
  await page.mouse.dblclick(pt.x, pt.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.keyboard.press('Control+End')
}

const layerLabels = (page: Page) => page.locator('.layer-row .layer-label').allTextContents()

/** Every character of the scene layer's first text card: its left and top on the page. */
function characterBoxes(page: Page, id: string) {
  return page.evaluate((id) => {
    const body = document.querySelector(`.scene-text[data-id="${id}"] .scene-text-body`) ?? document.querySelector('.scene-text-body')!
    const out: number[][] = []
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (let i = 0; i < (n as Text).data.length; i++) {
        range.setStart(n, i)
        range.setEnd(n, i + 1)
        const r = range.getBoundingClientRect()
        out.push([r.left, r.top, r.width])
      }
    }
    return { boxes: out, height: getComputedStyle(body).height, markers: Array.from(body.querySelectorAll('li, .yp-check, hr, pre, blockquote')).map((el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }) }
  }, id)
}

/** The page rectangle of the first element matching `selector` in the card, relative to the canvas host (scene units at zoom 1). */
function rectIn(page: Page, selector: string, index = 0) {
  return page.evaluate(
    ({ selector, index }) => {
      const host = document.querySelector('.canvas-host')!.getBoundingClientRect()
      const el = document.querySelectorAll(`.scene-layer ${selector}`)[index]!
      const r = el.getBoundingClientRect()
      const fontSize = parseFloat(getComputedStyle(el.closest('.scene-text-body')!).fontSize)
      return { left: r.left - host.left, top: r.top - host.top, width: r.width, height: r.height, em: fontSize }
    },
    { selector, index },
  )
}

// ---- the plan's acceptance tests ------------------------------------------------------------------

test('checklist-typed-char-by-char-upgrades-bullet-without-trapping', async ({ page }) => {
  const { errors, at } = await open(page, [])
  await newText(page, at, 120, 120)
  await page.keyboard.type('- [ ] Buy vinyl')
  const typed = await storedWhen(page, (d) => texts(d).length === 1 && texts(d)[0]!.text === 'Buy vinyl')
  expect(texts(typed)[0]!.blocks).toEqual([tasks([false, [p('Buy vinyl')]])])
  expect(await editedText(page)).toMatchObject({ value: 'Buy vinyl', start: 9, end: 9 })
  // A click on the box, while editing, ticks it, saved like typing; the caret stays where it was.
  const box = await rectIn(page, '.yp-check')
  await page.mouse.click(at(box.left + box.width / 2, box.top + box.height / 2).x, at(box.left + box.width / 2, box.top + box.height / 2).y)
  const ticked = await storedWhen(page, (d) => JSON.stringify(texts(d)[0]!.blocks).includes('"checked":true'))
  expect(texts(ticked)[0]!.blocks).toEqual([tasks([true, [p('Buy vinyl')]])])
  expect(await editedText(page)).toMatchObject({ value: 'Buy vinyl', start: 9, end: 9, focused: true })
  // Untick and tick again quickly, then in-edit undo: each click is an undo step of its own, so the
  // first undo gives the state in between (unticked), the second the state before both (ticked).
  const boxAt = at(box.left + box.width / 2, box.top + box.height / 2)
  const task = page.locator('.scene-layer .yp-task')
  await page.mouse.click(boxAt.x, boxAt.y)
  await page.mouse.click(boxAt.x, boxAt.y, { delay: 0 })
  await expect(task).toHaveAttribute('data-checked', 'true')
  await page.keyboard.press('Control+z')
  await expect(task).toHaveAttribute('data-checked', 'false')
  await page.keyboard.press('Control+z')
  await expect(task).toHaveAttribute('data-checked', 'true')
  await page.keyboard.press('Control+z')
  await expect(task).toHaveAttribute('data-checked', 'false')
  await page.keyboard.press('Control+Shift+z')
  await expect(task).toHaveAttribute('data-checked', 'true')
  await storedWhen(page, (d) => JSON.stringify(texts(d)[0]!.blocks) === JSON.stringify([tasks([true, [p('Buy vinyl')]])]))
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(status(page)).toContainText('Saved on this device')
  await expect(page.locator('.scene-layer .yp-task')).toHaveAttribute('data-checked', 'true')
  expect(texts(await storedDoc(page))[0]!.blocks).toEqual([tasks([true, [p('Buy vinyl')]])])

  // Backspace straight after `[ ] ` converted gives back the literal characters, in the bullet.
  await newText(page, at, 120, 320)
  await page.keyboard.type('- [ ] ')
  await page.keyboard.press('Backspace')
  expect(await editedText(page)).toMatchObject({ value: '[ ] ', start: 4, end: 4 })
  const reverted = await storedWhen(page, (d) => texts(d).length === 2)
  expect(texts(reverted).find((t) => t.text === '[ ] ')!.blocks).toEqual([bullets([p('[ ] ')])])
  expect(errors).toEqual([])
})

test('divider-only-and-ticked-box-cards-are-kept', async ({ page }) => {
  const { errors, at } = await open(page, [])
  // Only a divider: kept on Esc, saved, listed as `Text`, and still there after a reload.
  await newText(page, at, 120, 100)
  await page.keyboard.type('---')
  await page.keyboard.press('Escape')
  const divider = await storedWhen(page, (d) => texts(d).length === 1)
  expect(texts(divider)[0]).toMatchObject({ text: '', blocks: [{ type: 'divider' }, p()] })
  expect(await layerLabels(page)).toEqual(['Text'])
  // Only a ticked, empty checkbox: kept too.
  await newText(page, at, 120, 300)
  await page.keyboard.type('- [x] ')
  await page.keyboard.press('Escape')
  const ticked = await storedWhen(page, (d) => texts(d).length === 2)
  expect(texts(ticked)[1]).toMatchObject({ text: '', blocks: [tasks([true, [p()]])] })
  expect(await layerLabels(page)).toEqual(['Text', 'Text'])
  await page.reload()
  await expect(status(page)).toContainText('Saved on this device')
  expect(await layerLabels(page)).toEqual(['Text', 'Text'])
  await expect(page.locator('.scene-layer hr')).toHaveCount(1)

  // Only an empty bullet, or only an unticked empty checkbox (or `# `, `> `): discarded, with no
  // undo step and nothing saved.
  await expect(undoButton(page)).toBeDisabled()
  const before = await snapshotIdb(page)
  for (const [i, t] of ['- ', '- [ ] ', '> ', '# '].entries()) {
    await newText(page, at, 500, 100 + i * 120)
    await page.keyboard.type(t)
    await page.keyboard.press('Escape')
  }
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  // Nothing of them is stored (as for a blank text before: its first typed character may schedule a
  // save, which then stores the board without it, exactly as it was).
  expect((await snapshotIdb(page)).doc).toEqual(before.doc)
  await expect(undoButton(page)).toBeDisabled()
  expect(await layerLabels(page)).toEqual(['Text', 'Text'])
  expect(errors).toEqual([])
})

test('pinned-literal-cases-empty-list-discard-and-backspace-revert', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('L', 600, 400, { text: 'x', blocks: [bullets([p('x')])] }), textRec('C', 600, 510, { text: '-x', blocks: [{ type: 'paragraph', content: [{ text: '-x', code: true }] }] })])
  // Typed literal cases stay literal.
  await newText(page, at, 60, 60)
  await page.keyboard.type('2 * 3 * 4\nsnake*case*\n* item\n#tag\n#### four')
  // Pasted `- item` stays literal.
  await page.keyboard.press('Enter')
  await page.evaluate(() => navigator.clipboard.writeText('- item'))
  await page.keyboard.press('Control+v')
  // An IME-composed `- ` stays literal.
  await page.keyboard.press('Enter')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '-', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.insertText', { text: '-' })
  await cdp.send('Input.imeSetComposition', { text: ' ', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.insertText', { text: ' ' })
  await page.keyboard.type('x')
  const literal = '2 * 3 * 4\nsnake*case*\n* item\n#tag\n#### four\n- item\n- x'
  // Inside inline code no shortcut fires: `-x` as code, a space typed between `-` and `x` stays a space.
  await page.keyboard.press('Escape')
  await editAtEnd(page, at(605, 520))
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type(' ')
  const inCode = await storedWhen(page, (d) => byId(d, 'C').text === '- x')
  expect(byId(inCode, 'C').blocks).toEqual([{ type: 'paragraph', content: [{ text: '- x', code: true }] }])
  await page.keyboard.press('Escape')
  await page.mouse.dblclick(at(70, 70).x, at(70, 70).y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  const lit = await storedWhen(page, (d) => texts(d).some((t) => t.text === literal))
  expect(texts(lit).find((t) => t.text === literal)).not.toHaveProperty('blocks')
  expect(texts(lit).find((t) => t.text === literal)).not.toHaveProperty('spans')

  // Backspace straight after `> `, `---` and `` `code` `` gives back the exact characters.
  for (const [i, [t, back]] of ([['> ', '> '], ['---', '---'], ['a `code`', 'a `code`']] as const).entries()) {
    await page.keyboard.press('Escape')
    await newText(page, at, 60, 320 + i * 90)
    await page.keyboard.type(t)
    expect((await editedText(page))!.value).not.toBe(back)
    await page.keyboard.press('Backspace')
    expect(await editedText(page)).toMatchObject({ value: back, start: back.length, end: back.length })
    await storedWhen(page, (d) => texts(d).some((x) => x.text === back && x.blocks === undefined))
  }
  await page.keyboard.press('Escape')

  // An existing text emptied to an empty list is discarded when the edit ends, as one undo step.
  const listCount = texts(await storedDoc(page)).length
  await editAtEnd(page, at(650, 410))
  await page.keyboard.press('Backspace')
  expect((await editedText(page))!.value).toBe('')
  await page.keyboard.press('Escape')
  const gone = await storedWhen(page, (d) => texts(d).length === listCount - 1)
  expect(gone.objects.find((o) => o.id === 'L')).toBeUndefined()
  await undoButton(page).click()
  const back = await storedWhen(page, (d) => d.objects.some((o) => o.id === 'L'))
  expect(byId(back, 'L').blocks).toEqual([bullets([p('x')])])
  expect(errors).toEqual([])
})

test('tab-indents-in-lists-and-exits-elsewhere', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 100, { text: 'one\ntwo\nafter', blocks: [bullets([p('one')], [p('two')]), p('after')] })])
  const line = (await rectIn(page, 'li', 1))
  // Tab on the second item: nested under the first, the edit stays open with the caret in place.
  await page.mouse.dblclick(at(line.left + 5, line.top + line.height / 2).x, at(line.left + 5, line.top + line.height / 2).y)
  await page.keyboard.press('End')
  await page.keyboard.press('Tab')
  expect(await editedText(page)).toMatchObject({ value: 'one\ntwo\nafter', start: 7, end: 7, focused: true })
  const nested = await storedWhen(page, (d) => JSON.stringify(byId(d, 't').blocks) !== JSON.stringify([bullets([p('one')], [p('two')]), p('after')]))
  expect(byId(nested, 't').blocks).toEqual([bullets([p('one'), bullets([p('two')])]), p('after')])
  // Shift+Tab lifts it back.
  await page.keyboard.press('Shift+Tab')
  await storedWhen(page, (d) => JSON.stringify(byId(d, 't').blocks) === JSON.stringify([bullets([p('one')], [p('two')]), p('after')]))
  expect(await editedText(page)).toMatchObject({ start: 7, focused: true })
  // Tab on the first item changes nothing and keeps the edit open.
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Tab')
  expect(await editedText(page)).toMatchObject({ value: 'one\ntwo\nafter', start: 0, focused: true })
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(byId(await storedDoc(page), 't').blocks).toEqual([bullets([p('one')], [p('two')]), p('after')])
  // Tab in a plain line ends the edit.
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Tab')
  await expect.poll(() => editedText(page)).toBeNull()
  expect(errors).toEqual([])
})

test('a-card-cannot-grow-past-the-stored-bounds', async ({ page }) => {
  // 3,333 items of one word: 1 + 3,333 × 3 = 10,000 stored nodes, the bound.
  const items = Array.from({ length: 3333 }, (_, i) => [p(`w${i}`)])
  // Lists nested five deep: the innermost lines are at depth 6, the bound.
  let deep: Block = bullets([p('a')], [p('b')])
  for (let i = 0; i < 4; i++) deep = bullets([p(`l${i}`), deep])
  let quoted: Block = p('q')
  for (let i = 0; i < 5; i++) quoted = { type: 'blockquote', blocks: [quoted] }
  const { errors, at } = await open(page, [
    textRec('n', 40, 40, { text: '', fontSize: 8, width: 200, blocks: [bullets(...items)] }),
    textRec('d', 600, 40, { text: '', blocks: [deep] }),
    textRec('q', 900, 40, { text: 'q', width: 300, blocks: [quoted] }),
  ])
  // A new item would add two nodes: Enter does nothing. Typing in the last item adds none, and is saved.
  await editAtEnd(page, at(60, 45))
  const before = (await editedText(page))!.value
  await page.keyboard.press('Enter')
  expect((await editedText(page))!.value).toBe(before)
  await page.keyboard.type('x')
  const saved = await storedWhen(page, (d) => (byId(d, 'n').text as string).endsWith('w3332x'))
  const list = (byId(saved, 'n').blocks as Array<{ items: unknown[] }>)[0]!
  expect(list.items).toHaveLength(3333)
  await page.keyboard.press('Escape')
  // At the deepest level, Tab cannot go deeper: nothing changes and the edit stays open.
  await editAtEnd(page, at(700, 50))
  const deepBefore = byId(await storedDoc(page), 'd').blocks
  await page.keyboard.press('Tab')
  expect(await editedText(page)).toMatchObject({ focused: true })
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(byId(await storedDoc(page), 'd').blocks).toEqual(deepBefore)
  await expect(status(page)).toContainText('Saved on this device')
  await page.keyboard.press('Escape')
  // A `- ` that would put a line six levels deep (five quotes) one level deeper does not convert;
  // Backspace then deletes the space, not what was typed before it.
  await editAtEnd(page, at(1000, 50))
  await page.keyboard.type('keep\n- ')
  expect((await editedText(page))!.value.endsWith('keep\n- ')).toBe(true)
  await page.keyboard.press('Backspace')
  expect((await editedText(page))!.value.endsWith('keep\n-')).toBe(true)
  await page.keyboard.press('Escape')
  // A paste that would add nodes past the bound does not happen.
  await editAtEnd(page, at(60, 45))
  const atBound = (await editedText(page))!.value
  await page.evaluate(() => navigator.clipboard.writeText('one\ntwo'))
  await page.keyboard.press('Control+v')
  expect((await editedText(page))!.value).toBe(atBound)
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

// ---- typing every block, storing, reloading, undo ------------------------------------------------------

test('every block typed for real is stored as typed, survives a reload, and the edit is one undo step', async ({ page }) => {
  const { errors, at } = await open(page, [])
  await newText(page, at, 80, 60)
  // A bullet item, a second one, Enter on an empty item to leave the list; a quote, left the same
  // way; a divider; a line with inline code; a numbered list starting at 3; a checklist; a code block.
  await page.keyboard.type('- one\ntwo\n\n> quoted\n\n---see `npm test` now\n3. three\n\n[] task\n\n```let a\nlet b')
  const want = [
    bullets([p('one')], [p('two')]),
    { type: 'blockquote', blocks: [p('quoted')] },
    { type: 'divider' },
    { type: 'paragraph', content: [{ text: 'see ' }, { text: 'npm test', code: true }, { text: ' now' }] },
    { type: 'orderedList', start: 3, items: [{ blocks: [p('three')] }] },
    tasks([false, [p('task')]]),
    { type: 'codeBlock', text: 'let a\nlet b' },
  ]
  const typed = await storedWhen(page, (d) => texts(d).length === 1 && JSON.stringify(texts(d)[0]!.blocks) === JSON.stringify(want))
  const rec = texts(typed)[0]!
  expect(rec.text).toBe('one\ntwo\nquoted\nsee npm test now\nthree\ntask\nlet a\nlet b')
  expect(typed.version).toBe(3)
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(status(page)).toContainText('Saved on this device')
  expect(texts(await storedDoc(page))[0]).toEqual(rec)
  await expect(page.locator('.scene-layer ol')).toHaveAttribute('start', '3')
  // Undo after leaving takes back the whole edit (here, the whole new text); Redo brings it back exactly.
  await page.mouse.click(at(600, 600).x, at(600, 600).y)
  const id = rec.id
  await page.evaluate((id) => window.__writing.select(id), id)
  await page.keyboard.press('Delete')
  await storedWhen(page, (d) => texts(d).length === 0)
  await undoButton(page).click()
  await storedWhen(page, (d) => texts(d).length === 1)
  expect(texts(await storedDoc(page))[0]).toEqual(rec)
  await redoButton(page).click()
  await storedWhen(page, (d) => texts(d).length === 0)
  await undoButton(page).click()
  expect(texts(await storedWhen(page, (d) => texts(d).length === 1))[0]).toEqual(rec)
  expect(errors).toEqual([])
})

test('an edit of an existing text that adds and removes blocks is one undo step; a text with no blocks left is stored compact', async ({ page }) => {
  const plain = textRec('t', 100, 100, { text: 'alpha' })
  const { errors, at } = await open(page, [plain])
  await editAtEnd(page, at(110, 110))
  await page.keyboard.type('\n- beta')
  await storedWhen(page, (d) => byId(d, 't').blocks !== undefined)
  await page.keyboard.press('Escape')
  await undoButton(page).click()
  expect(byId(await storedWhen(page, (d) => byId(d, 't').blocks === undefined), 't')).toEqual(plain)
  await redoButton(page).click()
  expect(byId(await storedWhen(page, (d) => byId(d, 't').blocks !== undefined), 't').blocks).toEqual([p('alpha'), bullets([p('beta')])])
  // Back out of the list with Backspace at its start: compact again.
  await editAtEnd(page, at(110, 110))
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  const compact = await storedWhen(page, (d) => byId(d, 't').blocks === undefined)
  expect(byId(compact, 't')).toEqual({ ...plain, text: 'alpha\nbeta' })
  expect(errors).toEqual([])
})

// ---- storage ------------------------------------------------------------------------------------------

test('the first save of a rich text upgrades the database to version 3; a board without one keeps its version', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 100, { text: 'plain' })])
  expect(await dbVersion(page)).toBe(1)
  await editAtEnd(page, at(110, 110))
  await page.keyboard.type(' words')
  const plainSave = await storedWhen(page, (d) => byId(d, 't').text === 'plain words')
  expect(plainSave.version).toBe(1)
  expect(await dbVersion(page)).toBe(1)
  // Inline code typed and then taken back with Backspace never reached a save as rich... but a
  // list does: the save that stores it upgrades the database in the same step.
  await page.keyboard.type('\n- item')
  const richSave = await storedWhen(page, (d) => byId(d, 't').blocks !== undefined)
  expect(richSave.version).toBe(3)
  expect(richSave.frames).toEqual([])
  expect(await dbVersion(page)).toBe(3)
  // Removing it again stores the text compact and wire version 1; the database stays at 3.
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  const back = await storedWhen(page, (d) => byId(d, 't').blocks === undefined)
  expect(back.version).toBe(1)
  expect(await dbVersion(page)).toBe(3)
  expect(errors).toEqual([])
})

test('a board saved with blocks opens editable, and loading it writes nothing', async ({ page }) => {
  const rec = textRec('t', 100, 100, { text: 'one', blocks: [bullets([p('one')])] })
  await openBlank(page)
  await seedRaw(page, 3, { version: 3, title: 'Writing', frames: [], objects: [rec], viewport: UNIT })
  const before = await snapshotIdb(page)
  await openApp(page)
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(await snapshotIdb(page)).toEqual(before)
  await expect(page.getByTestId('readonly-banner')).toHaveCount(0)
  await expect(page.locator('.scene-layer ul li')).toHaveCount(1)
})

// ---- what is drawn ----------------------------------------------------------------------------------

test('entering and leaving an edit of a text with every block moves no character, marker or block', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 60, 40, { blocks: EVERY_BLOCK }), textRec('d', 560, 40, { blocks: EVERY_BLOCK, minHeight: 0, width: 300, align: 'center' })])
  for (const [id, x] of [['t', 70], ['d', 570]] as const) {
    const idle = await characterBoxes(page, id)
    await page.mouse.dblclick(at(x, 50).x, at(x, 50).y)
    await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
    const live = await characterBoxes(page, id)
    await page.keyboard.press('Escape')
    await expect.poll(() => editedText(page)).toBeNull()
    const after = await characterBoxes(page, id)
    expect(live.boxes.length, id).toBeGreaterThan(300)
    expect(live, id).toEqual(idle)
    expect(after, id).toEqual(idle)
  }
  expect(errors).toEqual([])
})

test('what is painted for each block: bullets, numbers, ticked and unticked boxes, the quote rule, the divider, code', async ({ page }) => {
  const { errors } = await open(page, [textRec('t', 60, 40, { fontSize: 24, width: 560, blocks: EVERY_BLOCK })])
  const ink = (x: number, y: number) => paintedAt(page, x, y)
  /** Ink within a pixel above or below (a hairline is snapped to whole pixels). */
  const inkNear = async (x: number, y: number) => (await ink(x, y - 1)) || (await ink(x, y)) || (await ink(x, y + 1))
  // A bullet: a dot in the gutter, on the first line, and nothing just outside it.
  const li = await rectIn(page, 'ul:not(.yp-tasks) > li')
  const dot = { x: li.left - 0.8 * li.em, y: li.top + 0.62 * li.em }
  expect(await ink(dot.x, dot.y)).toBe(true)
  expect(await ink(li.left - 0.3 * li.em, dot.y)).toBe(false)
  expect(await ink(li.left - 1.4 * li.em, dot.y)).toBe(false)
  // A number: its digits in the gutter of a numbered item.
  const ol = await rectIn(page, 'ol > li')
  let digits = false
  for (let x = ol.left - 1.3 * ol.em; x < ol.left - 0.3 * ol.em; x += 1) if (await ink(x, ol.top + 0.6 * ol.em)) digits = true
  expect(digits).toBe(true)
  // A ticked box has a tick inside; an unticked one is empty inside, with its edge drawn.
  const ticked = await rectIn(page, '.yp-check', 0)
  const empty = await rectIn(page, '.yp-check', 1)
  let tick = false
  for (let d = -3; d <= 3; d++) if (await ink(ticked.left + ticked.width / 2 + d, ticked.top + ticked.height / 2)) tick = true
  expect(tick).toBe(true)
  expect(await ink(empty.left + empty.width / 2, empty.top + empty.height / 2)).toBe(false)
  expect(await ink(empty.left + 1, empty.top + empty.height / 2)).toBe(true)
  // The quote: a rule down its left edge, the full height of its lines.
  const quote = await rectIn(page, 'blockquote')
  for (const f of [0.1, 0.5, 0.9]) expect(await ink(quote.left + 0.06 * quote.em, quote.top + f * quote.height)).toBe(true)
  expect(await ink(quote.left + 0.5 * quote.em, quote.top + 0.5 * quote.height)).toBe(false)
  // The divider: a rule across the middle of its line, and nothing a quarter line above or below.
  const hr = await rectIn(page, 'hr')
  for (const f of [0.05, 0.5, 0.95]) expect(await inkNear(hr.left + f * hr.width, hr.top + hr.height / 2)).toBe(true)
  expect(await ink(hr.left + hr.width / 2, hr.top + hr.height / 4)).toBe(false)
  expect(await ink(hr.left + hr.width / 2, hr.top + (3 * hr.height) / 4)).toBe(false)
  // Code: a tinted panel (painted in its padding, where no letter is), and inline code's tint just before its first letter.
  const pre = await rectIn(page, 'pre')
  expect(await ink(pre.left + 0.3 * pre.em, pre.top + 0.25 * pre.em)).toBe(true)
  expect(await ink(pre.left + pre.width - 3, pre.top + pre.height - 3)).toBe(true)
  expect(await ink(pre.left - 3, pre.top + pre.height / 2)).toBe(false)
  const code = await rectIn(page, 'p > code')
  expect(await ink(code.left - 1, code.top + code.height / 2)).toBe(true)
  expect(errors).toEqual([])
})

test('a frame preview shows the blocks where the page shows them', async ({ page }) => {
  const frame = { id: 'F', name: 'Review', left: 20, top: 20, width: 640, height: 720 }
  const { errors } = await open(page, [textRec('t', 60, 40, { fontSize: 20, width: 520, frameId: 'F', blocks: EVERY_BLOCK })], [frame])
  const url = await page.evaluate(() => window.__writing.preview('F'))
  const png = decodePng(Buffer.from(url.split(',')[1]!, 'base64'))
  const scale = png.width / frame.width
  const px = (sx: number, sy: number) => {
    const x = Math.round((sx - frame.left) * scale)
    const y = Math.round((sy - frame.top) * scale)
    const i = (y * png.width + x) * 4
    return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
  }
  const paper = (c: number[]) => c[0]! > 250 && c[1]! > 250 && c[2]! > 250
  // Each marker, on the board and in the preview: the preview must show at least most of the ink the board shows there.
  const regions = await markerRegions(page)
  for (const r of regions) {
    const board = inkShare(await screenPixels(page, r.left, r.top, r.width, r.height), r.faint)
    const shown = inkShare(previewCrop(png, scale, frame, r), r.faint)
    expect(board, `${r.name} on the board`).toBeGreaterThan(0.02)
    expect(shown, `${r.name} in the preview (board ${board.toFixed(3)})`).toBeGreaterThan(board * 0.5)
  }
  const li = await rectIn(page, 'ul:not(.yp-tasks) > li')
  expect(paper(px(li.left - 0.8 * li.em, li.top + 0.62 * li.em))).toBe(false) // the bullet
  expect(paper(px(li.left - 0.3 * li.em, li.top + 0.62 * li.em))).toBe(true)
  const ticked = await rectIn(page, '.yp-check', 0)
  let tick = false
  for (let d = -2; d <= 2; d++) if (!paper(px(ticked.left + ticked.width / 2 + d, ticked.top + ticked.height / 2))) tick = true
  expect(tick).toBe(true)
  const empty = await rectIn(page, '.yp-check', 1)
  expect(paper(px(empty.left + empty.width / 2, empty.top + empty.height / 2))).toBe(true)
  const hr = await rectIn(page, 'hr')
  expect([-2, -1, 0, 1, 2].some((d) => !paper(px(hr.left + hr.width / 2, hr.top + hr.height / 2 + d / scale)))).toBe(true)
  const pre = await rectIn(page, 'pre')
  expect(paper(px(pre.left + 0.3 * pre.em, pre.top + 0.25 * pre.em))).toBe(false) // the code panel's tint
  const quote = await rectIn(page, 'blockquote')
  expect(paper(px(quote.left + 0.06 * quote.em, quote.top + quote.height / 2))).toBe(false)
  expect(errors).toEqual([])
})

// ---- transforms, captions, read-only -----------------------------------------------------------------

test('a rich text: the side handle stops at its widest word plus its indent; a corner scale scales the blocks with the text', async ({ page }) => {
  const blocks = [p('A short line'), bullets([p('nested'), bullets([p('extraordinarily')])])]
  const { errors, at } = await open(page, [textRec('t', 100, 100, { fontSize: 20, width: 400, blocks })])
  await page.evaluate(() => window.__writing.select('t'))
  const c = (await page.evaluate(() => window.__writing.controls()))!
  await drag(page, c.mr!, { x: c.ml!.x + 5, y: c.mr!.y }, { steps: 12 })
  const narrowed = await storedWhen(page, (d) => (byId(d, 't').width as number) < 400)
  const width = byId(narrowed, 't').width as number
  // The widest word, `extraordinarily`, sits two list levels in (3em at 20px): the box is exactly as wide as that.
  const word = await page.evaluate(() => {
    const p = Array.from(document.querySelectorAll('.scene-layer li li p')).pop()!
    const range = document.createRange()
    range.selectNodeContents(p)
    const r = range.getBoundingClientRect()
    const body = document.querySelector('.scene-text-body')!.getBoundingClientRect()
    return { right: r.right - body.left, lines: range.getClientRects().length }
  })
  expect(word.lines).toBe(1)
  expect(width).toBeGreaterThanOrEqual(word.right - 0.05)
  expect(width).toBeLessThan(word.right + 1)
  expect(byId(narrowed, 't').blocks).toEqual(blocks)
  // A corner scale doubles the size: font size and width double, the blocks stay, and the indent doubles with them.
  const indentBefore = (await rectIn(page, 'li li p')).left - (await rectIn(page, '.scene-text-body')).left
  const c2 = (await page.evaluate(() => window.__writing.controls()))!
  const tl = c2.tl!
  const br = c2.br!
  await drag(page, br, { x: tl.x + (br.x - tl.x) * 2, y: tl.y + (br.y - tl.y) * 2 }, { steps: 16 })
  const scaled = await storedWhen(page, (d) => (byId(d, 't').fontSize as number) > 30)
  const k = (byId(scaled, 't').fontSize as number) / 20
  expect(k).toBeGreaterThan(1.8)
  expect(byId(scaled, 't').width).toBeCloseTo(width * k, 0)
  expect(byId(scaled, 't').blocks).toEqual(blocks)
  expect(byId(scaled, 't')).not.toHaveProperty('height')
  const indentAfter = (await rectIn(page, 'li li p')).left - (await rectIn(page, '.scene-text-body')).left
  expect(indentAfter / indentBefore).toBeCloseTo(k, 1)
  void at
  expect(errors).toEqual([])
})

test('a caption can hold blocks: typed in it, saved, and still attached to its image', async ({ page }) => {
  const image = { type: 'image', id: 'img', left: 100, top: 100, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 }
  const caption = { ...textRec('cap', 100, 330, { text: 'Side A', fontSize: 16, width: 300 }), captionOf: 'img' }
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedRaw(page, 2, { version: 2, title: 'Writing', frames: [], objects: [image, caption], viewport: UNIT }, [{ id: 'a1', name: 'a.png', width: 300, height: 200 }])
  await installProbe(page)
  await openApp(page)
  const at = await sceneToPage(page, UNIT)
  await editAtEnd(page, at(110, 338))
  await page.keyboard.type('\n- one\ntwo')
  const saved = await storedWhen(page, (d) => byId(d, 'cap').blocks !== undefined && (byId(d, 'cap').text as string).endsWith('two'))
  expect(byId(saved, 'cap')).toMatchObject({ captionOf: 'img', blocks: [p('Side A'), bullets([p('one')], [p('two')])] })
  await page.keyboard.press('Escape')
  // Moving the image carries the rich caption with it.
  await drag(page, at(200, 200), at(260, 230))
  const moved = await storedWhen(page, (d) => byId(d, 'img').left === 160)
  expect(byId(moved, 'cap')).toMatchObject({ captionOf: 'img', left: 160 })
  expect(errors).toEqual([])
})

test('a board that goes read-only mid-edit keeps the text and its blocks on screen and writes nothing', async ({ context }) => {
  const rec = textRec('t', 100, 100, { text: 'one', blocks: [bullets([p('one')])] })
  const seed = await context.newPage()
  await openBlank(seed)
  await seedRaw(seed, 3, { version: 3, title: 'Writing', frames: [], objects: [rec], viewport: UNIT })
  await seed.close()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openApp(page)
  const at = await sceneToPage(page, UNIT)
  await editAtEnd(page, at(130, 110))
  await page.keyboard.type('\ntwo')
  await storedWhen(page, (d) => byId(d, 't').text === 'one\ntwo')
  // Another tab writes the board.
  const other = await context.newPage()
  await openBlank(other)
  await other.evaluate(async () => {
    const path = '/src/persistence/boardStore.ts'
    const { IndexedDbBoardStore } = await import(/* @vite-ignore */ path)
    const store = new IndexedDbBoardStore()
    const loaded = await store.load()
    await store.save({ ...loaded.doc, title: 'Other tab' }, loaded.token, () => undefined)
    store.close?.()
  })
  const written = await snapshotIdb(other)
  await page.bringToFront()
  await page.keyboard.type(' three')
  await expect(page.getByTestId('readonly-banner')).toContainText('changed in another tab')
  // The edit ended; the static card shows the text with its list as it was typed.
  await expect.poll(() => editedText(page)).toBeNull()
  await expect(page.locator('.scene-layer li')).toHaveCount(2)
  await expect(page.locator('.scene-layer li').nth(1)).toContainText('two three')
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(await snapshotIdb(page)).toEqual(written)
  expect(errors).toEqual([])
})

test('the panel: block buttons on the selected lines while editing and on every line of a selected box, pressed when on', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 100, { text: 'a\nb' })])
  const btn = (name: string) => page.getByRole('button', { name, exact: true })
  await page.evaluate(() => window.__writing.select('t'))
  // A selected box: every line.
  await btn('Bulleted list').click()
  const listed = await storedWhen(page, (d) => byId(d, 't').blocks !== undefined)
  expect(byId(listed, 't').blocks).toEqual([bullets([p('a')], [p('b')])])
  await expect(btn('Bulleted list')).toHaveAttribute('aria-pressed', 'true')
  await expect(btn('Divider')).toBeDisabled()
  // While editing: the caret's line, and the edit keeps the keyboard.
  await editAtEnd(page, at(130, 110))
  await btn('Checklist').click()
  expect(await editedText(page)).toMatchObject({ focused: true })
  await expect(btn('Checklist')).toHaveAttribute('aria-pressed', 'true')
  await expect(btn('Bulleted list')).toHaveAttribute('aria-pressed', 'false')
  await btn('Divider').click()
  await btn('Quote').click()
  await page.keyboard.type('q')
  await btn('Inline code').click()
  await page.keyboard.type('c')
  const done = await storedWhen(page, (d) => (byId(d, 't').text as string).endsWith('qc'))
  // Checklist made the caret's line alone a checklist item (the other line keeps its bullet); the divider, the quote and the code went in at the caret, in its item.
  expect(byId(done, 't').blocks).toEqual([
    bullets([p('a')]),
    tasks([false, [p('b'), { type: 'divider' }, { type: 'blockquote', blocks: [{ type: 'paragraph', content: [{ text: 'q' }, { text: 'c', code: true }] }] }]]),
  ])
  await page.keyboard.press('Escape')
  // One undo step for the whole edit.
  await undoButton(page).click()
  expect(byId(await storedWhen(page, (d) => byId(d, 't').text === 'a\nb'), 't').blocks).toEqual([bullets([p('a')], [p('b')])])
  expect(errors).toEqual([])
})

// ---- the review round: browser evidence for each fix -------------------------------------------------

interface Region {
  name: string
  left: number
  top: number
  width: number
  height: number
  /** A light tint (the code panel), not ink. */
  faint?: boolean
}

/** Where each kind of marker is drawn on the board (scene units, the canvas at zoom 1). */
async function markerRegions(page: Page): Promise<Region[]> {
  const li = await rectIn(page, 'ul:not(.yp-tasks) > li')
  const ol = await rectIn(page, 'ol > li')
  const ol2 = await rectIn(page, 'ol > li', 1)
  const ticked = await rectIn(page, '.yp-check', 0)
  const empty = await rectIn(page, '.yp-check', 1)
  const quote = await rectIn(page, 'blockquote')
  const hr = await rectIn(page, 'hr')
  const pre = await rectIn(page, 'pre')
  const em = li.em
  return [
    { name: 'bullet', left: li.left - 1.2 * em, top: li.top + 0.3 * em, width: 0.8 * em, height: 0.7 * em },
    { name: 'number', left: ol.left - 1.4 * em, top: ol.top + 0.15 * em, width: 1.2 * em, height: 1.1 * em },
    { name: 'second number', left: ol2.left - 1.4 * em, top: ol2.top + 0.15 * em, width: 1.2 * em, height: 1.1 * em },
    { name: 'ticked box', left: ticked.left, top: ticked.top, width: ticked.width, height: ticked.height },
    { name: 'unticked box', left: empty.left, top: empty.top, width: empty.width, height: empty.height },
    { name: 'quote rule', left: quote.left, top: quote.top, width: 0.2 * em, height: quote.height },
    { name: 'divider', left: hr.left, top: hr.top + hr.height * 0.3, width: hr.width, height: hr.height * 0.4 },
    { name: 'code panel', left: pre.left + 1, top: pre.top + 1, width: 0.5 * em, height: 0.35 * em, faint: true },
  ]
}

/** The share of pixels that are not white paper: ink (far from white), or for a faint region any tint. */
function inkShare(img: { width: number; height: number; data: Uint8Array }, faint = false): number {
  let ink = 0
  const n = img.width * img.height
  for (let i = 0; i < n; i++) {
    const d = Math.max(255 - img.data[i * 4]!, 255 - img.data[i * 4 + 1]!, 255 - img.data[i * 4 + 2]!)
    if (d > (faint ? 6 : 40)) ink++
  }
  return n === 0 ? 0 : ink / n
}

/** The pixels of a scene region in a frame's preview bitmap. */
function previewCrop(png: { width: number; height: number; data: Uint8Array }, scale: number, frame: { left: number; top: number }, r: Region) {
  const x0 = Math.round((r.left - frame.left) * scale)
  const y0 = Math.round((r.top - frame.top) * scale)
  const w = Math.max(1, Math.round(r.width * scale))
  const h = Math.max(1, Math.round(r.height * scale))
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x
      const sy = y0 + y
      const o = (y * w + x) * 4
      if (sx < 0 || sy < 0 || sx >= png.width || sy >= png.height) {
        data.set([255, 255, 255, 255], o)
        continue
      }
      const i = (sy * png.width + sx) * 4
      data.set(png.data.subarray(i, i + 4), o)
    }
  }
  return { width: w, height: h, data }
}

test('17: a frame preview shows a long list number that reaches left of its text, as the board does', async ({ page }) => {
  const frame = { id: 'F', name: 'Numbers', left: 20, top: 20, width: 700, height: 300 }
  const { errors } = await open(
    page,
    [
      textRec('a', 300, 60, { fontSize: 24, width: 380, frameId: 'F', blocks: [{ type: 'orderedList', start: 123, items: [{ blocks: [p('Listen')] }] }] }),
      textRec('b', 300, 160, { fontSize: 24, width: 380, frameId: 'F', blocks: [{ type: 'orderedList', start: 123456789, items: [{ blocks: [p('Listen')] }] }] }),
    ],
    [frame],
  )
  // What the board shows first, with nothing selected (a selected frame's handles would be in the way).
  const seen: Array<{ r: Region; board: { width: number; height: number; data: Uint8Array }; boxLeft: number }> = []
  for (const i of [0, 1]) {
    const li = await rectIn(page, 'ol > li', i)
    const card = await rectIn(page, '.scene-text-body', i)
    // The whole gutter and beyond, to the frame's left edge: what the board shows of the number there.
    const r: Region = { name: `number ${i}`, left: frame.left + 2, top: li.top + 0.15 * li.em, width: li.left - frame.left - 4, height: 1.1 * li.em }
    seen.push({ r, board: await screenPixels(page, r.left, r.top, r.width, r.height), boxLeft: card.left })
  }
  const url = await page.evaluate(() => window.__writing.preview('F'))
  const png = decodePng(Buffer.from(url.split(',')[1]!, 'base64'))
  const scale = png.width / frame.width
  for (const { r, board, boxLeft } of seen) {
    expect(inkShare(board), 'the board shows the number').toBeGreaterThan(0.02)
    // Columns of ink, left to right: the preview has ink in (nearly) every column the board does, the part left of the box included.
    const cols = (img: { width: number; height: number; data: Uint8Array }) =>
      Array.from({ length: img.width }, (_, x) => Array.from({ length: img.height }, (_, y) => 255 - img.data[(y * img.width + x) * 4]! > 60).some(Boolean))
    const boardCols = cols(board)
    const shownCols = cols(previewCrop(png, scale, frame, r))
    expect(boardCols.indexOf(true) + r.left, `${r.name} reaches left of its box`).toBeLessThan(boxLeft)
    let missing = 0
    boardCols.forEach((on, x) => {
      if (on && !shownCols.slice(Math.max(0, Math.floor(x * scale) - 2), Math.floor(x * scale) + 3).some(Boolean)) missing++
    })
    expect(missing, `${r.name}: columns missing from the preview (of ${boardCols.filter(Boolean).length})`).toBeLessThanOrEqual(1)
  }
  expect(errors).toEqual([])
})

test('2: a whole-box Quote that would nest past the bound is refused: the bullets stay, the board saves, later writing survives a reload', async ({ page }) => {
  const { errors, at } = await open(page, [])
  await newText(page, at, 100, 80)
  await page.keyboard.type('- Side A')
  for (let i = 1; i <= 5; i++) {
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.type(`Track ${i}`)
  }
  await page.keyboard.press('Escape')
  const before = await storedWhen(page, (d) => texts(d).length === 1 && (texts(d)[0]!.text as string).endsWith('Track 5'))
  const rec = texts(before)[0]!
  await page.locator('.layer-row', { hasText: 'Side A' }).click()
  await page.getByRole('button', { name: 'Quote', exact: true }).click()
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  await expect(status(page)).toContainText('Saved on this device')
  expect(texts(await storedDoc(page))[0]).toEqual(rec)
  await expect(undoButton(page)).toBeEnabled() // the text's own creation, not a refused Quote
  await expect(page.locator('.scene-layer blockquote')).toHaveCount(0)
  // Later writing is kept.
  await editAtEnd(page, at(110, 92))
  await page.keyboard.type(' later')
  await page.keyboard.press('Escape')
  await storedWhen(page, (d) => (texts(d)[0]!.text as string).endsWith('Track 5 later'))
  await page.reload()
  await expect(status(page)).toContainText('Saved on this device')
  expect((texts(await storedDoc(page))[0]!.text as string).endsWith('Track 5 later')).toBe(true)
  expect(errors).toEqual([])
})

test('9a: Checklist and Numbered list convert a nested item with its parent, on a selected box and in an edit', async ({ page }) => {
  const { errors, at } = await open(page, [])
  await newText(page, at, 100, 80)
  await page.keyboard.type('- Album\nTrack')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Escape')
  await storedWhen(page, (d) => texts(d).length === 1)
  const btn = (name: string) => page.getByRole('button', { name, exact: true })
  await page.locator('.layer-row', { hasText: 'Album' }).click()
  await btn('Checklist').click()
  const checked = await storedWhen(page, (d) => JSON.stringify(texts(d)[0]!.blocks).includes('taskList'))
  expect(texts(checked)[0]!.blocks).toEqual([tasks([false, [p('Album'), tasks([false, [p('Track')]])]])])
  await expect(btn('Checklist')).toHaveAttribute('aria-pressed', 'true')
  await btn('Numbered list').click()
  const numberedBox = await storedWhen(page, (d) => JSON.stringify(texts(d)[0]!.blocks).includes('orderedList') && !JSON.stringify(texts(d)[0]!.blocks).includes('taskList'))
  expect(texts(numberedBox)[0]!.blocks).toEqual([{ type: 'orderedList', items: [{ blocks: [p('Album'), { type: 'orderedList', items: [{ blocks: [p('Track')] }] }] }] }])
  // In an edit, with both lines selected: back to bullets, both.
  await editAtEnd(page, at(140, 92))
  await page.keyboard.press('Control+a')
  await btn('Bulleted list').click()
  const bulleted = await storedWhen(page, (d) => !JSON.stringify(texts(d)[0]!.blocks).includes('orderedList'))
  expect(texts(bulleted)[0]!.blocks).toEqual([bullets([p('Album'), bullets([p('Track')])])])
  await expect(btn('Bulleted list')).toHaveAttribute('aria-pressed', 'true')
  expect(errors).toEqual([])
})

test('R4: a numbered list starts at up to 999,999,999, and its numbers are painted as stored; a longer number stays as typed', async ({ page }) => {
  const { errors, at } = await open(page, [])
  await newText(page, at, 400, 80)
  await page.keyboard.type('999999999. Item\nNext')
  const saved = await storedWhen(page, (d) => texts(d).length === 1 && texts(d)[0]!.text === 'Item\nNext')
  expect(texts(saved)[0]!.blocks).toEqual([{ type: 'orderedList', start: 999999999, items: [{ blocks: [p('Item')] }, { blocks: [p('Next')] }] }])
  await page.keyboard.press('Escape') // the static card (the live editor would take a probe added to it away)
  // The second marker as painted, and the same place with the marker hidden and the expected number
  // written there in the marker's own style: they match for 1000000000., not for 2147483647.
  const li = await rectIn(page, 'ol > li', 1)
  const box = (await page.locator('.canvas-host').boundingBox())!
  const region = { left: box.x + li.left - 7 * li.em, top: box.y + li.top, width: 7 * li.em, height: 1.4 * li.em }
  const shot = (style = '') => pagePixels(page, region.left, region.top, region.width, region.height, { style })
  const painted = await shot()
  const differs = async (text: string) => {
    await page.evaluate((text) => {
      const li = document.querySelectorAll('.scene-layer ol > li')[1]!
      const probe = document.createElement('span')
      probe.id = 'marker-probe'
      probe.style.cssText = 'position:absolute;right:100%;top:var(--yp-shift-0,0px);margin-right:0.35em;font-size:1em;font-style:normal;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap;color:color-mix(in srgb, currentColor 62%, transparent)'
      probe.textContent = text
      li.append(probe)
    }, text)
    const written = await shot('.yuriful-prose ol > li::before { visibility: hidden !important }')
    await page.evaluate(() => document.getElementById('marker-probe')?.remove())
    let n = 0
    for (let i = 0; i < painted.data.length; i += 4) if (Math.abs(painted.data[i]! - written.data[i]!) > 40) n++
    return n / (painted.width * painted.height)
  }
  expect(await differs('1000000000.')).toBeLessThan(0.005)
  expect(await differs('2147483647.')).toBeGreaterThan(0.01)
  // One more digit stays as typed.
  await newText(page, at, 400, 300)
  await page.keyboard.type('1000000000. ten')
  await storedWhen(page, (d) => texts(d).some((t) => t.text === '1000000000. ten' && t.blocks === undefined))
  expect(errors).toEqual([])
})

test('1: the Divider button replaces selected text without an error', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 100, { text: 'abc' })])
  await editAtEnd(page, at(110, 110))
  await page.keyboard.press('Shift+ArrowLeft')
  await page.getByRole('button', { name: 'Divider', exact: true }).click()
  const one = await storedWhen(page, (d) => byId(d, 't').blocks !== undefined)
  expect(byId(one, 't').blocks).toEqual([p('ab'), { type: 'divider' }, p()])
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: 'Divider', exact: true }).click()
  await expect(page.locator('.ProseMirror hr')).toHaveCount(1)
  await storedWhen(page, (d) => JSON.stringify(byId(d, 't').blocks) === JSON.stringify([{ type: 'divider' }, p()]))
  expect(errors).toEqual([])
})

test('3: an IME composition that would take a code block past the character bound is undone, through Chromium\'s IME', async ({ page }) => {
  await openBlank(page)
  await page.evaluate(async () => {
    const path = '/src/editor/textSession.ts'
    const { createEditSession } = await import(/* @vite-ignore */ path)
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    el.style.cssText = 'max-height:100px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere'
    const s = createEditSession({ text: '', blocks: [{ type: 'codeBlock', text: 'x'.repeat(500000) }] }, {}, { caret: 0 })
    ;(window as unknown as { s: unknown }).s = s
    s.mount(el).focus()
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.insertText', { text: 'か' })
  const result = await page.evaluate(async () => {
    const path = '/src/model/textDoc.ts'
    const { canonicalTextContent } = await import(/* @vite-ignore */ path)
    const s = (window as unknown as { s: { content(): { text: string }; finish(): void } }).s
    await new Promise((r) => setTimeout(r, 50))
    const live = s.content().text.length
    s.finish()
    const c = s.content()
    return { live, length: c.text.length, loadable: canonicalTextContent(c) !== null }
  })
  expect(result).toEqual({ live: 500000, length: 500000, loadable: true })
})

test('4: an HTML-only paste into a selected code line inserts the words of the HTML', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 100, { text: 'abc', blocks: [{ type: 'codeBlock', text: 'abc' }] })])
  await editAtEnd(page, at(125, 118))
  await page.keyboard.press('Control+a')
  await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob(['<p>new</p>'], { type: 'text/html' }) })]))
  await page.keyboard.press('Control+v')
  expect((await editedText(page))?.value).toBe('new')
  await storedWhen(page, (d) => JSON.stringify(byId(d, 't').blocks) === JSON.stringify([{ type: 'codeBlock', text: 'new' }]))
  expect(errors).toEqual([])
})

test('19: a resize or a move released over a disabled panel button ends there and is kept', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 120, { text: 'plain words', width: 420 }), textRec('h', 100, 400, { text: 'Heading', headings: [1], width: 420 })])
  const cases: Array<{ id: string; button: string; what: 'resize' | 'move' }> = [
    { id: 't', button: 'Divider', what: 'resize' }, // disabled outside an edit, with its tip
    { id: 'h', button: 'Bold', what: 'resize' }, // disabled on a heading, with its tip
    { id: 'h', button: 'Bring to front', what: 'move' }, // an ordinary disabled button (the heading is already in front)
  ]
  for (const c of cases) {
    await page.evaluate((id) => window.__writing.select(id), c.id)
    const target = page.getByRole('button', { name: c.button, exact: true })
    await expect(target, c.button).toBeDisabled()
    const to = (await target.boundingBox())!
    const before = byId(await storedDoc(page), c.id)
    const controls = (await page.evaluate(() => window.__writing.controls()))!
    const from = c.what === 'resize' ? controls.mr! : { x: (controls.tl!.x + controls.br!.x) / 2, y: (controls.tl!.y + controls.br!.y) / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
    await page.mouse.up()
    // Back over the board: the change stays.
    await page.mouse.move(at(700, 650).x, at(700, 650).y, { steps: 4 })
    const after = await storedWhen(page, (d) => JSON.stringify(byId(d, c.id)) !== JSON.stringify(before))
    if (c.what === 'resize') expect(byId(after, c.id).width, c.button).not.toBe(before.width)
    else expect(byId(after, c.id).left, c.button).not.toBe(before.left)
    // The button did nothing, and the text is still selected.
    expect(byId(after, c.id).blocks, c.button).toBeUndefined()
    expect(await page.locator('.inspector-title').textContent()).toContain('Text')
  }
  expect(errors).toEqual([])
})

test('20: at 1366x768 the Layers header and two rows stay usable whatever is selected', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  const image = { type: 'image', id: 'img', left: 120, top: 120, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 }
  const caption = { ...textRec('cap', 120, 330, { text: 'A caption', fontSize: 16, width: 300 }), captionOf: 'img' }
  const plain = textRec('t', 600, 120, { text: 'A text' })
  const frame = { id: 'F', name: 'Spread', left: 560, top: 300, width: 300, height: 200 }
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedRaw(page, 2, { version: 2, title: 'Layers', frames: [frame], objects: [image, caption, plain], viewport: UNIT }, [{ id: 'a1', name: 'a.png', width: 300, height: 200 }])
  await installProbe(page)
  await openApp(page)
  for (const id of ['cap', 't', 'img', 'F']) {
    await page.evaluate((id) => window.__writing.select(id), id)
    const panel = (await page.locator('.layers').boundingBox())!
    // The column holds both, one above the other: the panel ends above the list, and the list within the column (clear of the zoom controls).
    const column = (await page.locator('.side-stack').boundingBox())!
    const inspector = (await page.locator('.inspector').boundingBox())!
    expect(inspector.y + inspector.height, id).toBeLessThanOrEqual(panel.y + 0.5)
    expect(panel.y + panel.height, id).toBeLessThanOrEqual(column.y + column.height + 0.5)
    // Everything in the panel can be reached: its last button scrolls into view inside it.
    const last = page.locator('.inspector button').last()
    await last.scrollIntoViewIfNeeded()
    const lastBox = (await last.boundingBox())!
    expect(lastBox.y + lastBox.height, id).toBeLessThanOrEqual(inspector.y + inspector.height + 0.5)
    const header = (await page.locator('.layers-header').boundingBox())!
    expect(header.y, id).toBeGreaterThanOrEqual(panel.y - 0.5)
    expect(header.y + header.height, id).toBeLessThanOrEqual(panel.y + panel.height + 0.5)
    const list = (await page.locator('.layers-list').boundingBox())!
    const rows = page.locator('.layer-row')
    for (const i of [0, 1]) {
      const r = (await rows.nth(i).boundingBox())!
      expect(r.y, `${id} row ${i}`).toBeGreaterThanOrEqual(list.y - 0.5)
      expect(r.y + r.height, `${id} row ${i}`).toBeLessThanOrEqual(list.y + list.height + 0.5)
    }
    // Usable: the second row takes a click (it selects that object).
    await rows.nth(1).click()
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  }
  expect(errors).toEqual([])
})

test('21: in a code block the mark buttons are disabled and say why; their keys do nothing', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 100, { text: 'const x', blocks: [{ type: 'codeBlock', text: 'const x' }] })])
  await editAtEnd(page, at(125, 118))
  await page.keyboard.press('Control+a')
  for (const name of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Inline code']) {
    const b = page.getByRole('button', { name, exact: true })
    await expect(b, name).toBeDisabled()
    await expect(b, name).toHaveAttribute('data-tip', `${name}: code blocks are plain text`)
  }
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(byId(await storedDoc(page), 't').blocks).toEqual([{ type: 'codeBlock', text: 'const x' }])
  expect(errors).toEqual([])
})

test('R1: an IME composition refused at the bound takes back only itself, through Chromium\'s IME', async ({ page }) => {
  await openBlank(page)
  const mount = (blocks: unknown, caret: number, select?: [number, number]) =>
    page.evaluate(
      async ({ blocks, caret, select }) => {
        const path = '/src/editor/textSession.ts'
        const { createEditSession } = await import(/* @vite-ignore */ path)
        const old = (window as unknown as { s?: { finish(): void } }).s
        old?.finish()
        const el = document.createElement('div')
        document.body.replaceChildren(el)
        el.style.cssText = 'max-height:100px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere'
        const s = createEditSession({ text: '', blocks }, {}, { caret })
        ;(window as unknown as { s: unknown }).s = s
        s.mount(el).focus()
        if (select) s.select(select[0], select[1])
      },
      { blocks, caret, select },
    )
  const cdp = await page.context().newCDPSession(page)
  const compose = async (text: string) => {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
    await cdp.send('Input.insertText', { text })
    await page.waitForTimeout(30)
  }
  const read = () =>
    page.evaluate(() => {
      const s = (window as unknown as { s: { content(): { text: string }; canRedo: boolean } }).s
      const t = s.content().text
      return { length: t.length, head: t.slice(0, 3), canRedo: s.canRedo }
    })
  const act = (what: 'undo' | 'redo') => page.evaluate((what) => (window as unknown as { s: Record<string, () => boolean> }).s[what]!(), what)
  const base = 'x'.repeat(499999)
  // `A` typed, then `B` composed straight after: `B` goes, `A` stays, and redo does not bring `B` back.
  await mount([{ type: 'codeBlock', text: base }], 0)
  await page.keyboard.type('A')
  await compose('B')
  expect(await read()).toEqual({ length: 500000, head: 'Axx', canRedo: false })
  await act('redo')
  expect((await read()).length).toBe(500000)
  await act('undo')
  expect(await read()).toMatchObject({ length: 499999, head: 'xxx' })
  await act('redo')
  expect(await read()).toMatchObject({ length: 500000, head: 'Axx' })
  // Two compositions in a row: the second goes, the first stays.
  await mount([{ type: 'codeBlock', text: base }], 0)
  await compose('A')
  await compose('B')
  expect(await read()).toMatchObject({ length: 500000, head: 'Axx' })
  // Over a selection: one that fits is kept, one that does not gives the selection back.
  await mount([{ type: 'codeBlock', text: 'A' + base }], 0, [0, 1])
  await compose('B')
  expect(await read()).toMatchObject({ length: 500000, head: 'Bxx' })
  await mount([{ type: 'codeBlock', text: 'A' + base }], 0, [0, 1])
  await compose('BC')
  expect(await read()).toMatchObject({ length: 500000, head: 'Axx', canRedo: false })
})

test('R2c, R2b, R2a: the block buttons change every selected line and only those, by typing and by the panel', async ({ page }) => {
  const quotes = Array.from({ length: 65 }, (_, i) => ({ type: 'blockquote', blocks: [p(`q${i}`)] }))
  const { errors, at } = await open(page, [textRec('q', 700, 60, { text: '', fontSize: 8, width: 200, blocks: quotes })])
  const btn = (name: string) => page.getByRole('button', { name, exact: true })
  // R2c: Review, then Album and a nested Track; select all; Checklist: every line a checklist item, Track still nested.
  await newText(page, at, 80, 60)
  await page.keyboard.type('Review\n- Album\nTrack')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Control+a')
  await btn('Checklist').click()
  await expect(btn('Checklist')).toHaveAttribute('aria-pressed', 'true')
  const want = [tasks([false, [p('Review')]], [false, [p('Album'), tasks([false, [p('Track')]])]])]
  const checked = await storedWhen(page, (d) => texts(d).some((t) => JSON.stringify(t.blocks) === JSON.stringify(want)))
  const id = texts(checked).find((t) => JSON.stringify(t.blocks) === JSON.stringify(want))!.id
  // The same from Layers, on the box: back to bullets for every line, then Checklist again.
  await page.keyboard.press('Escape')
  await page.evaluate((id) => window.__writing.select(id), id)
  await btn('Bulleted list').click()
  await storedWhen(page, (d) => JSON.stringify(byId(d, id).blocks) === JSON.stringify([bullets([p('Review')], [p('Album'), bullets([p('Track')])])]))
  await btn('Checklist').click()
  await storedWhen(page, (d) => JSON.stringify(byId(d, id).blocks) === JSON.stringify(want))
  await expect(btn('Checklist')).toHaveAttribute('aria-pressed', 'true')
  // R2b: a quote holding bullets Album and Track, the caret only in Track: Quote takes Track out, Album keeps its quote.
  await newText(page, at, 80, 300)
  await page.keyboard.type('> - Album\nTrack')
  await btn('Quote').click()
  const quoted = await storedWhen(page, (d) => texts(d).some((t) => t.text === 'Album\nTrack' && JSON.stringify(t.blocks) !== JSON.stringify([{ type: 'blockquote', blocks: [bullets([p('Album')], [p('Track')])] }])))
  expect(texts(quoted).find((t) => t.text === 'Album\nTrack')!.blocks).toEqual([{ type: 'blockquote', blocks: [bullets([p('Album')])] }, bullets([p('Track')])])
  await expect(btn('Quote')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ArrowUp')
  await expect(btn('Quote')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  // R2a: 65 sibling quotes, the box selected from Layers, the pressed Quote pressed once: every quote goes.
  await page.evaluate(() => window.__writing.select('q'))
  await expect(btn('Quote')).toHaveAttribute('aria-pressed', 'true')
  await btn('Quote').click()
  const unquoted = await storedWhen(page, (d) => byId(d, 'q').blocks === undefined)
  expect((byId(unquoted, 'q').text as string).split('\n')).toHaveLength(65)
  await expect(btn('Quote')).toHaveAttribute('aria-pressed', 'false')
  expect(errors).toEqual([])
})

test('R5: in a code block the font buttons are disabled and say why, and nothing is chosen for what is typed', async ({ page }) => {
  const { errors, at } = await open(page, [textRec('t', 100, 100, { text: 'const x', blocks: [{ type: 'codeBlock', text: 'const x' }] })])
  await editAtEnd(page, at(125, 118))
  for (const name of ['Sans', 'Serif', 'Mono', 'Handwritten', 'Display']) {
    const b = page.getByRole('button', { name, exact: true })
    await expect(b, name).toBeDisabled()
    await expect(b, name).toHaveAttribute('data-tip', `${name}: code blocks are always Mono`)
  }
  // Clicking one does nothing, and the text keeps the keyboard.
  await page.getByRole('button', { name: 'Serif', exact: true }).click({ force: true })
  expect(await editedText(page)).toMatchObject({ focused: true })
  await page.keyboard.type('X')
  const saved = await storedWhen(page, (d) => byId(d, 't').text === 'const xX')
  expect(byId(saved, 't').blocks).toEqual([{ type: 'codeBlock', text: 'const xX' }])
  expect(errors).toEqual([])
})

test('R6: a frame preview shows a list number that reaches into the frame from a text outside it', async ({ page }) => {
  const frame = { id: 'F', name: 'Edge', left: 20, top: 20, width: 400, height: 240 }
  const { errors } = await open(page, [textRec('t', frame.left + frame.width + 55, 80, { fontSize: 24, width: 300, blocks: [{ type: 'orderedList', start: 123456789, items: [{ blocks: [p('Listen')] }] }] })], [frame])
  const li = await rectIn(page, 'ol > li')
  const r: Region = { name: 'number inside the frame', left: frame.left + frame.width - 60, top: li.top + 0.15 * li.em, width: 58, height: 1.1 * li.em }
  const board = await screenPixels(page, r.left, r.top, r.width, r.height)
  expect(inkShare(board), 'the board shows part of the number inside the frame').toBeGreaterThan(0.02)
  const url = await page.evaluate(() => window.__writing.preview('F'))
  const png = decodePng(Buffer.from(url.split(',')[1]!, 'base64'))
  const shown = inkShare(previewCrop(png, png.width / frame.width, frame, r))
  expect(shown, 'the preview shows it too').toBeGreaterThan(inkShare(board) * 0.5)
  expect(errors).toEqual([])
})
