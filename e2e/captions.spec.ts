import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { albumSpread, drag, imageFile, openApp, openBlank, releaseHydration, sceneToPage, seedRaw, snapshotIdb, stallHydration, storedDoc } from './helpers.ts'
import type { StoredBoard } from './helpers.ts'

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const layer = (page: Page, id: string) => page.getByRole('option').and(page.locator(`[data-layer-id="${id}"]`))
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Selection', exact: true })
const textarea = (page: Page) => page.locator('textarea:focus')
const object = (board: StoredBoard, id: string) => board.objects.find((item) => item.id === id)!
const errors = new WeakMap<Page, string[]>()

test.afterEach(({ page }) => expect(errors.get(page) ?? []).toEqual([]))

async function fixture(page: Page, change?: (board: StoredBoard) => void, options: { open?: boolean; feedback?: false } = {}) {
  const { doc, assets } = albumSpread()
  change?.(doc)
  const messages: string[] = []
  errors.set(page, messages)
  page.on('pageerror', (error) => messages.push(error.message))
  await openBlank(page)
  await seedRaw(page, 2, { ...doc }, assets)
  if (options.feedback === false) await page.evaluate(() => localStorage.setItem('yuriful.prefs.v1', '{"feedback":false}'))
  if (options.open !== false) await openApp(page)
  return doc
}

async function savedAfter(page: Page, check: (board: StoredBoard) => boolean) {
  await expect.poll(async () => check(await storedDoc(page))).toBe(true)
  return storedDoc(page)
}

async function select(page: Page, ...ids: string[]) {
  for (const [i, id] of ids.entries()) await layer(page, id).click(i === 0 ? {} : { modifiers: ['Shift'] })
}

async function undoRedo(page: Page, before: StoredBoard, after: StoredBoard, expectFirstStep = true) {
  await button(page, 'Undo').click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(before.objects)
  await expect.poll(async () => (await storedDoc(page)).frames).toEqual(before.frames)
  if (expectFirstStep) await expect(button(page, 'Undo')).toBeDisabled()
  await button(page, 'Redo').click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(after.objects)
  await expect.poll(async () => (await storedDoc(page)).frames).toEqual(after.frames)
}

function expectUnder(board: StoredBoard, imageId = 'front', captionId = 'caption', original = { width: 150, height: 120 }) {
  const image = object(board, imageId)
  const caption = object(board, captionId)
  const { width, height } = image.crop ?? original
  const w = width * image.scaleX!
  const h = height * image.scaleY!
  const radians = image.angle * Math.PI / 180
  const dx = w * Math.cos(radians)
  const dy = w * Math.sin(radians)
  const ex = -h * Math.sin(radians)
  const ey = h * Math.cos(radians)
  expect(caption.captionOf).toBe(image.id)
  expect(caption.frameId).toBe(image.frameId)
  expect(caption.angle).toBe(0)
  expect(caption.left).toBeCloseTo(image.left + Math.min(0, dx) + Math.min(0, ex), 2)
  expect(caption.top).toBeCloseTo(image.top + Math.max(0, dy) + Math.max(0, ey) + Math.round(caption.fontSize! * 0.4), 2)
  expect(caption.width).toBeCloseTo(Math.abs(dx) + Math.abs(ex), 2)
}

/** Sample the actual text ink while a drag is still held, before commit can re-place it. */
function ink(page: Page, x: number, y: number) {
  return page.locator('canvas.lower-canvas').evaluate((canvas, { x, y }) => {
    const el = canvas as HTMLCanvasElement
    const scale = el.width / el.clientWidth
    const data = el.getContext('2d')!.getImageData(x * scale, y * scale, 150 * scale, 19 * scale).data
    const dark = []
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 75 && data[i + 1]! < 75 && data[i + 2]! < 75 && data[i + 3]! > 150) dark.push(i)
    return dark
  }, { x, y })
}

const carries = [
  { name: 'image alone', selected: ['front'], start: [285, 205] },
  { name: 'image and caption selected', selected: ['front', 'caption'], start: [285, 205] },
  { name: 'frame with neither child selected', selected: ['sleeve'], start: [158, 76] },
  { name: 'frame and image selected, caption unselected', selected: ['sleeve', 'front'], start: [158, 76] },
] as const

