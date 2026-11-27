/**
 * Real-browser tests (real Fabric, real IndexedDB) for formatted text: a stored text's marks,
 * headings, font, alignment and colour are drawn by Fabric, survive saving, moving, scaling,
 * undo, redo and reload, and stay what the canvas shows while the text is typed into.
 *
 * There are no formatting controls yet, so formatted text is seeded into storage.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  AUTOSAVE_QUIET_MS,
  drag,
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
const RED = '#c0392b'

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

/**
 * Everything at once: a level 1 heading, an EMPTY level 2 heading line, a bold and an italic
 * word, and a span after an emoji (UTF-16 offsets: the emoji is two code units).
 *   0 "Heading" 7 \n 8 "" 8 \n 9 "Some bold, some italic" 31 \n 32 "😀 marked tail" 46
 */
const RICH_TEXT = 'Heading\n\nSome bold, some italic\n😀 marked tail'
const RICH: Seed = textRec('rich', 100, 100, RICH_TEXT, {
  width: 500,
  font: 'serif',
  align: 'center',
  color: RED,
  spans: [
    { start: 14, end: 18, bold: true },
    { start: 25, end: 31, italic: true },
    { start: 35, end: 41, bold: true, underline: true, strike: true },
  ],
  headings: [1, 2],
})

const board = (objects: unknown[], view: View = UNIT) => ({ version: 1, title: 'Text', objects, viewport: view })

async function open(page: Page, objects: unknown[], view: View = UNIT) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedMilestone1(page, board(objects, view))
  await openApp(page)
  return { errors, at: await sceneToPage(page, view) }
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

interface Ink {
  count: number
  red: number
  top: number
  bottom: number
  left: number
  right: number
}
/**
 * What is drawn in a rectangle of the scene canvas (canvas CSS pixels): how many pixels are
 * dark ink, how many are clearly red, and the extent of all of them.
 */
function inkIn(page: Page, left: number, top: number, width: number, height: number): Promise<Ink> {
  return page.evaluate(
    ({ left, top, width, height }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.canvas-container canvas.lower-canvas')
      if (!canvas) throw new Error('scene canvas not found')
      const scale = canvas.width / canvas.clientWidth
      const w = Math.round(width * scale)
      const d = canvas.getContext('2d')!.getImageData(Math.round(left * scale), Math.round(top * scale), w, Math.round(height * scale)).data
      const ink: Ink = { count: 0, red: 0, top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity }
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b, a] = [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!]
        const dark = a > 40 && r < 160 && g < 160 && b < 160
        const red = a > 40 && r > 140 && g < 110 && b < 110
        if (!dark && !red) continue
        if (dark) ink.count++
        if (red) ink.red++
        const y = Math.floor(i / 4 / w) / scale
        const x = ((i / 4) % w) / scale
        ink.top = Math.min(ink.top, y)
        ink.bottom = Math.max(ink.bottom, y)
        ink.left = Math.min(ink.left, x)
        ink.right = Math.max(ink.right, x)
      }
      return ink
    },
    { left, top, width, height },
  )
}

