/**
 * Real-browser tests (real Fabric, real IndexedDB) for applying formatting: the panel's text
 * controls and Ctrl/Cmd+B, I, U, on a selected range, at a caret, and on a whole box. What
 * is stored, what is drawn, that an edit goes on (caret, range, focus) after a control is
 * used, history and saving, and the guards.
 */
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  AUTOSAVE_QUIET_MS,
  drag,
  imageFile,
  openApp,
  openBlank,
  redoButton,
  sceneToPage,
  seedMilestone1,
  seedRaw,
  snapshotIdb,
  status,
  storedDoc,
  undoButton,
  waitSaved,
} from './helpers.ts'
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
const board = (objects: unknown[]) => ({ version: 1, title: 'Formatting', objects, viewport: UNIT })

async function open(page: Page, objects: unknown[]) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
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

/** Enters editing of the text under `p` and puts the caret after `n` characters (graphemes). */
async function caretAt(page: Page, p: { x: number; y: number }, n: number) {
  await page.mouse.dblclick(p.x, p.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowRight')
}
async function selectRight(page: Page, n: number) {
  for (let i = 0; i < n; i++) await page.keyboard.press('Shift+ArrowRight')
}

const button = (page: Page, name: string): Locator => page.getByRole('button', { name, exact: true })
/** The edit still has the keyboard: Fabric's hidden textarea is focused. */
const editHasFocus = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-fabric') === 'textarea')

interface Ink {
  count: number
  red: number
  left: number
  right: number
  top: number
  bottom: number
}
/** Dark and clearly red pixels in a rectangle of the scene canvas (CSS pixels), and their extent. */
function inkIn(page: Page, left: number, top: number, width: number, height: number): Promise<Ink> {
  return page.evaluate(
    ({ left, top, width, height }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.canvas-container canvas.lower-canvas')
      if (!canvas) throw new Error('scene canvas not found')
      const scale = canvas.width / canvas.clientWidth
      const w = Math.round(width * scale)
      const d = canvas.getContext('2d')!.getImageData(Math.round(left * scale), Math.round(top * scale), w, Math.round(height * scale)).data
      const ink: Ink = { count: 0, red: 0, left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b, a] = [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!]
        const dark = a > 40 && r < 160 && g < 160 && b < 160
        const red = a > 40 && r > 150 && g < 110 && b < 110
        if (!dark && !red) continue
        if (dark) ink.count++
        if (red) ink.red++
        const x = ((i / 4) % w) / scale
        const y = Math.floor(i / 4 / w) / scale
        ink.left = Math.min(ink.left, x)
        ink.right = Math.max(ink.right, x)
        ink.top = Math.min(ink.top, y)
        ink.bottom = Math.max(ink.bottom, y)
      }
      return ink
    },
    { left, top, width, height },
  )
}
/** Deselects (Esc twice: leave the edit, then the selection), so that no selection chrome is drawn. */
async function deselect(page: Page) {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator('.inspector-title')).toHaveCount(0)
}