for (const { name, selected, start } of carries) {
  test(`moves the caption exactly once with ${name}, even before release`, async ({ page }) => {
    const before = await fixture(page, undefined, { feedback: false }) // compare caption ink without drag shadows
    const at = await sceneToPage(page, before.viewport)
    await select(page, ...selected)
    const pixels = await ink(page, 210, 280)
    expect(pixels.length).toBeGreaterThan(60)
    await drag(page, at(start[0], start[1]), at(start[0] + 35, start[1] + 55), { hold: true })
    await expect.poll(() => ink(page, 245, 335)).toEqual(pixels)
    await page.mouse.up()
    const after = await savedAfter(page, (doc) => object(doc, 'front').top === 205)
    expect(object(after, 'caption')).toEqual({ ...object(before, 'caption'), left: 245, top: 335 })
    expect(object(after, 'loose')).toEqual(object(before, 'loose'))
    await undoRedo(page, before, after)
  })
}

test('scales the image alone, then rotates it without tipping the caption', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  await select(page, 'front')
  await drag(page, at(360, 270), at(435, 330))
  const scaled = await savedAfter(page, (doc) => object(doc, 'front').scaleX! > 1.3)
  expectUnder(scaled)
  expect(object(scaled, 'caption').fontSize).toBe(24)
  await undoRedo(page, before, scaled)
  await button(page, 'Undo').click()
  await savedAfter(page, (doc) => object(doc, 'front').scaleX === 1)
  await select(page, 'front')
  await drag(page, at(285, 108), at(386, 210))
  const rotated = await savedAfter(page, (doc) => object(doc, 'front').angle > 60)
  expectUnder(rotated)
  await undoRedo(page, before, rotated)
  await openApp(page)
  const untouched = await snapshotIdb(page)
  await select(page, 'front')
  await page.keyboard.press('Enter')
  await expect(textarea(page)).toHaveValue('Front sleeve')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(650)
  expect(await snapshotIdb(page)).toEqual(untouched)
  await expect(button(page, 'Undo')).toBeDisabled()
})

test('scales image and caption as a pair, then rotates both and detaches', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  await select(page, 'front', 'caption')
  await drag(page, at(210, 150), at(150, 95))
  const scaled = await savedAfter(page, (doc) => object(doc, 'front').scaleX! > 1.2)
  expectUnder(scaled)
  expect(object(scaled, 'caption').fontSize).toBeCloseTo(24 * object(scaled, 'front').scaleX!, 2)
  await undoRedo(page, before, scaled)
  await button(page, 'Undo').click()
  await savedAfter(page, (doc) => object(doc, 'front').scaleX === 1)
  await select(page, 'front', 'caption')
  await drag(page, at(285, 110), at(404, 229))
  const rotated = await savedAfter(page, (doc) => object(doc, 'front').angle > 60)
  expect(object(rotated, 'caption')).not.toHaveProperty('captionOf')
  expect(object(rotated, 'caption').angle).toBe(object(rotated, 'front').angle)
  await undoRedo(page, before, rotated)
})

test('a press keeps attachment, moving the caption detaches, and later image moves and deletion leave it in place', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  await page.mouse.click(at(267, 293).x, at(267, 293).y)
  await expect(button(page, 'Detach caption')).toBeVisible()
  await expect(button(page, 'Undo')).toBeDisabled()
  await drag(page, at(267, 293), at(177, 337)) // Drop clear of the other images.
  const detached = await savedAfter(page, (doc) => object(doc, 'caption').top === 324)
  expect(object(detached, 'caption')).not.toHaveProperty('captionOf')
  expect(object(detached, 'front')).toEqual(object(before, 'front'))
  await undoRedo(page, before, detached)
  await drag(page, at(280, 200), at(290, 220))
  const moved = await savedAfter(page, (doc) => object(doc, 'front').top === 170)
  expect(object(moved, 'caption')).toEqual(object(detached, 'caption'))
  await page.keyboard.press('Delete')
  const deleted = await savedAfter(page, (doc) => !object(doc, 'front'))
  expect(object(deleted, 'caption')).toEqual(object(detached, 'caption'))
})

test('a direct side resize detaches an attached caption without moving its image', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  await select(page, 'caption')
  await drag(page, at(362, 294), at(404, 294))
  const resized = await savedAfter(page, (doc) => object(doc, 'caption').width! > 175)
  expect(object(resized, 'caption')).not.toHaveProperty('captionOf')
  expect(object(resized, 'front')).toEqual(object(before, 'front'))
  await undoRedo(page, before, resized)
})

