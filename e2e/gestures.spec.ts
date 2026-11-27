/**
 * Real-browser tests (real Fabric, real IndexedDB) for the gesture lifecycle on boards
 * without frames: what a save sees during a gesture, cancelling, pointer buttons,
 * imports that finish mid-gesture, and the single scale factor of a multi-selection.
 * Frames have their own spec; everything here must also hold for milestone 1 content.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  AUTOSAVE_QUIET_MS,
  drag,
  imageFile,
  openApp,
  openBlank,
  redoButton,
  sceneToPage,
  seedMilestone1,
  snapshotIdb,
  status,
  storedDoc,
  undoButton,
  waitSaved,
} from './helpers.ts'
import type { StoredObject, View } from './helpers.ts'

const VIEW: View = { zoom: 1, panX: 0, panY: 0 }
const IMAGE = { type: 'image', id: 'img', left: 300, top: 200, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 }
const ASSET = { id: 'a1', name: 'pic.png', width: 200, height: 120 }
/** Centre of the seeded image in scene coordinates. */
const CENTRE = { x: 400, y: 260 }

const board = (objects: unknown[], viewport: View = VIEW) => ({ version: 1, title: 'Gestures', objects, viewport })

async function open(page: Page, objects: unknown[] = [IMAGE], viewport: View = VIEW) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedMilestone1(page, board(objects, viewport), [ASSET])
  await openApp(page)
  return { errors, at: await sceneToPage(page, viewport) }
}

const byId = (objects: StoredObject[], id: string) => {
  const found = objects.find((o) => o.id === id)
  if (!found) throw new Error(`no stored object ${id}`)
  return found
}

test.describe('durable scene', () => {
  test('a save during a held drag stores the new title and the pre-drag geometry; release stores the final geometry', async ({ page }) => {
    const { errors, at } = await open(page)
    const title = page.locator('input[aria-label="Board title"]')
    await title.fill('Renamed while dragging')
    await title.press('Enter')
    await drag(page, at(CENTRE.x, CENTRE.y), at(CENTRE.x + 150, CENTRE.y + 80), { hold: true })
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)

    const during = await storedDoc(page)
    expect(during.title).toBe('Renamed while dragging')
    expect(byId(during.objects, 'img')).toMatchObject({ left: 300, top: 200 })

    await page.mouse.up()
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(450)
    expect(byId((await storedDoc(page)).objects, 'img')).toMatchObject({ left: 450, top: 280 })
    expect(errors).toEqual([])
  })

  test('reloading in the middle of a drag leaves the stored board byte-equal', async ({ page }) => {
    const { at } = await open(page)
    const before = await snapshotIdb(page)
    await drag(page, at(CENTRE.x, CENTRE.y), at(CENTRE.x + 120, CENTRE.y + 40), { hold: true })
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
  })
})