test.describe('marks on a range while editing', () => {
  test('select with the keyboard, click Bold: that range is stored bold and drawn bold, and typing goes on in the text', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'plain words here')
    const ref = textRec('ref', 100, 300, 'plain words here', { spans: [{ start: 6, end: 11, bold: true }] })
    const { errors, at } = await open(page, [rec, ref])
    const plainInk = await inkIn(page, 95, 90, 380, 50)
    await caretAt(page, at(130, 112), 6)
    await selectRight(page, 5) // "words"
    await button(page, 'Bold').click()
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
    expect(await editHasFocus(page)).toBe(true)
    // The typing save, mid-edit, already has it.
    const bold = await storedWhen(page, (d) => byId(d, 't').spans !== undefined)
    expect(byId(bold, 't')).toEqual({ ...rec, spans: [{ start: 6, end: 11, bold: true }] })
    // The range is still selected: typing replaces it; first collapse it to its end.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('!')
    const typed = await storedWhen(page, (d) => byId(d, 't').text === 'plain words! here')
    expect(byId(typed, 't')).toEqual({ ...rec, text: 'plain words! here', spans: [{ start: 6, end: 12, bold: true }] })
    await page.keyboard.press('Backspace')
    await storedWhen(page, (d) => byId(d, 't').text === 'plain words here')
    await deselect(page)
    await waitSaved(page)
    // Drawn like a text stored bold there.
    const a = await inkIn(page, 95, 90, 380, 50)
    const b = await inkIn(page, 95, 290, 380, 50)
    expect(a.count).toBeGreaterThan(plainInk.count * 1.05)
    expect(Math.abs(a.count - b.count)).toBeLessThan(b.count * 0.03)
    expect(Math.abs(a.right - a.left - (b.right - b.left))).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })

  test('a formatting-only edit left with Esc is one undo step; undo and redo restore it exactly; reload shows it', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'one two three', { spans: [{ start: 0, end: 3, italic: true }] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 4)
    await selectRight(page, 3) // "two"
    await button(page, 'Underline').click()
    await page.keyboard.press('Shift+ArrowRight') // "two " — with the space
    await button(page, 'Italic').click()
    await page.keyboard.press('Escape') // leaves the edit; the text did not change
    const done = await storedWhen(page, (d) => byId(d, 't').spans?.length === 3)
    const want = { ...rec, spans: [{ start: 0, end: 3, italic: true }, { start: 4, end: 7, italic: true, underline: true }, { start: 7, end: 8, italic: true }] }
    expect(byId(done, 't')).toEqual(want)
    await waitSaved(page)
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').spans?.length === 1)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    await expect(undoButton(page)).toBeDisabled() // the whole edit was one step
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').spans?.length === 3)
    expect(byId(await storedDoc(page), 't')).toEqual(want)
    await waitSaved(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(byId(await storedDoc(page), 't')).toEqual(want) // loading rewrote nothing
    expect(errors).toEqual([])
  })

  test('Ctrl+B, Ctrl+I, Ctrl+U on a selected range; the keys of the edit itself still work', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'alpha beta')
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 0)
    await selectRight(page, 5)
    await page.keyboard.press('Control+b')
    await page.keyboard.press('Control+i')
    await page.keyboard.press('Control+u')
    const done = await storedWhen(page, (d) => byId(d, 't').spans !== undefined && Object.keys(d.objects[0]!.spans![0]!).length === 5)
    expect(byId(done, 't')).toEqual({ ...rec, spans: [{ start: 0, end: 5, bold: true, italic: true, underline: true }] })
    await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true')
    // Ctrl+A, the arrows and typing are still the edit's own.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('!')
    await storedWhen(page, (d) => byId(d, 't').text === 'alpha beta!')
    await page.keyboard.press('Escape')
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').text === 'alpha beta' && byId(d, 't').spans === undefined)
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('the panel shows the state at the caret and of the range as it moves: off, on, mixed', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'plain bold', { spans: [{ start: 6, end: 10, bold: true }] })
    const { errors, at } = await open(page, [rec])
    const bold = button(page, 'Bold')
    await caretAt(page, at(130, 112), 3)
    await expect(bold).toHaveAttribute('aria-pressed', 'false')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight') // after "b": the next character would be bold
    await expect(bold).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Home')
    await expect(bold).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Shift+End') // the whole line: part bold
    await expect(bold).toHaveAttribute('aria-pressed', 'mixed')
    await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Escape')
    await expect(bold).toHaveAttribute('aria-pressed', 'mixed') // the whole box
    expect(errors).toEqual([])
  })
})

test.describe('marks with only a caret', () => {
  test('Bold with a caret, then typing: what is typed is bold; moving the caret drops the choice', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'abc')
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(110, 112), 3)
    await button(page, 'Bold').click()
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(byId(await storedDoc(page), 't')).toEqual(rec) // nothing to save yet
    await page.keyboard.type('XY')
    const typed = await storedWhen(page, (d) => byId(d, 't').text === 'abcXY')
    expect(byId(typed, 't')).toEqual({ ...rec, text: 'abcXY', spans: [{ start: 3, end: 5, bold: true }] })
    // A choice made, then the caret moved with an arrow key: dropped.
    await page.keyboard.press('Home')
    await page.keyboard.press('Control+i')
    await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.type('-')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'a-bcXY')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'a-bcXY', spans: [{ start: 4, end: 6, bold: true }] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('a pending "off" next to a bold character really types plain text', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'bold', { spans: [{ start: 0, end: 4, bold: true }] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(110, 112), 4)
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Control+b')
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.type(' plain')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'bold plain')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'bold plain' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('a pending choice survives an IME composition', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'ab')
    const { errors, at } = await open(page, [rec])
    const cdp = await page.context().newCDPSession(page)
    await caretAt(page, at(110, 112), 2)
    await button(page, 'Underline').click()
    await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.imeSetComposition', { text: 'ka', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.insertText', { text: 'カ' })
    await page.keyboard.type('Z')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'abカZ')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'abカZ', spans: [{ start: 2, end: 4, underline: true }] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})