for (const action of ['scale', 'rotate'] as const) {
  test(`a direct caption ${action} detaches it and leaves its image alone`, async ({ page }) => {
    const before = await fixture(page)
    const at = await sceneToPage(page, before.viewport)
    await select(page, 'caption')
    if (action === 'scale') await drag(page, at(362, 309), at(415, 319))
    else await drag(page, at(285, 238), at(341, 294))
    const changed = await savedAfter(page, (doc) => !object(doc, 'caption').captionOf)
    if (action === 'scale') expect(object(changed, 'caption').fontSize!).toBeGreaterThan(28)
    else expect(object(changed, 'caption').angle).toBeGreaterThan(60)
    expect(object(changed, 'front')).toEqual(object(before, 'front'))
    await undoRedo(page, before, changed)
  })
}

test('dragging a frame with only its caption selected directly detaches the caption', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  await select(page, 'sleeve', 'caption')
  await drag(page, at(158, 76), at(193, 131))
  const moved = await savedAfter(page, (doc) => object(doc, 'front').top === 205)
  expect(object(moved, 'caption')).toEqual({ ...object(before, 'caption'), captionOf: undefined, left: 245, top: 335 })
  await undoRedo(page, before, moved)
})

test('a caption changes frames with its image even if its own centre is outside', async ({ page }) => {
  const before = await fixture(page, (doc) => doc.frames!.push({ id: 'next', name: 'Sleeve, side B', left: 770, top: 150, width: 220, height: 85 }))
  const at = await sceneToPage(page, before.viewport)
  await drag(page, at(280, 205), at(860, 205))
  const moved = await savedAfter(page, (doc) => object(doc, 'front').frameId === 'next')
  expectUnder(moved)
  expect(object(moved, 'caption').top).toBeGreaterThan(235)
  await select(page, 'next')
  await expect(page.getByTestId('frame-item-count')).toHaveText('2 items')
  await button(page, 'Select with contents').click()
  await expect(inspector(page).locator('.inspector-title')).toHaveText('3 objects')
  await undoRedo(page, before, moved)
})

test('shrinking a frame releases the image and its caption together, never the caption alone', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  await select(page, 'sleeve')
  await drag(page, at(445, 555), at(445, 260))
  const shrunk = await savedAfter(page, (doc) => doc.frames![0]!.height < 200)
  expect(object(shrunk, 'caption')).toEqual(object(before, 'caption'))
  expect(object(shrunk, 'front')).toEqual(object(before, 'front'))
  const bottom = shrunk.frames![0]!.top + shrunk.frames![0]!.height
  await drag(page, at(445, bottom), at(445, 194))
  const released = await savedAfter(page, (doc) => !object(doc, 'front').frameId)
  expectUnder(released)
  expect(object(released, 'caption')).not.toHaveProperty('frameId')
  expect(object(released, 'caption').top).toBe(280)
  await undoRedo(page, shrunk, released, false)
})

test('applied Crop, Fill, Fit and Replace settle with the caption in the same step', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  const captionInk = await ink(page, 210, 280)
  await select(page, 'front')
  await button(page, 'Crop image').click()
  await drag(page, at(360, 270), at(328, 220))
  await expect.poll(() => ink(page, 210, 280)).toEqual(captionInk)
  expect(await storedDoc(page)).toEqual(before)
  await page.keyboard.press('Escape')
  await expect(button(page, 'Undo')).toBeDisabled()
  await button(page, 'Crop image').click()
  await drag(page, at(360, 270), at(328, 220))
  await page.keyboard.press('Enter')
  const cropped = await savedAfter(page, (doc) => !!object(doc, 'front').crop)
  expectUnder(cropped)
  await undoRedo(page, before, cropped)
  await button(page, 'Fill image').click()
  const filled = await savedAfter(page, (doc) => (object(doc, 'front').crop?.y ?? 0) > 10)
  expectUnder(filled)
  await undoRedo(page, cropped, filled, false)
  await button(page, 'Fit image').click()
  const fitted = await savedAfter(page, (doc) => !object(doc, 'front').crop)
  expectUnder(fitted)
  await undoRedo(page, filled, fitted, false)
  const file = page.waitForEvent('filechooser')
  await button(page, 'Replace image').click()
  await (await file).setFiles(imageFile('New cover.png', 200, 250, 8))
  const replaced = await savedAfter(page, (doc) => object(doc, 'front').assetId !== 'front')
  expectUnder(replaced, 'front', 'caption', { width: 200, height: 250 })
  await undoRedo(page, fitted, replaced, false)
})