test.describe('cancelling', () => {
  test('Esc mid-drag restores the board, records nothing, and the next drag works', async ({ page }) => {
    const { errors, at } = await open(page)
    const before = await snapshotIdb(page)
    await drag(page, at(CENTRE.x, CENTRE.y), at(CENTRE.x + 200, CENTRE.y + 100), { hold: true })
    await page.keyboard.press('Escape')
    await page.mouse.move(at(CENTRE.x + 260, CENTRE.y + 130).x, at(CENTRE.x + 260, CENTRE.y + 130).y, { steps: 4 }) // still held: must move nothing
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before) // not even a rewrite of the same document
    await expect(undoButton(page)).toBeDisabled()

    // The image is back where it was, so it is grabbed at its original place.
    await drag(page, at(CENTRE.x, CENTRE.y), at(CENTRE.x + 50, CENTRE.y))
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(350)
    await expect(undoButton(page)).toBeEnabled()
    await undoButton(page).click()
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('a window blur mid-drag restores the board and records nothing', async ({ page }) => {
    const { errors, at } = await open(page)
    const before = await snapshotIdb(page)
    await drag(page, at(CENTRE.x, CENTRE.y), at(CENTRE.x + 180, CENTRE.y + 90), { hold: true })
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))) // the window lost focus (e.g. alt-tab)
    await page.mouse.move(at(CENTRE.x + 240, CENTRE.y + 120).x, at(CENTRE.x + 240, CENTRE.y + 120).y, { steps: 3 })
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    await expect(undoButton(page)).toBeDisabled()
    await drag(page, at(CENTRE.x, CENTRE.y), at(CENTRE.x + 30, CENTRE.y)) // it is back where it was, and still draggable
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(330)
    expect(errors).toEqual([])
  })

  test('Esc mid-scale of a multi-selection restores every member exactly and records nothing', async ({ page }) => {
    const second = { ...IMAGE, id: 'img2', left: 700, top: 420, angle: 25 }
    const { errors, at } = await open(page, [IMAGE, second])
    const before = await snapshotIdb(page)
    await page.keyboard.press('Control+a')
    await expect(page.locator('.inspector-title')).toHaveText('2 objects')
    const handle = at(300, 200) // top-left corner of the selection (the first image's corner)
    await drag(page, handle, { x: handle.x + 150, y: handle.y + 100 }, { hold: true, steps: 10 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    await expect(undoButton(page)).toBeDisabled()
    await expect(page.locator('.inspector-title')).toHaveText('2 objects') // the selection is re-formed
    expect(errors).toEqual([])
  })

  test('ten drags out and back return the board to exactly where it started, each one undoable', async ({ page }) => {
    const { errors, at } = await open(page)
    const before = (await storedDoc(page)).objects
    for (let i = 0; i < 5; i++) {
      await drag(page, at(CENTRE.x, CENTRE.y), at(CENTRE.x + 137, CENTRE.y - 53))
      await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(437)
      await drag(page, at(CENTRE.x + 137, CENTRE.y - 53), at(CENTRE.x, CENTRE.y))
      await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(300)
    }
    expect((await storedDoc(page)).objects).toEqual(before) // no drift after ten gestures
    for (let i = 0; i < 10; i++) {
      await expect(undoButton(page)).toBeEnabled()
      await undoButton(page).click()
    }
    await expect(undoButton(page)).toBeDisabled() // ten steps, no more and no fewer
    expect(errors).toEqual([])
  })

  test('a click that moves nothing records nothing and saves nothing', async ({ page }) => {
    const { at } = await open(page)
    const before = await snapshotIdb(page)
    await page.mouse.click(at(CENTRE.x, CENTRE.y).x, at(CENTRE.x, CENTRE.y).y)
    await expect(page.locator('.inspector-title')).toHaveText('Image')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    await expect(undoButton(page)).toBeDisabled()
  })
})

test.describe('a text that ends blank', () => {
  const NOTE = { type: 'text', id: 'note', left: 700, top: 200, angle: 0, text: 'note', fontSize: 24, width: 240 }

  test('emptying an existing text and pressing Esc removes it with no page error, as one undoable step', async ({ page }) => {
    const { errors, at } = await open(page, [IMAGE, NOTE])
    const inside = at(712, 212)
    await page.mouse.dblclick(inside.x, inside.y)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Escape')
    await waitSaved(page)
    await expect.poll(async () => (await storedDoc(page)).objects.map((o) => o.id)).toEqual(['img'])
    expect(errors).toEqual([])
    await undoButton(page).click()
    await expect.poll(async () => (await storedDoc(page)).objects.map((o) => o.id)).toEqual(['img', 'note'])
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })

  test('leaving an emptied text by clicking another object selects that object with the same click', async ({ page }) => {
    const { errors, at } = await open(page, [IMAGE, NOTE])
    const inside = at(712, 212)
    await page.mouse.dblclick(inside.x, inside.y)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await page.mouse.click(at(CENTRE.x, CENTRE.y).x, at(CENTRE.x, CENTRE.y).y) // the image
    await expect(page.locator('.inspector-title')).toHaveText('Image') // not swallowed by an error
    await expect.poll(async () => (await storedDoc(page)).objects.map((o) => o.id)).toEqual(['img'])
    expect(errors).toEqual([])
  })

  test('Shift-clicking another object out of an emptied text selects just that object', async ({ page }) => {
    const { errors, at } = await open(page, [IMAGE, NOTE])
    const inside = at(712, 212)
    await page.mouse.dblclick(inside.x, inside.y)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await page.keyboard.down('Shift')
    await page.mouse.click(at(CENTRE.x, CENTRE.y).x, at(CENTRE.x, CENTRE.y).y)
    await page.keyboard.up('Shift')
    await expect(page.locator('.inspector-title')).toHaveText('Image') // not "2 objects" with a ghost
    await expect.poll(async () => (await storedDoc(page)).objects.map((o) => o.id)).toEqual(['img'])
    expect(errors).toEqual([])
  })

  test('a new text holding only spaces is discarded without a page error', async ({ page }) => {
    const { errors, at } = await open(page)
    const before = await snapshotIdb(page)
    await page.keyboard.press('t')
    await page.mouse.click(at(800, 450).x, at(800, 450).y)
    await page.keyboard.type('   ')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(JSON.parse((await snapshotIdb(page)).doc).objects).toEqual(JSON.parse(before.doc).objects)
    await expect(undoButton(page)).toBeDisabled()
    expect(errors).toEqual([])
  })
})

