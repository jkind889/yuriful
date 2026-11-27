import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { SnapSide } from '../src/model/captionSnap.ts'
import { albumLayer, openAlbumFeel, readFeedback } from './feel-helpers.ts'
import { drag, editedText, openApp, redoButton, screenPixel, snapshotIdb, storedDoc, undoButton } from './helpers.ts'
import type { StoredBoard, StoredObject } from './helpers.ts'

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const title = (page: Page) => page.getByRole('textbox', { name: 'Board title' })
/** The text being edited while it has the keyboard, or null. */
const focusedEdit = async (page: Page) => {
  const edit = await editedText(page)
  return edit?.focused ? edit.value : null
}
const find = (doc: StoredBoard, id = 'caption') => doc.objects.find((obj) => obj.id === id)!
const heldSnap = async (page: Page) => (await readFeedback(page)).snap
const SOURCE = { left: 800, top: 520, width: 120, minHeight: 48, text: 'Proofs' }

function freeCaption(doc: StoredBoard) {
  const caption = find(doc)
  Object.assign(caption, SOURCE)
  delete caption.captionOf
}

function fixture(page: Page, options: { snap?: boolean; feedback?: boolean; change?: (doc: StoredBoard) => void } = {}) {
  return openAlbumFeel(page, (doc) => {
    freeCaption(doc)
    options.change?.(doc)
  }, { captionSnap: options.snap ?? true, feedback: options.feedback ?? true })
}

type At = Awaited<ReturnType<typeof fixture>>['at']
const landing: Record<SnapSide, [number, number]> = { under: [242, 280], top: [242, 90], left: [78, 180], right: [370, 180] }

function holdAt(page: Page, at: At, left: number, top: number) {
  return drag(page, at(SOURCE.left + 30, SOURCE.top + 12), at(left + 30, top + 12), { hold: true })
}

async function storedCaption(page: Page, imageId: string, id = 'caption') {
  await expect.poll(async () => find(await storedDoc(page), id)?.captionOf).toBe(imageId)
  return find(await storedDoc(page), id)
}

function expectSide(caption: StoredObject, side: SnapSide) {
  if (side === 'under') expect(caption).not.toHaveProperty('captionSide')
  else expect(caption.captionSide).toBe(side)
}

async function expectCanonical(page: Page, side: SnapSide, id = 'caption', imageId = 'front') {
  const doc = await storedDoc(page)
  const image = find(doc, imageId)
  const caption = find(doc, id)
  const bounds = await page.evaluate(({ id, imageId }) => ({ caption: window.__feel.bounds(id)!, image: window.__feel.bounds(imageId)! }), { id, imageId })
  const gap = Math.round(caption.fontSize! * 0.4)
  expect(caption.frameId).toBe(image.frameId)
  expect(caption.angle).toBe(0)
  expectSide(caption, side)
  if (side === 'left' || side === 'right') {
    expect((bounds.caption.top + bounds.caption.bottom) / 2).toBeCloseTo(bounds.image.top + caption.captionPosition! * (bounds.image.bottom - bounds.image.top), 2)
    if (side === 'left') expect(bounds.caption.right + gap).toBeCloseTo(bounds.image.left, 2)
    else expect(caption.left).toBeCloseTo(bounds.image.right + gap, 2)
  } else {
    expect((bounds.caption.left + bounds.caption.right) / 2).toBeCloseTo(bounds.image.left + caption.captionPosition! * (bounds.image.right - bounds.image.left), 2)
    if (side === 'top') expect(bounds.caption.bottom + gap).toBeCloseTo(bounds.image.top, 2)
    else expect(caption.top).toBeCloseTo(bounds.image.bottom + gap, 2)
  }
}