test('layout excludes a caption when its image is selected and detaches when laying out the caption directly', async ({ page }) => {
  const before = await fixture(page)
  await select(page, 'front', 'caption', 'back', 'detail')
  await button(page, 'Distribute horizontally').click()
  const spaced = await savedAfter(page, (doc) => object(doc, 'back').left !== 520)
  expect(object(spaced, 'front')).toEqual(object(before, 'front'))
  expect(object(spaced, 'caption')).toEqual(object(before, 'caption'))
  await undoRedo(page, before, spaced)
  await select(page, 'front', 'caption', 'back')
  await button(page, 'Align right edges').click()
  const aligned = await savedAfter(page, (doc) => object(doc, 'front').left !== 210)
  expectUnder(aligned)
  await expect(inspector(page).locator('.inspector-title')).toHaveText('3 objects')
  await undoRedo(page, spaced, aligned, false)
  await select(page, 'caption', 'notes')
  await button(page, 'Align right edges').click()
  const detached = await savedAfter(page, (doc) => !object(doc, 'caption').captionOf)
  expect(object(detached, 'front')).toEqual(object(aligned, 'front'))
  await undoRedo(page, aligned, detached, false)
})

test('deleting an image takes its caption in one undo step, and duplicating a frame copies the pair once', async ({ page }) => {
  const before = await fixture(page)
  await select(page, 'front')
  await page.keyboard.press('Delete')
  const deleted = await savedAfter(page, (doc) => !object(doc, 'front'))
  expect(object(deleted, 'caption')).toBeUndefined()
  await undoRedo(page, before, deleted)
  await button(page, 'Undo').click()
  await savedAfter(page, (doc) => !!object(doc, 'front'))
  await select(page, 'sleeve')
  await button(page, 'Duplicate').click()
  const duplicated = await savedAfter(page, (doc) => doc.frames?.length === 2)
  const copyFrame = duplicated.frames![1]!
  const copies = duplicated.objects.filter((item) => item.frameId === copyFrame.id)
  const image = copies.find((item) => item.assetId === 'front')!
  const captions = copies.filter((item) => item.captionOf === image.id)
  expect(copies).toHaveLength(9)
  expect(captions).toHaveLength(1)
  expectUnder(duplicated, image.id, captions[0]!.id)
  expect(image.left).toBe(234)
  expect(captions[0]!.top).toBe(304)
  await undoRedo(page, before, duplicated)
  await openApp(page)
  await select(page, image.id)
  await expect(button(page, 'Edit caption')).toBeVisible()
  expect(await storedDoc(page)).toEqual(duplicated)
})

test('keyboard activation, caption-only duplication, and Make and Detach caption controls', async ({ page }) => {
  const before = await fixture(page)
  await select(page, 'caption')
  await button(page, 'Duplicate').click()
  const duplicated = await savedAfter(page, (doc) => doc.objects.length === before.objects.length + 1)
  expect(duplicated.objects.at(-1)).not.toHaveProperty('captionOf')
  await undoRedo(page, before, duplicated)
  await select(page, 'front')
  await button(page, 'Detach caption').focus()
  await page.keyboard.press('Enter')
  const detached = await savedAfter(page, (doc) => !object(doc, 'caption').captionOf)
  expect(object(detached, 'caption')).toEqual({ ...object(before, 'caption'), captionOf: undefined })
  await undoRedo(page, duplicated, detached, false)
  await select(page, 'front', 'caption')
  await button(page, 'Make caption').click()
  const made = await savedAfter(page, (doc) => object(doc, 'caption').captionOf === 'front')
  expectUnder(made)
  await undoRedo(page, detached, made, false)
  await select(page, 'front')
  await button(page, 'Edit caption').focus()
  await page.keyboard.press('Enter')
  await expect(textarea(page)).toBeFocused()
  await page.keyboard.type(' A')
  await page.keyboard.press('Escape')
  const edited = await savedAfter(page, (doc) => object(doc, 'caption').text === 'Front sleeve A')
  expectUnder(edited)
  await undoRedo(page, made, edited, false)
})

