/**
 * Real-browser tests (real Fabric, real IndexedDB) for Replace image.
 *
 * The board's image has coloured quadrants; every replacement picture is a gradient whose
 * green channel is 240 everywhere (`pngBuffer` with seed 3), which none of the quadrants has,
 * so a canvas sample says which picture is showing. Samples are read from Fabric's lower
 * canvas (the scene, without selection handles).
 */
import { expect, test } from '@playwright/test'
import type { FileChooser, Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, openApp, openBlank, pngBuffer, redoButton, sceneToPage, seedRaw, snapshotIdb, storedDoc, undoButton } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredObject, View } from './helpers.ts'

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }
const PAT: SeedAsset = { id: 'q1', name: 'quadrants.png', width: 240, height: 160, pattern: 'quadrants' }
const OTHER: SeedAsset = { id: 'q2', name: 'other.png', width: 240, height: 160, pattern: 'quadrants' }
const GREEN = 240 // the replacement pictures' green channel

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
const picture = (name: string, width: number, height: number) => ({ name, mimeType: 'image/png', buffer: pngBuffer(width, height, 3) })

async function openSeeded(page: Page, frames: unknown[], objects: unknown[], assets: SeedAsset[] = [PAT]) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  const doc = frames.length === 0 ? { version: 1, title: 'Replace', objects, viewport: UNIT } : { version: 2, title: 'Replace', frames, objects, viewport: UNIT }
  await seedRaw(page, frames.length === 0 ? 1 : 2, doc, assets)
  await openApp(page)
  return { errors, at: await sceneToPage(page, UNIT) }
}

const inspector = (page: Page) => page.locator('.inspector')
const title = (page: Page) => page.locator('.inspector-title')
const replaceButton = (page: Page) => inspector(page).getByRole('button', { name: 'Replace image', exact: true })
const fitButton = (page: Page) => inspector(page).getByRole('button', { name: 'Fit image', exact: true })
const list = (page: Page) => page.getByRole('listbox', { name: 'Layers', exact: true })
const row = (page: Page, id: string) => list(page).locator(`[data-layer-id="${id}"]`)
const toast = (page: Page) => page.locator('.toast')

