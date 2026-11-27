/**
 * Real-browser tests (real IndexedDB, several pages in one browser context) for storage:
 * opening a board saved by milestone 1, the one-way upgrade on the first framed save,
 * two tabs on one board, and bytes that another tab pruned.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  AUTOSAVE_QUIET_MS,
  dbVersion,
  drag,
  openApp,
  openBlank,
  sceneToPage,
  seedMilestone1,
  seedRaw,
  snapshotIdb,
  status,
  storedDoc,
  tamperIdb,
  undoButton,
  waitSaved,
} from './helpers.ts'
import type { StoredBoard, View } from './helpers.ts'

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }
const PIC = { id: 'a1', name: 'pic.png', width: 200, height: 120 }
const IMAGE = { type: 'image', id: 'img', left: 300, top: 200, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 }
const TEXT = { type: 'text', id: 'txt', left: 600, top: 420, angle: 0, text: 'from milestone 1', fontSize: 24, width: 240 }
const legacyBoard = (title = 'Old board') => ({ version: 1, title, objects: [IMAGE, TEXT], viewport: UNIT })

/** The stored row as it is, without the document: which fields it has, and the database version. */
function rawRow(page: Page): Promise<{ keys: string[]; version: number; rev: unknown }> {
  return page.evaluate(
    () =>
      new Promise<{ keys: string[]; version: number; rev: unknown }>((resolve, reject) => {
        const open = indexedDB.open('yuriful')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const get = db.transaction('boards', 'readonly').objectStore('boards').get('current')
          get.onsuccess = () => {
            const row = (get.result ?? {}) as Record<string, unknown>
            const version = db.version
            db.close()
            resolve({ keys: Object.keys(row).sort(), version, rev: row.rev })
          }
          get.onerror = () => reject(get.error)
        }
      }),
  )
}

async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}
const errorsOf = (page: Page) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}
const banner = (page: Page) => page.getByTestId('readonly-banner')