test.describe('a selected box (not being edited)', () => {
  test('marks toggle on the whole box, each its own undo step; Ctrl+B, I, U do the same', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'some words', { spans: [{ start: 0, end: 4, italic: true }] })
    const { errors, at } = await open(page, [rec])
    await page.mouse.click(at(130, 112).x, at(130, 112).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    await expect(button(page, 'Italic')).toHaveAttribute('aria-pressed', 'mixed')
    await button(page, 'Italic').click() // part has it: on everywhere
    await storedWhen(page, (d) => byId(d, 't').spans?.[0]?.end === 10)
    await button(page, 'Strikethrough').click()
    await page.keyboard.press('Control+b')
    await page.keyboard.press('Control+u')
    const all = await storedWhen(page, (d) => byId(d, 't').spans?.[0]?.underline === true)
    expect(byId(all, 't')).toEqual({ ...rec, spans: [{ start: 0, end: 10, bold: true, italic: true, underline: true, strike: true }] })
    await button(page, 'Italic').click() // all of it has it: off everywhere
    await storedWhen(page, (d) => byId(d, 't').spans?.[0]?.italic === undefined)
    await deselect(page)
    for (let i = 0; i < 5; i++) await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').spans?.[0]?.end === 4)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('Ctrl+B is left to the browser with an image selected and with nothing selected', async ({ page }) => {
    const { errors, at } = await open(page, [textRec('t', 100, 100, 'words')])
    await page.evaluate(() => {
      const seen: boolean[] = []
      ;(window as unknown as { __seen: boolean[] }).__seen = seen
      window.addEventListener('keydown', (e) => {
        if (e.key === 'b') seen.push(e.defaultPrevented)
      })
    })
    const seen = () => page.evaluate(() => (window as unknown as { __seen: boolean[] }).__seen)
    await page.keyboard.press('Control+b') // nothing selected
    const image = page.getByTestId('image-input')
    await image.setInputFiles(imageFile('pic.png', 80, 60))
    await expect(page.locator('.inspector-title')).toHaveText('Image')
    await page.keyboard.press('Control+b')
    await page.mouse.click(at(110, 112).x, at(110, 112).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    await page.keyboard.press('Control+b')
    expect(await seen()).toEqual([false, false, true])
    expect(errors).toEqual([])
  })

  test('headings: Heading 1 on every line of the box, then back to Body leaves no bold; drawn taller', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { spans: [{ start: 6, end: 10, bold: true }] })
    const { errors, at } = await open(page, [rec])
    const ink0 = await inkIn(page, 90, 90, 500, 300)
    await page.mouse.click(at(120, 112).x, at(120, 112).y)
    await button(page, 'H1 (Heading 1)').click()
    await expect(button(page, 'H1 (Heading 1)')).toHaveAttribute('aria-pressed', 'true')
    await expect(button(page, 'Bold')).toBeDisabled() // headings are always bold
    await expect(button(page, 'Bold')).toHaveAttribute('aria-pressed', 'true')
    const h = await storedWhen(page, (d) => byId(d, 't').headings !== undefined)
    expect(byId(h, 't')).toEqual({ ...rec, spans: undefined, headings: [1, 1] })
    await deselect(page)
    await waitSaved(page)
    const ink1 = await inkIn(page, 90, 90, 500, 300)
    expect((ink1.bottom - ink1.top) / (ink0.bottom - ink0.top)).toBeGreaterThan(1.8)
    await page.mouse.click(at(120, 112).x, at(120, 112).y)
    await button(page, 'Body').click()
    const b = await storedWhen(page, (d) => byId(d, 't').headings === undefined)
    expect(byId(b, 't')).toEqual({ ...rec, spans: undefined })
    expect(errors).toEqual([])
  })

  test('font, alignment and colour are stored and drawn; alignment keeps the box where it is', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Sample', { width: 400 })
    const { errors, at } = await open(page, [rec])
    const left0 = await inkIn(page, 95, 90, 410, 50)
    await page.mouse.click(at(120, 112).x, at(120, 112).y)
    await button(page, 'Serif').click()
    await button(page, 'Align right').click()
    await button(page, 'Red').click()
    await expect(button(page, 'Red')).toHaveAttribute('aria-pressed', 'true')
    const done = await storedWhen(page, (d) => byId(d, 't').color !== undefined)
    expect(byId(done, 't')).toEqual({ ...rec, font: 'serif', align: 'right', color: '#d92d20' })
    await deselect(page)
    await waitSaved(page)
    const ink = await inkIn(page, 95, 90, 410, 50)
    expect(ink.red).toBeGreaterThan(100)
    expect(ink.count).toBeLessThan(ink.red / 4) // the words are red, not ink
    expect(ink.left).toBeGreaterThan(left0.left + 200) // moved to the right edge of the box
    // The box spans x 100 to 500; the sampled rectangle starts at x 95.
    expect(ink.right).toBeGreaterThan(405 - 15) // up against the box's right edge
    expect(ink.right).toBeLessThanOrEqual(405 + 2) // and no further
    await page.mouse.click(at(480, 112).x, at(480, 112).y)
    await button(page, 'Align centre').click()
    await button(page, 'Ink').click()
    const centred = await storedWhen(page, (d) => byId(d, 't').align === 'center' && byId(d, 't').color === undefined)
    expect(byId(centred, 't')).toEqual({ ...rec, font: 'serif', align: 'center' }) // left and width unchanged
    expect(errors).toEqual([])
  })
})

