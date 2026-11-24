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
  const { errors, at } = await open(page, [textRec('L', 600, 400, { text: 'x', blocks: [bullets([p('x')])] })])
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
  const { errors, at } = await open(page, [
    textRec('n', 40, 40, { text: '', fontSize: 8, width: 200, blocks: [bullets(...items)] }),
    textRec('d', 600, 40, { text: '', blocks: [deep] }),
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
  // Checklist turned the list the caret was in into a checklist; the divider, the quote and the code went in at the caret, in its item.
  expect(byId(done, 't').blocks).toEqual([
    tasks([false, [p('a')]], [false, [p('b'), { type: 'divider' }, { type: 'blockquote', blocks: [{ type: 'paragraph', content: [{ text: 'q' }, { text: 'c', code: true }] }] }]]),
  ])
  await page.keyboard.press('Escape')
  // One undo step for the whole edit.
  await undoButton(page).click()
  expect(byId(await storedWhen(page, (d) => byId(d, 't').text === 'a\nb'), 't').blocks).toEqual([bullets([p('a')], [p('b')])])
  expect(errors).toEqual([])
})