for (const [label, prefs] of [
  ['no preferences', {}],
  ['an older preference without captionSnap', { feedback: false }],
] as const) {
  test(`caption snapping works by default with ${label}`, async ({ page }) => {
    const { at } = await openAlbumFeel(page, freeCaption, prefs)
    const readPrefs = () => page.evaluate(() => localStorage.getItem('yuriful.prefs.v1'))
    const originalPrefs = Object.keys(prefs).length ? JSON.stringify(prefs) : null
    expect(await readPrefs()).toBe(originalPrefs)
    await button(page, 'Canvas options').click()
    await expect(page.getByRole('checkbox', { name: 'Snap captions to images' })).toBeChecked()
    await button(page, 'Canvas options').click()
    await holdAt(page, at, ...landing.under)
    expect(await heldSnap(page)).toMatchObject({ imageId: 'front', side: 'under' })
    await page.mouse.up()
    await storedCaption(page, 'front')
    expect(await readPrefs()).toBe(originalPrefs)
  })
}

test('caption snapping honors a saved OFF and a near drop stays ordinary text', async ({ page }) => {
  const { at } = await openAlbumFeel(page, freeCaption, { feedback: false, captionSnap: false })
  await button(page, 'Canvas options').click()
  await expect(page.getByRole('checkbox', { name: 'Snap captions to images' })).not.toBeChecked()
  await button(page, 'Canvas options').click()
  await holdAt(page, at, ...landing.under)
  expect(await heldSnap(page)).toBeNull()
  await page.mouse.up()
  await expect.poll(async () => find(await storedDoc(page)).left).toBe(242)
  expect(find(await storedDoc(page)).captionOf).toBeUndefined()
})

for (const side of ['under', 'top', 'left', 'right'] as const) {
  test(`previews and saves an off-center ${side} caption`, async ({ page }) => {
    const { at, before } = await fixture(page, { feedback: side !== 'left' })
    await holdAt(page, at, ...landing[side])
    const preview = await heldSnap(page)
    expect(preview).toMatchObject({ side, imageId: 'front', textId: 'caption' })
    if (side === 'left') expect((await readFeedback(page)).lifted).toEqual([])
    expect(await storedDoc(page)).toEqual(before)
    await page.mouse.up()
    const saved = await storedCaption(page, 'front')
    expectSide(saved, side)
    expect(saved.captionPosition).toBeDefined()
    expect(saved.captionPosition).not.toBe(0.5)
    expect(saved.left).toBe(preview!.box.left)
    expect(saved.top).toBe(preview!.box.top)
    expect(saved.width).toBeCloseTo(preview!.box.right - preview!.box.left, 2)
    expect(await heldSnap(page)).toBeNull()
    await expectCanonical(page, side)
  })

  test(`typing, formatting and font size keep an attached ${side} caption flush`, async ({ page }) => {
    const { at } = await fixture(page)
    await holdAt(page, at, ...landing[side])
    await page.mouse.up()
    await storedCaption(page, 'front')
    await albumLayer(page, 'front').click()
    await page.keyboard.press('Enter')
    await expect.poll(() => focusedEdit(page)).toBe('Proofs')
    await page.keyboard.type(' with more words to wrap and measure the placement again')
    await expect.poll(async () => find(await storedDoc(page)).text).toContain('again')
    await expectCanonical(page, side)
    await button(page, 'H1 (Heading 1)').click()
    await expect.poll(() => focusedEdit(page)).not.toBeNull()
    await expect.poll(async () => find(await storedDoc(page)).headings?.[0]).toBe(1)
    await expectCanonical(page, side)
    await page.keyboard.press('Escape')
    const size = page.getByRole('spinbutton', { name: 'Font size' })
    await size.fill('36')
    await size.press('Enter')
    await expect.poll(async () => find(await storedDoc(page)).fontSize).toBe(36)
    await expectCanonical(page, side)
  })
}

for (const modifier of ['Control', 'Meta'] as const) {
  test(`${modifier} on primary release suppresses an already visible caption preview`, async ({ page }) => {
    const { at } = await fixture(page)
    await holdAt(page, at, ...landing.right)
    expect((await heldSnap(page))?.side).toBe('right')
    await page.keyboard.down(modifier)
    await page.mouse.up()
    await page.keyboard.up(modifier)
    await expect.poll(async () => find(await storedDoc(page)).left).toBe(370)
    expect(find(await storedDoc(page)).captionOf).toBeUndefined()
    expect(await heldSnap(page)).toBeNull()
  })
}

