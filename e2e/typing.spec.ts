/**
 * Real-browser tests (real Fabric, real IndexedDB) for the typing shortcuts: `# `, `## `,
 * `### ` at the start of a line, `**bold**` and `*italic*` typed character by character, and
 * Backspace straight afterwards to get the literal characters back. What is stored, that
 * Fabric's object and its hidden textarea still agree afterwards (typing, Backspace, the arrow
 * keys, selection and paste behave normally), what stays literal, history and saving.
 */
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, openApp, openBlank, redoButton, sceneToPage, seedMilestone1, status, storedDoc, undoButton, waitSaved } from './helpers.ts'
import type { StoredBoard, StoredObject, View } from './helpers.ts'

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }

type Seed = StoredObject & { type: 'text'; text: string; fontSize: number; width: number }
const textRec = (id: string, left: number, top: number, text: string, extra: Partial<Seed> = {}): Seed => ({
  type: 'text',
  id,
  left,
  top,
  angle: 0,
  text,
  fontSize: 24,
  width: 360,
  ...extra,
})
const board = (objects: unknown[], frames?: unknown[]) => ({ version: frames ? 2 : 1, title: 'Typing', objects, viewport: UNIT, ...(frames && { frames }) })

async function open(page: Page, objects: unknown[], opts: { clipboard?: boolean } = {}) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  if (opts.clipboard) await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openBlank(page)
  await seedMilestone1(page, board(objects))
  await openApp(page)
  return { errors, at: await sceneToPage(page, UNIT) }
}