test('image-only duplication copies its caption and selects just the new image', async ({ page }) => {
  const before = await fixture(page)
  await select(page, 'front')
  await page.keyboard.press('Control+d')
  const after = await savedAfter(page, (doc) => doc.objects.length === before.objects.length + 2)
  const [image, text] = after.objects.slice(-2)
  expect(image!.assetId).toBe('front')
  expectUnder(after, image!.id, text!.id)
  await expect(layer(page, image!.id)).toHaveAttribute('aria-selected', 'true')
  await expect(layer(page, text!.id)).toHaveAttribute('aria-selected', 'false')
  await undoRedo(page, before, after)
})

test('a locked caption still follows, and survives deletion detached at its last position', async ({ page }) => {
  const before = await fixture(page, (doc) => { object(doc, 'caption').locked = true })
  const at = await sceneToPage(page, before.viewport)
  await select(page, 'front')
  await expect(button(page, 'Edit caption')).toBeDisabled()
  await expect(button(page, 'Detach caption')).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(textarea(page)).toHaveCount(0)
  await drag(page, at(280, 205), at(305, 233))
  const moved = await savedAfter(page, (doc) => object(doc, 'front').top === 178)
  expectUnder(moved)
  await page.keyboard.press('Delete')
  const deleted = await savedAfter(page, (doc) => !object(doc, 'front'))
  expect(object(deleted, 'caption')).toEqual({ ...object(moved, 'caption'), captionOf: undefined })
  await undoRedo(page, moved, deleted, false)
})

const editExits = ['Esc', 'empty board click', 'object click', 'Shift-click', 'panel Detach caption'] as const
for (const exit of editExits) {
  for (const blank of [false, true]) {
    test(`leaves the first ${blank ? 'blank' : 'typed'} caption edit by ${exit}`, async ({ page }) => {
      const before = await fixture(page)
      const at = await sceneToPage(page, before.viewport)
      await select(page, 'back')
      if (blank) await button(page, 'Add caption').click()
      else await page.keyboard.press('Enter')
      await expect(textarea(page)).toBeFocused()
      if (!blank) await page.keyboard.type('Back sleeve\nPrinted in 1991')
      if (exit === 'Esc') await page.keyboard.press('Escape')
      if (exit === 'empty board click') await page.mouse.click(at(810, 350).x, at(810, 350).y)
      if (exit === 'object click') await page.mouse.click(at(280, 200).x, at(280, 200).y)
      if (exit === 'Shift-click') {
        await page.keyboard.down('Shift')
        await page.mouse.click(at(280, 200).x, at(280, 200).y)
        await page.keyboard.up('Shift')
      }
      if (exit === 'panel Detach caption') await button(page, 'Detach caption').click()
      await expect(textarea(page)).toHaveCount(0)
      if (blank) {
        await expect(button(page, 'Undo')).toBeDisabled()
        await select(page, 'back')
        await expect(button(page, 'Add caption')).toBeEnabled()
        expect(await storedDoc(page)).toEqual(before)
        return
      }
      const withCaption = await savedAfter(page, (doc) => doc.objects.length === before.objects.length + 1)
      const added = withCaption.objects.find((o) => !before.objects.some((old) => old.id === o.id))!
      expect(added.text).toBe('Back sleeve\nPrinted in 1991')
      expect(withCaption.objects.indexOf(added)).toBe(withCaption.objects.findIndex((o) => o.id === 'back') + 1)
      if (exit === 'panel Detach caption') {
        expect(added).not.toHaveProperty('captionOf')
        const attached = { ...withCaption, objects: withCaption.objects.map((o) => o === added ? { ...o, captionOf: 'back' } : o) }
        await undoRedo(page, attached, withCaption, false)
        await button(page, 'Undo').click()
        await savedAfter(page, (doc) => !!object(doc, added.id)?.captionOf)
        await button(page, 'Undo').click()
        await savedAfter(page, (doc) => !object(doc, added.id))
        return
      }
      expectUnder(withCaption, 'back', added.id, { width: 120, height: 100 })
      await undoRedo(page, before, withCaption)
    })
  }
}