test.describe('a board saved by milestone 1', () => {
  test('opens editable with the same objects, is not rewritten by loading, stays version 1 through frameless edits, and upgrades with its first frame', async ({ page }) => {
    const errors = errorsOf(page)
    await openBlank(page)
    await seedMilestone1(page, legacyBoard(), [PIC])
    const before = await snapshotIdb(page)
    expect(await rawRow(page)).toEqual({ keys: ['doc', 'id', 'updatedAt'], version: 1, rev: undefined }) // a genuine milestone 1 row

    await openApp(page)
    await expect(banner(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Text' })).toBeEnabled()
    await expect(page.locator('input[aria-label="Board title"]')).toHaveValue('Old board')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before) // loading wrote nothing: same document, same timestamp, same bytes
    expect(await rawRow(page)).toEqual({ keys: ['doc', 'id', 'updatedAt'], version: 1, rev: undefined })
    await expect(undoButton(page)).toBeDisabled()

    // Both objects really are there: select everything.
    await page.keyboard.press('Control+a')
    await expect(page.locator('.inspector-title')).toHaveText('2 objects')
    await page.keyboard.press('Escape')

    // A frameless edit: still the milestone 1 document shape in a version 1 database.
    const at = await sceneToPage(page, UNIT)
    await drag(page, at(400, 260), at(450, 300))
    const edited = await storedWhen(page, (d) => d.objects[0]!.left === 350)
    expect(edited).toEqual({ ...legacyBoard(), objects: [{ ...IMAGE, left: 350, top: 240 }, TEXT] })
    expect(Object.keys(edited)).toEqual(['version', 'title', 'objects', 'viewport'])
    const row = await rawRow(page)
    expect(row.version).toBe(1)
    expect(row.keys).toEqual(['doc', 'id', 'rev', 'updatedAt']) // it gained a revision id, nothing else
    expect((await snapshotIdb(page)).assets).toEqual(before.assets)

    // The first frame: the document becomes version 2 and the database is upgraded with it.
    await page.keyboard.press('f')
    await drag(page, at(250, 150), at(900, 520))
    const framed = await storedWhen(page, (d) => d.version === 2)
    expect(framed.frames).toHaveLength(1)
    expect(framed.objects).toEqual(edited.objects) // content untouched, and nothing adopted
    expect(await dbVersion(page)).toBe(2)

    await waitSaved(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await expect(banner(page)).toHaveCount(0)
    expect(errors).toEqual([])
  })
})

test.describe('the upgrade is a fence against the old build', () => {
  test('an open milestone 1 tab cannot write once a frame has been saved, and the frame survives its attempts', async ({ context }) => {
    // The "old tab": a page holding milestone 1's own storage code with a live connection.
    const old = await context.newPage()
    await openBlank(old)
    await old.evaluate(async (doc) => {
      const path = '/src/persistence/testing/legacyStoreV1.ts'
      const { LegacyStoreV1 } = await import(/* @vite-ignore */ path)
      const store = new LegacyStoreV1()
      await store.save(doc, [])
      ;(window as unknown as { __old: unknown }).__old = store // stays open, like a tab left in the background
    }, { ...legacyBoard(), objects: [TEXT] })

    const page = await context.newPage()
    const errors = errorsOf(page)
    await openApp(page)
    const at = await sceneToPage(page, UNIT)
    await page.keyboard.press('f')
    await drag(page, at(250, 150), at(900, 520))
    const framed = await storedWhen(page, (d) => d.version === 2)
    expect(await dbVersion(page)).toBe(2)
    await waitSaved(page) // not blocked by the old tab: it let go when asked

    // The old tab now tries to save its stale, frameless board, and to read.
    const attempts = await old.evaluate(async (doc) => {
      const store = (window as unknown as { __old: { save: (d: unknown, a: unknown[]) => Promise<void>; loadRaw: () => Promise<unknown> } }).__old
      const outcome = async (run: () => Promise<unknown>) => run().then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)))
      return { save: await outcome(() => store.save(doc, [])), load: await outcome(() => store.loadRaw()) }
    }, { ...legacyBoard('Stale overwrite'), objects: [] })
    expect(attempts.save).not.toBe('ok')
    expect(attempts.load).not.toBe('ok')

    expect(await storedDoc(page)).toEqual(framed) // the framed board is exactly as the app saved it
    expect(await dbVersion(page)).toBe(2)

    // And the app carries on saving normally afterwards.
    await page.keyboard.press('Delete') // the new frame is still selected
    await storedWhen(page, (d) => d.version === 1)
    expect(await dbVersion(page)).toBe(2) // never demoted
    expect(errors).toEqual([])
  })
})