test.describe('headings while editing', () => {
  test('on the caret line, on the lines a range touches, and on an empty line; Body again; one undo for the edit', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'one\ntwo\n\nfour')
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(110, 112), 5) // in "two"
    await button(page, 'H2 (Heading 2)').click()
    expect(await editHasFocus(page)).toBe(true)
    await storedWhen(page, (d) => JSON.stringify(byId(d, 't').headings) === '[0,2]')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await selectRight(page, 5) // "ne\ntw"
    await button(page, 'H3 (Heading 3)').click()
    await storedWhen(page, (d) => JSON.stringify(byId(d, 't').headings) === '[3,3]')
    await page.keyboard.press('ArrowRight')
    for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight') // the empty line
    await button(page, 'H1 (Heading 1)').click()
    await storedWhen(page, (d) => JSON.stringify(byId(d, 't').headings) === '[3,3,1]')
    await page.keyboard.type('three')
    const typed = await storedWhen(page, (d) => byId(d, 't').text === 'one\ntwo\nthree\nfour')
    expect(byId(typed, 't')).toEqual({ ...rec, text: 'one\ntwo\nthree\nfour', headings: [3, 3, 1] })
    await page.keyboard.press('ArrowUp')
    await button(page, 'Body').click()
    await storedWhen(page, (d) => JSON.stringify(byId(d, 't').headings) === '[3,0,1]')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').text === 'one\ntwo\n\nfour')
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('font, alignment and colour while editing: the edit, its range and the box position stay', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'keep typing', { width: 300, align: 'center' })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(250, 112), 5)
    await selectRight(page, 6) // "typing"
    await button(page, 'Mono').click()
    await button(page, 'Align right').click()
    await button(page, 'Blue').click()
    expect(await editHasFocus(page)).toBe(true)
    await page.keyboard.type('going') // replaces the range that was selected before the clicks
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'keep going')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'keep going', spans: [{ start: 5, end: 10, font: 'mono' }], align: 'right', color: '#1c6fd1' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})

test.describe('font on a text range or at the caret', () => {
  test('keeps a wrapped Unicode range selected and preserves its marks through undo and reload', async ({ page }) => {
    const word = '👩🏽‍🚀 two'
    const rec = textRec('t', 100, 100, `one ${word} three four`, { width: 110, spans: [{ start: 4, end: 4 + word.length, italic: true }] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(110, 112), 4)
    await selectRight(page, 5) // one emoji, a space and three letters
    const range = () => page.locator('textarea[data-fabric=textarea]').evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))
    expect(await range()).toBe(word)
    await button(page, 'Mono').click()
    expect(await range()).toBe(word)
    expect(await editHasFocus(page)).toBe(true)
    await expect(button(page, 'Mono')).toHaveAttribute('aria-pressed', 'true')
    await selectRight(page, 2)
    await expect(page.getByText('Mixed', { exact: true })).toBeVisible()
    const want = { ...rec, spans: [{ ...rec.spans![0], font: 'mono' }] }
    await page.keyboard.press('Escape')
    await waitSaved(page)
    expect(byId(await storedDoc(page), 't')).toEqual(want)
    await undoButton(page).click()
    await waitSaved(page)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    await redoButton(page).click()
    await waitSaved(page)
    await page.reload()
    await expect(status(page)).toContainText('Saved on this device')
    await caretAt(page, at(110, 112), 4)
    await selectRight(page, 5)
    await expect(button(page, 'Mono')).toHaveAttribute('aria-pressed', 'true')
    expect(byId(await storedDoc(page), 't')).toEqual(want)
    await page.keyboard.press('Escape')
    await button(page, 'Serif').click()
    await waitSaved(page)
    expect(byId(await storedDoc(page), 't')).toEqual({ ...rec, font: 'serif' })
    expect(errors).toEqual([])
  })

  test('a caret font affects typing and Markdown conversion until the caret moves', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'one two')
    const { at } = await open(page, [rec])
    await caretAt(page, at(110, 112), 4)
    await button(page, 'Serif').click()
    await expect(button(page, 'Serif')).toHaveAttribute('aria-pressed', 'true')
    await expect(undoButton(page)).toBeDisabled()
    await page.keyboard.type('*it* ')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('X')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    expect(byId(await storedDoc(page), 't')).toEqual({
      ...rec, text: 'Xone it two', spans: [{ start: 5, end: 7, italic: true, font: 'serif' }, { start: 7, end: 8, font: 'serif' }],
    })
  })
})

