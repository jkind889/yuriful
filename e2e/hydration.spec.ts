/**
 * Real-browser regression tests for persistence safety (real Fabric, real IndexedDB):
 *
 *  1. Nothing is editable or saved until the stored board has been hydrated.
 *  2. A board that cannot be fully restored (undecodable image, unreadable document,
 *     unavailable storage) is READ-ONLY, and its original document and image bytes
 *     are never rewritten, deleted, or pruned.
 *  3. Control: a fully successful restore stays editable and still prunes orphaned bytes.
 */
import { expect, test } from '@playwright/test'
import {
  AUTOSAVE_QUIET_MS,
  dropImage,
  imageFile,
  makeStorageUnavailable,
  pngBuffer,
  releaseHydration,
  seedBoard,
  snapshotIdb,
  stallHydration,
  status,
  tamperIdb,
  waitSaved,
} from './helpers.ts'

const tinyPng = pngBuffer(4, 4, 2).toString('base64')

test.describe('hydration gate: early interaction while the stored board is still loading', () => {
  test('input during delayed hydration changes nothing, then the restored board edits normally', async ({ context }) => {
    const reader = await seedBoard(context) // independent view of what is really persisted
    const before = await snapshotIdb(reader)
    const docBefore = JSON.parse(before.doc)
    expect(docBefore.objects).toHaveLength(3)
    expect(Object.keys(before.assets)).toHaveLength(2)

    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await stallHydration(page)
    await page.goto('/')
    await expect(status(page)).toContainText('Loading')
    await expect(page.locator('.toolbar')).toHaveCount(0)
    await expect(page.locator('input[aria-label="Board title"]')).toBeDisabled()

    // Everything a user (or a stray event) could do while hydration is pending.
    for (const key of ['t', 'h', 'v', 'i', 'f', 'Control+a', 'Delete', 'Backspace', 'Control+z', 'Control+Shift+z', '=', '-', '0', 'Shift+1', '[', ']', 'Escape']) {
      await page.keyboard.press(key)
    }
    await page.keyboard.down('Space')
    await page.mouse.move(500, 400)
    await page.mouse.down()
    await page.mouse.move(560, 440, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    await page.keyboard.press('t')
    await page.mouse.click(300, 300) // would place text if the text tool were live
    await page.keyboard.type('EARLY TEXT SHOULD NOT EXIST')
    await page.mouse.click(700, 500)
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, 300)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -300)
    await page.keyboard.up('Control')
    await page.setInputFiles('input[type=file]', [imageFile('early.png', 50, 50)]) // picker path
    await dropImage(page, 'early-drop.png', tinyPng) // drop path
    await expect(page.locator('.toast')).toContainText(/still loading/i)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)

    await expect(status(page)).toContainText('Loading') // never reached dirty/saving
    const during = await snapshotIdb(reader)
    expect(during.doc).toBe(before.doc)
    expect(during.updatedAt).toBe(before.updatedAt) // no write of any kind
    expect(during.assets).toEqual(before.assets)

    await releaseHydration(page)
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled() // early input recorded no history
    await expect(page.locator('.empty-state')).toHaveCount(0)
    await expect(page.locator('.zoom-readout')).toHaveText(`${Math.round(docBefore.viewport.zoom * 100)}%`)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect((await snapshotIdb(reader)).updatedAt).toBe(before.updatedAt) // restoring alone writes nothing

    // A genuine edit afterwards saves the *restored* board, not an empty or partial one.
    const title = page.locator('input[aria-label="Board title"]')
    await title.fill('Edited after hydration')
    await title.press('Enter')
    await waitSaved(page)
    const after = await snapshotIdb(reader)
    const docAfter = JSON.parse(after.doc)
    expect(docAfter.title).toBe('Edited after hydration')
    expect(docAfter.objects).toEqual(docBefore.objects) // same 3 objects, order and geometry
    expect(after.assets).toEqual(before.assets)
    expect(errors).toEqual([])
  })
})

