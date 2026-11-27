import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openApp, openBlank, redoButton, seedRaw, storedDoc, undoButton, waitSaved } from './helpers.ts'

const asset = { id: 'art', name: 'Tide.png', width: 100, height: 60 }
const image = (id: string, left: number, top: number, extra: Record<string, unknown> = {}) => ({
  id, type: 'image', assetId: asset.id, left, top, angle: 0, scaleX: 1, scaleY: 1, ...extra,
})

async function open(page: Page, objects: unknown[], frames: unknown[] = []) {
  await openBlank(page)
  await seedRaw(page, 2, { version: 2, title: 'Layout study', frames, objects, viewport: { zoom: 1, panX: 0, panY: 0 } }, [asset])
  await openApp(page)
}
const row = (page: Page, id: string) => page.locator(`[data-layer-id="${id}"]`)
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
async function select(page: Page, ids: string[]) {
  for (const [i, id] of ids.entries()) await row(page, id).click({ modifiers: i ? ['Shift'] : [] })
}

test('align and distribute use rotated displayed bounds and equal gaps, and survive history and reload', async ({ page }) => {
  const a = image('a', 200, 160, { angle: 90 })
  const b = image('b', 315, 200, { scaleX: 0.5, scaleY: 0.5, crop: { x: 10, y: 0, width: 80, height: 60 } })
  const c = image('c', 520, 230)
  await open(page, [a, b, c])
  await select(page, ['c', 'b'])
  await expect(button(page, 'Distribute horizontally')).toBeDisabled()
  await row(page, 'a').click({ modifiers: ['Shift'] })
  await button(page, 'Align top edges').click()
  const aligned = [a, { ...b, top: 160 }, { ...c, top: 160 }]
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(aligned)
  await expect(button(page, 'Distribute vertically')).toBeDisabled()
  await button(page, 'Distribute horizontally').click()
  // A's rotated right edge is 200. The middle crop is 40 units wide, so both gaps are 140.
  const spaced = [a, { ...b, top: 160, left: 340 }, { ...c, top: 160 }]
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(spaced)
  for (const id of ['a', 'b', 'c']) await expect(row(page, id)).toHaveAttribute('aria-selected', 'true')

  await button(page, 'Distribute horizontally').click() // already evenly spaced
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(aligned)
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual([a, b, c])
  await expect(undoButton(page)).toBeDisabled()
  await redoButton(page).click()
  await redoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(spaced)

  await button(page, 'Align left edges').click()
  // A's rotated left edge is 140, even though its stored top-left origin is x=200.
  await expect.poll(async () => (await storedDoc(page)).objects.map((o) => o.left)).toEqual([200, 140, 140])
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(spaced)
  await waitSaved(page)
  await page.reload()
  await expect(row(page, 'b')).toBeVisible()
  expect((await storedDoc(page)).objects).toEqual(spaced)
})

test('align moves a frame with unselected members exactly once and leaves nearby loose items loose', async ({ page }) => {
  const frame = { id: 'frame', name: 'Cover', left: 420, top: 100, width: 340, height: 460 }
  const locked = image('locked', 550, 190, { frameId: 'frame', locked: true })
  const selected = image('member', 470, 290, { frameId: 'frame' })
  const near = image('loose', 250, 450)
  const anchor = image('anchor', 180, 220)
  await open(page, [locked, selected, near, anchor], [frame])
  await select(page, ['locked'])
  await expect(button(page, 'Align left edges')).toHaveCount(0)
  await select(page, ['frame', 'member', 'anchor'])
  await button(page, 'Align left edges').click()
  await expect.poll(async () => (await storedDoc(page)).frames).toEqual([{ ...frame, left: 180 }])
  expect((await storedDoc(page)).objects).toEqual([{ ...locked, left: 310 }, { ...selected, left: 180 }, near, anchor])
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).frames).toEqual([frame])
  expect((await storedDoc(page)).objects).toEqual([locked, selected, near, anchor])
})

test('moving selected content into a stationary frame updates ownership, while stationary content stays put', async ({ page }) => {
  const frame = { id: 'frame', name: 'Cover', left: 150, top: 100, width: 280, height: 300 }
  const anchor = image('inside', 240, 160)
  const outsider = image('outsider', 550, 240)
  await open(page, [anchor, outsider], [frame])
  await select(page, ['inside', 'outsider'])
  await button(page, 'Align left edges').click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual([anchor, { ...outsider, left: 240, frameId: 'frame' }])
})