test('a caption above its image grows upward while typing and preserves its side across undo and reload', async ({ page }) => {
  const before = await fixture(page, (doc) => Object.assign(object(doc, 'caption'), { top: 112.88, captionSide: 'top' }))
  await select(page, 'front')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter') // enters a newline in the caption
  await page.keyboard.type('Second line')
  const typed = await savedAfter(page, (doc) => object(doc, 'caption').text === 'Front sleeve\nSecond line')
  expect(object(typed, 'caption')).toMatchObject({ left: 210, width: 150, frameId: 'sleeve', captionSide: 'top' })
  expect(object(typed, 'caption').top).toBeLessThan(85)
  await page.keyboard.press('Escape')
  await undoRedo(page, before, typed)
  await openApp(page)
  await select(page, 'front')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(button(page, 'Undo')).toBeDisabled()
  expect(await storedDoc(page)).toEqual(typed)
  await select(page, 'caption')
  await button(page, 'H1 (Heading 1)').click()
  const formatted = await savedAfter(page, (doc) => object(doc, 'caption').headings?.[0] === 1)
  expect(object(formatted, 'caption').top).toBeLessThan(object(typed, 'caption').top)
  expect(object(formatted, 'caption')).toMatchObject({ captionOf: 'front', captionSide: 'top', frameId: 'sleeve' })
  await undoRedo(page, typed, formatted)
})

test('side captions keep their width and use the upright image edges after movement', async ({ page }) => {
  const before = await fixture(page, (doc) => {
    Object.assign(object(doc, 'caption'), { captionSide: 'right', left: 370, top: 150, width: 114 })
    doc.objects.push({ ...object(doc, 'caption'), id: 'left-caption', text: 'Back', captionOf: 'back', captionSide: 'left', left: 296, top: 154 })
  })
  const at = await sceneToPage(page, before.viewport)
  await drag(page, at(280, 208), at(300, 240))
  const moved = await savedAfter(page, (doc) => object(doc, 'front').top === 182)
  expect(object(moved, 'caption')).toMatchObject({ left: 390, top: 182, width: 114, captionSide: 'right' })
  expect(object(moved, 'left-caption')).toEqual(object(before, 'left-caption'))
  await drag(page, at(475, 230), at(475, 340))
  const both = await savedAfter(page, (doc) => object(doc, 'back').top === 264)
  expect(object(both, 'left-caption')).toMatchObject({ left: 296, top: 264, width: 114, captionSide: 'left' })
  await undoRedo(page, moved, both, false)
})

test('loading a stored placement displays it in place and leaves the row untouched', async ({ page }) => {
  const before = await fixture(page, (doc) => Object.assign(object(doc, 'caption'), { left: 790, top: 340, captionSide: 'top' }))
  const saved = await snapshotIdb(page)
  const at = await sceneToPage(page, before.viewport)
  await page.mouse.click(at(826, 354).x, at(826, 354).y)
  await expect(button(page, 'Detach caption')).toBeEnabled()
  await expect(button(page, 'Undo')).toBeDisabled()
  await page.waitForTimeout(650)
  expect(await snapshotIdb(page)).toEqual(saved)
})

test('a glyph wider than a tiny image can widen its caption, and deleting it shrinks the caption again', async ({ page }) => {
  const before = await fixture(page, (doc) => {
    Object.assign(object(doc, 'front'), { scaleX: 0.07, scaleY: 0.07 })
    doc.objects = doc.objects.filter((o) => o.id !== 'caption')
  })
  await select(page, 'front')
  await page.keyboard.press('Enter')
  await page.keyboard.type('W')
  const wide = await savedAfter(page, (doc) => doc.objects.length === before.objects.length + 1)
  const id = wide.objects.find((o) => o.captionOf === 'front')!.id
  expect(object(wide, id).width!).toBeGreaterThan(10.5)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('i')
  const narrow = await savedAfter(page, (doc) => object(doc, id)?.text === 'i')
  expectUnder(narrow, 'front', id)
  await page.keyboard.press('Escape')
  await undoRedo(page, before, narrow)
})