test.describe('two tabs on one board', () => {
  test('the tab whose view is stale never overwrites: it goes read-only with a Reload button, and reloading shows the other tab work', async ({ context }) => {
    const seed = await context.newPage()
    await openBlank(seed)
    await seedMilestone1(seed, legacyBoard(), [PIC])
    await seed.close()

    const first = await context.newPage()
    const second = await context.newPage()
    const errors = [errorsOf(first), errorsOf(second)]
    await openApp(first)
    await openApp(second) // both have loaded the same revision
    const at = await sceneToPage(first, UNIT)

    await first.bringToFront()
    await drag(first, at(400, 260), at(500, 260))
    const saved = await storedWhen(first, (d) => d.objects[0]!.left === 400)
    await waitSaved(first)

    await second.bringToFront()
    await drag(second, at(400, 260), at(400, 400)) // an edit based on the old revision
    await expect(banner(second)).toBeVisible()
    await expect(banner(second)).toContainText('Read-only')
    await expect(banner(second)).toContainText('changed in another tab')
    await expect(status(second)).toContainText('Not saving')
    await expect(second.getByRole('button', { name: 'Select', exact: true })).toBeDisabled()
    await expect(undoButton(second)).toBeDisabled() // it has a history step (the drag), but a read-only board cannot be changed by undo either
    await second.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(second)).toEqual(saved) // the first tab's board is untouched
    expect((await snapshotIdb(second)).assets).toEqual((await snapshotIdb(first)).assets)

    // Nothing more can be done in the stale tab except look, and reload.
    await second.keyboard.press('Control+a')
    await second.keyboard.press('Delete')
    await second.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(second)).toEqual(saved)

    await banner(second).getByRole('button', { name: 'Reload' }).click()
    await expect(second.locator('.toolbar')).toBeVisible()
    await expect(status(second)).toContainText('Saved on this device')
    await expect(banner(second)).toHaveCount(0) // editable again, on the saved board
    await drag(second, at(500, 260), at(500, 300)) // the image is where the first tab left it
    const after = await storedWhen(second, (d) => d.objects[0]!.top === 240)
    expect(after.objects[0]).toMatchObject({ left: 400, top: 240 })

    // And now it is the first tab that is stale.
    await first.bringToFront()
    await drag(first, at(500, 300), at(520, 300))
    await expect(banner(first)).toContainText('changed in another tab')
    expect(await storedDoc(first)).toEqual(after)
    expect(errors.flat()).toEqual([])
  })

  test('an image deleted in one tab and pruned by another comes back, with its original bytes, when the first tab undoes', async ({ context }) => {
    const seed = await context.newPage()
    await openBlank(seed)
    await seedMilestone1(seed, legacyBoard(), [PIC])
    const original = (await snapshotIdb(seed)).assets
    expect(Object.keys(original)).toEqual(['a1'])
    await seed.close()

    const first = await context.newPage()
    const errors = errorsOf(first)
    await openApp(first)
    const at = await sceneToPage(first, UNIT)
    await first.mouse.click(at(400, 260).x, at(400, 260).y)
    await expect(first.locator('.inspector-title')).toHaveText('Image')
    await first.keyboard.press('Delete')
    await storedWhen(first, (d) => d.objects.length === 1)
    await waitSaved(first)
    expect((await snapshotIdb(first)).assets).toEqual(original) // the bytes are still there: undo could need them

    // Another tab opens that revision; its startup cleanup legitimately removes the unreferenced bytes.
    const second = await context.newPage()
    await openApp(second)
    await expect.poll(async () => Object.keys((await snapshotIdb(second)).assets)).toEqual([])
    await second.close()

    await first.bringToFront()
    await undoButton(first).click() // the image is back on the canvas; storage no longer has its bytes
    await storedWhen(first, (d) => d.objects.length === 2)
    await waitSaved(first)
    expect((await snapshotIdb(first)).assets).toEqual(original) // stored again: same length, same hash, same type

    await first.reload()
    await expect(first.locator('.toolbar')).toBeVisible()
    await expect(status(first)).toContainText('Saved on this device')
    await expect(banner(first)).toHaveCount(0) // not "1 saved image could not be loaded"
    await first.keyboard.press('Control+a')
    await expect(first.locator('.inspector-title')).toHaveText('2 objects')
    expect(errors).toEqual([])
  })
})

test.describe('a read-only board that contains frames', () => {
  test('nothing can be selected, moved, drawn or written; the stored row and every asset stay exactly as they were', async ({ page }) => {
    const errors = errorsOf(page)
    const frame = { id: 'A', name: 'Cover', left: 250, top: 150, width: 500, height: 400 }
    await openBlank(page)
    await seedRaw(
      page,
      2,
      {
        version: 2,
        title: 'Framed, damaged',
        frames: [frame],
        objects: [
          { ...IMAGE, frameId: 'A' },
          { ...IMAGE, id: 'img2', left: 500, top: 350, assetId: 'a2', frameId: 'A' },
          { ...TEXT, left: 300, top: 480, frameId: 'A' },
        ],
        viewport: UNIT,
      },
      [PIC, { id: 'a2', name: 'second.png', width: 120, height: 120, seed: 2 }],
    )
    await tamperIdb(page, 'corrupt-second-asset') // one referenced image no longer decodes
    const before = await snapshotIdb(page)
    const rowBefore = await rawRow(page)

    await page.goto('/')
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(banner(page)).toContainText('1 saved image could not be loaded')
    await expect(banner(page).getByRole('button', { name: 'Reload' })).toHaveCount(0) // reloading would not help here
    await expect(page.getByRole('button', { name: 'Frame', exact: true })).toBeDisabled()

    const at = await sceneToPage(page, UNIT)
    const label = { x: at(250, 150).x + 10, y: at(250, 150).y - 14 }
    await page.mouse.click(label.x, label.y) // the frame's label
    await expect(page.locator('.inspector')).toHaveCount(0)
    await drag(page, label, { x: label.x + 150, y: label.y + 100 }) // would move the frame and its members (it pans instead)
    await page.mouse.click(at(400, 260).x, at(400, 260).y) // the image that did load
    await page.mouse.dblclick(at(320, 490).x, at(320, 490).y) // the text
    await page.keyboard.type('nope')
    await page.keyboard.press('f')
    await drag(page, at(800, 150), at(950, 300))
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.inspector')).toHaveCount(0)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)

    const after = await snapshotIdb(page)
    expect({ ...after, doc: JSON.parse(after.doc).frames }).toEqual({ ...before, doc: [frame] }) // frames exactly as stored
    expect(JSON.parse(after.doc).objects).toEqual(JSON.parse(before.doc).objects) // every object and owner
    expect(after.updatedAt).toBe(before.updatedAt) // no write of any kind
    expect(after.assets).toEqual(before.assets) // every byte, including the undecodable one
    expect(await rawRow(page)).toEqual(rowBefore)
    await expect(status(page)).toContainText('Not saving')
    expect(errors).toEqual([])
  })
})