test.describe('failed load is read-only and preserves the original document and bytes', () => {
  test('an undecodable stored image: explicit read-only state, no edits, nothing written or pruned', async ({ context }) => {
    const seeded = await seedBoard(context)
    await tamperIdb(seeded, 'corrupt-second-asset') // referenced asset no longer decodes
    await tamperIdb(seeded, 'add-orphan') // and an unreferenced one that a careless prune would delete
    const base = await snapshotIdb(seeded)
    expect(Object.keys(base.assets)).toHaveLength(3)
    await seeded.close()

    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await expect(page.locator('.toolbar')).toBeVisible()

    // Explicit, persistent, visible reason.
    const banner = page.getByTestId('readonly-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Read-only')
    await expect(banner).toContainText('1 saved image could not be loaded')
    await expect(status(page)).toContainText('Not saving')
    await expect(page.locator('.empty-state')).toHaveCount(0) // what loaded is shown; no "add" prompts

    // Editing controls are disabled; navigation is not.
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Add image' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Text' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Frame', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled()
    await expect(page.locator('input[aria-label="Board title"]')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Hand (pan)' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Hand (pan)' })).toHaveAttribute('aria-pressed', 'true')

    // Try hard to edit.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.press('t')
    await page.mouse.click(120, 700)
    await page.keyboard.type('typing into a protected session')
    await page.keyboard.press('Escape')
    await page.keyboard.press('i')
    await page.keyboard.press('f') // would arm the Frame tool
    await page.mouse.move(300, 600)
    await page.mouse.down()
    await page.mouse.move(500, 700, { steps: 4 })
    await page.mouse.up()
    await page.mouse.dblclick(100, 450) // would enter text editing on the stored text
    await page.keyboard.type('nope')
    await page.mouse.move(640, 400) // drag over the stored image
    await page.mouse.down()
    await page.mouse.move(700, 460, { steps: 6 })
    await page.mouse.up()
    await page.setInputFiles('input[type=file]', [imageFile('blocked.png', 20, 20)])
    await expect(page.locator('.toast-error')).toContainText('read-only')
    await dropImage(page, 'blocked-drop.png', tinyPng)
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    await expect(page.locator('.inspector')).toHaveCount(0) // nothing could even be selected
    await expect(status(page)).toContainText('Not saving')

    // Navigation still works (and never writes).
    await expect(page.locator('.zoom-readout')).toHaveText('100%')
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect(page.locator('.zoom-readout')).toHaveText('125%')
    await page.keyboard.press('0')
    await expect(page.locator('.zoom-readout')).toHaveText('100%')

    const mid = await snapshotIdb(page)
    expect(mid.doc).toBe(base.doc) // both image records and the text still stored
    expect(mid.updatedAt).toBe(base.updatedAt) // no write of any kind
    expect(mid.assets).toEqual(base.assets) // every asset byte, including undecodable and orphan

    // Reload repeatedly: the hydration-time prune must never delete anything here.
    for (let i = 0; i < 2; i++) {
      await page.reload()
      await expect(page.getByTestId('readonly-banner')).toBeVisible()
    }
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    const reloaded = await snapshotIdb(page)
    expect(reloaded.doc).toBe(base.doc)
    expect(reloaded.assets).toEqual(base.assets)
    expect(JSON.parse(reloaded.doc).objects.filter((o: { type: string }) => o.type === 'image')).toHaveLength(2)
    await expect(status(page)).toContainText('Not saving') // never silently "Saved"
    expect(errors).toEqual([])
  })

  test('an unreadable stored document is read-only and left untouched', async ({ context }) => {
    const seeded = await seedBoard(context)
    await tamperIdb(seeded, 'unreadable-board')
    const base = await snapshotIdb(seeded)
    await seeded.close()

    const page = await context.newPage()
    await page.goto('/')
    await expect(page.getByTestId('readonly-banner')).toContainText('could not be read')
    await expect(page.getByRole('button', { name: 'Text' })).toBeDisabled()
    await page.keyboard.press('t')
    await page.mouse.click(300, 300)
    await page.keyboard.type('no')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(base)
  })

  test('unavailable storage is read-only with a visible reason, and the app still renders', async ({ page }) => {
    await makeStorageUnavailable(page)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    const banner = page.getByTestId('readonly-banner')
    await expect(banner).toContainText('Local storage is unavailable')
    await expect(banner).toContainText('Storage access denied')
    await expect(status(page)).toContainText('Not saving')
    await expect(page.locator('.empty-state')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add image' })).toBeDisabled()
    await page.keyboard.press('t')
    await page.mouse.click(300, 300)
    await page.keyboard.type('x')
    await expect(page.locator('.inspector')).toHaveCount(0)
    expect(errors).toEqual([])
  })
})

test.describe('control: a healthy board stays editable and is still pruned', () => {
  test('successful restore is not read-only; only unreferenced bytes are pruned', async ({ context }) => {
    const seeded = await seedBoard(context)
    await tamperIdb(seeded, 'add-orphan')
    const base = await snapshotIdb(seeded)
    const referenced = Object.keys(base.assets).filter((id) => id !== 'orphan-asset')
    expect(referenced).toHaveLength(2)
    await seeded.close()

    const page = await context.newPage()
    await page.goto('/')
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await expect(page.getByTestId('readonly-banner')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Text' })).toBeEnabled()
    await expect(page.locator('input[aria-label="Board title"]')).toBeEnabled()

    await expect.poll(async () => 'orphan-asset' in (await snapshotIdb(page)).assets).toBe(false)
    const after = await snapshotIdb(page)
    expect(after.doc).toBe(base.doc)
    for (const id of referenced) expect(after.assets[id]).toEqual(base.assets[id])
  })
})