test.describe('guards and lifecycle', () => {
  test('a read-only board shows no formatting controls and writes nothing', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const rec = textRec('t', 100, 100, 'Sample words')
    const lost = { type: 'image', id: 'lost', left: 600, top: 300, angle: 0, assetId: 'gone', scaleX: 1, scaleY: 1 }
    await openBlank(page)
    await seedMilestone1(page, board([rec, lost]))
    await page.goto('/')
    await expect(page.getByTestId('readonly-banner')).toContainText('could not be loaded')
    const before = await snapshotIdb(page)
    const at = await sceneToPage(page, UNIT)
    await page.mouse.click(at(120, 112).x, at(120, 112).y)
    await page.mouse.dblclick(at(120, 112).x, at(120, 112).y)
    await page.keyboard.press('Control+b')
    await page.keyboard.press('Control+i')
    await expect(button(page, 'Bold')).toHaveCount(0)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    expect(errors).toEqual([])
  })

  test('Ctrl+B during a held drag is ignored; the drag still lands', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'drag me')
    const { errors, at } = await open(page, [rec])
    await page.mouse.click(at(120, 112).x, at(120, 112).y)
    await drag(page, at(120, 112), at(180, 152), { hold: true })
    await page.keyboard.press('Control+b')
    await page.mouse.up()
    const moved = await storedWhen(page, (d) => byId(d, 't').left !== 100)
    expect(byId(moved, 't')).toEqual({ ...rec, left: 160, top: 140 })
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').left === 100)
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('formatting, then a drag cancelled with Esc, leaves the formatted box', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'formatted')
    const { errors, at } = await open(page, [rec])
    await page.mouse.click(at(120, 112).x, at(120, 112).y)
    await button(page, 'H2 (Heading 2)').click()
    await storedWhen(page, (d) => byId(d, 't').headings !== undefined)
    await drag(page, at(120, 112), at(200, 200), { hold: true })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await waitSaved(page)
    expect(byId(await storedDoc(page), 't')).toEqual({ ...rec, headings: [2] })
    expect(errors).toEqual([])
  })

  test('a heading that makes an owned text’s centre leave its frame keeps the owner; moving the text afterwards releases it', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const frame = { id: 'F', name: 'Spread', left: 50, top: 50, width: 500, height: 300 }
    // Three 24 px lines are about 92 tall: the box's centre is at about 316, inside the frame
    // (whose bottom is at 350). As level 1 headings (48 px) they are about 183 tall: centre about 361.
    const rec = { ...textRec('t', 100, 270, 'A\nB\nC', { width: 200 }), frameId: 'F' }
    await openBlank(page)
    await seedRaw(page, 2, { version: 2, title: 'Framed', frames: [frame], objects: [rec], viewport: UNIT })
    await openApp(page)
    const at = await sceneToPage(page, UNIT)
    await page.mouse.click(at(105, 282).x, at(105, 282).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    await button(page, 'H1 (Heading 1)').click()
    const h = await storedWhen(page, (d) => byId(d, 't').headings !== undefined)
    expect(byId(h, 't')).toEqual({ ...rec, headings: [1, 1, 1] }) // still owned
    await deselect(page)
    await waitSaved(page)
    const ink = await inkIn(page, 90, 260, 300, 400)
    expect(260 + (ink.top + ink.bottom) / 2).toBeGreaterThan(350) // its centre is now below the frame (ink is relative to the sampled rectangle)
    // Nudging the text is its own movement: ownership is decided again, from its centre.
    await drag(page, at(110, 290), at(112, 290))
    const moved = await storedWhen(page, (d) => byId(d, 't').left !== 100)
    expect(byId(moved, 't').frameId).toBeUndefined()
    expect(errors).toEqual([])
  })
})

test.describe('the line break after a heading replaced by Enter', () => {
  test('leaves the record unchanged: no bold appears on the next line', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 125), 5) // the end of "Title"
    await page.keyboard.press('Shift+ArrowRight') // the line break
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    expect(errors).toEqual([])
  })
})
