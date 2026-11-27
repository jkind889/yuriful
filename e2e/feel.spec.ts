import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { CENTRE, FRAME, FRONT, IMAGE, NO_FEEDBACK, VIEW, albumLayer, canvasBox, fileDrag, openAlbumFeel, openFeel, readFeedback, readView, sampleViewTwice } from './feel-helpers.ts'
import type { StoredBoard, View } from './helpers.ts'
import { AUTOSAVE_QUIET_MS, drag, imageFile, openApp, openBlank, redoButton, seedMilestone1, snapshotIdb, storedDoc, undoButton, waitSaved } from './helpers.ts'

test('Canvas options works by keyboard and persists independently of the board', async ({ page }) => {
  await openBlank(page)
  await seedMilestone1(page, { version: 1, title: 'Canvas options', viewport: { zoom: 1, panX: 0, panY: 0 }, objects: [] })
  await openApp(page)
  const before = await snapshotIdb(page)
  const trigger = page.getByRole('button', { name: 'Canvas options', exact: true })
  await page.getByRole('button', { name: 'Appearance', exact: true }).press('Tab')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  const feedback = page.getByRole('checkbox', { name: 'Interaction feedback' })
  const snap = page.getByRole('checkbox', { name: 'Snap captions to images' })
  await expect(feedback).toBeChecked()
  await expect(snap).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(feedback).toBeFocused()
  await page.keyboard.press('Space')
  await expect(feedback).not.toBeChecked()
  await page.keyboard.press('Tab')
  await expect(snap).toBeFocused()
  await page.keyboard.press('Space')
  await expect(snap).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect(feedback).toHaveCount(0)
  expect(await snapshotIdb(page)).toEqual(before)

  await page.reload()
  await expect(page.locator('.toolbar')).toBeVisible()
  await page.getByRole('button', { name: 'Appearance', exact: true }).press('Tab')
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Space')
  await expect(feedback).not.toBeChecked()
  await expect(snap).not.toBeChecked()
  expect(await snapshotIdb(page)).toEqual(before)
})

test('gain and loss outlines match the frame membership stored after release', async ({ page }) => {
  const at = await openFeel(page)
  const start = at(CENTRE.x, CENTRE.y)
  await drag(page, start, at(515, 280), { hold: true }) // overlap: the Back owner stays sticky
  expect(await readFeedback(page)).toMatchObject({ gaining: [], losing: [] })
  const end = at(670, 280)
  await page.mouse.move(end.x, end.y)
  const shown = await readFeedback(page)
  expect(shown).toMatchObject({ gaining: [FRONT.id], losing: [FRAME.id] })
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[0]?.frameId).toBe(shown.gaining[0])
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
})

test('a dragged frame outlines the members it carries, including locked members, and leaves loose images behind', async ({ page }) => {
  const locked = { ...IMAGE, id: 'locked', top: 345, locked: true }
  const loose = { ...IMAGE, id: 'loose', left: 420, top: 370, frameId: undefined }
  const at = await openFeel(page, { objects: [IMAGE, locked, loose] })
  await drag(page, at(220, 145), at(345, 170), { hold: true })
  expect(await readFeedback(page)).toMatchObject({ carried: [IMAGE.id, locked.id], lifted: [], gaining: [], losing: [] })
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects.map((o) => o.left)).toEqual([425, 425, 420])
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
})

test('a frame being resized previews a member it will release', async ({ page }) => {
  const at = await openFeel(page, { frames: [FRAME] })
  const label = at(238, 145)
  await page.mouse.click(label.x, label.y)
  await drag(page, at(540, 480), at(310, 420), { hold: true })
  expect(await readFeedback(page)).toMatchObject({ losing: [FRAME.id], gaining: [], carried: [], lifted: [] })
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).frames?.[0]?.width).toBe(110)
  expect((await storedDoc(page)).objects[0]?.frameId).toBeUndefined()
})

