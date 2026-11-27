import { expect, test } from '@playwright/test'
import { openApp, openBlank, redoButton, seedRaw, snapshotIdb, storedDoc, undoButton, waitSaved } from './helpers.ts'

const frame = { id: 'frame', name: 'Album art', left: 120, top: 100, width: 680, height: 430 }
const image = {
  id: 'photo', type: 'image', assetId: 'art', left: 220, top: 210, angle: 12, scaleX: 1, scaleY: 1,
  crop: { x: 3, y: 12, width: 72, height: 40 }, frameId: 'frame', locked: true,
}
const text = {
  id: 'title', type: 'text', text: 'Salt tide', left: 370, top: 150, angle: 0, width: 280, minHeight: 80,
  fontSize: 20, font: 'serif', spans: [{ start: 0, end: 4, italic: true, font: 'mono' }], headings: [1], frameId: 'frame',
}

test('duplicate a frame and its owned layers once, with crop, rich text and shared original bytes', async ({ page }) => {
  await openBlank(page)
  await seedRaw(page, 2, {
    version: 2, title: 'Duplication', frames: [frame], objects: [image, text],
    viewport: { zoom: 1, panX: 0, panY: 0 },
  }, [{ id: 'art', name: 'Art.png', width: 100, height: 70 }])
  await openApp(page)
  const initial = await storedDoc(page)
  const { assets } = await snapshotIdb(page)
  const row = (id: string) => page.locator(`[data-layer-id="${id}"]`)
  const duplicate = page.getByRole('button', { name: 'Duplicate', exact: true })

  await row('photo').click()
  await expect(duplicate).toBeDisabled()
  await page.keyboard.press('Control+d')
  await expect(undoButton(page)).toBeDisabled()
  await row('frame').click()
  await row('title').click({ modifiers: ['Shift'] })
  await duplicate.click()
  await expect.poll(async () => (await storedDoc(page)).objects.length).toBe(4)

  const copied = await storedDoc(page)
  const newFrame = copied.frames?.[1]
  expect(newFrame).toMatchObject({ name: 'Album art copy', left: 144, top: 124, width: 680, height: 430 })
  expect(newFrame?.id).not.toBe('frame')
  const [copiedPhoto, copiedText] = copied.objects.slice(2)
  const unlocked: Partial<typeof image> = { ...image }
  delete unlocked.locked
  expect(copiedPhoto).toEqual({ ...unlocked, id: copiedPhoto?.id, left: 244, top: 234, frameId: newFrame?.id })
  expect(copiedText).toEqual({ ...text, id: copiedText?.id, left: 394, top: 174, frameId: newFrame?.id })
  expect(new Set(copied.objects.map((o) => o.id)).size).toBe(4)
  expect((await snapshotIdb(page)).assets).toEqual(assets)
  await expect(row(newFrame!.id)).toHaveAttribute('aria-selected', 'true')
  await expect(row(copiedText!.id)).toHaveAttribute('aria-selected', 'true')

  await undoButton(page).click()
  await expect.poll(() => storedDoc(page)).toEqual(initial)
  await expect(undoButton(page)).toBeDisabled()
  await redoButton(page).click()
  await expect.poll(() => storedDoc(page)).toEqual(copied)
  await waitSaved(page)
  await page.reload()
  await expect(row(copiedText!.id)).toBeVisible()
  await row(copiedText!.id).click()
  await page.keyboard.press('Control+d')
  await expect.poll(async () => (await storedDoc(page)).objects.length).toBe(5)
  const lone = (await storedDoc(page)).objects[4]
  expect(lone).toEqual({ ...copiedText, id: lone?.id, left: 418, top: 198 })
  expect((await snapshotIdb(page)).assets).toEqual(assets)
})