test('a modifier hides the caption preview while moving and the next unmodified move brings it back', async ({ page }) => {
  const { at } = await fixture(page)
  await holdAt(page, at, ...landing.under)
  expect((await heldSnap(page))?.side).toBe('under')
  await page.keyboard.down('Control')
  const point = at(258, 292)
  await page.mouse.move(point.x, point.y)
  expect(await heldSnap(page)).toBeNull()
  await page.keyboard.up('Control')
  await page.mouse.move(point.x + 2, point.y)
  expect((await heldSnap(page))?.side).toBe('under')
  await page.mouse.up()
  await storedCaption(page, 'front')
})

for (const kind of ['multi-selection', 'locked image', 'already-captioned image', 'rotated text'] as const) {
  test(`${kind} keeps a near drop from snapping`, async ({ page }) => {
    const { at } = await fixture(page, { change(doc) {
      if (kind === 'locked image') find(doc, 'front').locked = true
      if (kind === 'already-captioned image') {
        const notes = find(doc, 'notes')
        notes.captionOf = 'front'
        Object.assign(notes, { left: 210, top: 280, width: 150 })
      }
      if (kind === 'rotated text') find(doc).angle = 10
    } })
    if (kind === 'multi-selection') {
      await albumLayer(page, 'caption').click()
      await albumLayer(page, 'notes').click({ modifiers: ['Shift'] })
    }
    await holdAt(page, at, ...(kind === 'already-captioned image' ? landing.right : landing.under))
    expect(await heldSnap(page)).toBeNull()
    await page.mouse.up()
    await expect.poll(async () => find(await storedDoc(page)).left).not.toBe(SOURCE.left)
    expect(find(await storedDoc(page)).captionOf).toBeUndefined()
  })
}

test('a small nudge re-attaches a legacy caption and stores its new position', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page, undefined, { captionSnap: true })
  await drag(page, at(267, 293), at(270, 300), { hold: true })
  expect(await heldSnap(page)).toMatchObject({ side: 'under', imageId: 'front' })
  await page.mouse.up()
  await expect.poll(async () => find(await storedDoc(page)).captionPosition).toBeGreaterThan(0.5)
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(before.objects)

  await drag(page, at(267, 293), at(267, 125), { hold: true })
  expect(await heldSnap(page)).toMatchObject({ side: 'top', imageId: 'front' })
  await page.mouse.up()
  await expect.poll(async () => find(await storedDoc(page)).captionSide).toBe('top')
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(before.objects)
})

test('an upright text stored at 360 degrees can preview and snap', async ({ page }) => {
  const { at, before } = await fixture(page, { change(doc) { find(doc).angle = 360 } })
  expect(find(before).angle).toBe(360)
  await holdAt(page, at, ...landing.top)
  expect(await heldSnap(page)).toMatchObject({ side: 'top', imageId: 'front' })
  await page.mouse.up()
  expect(await storedCaption(page, 'front')).toMatchObject({ captionSide: 'top', angle: 0 })
  await expectCanonical(page, 'top')
})

test('the gaining frame follows the snapped image even when the text box is outside it', async ({ page }) => {
  const { at } = await fixture(page, { change(doc) { delete find(doc).frameId } })
  await holdAt(page, at, ...landing.left)
  expect((await heldSnap(page))?.side).toBe('left')
  expect((await readFeedback(page)).gaining).toEqual(['sleeve'])
  await page.mouse.up()
  expect((await storedCaption(page, 'front')).frameId).toBe('sleeve')
})