test('a resize below the frame minimum previews the clamped outcome', async ({ page }) => {
  const at = await openFeel(page, { frames: [FRAME], objects: [{ ...IMAGE, left: 170 }] })
  const label = at(220, 145)
  await page.mouse.click(label.x, label.y)
  await drag(page, at(540, 480), at(210, 420), { hold: true })
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).frames?.[0]?.width).toBe(24)
  expect((await storedDoc(page)).objects[0]?.frameId).toBe(FRAME.id)
})

test('scaling and rotating content preview the frames the changed boxes will join', async ({ page }) => {
  const rotated = { ...IMAGE, id: 'rotate', left: 730, top: 360, frameId: undefined }
  const at = await openFeel(page, { frames: [FRONT], objects: [{ ...IMAGE, left: 410, frameId: undefined }, rotated] })
  const image = at(460, 280)
  await page.mouse.click(image.x, image.y)
  await drag(page, at(510, 310), at(660, 400), { hold: true })
  const gainOnScale = (await readFeedback(page)).gaining
  expect(gainOnScale).toEqual([FRONT.id])
  expect((await readFeedback(page)).lifted).toEqual([])
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[0]?.frameId).toBe(gainOnScale[0])

  const body = at(780, 390)
  await page.mouse.click(body.x, body.y)
  const control = await page.evaluate(() => window.__feel.controls()?.mtr)
  expect(control).toBeDefined()
  const rotate = at(control!.x, control!.y)
  await drag(page, rotate, { x: rotate.x + 70, y: rotate.y + 40 }, { hold: true })
  const gainOnRotate = (await readFeedback(page)).gaining
  expect(gainOnRotate).toEqual([FRONT.id])
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[1]?.frameId).toBe(gainOnRotate[0])
})

test('a file marker tracks the first image centre and clears on leave, drop, drag end, blur and Esc', async ({ page }) => {
  const at = await openFeel(page)
  const point = at(650, 330)
  const show = async () => {
    await fileDrag(page, 'dragenter', at(420, 330))
    await fileDrag(page, 'dragover', point)
    expect((await readFeedback(page)).drop).toEqual({ point: { x: 650, y: 330 }, frameId: FRONT.id })
  }
  await show()
  await fileDrag(page, 'dragleave', point)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await show()
  await fileDrag(page, 'dragleave', point, true)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await show()
  await fileDrag(page, 'dragend', point)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await show()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await show()
  await page.keyboard.press('Escape')
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await show()
  await fileDrag(page, 'drop', point)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await expect.poll(async () => (await storedDoc(page)).objects.length).toBe(2)
  const imported = (await storedDoc(page)).objects[1]!
  expect(imported.frameId).toBe(FRONT.id)
  expect(imported.left + 40 * imported.scaleX!).toBe(650)
  expect(imported.top + 20 * imported.scaleY!).toBe(330)
})

test('lift is visible on the live canvas and absent from records, saves and undo history', async ({ page }) => {
  const at = await openFeel(page)
  const start = at(CENTRE.x, CENTRE.y)
  const end = at(670, 280)
  const moved = async () => {
    await drag(page, start, end, { hold: true })
    expect((await readFeedback(page)).lifted).toEqual([IMAGE.id])
    expect(await page.evaluate(() => window.__feel.shadows())).toContain(true)
    expect(await page.evaluate(() => window.__feel.scene().objects[0])).toEqual({ ...IMAGE, left: 620 })
  }
  await page.getByRole('textbox', { name: 'Board title' }).fill('Save during lift')
  await page.getByRole('textbox', { name: 'Board title' }).press('Enter')
  await moved()
  await expect.poll(async () => (await storedDoc(page)).title).toBe('Save during lift')
  expect((await storedDoc(page)).objects).toEqual([IMAGE])
  expect(await page.evaluate(() => window.__feel.history().objects)).toEqual([IMAGE])
  await expect(undoButton(page)).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  expect(await page.evaluate(() => window.__feel.shadows())).not.toContain(true)
  await page.mouse.up()
  await expect(undoButton(page)).toBeDisabled()

  await moved()
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[0]?.left).toBe(620)
  const after = { ...IMAGE, left: 620, frameId: FRONT.id }
  expect((await storedDoc(page)).objects).toEqual([after])
  expect(await page.evaluate(() => window.__feel.history().objects)).toEqual([after])
  expect(await page.evaluate(() => window.__feel.shadows())).not.toContain(true)
  await undoButton(page).click()
  await waitSaved(page)
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual([IMAGE])
  await expect(undoButton(page)).toBeDisabled()
  await redoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual([after])
  expect(await page.evaluate(() => window.__feel.shadows())).not.toContain(true)
})

