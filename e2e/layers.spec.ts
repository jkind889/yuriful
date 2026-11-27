/**
 * Real-browser tests (real Fabric, real IndexedDB) for the layer list.
 */
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, drag, openApp, openBlank, redoButton, sceneToPage, seedRaw, snapshotIdb, storedDoc, undoButton, waitSaved } from './helpers.ts'
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
const frameRec = (id: string, left: number, top: number, width: number, height: number, name = id) => ({ id, name, left, top, width, height })

interface Opened {
  errors: string[]
  at: (x: number, y: number) => { x: number; y: number }
}

async function openSeeded(page: Page, frames: unknown[], objects: unknown[], assets: SeedAsset[] = [PIC]): Promise<Opened> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedRaw(page, 2, { version: 2, title: 'Layers', frames, objects, viewport: UNIT }, assets)
  await openApp(page)
  return { errors, at: await sceneToPage(page, UNIT) }
}

const list = (page: Page) => page.getByRole('listbox', { name: 'Layers', exact: true })
const row = (page: Page, id: string) => list(page).locator(`[data-layer-id="${id}"]`)
const rowIds = (page: Page) => list(page).getByRole('option').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.layerId))
const selectedRows = (page: Page) =>
  list(page)
    .locator('[role=option][aria-selected=true]')
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.layerId))
const title = (page: Page) => page.locator('.inspector-title')
const obj = (doc: StoredBoard, id: string) => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no stored object ${id}`)
  return found
}
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}

async function rowPoint(page: Page, id: string, part: 'before' | 'middle' | 'after' = 'middle') {
  const layer = row(page, id)
  await layer.scrollIntoViewIfNeeded()
  const box = await layer.boundingBox()
  if (!box) throw new Error(`missing row ${id}`)
  return { x: box.x + 55, y: box.y + box.height * { before: 0.2, middle: 0.5, after: 0.8 }[part] }
}

test.describe('dragging layer rows', () => {
  test('reorders two overlapping images in the same frame above and below, with undo, redo and reload', async ({ page }) => {
    const frames = [frameRec('outer', 80, 80, 650, 460), frameRec('f1', 200, 120, 470, 360, 'Frame 1')]
    const small = image('small', 300, 220, { frameId: 'f1' })
    const big = image('big', 250, 150, { assetId: 'a2', frameId: 'f1' })
    const o = await openSeeded(page, frames, [small, big], [PIC, BIG])
    const original = ['big', 'small', 'f1', 'outer']
    const reordered = ['small', 'big', 'f1', 'outer']
    await expect.poll(() => rowIds(page)).toEqual(original)
    await row(page, 'big').focus()

    // A pending title save during the drag must still see the original order.
    await page.getByRole('textbox', { name: 'Board title' }).fill('Overlap')
    await drag(page, await rowPoint(page, 'small'), await rowPoint(page, 'big', 'before'), { hold: true })
    await expect(row(page, 'big')).toHaveAttribute('data-insert', 'before')
    await expect.poll(() => rowIds(page)).toEqual(original)
    await expect.poll(async () => {
      const doc = await storedDoc(page)
      return [doc.title, doc.objects.map((item) => item.id)]
    }).toEqual(['Overlap', ['small', 'big']])
    await expect(undoButton(page)).toBeDisabled()
    await page.mouse.up()
    await expect.poll(() => rowIds(page)).toEqual(reordered)
    await expect(list(page).locator('[data-insert]')).toHaveCount(0)
    await expect.poll(() => selectedRows(page)).toEqual([])
    await expect(page.locator('body')).toBeFocused()
    const saved = await storedWhen(page, (d) => d.objects[0]?.id === 'big')
    expect(saved.objects).toEqual([big, small])
    expect(saved.frames).toEqual(frames)

    const overlap = o.at(390, 275)
    await page.mouse.click(overlap.x, overlap.y)
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    await undoButton(page).click()
    await expect.poll(() => rowIds(page)).toEqual(original)
    await expect(undoButton(page)).toBeDisabled()
    await redoButton(page).click()
    await expect.poll(() => rowIds(page)).toEqual(reordered)

    await drag(page, await rowPoint(page, 'small'), await rowPoint(page, 'big', 'after'), { hold: true })
    await expect(row(page, 'big')).toHaveAttribute('data-insert', 'after')
    await page.mouse.up()
    await expect.poll(() => rowIds(page)).toEqual(original)
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    await undoButton(page).click()
    await expect.poll(() => rowIds(page)).toEqual(reordered)
    await storedWhen(page, (d) => d.objects[0]?.id === 'big')
    await waitSaved(page)
    await page.reload()
    await expect.poll(() => rowIds(page)).toEqual(reordered)
    await page.mouse.click(overlap.x, overlap.y)
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    expect(o.errors).toEqual([])
  })

  test('invalid drops, Escape, blur and a lost release leave order, selection and storage alone', async ({ page }) => {
    const o = await openSeeded(page, [frameRec('frame', 180, 110, 500, 370)], [image('a', 300, 220), image('b', 250, 150)])
    const start = () => rowPoint(page, 'a')
    const target = () => rowPoint(page, 'b', 'before')
    const indicator = list(page).locator('[data-insert]')
    await row(page, 'b').click()
    const before = await snapshotIdb(page)
    const source = await start()
    const above = await target()
    await page.mouse.move(source.x, source.y)
    await page.mouse.down()
    await page.keyboard.press('Escape') // also cancel before the pointer has crossed the drag threshold
    await page.mouse.move(above.x, above.y)
    await expect(indicator).toHaveCount(0)
    await page.mouse.up()
    for (const point of [await rowPoint(page, 'b', 'after'), await rowPoint(page, 'frame', 'before'), o.at(400, 260)]) {
      await drag(page, await start(), point, { hold: true })
      await expect(indicator).toHaveCount(0)
      await page.mouse.up()
    }
    await drag(page, await start(), await target(), { hold: true })
    await expect(indicator).toHaveCount(1)
    await page.keyboard.press('Delete')
    await expect.poll(() => rowIds(page)).toEqual(['b', 'a', 'frame'])
    await page.keyboard.press('Escape')
    await expect(indicator).toHaveCount(0)
    // The release on the source must not turn a cancelled drag into a click.
    await page.mouse.move(source.x, source.y)
    await page.mouse.up()

    await drag(page, await start(), await target(), { hold: true })
    await expect(indicator).toHaveCount(1)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(indicator).toHaveCount(0)
    await page.mouse.up()

    await drag(page, await start(), await target(), { hold: true })
    await expect(indicator).toHaveCount(1)
    await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 })))
    await expect(indicator).toHaveCount(0)
    await page.mouse.up()

    await expect.poll(() => rowIds(page)).toEqual(['b', 'a', 'frame'])
    await expect.poll(() => selectedRows(page)).toEqual(['b'])
    await expect(undoButton(page)).toBeDisabled()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)

    await drag(page, await start(), await target(), { hold: true })
    await expect(indicator).toHaveCount(1)
    await page.reload()
    await page.mouse.up()
    await expect.poll(() => rowIds(page)).toEqual(['b', 'a', 'frame'])
    await expect(indicator).toHaveCount(0)
    await expect(undoButton(page)).toBeDisabled()
    expect(await snapshotIdb(page)).toEqual(before)
    expect(o.errors).toEqual([])
  })

  test('a save conflict during a drag cancels the preview and leaves the newer board intact', async ({ page, context }) => {
    const o = await openSeeded(page, [], [image('a', 300, 220), image('b', 250, 150)])
    const writer = await context.newPage()
    await openApp(writer)
    const writerTitle = writer.getByRole('textbox', { name: 'Board title' })
    await writerTitle.fill('Newer board')
    await writerTitle.press('Enter')
    await waitSaved(writer)
    const saved = await snapshotIdb(writer)
    await writer.close()
    await page.bringToFront()

    const from = await rowPoint(page, 'a')
    const to = await rowPoint(page, 'b', 'before')
    await page.getByRole('textbox', { name: 'Board title' }).fill('Stale title')
    await drag(page, from, to, { hold: true })
    await expect(row(page, 'b')).toHaveAttribute('data-insert', 'before')
    await expect(page.getByTestId('readonly-banner')).toBeVisible()
    await expect(list(page).locator('[data-insert]')).toHaveCount(0)
    await page.mouse.up()
    await expect.poll(() => rowIds(page)).toEqual(['b', 'a'])
    expect(await snapshotIdb(page)).toEqual(saved)
    expect(o.errors).toEqual([])
  })

  test('locks stay intact, frames move only among frames, and keyboard and inspector order still work', async ({ page }) => {
    const a = image('a', 300, 220, { frameId: 'inner' })
    const b = image('b', 250, 150, { frameId: 'inner', locked: true })
    const outer = frameRec('outer', 80, 80, 650, 460)
    const inner = { ...frameRec('inner', 200, 120, 470, 360), locked: true }
    const o = await openSeeded(page, [outer, inner], [a, b])
    await drag(page, await rowPoint(page, 'b'), await rowPoint(page, 'a', 'after'))
    await drag(page, await rowPoint(page, 'inner'), await rowPoint(page, 'outer', 'after'))
    await drag(page, await rowPoint(page, 'outer'), await rowPoint(page, 'a', 'before'))
    await expect.poll(() => rowIds(page)).toEqual(['b', 'a', 'inner', 'outer'])
    await expect(undoButton(page)).toBeDisabled()

    await row(page, 'b').focus()
    await page.keyboard.press('Space')
    await expect.poll(() => selectedRows(page)).toEqual(['b'])
    await drag(page, await rowPoint(page, 'a'), await rowPoint(page, 'b', 'before'), { hold: true })
    await expect(row(page, 'b')).toHaveAttribute('data-insert', 'before')
    await page.mouse.down({ button: 'right' })
    await page.mouse.up({ button: 'right' })
    await expect(row(page, 'b')).toHaveAttribute('data-insert', 'before')
    await expect.poll(() => rowIds(page)).toEqual(['b', 'a', 'inner', 'outer'])
    await page.mouse.up()
    await expect.poll(() => rowIds(page)).toEqual(['a', 'b', 'inner', 'outer'])
    await expect.poll(() => selectedRows(page)).toEqual(['b'])
    await expect(page.locator('body')).toBeFocused()
    await drag(page, await rowPoint(page, 'outer'), await rowPoint(page, 'inner', 'before'))
    await expect.poll(() => rowIds(page)).toEqual(['a', 'b', 'outer', 'inner'])

    await row(page, 'a').focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('[')
    await expect.poll(() => rowIds(page)).toEqual(['b', 'a', 'outer', 'inner'])
    await page.getByRole('button', { name: 'Bring forward', exact: true }).click()
    await expect.poll(() => rowIds(page)).toEqual(['a', 'b', 'outer', 'inner'])
    const saved = await storedWhen(page, (d) => d.frames?.[0]?.id === 'inner' && d.objects[0]?.id === 'b')
    await waitSaved(page)
    expect(saved.objects).toEqual([b, a])
    expect(saved.frames).toEqual([inner, outer])
    expect(o.errors).toEqual([])
  })
})

test.describe('the layer list', () => {
  test('selects an image that another one covers completely; ] then brings it forward, and the order survives a reload', async ({ page }) => {
    // "small" lies entirely under "big".
    const o = await openSeeded(page, [], [image('small', 300, 200), image('big', 250, 150, { assetId: 'a2' })], [PIC, BIG])
    await expect(rowIds(page)).resolves.toEqual(['big', 'small']) // front-most first
    await expect(row(page, 'big')).toHaveText('big.png')
    await expect(row(page, 'small')).toHaveText('pic.png')

    // On the canvas, the covered image cannot be reached: a click there selects the big one.
    await page.mouse.click(o.at(400, 260).x, o.at(400, 260).y)
    await expect(title(page)).toHaveText('Image')
    await expect.poll(() => selectedRows(page)).toEqual(['big'])

    // From the list it can.
    await row(page, 'small').click()
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    await expect(row(page, 'small')).toHaveAttribute('aria-selected', 'true')
    await expect(row(page, 'big')).toHaveAttribute('aria-selected', 'false')
    // The row did not take focus, so the board's shortcuts still work.
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)

    await page.keyboard.press(']')
    await expect.poll(() => rowIds(page)).toEqual(['small', 'big'])
    const stored = await storedWhen(page, (d) => d.objects.map((x) => x.id).join() === 'big,small') // back to front
    expect(obj(stored, 'small')).toMatchObject({ left: 300, top: 200 }) // reordering moved nothing
    // Now the canvas reaches it too.
    await page.keyboard.press('Escape')
    await page.mouse.click(o.at(400, 260).x, o.at(400, 260).y)
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    await waitSaved(page)

    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect.poll(() => rowIds(page)).toEqual(['small', 'big'])
    await expect.poll(() => selectedRows(page)).toEqual([])
    expect(o.errors).toEqual([])
  })

  test('an owned image keeps its owner through reordering; the frame row stays below all content and content shows its frame', async ({ page }) => {
    const o = await openSeeded(page, [frameRec('f1', 100, 100, 400, 300, 'Cover')], [image('o1', 150, 150, { frameId: 'f1' }), image('loose', 650, 150)])
    await expect.poll(() => rowIds(page)).toEqual(['loose', 'o1', 'f1'])
    await expect(row(page, 'o1').locator('.layer-frame')).toHaveText('Cover')
    await expect(row(page, 'loose').locator('.layer-frame')).toHaveCount(0)
    await expect(row(page, 'f1')).toHaveAttribute('data-layer-kind', 'frame')

    await row(page, 'o1').click()
    await page.keyboard.press('Control+]')
    await expect.poll(() => rowIds(page)).toEqual(['o1', 'loose', 'f1'])
    let stored = await storedWhen(page, (d) => d.objects.map((x) => x.id).join() === 'loose,o1')
    expect(obj(stored, 'o1').frameId).toBe('f1')
    expect(obj(stored, 'loose').frameId).toBeUndefined()

    // Sending everything selected to the back never puts content behind the frame.
    await row(page, 'loose').click({ modifiers: ['Control'] })
    await row(page, 'f1').click({ modifiers: ['Control'] })
    await expect(title(page)).toHaveText('3 objects')
    await page.keyboard.press('Control+[')
    await expect.poll(() => rowIds(page)).toEqual(['o1', 'loose', 'f1'])
    await page.keyboard.press('[')
    await expect.poll(() => rowIds(page)).toEqual(['o1', 'loose', 'f1'])

    await row(page, 'f1').click()
    await expect(title(page)).toHaveText('Frame')
    await expect(page.getByTestId('frame-item-count')).toHaveText('1 item')
    await waitSaved(page)
    stored = await storedDoc(page)
    expect(stored.frames).toHaveLength(1)
    expect(stored.objects.map((x) => [x.id, x.frameId])).toEqual([
      ['loose', undefined],
      ['o1', 'f1'],
    ])
    expect(o.errors).toEqual([])
  })

  test('Ctrl-clicked rows form one selection that a drag moves exactly once, together with the frame’s unselected members', async ({ page }) => {
    const o = await openSeeded(
      page,
      [frameRec('f1', 100, 100, 400, 300, 'Cover')],
      [image('o1', 150, 150, { frameId: 'f1' }), image('o2', 280, 250, { frameId: 'f1' }), image('loose', 650, 150)],
    )
    await row(page, 'f1').click()
    await row(page, 'o1').click({ modifiers: ['Control'] })
    await row(page, 'loose').click({ modifiers: ['Shift'] })
    await expect(title(page)).toHaveText('3 objects')
    await expect.poll(() => selectedRows(page)).toEqual(['loose', 'o1', 'f1'])

    // Grab the selection on o1 (a member) and move it by (40, 30).
    await drag(page, o.at(250, 210), o.at(290, 240))
    const stored = await storedWhen(page, (d) => (d.frames ?? [])[0]?.left === 140)
    expect(stored.frames![0]).toMatchObject({ left: 140, top: 130, width: 400, height: 300 })
    expect(obj(stored, 'o1')).toMatchObject({ left: 190, top: 180, frameId: 'f1' }) // selected member: through the selection only
    expect(obj(stored, 'o2')).toMatchObject({ left: 320, top: 280, frameId: 'f1' }) // unselected member: carried once
    expect(obj(stored, 'loose')).toMatchObject({ left: 690, top: 180 })
    expect(obj(stored, 'loose').frameId).toBeUndefined()
    await expect.poll(() => selectedRows(page)).toEqual(['loose', 'o1', 'f1'])
    expect(o.errors).toEqual([])
  })

  test('clicking a row while typing a new text commits the text as one undo step and selects the row', async ({ page }) => {
    const o = await openSeeded(page, [], [image('i1', 500, 100)])
    await page.keyboard.press('t')
    await page.mouse.click(o.at(150, 400).x, o.at(150, 400).y)
    await page.keyboard.type('a quick note')
    await row(page, 'i1').click()
    await expect(title(page)).toHaveText('Image')
    await expect.poll(() => selectedRows(page)).toEqual(['i1'])
    const ids = await rowIds(page)
    expect(ids).toHaveLength(2)
    await expect(list(page).locator('[data-layer-kind=text]')).toHaveText('a quick note')
    const stored = await storedWhen(page, (d) => d.objects.some((x) => x.type === 'text'))
    expect(stored.objects.find((x) => x.type === 'text')).toMatchObject({ text: 'a quick note' })

    await undoButton(page).click()
    await expect.poll(() => rowIds(page)).toEqual(['i1'])
    await expect(undoButton(page)).toBeDisabled() // the text was exactly one step
    expect(o.errors).toEqual([])
  })

  test('clicking a row while a blank new text is open discards it', async ({ page }) => {
    const o = await openSeeded(page, [], [image('i1', 500, 100)])
    await page.keyboard.press('t')
    await page.mouse.click(o.at(150, 400).x, o.at(150, 400).y)
    await row(page, 'i1').click()
    await expect.poll(() => selectedRows(page)).toEqual(['i1'])
    await expect.poll(() => rowIds(page)).toEqual(['i1'])
    await expect(undoButton(page)).toBeDisabled()
    expect(o.errors).toEqual([])
  })

  test('a frame name being typed is committed before a row click changes the selection', async ({ page }) => {
    const o = await openSeeded(page, [frameRec('f1', 100, 100, 400, 300, 'Cover')], [image('i1', 650, 150)])
    await row(page, 'f1').click()
    const name = page.getByLabel('Name', { exact: true })
    await name.fill('Spread')
    await row(page, 'i1').click()
    await expect(title(page)).toHaveText('Image')
    await expect.poll(() => selectedRows(page)).toEqual(['i1'])
    await expect(row(page, 'f1')).toHaveText('Spread')
    const stored = await storedWhen(page, (d) => (d.frames ?? [])[0]?.name === 'Spread')
    expect(stored.frames).toHaveLength(1)
    await undoButton(page).click() // the rename was its own step, recorded once
    await expect(row(page, 'f1')).toHaveText('Cover')
    await expect(undoButton(page)).toBeDisabled()
    expect(o.errors).toEqual([])
  })

  test('a text’s row follows typing before the edit ends; emptied, the row disappears', async ({ page }) => {
    const o = await openSeeded(page, [], [{ type: 'text', id: 'note', left: 100, top: 400, angle: 0, text: 'draft', fontSize: 24, width: 200 }])
    await expect(row(page, 'note')).toHaveText('draft')
    await page.mouse.dblclick(o.at(130, 412).x, o.at(130, 412).y)
    await page.keyboard.press('End')
    await page.keyboard.type(' two')
    await expect(row(page, 'note')).toHaveText('draft two') // still editing
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    await expect(row(page, 'note')).toHaveCount(0)
    await page.keyboard.type('back')
    await expect(row(page, 'note')).toHaveText('back')
    await page.keyboard.press('Escape')
    const stored = await storedWhen(page, (d) => d.objects[0]?.text === 'back')
    expect(stored.objects).toHaveLength(1)
    expect(o.errors).toEqual([])
  })

  test('a row click lets go of the font size field: its keys then act on the newly selected object', async ({ page }) => {
    const text = (id: string, left: number) => ({ type: 'text', id, left, top: 400, angle: 0, text: id, fontSize: 24, width: 200 })
    const o = await openSeeded(page, [], [text('alpha', 100), text('beta', 500)])
    await row(page, 'alpha').click()
    const size = page.getByLabel('Font size', { exact: true })
    await size.click()
    await expect(size).toBeFocused()
    await row(page, 'beta').click()
    await expect.poll(() => selectedRows(page)).toEqual(['beta'])
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
    await page.keyboard.press('Delete')
    await expect.poll(() => rowIds(page)).toEqual(['alpha'])
    const stored = await storedWhen(page, (d) => d.objects.length === 1)
    expect(stored.objects.map((x) => [x.id, x.fontSize])).toEqual([['alpha', 24]]) // neither size was changed
    expect(o.errors).toEqual([])
  })

  test('a row click commits a board title being typed and lets go of the field: the board’s shortcuts then work', async ({ page }) => {
    const o = await openSeeded(page, [], [image('i1', 500, 100)])
    const titleInput = page.getByLabel('Board title', { exact: true })
    await titleInput.click()
    await page.keyboard.type('Moodboard')
    await row(page, 'i1').click()
    await expect.poll(() => selectedRows(page)).toEqual(['i1'])
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
    await expect(titleInput).toHaveValue('Moodboard')
    await page.keyboard.press('Delete')
    await expect(page.locator('.layers')).toHaveCount(0)
    const stored = await storedWhen(page, (d) => d.objects.length === 0)
    expect(stored.title).toBe('Moodboard')
    expect(o.errors).toEqual([])
  })

  test('holding Ctrl+Enter on a focused row toggles it once, not on every key repeat', async ({ page }) => {
    const o = await openSeeded(page, [], [image('i1', 100, 100), image('i2', 500, 100)])
    await row(page, 'i1').click()
    await row(page, 'i2').focus()
    await page.keyboard.down('Control')
    await page.keyboard.down('Enter')
    await page.keyboard.down('Enter') // an auto-repeat
    await page.keyboard.up('Enter')
    await page.keyboard.up('Control')
    await expect.poll(() => selectedRows(page)).toEqual(['i2', 'i1'])
    expect(o.errors).toEqual([])
  })

  test('on a read-only board the list shows what is there, but its rows do nothing', async ({ page }) => {
    await openBlank(page)
    // "bad" refers to image bytes that are not stored: the board opens read-only.
    await seedRaw(
      page,
      2,
      { version: 2, title: 'Broken', frames: [frameRec('f1', 100, 100, 400, 300, 'Cover')], objects: [image('ok', 150, 150, { frameId: 'f1' }), image('bad', 600, 150, { assetId: 'gone' })], viewport: UNIT },
      [PIC],
    )
    await page.goto('/')
    await expect(page.getByTestId('readonly-banner')).toBeVisible()
    await expect.poll(() => rowIds(page)).toEqual(['ok', 'f1'])
    await expect(row(page, 'ok')).toHaveAttribute('aria-disabled', 'true')
    // Playwright would wait for a disabled row to become enabled: force the clicks through to prove they do nothing.
    await row(page, 'ok').click({ force: true })
    await row(page, 'f1').click({ force: true, modifiers: ['Control'] })
    await expect.poll(() => selectedRows(page)).toEqual([])
    await expect(page.locator('.inspector')).toHaveCount(0)
  })
})

test.describe('the layer panel on screen', () => {
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  async function box(l: Locator) {
    const b = await l.boundingBox()
    if (!b) throw new Error('not visible')
    return b
  }

  for (const height of [800, 720]) {
    test(`overlaps none of the other chrome at 1280×${height}, scrolls a long list, and collapses`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height })
      const objects = Array.from({ length: 30 }, (_, i) => image(`i${i}`, 120 + (i % 6) * 40, 120 + Math.floor(i / 6) * 40, { frameId: 'f1' }))
      const o = await openSeeded(page, [frameRec('f1', 100, 100, 500, 400, 'A frame with a rather long name')], objects)
      // The tallest inspector: a single frame.
      await row(page, 'f1').click()
      await expect(title(page)).toHaveText('Frame')
      // A notice, so that the notice area is on screen too.
      await page.setInputFiles('input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') })
      await expect(page.locator('.toast')).toBeVisible()

      const panel = await box(page.locator('.layers'))
      for (const other of [
        page.locator('.toolbar'),
        page.locator('.inspector'),
        page.getByRole('group', { name: 'Zoom', exact: true }),
        page.getByRole('group', { name: 'History', exact: true }),
        page.locator('.toast'),
      ]) {
        expect(overlaps(panel, await box(other))).toBe(false)
      }
      const viewport = page.viewportSize()!
      expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height)
      const scrolls = await list(page).evaluate((el) => el.scrollHeight > el.clientHeight + 1)
      expect(scrolls).toBe(true)

      const toggle = page.locator('.layers-header')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await toggle.click()
      await expect(list(page)).toHaveCount(0)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(list(page)).toBeVisible()
      expect(o.errors).toEqual([])
    })
  }
})

test.describe('Alt-pressing an object selected from the list', () => {
  test('a covered image: a plain press still goes to the image on top; Alt-drag moves the selected one, as one undo step, by the normal ownership rule', async ({ page }) => {
    // "small" lies entirely under "big"; both belong to the frame.
    const o = await openSeeded(
      page,
      [frameRec('f1', 100, 100, 600, 450, 'Cover')],
      [image('small', 300, 200, { frameId: 'f1' }), image('big', 250, 150, { assetId: 'a2', frameId: 'f1' })],
      [PIC, BIG],
    )
    // Unchanged default: a plain drag on the covered image moves the one on top.
    await row(page, 'small').click()
    await drag(page, o.at(400, 260), o.at(440, 290))
    let stored = await storedWhen(page, (d) => obj(d, 'big').left === 290)
    expect(obj(stored, 'big')).toMatchObject({ left: 290, top: 180, frameId: 'f1' })
    expect(obj(stored, 'small')).toMatchObject({ left: 300, top: 200, frameId: 'f1' })
    await expect.poll(() => selectedRows(page)).toEqual(['big'])
    await undoButton(page).click()
    await storedWhen(page, (d) => obj(d, 'big').left === 250)
    await expect(undoButton(page)).toBeDisabled()

    // With Alt held, the press acts on the selected image. Dragged out of the frame, it becomes loose.
    await row(page, 'small').click()
    await page.keyboard.down('Alt')
    await drag(page, o.at(400, 260), o.at(800, 260))
    await page.keyboard.up('Alt')
    stored = await storedWhen(page, (d) => obj(d, 'small').left === 700)
    expect(obj(stored, 'small')).toMatchObject({ left: 700, top: 200 })
    expect(obj(stored, 'small').frameId).toBeUndefined()
    expect(obj(stored, 'big')).toMatchObject({ left: 250, top: 150, frameId: 'f1' })
    expect(stored.objects.map((x) => x.id)).toEqual(['small', 'big']) // stacking unchanged
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    await expect(row(page, 'small').locator('.layer-frame')).toHaveCount(0)

    // One undo step takes it all back.
    await undoButton(page).click()
    stored = await storedWhen(page, (d) => obj(d, 'small').left === 300)
    expect(obj(stored, 'small')).toMatchObject({ left: 300, top: 200, frameId: 'f1' })
    await expect(undoButton(page)).toBeDisabled()

    // An Alt-drag is cancelled by Esc like any drag: nothing moves, no step, no save.
    await expect.poll(() => selectedRows(page)).toEqual(['small'])
    await page.keyboard.down('Alt')
    await drag(page, o.at(400, 260), o.at(500, 330), { hold: true })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.keyboard.up('Alt')
    // So is one interrupted by the window losing focus.
    await page.keyboard.down('Alt')
    await drag(page, o.at(400, 260), o.at(470, 300), { hold: true })
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await waitSaved(page)
    stored = await storedDoc(page)
    expect(obj(stored, 'small')).toMatchObject({ left: 300, top: 200, frameId: 'f1' })
    expect(obj(stored, 'big')).toMatchObject({ left: 250, top: 150, frameId: 'f1' })
    await expect(undoButton(page)).toBeDisabled()
    expect(o.errors).toEqual([])
  })

  test('Alt changes nothing else: a marquee, a press beside the selection, and a selected frame’s interior behave as without it', async ({ page }) => {
    const o = await openSeeded(page, [frameRec('f1', 100, 100, 400, 300, 'Cover')], [image('pic', 650, 150), image('other', 650, 400)])
    await page.keyboard.down('Alt')
    // A marquee on the empty board selects what it encloses.
    await drag(page, o.at(600, 120), o.at(900, 300))
    await expect.poll(() => selectedRows(page)).toEqual(['pic'])
    // A press where the selected object is not under the pointer acts on what is there.
    await page.mouse.click(o.at(750, 460).x, o.at(750, 460).y)
    await expect.poll(() => selectedRows(page)).toEqual(['other'])
    await page.mouse.click(o.at(580, 600).x, o.at(580, 600).y)
    await expect.poll(() => selectedRows(page)).toEqual([])
    await page.keyboard.up('Alt')

    // A selected frame is still hit only by its label or outline: its interior stays click-through.
    await row(page, 'f1').click()
    await expect.poll(() => selectedRows(page)).toEqual(['f1'])
    await page.keyboard.down('Alt')
    await drag(page, o.at(300, 250), o.at(350, 300))
    await page.keyboard.up('Alt')
    await expect.poll(() => selectedRows(page)).toEqual([])
    expect((await storedDoc(page)).frames![0]).toMatchObject({ left: 100, top: 100, width: 400, height: 300 })
    await expect(undoButton(page)).toBeDisabled()
    expect(o.errors).toEqual([])
  })
})

test.describe('Alt and frame labels', () => {
  test('Alt never reaches the selected object through a frame’s label: the label still wins', async ({ page }) => {
    // The frame's label (just above its top-left corner) lies over the selected image.
    const o = await openSeeded(page, [frameRec('f2', 300, 300, 300, 200, 'Low')], [image('pic', 280, 240)])
    await row(page, 'pic').click()
    const corner = o.at(300, 300)
    const label = { x: corner.x + 10, y: corner.y - 14 }
    await page.keyboard.down('Alt')
    await drag(page, label, { x: label.x + 40, y: label.y + 30 })
    await page.keyboard.up('Alt')
    const stored = await storedWhen(page, (d) => (d.frames ?? [])[0]?.left === 340)
    expect(stored.frames![0]).toMatchObject({ left: 340, top: 330, width: 300, height: 200 })
    expect(obj(stored, 'pic')).toMatchObject({ left: 280, top: 240 })
    expect(obj(stored, 'pic').frameId).toBeUndefined() // moving a frame adopts nothing
    await expect.poll(() => selectedRows(page)).toEqual(['f2'])
    expect(o.errors).toEqual([])
  })
})

test.describe('the layer list, collapsed', () => {
  test('stays collapsed when the list empties and fills again', async ({ page }) => {
    const o = await openSeeded(page, [], [image('i1', 300, 200)])
    const toggle = page.locator('.layers-header')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.mouse.click(o.at(400, 260).x, o.at(400, 260).y)
    await page.keyboard.press('Delete')
    await expect(page.locator('.layers')).toHaveCount(0)
    await undoButton(page).click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(list(page)).toHaveCount(0)
    await toggle.click()
    await expect.poll(() => rowIds(page)).toEqual(['i1'])
    expect(o.errors).toEqual([])
  })
})

test.describe('focus after a mouse press on a row', () => {
  test('a row focused from the keyboard lets go when another row is clicked: Space then pans and the clicked row stays selected', async ({ page }) => {
    const o = await openSeeded(page, [], [image('A', 100, 100), image('B', 500, 100)])
    await row(page, 'A').focus()
    await page.keyboard.press('Enter') // keyboard activation still works
    await expect.poll(() => selectedRows(page)).toEqual(['A'])
    await row(page, 'B').click()
    await expect.poll(() => selectedRows(page)).toEqual(['B'])
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)

    // Space now holds the hand: a drag pans the board, and nothing selects A again.
    const from = o.at(900, 500)
    await page.keyboard.down('Space')
    await drag(page, from, { x: from.x + 60, y: from.y + 30 })
    await page.keyboard.up('Space')
    await expect.poll(async () => (await storedDoc(page)).viewport.panX).toBe(60)
    await expect.poll(() => selectedRows(page)).toEqual(['B'])
  })

  test('the same for a padlock pressed after a row was focused from the keyboard', async ({ page }) => {
    await openSeeded(page, [], [image('A', 100, 100), image('B', 500, 100)])
    await row(page, 'A').focus()
    await row(page, 'B').getByTestId('layer-lock').click()
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  })
})