test('moving a caption to another image transfers it and restores the old attachment with one undo', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page, undefined, { captionSnap: true })
  // The rotated back cover's displayed left and bottom edges are x=420 and y=274.
  await drag(page, at(267, 293), at(487, 297), { hold: true })
  expect(await heldSnap(page)).toMatchObject({ side: 'under', imageId: 'back' })
  await page.mouse.up()
  await storedCaption(page, 'back')
  expect((await storedDoc(page)).objects.filter((o) => o.captionOf === 'front')).toEqual([])
  await expectCanonical(page, 'under', 'caption', 'back')
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(before.objects)
  await expect(undoButton(page)).toBeDisabled()
})

test('a top snap is one undo step and its side survives redo, reload, duplicate and delete undo', async ({ page }) => {
  const { at, before } = await fixture(page, { change(doc) { delete find(doc).minHeight } })
  // A legacy click-created text is about 27 px tall before it becomes a drawn caption.
  await holdAt(page, at, 225, 112)
  expect((await heldSnap(page))?.side).toBe('top')
  await page.mouse.up()
  const snapped = await storedCaption(page, 'front')
  expect(snapped).toMatchObject({ captionSide: 'top', minHeight: 0 })
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual(before.objects)
  await expect(undoButton(page)).toBeDisabled()
  await redoButton(page).click()
  await expect.poll(async () => find(await storedDoc(page))).toEqual(snapped)
  await openApp(page)
  expect(find(await storedDoc(page))).toEqual(snapped)
  await albumLayer(page, 'front').click()
  await page.keyboard.press('Enter')
  await expect.poll(() => focusedEdit(page)).toBe('Proofs')
  await page.keyboard.press('Escape')
  await albumLayer(page, 'front').click()
  await page.keyboard.press('Control+d')
  await expect.poll(async () => (await storedDoc(page)).objects.filter((obj) => obj.captionSide === 'top').length).toBe(2)
  const copy = (await storedDoc(page)).objects.find((obj) => obj.captionSide === 'top' && obj.id !== 'caption')!
  expect(copy.captionOf).toBeDefined()
  await albumLayer(page, copy.captionOf!).click()
  await page.keyboard.press('Delete')
  await expect.poll(async () => find(await storedDoc(page), copy.id)).toBeUndefined()
  await undoButton(page).click()
  await expect.poll(async () => find(await storedDoc(page), copy.id)).toEqual(copy)
})

for (const interruption of ['Esc', 'blur', 'lost release'] as const) {
  test(`${interruption} clears the caption preview and restores the scene`, async ({ page }) => {
    const { at, before } = await fixture(page)
    const original = await snapshotIdb(page)
    await holdAt(page, at, ...landing.left)
    expect((await heldSnap(page))?.side).toBe('left')
    if (interruption === 'Esc') await page.keyboard.press('Escape')
    if (interruption === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    if (interruption === 'lost release') {
      await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 })))
    }
    expect(await heldSnap(page)).toBeNull()
    expect(await page.evaluate(() => window.__feel.scene().objects)).toEqual(before.objects)
    await page.mouse.up()
    await expect(undoButton(page)).toBeDisabled()
    expect(await snapshotIdb(page)).toEqual(original)
  })
}

test('during a caption preview autosave stores the old scene and a later conflicting save cancels', async ({ page }) => {
  const { at, before } = await fixture(page)
  await holdAt(page, at, ...landing.right)
  expect((await heldSnap(page))?.side).toBe('right')
  await title(page).fill('Save while snapping')
  await title(page).press('Enter')
  await expect.poll(async () => (await storedDoc(page)).title).toBe('Save while snapping')
  expect((await storedDoc(page)).objects).toEqual(before.objects)
  expect((await heldSnap(page))?.side).toBe('right')
  await page.evaluate(async () => {
    const path = '/src/persistence/boardStore.ts'
    const { IndexedDbBoardStore } = await import(/* @vite-ignore */ path) as typeof import('../src/persistence/boardStore.ts')
    const writer = new IndexedDbBoardStore()
    const stored = (await writer.load())!
    await writer.save({ ...stored.doc, title: 'Another writer' }, stored.token, (id) => stored.assets.get(id))
  })
  await title(page).fill('Stale edit')
  await title(page).press('Enter')
  await expect(page.getByTestId('readonly-banner')).toBeVisible()
  expect(await heldSnap(page)).toBeNull()
  expect(await page.evaluate(() => window.__feel.scene().objects)).toEqual(before.objects)
  await page.mouse.up()
  expect((await storedDoc(page)).title).toBe('Another writer')
})