test('turning off interaction feedback hides outlines, marks and lift', async ({ page }) => {
  const at = await openFeel(page, { feedback: false })
  const end = at(670, 280)
  await drag(page, at(CENTRE.x, CENTRE.y), end, { hold: true })
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  expect(await page.evaluate(() => window.__feel.shadows())).not.toContain(true)
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[0]?.frameId).toBe(FRONT.id)
  await fileDrag(page, 'dragenter', end)
  await fileDrag(page, 'dragover', end)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
})

async function dragToEdge(page: Page, start: { x: number; y: number }, inset = 4) {
  const box = await canvasBox(page)
  const edge = { x: box.x + box.width - inset, y: box.y + box.height / 2 }
  await drag(page, start, edge, { steps: 2, hold: true })
  return { edge, box }
}

async function expectViewStopped(page: Page) {
  const { before, after } = await sampleViewTwice(page)
  expect(after).toEqual(before)
  return after
}

test('after edge panning a frame lands under the pointer and its owned member moves exactly once', async ({ page }) => {
  const viewport = { zoom: 1.25, panX: 35, panY: 17 }
  const loose = { ...IMAGE, id: 'loose', left: 425, frameId: undefined }
  const at = await openFeel(page, { frames: [FRAME], objects: [IMAGE, loose], viewport })
  const origin = at(FRAME.left, FRAME.top)
  const start = { x: origin.x + 15, y: origin.y - 13 } // a label offset measured in CSS pixels
  const { edge, box } = await dragToEdge(page, start)
  const grab = { x: (start.x - origin.x) / viewport.zoom, y: (start.y - origin.y) / viewport.zoom }
  await expect.poll(async () => (await readView(page)).panX).toBeLessThan(viewport.panX - 90)
  expect((await readFeedback(page)).carried).toEqual([IMAGE.id])
  const during = await page.evaluate(() => ({ scene: window.__feel.scene(), view: window.__feel.viewport() }))
  expect(during.scene.frames[0]?.left).toBeCloseTo((edge.x - box.x - during.view.panX) / during.view.zoom - grab.x, 2)
  expect(during.scene.objects[0]?.left).toBeCloseTo(IMAGE.left + during.scene.frames[0]!.left - FRAME.left, 2)
  await page.mouse.up()
  const stopped = await expectViewStopped(page)
  await waitSaved(page)
  const after = await storedDoc(page)
  const frame = after.frames![0]!
  expect(frame.left).toBeCloseTo((edge.x - box.x - stopped.panX) / stopped.zoom - grab.x, 2)
  expect(frame.top).toBeCloseTo((edge.y - box.y - stopped.panY) / stopped.zoom - grab.y, 2)
  expect(after.objects[0]?.left).toBeCloseTo(IMAGE.left + frame.left - FRAME.left, 2)
  expect(after.objects[0]?.top).toBeCloseTo(IMAGE.top + frame.top - FRAME.top, 2)
  expect(after.objects[0]?.frameId).toBe(FRAME.id)
  expect(after.objects[1]?.left).toBe(loose.left)
  expect(after.objects[1]?.frameId).toBeUndefined()
  expect(after.viewport).toEqual(stopped)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await undoButton(page).click()
  await waitSaved(page)
  await expect.poll(async () => (await storedDoc(page)).frames).toEqual([FRAME])
  expect((await storedDoc(page)).objects).toEqual([IMAGE, loose])
  expect((await storedDoc(page)).viewport).toEqual(stopped)
  await expect(undoButton(page)).toBeDisabled()
})