const byId = (doc: StoredBoard, id: string) => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no object ${id}`)
  return found
}
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}

/** Enters editing of the text under `p` and puts the caret at its very end (Fabric's Ctrl+End only goes to the end of the line). */
async function editAtEnd(page: Page, p: { x: number; y: number }) {
  await page.mouse.dblclick(p.x, p.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('ArrowRight')
}
/** Types character by character, as a person does (a keydown, the input, a keyup per character). */
const typeKeys = (page: Page, s: string) => page.keyboard.type(s)

/** Fabric's hidden textarea: its value and selection (UTF-16). */
const textarea = (page: Page) =>
  page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-fabric="textarea"]')
    return ta ? { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd, focused: document.activeElement === ta } : null
  })

const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true })

test.describe("Fabric's object and its hidden textarea agree after a conversion", () => {
  test('bold: typing, Backspace, arrow keys, selection and paste straight afterwards behave normally', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'go')
    const { errors, at } = await open(page, [rec], { clipboard: true })
    await editAtEnd(page, at(110, 112))
    await typeKeys(page, ' **bold**')
    expect(await textarea(page)).toEqual({ value: 'go bold', start: 7, end: 7, focused: true })
    const converted = await storedWhen(page, (d) => byId(d, 't').text === 'go bold') // the typing save has the converted state
    expect(byId(converted, 't')).toEqual({ ...rec, text: 'go bold', spans: [{ start: 3, end: 7, bold: true }] })
    // typing on: plain, right after the bold word
    await typeKeys(page, ' x')
    await storedWhen(page, (d) => byId(d, 't').text === 'go bold x')
    expect(byId(await storedDoc(page), 't')).toEqual({ ...rec, text: 'go bold x', spans: [{ start: 3, end: 7, bold: true }] })
    // Backspace deletes normally now (the next text change ended "straight after")
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await storedWhen(page, (d) => byId(d, 't').text === 'go bold')
    // arrow keys and a selection: select "ol" and replace it
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    expect(await textarea(page)).toEqual({ value: 'go bold', start: 4, end: 6, focused: true })
    await typeKeys(page, 'O')
    await storedWhen(page, (d) => byId(d, 't').text === 'go bOd')
    expect(byId(await storedDoc(page), 't').spans).toEqual([{ start: 3, end: 6, bold: true }])
    // copy and paste through Fabric's own clipboard path
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('ArrowRight') // collapses the selection
    await page.keyboard.press('End')
    await page.keyboard.press('Control+v')
    await storedWhen(page, (d) => byId(d, 't').text === 'go bOdgo')
    expect(await textarea(page)).toEqual({ value: 'go bOdgo', start: 8, end: 8, focused: true })
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'go bOdgo')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'go bOdgo', spans: [{ start: 3, end: 6, bold: true }] })
    expect(errors).toEqual([])
  })

  test('a revert: the literal characters come back exactly, then typing, arrows and Backspace behave normally', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'go')
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(110, 112))
    await typeKeys(page, ' *it*')
    await storedWhen(page, (d) => byId(d, 't').text === 'go it')
    await page.keyboard.press('Backspace') // puts the markers back, deletes nothing
    expect(await textarea(page)).toEqual({ value: 'go *it*', start: 7, end: 7, focused: true })
    const reverted = await storedWhen(page, (d) => byId(d, 't').text === 'go *it*')
    expect(byId(reverted, 't')).toEqual({ ...rec, text: 'go *it*' })
    await typeKeys(page, '!') // stays literal
    await storedWhen(page, (d) => byId(d, 't').text === 'go *it*!')
    await page.keyboard.press('Backspace') // deletes normally
    await page.keyboard.press('Backspace')
    await storedWhen(page, (d) => byId(d, 't').text === 'go *it')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await typeKeys(page, 'X')
    await storedWhen(page, (d) => byId(d, 't').text === 'go *Xit')
    expect(await textarea(page)).toEqual({ value: 'go *Xit', start: 5, end: 5, focused: true })
    await page.keyboard.press('Escape')
    expect(byId(await storedWhen(page, (d) => byId(d, 't').text === 'go *Xit'), 't')).toEqual({ ...rec, text: 'go *Xit' })
    expect(errors).toEqual([])
  })

  test('a heading on a line with text after the caret, then typing and Backspace there', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'one\nTitle')
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(110, 112))
    await page.keyboard.press('Home') // start of "Title"
    await typeKeys(page, '## ')
    expect(await textarea(page)).toEqual({ value: 'one\nTitle', start: 4, end: 4, focused: true })
    await storedWhen(page, (d) => byId(d, 't').headings !== undefined)
    expect(byId(await storedDoc(page), 't')).toEqual({ ...rec, headings: [0, 2] })
    await typeKeys(page, 'A ')
    await storedWhen(page, (d) => byId(d, 't').text === 'one\nA Title')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace') // joins the heading onto "one": the line it joins keeps its level
    await storedWhen(page, (d) => byId(d, 't').text === 'oneTitle')
    expect(byId(await storedDoc(page), 't')).toEqual({ ...rec, text: 'oneTitle' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})


test.describe('each shortcut, typed for real and stored after leaving the edit', () => {
  test('bold and italic: what is typed straight afterwards is plain (real Fabric copies the neighbouring style)', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'a')
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(105, 112))
    await typeKeys(page, ' **bold**x *it*y')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'a boldx ity')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'a boldx ity', spans: [{ start: 2, end: 6, bold: true }, { start: 8, end: 10, italic: true }] })
    expect(errors).toEqual([])
  })

  test('headings: on an empty line, at the start of a line with text, changing a level; the caret is at the start of the line', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Old\nbody', { headings: [3] })
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(105, 112))
    await page.keyboard.press('Enter')
    await typeKeys(page, '# Big')
    await page.keyboard.press('Enter')
    await typeKeys(page, '### small')
    // back to the start of "Old" (a level 3 heading) and make it level 2
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowLeft')
    await typeKeys(page, '## ')
    expect(await textarea(page)).toMatchObject({ value: 'Old\nbody\nBig\nsmall', start: 0, end: 0 })
    await typeKeys(page, 'An ')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'An Old\nbody\nBig\nsmall')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'An Old\nbody\nBig\nsmall', headings: [2, 0, 1, 3] })
    expect(errors).toEqual([])
  })

  test('literal cases are stored exactly as typed', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'x', { width: 600 })
    const { errors, at } = await open(page, [rec])
    const lines = ['2 * 3 * 4', 'a ** b', '* item', '**', 'snake*case*', '***x***', '#tag', '####  four', 'a # b', '** x**', '*x *', '#x']
    await editAtEnd(page, at(105, 112))
    for (const line of lines) {
      await page.keyboard.press('Enter')
      await typeKeys(page, line)
    }
    await page.keyboard.press('Escape')
    const want = ['x', ...lines].join('\n')
    const done = await storedWhen(page, (d) => byId(d, 't').text === want)
    expect(byId(done, 't')).toEqual({ ...rec, text: want })
    expect(errors).toEqual([])
  })

  test('pasted markers stay literal: a pasted `**x**`, and a pasted `*` that would close a marker', async ({ page }) => {
    const src = textRec('src', 100, 300, '**x** *')
    const rec = textRec('t', 100, 100, 'go')
    const { errors, at } = await open(page, [rec, src], { clipboard: true })
    await editAtEnd(page, at(105, 312))
    await page.keyboard.press('Home')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Control+c') // "**x**"
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await editAtEnd(page, at(105, 112))
    await typeKeys(page, ' ')
    await page.keyboard.press('Control+v')
    await storedWhen(page, (d) => byId(d, 't').text === 'go **x**')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await editAtEnd(page, at(105, 312))
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+c') // "*"
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await editAtEnd(page, at(105, 112))
    await typeKeys(page, ' *i')
    await page.keyboard.press('Control+v')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'go **x** *i*')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'go **x** *i*' })
    expect(errors).toEqual([])
  })

  test('an IME composition that produces `*` or a space fires nothing', async ({ page }) => {
    const rec = textRec('t', 100, 100, '*i')
    const { errors, at } = await open(page, [rec])
    const cdp = await page.context().newCDPSession(page)
    await editAtEnd(page, at(105, 112))
    await cdp.send('Input.imeSetComposition', { text: '*', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.insertText', { text: '*' })
    await storedWhen(page, (d) => byId(d, 't').text === '*i*')
    await page.keyboard.press('Enter')
    await typeKeys(page, '#')
    await cdp.send('Input.imeSetComposition', { text: ' ', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.insertText', { text: ' ' })
    await typeKeys(page, 'T')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === '*i*\n# T')
    expect(byId(done, 't')).toEqual({ ...rec, text: '*i*\n# T' })
    expect(errors).toEqual([])
  })
})

test.describe('Backspace straight after a shortcut', () => {
  test('each kind comes back literally; typing on stays literal and is stored', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'x', { width: 500 })
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(105, 112))
    await typeKeys(page, ' **b**')
    await page.keyboard.press('Backspace')
    await typeKeys(page, ' *i*')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await typeKeys(page, '## ')
    await page.keyboard.press('Backspace')
    await typeKeys(page, 'H')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'x **b** *i*\n## H')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'x **b** *i*\n## H' })
    expect(errors).toEqual([])
  })

  test('after moving the caret (arrow key, or a click in the text) Backspace deletes normally', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'go')
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(105, 112))
    await typeKeys(page, ' *ab*')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Backspace') // deletes "a"
    await storedWhen(page, (d) => byId(d, 't').text === 'go b')
    await page.keyboard.press('End')
    await typeKeys(page, ' **c**')
    await page.mouse.click(at(105, 112).x, at(105, 112).y) // a click in the text moves the caret
    await page.keyboard.press('End')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'go b ')
    // after the arrow key the pending plain choice was dropped: the space typed next to the italic b is italic, as typing is
    expect(byId(done, 't')).toEqual({ ...rec, text: 'go b ', spans: [{ start: 3, end: 5, italic: true }] })
    expect(errors).toEqual([])
  })
})

test.describe('history', () => {
  const ways: Array<[string, (page: Page, at: (x: number, y: number) => { x: number; y: number }) => Promise<void>]> = [
    ['Esc', (page) => page.keyboard.press('Escape')],
    ['a click on empty canvas', (page, at) => page.mouse.click(at(700, 600).x, at(700, 600).y)],
    ['a click on another object', (page, at) => page.mouse.click(at(105, 312).x, at(105, 312).y)],
    ['a toolbar tool button', (page) => page.getByRole('button', { name: 'Hand (pan)', exact: true }).click()],
  ]
  for (const [how, leave] of ways) {
    test(`a conversion, left by ${how}, is one undo step; undo and redo restore it exactly`, async ({ page }) => {
      const rec = textRec('t', 100, 100, 'go')
      const other = textRec('o', 100, 300, 'other')
      const { errors, at } = await open(page, [rec, other])
      await editAtEnd(page, at(105, 112))
      await typeKeys(page, ' **b** and')
      await page.keyboard.press('Enter')
      await typeKeys(page, '# H')
      const want = { ...rec, text: 'go b and\nH', spans: [{ start: 3, end: 4, bold: true }], headings: [0, 1] }
      await storedWhen(page, (d) => byId(d, 't').text === want.text)
      await leave(page, at)
      await storedWhen(page, (d) => byId(d, 't').text === want.text)
      expect(byId(await storedDoc(page), 't')).toEqual(want)
      await waitSaved(page)
      await undoButton(page).click()
      await storedWhen(page, (d) => byId(d, 't').text === 'go')
      expect(byId(await storedDoc(page), 't')).toEqual(rec)
      await expect(undoButton(page)).toBeDisabled()
      await redoButton(page).click()
      await storedWhen(page, (d) => byId(d, 't').text === want.text)
      expect(byId(await storedDoc(page), 't')).toEqual(want)
      await waitSaved(page)
      await page.reload()
      await expect(status(page)).toContainText('Saved on this device')
      await page.waitForTimeout(AUTOSAVE_QUIET_MS)
      expect(byId(await storedDoc(page), 't')).toEqual(want)
      expect(errors).toEqual([])
    })
  }

  test("the browser's own Ctrl+Z in the text after a conversion or a revert corrupts nothing", async ({ page }) => {
    const rec = textRec('t', 100, 100, 'go')
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(105, 112))
    await typeKeys(page, ' **b**')
    await page.keyboard.press('Control+z') // the conversion replaced the textarea's value: nothing to undo there
    await typeKeys(page, 'q')
    await page.keyboard.press('Control+z') // undoes only the "q"
    await typeKeys(page, ' *i*')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Control+z')
    expect(await textarea(page)).toMatchObject({ value: 'go b *i*', start: 8, end: 8 })
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'go b *i*')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'go b *i*', spans: [{ start: 3, end: 4, bold: true }] })
    expect(errors).toEqual([])
  })

  test('a new text started with `# Title` from the Text tool; one started with `# ` and left blank is discarded', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await page.mouse.click(at(300, 300).x, at(300, 300).y)
    await typeKeys(page, '# ')
    await page.keyboard.press('Escape') // blank: discarded, no step
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect((await storedDoc(page)).objects).toEqual([])
    await expect(undoButton(page)).toBeDisabled()
    await page.keyboard.press('t')
    await page.mouse.click(at(300, 300).x, at(300, 300).y)
    await typeKeys(page, '# Title')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => d.objects.length === 1)
    expect(done.objects[0]).toMatchObject({ text: 'Title', headings: [1] })
    await undoButton(page).click()
    await storedWhen(page, (d) => d.objects.length === 0)
    expect(errors).toEqual([])
  })
})