test('the menu stays closed mid-gesture and a forced preference change clears the preview', async ({ page }) => {
  const { at } = await fixture(page)
  await holdAt(page, at, ...landing.right)
  expect((await heldSnap(page))?.side).toBe('right')
  await button(page, 'Canvas options').focus()
  await page.keyboard.press('Enter')
  await expect(button(page, 'Canvas options')).toHaveAttribute('aria-expanded', 'false')
  await page.evaluate(async () => {
    const path = '/src/persistence/prefsStore.ts'
    const { canvasPrefs } = await import(/* @vite-ignore */ path) as typeof import('../src/persistence/prefsStore.ts')
    canvasPrefs.set('captionSnap', false)
  })
  expect(await heldSnap(page)).toBeNull()
  await page.mouse.up()
  await expect.poll(async () => find(await storedDoc(page)).left).toBe(370)
  expect(find(await storedDoc(page)).captionOf).toBeUndefined()
})

test('zoomed placement keeps the right-edge preview and the released position together', async ({ page }) => {
  const { at } = await fixture(page, { change: (doc) => {
    doc.viewport = { zoom: 0.75, panX: 90, panY: 30 }
  } })
  await holdAt(page, at, ...landing.right)
  const preview = await heldSnap(page)
  expect(preview).toMatchObject({ side: 'right', imageId: 'front' })
  await page.mouse.up()
  const saved = await storedCaption(page, 'front')
  expect(saved.captionPosition).toBe(preview!.position)
  expect(saved.left).toBe(preview!.box.left)
  expect(saved.top).toBe(preview!.box.top)
})

const RED = '#b52d42'

function lifecycleBoard(page: Page, zoom: number, framed = true, styled = true) {
  return openAlbumFeel(page, (doc) => {
    const image = find(doc, 'front')
    const caption = find(doc)
    Object.assign(image, { left: 230, top: 125 })
    Object.assign(caption, { left: 261, top: 255, width: 88, minHeight: 48, text: 'Proof' })
    if (styled) caption.captionBackground = RED
    if (framed) Object.assign(doc.frames![0]!, { name: 'Frame 3', left: 60, top: 30, width: 450, height: 325 })
    else {
      delete image.frameId
      delete caption.frameId
      doc.version = 1
      delete doc.frames
    }
    doc.objects = [image, caption]
    doc.viewport = { zoom, panX: 0, panY: 10 }
  }, { captionSnap: true })
}

async function dragCaption(page: Page, at: At, left: number, top: number, hold = false) {
  const bounds = await page.evaluate(() => window.__feel.bounds('caption')!)
  await drag(page, at(bounds.left + 19, bounds.top + 14), at(left + 19, top + 14), { hold })
}

/** The pixel the page shows just inside the caption's bottom-left corner. */
async function captionBackgroundPixel(page: Page) {
  const { x, y } = await page.evaluate(() => {
    const rect = window.__feel.bounds('caption')!
    const { zoom, panX, panY } = window.__feel.viewport()
    return { x: Math.floor((rect.left + 5) * zoom + panX), y: Math.floor((rect.bottom - 5) * zoom + panY) }
  })
  return screenPixel(page, x, y)
}