test('Esc during edge pan restores the scene while keeping the live view', async ({ page }) => {
  const at = await openFeel(page)
  const start = at(CENTRE.x, CENTRE.y)
  await dragToEdge(page, start)
  await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
  expect((await readFeedback(page)).lifted).toEqual([IMAGE.id])
  await page.keyboard.press('Escape')
  const stopped = await expectViewStopped(page)
  expect(stopped.panX).toBeLessThan(-60)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  expect(await page.evaluate(() => window.__feel.scene().objects)).toEqual([IMAGE])
  await page.mouse.up() // a late release changes nothing
  await waitSaved(page)
  const doc = await storedDoc(page)
  expect(doc.objects).toEqual([IMAGE])
  expect(doc.viewport).toEqual(stopped)
  await expect(undoButton(page)).toBeDisabled()
})

for (const reason of ['blur', 'lost release', 'dispose'] as const) {
  test(`edge pan and lift stop when the held gesture ends through ${reason}`, async ({ page }) => {
    const at = await openFeel(page)
    const { edge } = await dragToEdge(page, at(CENTRE.x, CENTRE.y))
    await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
    expect((await readFeedback(page)).lifted).toEqual([IMAGE.id])
    if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    if (reason === 'lost release') {
      await page.evaluate((e) => document.body.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: e.x, clientY: e.y, buttons: 0,
      })), edge)
    }
    if (reason === 'dispose') await page.evaluate(() => window.__feel.dispose())
    await expectViewStopped(page)
    expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
    expect(await page.evaluate(() => window.__feel.shadows())).not.toContain(true)
    await page.mouse.up()
    expect((await storedDoc(page)).objects).toEqual([IMAGE])
    if (reason !== 'dispose') {
      expect(await page.evaluate(() => window.__feel.scene().objects)).toEqual([IMAGE])
      await expect(undoButton(page)).toBeDisabled()
    }
  })
}

test('a stale save during edge pan makes the board read-only and cancels the drag', async ({ page }) => {
  const at = await openFeel(page)
  await page.evaluate(async () => {
    const path = '/src/persistence/boardStore.ts'
    const { IndexedDbBoardStore } = await import(/* @vite-ignore */ path) as typeof import('../src/persistence/boardStore.ts')
    const other = new IndexedDbBoardStore()
    const stored = (await other.load())!
    await other.save({ ...stored.doc, title: 'Another writer' }, stored.token, (id) => stored.assets.get(id))
  })
  await dragToEdge(page, at(CENTRE.x, CENTRE.y))
  await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
  expect((await readFeedback(page)).lifted).toEqual([IMAGE.id])
  await page.evaluate(() => {
    // Use the same immediate flush as a hidden page without also introducing blur.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })
  await expect(page.getByTestId('readonly-banner')).toContainText('Read-only')
  await expectViewStopped(page)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  expect(await page.evaluate(() => window.__feel.scene().objects)).toEqual([IMAGE])
  await fileDrag(page, 'dragover', at(650, 330))
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await page.mouse.up()
  expect((await storedDoc(page)).title).toBe('Another writer')
  expect((await storedDoc(page)).viewport).toEqual(VIEW)
})

test('an edge drag survives other mouse buttons and zoom, and a saved view keeps the pre-drag scene', async ({ page }) => {
  const at = await openFeel(page)
  const { edge, box } = await dragToEdge(page, at(CENTRE.x, CENTRE.y))
  await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
  for (const button of ['right', 'middle'] as const) {
    await page.mouse.down({ button })
    await page.mouse.move(edge.x, edge.y + 2)
    await page.mouse.up({ button })
    expect((await readFeedback(page)).lifted).toEqual([IMAGE.id])
  }
  await page.keyboard.press('=')
  await expect.poll(async () => (await readView(page)).zoom).toBe(1.25)
  const beforeMiddle = await readView(page)
  const middle = { x: box.x + Math.round(box.width * 0.59), y: edge.y }
  await page.mouse.move(middle.x, middle.y)
  const stopped = await expectViewStopped(page)
  expect(stopped.panX).toBeLessThanOrEqual(beforeMiddle.panX)
  await expect.poll(async () => (await storedDoc(page)).viewport).toEqual(stopped)
  expect((await storedDoc(page)).objects).toEqual([IMAGE])

  await page.mouse.up()
  await waitSaved(page)
  const saved = (await storedDoc(page)).objects[0]!
  expect(saved.left).toBeCloseTo((middle.x - box.x - stopped.panX) / stopped.zoom - 50, 2)
  expect(saved.top).toBeCloseTo((middle.y - box.y - stopped.panY) / stopped.zoom - 30, 2)
})

test('an import that decodes during edge pan waits and undo removes it before undoing the drag', async ({ page }) => {
  const at = await openFeel(page)
  await dragToEdge(page, at(CENTRE.x, CENTRE.y))
  await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
  await page.getByTestId('image-input').setInputFiles([imageFile('late.png', 80, 60, 3)])
  await expect.poll(() => page.evaluate(() => window.__feel.stagedImports())).toBe(1)
  expect(await page.evaluate(() => window.__feel.scene().objects.length)).toBe(1)
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects.length).toBe(2)
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects.length).toBe(1)
  expect((await storedDoc(page)).objects[0]?.left).toBeGreaterThan(1200)
  await undoButton(page).click()
  await expect.poll(async () => (await storedDoc(page)).objects).toEqual([IMAGE])
  await expect(undoButton(page)).toBeDisabled()
})