test.describe('slice 2 follow-ups', () => {
  test('a held Ctrl+B or Ctrl+U toggles once; its repeats are claimed (the browser does nothing with them) and toggle nothing', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'abc')
    const { errors, at } = await open(page, [rec])
    await page.evaluate(() => {
      const seen: Array<[string, boolean, boolean]> = []
      ;(window as unknown as { __seen: typeof seen }).__seen = seen
      window.addEventListener('keydown', (e) => {
        if (e.key === 'b' || e.key === 'u') seen.push([e.key, e.repeat, e.defaultPrevented])
      })
    })
    const seen = () => page.evaluate(() => (window as unknown as { __seen: Array<[string, boolean, boolean]> }).__seen)
    await page.mouse.dblclick(at(105, 112).x, at(105, 112).y)
    await page.keyboard.press('Control+a')
    await page.keyboard.down('Control')
    for (let i = 0; i < 4; i++) await page.keyboard.down('b') // the first press, then three repeats
    await page.keyboard.up('b')
    await page.keyboard.up('Control')
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape') // leave the edit; the box stays selected
    await page.keyboard.down('Control')
    for (let i = 0; i < 3; i++) await page.keyboard.down('u')
    await page.keyboard.up('u')
    await page.keyboard.up('Control')
    const done = await storedWhen(page, (d) => byId(d, 't').spans?.[0]?.underline === true)
    expect(byId(done, 't')).toEqual({ ...rec, spans: [{ start: 0, end: 3, bold: true, underline: true }] })
    expect(await seen()).toEqual([
      ['b', false, true],
      ['b', true, true],
      ['b', true, true],
      ['b', true, true],
      ['u', false, true],
      ['u', true, true],
      ['u', true, true],
    ])
    expect(errors).toEqual([])
  })

  test('a box whose text ends with an empty line: the panel shows its heading, and a heading on the box leaves the empty last line alone', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\n', { headings: [1] })
    const { errors, at } = await open(page, [rec])
    await page.mouse.click(at(120, 120).x, at(120, 120).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    await expect(button(page, 'H1 (Heading 1)')).toHaveAttribute('aria-pressed', 'true')
    await button(page, 'H2 (Heading 2)').click()
    const done = await storedWhen(page, (d) => byId(d, 't').headings?.[0] === 2)
    expect(byId(done, 't')).toEqual({ ...rec, headings: [2] })
    await expect(button(page, 'H2 (Heading 2)')).toHaveAttribute('aria-pressed', 'true')
    expect(errors).toEqual([])
  })

  test('heading buttons are named after what they show; the greyed-out Bold in a heading has one tip that explains it', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title', { headings: [1] })
    const { errors, at } = await open(page, [rec])
    await page.mouse.click(at(120, 120).x, at(120, 120).y)
    for (const n of [1, 2, 3]) await expect(button(page, `H${n} (Heading ${n})`)).toHaveText(`H${n}`)
    await expect(button(page, 'Body')).toHaveText('Body')
    const bold = button(page, 'Bold')
    await expect(bold).toBeDisabled()
    await expect(bold).not.toHaveAttribute('title')
    await expect(bold).toHaveAttribute('data-tip', 'Bold: headings are always bold')
    await bold.hover({ force: true })
    await expect.poll(() => bold.evaluate((el) => getComputedStyle(el, '::after').display)).not.toBe('none')
    expect(errors).toEqual([])
  })
})