test.describe('pointer buttons', () => {
  for (const button of ['right', 'middle'] as const) {
    test(`a ${button}-button press and release during a primary drag does not end the drag`, async ({ page }) => {
      const { errors, at } = await open(page)
      const start = at(CENTRE.x, CENTRE.y)
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + 60, start.y + 20, { steps: 4 })
      await page.mouse.down({ button })
      await page.mouse.move(start.x + 90, start.y + 30, { steps: 4 }) // moving with both held: still the drag, never a pan
      await page.mouse.up({ button })
      await page.mouse.move(start.x + 120, start.y + 40, { steps: 4 }) // the drag must still be live
      await page.mouse.move(start.x + 120, 10, { steps: 4 }) // also outside the canvas (over the header)
      await page.mouse.move(start.x + 180, start.y + 60, { steps: 4 })
      await page.mouse.up()
      await waitSaved(page)
      await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(480)
      const after = await storedDoc(page)
      expect(byId(after.objects, 'img')).toMatchObject({ left: 480, top: 260 }) // followed the pointer to the very end
      expect(after.viewport).toEqual(VIEW) // and the middle button did not pan

      // After the primary release the pointer moves nothing.
      const settled = await snapshotIdb(page)
      await page.mouse.move(start.x + 300, start.y + 200, { steps: 4 })
      await page.waitForTimeout(AUTOSAVE_QUIET_MS)
      expect(await snapshotIdb(page)).toEqual(settled)

      // Exactly one undo step for the whole drag.
      await undoButton(page).click()
      await expect(undoButton(page)).toBeDisabled()
      await waitSaved(page)
      expect(byId((await storedDoc(page)).objects, 'img')).toMatchObject({ left: 300, top: 200 })
      expect(errors).toEqual([])
    })
  }

  test('a right-button drag over an object moves nothing and selects nothing', async ({ page }) => {
    const { errors, at } = await open(page)
    const before = await snapshotIdb(page)
    const start = at(CENTRE.x, CENTRE.y)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(start.x + 100, start.y + 50, { steps: 4 })
    await page.mouse.up({ button: 'right' })
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect(undoButton(page)).toBeDisabled()
    // A primary drag afterwards still works.
    await drag(page, start, { x: start.x + 40, y: start.y })
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(340)
    expect(errors).toEqual([])
  })
})

test.describe('imports that finish during a gesture', () => {
  test('a file chosen while the pointer is held becomes its own undo step after the drag', async ({ page }) => {
    const { errors, at } = await open(page)
    const start = at(CENTRE.x, CENTRE.y)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 100, start.y, { steps: 4 })
    await page.setInputFiles('input[type=file]', [imageFile('late.png', 80, 60, 3)])
    await page.waitForTimeout(400) // decoding finishes while the drag is still held
    await page.mouse.up()
    await waitSaved(page)
    await expect.poll(async () => (await storedDoc(page)).objects.length).toBe(2)
    expect(byId((await storedDoc(page)).objects, 'img').left).toBe(400)

    await undoButton(page).click() // first undo: only the import
    await waitSaved(page)
    await expect.poll(async () => (await storedDoc(page)).objects.length).toBe(1)
    expect(byId((await storedDoc(page)).objects, 'img').left).toBe(400)
    await undoButton(page).click() // second undo: the drag
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(300)
    await expect(undoButton(page)).toBeDisabled()

    // A following drag works normally.
    await drag(page, start, { x: start.x - 50, y: start.y })
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').left).toBe(250)
    expect(errors).toEqual([])
  })
})

