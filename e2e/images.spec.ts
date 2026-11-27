/**
 * Real-browser tests (real Fabric, real IndexedDB) for image crop, Fit and Fill.
 *
 * The fixture image has four coloured quadrants overlaid with an 8-pixel checker, so a sample
 * of the canvas says which part of the original it shows, and a region of the canvas changes
 * visibly if the image moves by even one pixel. Samples are read from Fabric's lower canvas,
 * which holds the scene and the crop overlay but not the selection handles.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, QUADRANT_COLOURS, drag, openApp, openBlank, redoButton, sceneToPage, seedRaw, snapshotIdb, storedDoc, undoButton } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredObject, View } from './helpers.ts'

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }
/** 240 x 160 source pixels: quadrants 120 x 80. */
const PAT: SeedAsset = { id: 'q1', name: 'quadrants.png', width: 240, height: 160, pattern: 'quadrants' }
const OTHER: SeedAsset = { id: 'q2', name: 'other.png', width: 240, height: 160, pattern: 'quadrants' }

type Crop = { x: number; y: number; width: number; height: number }
const image = (id: string, left: number, top: number, extra: Record<string, unknown> = {}) => ({
  type: 'image',
  id,
  left,
  top,
  angle: 0,
  assetId: 'q1',
  scaleX: 1,
  scaleY: 1,
  ...extra,
})
const frameRec = (id: string, left: number, top: number, width: number, height: number) => ({ id, name: id, left, top, width, height })

interface Opened {
  errors: string[]
  at: (x: number, y: number) => { x: number; y: number }
}

async function openSeeded(page: Page, frames: unknown[], objects: unknown[], assets: SeedAsset[] = [PAT]): Promise<Opened> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  const doc = frames.length === 0 ? { version: 1, title: 'Images', objects, viewport: UNIT } : { version: 2, title: 'Images', frames, objects, viewport: UNIT }
  await seedRaw(page, frames.length === 0 ? 1 : 2, doc, assets)
  await openApp(page)
  return { errors, at: await sceneToPage(page, UNIT) }
}

// ---- locators ---------------------------------------------------------------------------------