/** Enters editing of the text under `p` and puts the caret after `n` characters (graphemes). */
async function caretAt(page: Page, p: { x: number; y: number }, n: number) {
  await page.mouse.dblclick(p.x, p.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowRight')
}

test.describe('a stored formatted text', () => {
  test('opens editable, loading writes nothing, and a move stores exactly the same formatting (version 1 board)', async ({ page }) => {
    const { errors, at } = await open(page, [RICH])
    const before = await snapshotIdb(page)
    await expect(page.getByTestId('readonly-banner')).toHaveCount(0)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before) // opening alone writes nothing
    await expect(undoButton(page)).toBeDisabled()

    await drag(page, at(150, 120), at(190, 150))
    const moved = await storedWhen(page, (d) => byId(d, 'rich').left !== 100)
    expect(moved.version).toBe(1)
    expect(byId(moved, 'rich')).toEqual({ ...RICH, left: 140, top: 130 })
    expect(errors).toEqual([])
  })

  test('opens from a version 2 board with frames and keeps its formatting and owner through a move', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const frame = { id: 'F', name: 'Spread', left: 50, top: 50, width: 700, height: 500 }
    const rich = { ...RICH, frameId: 'F' }
    await openBlank(page)
    await seedRaw(page, 2, { version: 2, title: 'Framed', frames: [frame], objects: [rich], viewport: UNIT })
    await openApp(page)
    const at = await sceneToPage(page, UNIT)
    await drag(page, at(150, 120), at(170, 140))
    const moved = await storedWhen(page, (d) => byId(d, 'rich').left !== 100)
    expect(moved.frames).toEqual([frame])
    expect(byId(moved, 'rich')).toEqual({ ...rich, left: 120, top: 120 })
    expect(errors).toEqual([])
  })

  test('is drawn with its formatting: headings (including an empty one) are taller, bold and colour change the ink', async ({ page }) => {
    const plain = textRec('plain', 40, 40, 'Title\n\nbody')
    const h1 = textRec('h1', 440, 40, 'Title\n\nbody', { headings: [1] })
    const h12 = textRec('h12', 840, 40, 'Title\n\nbody', { headings: [1, 2] })
    const word = textRec('word', 40, 400, 'Sample words')
    const strong = textRec('strong', 440, 400, 'Sample words', { spans: [{ start: 0, end: 12, bold: true }], color: RED })
    const { errors } = await open(page, [plain, h1, h12, word, strong])

    const col = (left: number) => inkIn(page, left - 5, 30, 380, 330)
    await expect.poll(async () => (await col(40)).count).toBeGreaterThan(0)
    const [p, a, b] = [await col(40), await col(440), await col(840)]
    expect(a.bottom - a.top).toBeGreaterThan(p.bottom - p.top + 20) // the heading line is drawn at twice the size
    expect(b.bottom - b.top).toBeGreaterThan(a.bottom - a.top + 15) // and so is the empty heading line below it
    expect(a.count).toBeGreaterThan(p.count * 1.5)

    const w = await inkIn(page, 35, 390, 380, 60)
    const s = await inkIn(page, 435, 390, 380, 60)
    expect(w.red).toBe(0)
    expect(w.count).toBeGreaterThan(0)
    expect(s.red).toBeGreaterThan(w.count) // red, and bold: more ink than the plain words
    expect(errors).toEqual([])
  })

  test('a mark on a wrapped line of a paragraph is drawn on that word (styles are keyed by paragraph, not by drawn line)', async ({ page }) => {
    // Narrow boxes: "aaaa bbbb" on the first drawn line, "cccc dddd" wrapped onto the second.
    const plain = textRec('plain', 40, 40, 'aaaa bbbb cccc dddd', { width: 130 })
    const marked = textRec('marked', 440, 40, 'aaaa bbbb cccc dddd', { width: 130, spans: [{ start: 15, end: 19, bold: true }] })
    const { errors } = await open(page, [plain, marked])
    await expect.poll(async () => (await inkIn(page, 35, 30, 140, 30)).count).toBeGreaterThan(0)
    const first = [await inkIn(page, 35, 30, 140, 30), await inkIn(page, 435, 30, 140, 30)]
    const second = [await inkIn(page, 35, 62, 140, 30), await inkIn(page, 435, 62, 140, 30)]
    expect(second[0]!.count).toBeGreaterThan(0)
    expect(first[1]!.count).toBe(first[0]!.count) // nothing bold on the first drawn line
    expect(second[1]!.count).toBeGreaterThan(second[0]!.count * 1.1) // "dddd" is bold
    expect(errors).toEqual([])
  })

  test('move, undo, redo and reload keep the formatting exactly', async ({ page }) => {
    const { errors, at } = await open(page, [RICH])
    const before = await storedDoc(page)
    await drag(page, at(150, 120), at(250, 170))
    const moved = await storedWhen(page, (d) => byId(d, 'rich').left !== 100)
    expect(byId(moved, 'rich')).toEqual({ ...RICH, left: 200, top: 150 })
    await page.keyboard.press('Escape')

    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'rich').left === 100)
    expect((await storedDoc(page)).objects).toEqual(before.objects)
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'rich').left === 200)
    expect((await storedDoc(page)).objects).toEqual(moved.objects)

    await waitSaved(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect((await storedDoc(page)).objects).toEqual(moved.objects) // no drift from loading
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('a corner scale scales the size and width as today, keeps the formatting, and draws the heading at its ratio', async ({ page }) => {
    const rec = textRec('t', 100, 200, 'Title\nbody text', { headings: [1], spans: [{ start: 6, end: 10, italic: true }], width: 300 })
    const { errors, at } = await open(page, [rec])
    const ink0 = await inkIn(page, 90, 150, 700, 600)
    await page.mouse.click(at(150, 230).x, at(150, 230).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    // The top-right handle; the anchor is the bottom-left corner.
    const handle = at(100 + 300 + 2, 200 - 2)
    await drag(page, handle, { x: handle.x + 150, y: handle.y - 80 }, { steps: 10 })
    const scaled = await storedWhen(page, (d) => byId(d, 't').width !== 300)
    const t = byId(scaled, 't')
    const k = t.width! / 300
    expect(k).toBeGreaterThan(1.3)
    expect(t.fontSize).toBeCloseTo(24 * k, 1) // folded into the size, as for a plain text
    expect(t.left).toBe(100)
    expect({ ...t, fontSize: 0, width: 0, top: 0 }).toEqual({ ...rec, fontSize: 0, width: 0, top: 0 }) // formatting unchanged
    await page.keyboard.press('Escape')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(page)).toEqual(scaled) // deselecting changes nothing

    // Every line, the heading included, is drawn k times larger: the ink is k times taller.
    const ink1 = await inkIn(page, 90, 50, 900, 700)
    expect((ink1.bottom - ink1.top) / (ink0.bottom - ink0.top)).toBeCloseTo(k, 1)

    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').width === 300)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').width !== 300)
    expect(await storedDoc(page)).toEqual(scaled)
    expect(errors).toEqual([])
  })

  test('a read-only board shows formatted text and writes nothing', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const strong = textRec('strong', 100, 100, 'Sample words', { spans: [{ start: 0, end: 12, bold: true }], color: RED })
    const lost = { type: 'image', id: 'lost', left: 600, top: 300, angle: 0, assetId: 'gone', scaleX: 1, scaleY: 1 } // its bytes are missing
    await openBlank(page)
    await seedMilestone1(page, board([strong, lost]))
    await page.goto('/')
    await expect(page.getByTestId('readonly-banner')).toContainText('could not be loaded')
    const before = await snapshotIdb(page)
    await expect.poll(async () => (await inkIn(page, 95, 90, 380, 60)).red).toBeGreaterThan(50)
    const at = await sceneToPage(page, UNIT)
    await page.mouse.dblclick(at(120, 112).x, at(120, 112).y)
    await page.keyboard.type('nope')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    expect(errors).toEqual([])
  })
})