test.describe('scaling', () => {
  test('Shift does not unlock free scaling: an image stays proportional', async ({ page }) => {
    const { at } = await open(page)
    await page.mouse.click(at(CENTRE.x, CENTRE.y).x, at(CENTRE.x, CENTRE.y).y)
    const corner = at(500, 320) // bottom-right corner of the 200x120 image
    await page.keyboard.down('Shift')
    await drag(page, corner, { x: corner.x + 160, y: corner.y + 10 })
    await page.keyboard.up('Shift')
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'img').scaleX).toBeGreaterThan(1.2)
    const img = byId((await storedDoc(page)).objects, 'img')
    expect(img.scaleX).toBe(img.scaleY)
    expect(img.angle).toBe(0)
  })

  test('a multi-selection is limited by one factor: a 300px text stops every member at exactly 400/300', async ({ page }) => {
    // Zoomed out so the large text fits. The selection spans x 300..1500 in the scene.
    const view: View = { zoom: 0.25, panX: 500, panY: 400 }
    const text = { type: 'text', id: 'txt', left: 700, top: 200, angle: 0, text: 'Big', fontSize: 300, width: 800 }
    const { errors, at } = await open(page, [IMAGE, text], view)
    const before = (await storedDoc(page)).objects

    await page.keyboard.press('Control+a')
    await expect(page.locator('.inspector-title')).toHaveText('2 objects')
    // Drag the top-left handle far up and left: asks for well over 2x about the bottom-right corner.
    const handle = at(300, 200)
    await drag(page, handle, { x: handle.x - 420, y: handle.y - 300 }, { steps: 12 })
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'txt').fontSize).toBe(400)

    const k = 400 / 300
    const check = (objects: StoredObject[]) => {
      const img = byId(objects, 'img')
      const txt = byId(objects, 'txt')
      expect(txt.fontSize).toBe(400) // the limit, exactly
      expect(txt.width).toBeCloseTo(800 * k, 1) // not 2x: the same factor as the font
      expect(img.scaleX).toBeCloseTo(k, 4)
      expect(img.scaleY).toBeCloseTo(k, 4)
      // Positions scale by the same factor about the fixed right edge (x = 1500 in the scene).
      expect(txt.left + (txt.width ?? 0)).toBeCloseTo(1500, 0)
      expect(txt.left - img.left).toBeCloseTo((700 - 300) * k, 0)
      expect(txt.top - img.top).toBeCloseTo(0, 0)
    }
    const after = (await storedDoc(page)).objects
    check(after)

    // Deselecting must not change anything (the text scale was folded into its font size).
    await page.keyboard.press('Escape')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect((await storedDoc(page)).objects).toEqual(after)

    // The canvas object itself carries the folded size, not a leftover scale: selected on its
    // own, the text reports 400 in the Inspector.
    const txt = byId(after, 'txt')
    const inside = at(txt.left + 60, txt.top + 150)
    await page.mouse.click(inside.x, inside.y)
    await expect(page.locator('.inspector-title')).toHaveText('Text')
    await expect(page.locator('.number-input')).toHaveValue('400')
    await page.keyboard.press('Escape')

    await undoButton(page).click()
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'txt').fontSize).toBe(300)
    expect((await storedDoc(page)).objects).toEqual(before) // exact pre-gesture records
    await expect(undoButton(page)).toBeDisabled()

    await redoButton(page).click()
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'txt').fontSize).toBe(400)
    expect((await storedDoc(page)).objects).toEqual(after)

    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect((await storedDoc(page)).objects).toEqual(after) // no drift from loading
    expect(errors).toEqual([])
  })

  test('an out-of-range text in a multi-selection may shrink but blocks any enlargement', async ({ page }) => {
    const view: View = { zoom: 0.25, panX: 500, panY: 400 }
    const text = { type: 'text', id: 'txt', left: 700, top: 200, angle: 0, text: 'Huge', fontSize: 500, width: 1400 }
    const { at } = await open(page, [IMAGE, text], view)
    const before = await snapshotIdb(page)

    // Enlarge: not allowed at all, and the text is not snapped down to 400 either.
    await page.keyboard.press('Control+a')
    const handle = at(300, 200)
    await drag(page, handle, { x: handle.x - 200, y: handle.y - 150 }, { steps: 10 })
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    await expect(undoButton(page)).toBeDisabled()

    // Shrink: allowed, and every member shrinks by the same factor.
    await drag(page, handle, { x: handle.x + 60, y: handle.y + 40 }, { steps: 10 })
    await waitSaved(page)
    await expect.poll(async () => byId((await storedDoc(page)).objects, 'txt').fontSize ?? 500).toBeLessThan(500)
    const objects = (await storedDoc(page)).objects
    const k = (byId(objects, 'txt').fontSize ?? 0) / 500
    expect(k).toBeGreaterThan(0.5)
    expect(byId(objects, 'txt').width).toBeCloseTo(1400 * k, 0)
    expect(byId(objects, 'img').scaleX).toBeCloseTo(k, 2)
  })
})