test.describe('slice 3 review follow-ups', () => {
  test('Body on a box also clears an empty last line that is still a heading; a heading level leaves it alone', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\n', { headings: [1, 1] }) // "Title\nSub", both headings, with "Sub" deleted
    const { errors, at } = await open(page, [rec])
    await page.mouse.click(at(120, 120).x, at(120, 120).y)
    await expect(button(page, 'H1 (Heading 1)')).toHaveAttribute('aria-pressed', 'true')
    await button(page, 'H2 (Heading 2)').click()
    await storedWhen(page, (d) => byId(d, 't').headings?.[0] === 2)
    expect(byId(await storedDoc(page), 't')).toEqual({ ...rec, headings: [2, 1] })
    await button(page, 'Body').click()
    const done = await storedWhen(page, (d) => byId(d, 't').headings === undefined)
    const { headings: _gone, ...plain } = rec
    void _gone
    expect(byId(done, 't')).toEqual(plain)
    await expect(button(page, 'Body')).toHaveAttribute('aria-pressed', 'true')
    expect(errors).toEqual([])
  })

  test('with italic pending from the panel, typing `**b**x` gives "b" bold and italic and "x" italic only', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'go ')
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(105, 112))
    await button(page, 'Italic').click()
    await typeKeys(page, '**b**x')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'go bx')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'go bx', spans: [{ start: 3, end: 4, bold: true, italic: true }, { start: 4, end: 5, italic: true }] })
    expect(errors).toEqual([])
  })

  test('holding Backspace straight after `# ` reverts once, then its repeats delete normally', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'abc')
    const { errors, at } = await open(page, [rec])
    await editAtEnd(page, at(105, 112))
    await page.keyboard.press('Home')
    await typeKeys(page, '# ')
    await storedWhen(page, (d) => byId(d, 't').headings !== undefined)
    await page.keyboard.down('Backspace') // reverts: "# abc"
    expect(await textarea(page)).toMatchObject({ value: '# abc', start: 2, end: 2 })
    await page.keyboard.down('Backspace') // a repeat: deletes the space
    expect(await textarea(page)).toMatchObject({ value: '#abc', start: 1, end: 1 })
    await page.keyboard.down('Backspace') // and the "#"
    await page.keyboard.up('Backspace')
    expect(await textarea(page)).toMatchObject({ value: 'abc', start: 0, end: 0 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(byId(await storedDoc(page), 't')).toEqual(rec) // no heading stored
    await expect(undoButton(page)).toBeDisabled() // the edit changed nothing in the end
    expect(errors).toEqual([])
  })
})