test.describe('typing into a formatted text', () => {
  test('typing in the middle of a bold run extends it; the typing save mid-edit is already right; Esc then one undo restores it', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'plain bold rest', { spans: [{ start: 6, end: 10, bold: true }] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 8) // between "bo" and "ld"
    await page.keyboard.type('XY')
    // Saved while still editing (the autosave debounce fires mid-edit).
    const typed = await storedWhen(page, (d) => byId(d, 't').text === 'plain boXYld rest')
    expect(byId(typed, 't')).toEqual({ ...rec, text: 'plain boXYld rest', spans: [{ start: 6, end: 12, bold: true }] })
    await page.keyboard.press('Escape')
    await waitSaved(page)
    expect(await storedDoc(page)).toEqual(typed)

    await undoButton(page).click() // the whole edit is one step
    await storedWhen(page, (d) => byId(d, 't').text === 'plain bold rest')
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    await expect(undoButton(page)).toBeDisabled()
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').text !== 'plain bold rest')
    expect(await storedDoc(page)).toEqual(typed)
    expect(errors).toEqual([])
  })

  test('typing in the body line of a text with a heading keeps the heading (left by clicking elsewhere)', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 10) // the end of "body"
    await page.keyboard.type(' more')
    await page.mouse.click(at(900, 600).x, at(900, 600).y) // empty canvas
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'Title\nbody more')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'Title\nbody more' })
    expect(errors).toEqual([])
  })

  test('the first character typed on an empty heading line is a heading (it takes the placeholder style)', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\n\nbody', { headings: [1, 2] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 6) // on the empty line
    await page.keyboard.type('Sub')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'Title\nSub\nbody')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'Title\nSub\nbody' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('Backspace that merges a body line into a heading leaves one heading drawn at one size', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { headings: [1] })
    const reference = textRec('ref', 600, 100, 'Titlebody', { headings: [1] })
    const { errors, at } = await open(page, [rec, reference])
    await caretAt(page, at(130, 112), 6) // the start of "body"
    await page.keyboard.press('Backspace')
    const merged = await storedWhen(page, (d) => byId(d, 't').text === 'Titlebody')
    expect(byId(merged, 't')).toEqual({ ...rec, text: 'Titlebody' })
    await page.keyboard.press('Escape') // leaves the edit
    await page.keyboard.press('Escape') // and deselects, so no selection chrome is drawn over it
    await expect(page.locator('.inspector-title')).toHaveCount(0)
    await waitSaved(page)
    // Drawn like a text stored that way: the same extent, up to rasterisation. (Were "body"
    // still at the body size, the line would be about 50 pixels shorter.)
    const a = await inkIn(page, 95, 90, 400, 120)
    const b = await inkIn(page, 595, 90, 400, 120)
    expect(Math.abs(a.bottom - a.top - (b.bottom - b.top))).toBeLessThanOrEqual(2)
    expect(Math.abs(a.right - a.left - (b.right - b.left))).toBeLessThanOrEqual(2)
    expect(Math.abs(a.count - b.count)).toBeLessThan(b.count * 0.1)
    expect(errors).toEqual([])
  })

  test('an emoji typed before a span shifts the span by its two code units (left by clicking another object)', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'ab bold', { spans: [{ start: 3, end: 7, bold: true }] })
    const other = textRec('other', 100, 400, 'other')
    const { errors, at } = await open(page, [rec, other])
    await caretAt(page, at(130, 112), 0)
    await page.keyboard.type('😀')
    await page.mouse.click(at(120, 412).x, at(120, 412).y) // the other text
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    const done = await storedWhen(page, (d) => byId(d, 't').text === '😀ab bold')
    expect(byId(done, 't')).toEqual({ ...rec, text: '😀ab bold', spans: [{ start: 5, end: 9, bold: true }] })
    expect(errors).toEqual([])
  })
})