const interruptions = [
  { name: 'Esc during image scaling', start: [360, 270], end: [438, 332], selected: 'front', kind: 'escape' },
  { name: 'blur during image rotation', start: [285, 108], end: [386, 210], selected: 'front', kind: 'blur' },
  { name: 'a lost release during a caption drag', start: [267, 293], end: [307, 343], selected: 'caption', kind: 'lost' },
  { name: 'a lost release during image scaling', start: [360, 270], end: [438, 332], selected: 'front', kind: 'lost' },
  { name: 'a lost release during image rotation', start: [285, 108], end: [386, 210], selected: 'front', kind: 'lost' },
  { name: 'reload during an image drag', start: [280, 200], end: [325, 250], selected: 'front', kind: 'reload' },
] as const

for (const { name, start, end, selected, kind } of interruptions) {
  test(`${name} restores image and caption without an undo step`, async ({ page }) => {
    const before = await fixture(page)
    const at = await sceneToPage(page, before.viewport)
    const saved = await snapshotIdb(page)
    await select(page, selected)
    await drag(page, at(start[0], start[1]), at(end[0], end[1]), { hold: true })
    if (kind === 'escape') await page.keyboard.press('Escape')
    if (kind === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    if (kind === 'lost') await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 })))
    if (kind === 'reload') await openApp(page)
    await page.mouse.up()
    await expect(button(page, 'Undo')).toBeDisabled()
    expect(await snapshotIdb(page)).toEqual(saved)
    await select(page, 'front')
    await expect(button(page, 'Edit caption')).toBeEnabled()
    await drag(page, at(280, 200), at(285, 210))
    const next = await savedAfter(page, (doc) => object(doc, 'front').top === 160)
    expectUnder(next)
  })
}

test('a second mouse button does not settle the drag, a mid-drag save sees the base, and the import waits', async ({ page }) => {
  const before = await fixture(page)
  const at = await sceneToPage(page, before.viewport)
  await drag(page, at(280, 200), at(310, 250), { hold: true })
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  const title = page.getByRole('textbox', { name: 'Board title', exact: true })
  await title.fill('Album spread, retitled')
  await title.press('Enter')
  const mid = await savedAfter(page, (doc) => doc.title !== before.title)
  expect(mid.objects).toEqual(before.objects)
  await page.setInputFiles('input[type=file]', imageFile('Mid-gesture.png', 100, 70))
  await expect(page.getByText('Mid-gesture.png', { exact: true })).toHaveCount(0)
  await page.mouse.up()
  const after = await savedAfter(page, (doc) => doc.objects.length === before.objects.length + 1)
  expect(object(after, 'front').top).toBe(200)
  expectUnder(after)
  await button(page, 'Undo').click()
  const moved = await savedAfter(page, (doc) => doc.objects.length === before.objects.length)
  expect(object(moved, 'front')).toEqual(object(after, 'front'))
  expect(object(moved, 'caption')).toEqual(object(after, 'caption'))
  await undoRedo(page, before, moved)
})

test('loading and a stale tab guard Enter, and a conflict rolls back a held caption transform', async ({ context, page }) => {
  const before = await fixture(page, undefined, { open: false })
  await stallHydration(page)
  await page.goto('/')
  await page.keyboard.press('Enter')
  await expect(textarea(page)).toHaveCount(0)
  await releaseHydration(page)
  await expect(page.locator('.save-status')).toContainText('Saved on this device')
  const other = await context.newPage()
  await openApp(other)
  await page.bringToFront()
  const at = await sceneToPage(page, before.viewport)
  const pixels = await ink(page, 210, 280)
  await select(page, 'front', 'caption')
  await drag(page, at(285, 110), at(404, 229), { hold: true })
  await other.evaluate(async () => {
    const path = '/src/persistence/boardStore.ts'
    const { IndexedDbBoardStore } = await import(/* @vite-ignore */ path)
    const store = new IndexedDbBoardStore()
    const loaded = await store.load()
    await store.save({ ...loaded.doc, title: 'Saved in another tab' }, loaded.token, () => undefined)
  })
  const title = page.getByRole('textbox', { name: 'Board title', exact: true })
  await title.fill('Changed in stale tab')
  await title.press('Enter')
  await expect(page.getByTestId('readonly-banner')).toContainText('changed in another tab')
  await expect.poll(() => ink(page, 210, 280)).toEqual(pixels)
  await page.mouse.up()
  await page.keyboard.press('Enter')
  await expect(textarea(page)).toHaveCount(0)
  await expect(button(page, 'Undo')).toBeDisabled()
  expect(await storedDoc(page)).toEqual({ ...before, title: 'Saved in another tab' })
})
