/**
 * Real-browser tests (real Fabric, real IndexedDB) for the Text tool's drag: pressing on empty
 * canvas and dragging out a box with a wrapping width and minimum height. What is stored, how
 * the text wraps, the click that still gives the default box, cancelling, other buttons,
 * directions, the minimum width, frames, history and zoom.
 */
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, drag, imageFile, openApp, openBlank, redoButton, sceneToPage, seedMilestone1, seedRaw, status, storedDoc, undoButton, waitSaved } from './helpers.ts'
import type { StoredBoard, StoredObject, View } from './helpers.ts'

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }
type Seed = StoredObject & { type: 'text'; text: string; fontSize: number; width: number }
const textRec = (id: string, left: number, top: number, text: string, extra: Partial<Seed> = {}): Seed => ({ type: 'text', id, left, top, angle: 0, text, fontSize: 24, width: 360, ...extra })

async function open(page: Page, objects: unknown[], opts: { view?: View; frames?: unknown[] } = {}) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const view = opts.view ?? UNIT
  await openBlank(page)
  if (opts.frames) await seedRaw(page, 2, { version: 2, title: 'Text tool', frames: opts.frames, objects, viewport: view })
  else await seedMilestone1(page, { version: 1, title: 'Text tool', objects, viewport: view })
  await openApp(page)
  return { errors, at: await sceneToPage(page, view) }
}
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}
const texts = (doc: StoredBoard) => doc.objects.filter((o) => o.type === 'text')
const tool = (page: Page, name: string): Locator => page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name, exact: true })
const editing = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('data-fabric') === 'textarea')
type P = { x: number; y: number }