for (const zoom of [1.15, 2]) {
  for (const side of ['under', 'top', 'left', 'right'] as const) {
    test(`a detached caption reattaches off-center at the visible ${side} gap at ${Math.round(zoom * 100)}%`, async ({ page }) => {
      const { at } = await lifecycleBoard(page, zoom)
      await albumLayer(page, 'caption').click()
      if (side === 'under') await dragCaption(page, at, 111, 286)
      else await button(page, 'Detach caption').click()
      await expect.poll(async () => find(await storedDoc(page))).not.toHaveProperty('captionOf')

      // At 115%, being four canvas units outside the normal gap is outside the physical-edge band.
      const gap = zoom === 1.15 ? 14 : 10
      const target = {
        under: [294, 245 + gap], top: [294, 125 - gap - 48],
        left: [230 - gap - 88, 130], right: [380 + gap, 130],
      }[side] as [number, number]
      await dragCaption(page, at, ...target, true)
      const preview = await heldSnap(page)
      expect(preview).toMatchObject({ side, imageId: 'front' })
      const horizontal = side === 'under' || side === 'top'
      const offsetError = Math.abs(preview!.position * (horizontal ? 150 : 120) - (horizontal ? 108 : 29))
      expect(offsetError * zoom).toBeLessThanOrEqual(1.5) // Browser pointer coordinates are rounded to pixels.
      await page.mouse.up()
      const saved = await storedCaption(page, 'front')
      expect(saved).toMatchObject({ captionBackground: RED, frameId: 'sleeve', captionPosition: preview!.position })
      expect(saved.left).toBe(preview!.box.left)
      expect(saved.top).toBe(preview!.box.top)
      await expectCanonical(page, side)
    })
  }
}

for (const method of ['button', 'drag away'] as const) {
  test(`${method} detach preserves editable color without following the former image`, async ({ page }) => {
    const { at } = await lifecycleBoard(page, 1.15)
    await albumLayer(page, 'caption').click()
    if (method === 'button') await button(page, 'Detach caption').click()
    else await dragCaption(page, at, 105, 275)
    await expect.poll(async () => find(await storedDoc(page))).not.toHaveProperty('captionOf')
    const detached = find(await storedDoc(page))
    expect(detached).toHaveProperty('captionBackground', RED)
    await undoButton(page).click()
    expect(await storedCaption(page, 'front')).toHaveProperty('captionBackground', RED)
    await redoButton(page).click()
    await expect.poll(async () => find(await storedDoc(page))).toEqual(detached)

    await dragCaption(page, at, 111, 286)
    await expect.poll(async () => Math.abs(find(await storedDoc(page)).top - 286)).toBeLessThan(1)
    const moved = find(await storedDoc(page))
    expect(moved).toMatchObject({ captionBackground: RED, frameId: 'sleeve' })
    await expect.poll(() => captionBackgroundPixel(page)).toEqual([181, 45, 66, 255])

    await undoButton(page).click()
    await expect.poll(async () => find(await storedDoc(page))).toEqual(detached)
    await redoButton(page).click()
    await expect.poll(async () => find(await storedDoc(page))).toEqual(moved)

    await openApp(page)
    await expect.poll(() => captionBackgroundPixel(page)).toEqual([181, 45, 66, 255])
    await drag(page, at(290, 155), at(309, 171))
    await expect.poll(async () => Math.abs(find(await storedDoc(page), 'front').left - 249)).toBeLessThan(1)
    expect(find(await storedDoc(page))).toEqual(moved)
    await button(page, 'Canvas options').click()
    const snapToggle = page.getByRole('checkbox', { name: 'Snap captions to images' })
    await snapToggle.uncheck()
    await snapToggle.check()
    await button(page, 'Canvas options').click()
    expect(find(await storedDoc(page))).toEqual(moved)
    await albumLayer(page, 'caption').click()
    const color = page.getByLabel('Caption background color')
    const background = page.getByRole('checkbox', { name: 'Caption background' })
    await expect(color).toHaveValue(RED)
    await color.fill('#5574ab')
    await expect.poll(async () => find(await storedDoc(page)).captionBackground).toBe('#5574ab')
    await background.click()
    await expect.poll(async () => find(await storedDoc(page))).not.toHaveProperty('captionBackground')
    expect(find(await storedDoc(page))).not.toHaveProperty('captionOf')
    await expect(background).toHaveCount(0)
  })
}