test.describe('a pending bold never survives onto a heading line (QA final pass)', () => {
  /** A new blank text from a Text tool click, being typed into. */
  async function newText(page: Page) {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await page.mouse.click(at(150, 150).x, at(150, 150).y)
    return errors
  }
  const only = async (page: Page) => storedWhen(page, (d) => d.objects.length === 1).then((d) => d.objects[0]!)

  for (const mode of ['control', 'panel H1', '`# `', '`## `'] as const) {
    test(`${mode}: "Title", Enter, "Body" stores a plain body line and no bold at all`, async ({ page }) => {
      const errors = await newText(page)
      if (mode !== 'control') await page.keyboard.press('Control+b')
      if (mode === '`# `') await typeKeys(page, '# ')
      else if (mode === '`## `') await typeKeys(page, '## ')
      else await button(page, 'H1 (Heading 1)').click()
      await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true') // the heading's own bold
      await expect(button(page, 'Bold')).toBeDisabled()
      await typeKeys(page, 'Title')
      await page.keyboard.press('Enter')
      await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'false') // the new normal line is plain
      await typeKeys(page, 'Body')
      await page.keyboard.press('Escape')
      const rec = await only(page)
      expect(rec).toMatchObject({ text: 'Title\nBody', headings: [mode === '`## `' ? 2 : 1] })
      expect(rec.spans).toBeUndefined()
      expect(errors).toEqual([])
    })
  }

  test('bold pending, H1 from the panel, then Enter straight away (nothing typed on the heading line): the next line is plain', async ({ page }) => {
    const errors = await newText(page)
    await page.keyboard.press('Control+b')
    await button(page, 'H1 (Heading 1)').click()
    await page.keyboard.press('Enter')
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'false')
    await typeKeys(page, 'Body')
    await page.keyboard.press('Escape')
    const rec = await only(page)
    expect(rec).toMatchObject({ text: '\nBody', headings: [1] })
    expect(rec.spans).toBeUndefined()
    expect(errors).toEqual([])
  })

  test('italic and bold pending, then H1: the heading and the line after it are italic, nothing is stored bold', async ({ page }) => {
    const errors = await newText(page)
    await page.keyboard.press('Control+i')
    await page.keyboard.press('Control+b')
    await button(page, 'H1 (Heading 1)').click()
    await typeKeys(page, 'Title')
    await page.keyboard.press('Enter')
    await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true')
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'false')
    await typeKeys(page, 'Body')
    await page.keyboard.press('Escape')
    const rec = await only(page)
    expect(rec).toMatchObject({ text: 'Title\nBody', headings: [1], spans: [{ start: 0, end: 10, italic: true }] })
    expect(errors).toEqual([])
  })

  test('Backspace straight after `# ` brings back the literal characters and the pending bold: what is typed next is bold', async ({ page }) => {
    const errors = await newText(page)
    await page.keyboard.press('Control+b')
    await typeKeys(page, '# ')
    await page.keyboard.press('Backspace')
    expect(await textarea(page)).toMatchObject({ value: '# ', start: 2, end: 2 })
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
    await expect(button(page, 'Bold')).toBeEnabled() // a normal line again: bold can be chosen
    await typeKeys(page, 'x')
    await page.keyboard.press('Escape')
    const rec = await only(page)
    expect(rec).toMatchObject({ text: '# x', spans: [{ start: 0, end: 3, bold: true }] })
    expect(rec.headings).toBeUndefined()
    expect(errors).toEqual([])
  })

  test('a normal line with bold pending joined into the heading above it (Backspace at its start): what follows the heading is plain', async ({ page }) => {
    const errors = await newText(page)
    await button(page, 'H1 (Heading 1)').click()
    await typeKeys(page, 'Title')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+b') // on the new, normal line
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Backspace') // joins it into "Title"
    await typeKeys(page, 'A')
    await page.keyboard.press('Enter')
    await typeKeys(page, 'Body')
    await page.keyboard.press('Escape')
    const rec = await only(page)
    expect(rec).toMatchObject({ text: 'TitleA\nBody', headings: [1] })
    expect(rec.spans).toBeUndefined()
    expect(errors).toEqual([])
  })
})