/** Dark pixels in a page rectangle of the scene canvas, and their extent. */
function inkIn(page: Page, left: number, top: number, width: number, height: number) {
  return page.evaluate(
    ({ left, top, width, height }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.canvas-container canvas.lower-canvas')!
      const r = canvas.getBoundingClientRect()
      const scale = canvas.width / canvas.clientWidth
      const w = Math.round(width * scale)
      const d = canvas.getContext('2d')!.getImageData(Math.round((left - r.left) * scale), Math.round((top - r.top) * scale), w, Math.round(height * scale)).data
      const ink = { count: 0, left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
      for (let i = 0; i < d.length; i += 4) {
        if (!(d[i + 3]! > 40 && d[i]! < 160 && d[i + 1]! < 160 && d[i + 2]! < 160)) continue
        ink.count++
        const x = left + ((i / 4) % w) / scale
        const y = top + Math.floor(i / 4 / w) / scale
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

/** Pixels of the accent colour (the dashed rectangle being drawn) in a page rectangle of the scene canvas. */
function accentIn(page: Page, left: number, top: number, width: number, height: number, accent = [0x6c, 0x7b, 0xf2]) {
  return page.evaluate(
    ({ left, top, width, height, accent }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.canvas-container canvas.lower-canvas')!
      const r = canvas.getBoundingClientRect()
      const scale = canvas.width / canvas.clientWidth
      const d = canvas.getContext('2d')!.getImageData(Math.round((left - r.left) * scale), Math.round((top - r.top) * scale), Math.round(width * scale), Math.round(height * scale)).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 0 && accent.every((c, j) => Math.abs(d[i + j]! - c) < 30)) n++
      return n
    },
    { left, top, width, height, accent },
  )
}

test.describe('dragging out a text box', () => {
  test('the dragged width and minimum height are stored in scene units, and words wrap to that width', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(400, 400))
    await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true') // single-use
    expect(await editing(page)).toBe(true)
    const base = at(130, 400)
    // Fabric's editing border is pale blue. It is still at the drafted bottom before typing.
    await expect.poll(() => accentIn(page, base.x, base.y - 4, 240, 9, [102, 153, 255])).toBeGreaterThan(100)
    await page.keyboard.type('a long sentence that has to wrap several times inside this box')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 1)
    expect(done.objects[0]).toMatchObject({ left: 100, top: 100, width: 300, minHeight: 300, fontSize: 24 })
    const p0 = at(90, 90)
    const ink = await inkIn(page, p0.x, p0.y, 600, 400)
    expect(ink.right).toBeLessThanOrEqual(at(401, 0).x) // wrapped at the box's width
    expect(ink.bottom - ink.top).toBeGreaterThan(24 * 1.25 * 2.5) // on at least three lines
    expect(ink.bottom).toBeLessThan(at(0, 100 + 24 * 1.25 * 5).y) // text still starts at the top of the box
    expect(errors).toEqual([])
  })

  test('a click still gives the default box with exactly the values stored today', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await page.mouse.click(at(300, 300).x, at(300, 300).y)
    await page.keyboard.type('just words')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 1)
    const { id: _id, ...rest } = done.objects[0]!
    void _id
    expect(rest).toEqual({ left: 300, top: 300, angle: 0, type: 'text', text: 'just words', fontSize: 24, width: 240 })
    expect(errors).toEqual([])
  })

  test('a tiny drag (under 4 screen pixels) is a click: the default box at the press point', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(300, 300), at(302, 301), { steps: 2 })
    await page.keyboard.type('x')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 1)
    expect(done.objects[0]).toMatchObject({ left: 300, top: 300, width: 240 })
    expect(errors).toEqual([])
  })

  test('leftward and upward drags; a drag narrower than two font sizes gives the default box at the press point', async ({ page }) => {
    const { errors, at } = await open(page, [], { view: { zoom: 1, panX: 0, panY: -100 } })
    const make = async (from: P, to: P, typed: string) => {
      await page.keyboard.press('t')
      await drag(page, from, to)
      await page.keyboard.type(typed)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    }
    await make(at(500, 300), at(200, 150), 'up left')
    await make(at(300, 400), at(304, 403), 'jitter') // a wobble just past the slop
    await make(at(300, 500), at(310, 650), 'down') // mostly vertical
    await make(at(300, 800), at(310, 700), 'up') // mostly vertical, upward: still at the press point
    await make(at(700, 400), at(660, 450), 'narrow left')
    await make(at(700, 600), at(748, 620), 'w48') // exactly two font sizes wide: the dragged width
    const done = await storedWhen(page, (d) => texts(d).length === 6)
    const by = (t: string) => done.objects.find((o) => o.text === t)
    expect(by('up left')).toMatchObject({ left: 200, top: 150, width: 300, minHeight: 150 })
    expect(by('jitter')).toMatchObject({ left: 300, top: 400, width: 240 })
    expect(by('down')).toMatchObject({ left: 300, top: 500, width: 240 })
    expect(by('up')).toMatchObject({ left: 300, top: 800, width: 240 })
    expect(by('narrow left')).toMatchObject({ left: 700, top: 400, width: 240 })
    expect(by('w48')).toMatchObject({ left: 700, top: 600, width: 48 })
    expect(errors).toEqual([])
  })

  test('released outside the canvas (over the toolbar): the box still comes, up to where the pointer was', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    const toolbar = (await page.locator('.toolbar').boundingBox())!
    const over = { x: toolbar.x + toolbar.width / 2, y: at(0, 300).y }
    await drag(page, at(300, 300), over)
    await page.keyboard.type('reached')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 1)
    const host = (await page.locator('.canvas-host').boundingBox())!
    expect(done.objects[0]).toMatchObject({ top: 300, minHeight: 0, width: Math.round((at(300, 0).x - over.x) * 100) / 100 })
    expect(done.objects[0]!.left).toBeCloseTo(over.x - host.x, 1)
    expect(errors).toEqual([])
  })

  for (const view of [
    { zoom: 2, panX: 0, panY: 0 },
    { zoom: 0.5, panX: 100, panY: 50 },
  ]) {
    test(`at zoom ${view.zoom}: the width and minimum height are in scene units`, async ({ page }) => {
      const { errors, at } = await open(page, [], { view })
      await page.keyboard.press('t')
      await drag(page, at(100, 100), at(300, 150))
      await page.keyboard.type('zoomed')
      await page.keyboard.press('Escape')
      const done = await storedWhen(page, (d) => texts(d).length === 1)
      expect(done.objects[0]).toMatchObject({ left: 100, top: 100, width: 200, minHeight: 50, fontSize: Math.round(Math.min(160, Math.max(12, 24 / view.zoom))) })
      expect(errors).toEqual([])
    })
  }

  test('`# Title` typed first in a dragged box is a heading, and a typing shortcut works straight away', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(500, 200))
    await page.keyboard.type('# Title')
    await page.keyboard.press('Enter')
    await page.keyboard.type('a **bold** word')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 1)
    expect(done.objects[0]).toMatchObject({ text: 'Title\na bold word', width: 400, headings: [1], spans: [{ start: 8, end: 12, bold: true }] })
    expect(errors).toEqual([])
  })

  test('a long token grows the box downward, preserves graphemes and leaves existing boxes alone', async ({ page }) => {
    const token = '👩🏽‍🚀ABCDEFGHIJKLMN👩🏽‍🚀OPQRSTUVWXYZ'
    const legacy = textRec('legacy', 100, 440, 'legacy', { width: 100 })
    const { errors, at } = await open(page, [legacy])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(200, 150))
    await page.getByRole('button', { name: 'Mono', exact: true }).click()
    await page.keyboard.insertText(token)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    const doc = await storedWhen(page, (d) => texts(d).length === 2)
    expect(doc.objects.find((o) => o.text === token)).toMatchObject({ width: 100, minHeight: 50, spans: [{ start: 0, end: token.length, font: 'mono' }] })
    const p = at(90, 90)
    const ink = await inkIn(page, p.x, p.y, 650, 320)
    expect(ink.right).toBeLessThanOrEqual(at(202, 0).x)
    expect(ink.bottom).toBeGreaterThan(at(0, 175).y)

    await page.mouse.dblclick(at(110, 112).x, at(110, 112).y)
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('short')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.mouse.click(at(150, 144).x, at(150, 144).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text') // shrinks back to the drawn floor
    await page.mouse.click(at(150, 166).x, at(150, 166).y)
    await expect(page.locator('.inspector-title')).toHaveCount(0)

    await page.mouse.dblclick(at(110, 452).x, at(110, 452).y)
    await page.keyboard.press('Control+a')
    await page.keyboard.insertText('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    await page.keyboard.press('Escape')
    const withLegacy = await storedWhen(page, (d) => (d.objects.find((o) => o.id === 'legacy')?.width ?? 0) > 100)
    expect(withLegacy.objects.find((o) => o.id === 'legacy')).not.toHaveProperty('minHeight')
    expect(errors).toEqual([])
  })

  test('dragging from the empty lower area moves the box, and resizing keeps or scales the minimum height', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(300, 300))
    await page.keyboard.type('Move me')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    await drag(page, at(150, 250), at(210, 300))
    const moved = (await storedWhen(page, (d) => d.objects[0]?.left === 160)).objects[0]!
    expect(moved).toMatchObject({ top: 150, width: 200, minHeight: 200 })

    await drag(page, at(362, 250), at(422, 250)) // right side handle halfway down the drawn height
    const widened = (await storedWhen(page, (d) => d.objects[0]?.width !== 200)).objects[0]!
    expect(widened.width).toBeGreaterThan(250)
    expect(widened.minHeight).toBe(200)

    const corner = at(widened.left + widened.width! + 2, 352)
    await drag(page, corner, { x: corner.x + 65, y: corner.y + 50 })
    const scaled = (await storedWhen(page, (d) => d.objects[0]?.fontSize !== 24)).objects[0]!
    const scale = scaled.width! / widened.width!
    expect(scale).toBeGreaterThan(1.2)
    expect(scaled.minHeight).toBeCloseTo(200 * scale, 1)
    await undoButton(page).click()
    expect((await storedWhen(page, (d) => d.objects[0]?.fontSize === 24)).objects[0]).toEqual(widened)
    await redoButton(page).click()
    expect((await storedWhen(page, (d) => d.objects[0]?.fontSize === scaled.fontSize)).objects[0]).toEqual(scaled)
    expect(errors).toEqual([])
  })

  test('reopening a narrow drawn box measures its saved font before settling its width', async ({ page }) => {
    // At 40px a mono W fits inside 30px, while the default Sans W does not.
    const rec = textRec('t', 100, 100, 'WWW', { width: 30, fontSize: 40, minHeight: 200, spans: [{ start: 0, end: 3, font: 'mono' }] })
    const { errors, at } = await open(page, [rec])
    await drag(page, at(110, 270), at(130, 270))
    const moved = (await storedWhen(page, (d) => d.objects[0]?.left === 120)).objects[0]
    expect(moved).toEqual({ ...rec, left: 120 })
    expect(errors).toEqual([])
  })
})