const centered: ReadonlyArray<readonly [SnapSide, number, number, number]> = [
  ['under', 1.6, 261, 255], ['top', 2.4, 261, 67], ['left', 1, 132, 161], ['right', 0.8, 390, 161],
]
for (const [side, zoom, left, top] of centered) {
  test(`unstyled text on a frameless board reattaches at the centered ${side} gap at ${zoom * 100}%`, async ({ page }) => {
    const { at } = await lifecycleBoard(page, zoom, false, false)
    await albumLayer(page, 'caption').click()
    await button(page, 'Detach caption').click()
    await expect.poll(async () => find(await storedDoc(page))).not.toHaveProperty('captionOf')
    await expect(page.getByRole('checkbox', { name: 'Caption background' })).toHaveCount(0)
    // Move away first so the centered under case is a real drag, too.
    await dragCaption(page, at, 106, 255)
    await dragCaption(page, at, left, top)
    const caption = await storedCaption(page, 'front')
    expectSide(caption, side)
    expect(caption.captionPosition).toBeCloseTo(0.5, 1)
    expect(caption).not.toHaveProperty('captionBackground')
    expect(caption).not.toHaveProperty('frameId')
  })
}

test('an off-center snap moves and resizes with its image, and its background is reversible', async ({ page }) => {
  const { at } = await fixture(page)
  await holdAt(page, at, ...landing.under)
  await page.mouse.up()
  const attached = await storedCaption(page, 'front')
  await drag(page, at(268, 202), at(285, 222))
  await expect.poll(async () => find(await storedDoc(page), 'front').left).not.toBe(210)
  expect(find(await storedDoc(page)).captionPosition).toBe(attached.captionPosition)
  await expectCanonical(page, 'under')

  await albumLayer(page, 'front').click()
  const corner = await page.evaluate(() => window.__feel.controls()!.br!)
  const host = (await page.locator('.canvas-host').boundingBox())!
  const from = { x: host.x + corner.x, y: host.y + corner.y }
  await drag(page, from, { x: from.x + 48, y: from.y + 35 }, { hold: true })
  const resizing = await page.evaluate(() => ({
    caption: window.__feel.bounds('caption')!,
    image: window.__feel.bounds('front')!,
  }))
  expect((resizing.caption.left + resizing.caption.right) / 2)
    .toBeCloseTo(resizing.image.left + attached.captionPosition! * (resizing.image.right - resizing.image.left), 1)
  await page.mouse.up()
  await expect.poll(async () => find(await storedDoc(page), 'front').scaleX).not.toBe(1)
  await expectCanonical(page, 'under')

  const background = page.getByRole('checkbox', { name: 'Caption background' })
  const color = page.getByLabel('Caption background color')
  const pixel = () => captionBackgroundPixel(page)
  await expect(background).not.toBeChecked()
  await expect(color).toHaveCount(0)
  const blank = await pixel()
  await background.check()
  await color.fill('#ad4278')
  await expect.poll(async () => find(await storedDoc(page)).captionBackground).toBe('#ad4278')
  await expect.poll(pixel).toEqual([173, 66, 120, 255])
  await background.uncheck()
  await expect.poll(async () => find(await storedDoc(page))).not.toHaveProperty('captionBackground')
  await expect.poll(pixel).toEqual(blank)
  await undoButton(page).click()
  await expect.poll(async () => find(await storedDoc(page)).captionBackground).toBe('#ad4278')
  await redoButton(page).click()
  await expect.poll(async () => find(await storedDoc(page))).not.toHaveProperty('captionBackground')
  const saved = find(await storedDoc(page))
  await openApp(page)
  await albumLayer(page, 'front').click()
  expect(find(await storedDoc(page))).toEqual(saved)
  await expect(background).not.toBeChecked()
  await expect(color).toHaveCount(0)
})