/**
 * A heading is a property of a line: each line's level is carried across an edit from the
 * levels the lines had before it and how the text changed (see `textAfterEdit`), and the
 * bold of a heading never becomes a mark of its own.
 */
test.describe('editing around headings', () => {
  test('Enter at the end of a heading starts a normal line; what is typed there is plain', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 5)
    await page.keyboard.press('Enter')
    await page.keyboard.type('Next')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'Title\nNext\nbody')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'Title\nNext\nbody' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('Enter in the middle of a heading leaves both halves headings', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 2)
    await page.keyboard.press('Enter')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'Ti\ntle\nbody')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'Ti\ntle\nbody', headings: [1, 1] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('Enter at the end of a normal line above a heading starts a normal line; the heading stays on its line', async ({ page }) => {
    // The text after Enter is the same as after Enter at the start of "Title"; the caret tells them apart.
    const rec = textRec('t', 100, 100, 'body\nTitle', { headings: [0, 1] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(120, 112), 4) // the end of "body"
    await page.keyboard.press('Enter')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'body\n\nTitle')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'body\n\nTitle', headings: [0, 0, 1] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('a heading line emptied by Backspace stays a heading, and what is typed there is a heading; one undo restores it', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 112), 5)
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace')
    const emptied = await storedWhen(page, (d) => byId(d, 't').text === '\nbody') // the typing save, mid-edit
    expect(byId(emptied, 't')).toEqual({ ...rec, text: '\nbody' })
    await page.keyboard.type('New')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'New\nbody')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'New\nbody' })
    await page.keyboard.press('Escape')
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').text === 'Title\nbody')
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('Backspace at the start of a heading under a line with text joins it into that normal line, drawn plain', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'body\nTitle', { headings: [0, 1] })
    const reference = textRec('ref', 600, 100, 'bodyTitle')
    const boldRef = textRec('bref', 600, 300, 'bodyTitle', { spans: [{ start: 4, end: 9, bold: true }] })
    const { errors, at } = await open(page, [rec, reference, boldRef])
    await caretAt(page, at(130, 112), 5) // the start of "Title"
    await page.keyboard.press('Backspace')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'bodyTitle')
    const rest = { ...rec, headings: undefined }
    expect(byId(done, 't')).toEqual({ ...rest, text: 'bodyTitle' }) // no heading, and no bold left behind by it
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    const a = await inkIn(page, 95, 90, 400, 80)
    const b = await inkIn(page, 595, 90, 400, 80)
    expect(Math.abs(a.bottom - a.top - (b.bottom - b.top))).toBeLessThanOrEqual(2) // drawn at the normal size
    expect(Math.abs(a.right - a.left - (b.right - b.left))).toBeLessThanOrEqual(1) // and not bold
    const bold = await inkIn(page, 595, 290, 400, 80)
    expect(bold.right - bold.left).toBeGreaterThan(b.right - b.left + 3) // what a bold "Title" would look like
    expect(errors).toEqual([])
  })

  test('Backspace at the start of a heading under an EMPTY line keeps the heading', async ({ page }) => {
    const rec = textRec('t', 100, 100, '\nTitle', { headings: [0, 1] })
    const { errors, at } = await open(page, [rec])
    await caretAt(page, at(130, 150), 1)
    await page.keyboard.press('Backspace')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'Title')
    expect(byId(done, 't')).toEqual({ ...rec, text: 'Title', headings: [1] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})

/** Fabric's own clipboard path (its copy and paste handlers on the hidden textarea), inside the page. */
test.describe('pasting into a formatted text', () => {
  async function openWithClipboard(page: Page, objects: unknown[]) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    return open(page, objects)
  }
  /** Copies the whole of the text under `p` with Fabric's copy, and leaves it. */
  async function copyAllOf(page: Page, p: { x: number; y: number }) {
    await page.mouse.dblclick(p.x, p.y)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }

  test('P1: plain text copied from a 48 px text and pasted at the start of a line adds no heading and no size; Esc, undo, redo', async ({ page }) => {
    const big = textRec('big', 100, 400, 'BIG', { fontSize: 48 })
    const rec = textRec('b', 100, 100, 'Title\nbody')
    const reference = textRec('ref', 600, 100, 'Title\nBIGbody')
    const { errors, at } = await openWithClipboard(page, [big, rec, reference])
    await copyAllOf(page, at(130, 425))
    await caretAt(page, at(130, 112), 6)
    await page.keyboard.press('Control+v')
    const pasted = await storedWhen(page, (d) => byId(d, 'b').text !== 'Title\nbody') // the typing save, mid-edit
    expect(byId(pasted, 'b')).toEqual({ ...rec, text: 'Title\nBIGbody' })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    expect(byId(await storedDoc(page), 'b')).toEqual(byId(pasted, 'b'))
    const a = await inkIn(page, 95, 90, 400, 90)
    const b = await inkIn(page, 595, 90, 400, 90)
    expect(Math.abs(a.bottom - a.top - (b.bottom - b.top))).toBeLessThanOrEqual(2) // "BIG" is drawn at this text's size
    expect(Math.abs(a.count - b.count)).toBeLessThan(b.count * 0.05)

    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text === 'Title\nbody')
    expect(byId(await storedDoc(page), 'b')).toEqual(rec)
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text !== 'Title\nbody')
    expect(byId(await storedDoc(page), 'b')).toEqual(byId(pasted, 'b'))
    expect(errors).toEqual([])
  })

  test('P1b: text copied from a 30 px text (a level 3 heading size here) pasted at the start stays plain (left by clicking elsewhere)', async ({ page }) => {
    const mid = textRec('mid', 100, 400, 'MID', { fontSize: 30 })
    const rec = textRec('b', 100, 100, 'body')
    const { errors, at } = await openWithClipboard(page, [mid, rec])
    await copyAllOf(page, at(130, 420))
    await caretAt(page, at(130, 112), 0)
    await page.keyboard.press('Control+v')
    await page.mouse.click(at(900, 650).x, at(900, 650).y) // empty canvas
    const done = await storedWhen(page, (d) => byId(d, 'b').text === 'MIDbody')
    expect(byId(done, 'b')).toEqual({ ...rec, text: 'MIDbody' })
    expect(errors).toEqual([])
  })

  test('Q2: a normal line copied and pasted at the start of the heading keeps one heading and adds no bold (left by clicking another object); undo, redo', async ({ page }) => {
    const rec = textRec('b', 100, 100, 'Title\nbody', { headings: [1] })
    const other = textRec('other', 100, 450, 'other')
    const { errors, at } = await openWithClipboard(page, [rec, other])
    await caretAt(page, at(130, 112), 6)
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('ArrowLeft')
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Control+v')
    const pasted = await storedWhen(page, (d) => byId(d, 'b').text === 'bodyTitle\nbody')
    expect(byId(pasted, 'b')).toEqual({ ...rec, text: 'bodyTitle\nbody' })
    await page.mouse.click(at(120, 462).x, at(120, 462).y) // the other text
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    await waitSaved(page)
    expect(byId(await storedDoc(page), 'b')).toEqual(byId(pasted, 'b'))
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text === 'Title\nbody')
    expect(byId(await storedDoc(page), 'b')).toEqual(rec)
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text === 'bodyTitle\nbody')
    expect(byId(await storedDoc(page), 'b')).toEqual(byId(pasted, 'b'))
    expect(errors).toEqual([])
  })

  // Fabric's paste replaces the styles of what it is pasted over even when the text it leaves
  // is the same. Something is typed first, so that the edit has an undo step of its own.
  test('a word copied from a 48 px text and pasted over the same word adds no heading; undo, redo', async ({ page }) => {
    const big = textRec('big', 100, 400, 'BIG', { fontSize: 48 })
    const rec = textRec('b', 100, 100, 'BIG\nbody')
    const { errors, at } = await openWithClipboard(page, [big, rec])
    await copyAllOf(page, at(130, 425))
    await caretAt(page, at(130, 112), 8) // the end of "body"
    await page.keyboard.type('!')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowLeft')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight') // "BIG"
    await page.keyboard.press('Control+v')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    const done = await storedDoc(page)
    expect(byId(done, 'b')).toEqual({ ...rec, text: 'BIG\nbody!' })
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text === 'BIG\nbody')
    expect(byId(await storedDoc(page), 'b')).toEqual(rec)
    await expect(undoButton(page)).toBeDisabled()
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text === 'BIG\nbody!')
    expect(byId(await storedDoc(page), 'b')).toEqual(byId(done, 'b'))
    expect(errors).toEqual([])
  })

  test('a plain word pasted over the same word in a heading keeps the heading (left by clicking elsewhere); undo, redo', async ({ page }) => {
    const plain = textRec('plain', 100, 400, 'Title')
    const rec = textRec('b', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await openWithClipboard(page, [plain, rec])
    await copyAllOf(page, at(130, 412))
    await caretAt(page, at(130, 112), 10) // the end of "body"
    await page.keyboard.type('!')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowLeft')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight') // "Title"
    await page.keyboard.press('Control+v')
    await page.mouse.click(at(900, 650).x, at(900, 650).y) // empty canvas
    await waitSaved(page)
    const done = await storedDoc(page)
    expect(byId(done, 'b')).toEqual({ ...rec, text: 'Title\nbody!' })
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text === 'Title\nbody')
    expect(byId(await storedDoc(page), 'b')).toEqual(rec)
    await expect(undoButton(page)).toBeDisabled()
    await redoButton(page).click()
    await storedWhen(page, (d) => byId(d, 'b').text === 'Title\nbody!')
    expect(byId(await storedDoc(page), 'b')).toEqual(byId(done, 'b'))
    expect(errors).toEqual([])
  })

  test('pasted text keeps its bold: a bold word stays bold, and heading text arrives bold at the normal size', async ({ page }) => {
    const marked = textRec('marked', 100, 300, 'bold here', { spans: [{ start: 0, end: 4, bold: true }] })
    const heading = textRec('heading', 100, 450, 'Big\nx', { headings: [1] })
    const rec = textRec('b', 100, 100, 'ab')
    const { errors, at } = await openWithClipboard(page, [marked, heading, rec])
    await caretAt(page, at(110, 312), 0)
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await caretAt(page, at(110, 112), 1)
    await page.keyboard.press('Control+v')
    await storedWhen(page, (d) => byId(d, 'b').text === 'aboldb')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await caretAt(page, at(115, 470), 0)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await caretAt(page, at(110, 112), 6)
    await page.keyboard.press('Control+v')
    const done = await storedWhen(page, (d) => byId(d, 'b').text === 'aboldbBig')
    expect(byId(done, 'b')).toEqual({ ...rec, text: 'aboldbBig', spans: [{ start: 1, end: 5, bold: true }, { start: 6, end: 9, bold: true }] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('a multi-line paste into the middle of a heading: the first line joins it, the last carries the rest of the heading', async ({ page }) => {
    const source = textRec('src', 100, 400, 'A\nB')
    const rec = textRec('b', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await openWithClipboard(page, [source, rec])
    await copyAllOf(page, at(110, 412))
    await caretAt(page, at(130, 112), 2)
    await page.keyboard.press('Control+v')
    const done = await storedWhen(page, (d) => byId(d, 'b').text === 'TiA\nBtle\nbody')
    expect(byId(done, 'b')).toEqual({ ...rec, text: 'TiA\nBtle\nbody', headings: [1, 1] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('two lines from another application pasted at the end of a heading: the new line is normal and not bold', async ({ page }) => {
    const rec = textRec('b', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await openWithClipboard(page, [rec])
    await page.evaluate(() => navigator.clipboard.writeText('A\nB')) // not copied by Fabric: it copies the neighbouring style onto it
    await caretAt(page, at(130, 112), 5)
    await page.keyboard.press('Control+v')
    const done = await storedWhen(page, (d) => byId(d, 'b').text === 'TitleA\nB\nbody')
    expect(byId(done, 'b')).toEqual({ ...rec, text: 'TitleA\nB\nbody' })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})

test.describe('dropping text into a formatted text', () => {
  test('a word dragged from a 48 px text onto the normal line of a heading text brings no heading and no size, in every undo step', async ({ page }) => {
    const source = textRec('src', 100, 400, 'one BIG', { fontSize: 48 })
    const rec = textRec('b', 100, 100, 'Title\nbody', { headings: [1] })
    const { errors, at } = await open(page, [source, rec])
    await caretAt(page, at(130, 425), 4)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight') // "BIG"
    // Fabric's own drag and drop of the selection (DraggableTextDelegate.mjs): a native drag session.
    const from = at(240, 430)
    const to = at(102, 178) // the start of the body line (the heading line is 60 tall)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 10, from.y - 10, { steps: 3 })
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await page.mouse.up()
    const dropped = await storedWhen(page, (d) => byId(d, 'b').text === 'Title\nBIGbody' && byId(d, 'src').text === 'one ')
    expect(byId(dropped, 'b')).toEqual({ ...rec, text: 'Title\nBIGbody' })
    expect(byId(dropped, 'src')).toEqual({ ...source, text: 'one ' })
    await page.keyboard.press('Escape')
    await waitSaved(page)
    // However many steps the drop left in history, none of them gives the body line a heading.
    for (let step = 0; step < 4 && (await undoButton(page).isEnabled()); step++) {
      const before = JSON.stringify(await storedDoc(page))
      await undoButton(page).click()
      await storedWhen(page, (d) => JSON.stringify(d) !== before)
      expect(byId(await storedDoc(page), 'b').headings).toEqual([1])
    }
    const back = await storedDoc(page)
    expect(byId(back, 'b')).toEqual(rec)
    expect(byId(back, 'src')).toEqual(source)
    expect(errors).toEqual([])
  })
})

test.describe('the box after a style rewrite', () => {
  // "WWW" fits a 160 wide box as a heading; "abcWWW" laid out with the heading's size on
  // "WWW" does not, so Fabric widens the box before the styles are tidied. Once tidied,
  // "abcXYWWW" at the normal size fits the original width again.
  const seed = (align: 'center' | 'right' | undefined, angle = 0) => textRec('t', 300, 200, 'abc\nWWW', { headings: [0, 1], width: 160, angle, ...(align && { align }) })

  for (const align of [undefined, 'center', 'right'] as const) {
    test(`joining a heading onto a normal line and typing keeps the width and position (${align ?? 'left'} aligned)`, async ({ page }) => {
      const rec = seed(align)
      const { errors, at } = await open(page, [rec])
      await caretAt(page, at(380, 212), 4) // the start of "WWW"
      await page.keyboard.press('Backspace')
      await page.keyboard.type('XY')
      const done = await storedWhen(page, (d) => byId(d, 't').text === 'abcXYWWW')
      const rest = { ...rec, headings: undefined }
      expect(byId(done, 't')).toEqual({ ...rest, text: 'abcXYWWW' })
      await page.keyboard.press('Escape')
      expect(errors).toEqual([])
    })
  }

  test('the same for a rotated, centred text', async ({ page }) => {
    const rec = seed('center', 30)
    const { errors, at } = await open(page, [rec])
    // A point 40 right of and 15 below the box's top-left corner, turned with the box about that corner.
    const r = (30 * Math.PI) / 180
    const inside = at(300 + 40 * Math.cos(r) - 15 * Math.sin(r), 200 + 40 * Math.sin(r) + 15 * Math.cos(r))
    await caretAt(page, inside, 4)
    await page.keyboard.press('Backspace')
    await page.keyboard.type('XY')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'abcXYWWW')
    const t = byId(done, 't')
    expect(t.width).toBe(160)
    expect(t.left).toBeCloseTo(300, 0)
    expect(t.top).toBeCloseTo(200, 0)
    expect(t.headings).toBeUndefined()
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('a width set with a side handle just before is the width kept', async ({ page }) => {
    const rec = seed(undefined)
    const { errors, at } = await open(page, [rec])
    await page.mouse.click(at(320, 212).x, at(320, 212).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    // Find the right-hand side handle by the cursor Fabric shows over it.
    const upper = page.locator('.canvas-container canvas.upper-canvas')
    const x = at(300 + 160 + 2, 0).x
    let handle: { x: number; y: number } | undefined
    for (let y = 210; y < 320 && !handle; y += 2) {
      const p = at(0, y)
      await page.mouse.move(x, p.y)
      if ((await upper.evaluate((el) => (el as HTMLElement).style.cursor)) === 'e-resize') handle = { x, y: p.y + 4 }
    }
    if (!handle) throw new Error('side handle not found')
    await drag(page, handle, { x: handle.x + 60, y: handle.y }, { steps: 6 })
    const widened = await storedWhen(page, (d) => byId(d, 't').width !== 160)
    const width = byId(widened, 't').width!
    expect(width).toBeGreaterThan(200)
    await caretAt(page, at(320, 212), 4)
    await page.keyboard.press('Backspace')
    await page.keyboard.type('XY')
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'abcXYWWW')
    expect(byId(done, 't').width).toBe(width) // not back to 160
    expect(byId(done, 't').left).toBe(300)
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })

  test('a word that really is too long still widens the box, exactly as far as it needs, about the centre', async ({ page }) => {
    const rec = seed('center')
    const reference = textRec('ref', 300, 500, 'abcXYZXYZXYZXYZWWW', { width: 160, align: 'center' })
    const { errors, at } = await open(page, [rec, reference])
    await caretAt(page, at(380, 212), 4)
    await page.keyboard.press('Backspace')
    await page.keyboard.type('XYZXYZXYZXYZ')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    // Move the reference so that its stored width is the one Fabric gives that text.
    await drag(page, at(380, 512), at(380, 552))
    const done = await storedWhen(page, (d) => byId(d, 't').text === 'abcXYZXYZXYZXYZWWW' && byId(d, 'ref').top !== 500)
    const t = byId(done, 't')
    const ref = byId(done, 'ref')
    expect(ref.width).toBeGreaterThan(160)
    expect(t.width).toBe(ref.width)
    expect(t.left + t.width! / 2).toBeCloseTo(300 + 160 / 2, 0)
    expect(errors).toEqual([])
  })
})

test.describe('changing the size of a formatted text', () => {
  test('"Select with contents" (a frame and a formatted text) scaled from a corner scales the text once and keeps its formatting', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const frame = { id: 'F', name: 'Spread', left: 50, top: 50, width: 700, height: 500 }
    const rec = { ...textRec('t', 100, 100, 'Title\nbody text', { headings: [1], spans: [{ start: 6, end: 10, italic: true }], width: 300 }), frameId: 'F' }
    await openBlank(page)
    await seedRaw(page, 2, { version: 2, title: 'Framed', frames: [frame], objects: [rec], viewport: UNIT })
    await openApp(page)
    const at = await sceneToPage(page, UNIT)
    await page.mouse.click(at(60, 36).x, at(60, 36).y) // the frame's label
    await page.getByRole('button', { name: 'Select with contents' }).click()
    await expect(page.locator('.inspector-title')).toHaveText('2 objects')
    await drag(page, at(750, 550), at(575, 425), { steps: 10 }) // the bottom-right corner, inwards
    const scaled = await storedWhen(page, (d) => d.frames![0]!.width !== 700)
    const k = scaled.frames![0]!.width / 700
    expect(k).toBeGreaterThan(0.7)
    expect(k).toBeLessThan(0.8)
    const t = byId(scaled, 't')
    expect(t.fontSize).toBeCloseTo(24 * k, 1) // once, not k squared
    expect(t.width).toBeCloseTo(300 * k, 1)
    expect({ ...t, fontSize: 0, width: 0, left: 0, top: 0 }).toEqual({ ...rec, fontSize: 0, width: 0, left: 0, top: 0 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(page)).toEqual(scaled)
    await undoButton(page).click()
    await storedWhen(page, (d) => d.frames![0]!.width === 700)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    expect(errors).toEqual([])
  })

  test('the font size field redraws headings at their ratio; one undo restores it', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\nbody', { headings: [1], spans: [{ start: 6, end: 10, italic: true }], width: 500 })
    const { errors, at } = await open(page, [rec])
    const ink0 = await inkIn(page, 90, 90, 800, 500)
    await page.mouse.click(at(130, 120).x, at(130, 120).y)
    await page.getByLabel('Font size').fill('40')
    const sized = await storedWhen(page, (d) => byId(d, 't').fontSize === 40)
    expect(byId(sized, 't')).toEqual({ ...rec, fontSize: 40 })
    await page.keyboard.press('Escape')
    await page.mouse.click(at(900, 650).x, at(900, 650).y)
    await expect(page.locator('.inspector-title')).toHaveCount(0)
    await waitSaved(page)
    const ink1 = await inkIn(page, 90, 90, 800, 500)
    expect((ink1.bottom - ink1.top) / (ink0.bottom - ink0.top)).toBeCloseTo(40 / 24, 1) // the heading line too
    await undoButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').fontSize === 24)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    expect(errors).toEqual([])
  })
})

test.describe('a stored text with "\\r\\n" line breaks (the app never writes one)', () => {
  test('a move keeps it exactly; typing turns its break into "\\n" and keeps its heading and marks', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\r\nbody bold', { headings: [1], spans: [{ start: 12, end: 16, bold: true }] })
    const { errors, at } = await open(page, [rec])
    await drag(page, at(130, 120), at(140, 130))
    const moved = await storedWhen(page, (d) => byId(d, 't').left !== 100)
    expect(byId(moved, 't')).toEqual({ ...rec, left: 110, top: 110 })
    await page.keyboard.press('Escape')
    await page.mouse.dblclick(at(150, 140).x, at(150, 140).y)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('!')
    const typed = await storedWhen(page, (d) => byId(d, 't').text?.endsWith('!') === true)
    expect(byId(typed, 't')).toEqual({ ...rec, left: 110, top: 110, text: 'Title\nbody bold!', spans: [{ start: 11, end: 16, bold: true }] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})

test.describe('IME composition', () => {
  test('composing on an empty heading line and inside a bold run gives a heading and a bold run', async ({ page }) => {
    const rec = textRec('t', 100, 100, 'Title\n\nplain bold', { headings: [1, 2], spans: [{ start: 13, end: 17, bold: true }] })
    const { errors, at } = await open(page, [rec])
    const cdp = await page.context().newCDPSession(page)
    await caretAt(page, at(130, 112), 6) // the empty heading line
    await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.imeSetComposition', { text: 'ka', selectionStart: 2, selectionEnd: 2 })
    await cdp.send('Input.insertText', { text: 'カ' })
    await page.keyboard.type('Z')
    await storedWhen(page, (d) => byId(d, 't').text === 'Title\nカZ\nplain bold')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft') // between "bo" and "ld"
    await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.insertText', { text: 'ン' })
    await page.keyboard.type('Q')
    const done = await storedWhen(page, (d) => byId(d, 't').text?.includes('Q') === true)
    expect(byId(done, 't')).toEqual({ ...rec, text: 'Title\nカZ\nplain boンQld', spans: [{ start: 15, end: 21, bold: true }] })
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
  })
})

test.describe('a plain text', () => {
  test('created with the Text tool is stored with exactly the old keys', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await page.mouse.click(at(300, 300).x, at(300, 300).y)
    await page.keyboard.type('just words')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => d.objects.length === 1)
    expect(Object.keys(done.objects[0]!)).toEqual(['id', 'left', 'top', 'angle', 'type', 'text', 'fontSize', 'width'])
    expect(done.objects[0]!.text).toBe('just words')
    expect(errors).toEqual([])
  })
})