test.describe('storage that refuses or stalls', () => {
  test('a database from a newer build is read-only here and nothing in it is written', async ({ page }) => {
    const errors = errorsOf(page)
    await openBlank(page)
    await seedRaw(page, 3, { version: 1, title: 'From the future', objects: [TEXT], viewport: UNIT })
    const before = await snapshotIdb(page)
    await page.goto('/')
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(banner(page)).toContainText('newer yuriful')
    await expect(status(page)).toContainText('Not saving')
    await page.keyboard.press('t')
    await page.mouse.click(400, 400)
    await page.keyboard.type('nope')
    await page.keyboard.press('f')
    await page.mouse.click(500, 500)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    expect(await dbVersion(page)).toBe(3)
    expect(errors).toEqual([])
  })

  test('a first framed save blocked by another tab fails with Retry and writes nothing; once unblocked, Retry saves it', async ({ context }) => {
    test.setTimeout(60_000)
    const seed = await context.newPage()
    await openBlank(seed)
    await seedMilestone1(seed, legacyBoard(), [PIC])
    await seed.close()

    // A tab that holds the database open and ignores the request to let go.
    const stubborn = await context.newPage()
    await openBlank(stubborn)
    await stubborn.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('yuriful')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            open.result.onversionchange = () => {}
            ;(window as unknown as { __db: IDBDatabase }).__db = open.result
            resolve()
          }
        }),
    )
    /** Reads through the stubborn tab's own connection (a new open would queue behind the blocked upgrade). */
    const held = () =>
      stubborn.evaluate(
        () =>
          new Promise<{ version: number; docVersion: number; hasFrames: boolean }>((resolve, reject) => {
            const db = (window as unknown as { __db: IDBDatabase }).__db
            const get = db.transaction('boards', 'readonly').objectStore('boards').get('current')
            get.onsuccess = () => resolve({ version: db.version, docVersion: get.result.doc.version, hasFrames: 'frames' in get.result.doc })
            get.onerror = () => reject(get.error)
          }),
      )

    const page = await context.newPage()
    const errors = errorsOf(page)
    await openApp(page)
    const at = await sceneToPage(page, UNIT)
    await page.keyboard.press('f')
    await drag(page, at(250, 150), at(900, 520))
    await expect(page.locator('.inspector-title')).toHaveText('Frame')

    await expect(status(page)).toContainText('Couldn’t save', { timeout: 15_000 }) // after the deadline, not forever "Saving…"
    const retry = page.getByRole('button', { name: 'Retry' })
    await expect(retry).toBeVisible()
    await expect(page.locator('.toast-error')).toContainText('Close other yuriful tabs')
    expect(await held()).toEqual({ version: 1, docVersion: 1, hasFrames: false }) // nothing was written, nothing upgraded
    await expect(banner(page)).toHaveCount(0) // still editable: this is a retryable failure, not a conflict

    await stubborn.evaluate(() => (window as unknown as { __db: IDBDatabase }).__db.close()) // the other tab goes away
    await retry.click()
    await waitSaved(page)
    const saved = await storedDoc(page)
    expect(saved.version).toBe(2)
    expect(saved.frames).toHaveLength(1)
    expect(await dbVersion(page)).toBe(2)
    expect(errors).toEqual([])
  })
})