const inspector = (page: Page) => page.locator('.inspector')
const title = (page: Page) => page.locator('.inspector-title')
const cropButton = (page: Page) => inspector(page).getByRole('button', { name: 'Crop image', exact: true })
const fitButton = (page: Page) => inspector(page).getByRole('button', { name: 'Fit image', exact: true })
const fillButton = (page: Page) => inspector(page).getByRole('button', { name: 'Fill image', exact: true })
const doneButton = (page: Page) => inspector(page).getByRole('button', { name: 'Done', exact: true })
const cancelButton = (page: Page) => inspector(page).getByRole('button', { name: 'Cancel', exact: true })
const cropHelp = (page: Page) => page.getByTestId('crop-help')
const list = (page: Page) => page.getByRole('listbox', { name: 'Layers', exact: true })
const row = (page: Page, id: string) => list(page).locator(`[data-layer-id="${id}"]`)
const selectedRows = (page: Page) =>
  list(page)
    .locator('[role=option][aria-selected=true]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.layerId))

// ---- stored data -------------------------------------------------------------------------------

const obj = (doc: StoredBoard, id: string) => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no stored object ${id}`)
  return found as StoredObject & { locked?: unknown }
}
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}

/**
 * Renames the board and waits for that save: it re-serializes every record from the canvas, so
 * what it writes shows what the loaded canvas really holds (a reload alone never rewrites the row).
 */
async function resaveFromCanvas(page: Page, title: string): Promise<StoredBoard> {
  const input = page.getByRole('textbox', { name: 'Board title', exact: true })
  await input.fill(title)
  await input.press('Enter')
  return storedWhen(page, (d) => d.title === title)
}
const sameCrop = (a: Crop | undefined, b: Crop | undefined) => JSON.stringify(a) === JSON.stringify(b)

// ---- geometry ------------------------------------------------------------------------------------

/** Scene point of source pixel (u, v) of an image placed with its displayed top-left at (left, top) and showing `crop`. */
function sourcePoint(rec: { left: number; top: number; angle?: number; scaleX: number; scaleY: number; crop?: Crop }, u: number, v: number) {
  const r = ((rec.angle ?? 0) * Math.PI) / 180
  const dx = (u - (rec.crop?.x ?? 0)) * rec.scaleX
  const dy = (v - (rec.crop?.y ?? 0)) * rec.scaleY
  return { x: rec.left + dx * Math.cos(r) - dy * Math.sin(r), y: rec.top + dx * Math.sin(r) + dy * Math.cos(r) }
}

// ---- pixels ----------------------------------------------------------------------------------------

/** RGBA pixels of a page-pixel rectangle of Fabric's lower canvas, after the next two frames. */
function region(page: Page, at: { x: number; y: number }, w: number, h: number): Promise<number[]> {
  return page.evaluate(
    async ({ x, y, w, h }) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const c = document.querySelector('canvas.lower-canvas') as HTMLCanvasElement
      const rect = c.getBoundingClientRect()
      const ratio = c.width / rect.width
      const data = c.getContext('2d')!.getImageData(Math.round((x - rect.left) * ratio), Math.round((y - rect.top) * ratio), Math.round(w * ratio), Math.round(h * ratio)).data
      return Array.from(data)
    },
    { x: at.x, y: at.y, w, h },
  )
}
/** How many channel values differ by more than `tolerance`. */
function differing(a: number[], b: number[], tolerance = 24): number {
  expect(a.length).toBe(b.length)
  let n = 0
  for (let i = 0; i < a.length; i++) if (Math.abs((a[i] as number) - (b[i] as number)) > tolerance) n++
  return n
}
/** The sample's dominant colour family, judged against the quadrant colours (light or dark cell, dimmed or not). */
async function quadrantAt(page: Page, p: { x: number; y: number }): Promise<string> {
  const [r, g, b] = await region(page, { x: p.x - 1, y: p.y - 1 }, 3, 3)
  const scores = Object.entries(QUADRANT_COLOURS).map(([name, c]) => {
    const n = Math.hypot(c[0], c[1], c[2])
    const m = Math.hypot(r!, g!, b!) || 1
    return { name, cos: (c[0] * r! + c[1] * g! + c[2] * b!) / (n * m) }
  })
  scores.sort((a, z) => z.cos - a.cos)
  const best = scores[0]!
  return best.cos > 0.97 ? best.name : `none(${r},${g},${b})`
}

async function select(page: Page, p: { x: number; y: number }) {
  await page.mouse.click(p.x, p.y)
  await expect(title(page)).toHaveText('Image')
}
async function openCrop(page: Page) {
  await cropButton(page).click()
  await expect(cropHelp(page)).toBeVisible()
}

test.describe('cropping', () => {
  test('a corner and a side, applied with Enter: the crop is stored, the kept pixels do not move, one undo step', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150), image('Q', 600, 150, { assetId: 'q2' })], [PAT, OTHER])
    await select(page, o.at(320, 230))
    const kept = () => region(page, o.at(260, 170), 40, 40) // source 60..100 x 20..60: kept by the crop below
    const before = await kept()

    await openCrop(page)
    expect(differing(await kept(), before)).toBe(0) // the whole original in place: nothing moved on opening
    await drag(page, o.at(440, 310), o.at(400, 280)) // bottom-right corner handle
    await drag(page, o.at(200, 220), o.at(230, 220)) // left side handle
    expect(differing(await kept(), before)).toBe(0)
    // Outside the box the original is still there, dimmed.
    expect(await quadrantAt(page, o.at(215, 160))).toBe('tl')
    expect(await quadrantAt(page, o.at(430, 300))).toBe('br')

    await page.keyboard.press('Enter')
    await expect(cropHelp(page)).toBeHidden()
    await expect(title(page)).toHaveText('Image')
    let stored = await storedWhen(page, (d) => obj(d, 'P').crop !== undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 230, 150, { crop: { x: 30, y: 0, width: 170, height: 130 } }))
    expect(stored.objects.map((x) => x.id)).toEqual(['P', 'Q']) // same id and stacking order
    expect(differing(await kept(), before)).toBe(0) // applying moved nothing
    // What was cropped away is gone from the board.
    expect(await quadrantAt(page, o.at(215, 160))).not.toBe('tl')
    expect(await quadrantAt(page, o.at(430, 300))).not.toBe('br')

    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').crop === undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 200, 150))
    await expect(undoButton(page)).toBeDisabled() // exactly one step
    expect(await quadrantAt(page, o.at(215, 160))).toBe('tl')
    await redoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').crop !== undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 230, 150, { crop: { x: 30, y: 0, width: 170, height: 130 } }))
    expect(differing(await kept(), before)).toBe(0)
    expect(o.errors).toEqual([])
  })

  test('Esc and the Cancel button after dragging: the image is exactly as it was, nothing stored, no undo step', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150, { crop: { x: 20, y: 10, width: 180, height: 120 } })])
    await select(page, o.at(290, 210))
    const whole = () => region(page, o.at(180, 130), 240, 160)
    const before = await whole()
    const stored = await snapshotIdb(page)

    await openCrop(page)
    await drag(page, o.at(200, 150), o.at(260, 190))
    await page.keyboard.press('Escape')
    await expect(cropHelp(page)).toBeHidden()
    await expect(title(page)).toHaveText('Image')
    expect(differing(await whole(), before)).toBe(0)

    await openCrop(page)
    await drag(page, o.at(380, 270), o.at(300, 220))
    await cancelButton(page).click()
    await expect(cropHelp(page)).toBeHidden()
    expect(differing(await whole(), before)).toBe(0)

    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(stored)
    await expect(undoButton(page)).toBeDisabled()
    expect(o.errors).toEqual([])
  })

  test('cropped again: the whole original comes back, the box moves, and it grows back to the whole image', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    await select(page, o.at(320, 230))
    await openCrop(page)
    await drag(page, o.at(200, 150), o.at(240, 180)) // top-left corner in
    await page.keyboard.press('Enter')
    let stored = await storedWhen(page, (d) => obj(d, 'P').crop !== undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 240, 180, { crop: { x: 40, y: 30, width: 200, height: 130 } }))
    expect(await quadrantAt(page, o.at(210, 160))).not.toBe('tl') // cropped away

    await openCrop(page)
    expect(await quadrantAt(page, o.at(210, 160))).toBe('tl') // the whole original again, dimmed outside the box
    await drag(page, o.at(320, 240), o.at(300, 230)) // move the box
    await page.keyboard.press('Enter')
    stored = await storedWhen(page, (d) => obj(d, 'P').crop?.x === 20)
    expect(obj(stored, 'P')).toEqual(image('P', 220, 170, { crop: { x: 20, y: 20, width: 200, height: 130 } }))

    await openCrop(page)
    await drag(page, o.at(220, 170), o.at(120, 60)) // top-left far out: stops at the image's corner
    await drag(page, o.at(420, 300), o.at(600, 500)) // bottom-right far out
    await doneButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').crop === undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 200, 150))
    expect(Object.keys(obj(stored, 'P'))).not.toContain('crop')
    expect(o.errors).toEqual([])
  })

  test('a rotated, scaled image: the kept pixels stay put on screen, and a reload shows the same', async ({ page }) => {
    const rec = { left: 400, top: 120, angle: 30, scaleX: 0.75, scaleY: 0.75 }
    const o = await openSeeded(page, [], [image('R', rec.left, rec.top, { angle: 30, scaleX: 0.75, scaleY: 0.75 })])
    const p = (u: number, v: number) => {
      const s = sourcePoint(rec, u, v)
      return o.at(s.x, s.y)
    }
    await select(page, p(120, 80))
    const keptAt = p(120, 70) // well inside what the crop below keeps (source 40..200 x 0..120)
    const kept = () => region(page, { x: keptAt.x - 20, y: keptAt.y - 20 }, 40, 40)
    const before = await kept()

    await openCrop(page)
    expect(differing(await kept(), before)).toBe(0)
    await drag(page, p(240, 160), p(200, 120)) // bottom-right corner, along the image's own axes
    await drag(page, p(0, 60), p(40, 60)) // left side
    await page.keyboard.press('Enter')
    const stored = await storedWhen(page, (d) => obj(d, 'R').crop !== undefined)
    const r = obj(stored, 'R')
    expect(r.crop!.x).toBeCloseTo(40, 0)
    expect(r.crop!.y).toBe(0)
    expect(r.crop!.width).toBeCloseTo(160, 0)
    expect(r.crop!.height).toBeCloseTo(120, 0)
    expect(r).toMatchObject({ angle: 30, scaleX: 0.75, scaleY: 0.75 })
    // The new top-left is where source (crop.x, 0) was: moved along the rotated x axis.
    const corner = sourcePoint(rec, r.crop!.x, 0)
    expect(r.left).toBeCloseTo(corner.x, 1)
    expect(r.top).toBeCloseTo(corner.y, 1)
    const after = await kept()
    expect(differing(after, before)).toBe(0)

    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect.poll(async () => differing(await kept(), after)).toBe(0)
    expect(obj(await storedDoc(page), 'R')).toEqual(r)
    expect(obj(await resaveFromCanvas(page, 'Re-saved'), 'R')).toEqual(r) // what the reloaded canvas holds
    expect(o.errors).toEqual([])
  })
})

test.describe('what is saved while cropping', () => {
  // Already cropped, so the canvas (which holds the whole original while cropping) differs from the stored record.
  const CROP = { x: 20, y: 10, width: 200, height: 140 }
  const cropped = () => image('P', 200, 150, { crop: CROP })

  test('a save during crop mode stores the board from before it; Enter in the title field does not apply; applying stores the crop', async ({ page }) => {
    const o = await openSeeded(page, [], [cropped()])
    await select(page, o.at(300, 220))
    await openCrop(page) // the whole original lies at (180, 140); the box spans x 200..400, y 150..290
    await drag(page, o.at(400, 290), o.at(360, 260))
    const titleInput = page.getByRole('textbox', { name: 'Board title', exact: true })
    await titleInput.fill('Renamed mid-crop')
    await titleInput.press('Enter')
    let stored = await storedWhen(page, (d) => d.title === 'Renamed mid-crop')
    expect(obj(stored, 'P')).toEqual(cropped())
    await expect(cropHelp(page)).toBeVisible() // still cropping
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    stored = await storedWhen(page, (d) => d.viewport.zoom > 1)
    expect(obj(stored, 'P')).toEqual(cropped())
    await expect(cropHelp(page)).toBeVisible()

    await page.keyboard.press('Enter')
    stored = await storedWhen(page, (d) => obj(d, 'P').crop?.width === 160)
    expect(obj(stored, 'P')).toEqual(image('P', 200, 150, { crop: { x: 20, y: 10, width: 160, height: 110 } }))
    expect(o.errors).toEqual([])
  })

  test('a reload during crop mode opens the board from before it', async ({ page }) => {
    const o = await openSeeded(page, [], [cropped()])
    await select(page, o.at(300, 220))
    await openCrop(page)
    await drag(page, o.at(400, 290), o.at(360, 260))
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await storedWhen(page, (d) => d.viewport.zoom > 1)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(page.locator('.save-status')).toContainText('Saved on this device')
    await expect(cropHelp(page)).toHaveCount(0)
    expect(obj(await storedDoc(page), 'P')).toEqual(cropped())
    await expect(undoButton(page)).toBeDisabled()
    expect(obj(await resaveFromCanvas(page, 'Re-saved'), 'P')).toEqual(cropped()) // what the reloaded canvas holds
    expect(o.errors).toEqual([])
  })
})

test.describe('ending crop mode and moving around in it', () => {
  test('a press outside the box applies the crop and does nothing else', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    await select(page, o.at(320, 230))
    await openCrop(page)
    await drag(page, o.at(440, 310), o.at(360, 260))
    await page.mouse.click(o.at(800, 600).x, o.at(800, 600).y) // the empty board
    await expect(cropHelp(page)).toBeHidden()
    await expect(title(page)).toHaveText('Image') // still selected: the press did not deselect
    const stored = await storedWhen(page, (d) => obj(d, 'P').crop !== undefined)
    expect(obj(stored, 'P').crop).toEqual({ x: 0, y: 0, width: 160, height: 110 })
  })

  test('clicking a layer row applies the crop, then selects that row', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150), image('Q', 600, 150, { assetId: 'q2' })], [PAT, OTHER])
    await select(page, o.at(320, 230))
    await openCrop(page)
    await drag(page, o.at(440, 310), o.at(360, 260))
    await row(page, 'Q').click()
    await expect(cropHelp(page)).toBeHidden()
    await expect.poll(() => selectedRows(page)).toEqual(['Q'])
    const stored = await storedWhen(page, (d) => obj(d, 'P').crop !== undefined)
    expect(obj(stored, 'P').crop).toEqual({ x: 0, y: 0, width: 160, height: 110 })
    await undoButton(page).click()
    await storedWhen(page, (d) => obj(d, 'P').crop === undefined)
    await expect(undoButton(page)).toBeDisabled()
  })

  test('double-clicking an image opens crop mode, leaving no gesture or undo step behind', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    const before = await snapshotIdb(page)
    await page.mouse.dblclick(o.at(320, 230).x, o.at(320, 230).y)
    await expect(cropHelp(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(cropHelp(page)).toBeHidden()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    await expect(undoButton(page)).toBeDisabled()
  })

  test('Space-drag and the middle button pan during crop mode without changing the rectangle', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    await select(page, o.at(320, 230))
    await openCrop(page)
    await drag(page, o.at(440, 310), o.at(360, 260))
    await page.keyboard.down('Space')
    await drag(page, o.at(700, 500), o.at(760, 540))
    await page.keyboard.up('Space')
    const mid = o.at(800, 600)
    await page.mouse.move(mid.x, mid.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(mid.x + 40, mid.y - 20, { steps: 4 })
    await page.mouse.up({ button: 'middle' })
    await expect(cropHelp(page)).toBeVisible()
    let stored = await storedWhen(page, (d) => d.viewport.panX === 100 && d.viewport.panY === 20)
    expect(obj(stored, 'P')).toEqual(image('P', 200, 150)) // still the board from before the crop

    // The view moved by (100, 20): the box's right edge is now at page x of scene 360 + 100.
    const moved = await sceneToPage(page, { zoom: 1, panX: 100, panY: 20 })
    await drag(page, moved(360, 200), moved(340, 200)) // the right side, where it now is on screen
    await page.keyboard.press('Enter')
    stored = await storedWhen(page, (d) => obj(d, 'P').crop !== undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 200, 150, { crop: { x: 0, y: 0, width: 140, height: 110 } }))
  })
})

test.describe('Fit and Fill', () => {
  test('after an off-centre crop, Fill keeps the box with a centred maximal crop, and Fit shows the whole image inside it; each one undo step', async ({ page }) => {
    // The top-left 120 x 120 of the 240 x 160 original: a 120 x 120 box at (200, 150).
    const o = await openSeeded(page, [], [image('P', 200, 150, { crop: { x: 0, y: 0, width: 120, height: 120 } })])
    await select(page, o.at(260, 210))
    await expect(fitButton(page)).toBeEnabled()
    await expect(fillButton(page)).toBeEnabled()

    await fillButton(page).click()
    let stored = await storedWhen(page, (d) => obj(d, 'P').crop?.x === 40)
    const filled = obj(stored, 'P')
    expect(filled.crop).toEqual({ x: 40, y: 0, width: 160, height: 160 })
    expect(filled).toMatchObject({ left: 200, top: 150, scaleX: 0.75, scaleY: 0.75 })
    await expect(fillButton(page)).toBeDisabled() // would change nothing now
    // The middle of the box now shows the middle of the original: where four quadrants meet.
    expect(await quadrantAt(page, o.at(240, 190))).toBe('tl')
    expect(await quadrantAt(page, o.at(280, 230))).toBe('br')

    await fitButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').crop === undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 200, 170, { scaleX: 0.5, scaleY: 0.5 })) // 120 x 80, centred on (260, 210)
    await expect(fitButton(page)).toBeDisabled()
    await expect(fillButton(page)).toBeDisabled()

    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').crop?.x === 40)
    expect(obj(stored, 'P')).toEqual(filled)
    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').crop?.x === 0)
    expect(obj(stored, 'P')).toEqual(image('P', 200, 150, { crop: { x: 0, y: 0, width: 120, height: 120 } }))
    await expect(undoButton(page)).toBeDisabled()
  })

  test('Fill on a rotated image keeps its displayed box', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 300, 150, { angle: 30, crop: { x: 0, y: 0, width: 120, height: 120 } })])
    const centre = sourcePoint({ left: 300, top: 150, angle: 30, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 120, height: 120 } }, 60, 60)
    await select(page, o.at(centre.x, centre.y))
    await fillButton(page).click()
    const stored = await storedWhen(page, (d) => obj(d, 'P').crop?.x === 40)
    expect(obj(stored, 'P')).toMatchObject({ left: 300, top: 150, angle: 30, scaleX: 0.75, scaleY: 0.75 })
  })
})

test.describe('frames and locks', () => {
  test('cropped with its centre still inside, an owned image keeps its frame; cropped so its centre leaves, it is loose', async ({ page }) => {
    // Frame A spans x 100..400. The image spans x 250..490 (centre 370, inside A) and belongs to A.
    const o = await openSeeded(page, [frameRec('A', 100, 100, 300, 300)], [image('P', 250, 150, { frameId: 'A' })])
    await select(page, o.at(370, 230))
    await openCrop(page)
    await drag(page, o.at(490, 230), o.at(430, 230)) // right side in: x 250..430, centre 340, inside A
    await page.keyboard.press('Enter')
    let stored = await storedWhen(page, (d) => obj(d, 'P').crop !== undefined)
    expect(obj(stored, 'P')).toEqual(image('P', 250, 150, { frameId: 'A', crop: { x: 0, y: 0, width: 180, height: 160 } }))

    await openCrop(page)
    await drag(page, o.at(250, 230), o.at(380, 230)) // left side in: x 380..430, centre 405, outside A
    await page.keyboard.press('Enter')
    stored = await storedWhen(page, (d) => obj(d, 'P').crop?.x === 130)
    expect(obj(stored, 'P')).toEqual(image('P', 380, 150, { crop: { x: 130, y: 0, width: 50, height: 160 } }))
    expect(Object.keys(obj(stored, 'P'))).not.toContain('frameId')

    await undoButton(page).click() // back in the frame, exactly
    stored = await storedWhen(page, (d) => obj(d, 'P').crop?.x === 0)
    expect(obj(stored, 'P')).toEqual(image('P', 250, 150, { frameId: 'A', crop: { x: 0, y: 0, width: 180, height: 160 } }))
  })

  test('a locked image has no enabled Crop, Fit or Fill, and a double-click does nothing to it', async ({ page }) => {
    const o = await openSeeded(page, [], [image('L', 200, 150, { locked: true, crop: { x: 0, y: 0, width: 120, height: 120 } })])
    const before = await snapshotIdb(page)
    await row(page, 'L').click()
    await expect(title(page)).toHaveText('Image · Locked')
    await expect(cropButton(page)).toBeDisabled()
    await expect(fitButton(page)).toBeDisabled()
    await expect(fillButton(page)).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.mouse.dblclick(o.at(260, 210).x, o.at(260, 210).y)
    await page.waitForTimeout(300)
    await expect(cropHelp(page)).toHaveCount(0)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
  })
})

test.describe('a multi-selection with a cropped image', () => {
  test('moved and scaled from a corner: the crop is unchanged, the scale changes by the one factor, no drift on reload', async ({ page }) => {
    const crop = { x: 30, y: 20, width: 150, height: 100 }
    const o = await openSeeded(page, [], [image('P', 200, 150, { crop }), image('Q', 500, 150, { assetId: 'q2' })], [PAT, OTHER])
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('2 objects')
    await drag(page, o.at(275, 200), o.at(315, 240))
    let stored = await storedWhen(page, (d) => obj(d, 'P').left === 240)
    expect(obj(stored, 'P')).toEqual(image('P', 240, 190, { crop }))
    expect(obj(stored, 'Q')).toMatchObject({ left: 540, top: 190, scaleX: 1 })

    // The selection spans x 240..780, y 190..350: scale from its bottom-right corner.
    await drag(page, o.at(780, 350), o.at(900, 420), { steps: 10 })
    stored = await storedWhen(page, (d) => obj(d, 'Q').scaleX !== 1)
    const p = obj(stored, 'P')
    const q = obj(stored, 'Q')
    expect(sameCrop(p.crop, crop)).toBe(true)
    expect(p.scaleX).toBeCloseTo(q.scaleX!, 4)
    expect(p.scaleY).toBeCloseTo(q.scaleY!, 4)
    expect(p.scaleX).toBeCloseTo(p.scaleY!, 4)
    expect(p.left).toBeCloseTo(240, 1) // the top-left corner is the anchor
    expect(q.left - p.left).toBeCloseTo(300 * q.scaleX!, 0)

    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    const again = await resaveFromCanvas(page, 'Re-saved') // re-serialized from the reloaded canvas, not the untouched row
    expect(obj(again, 'P')).toEqual(p)
    expect(obj(again, 'Q')).toEqual(q)
    expect(o.errors).toEqual([])
  })
})

test.describe('review fixes', () => {
  test('a Fill that used to land 0.01 px away the second time: after one Fill the button is disabled and there is exactly one undo step', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150, { crop: { x: 0, y: 0, width: 20, height: 62 } })])
    await select(page, o.at(210, 181))
    await fillButton(page).click()
    const stored = await storedWhen(page, (d) => obj(d, 'P').crop?.height === 160)
    expect(obj(stored, 'P')).toMatchObject({ crop: { x: 94.2, y: 0, width: 51.61, height: 160 }, scaleX: 0.3875, scaleY: 0.3875 })
    await expect(fillButton(page)).toBeDisabled()
    await undoButton(page).click()
    await storedWhen(page, (d) => obj(d, 'P').crop?.height === 62)
    await expect(undoButton(page)).toBeDisabled()
    expect(o.errors).toEqual([])
  })

  test('Ctrl+A in crop mode selects nothing on the page and nothing on the board', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    await select(page, o.at(320, 230))
    await openCrop(page)
    await page.keyboard.press('Control+a')
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await expect(cropHelp(page)).toBeVisible()
  })
})

test.describe('final review fixes', () => {
  test("Fill keeps a crop that is one stored step off the whole image (Astra's 10 x 100 source at 99.8 x 100), through a reload and a re-save", async ({ page }) => {
    const THIN: SeedAsset = { id: 't1', name: 'thin.png', width: 10, height: 100, pattern: 'quadrants' }
    const o = await openSeeded(page, [], [image('T', 100, -3000, { assetId: 't1', scaleX: 99.8, scaleY: 100 })], [THIN])
    await select(page, o.at(600, 300))
    await fillButton(page).click()
    let stored = await storedWhen(page, (d) => obj(d, 'T').crop !== undefined)
    let t = obj(stored, 'T')
    expect(t.crop).toEqual({ x: 0.01, y: 0, width: 9.98, height: 100 })
    expect(t.crop!.width * t.scaleX!).toBeCloseTo(998, 6)
    await page.reload()
    await expect(page.locator('.save-status')).toContainText('Saved on this device')
    stored = await resaveFromCanvas(page, 'Re-saved')
    t = obj(stored, 'T')
    expect(t.crop).toEqual({ x: 0.01, y: 0, width: 9.98, height: 100 })
    expect(Math.abs(t.crop!.width * t.scaleX! - 998)).toBeLessThanOrEqual(0.05)
    expect(o.errors).toEqual([])
  })

  test("a crop dragged three screen pixels in at scale 8 stays inside the original, and a reload plus a re-save leaves it unchanged (Astra's case)", async ({ page }) => {
    const o = await openSeeded(page, [], [image('W', 100, 100, { scaleX: 8, scaleY: 8 })]) // 240 x 160 shown 1920 x 1280
    await select(page, o.at(600, 400))
    await openCrop(page)
    // The left side, 3 screen pixels = 0.375 source pixels. (Whether the browser's pointer maths lands
    // exactly on the half-step that the old rounding got wrong depends on the layout; the editor unit
    // test pins that case exactly. Here: the invariants, and that a reload plus a re-save keeps it.)
    await drag(page, o.at(100, 400), o.at(103, 400), { steps: 3 })
    await page.keyboard.press('Enter')
    const stored = await storedWhen(page, (d) => obj(d, 'W').crop !== undefined)
    const w = obj(stored, 'W')
    expect(w.crop!.x).toBeGreaterThan(0)
    expect(w.crop!.x + w.crop!.width).toBeLessThanOrEqual(240 + 1e-9)
    expect(w.crop!.width).toBe(Math.round((240 - w.crop!.x) * 100) / 100)
    await page.reload()
    await expect(page.locator('.save-status')).toContainText('Saved on this device')
    expect(obj(await resaveFromCanvas(page, 'Title only'), 'W')).toEqual(w)
    expect(o.errors).toEqual([])
  })

  test('straight after loading, a changed open crop enables Undo; pressing it applies and undoes the crop', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    await select(page, o.at(320, 230))
    const before = await region(page, o.at(180, 130), 280, 200)
    await openCrop(page)
    await expect(undoButton(page)).toBeDisabled()
    await drag(page, o.at(440, 310), o.at(360, 260))
    await expect(undoButton(page)).toBeEnabled()
    await undoButton(page).click()
    await expect(cropHelp(page)).toBeHidden()
    await expect(redoButton(page)).toBeEnabled()
    await expect(undoButton(page)).toBeDisabled()
    expect(differing(await region(page, o.at(180, 130), 280, 200), before)).toBe(0)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(obj(await storedDoc(page), 'P')).toEqual(image('P', 200, 150))
    expect(o.errors).toEqual([])
  })
})