test.describe('cancelling, other buttons, single use', () => {
  test('Esc mid-drag: no box, nothing stored, the Select tool', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(400, 300), { hold: true })
    const edge = at(100, 300) // the bottom edge of the rectangle being drawn
    await expect.poll(() => accentIn(page, edge.x, edge.y - 3, 300, 6)).toBeGreaterThan(50)
    await page.keyboard.press('Escape')
    await expect.poll(() => accentIn(page, edge.x, edge.y - 3, 300, 6)).toBe(0)
    await page.mouse.up()
    await expect(tool(page, 'Select')).toHaveAttribute('aria-pressed', 'true')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(texts(await storedDoc(page))).toEqual([])
    expect(await editing(page)).toBe(false)
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('a window blur mid-drag: no box; the Text tool stays chosen', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(400, 300), { hold: true })
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(texts(await storedDoc(page))).toEqual([])
    await expect(tool(page, 'Text')).toHaveAttribute('aria-pressed', 'true')
    expect(errors).toEqual([])
  })

  test('the right or middle button pressed and released mid-drag neither ends nor cancels it', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(250, 200), { hold: true })
    await page.mouse.down({ button: 'right' })
    await page.mouse.up({ button: 'right' })
    await page.mouse.down({ button: 'middle' })
    await page.mouse.up({ button: 'middle' })
    await page.mouse.move(at(400, 300).x, at(400, 300).y, { steps: 4 })
    await page.mouse.up()
    await page.keyboard.type('one box')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 1)
    expect(done.objects[0]).toMatchObject({ left: 100, top: 100, width: 300, text: 'one box' })
    expect(errors).toEqual([])
  })

  test('a dragged box left blank with Esc leaves no history step and nothing stored; the tool was single-use', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(400, 300))
    expect(await editing(page)).toBe(true)
    await page.keyboard.press('Escape')
    await drag(page, at(100, 400), at(400, 600)) // the Select tool now: a marquee, no text
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(texts(await storedDoc(page))).toEqual([])
    await expect(undoButton(page)).toBeDisabled()
    expect(await editing(page)).toBe(false)
    expect(errors).toEqual([])
  })

  test('a press with the Text tool on a text, an image or a frame label is not a draft; a frame interior is', async ({ page }) => {
    const frame = { id: 'F', name: 'Spread', left: 400, top: 100, width: 400, height: 300 }
    const { errors, at } = await open(page, [textRec('t', 100, 100, 'existing')], { frames: [frame] })
    await page.keyboard.press('t')
    await drag(page, at(110, 112), at(200, 300)) // on the text: Fabric drags it, as before
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    await page.keyboard.press('t')
    await drag(page, at(410, 92), at(500, 50)) // on the frame label: moves the frame
    await expect(page.locator('.inspector-title')).toHaveText('Frame')
    let doc = await storedWhen(page, (d) => d.frames?.[0]?.top === 58)
    expect(texts(doc)).toHaveLength(1)
    await page.keyboard.press('t')
    await drag(page, at(520, 150), at(700, 200)) // inside the frame: a box, which it owns
    await page.keyboard.type('inside')
    await page.keyboard.press('Escape')
    doc = await storedWhen(page, (d) => texts(d).length === 2)
    expect(doc.objects.find((o) => o.text === 'inside')).toMatchObject({ left: 520, top: 150, width: 180, frameId: 'F' })
    expect(errors).toEqual([])
  })
})