test('reduced-motion edge pan uses six pixels every frame across edge depths', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const at = await openFeel(page)
  const { edge } = await dragToEdge(page, at(CENTRE.x, CENTRE.y), 40)
  await expect.poll(async () => (await readView(page)).panX).toBeLessThanOrEqual(-30)
  await page.mouse.move(edge.x + 38, edge.y)
  await expect.poll(async () => (await readView(page)).panX).toBeLessThanOrEqual(-66)
  await page.mouse.up()
  const samples = await page.evaluate(() => window.__feel.viewSamples())
  expect(samples.length).toBeGreaterThanOrEqual(11)
  const pans = [0, ...samples.map((v) => v.panX)]
  expect(pans.slice(1).every((x, i) => x - pans[i]! === -6)).toBe(true)
  await expectViewStopped(page)
})

test('edge pan speeds up deeper in the edge and caps at 18 pixels beyond the board', async ({ page }) => {
  const at = await openFeel(page)
  const box = await canvasBox(page)
  const x = box.x + box.width / 2
  await drag(page, at(CENTRE.x, CENTRE.y), { x, y: box.y + 30 }, { steps: 1, hold: true })
  await expect.poll(async () => (await readView(page)).panY).toBeGreaterThanOrEqual(21)
  const shallow = await page.evaluate(() => window.__feel.viewSamples())
  expect(shallow.length).toBeGreaterThanOrEqual(4)
  expect(shallow[0]?.panY).toBe(5.25)
  await page.mouse.move(x, box.y - 10)
  const threshold = (await readView(page)).panY + 54
  await page.evaluate(() => window.__feel.viewSamples())
  await expect.poll(async () => (await readView(page)).panY).toBeGreaterThanOrEqual(threshold)
  await page.mouse.up()
  const deep = await page.evaluate(() => window.__feel.viewSamples())
  expect(deep.length).toBeGreaterThanOrEqual(3)
  expect(deep.slice(1).map((v, i) => v.panY - deep[i]!.panY).every((dy) => dy === 18)).toBe(true)
})

test('a press at the edge is still a click and can become an edge pan after movement', async ({ page }) => {
  const at = await openFeel(page, { objects: [{ ...IMAGE, left: 8, frameId: undefined }] })
  const start = at(15, 280)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  expect(await expectViewStopped(page)).toEqual(VIEW)
  await page.mouse.up()
  await expect(undoButton(page)).toBeDisabled()
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await page.mouse.down()
  await page.mouse.move(start.x - 6, start.y + 5)
  await expect.poll(async () => (await readView(page)).panX).toBeGreaterThan(35)
  await page.mouse.up()
  await expectViewStopped(page)
})