const obj = (doc: StoredBoard, id: string) => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no stored object ${id}`)
  return found as StoredObject & { assetId: string; locked?: unknown }
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

/** Centre and displayed size of a stored image, given its picture's size in source pixels. */
function box(rec: { left: number; top: number; angle: number; scaleX?: number; scaleY?: number; crop?: Crop }, size: { width: number; height: number }) {
  const w = (rec.crop?.width ?? size.width) * (rec.scaleX ?? 1)
  const h = (rec.crop?.height ?? size.height) * (rec.scaleY ?? 1)
  const r = (rec.angle * Math.PI) / 180
  return { x: rec.left + (w / 2) * Math.cos(r) - (h / 2) * Math.sin(r), y: rec.top + (w / 2) * Math.sin(r) + (h / 2) * Math.cos(r), w, h }
}
function expectSameBox(a: ReturnType<typeof box>, z: ReturnType<typeof box>) {
  expect(Math.hypot(z.x - a.x, z.y - a.y)).toBeLessThanOrEqual(0.02)
  expect(Math.abs(z.w - a.w)).toBeLessThanOrEqual(0.05)
  expect(Math.abs(z.h - a.h)).toBeLessThanOrEqual(0.05)
}

/** RGBA pixels of a page-pixel rectangle of Fabric's lower canvas, after the next two frames. */
function region(page: Page, at: { x: number; y: number }, w: number, h: number): Promise<number[]> {
  return page.evaluate(
    async ({ x, y, w, h }) => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const c = document.querySelector('canvas.lower-canvas') as HTMLCanvasElement
      const rect = c.getBoundingClientRect()
      const ratio = c.width / rect.width
      return Array.from(c.getContext('2d')!.getImageData(Math.round((x - rect.left) * ratio), Math.round((y - rect.top) * ratio), Math.round(w * ratio), Math.round(h * ratio)).data)
    },
    { x: at.x, y: at.y, w, h },
  )
}
const greenAt = async (page: Page, p: { x: number; y: number }) => (await region(page, p, 1, 1))[1]!
function differing(a: number[], b: number[], tolerance = 24): number {
  let n = 0
  for (let i = 0; i < a.length; i++) if (Math.abs((a[i] as number) - (b[i] as number)) > tolerance) n++
  return n
}

async function select(page: Page, p: { x: number; y: number }) {
  await page.mouse.click(p.x, p.y)
  await expect(title(page)).toHaveText('Image')
}
/** Presses Replace image and returns the open file chooser (the dialog stays "open" until files are set). */
async function pressReplace(page: Page): Promise<FileChooser> {
  const chooser = page.waitForEvent('filechooser')
  await replaceButton(page).click()
  const c = await chooser
  expect(c.isMultiple()).toBe(false)
  return c
}

test.describe('replace image', () => {
  test('a wider and then a taller picture: same id, box and stacking; a centred crop; the new colours inside the box only; one undo step each', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150), image('Q', 600, 150, { assetId: 'q2' })], [PAT, OTHER])
    const outside = () => region(page, o.at(170, 120), 20, 20) // the board just above-left of the box
    const outsideBefore = await outside()
    await select(page, o.at(320, 230))
    const before = obj(await storedDoc(page), 'P')

    await (await pressReplace(page)).setFiles(picture('wide.png', 400, 100))
    let stored = await storedWhen(page, (d) => obj(d, 'P').assetId !== 'q1')
    const wide = obj(stored, 'P')
    expect(wide).toMatchObject({ id: 'P', angle: 0, crop: { x: 125, y: 0, width: 150, height: 100 }, scaleX: 1.6, scaleY: 1.6 })
    expect(Object.keys(wide)).not.toContain('frameId')
    expect(stored.objects.map((x) => x.id)).toEqual(['P', 'Q'])
    expectSameBox(box(before, PAT), box(wide, { width: 400, height: 100 }))
    for (const p of [o.at(205, 155), o.at(320, 230), o.at(435, 305)]) expect(await greenAt(page, p)).toBeGreaterThan(GREEN - 12)
    expect(differing(await outside(), outsideBefore)).toBe(0)
    await expect(title(page)).toHaveText('Image') // still selected
    await expect(row(page, 'P')).toContainText('wide.png')

    await (await pressReplace(page)).setFiles(picture('tall.png', 100, 400))
    stored = await storedWhen(page, (d) => obj(d, 'P').assetId !== wide.assetId)
    const tall = obj(stored, 'P')
    expect(tall.crop!.x).toBe(0)
    expect(tall.crop!.width).toBe(100)
    expect(tall.crop!.height).toBeCloseTo(66.67, 2)
    expect(tall.crop!.y).toBeCloseTo((400 - 66.67) / 2, 1)
    expectSameBox(box(before, PAT), box(tall, { width: 100, height: 400 }))
    expect(await greenAt(page, o.at(320, 230))).toBeGreaterThan(GREEN - 12)

    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').assetId === wide.assetId)
    expect(obj(stored, 'P')).toEqual(wide)
    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').assetId === 'q1')
    expect(obj(stored, 'P')).toEqual(before)
    await expect(undoButton(page)).toBeDisabled()
    expect(await greenAt(page, o.at(320, 230))).toBeLessThan(200) // the quadrants again
    await redoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'P').assetId === wide.assetId)
    expect(obj(stored, 'P')).toEqual(wide)
    expect(o.errors).toEqual([])
  })

  test('the same aspect ratio at a different resolution: no crop, only the scale changes', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    await select(page, o.at(320, 230))
    await (await pressReplace(page)).setFiles(picture('double.png', 480, 320))
    const stored = await storedWhen(page, (d) => obj(d, 'P').assetId !== 'q1')
    const p = obj(stored, 'P')
    expect(p).toMatchObject({ left: 200, top: 150, angle: 0, scaleX: 0.5, scaleY: 0.5 })
    expect(Object.keys(p)).not.toContain('crop')
    // The one file input is back in Add mode once a replace pick has been handled.
    const input = page.locator('input[type=file]')
    expect(await input.evaluate((el) => (el as HTMLInputElement).multiple)).toBe(true)
    await expect(input).not.toHaveAttribute('data-replace-for')
  })

  test('a rotated, cropped image owned by a frame: box, angle and owner unchanged; a reload shows the same, stores the new bytes and prunes the old ones', async ({ page }) => {
    const crop = { x: 20, y: 10, width: 160, height: 120 }
    const o = await openSeeded(page, [{ id: 'A', name: 'A', left: 0, top: 0, width: 900, height: 700 }], [image('P', 300, 150, { angle: 30, scaleX: 0.75, scaleY: 0.75, crop, frameId: 'A' })])
    const before = obj(await storedDoc(page), 'P')
    const c = box(before, PAT)
    await select(page, o.at(c.x, c.y))
    await (await pressReplace(page)).setFiles(picture('new.png', 300, 300))
    const stored = await storedWhen(page, (d) => obj(d, 'P').assetId !== 'q1')
    const p = obj(stored, 'P')
    expect(p).toMatchObject({ frameId: 'A', angle: 30 })
    expect(p.scaleX).toBe(p.scaleY)
    expectSameBox(c, box(p, { width: 300, height: 300 }))
    const sample = () => region(page, { x: o.at(c.x, c.y).x - 15, y: o.at(c.x, c.y).y - 15 }, 30, 30)
    const shown = await sample()
    expect(shown[1]).toBeGreaterThan(GREEN - 12)
    let idb = await snapshotIdb(page)
    expect(Object.keys(idb.assets).sort()).toEqual(['q1', p.assetId].sort()) // the old bytes stay until a load prunes them

    await page.reload()
    await expect(page.locator('.save-status')).toContainText('Saved on this device')
    await expect.poll(async () => differing(await sample(), shown)).toBe(0)
    expect(obj(await storedDoc(page), 'P')).toEqual(p)
    expect(obj(await resaveFromCanvas(page, 'Re-saved'), 'P')).toEqual(p) // what the reloaded canvas holds
    await expect.poll(async () => Object.keys((await snapshotIdb(page)).assets)).toEqual([p.assetId])
    idb = await snapshotIdb(page)
    expect(idb.assets[p.assetId]!.len).toBe(picture('new.png', 300, 300).buffer.length)
    expect(o.errors).toEqual([])
  })

  test('the target deleted, or locked, while the file dialog is open: a notice, nothing changes, nothing is saved', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150), image('Q', 600, 150, { assetId: 'q2' })], [PAT, OTHER])
    await select(page, o.at(320, 230))
    let chooser = await pressReplace(page)
    await page.keyboard.press('Delete')
    await storedWhen(page, (d) => d.objects.length === 1)
    let snapshot = await snapshotIdb(page)
    await chooser.setFiles(picture('late.png', 400, 100))
    await expect(toast(page)).toContainText('could not be replaced: it is no longer on the board.')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(snapshot)

    await select(page, o.at(720, 230))
    chooser = await pressReplace(page)
    await row(page, 'Q').getByTestId('layer-lock').click()
    await storedWhen(page, (d) => obj(d, 'Q').locked === true)
    snapshot = await snapshotIdb(page)
    await chooser.setFiles(picture('late.png', 400, 100))
    await expect(toast(page)).toContainText('could not be replaced: it is locked. Unlock it and try again.')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(snapshot)
    expect(obj(await storedDoc(page), 'Q').assetId).toBe('q2')
    expect(o.errors).toEqual([])
  })

  test('chosen while the target is part of a multi-selection: replaced in place, the selection stays', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150), image('Q', 600, 150, { assetId: 'q2' })], [PAT, OTHER])
    await select(page, o.at(320, 230))
    const before = obj(await storedDoc(page), 'P')
    const chooser = await pressReplace(page)
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('2 objects')
    await chooser.setFiles(picture('wide.png', 400, 100))
    const stored = await storedWhen(page, (d) => obj(d, 'P').assetId !== 'q1')
    expectSameBox(box(before, PAT), box(obj(stored, 'P'), { width: 400, height: 100 }))
    expect(obj(stored, 'Q')).toEqual(image('Q', 600, 150, { assetId: 'q2' }))
    await expect(title(page)).toHaveText('2 objects')
    expect(await greenAt(page, o.at(320, 230))).toBeGreaterThan(GREEN - 12)
  })

  test('saved and reloaded: the new picture is shown, the document references exactly its assets, and loading rewrote nothing', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150), image('Q', 600, 150, { assetId: 'q2' })], [PAT, OTHER])
    await select(page, o.at(320, 230))
    await (await pressReplace(page)).setFiles(picture('wide.png', 400, 100))
    const stored = await storedWhen(page, (d) => obj(d, 'P').assetId !== 'q1')
    const newId = obj(stored, 'P').assetId
    await page.reload()
    await expect(page.locator('.save-status')).toContainText('Saved on this device')
    await expect.poll(async () => greenAt(page, o.at(320, 230))).toBeGreaterThan(GREEN - 12)
    await expect.poll(async () => Object.keys((await snapshotIdb(page)).assets).sort()).toEqual(['q2', newId].sort())
    const after = await snapshotIdb(page)
    const doc = JSON.parse(after.doc) as StoredBoard
    expect(doc.objects.map((x) => (x as unknown as { assetId: string }).assetId).sort()).toEqual(['q2', newId].sort())
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    const later = await snapshotIdb(page)
    expect(later.doc).toBe(after.doc)
    expect(later.updatedAt).toBe(after.updatedAt)
  })

  test('replace, then Fit: the whole new picture inside the box, centred, no crop', async ({ page }) => {
    const o = await openSeeded(page, [], [image('P', 200, 150)])
    await select(page, o.at(320, 230))
    await (await pressReplace(page)).setFiles(picture('wide.png', 400, 100))
    await storedWhen(page, (d) => obj(d, 'P').assetId !== 'q1')
    await fitButton(page).click()
    const stored = await storedWhen(page, (d) => obj(d, 'P').crop === undefined)
    const p = obj(stored, 'P')
    expect(p).toMatchObject({ left: 200, top: 200, scaleX: 0.6, scaleY: 0.6 }) // 240 x 60, centred on (320, 230)
    expect(Object.keys(p)).not.toContain('crop')
  })

  test('the button is disabled for a locked image', async ({ page }) => {
    await openSeeded(page, [], [image('L', 200, 150, { locked: true })])
    await row(page, 'L').click()
    await expect(title(page)).toHaveText('Image · Locked')
    await expect(replaceButton(page)).toBeDisabled()
  })
})