test.describe('ownership and history', () => {
  test('the drawn minimum height contributes to the centre used for frame ownership', async ({ page }) => {
    const frame = { id: 'F', name: 'Spread', left: 50, top: 50, width: 600, height: 250 }
    const { errors, at } = await open(page, [], { frames: [frame] })
    await page.keyboard.press('t')
    await drag(page, at(100, 240), at(300, 400))
    await page.keyboard.type('One line')
    await page.keyboard.press('Escape')
    const loose = (await storedWhen(page, (d) => texts(d).length === 1)).objects[0]!
    expect(loose).not.toHaveProperty('frameId') // the minimum height puts its centre at y 320
    await drag(page, at(150, 350), at(150, 270))
    const owned = (await storedWhen(page, (d) => d.objects[0]?.frameId === 'F')).objects[0]
    expect(owned).toMatchObject({ top: 160, minHeight: 160 })
    expect(errors).toEqual([])
  })

  test('a box dragged inside a frame belongs to it; one dragged mostly outside does not', async ({ page }) => {
    const frame = { id: 'F', name: 'Spread', left: 100, top: 100, width: 400, height: 300 }
    const { errors, at } = await open(page, [], { frames: [frame] })
    await page.keyboard.press('t')
    await drag(page, at(350, 150), at(480, 200)) // a click at 350 would make a 240-wide box centred outside
    await page.keyboard.type('in')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('t')
    await drag(page, at(350, 300), at(900, 350))
    await page.keyboard.type('out')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 2)
    expect(done.objects.find((o) => o.text === 'in')?.frameId).toBe('F')
    expect(done.objects.find((o) => o.text === 'out')?.frameId).toBeUndefined()
    expect(errors).toEqual([])
  })

  test('the owner is decided again from the box centre when the first edit ends: a tall text started near a frame\'s bottom edge ends up loose', async ({ page }) => {
    const frame = { id: 'F', name: 'Spread', left: 50, top: 50, width: 600, height: 400 }
    const { errors, at } = await open(page, [], { frames: [frame] })
    await page.keyboard.press('t')
    await drag(page, at(100, 380), at(400, 440)) // entirely inside the frame
    await page.keyboard.type('one')
    for (const line of ['two', 'three', 'four', 'five', 'six', 'seven']) {
      await page.keyboard.press('Enter')
      await page.keyboard.type(line)
    }
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('t')
    await drag(page, at(100, 70), at(400, 130)) // the same text started higher stays inside
    await page.keyboard.type('one')
    for (const line of ['two', 'three', 'four', 'five', 'six', 'seven']) {
      await page.keyboard.press('Enter')
      await page.keyboard.type(line)
    }
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 2)
    const low = done.objects.find((o) => o.top === 380)!
    const high = done.objects.find((o) => o.top === 70)!
    expect(low).toMatchObject({ left: 100, width: 300 })
    expect(low.frameId).toBeUndefined() // grew downward: its centre is below the frame
    expect(high.frameId).toBe('F')
    expect(errors).toEqual([])
  })

  test('an image import that finishes during a held drag is added first, as its own step; the new box is still being edited', async ({ page }) => {
    const { errors, at } = await open(page, [])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(400, 160), { hold: true })
    await page.setInputFiles('input[type=file]', [imageFile('late.png', 80, 60, 3)])
    await page.waitForTimeout(400) // decoding finishes while the drag is still held
    await page.mouse.up()
    expect(await editing(page)).toBe(true)
    await page.keyboard.type('after the image')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => d.objects.length === 2 && texts(d).length === 1)
    expect(texts(done)[0]).toMatchObject({ text: 'after the image', left: 100, top: 100, width: 300 })
    await waitSaved(page)
    await undoButton(page).click() // the text
    await storedWhen(page, (d) => d.objects.length === 1 && texts(d).length === 0)
    await undoButton(page).click() // the import
    await storedWhen(page, (d) => d.objects.length === 0)
    await expect(undoButton(page)).toBeDisabled() // two steps in all
    expect(errors).toEqual([])
  })

  test('typing into a dragged box is one undo step; redo restores it with its width; reload shows it', async ({ page }) => {
    const { errors, at } = await open(page, [textRec('other', 100, 500, 'other')])
    await page.keyboard.press('t')
    await drag(page, at(100, 100), at(260, 160))
    await page.keyboard.type('Sized')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 2)
    const made = done.objects.find((o) => o.text === 'Sized')!
    expect(made).toMatchObject({ width: 160, minHeight: 60 })
    await waitSaved(page)
    await undoButton(page).click()
    await storedWhen(page, (d) => texts(d).length === 1)
    await expect(undoButton(page)).toBeDisabled()
    await redoButton(page).click()
    const redone = await storedWhen(page, (d) => texts(d).length === 2)
    expect(redone.objects.find((o) => o.text === 'Sized')).toEqual(made)
    await waitSaved(page)
    await page.reload()
    await expect(status(page)).toContainText('Saved on this device')
    expect((await storedDoc(page)).objects.find((o) => o.text === 'Sized')).toEqual(made)
    await page.mouse.click(at(170, 150).x, at(170, 150).y)
    await expect(page.locator('.inspector-title')).toHaveText('Text') // the restored lower area can be hit
    expect(errors).toEqual([])
  })

  test('with the Text tool chosen and a text being edited, dragging inside that text selects its characters and makes no box', async ({ page }) => {
    const { errors, at } = await open(page, [textRec('t', 100, 100, 'select these words')])
    await page.keyboard.press('t')
    await page.mouse.dblclick(at(110, 112).x, at(110, 112).y)
    expect(await editing(page)).toBe(true)
    await drag(page, at(104, 112), at(300, 112)) // inside the edited text: a text selection, not a draft
    expect(await editing(page)).toBe(true)
    await page.keyboard.type('X')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d)[0]?.text !== 'select these words')
    expect(texts(done)).toHaveLength(1)
    const t = texts(done)[0]?.text ?? '' // the dragged-over characters were selected and replaced by the typed X
    expect(t.includes('X') && t.length < 'select these words'.length).toBe(true)
    expect(errors).toEqual([])
  })

  test('with the Text tool chosen, a text being edited, then a drag on empty canvas: the edit ends as its own step, then the new box', async ({ page }) => {
    const { errors, at } = await open(page, [textRec('t', 100, 100, 'old')])
    await page.keyboard.press('t')
    await page.mouse.dblclick(at(110, 112).x, at(110, 112).y)
    expect(await editing(page)).toBe(true) // a double-click edits a text while the Text tool stays chosen
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('er')
    await expect(tool(page, 'Text')).toHaveAttribute('aria-pressed', 'true')
    await drag(page, at(100, 300), at(300, 360))
    await page.keyboard.type('new')
    await page.keyboard.press('Escape')
    const done = await storedWhen(page, (d) => texts(d).length === 2)
    expect(done.objects.find((o) => o.id === 't')?.text).toBe('older')
    expect(done.objects.find((o) => o.text === 'new')).toMatchObject({ left: 100, top: 300, width: 200 })
    await undoButton(page).click() // the new box
    await storedWhen(page, (d) => texts(d).length === 1)
    await undoButton(page).click() // then the earlier edit, its own step
    await storedWhen(page, (d) => texts(d)[0]?.text === 'old')
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })
})