test('an edge drag leaves the view still when interaction feedback is off', async ({ page }) => {
  const at = await openFeel(page, { feedback: false })
  const { edge, box } = await dragToEdge(page, at(CENTRE.x, CENTRE.y))
  expect(await expectViewStopped(page)).toEqual(VIEW)
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[0]?.left).toBe(edge.x - box.x - 50)
  expect((await storedDoc(page)).viewport).toEqual(VIEW)
})
const albumFrames = (doc: StoredBoard) => {
  doc.frames!.push(
    { id: 'image-destination', name: 'Image destination', left: 770, top: 150, width: 220, height: 85 },
    { id: 'caption-destination', name: 'Caption destination', left: 770, top: 260, width: 220, height: 85 },
  )
}

for (const together of [false, true]) {
  test(`the album caption shares its image's frame preview ${together ? 'when both are selected' : 'and follows without lift'}`, async ({ page }) => {
    const { at } = await openAlbumFeel(page, albumFrames)
    if (together) {
      await albumLayer(page, 'front').click()
      await albumLayer(page, 'caption').click({ modifiers: ['Shift'] })
    }
    await drag(page, at(280, 205), at(860, 205), { hold: true })
    expect(await readFeedback(page)).toMatchObject({
      gaining: ['image-destination'], losing: ['sleeve'], carried: [],
      lifted: together ? ['front', 'caption'] : ['front'],
    })
    await page.mouse.up()
    const owner = async () => (await storedDoc(page)).objects.filter((obj) => ['front', 'caption'].includes(obj.id)).map((obj) => obj.frameId)
    await expect.poll(owner).toEqual(['image-destination', 'image-destination'])
  })
}

test('a caption moved alone previews its own frame after detaching', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page, albumFrames)
  await drag(page, at(267, 293), at(860, 293), { hold: true })
  expect(await readFeedback(page)).toMatchObject({ gaining: ['caption-destination'], losing: ['sleeve'], lifted: ['caption'] })
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects.find((obj) => obj.id === 'caption')?.frameId).toBe('caption-destination')
  const saved = (await storedDoc(page)).objects
  expect(saved.find((obj) => obj.id === 'caption')?.captionOf).toBeUndefined()
  expect(saved.find((obj) => obj.id === 'front')).toEqual(before.objects[0])
})

test('an album frame outlines its carried image and caption', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page)
  await drag(page, at(158, 76), at(193, 101), { hold: true })
  const held = await readFeedback(page)
  expect(held.carried).toEqual(expect.arrayContaining(['front', 'caption']))
  expect(held.carried).not.toContain('loose')
  expect(held.lifted).toEqual([])
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[1]?.left).toBe(before.objects[1]!.left + 35)
})

for (const cancel of [false, true]) {
  test(`the album caption keeps up exactly once during edge pan and ${cancel ? 'Esc restores the pair' : 'release leaves it canonical'}`, async ({ page }) => {
    const { at, before } = await openAlbumFeel(page)
    const { edge, box } = await dragToEdge(page, at(280, 205))
    await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
    const live = await page.evaluate(() => ({ front: window.__feel.scene().objects[0], caption: window.__feel.scene().objects[1], view: window.__feel.viewport() }))
    expect(live.front?.left).toBeCloseTo(edge.x - box.x - live.view.panX - 70, 2)
    expect(live.caption).toMatchObject({ left: live.front?.left, top: live.front!.top + 130, captionOf: 'front' })
    expect((await readFeedback(page)).lifted).toEqual(['front'])
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
    const stopped = await expectViewStopped(page)
    await expect.poll(async () => (await storedDoc(page)).viewport).toEqual(stopped)
    const after = await storedDoc(page)
    if (cancel) {
      expect(after.objects).toEqual(before.objects)
      expect(await page.evaluate(() => window.__feel.scene().objects)).toEqual(before.objects)
      await expect(undoButton(page)).toBeDisabled()
    } else {
      expect(after.objects[0]!.left).toBeCloseTo(edge.x - box.x - stopped.panX - 70, 2)
      expect(after.objects[1]).toMatchObject({ left: after.objects[0]!.left, top: after.objects[0]!.top + 130, width: 150, captionOf: 'front' })
      expect(after.objects[1]!.frameId).toBe(after.objects[0]!.frameId)
    }
  })
}

