/**
 * Real-browser tests (real Fabric, real IndexedDB) for locking.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, dbVersion, drag, openApp, openBlank, redoButton, sceneToPage, seedRaw, snapshotIdb, storedDoc, undoButton, waitSaved } from './helpers.ts'
import type { SeedAsset, StoredBoard, View } from './helpers.ts'

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }
const PIC: SeedAsset = { id: 'a1', name: 'pic.png', width: 200, height: 120 }
const BIG: SeedAsset = { id: 'a2', name: 'big.png', width: 400, height: 300, seed: 2 }

const image = (id: string, left: number, top: number, extra: Record<string, unknown> = {}) => ({
  type: 'image',
  id,
  left,
  top,
  angle: 0,
  assetId: 'a1',
  scaleX: 1,
  scaleY: 1,
  ...extra,
})
const text = (id: string, left: number, top: number, value: string, extra: Record<string, unknown> = {}) => ({
  type: 'text',
  id,
  left,
  top,
  angle: 0,
  text: value,
  fontSize: 24,
  width: 200,
  ...extra,
})
const frameRec = (id: string, left: number, top: number, width: number, height: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  left,
  top,
  width,
  height,
  ...extra,
})

interface Opened {
  errors: string[]
  at: (x: number, y: number) => { x: number; y: number }
}

async function openSeeded(page: Page, frames: unknown[], objects: unknown[], assets: SeedAsset[] = [PIC], version = 2): Promise<Opened> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  const doc = version === 1 ? { version: 1, title: 'Locking', objects, viewport: UNIT } : { version: 2, title: 'Locking', frames, objects, viewport: UNIT }
  await seedRaw(page, version, doc, assets)
  await openApp(page)
  return { errors, at: await sceneToPage(page, UNIT) }
}

const list = (page: Page) => page.getByRole('listbox', { name: 'Layers', exact: true })
const row = (page: Page, id: string) => list(page).locator(`[data-layer-id="${id}"]`)
const padlock = (page: Page, id: string) => row(page, id).getByTestId('layer-lock')
const selectedRows = (page: Page) =>
  list(page)
    .locator('[role=option][aria-selected=true]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.layerId))
const lockedRows = (page: Page) =>
  list(page)
    .locator('[data-layer-locked=true]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.layerId))
const title = (page: Page) => page.locator('.inspector-title')
const inspector = (page: Page) => page.locator('.inspector')
const lockButton = (page: Page) => inspector(page).getByRole('button', { name: 'Lock', exact: true })
const unlockButton = (page: Page) => inspector(page).getByRole('button', { name: 'Unlock', exact: true })
const obj = (doc: StoredBoard, id: string) => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no stored object ${id}`)
  return found as StoredBoard['objects'][number] & { locked?: unknown }
}
const frameOf = (doc: StoredBoard, id: string) => {
  const found = (doc.frames ?? []).find((f) => f.id === id)
  if (!found) throw new Error(`no stored frame ${id}`)
  return found as NonNullable<StoredBoard['frames']>[number] & { locked?: unknown }
}
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}
const focusIsOnBody = (page: Page) => page.evaluate(() => document.activeElement === document.body)
const cursorAt = async (page: Page, p: { x: number; y: number }) => {
  await page.mouse.move(p.x, p.y)
  return page.locator('.upper-canvas').evaluate((el) => (el as HTMLElement).style.cursor)
}

test.describe('a locked object on the canvas', () => {
  test('a big locked image on top of a small one: presses, marquees, Select all and Shift-click reach only the small one', async ({ page }) => {
    // "small" lies entirely under the locked "big".
    const o = await openSeeded(page, [], [image('small', 300, 200), image('big', 250, 150, { assetId: 'a2', locked: true })], [PIC, BIG])
    await expect.poll(() => lockedRows(page)).toEqual(['big'])
    expect(await cursorAt(page, o.at(600, 420))).toBe('default') // over the locked image only: nothing to grab
    expect(await cursorAt(page, o.at(400, 260))).toBe('move') // the small one beneath can be grabbed

    // A press on the locked image goes to the one beneath it.
    await drag(page, o.at(400, 260), o.at(440, 290))
    let stored = await storedWhen(page, (d) => obj(d, 'small').left === 340)
    expect(obj(stored, 'small')).toMatchObject({ left: 340, top: 230 })
    expect(obj(stored, 'big')).toEqual(image('big', 250, 150, { assetId: 'a2', locked: true }))
    await expect.poll(() => selectedRows(page)).toEqual(['small'])

    // A marquee over both selects only the unlocked one.
    await page.keyboard.press('Escape')
    await drag(page, o.at(200, 100), o.at(700, 520))
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    await expect(title(page)).toHaveText('Image')
    // So does Select all.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+a')
    await expect.poll(() => selectedRows(page)).toEqual(['small'])

    // Shift-click on the locked image does not add it.
    await page.keyboard.down('Shift')
    await page.mouse.click(o.at(600, 420).x, o.at(600, 420).y)
    await page.keyboard.up('Shift')
    await expect.poll(() => selectedRows(page)).toEqual([])
    // A marquee started on top of the locked image starts on the board, and takes what it touches.
    await drag(page, o.at(600, 420), o.at(520, 330))
    await expect.poll(() => selectedRows(page)).toEqual(['small'])

    await waitSaved(page)
    stored = await storedDoc(page)
    expect(obj(stored, 'big')).toEqual(image('big', 250, 150, { assetId: 'a2', locked: true }))
    expect(o.errors).toEqual([])
  })

  test('selected from the list, a locked image cannot be dragged, resized, deleted or reordered; unlocked it drags; undo locks it again', async ({ page }) => {
    const o = await openSeeded(page, [], [image('other', 700, 450), image('L', 300, 200, { locked: true })])
    const before = await snapshotIdb(page)
    await row(page, 'L').click()
    await expect.poll(() => selectedRows(page)).toEqual(['L'])
    await expect(title(page)).toHaveText('Image · Locked')
    await expect(page.getByTestId('locked-note')).toBeVisible()
    await expect(inspector(page).getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
    for (const name of ['Bring to front', 'Bring forward', 'Send backward', 'Send to back']) {
      await expect(inspector(page).getByRole('button', { name, exact: true })).toBeDisabled()
    }

    // Its body: the press falls through to the empty board (a marquee that takes nothing).
    await drag(page, o.at(400, 260), o.at(450, 300))
    await expect.poll(() => selectedRows(page)).toEqual([])
    // Where its bottom-right handle would be: no handle.
    await row(page, 'L').click()
    await drag(page, o.at(500, 320), o.at(560, 360))
    // Alt does not reach it either.
    await row(page, 'L').click()
    await page.keyboard.down('Alt')
    await drag(page, o.at(400, 260), o.at(450, 300))
    await page.keyboard.up('Alt')
    // Delete and the layer keys do nothing.
    await row(page, 'L').click()
    for (const k of ['Delete', 'Backspace', ']', '[', 'Control+]', 'Control+[']) await page.keyboard.press(k)
    await expect.poll(() => selectedRows(page)).toEqual(['L'])
    // Shift-clicking another object does not add it to the locked selection: it is selected alone.
    await page.keyboard.down('Shift')
    await page.mouse.click(o.at(800, 510).x, o.at(800, 510).y)
    await page.keyboard.up('Shift')
    await expect.poll(() => selectedRows(page)).toEqual(['other'])
    await expect(title(page)).toHaveText('Image')
    await expect(undoButton(page)).toBeDisabled()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before) // nothing was written

    // Unlock in the inspector: it drags again.
    await row(page, 'L').click()
    await unlockButton(page).click()
    await expect(title(page)).toHaveText('Image')
    await expect(lockButton(page)).toBeVisible()
    await drag(page, o.at(400, 260), o.at(450, 300))
    let stored = await storedWhen(page, (d) => obj(d, 'L').left === 350)
    expect(obj(stored, 'L')).toEqual(image('L', 350, 240))

    // Undo twice: back where it was, and locked again (click-through again).
    await undoButton(page).click()
    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'L').locked === true)
    expect(obj(stored, 'L')).toEqual(image('L', 300, 200, { locked: true }))
    await expect(undoButton(page)).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.mouse.click(o.at(400, 260).x, o.at(400, 260).y)
    await expect.poll(() => selectedRows(page)).toEqual([])

    await redoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'L').locked === undefined)
    expect(Object.keys(obj(stored, 'L'))).not.toContain('locked')
    await page.mouse.click(o.at(400, 260).x, o.at(400, 260).y)
    await expect.poll(() => selectedRows(page)).toEqual(['L'])
    expect(o.errors).toEqual([])
  })
})

test.describe('locked things and frames', () => {
  test('a locked member travels with its frame exactly once, also when "Select with contents" leaves it out; scaling that selection leaves it where it is', async ({ page }) => {
    const o = await openSeeded(page, [frameRec('A', 100, 100, 400, 300)], [image('L', 150, 150, { frameId: 'A', locked: true }), image('u', 280, 250, { frameId: 'A' })])

    // Dragged by its label: the frame carries the locked member by the same delta.
    const corner = o.at(100, 100)
    const label = { x: corner.x + 10, y: corner.y - 14 }
    await drag(page, label, { x: label.x + 40, y: label.y + 30 })
    let stored = await storedWhen(page, (d) => frameOf(d, 'A').left === 140)
    expect(obj(stored, 'L')).toEqual(image('L', 190, 180, { frameId: 'A', locked: true }))
    expect(obj(stored, 'u')).toMatchObject({ left: 320, top: 280, frameId: 'A' })

    // "Select with contents" takes the frame and the unlocked member only.
    await row(page, 'A').click()
    await inspector(page).getByRole('button', { name: 'Select with contents', exact: true }).click()
    await expect(title(page)).toHaveText('2 objects')
    await expect.poll(() => selectedRows(page)).toEqual(['u', 'A'])
    // Dragging that selection (by u) still carries the locked member, exactly once.
    await drag(page, o.at(420, 340), o.at(470, 360))
    stored = await storedWhen(page, (d) => frameOf(d, 'A').left === 190)
    expect(frameOf(stored, 'A')).toMatchObject({ left: 190, top: 150, width: 400, height: 300 })
    expect(obj(stored, 'u')).toMatchObject({ left: 370, top: 300, frameId: 'A' })
    expect(obj(stored, 'L')).toEqual(image('L', 240, 200, { frameId: 'A', locked: true }))

    // Scaling frame-with-contents from its bottom-right handle leaves the locked member as it is.
    await expect.poll(() => selectedRows(page)).toEqual(['u', 'A'])
    await drag(page, o.at(590, 450), o.at(490, 375), { steps: 10 })
    stored = await storedWhen(page, (d) => frameOf(d, 'A').width < 400)
    expect(frameOf(stored, 'A').width).toBeLessThan(400)
    expect(obj(stored, 'u').scaleX).toBeLessThan(1)
    expect(obj(stored, 'L')).toEqual(image('L', 240, 200, { frameId: 'A', locked: true })) // its centre (340, 260) is still inside
    expect(o.errors).toEqual([])
  })

  test('a locked frame cannot be dragged by its label; an image dragged into it joins it', async ({ page }) => {
    const LF = frameRec('LF', 300, 100, 300, 250, { locked: true })
    const o = await openSeeded(page, [LF], [image('x', 320, 480)])
    expect(await cursorAt(page, { x: o.at(300, 100).x + 10, y: o.at(300, 100).y - 14 })).toBe('default')
    const label = { x: o.at(300, 100).x + 10, y: o.at(300, 100).y - 14 }
    await drag(page, label, { x: label.x + 60, y: label.y + 40 })
    await drag(page, o.at(450, 225), o.at(500, 260)) // its outline is not grabbable, its interior is click-through
    await expect.poll(() => selectedRows(page)).toEqual([])
    await expect(undoButton(page)).toBeDisabled()
    // Double-clicking its label does not start a rename.
    await page.mouse.dblclick(label.x, label.y)
    await expect(page.locator('.inspector')).toHaveCount(0)

    // An image dragged into it joins it, by the image's own movement.
    await drag(page, o.at(420, 540), o.at(450, 220))
    const stored = await storedWhen(page, (d) => obj(d, 'x').frameId === 'LF')
    expect(obj(stored, 'x')).toMatchObject({ left: 350, top: 160, frameId: 'LF' })
    expect(frameOf(stored, 'LF')).toEqual(LF)
    expect(o.errors).toEqual([])
  })
})

test.describe('locked text', () => {
  test('locking a text being edited commits it, then locks it; a double-click does not edit it; the Text tool places a new text on a locked image', async ({ page }) => {
    const o = await openSeeded(page, [], [text('t', 100, 400, 'hello'), image('L', 500, 150, { locked: true })])
    await page.mouse.dblclick(o.at(130, 412).x, o.at(130, 412).y)
    await page.keyboard.press('End')
    await page.keyboard.type(' world')
    await lockButton(page).click()
    await expect(title(page)).toHaveText('Text · Locked')
    let stored = await storedWhen(page, (d) => obj(d, 't').locked === true)
    expect(obj(stored, 't')).toMatchObject({ text: 'hello world', locked: true })
    await expect(inspector(page).getByLabel('Font size', { exact: true })).toBeDisabled()

    // Two steps: the lock, then the typing.
    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 't').locked === undefined)
    expect(obj(stored, 't').text).toBe('hello world')
    await undoButton(page).click()
    await storedWhen(page, (d) => obj(d, 't').text === 'hello')
    await expect(undoButton(page)).toBeDisabled()
    await redoButton(page).click()
    await redoButton(page).click()
    await storedWhen(page, (d) => obj(d, 't').locked === true && obj(d, 't').text === 'hello world')

    // A double-click on the locked text does not start editing it.
    await page.keyboard.press('Escape')
    await page.mouse.dblclick(o.at(130, 412).x, o.at(130, 412).y)
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
    await page.keyboard.type('zz')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(obj(await storedDoc(page), 't').text).toBe('hello world')

    // With the Text tool, a click on the locked image places a new text there.
    await page.keyboard.press('t')
    await page.mouse.click(o.at(600, 200).x, o.at(600, 200).y)
    await page.keyboard.type('over')
    await page.keyboard.press('Escape')
    stored = await storedWhen(page, (d) => d.objects.length === 3)
    const added = stored.objects.find((x) => x.text === 'over')!
    expect(added).toMatchObject({ type: 'text', left: 600, top: 200 })
    expect(obj(stored, 'L')).toEqual(image('L', 500, 150, { locked: true }))
    expect(o.errors).toEqual([])
  })
})

test.describe('saving, reloading and the three ways to lock', () => {
  test('stored records say locked only where something is locked; after a reload they are still locked and click-through; a padlock unlocks', async ({ page }) => {
    const o = await openSeeded(page, [frameRec('F', 100, 100, 400, 300)], [image('L', 150, 150, { frameId: 'F' }), image('u', 600, 150)])
    await padlock(page, 'L').click()
    await padlock(page, 'F').click()
    let stored = await storedWhen(page, (d) => obj(d, 'L').locked === true && frameOf(d, 'F').locked === true)
    expect(obj(stored, 'L')).toEqual(image('L', 150, 150, { frameId: 'F', locked: true }))
    expect(frameOf(stored, 'F')).toEqual(frameRec('F', 100, 100, 400, 300, { locked: true }))
    expect(Object.keys(obj(stored, 'u'))).not.toContain('locked')
    expect(stored.version).toBe(2)

    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect.poll(() => lockedRows(page)).toEqual(['L', 'F'])
    await expect(padlock(page, 'L')).toHaveAttribute('aria-pressed', 'true')
    await expect(padlock(page, 'L')).toHaveAccessibleName('Unlock')
    await expect(padlock(page, 'u')).toHaveAccessibleName('Lock')
    await page.mouse.click(o.at(250, 210).x, o.at(250, 210).y) // the locked image, inside the locked frame
    await expect.poll(() => selectedRows(page)).toEqual([])
    const label = { x: o.at(100, 100).x + 10, y: o.at(100, 100).y - 14 }
    await page.mouse.click(label.x, label.y)
    await expect.poll(() => selectedRows(page)).toEqual([])

    await padlock(page, 'L').click()
    stored = await storedWhen(page, (d) => obj(d, 'L').locked === undefined)
    expect(obj(stored, 'L')).toEqual(image('L', 150, 150, { frameId: 'F' }))
    await page.mouse.click(o.at(250, 210).x, o.at(250, 210).y)
    await expect.poll(() => selectedRows(page)).toEqual(['L'])
    expect(o.errors).toEqual([])
  })

  test('a frameless board with a lock is still a version 1 board in a version 1 database', async ({ page }) => {
    const o = await openSeeded(page, [], [image('i', 300, 200)], [PIC], 1)
    await page.mouse.click(o.at(400, 260).x, o.at(400, 260).y)
    await page.keyboard.press('Control+Shift+L')
    const stored = await storedWhen(page, (d) => obj(d, 'i').locked === true)
    expect(stored.version).toBe(1)
    expect(stored).not.toHaveProperty('frames')
    expect(await dbVersion(page)).toBe(1)
    expect(o.errors).toEqual([])
  })

  test('Ctrl+Shift+L, the row padlock and the inspector button all lock and unlock; the padlock neither selects its row nor takes focus', async ({ page }) => {
    const o = await openSeeded(page, [], [image('A', 100, 150), image('B', 500, 150)])
    await page.mouse.click(o.at(200, 210).x, o.at(200, 210).y)
    await expect.poll(() => selectedRows(page)).toEqual(['A'])

    await page.keyboard.press('Control+Shift+L')
    await expect.poll(() => lockedRows(page)).toEqual(['A'])
    await expect(title(page)).toHaveText('Image · Locked')
    await expect.poll(() => selectedRows(page)).toEqual(['A'])
    await page.keyboard.press('Control+Shift+L')
    await expect.poll(() => lockedRows(page)).toEqual([])
    await expect(title(page)).toHaveText('Image')

    await padlock(page, 'B').click()
    await expect.poll(() => lockedRows(page)).toEqual(['B'])
    await expect.poll(() => selectedRows(page)).toEqual(['A']) // the row was not selected
    expect(await focusIsOnBody(page)).toBe(true)
    await padlock(page, 'B').click()
    await expect.poll(() => lockedRows(page)).toEqual([])

    await lockButton(page).click()
    await expect.poll(() => lockedRows(page)).toEqual(['A'])
    await unlockButton(page).click()
    await expect.poll(() => lockedRows(page)).toEqual([])
    await expect(undoButton(page)).toBeEnabled()
    expect(o.errors).toEqual([])
  })

  test('unlock A, select A and B, undo: A is locked again and a drag moves only B', async ({ page }) => {
    const o = await openSeeded(page, [], [image('A', 100, 150, { locked: true }), image('B', 500, 150)])
    await padlock(page, 'A').click()
    await expect.poll(() => lockedRows(page)).toEqual([])
    await row(page, 'A').click()
    await row(page, 'B').click({ modifiers: ['Control'] })
    await expect(title(page)).toHaveText('2 objects')
    await undoButton(page).click()
    await expect.poll(() => lockedRows(page)).toEqual(['A'])
    await expect.poll(() => selectedRows(page)).toEqual(['B'])
    await expect(title(page)).toHaveText('Image')

    await drag(page, o.at(600, 210), o.at(640, 240))
    const stored = await storedWhen(page, (d) => obj(d, 'B').left === 540)
    expect(obj(stored, 'B')).toMatchObject({ left: 540, top: 180 })
    expect(obj(stored, 'A')).toEqual(image('A', 100, 150, { locked: true }))
    expect(o.errors).toEqual([])
  })

  test('on a read-only board the padlocks are shown but do nothing', async ({ page }) => {
    await openBlank(page)
    await seedRaw(
      page,
      2,
      { version: 2, title: 'Broken', frames: [], objects: [image('ok', 150, 150, { locked: true }), image('bad', 600, 150, { assetId: 'gone' })], viewport: UNIT },
      [PIC],
    )
    await page.goto('/')
    await expect(page.getByTestId('readonly-banner')).toBeVisible()
    await expect.poll(() => lockedRows(page)).toEqual(['ok'])
    await expect(padlock(page, 'ok')).toBeDisabled()
    await padlock(page, 'ok').click({ force: true })
    await expect.poll(() => lockedRows(page)).toEqual(['ok'])
  })
})