test('captions still follow normally with interaction feedback off', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page, undefined, { feedback: false })
  await drag(page, at(285, 205), at(325, 245), { hold: true })
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
  expect(await page.evaluate(() => window.__feel.scene().objects[1])).toEqual({ ...before.objects[1], left: 250, top: 320 })
  await page.mouse.up()
  await expect.poll(async () => (await storedDoc(page)).objects[1]).toEqual({ ...before.objects[1], left: 250, top: 320 })
})

test('a fresh press on the board title cancels an abandoned image and caption drag', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page)
  const initial = await snapshotIdb(page)
  await drag(page, at(280, 205), at(316, 253), { hold: true })
  expect(await page.evaluate(() => window.__feel.scene().objects[0]?.top)).toBe(198)
  const title = (await page.getByRole('textbox', { name: 'Board title' }).boundingBox())!
  const click = { x: title.x + 30, y: title.y + title.height / 2, button: 'left' as const, clickCount: 1 }
  // The original release never arrives. Send a fresh press and release at the title
  // without an intervening mousemove reporting buttons=0.
  const session = await page.context().newCDPSession(page)
  await session.send('Input.dispatchMouseEvent', { ...click, type: 'mousePressed', buttons: 1 })
  await session.send('Input.dispatchMouseEvent', { ...click, type: 'mouseReleased', buttons: 0 })
  await session.detach()
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect((await storedDoc(page)).objects.slice(0, 2)).toEqual(before.objects.slice(0, 2))
  expect(await snapshotIdb(page)).toEqual(initial)
  await expect(undoButton(page)).toBeDisabled()
  expect(await readFeedback(page)).toEqual(NO_FEEDBACK)
})

test('a lost text-selection release leaves the range and edit in place', async ({ page }) => {
  const { at } = await openAlbumFeel(page)
  await albumLayer(page, 'front').click()
  await page.keyboard.press('Enter')
  const textarea = page.locator('textarea:focus')
  await expect(textarea).toHaveValue('Front sleeve')
  await drag(page, at(212, 294), at(248, 294), { hold: true })
  const range = () => textarea.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])
  const initial = await range()
  expect(initial[1]).toBeGreaterThan(initial[0]!)
  await page.evaluate((point) => document.querySelector('canvas.upper-canvas')!.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, buttons: 0, clientX: point.x, clientY: point.y,
  })), at(325, 294))
  expect(await range()).toEqual(initial)
  await page.mouse.up()
  await expect(textarea).toHaveValue('Front sleeve')
  await expect(undoButton(page)).toBeDisabled()
})

async function heldAlbum(page: Page) {
  return page.evaluate(() => ({ scene: window.__feel.scene(), viewport: window.__feel.viewport() }))
}

function expectAlbumGrab(
  board: { objects: ReadonlyArray<{ left: number; top: number }>; viewport: View },
  canvas: { x: number; y: number },
  pointer: { x: number; y: number },
) {
  const { zoom, panX, panY } = board.viewport
  const image = board.objects[0]!
  const caption = board.objects[1]!
  // Started 70 scene units across and 55 down from the sleeve's top-left.
  expect(image.left).toBeCloseTo((pointer.x - canvas.x - panX) / zoom - 70, 2)
  expect(image.top).toBeCloseTo((pointer.y - canvas.y - panY) / zoom - 55, 2)
  expect(caption.left).toBeCloseTo(image.left, 2)
  expect(caption.top).toBeCloseTo(image.top + 130, 2)
}

for (const feedback of [true, false]) {
  const setting = feedback ? 'on' : 'off'
  test(`a wheel pan after visiting the edge keeps the held grab point with feedback ${setting}`, async ({ page }) => {
    const { at } = await openAlbumFeel(page, undefined, { feedback })
    const { box } = await dragToEdge(page, at(280, 205))
    if (feedback) await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
    const middle = at(505, 325)
    await page.mouse.move(middle.x, middle.y)
    const view = await expectViewStopped(page)
    if (!feedback) expect(view).toEqual(VIEW)

    await page.mouse.wheel(0, 80)
    await expect.poll(async () => (await readView(page)).panY).toBe(view.panY - 80)
    const held = await heldAlbum(page)
    expectAlbumGrab({ objects: held.scene.objects, viewport: held.viewport }, box, middle)
    await page.mouse.up()
    await waitSaved(page)
    expectAlbumGrab(await storedDoc(page), box, middle)
  })

  test(`a zoom key during a drag that stays in the middle keeps the held grab point with feedback ${setting}`, async ({ page }) => {
    const { at } = await openAlbumFeel(page, undefined, { feedback })
    const box = await canvasBox(page)
    const middle = at(505, 325)
    await drag(page, at(280, 205), middle, { hold: true })
    expect(await readView(page)).toEqual(VIEW)
    await page.keyboard.press('=')
    await expect.poll(async () => (await readView(page)).zoom).toBe(1.25)
    await page.mouse.up()
    await waitSaved(page)
    expectAlbumGrab(await storedDoc(page), box, middle)
  })
}

test('wheel zoom, a Zoom button and Fit replay a held move before the next pointer event', async ({ page }) => {
  const { at } = await openAlbumFeel(page, undefined, { feedback: false })
  const box = await canvasBox(page)
  const middle = at(505, 325)
  await drag(page, at(280, 205), middle, { hold: true })

  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -65)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await readView(page)).zoom).toBeGreaterThan(1)
  const afterWheel = await heldAlbum(page)
  expectAlbumGrab({ objects: afterWheel.scene.objects, viewport: afterWheel.viewport }, box, middle)

  for (const name of ['Zoom in', 'Fit to content']) {
    const prior = await readView(page)
    await page.getByRole('button', { name, exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => readView(page)).not.toEqual(prior)
    const held = await heldAlbum(page)
    expectAlbumGrab({ objects: held.scene.objects, viewport: held.viewport }, box, middle)
  }
  await page.mouse.up()
  await waitSaved(page)
  expectAlbumGrab(await storedDoc(page), box, middle)
})

test('autosave during a replayed move sees the original scene and Esc still restores it', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page, undefined, { feedback: false })
  const box = await canvasBox(page)
  const middle = at(505, 325)
  await drag(page, at(280, 205), middle, { hold: true })
  await page.keyboard.press('=')
  await expect.poll(async () => (await storedDoc(page)).viewport.zoom).toBe(1.25)
  const held = await heldAlbum(page)
  expectAlbumGrab({ objects: held.scene.objects, viewport: held.viewport }, box, middle)
  expect((await storedDoc(page)).objects).toEqual(before.objects)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect((await heldAlbum(page)).scene.objects).toEqual(before.objects)
  expect(await readView(page)).toEqual(held.viewport)
  expect((await storedDoc(page)).objects).toEqual(before.objects)
  await expect(undoButton(page)).toBeDisabled()
})

test('hiding the page pauses edge pan until another pointer move and keeps the gesture held', async ({ page }) => {
  const { at, before } = await openAlbumFeel(page)
  const { edge } = await dragToEdge(page, at(280, 205))
  await expect.poll(async () => (await readView(page)).panX).toBeLessThan(-60)
  await page.evaluate(() => {
    // Simulate visibility alone. Keep Chromium's animation frames running to verify
    // the app cancels its own loop even when the browser has not suspended callbacks.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hidden = await sampleViewTwice(page)
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const visible = await sampleViewTwice(page)
  expect(visible.after).toEqual(visible.before)
  expect(visible.after).toEqual(hidden.before)
  expect(hidden.after).toEqual(hidden.before)
  expect((await readFeedback(page)).lifted).toEqual(['front'])
  expect((await heldAlbum(page)).scene.objects[0]!.left).not.toBe(before.objects[0]!.left)

  await page.mouse.move(edge.x - 2, edge.y + 2)
  await expect.poll(async () => (await readView(page)).panX).toBeLessThan(visible.after.panX - 30)
  // Also cover a browser that delivers no animation frames while hidden.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expectViewStopped(page)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect((await heldAlbum(page)).scene.objects).toEqual(before.objects)
  await expect(undoButton(page)).toBeDisabled()
})
