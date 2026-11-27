/**
 * Real-browser tests (real Fabric, real IndexedDB) for frames.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  AUTOSAVE_QUIET_MS,
  dbVersion,
  drag,
  imageFile,
  openApp,
  openBlank,
  redoButton,
  sceneToPage,
  seedMilestone1,
  seedRaw,
  snapshotIdb,
  status,
  storedDoc,
  undoButton,
  waitSaved,
} from './helpers.ts'
import type { StoredBoard, View } from './helpers.ts'

const FRAME = { id: 'f1', name: 'Cover', left: 100, top: 100, width: 400, height: 300 }

/** RGBA of one pixel of the scene canvas, at a position given in canvas (CSS) pixels. */
function pixel(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  return page.evaluate(
    ({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.canvas-container canvas.lower-canvas')
      if (!canvas) throw new Error('scene canvas not found')
      const scale = canvas.width / canvas.clientWidth // device pixel ratio
      const d = canvas.getContext('2d')!.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]!] as [number, number, number, number]
    },
    { x, y },
  )
}

/** Counts pixels in a canvas-pixel rectangle that are neither transparent nor white (i.e. drawn chrome). */
function inkIn(page: Page, left: number, top: number, width: number, height: number): Promise<number> {
  return page.evaluate(
    ({ left, top, width, height }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.canvas-container canvas.lower-canvas')
      if (!canvas) throw new Error('scene canvas not found')
      const scale = canvas.width / canvas.clientWidth
      const d = canvas.getContext('2d')!.getImageData(left * scale, top * scale, width * scale, height * scale).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i + 3]! > 40 && (d[i]! < 235 || d[i + 1]! < 235 || d[i + 2]! < 235)) n++
      return n
    },
    { left, top, width, height },
  )
}

test.describe('drawing a stored frame', () => {
  for (const view of [
    { zoom: 1, panX: 0, panY: 0 },
    { zoom: 0.5, panX: 200, panY: 100 },
    { zoom: 2, panX: -150, panY: -120 },
  ] satisfies View[]) {
    test(`white paper, outline and label follow the frame at zoom ${view.zoom}`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await openBlank(page)
      await seedRaw(page, 2, { version: 2, title: 'Framed', frames: [FRAME], objects: [], viewport: view })
      await page.goto('/')
      await expect(page.locator('.toolbar')).toBeVisible()

      const x = (sceneX: number) => sceneX * view.zoom + view.panX
      const y = (sceneY: number) => sceneY * view.zoom + view.panY
      const left = x(FRAME.left)
      const top = y(FRAME.top)
      const right = x(FRAME.left + FRAME.width)
      const bottom = y(FRAME.top + FRAME.height)
      const midX = (left + right) / 2
      const midY = (top + bottom) / 2

      await expect.poll(() => pixel(page, midX, midY)).toEqual([255, 255, 255, 255]) // paper
      expect((await pixel(page, left - 12, midY))[3]).toBe(0) // nothing outside the frame
      expect((await pixel(page, midX, bottom + 12))[3]).toBe(0)

      // A one-pixel outline exactly on each edge of the frame, whatever the zoom.
      for (const [px, py] of [
        [midX, top],
        [midX, bottom],
        [left, midY],
        [right, midY],
      ] as const) {
        const [r, g, b, a] = await pixel(page, px, py)
        expect(a, `edge at ${px},${py}`).toBeGreaterThan(200)
        expect(r + g + b, `edge at ${px},${py}`).toBeLessThan(720) // not paper white
      }
      expect(await pixel(page, midX, top + 2)).toEqual([255, 255, 255, 255]) // and only one pixel thick
      expect(await pixel(page, left + 2, midY)).toEqual([255, 255, 255, 255])
      expect((await pixel(page, midX, top - 2))[3]).toBe(0)
      expect((await pixel(page, left - 2, midY))[3]).toBe(0)

      // The label sits just above the top-left corner, at a fixed screen size.
      expect(await inkIn(page, Math.round(left), Math.round(top) - 24, 60, 20)).toBeGreaterThan(20)
      expect(await inkIn(page, Math.round(left) + 120, Math.round(top) - 24, 60, 20)).toBe(0) // nothing beside it
      expect(errors).toEqual([])
    })
  }
})

// =================================================================================================
// Editing frames
// =================================================================================================

const PIC = { id: 'a1', name: 'pic.png', width: 200, height: 120 }
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
const UNIT: View = { zoom: 1, panX: 0, panY: 0 }

interface Opened {
  errors: string[]
  /** Scene coordinates -> page coordinates. */
  at: (x: number, y: number) => { x: number; y: number }
}

/** Opens the app on a seeded board with frames (a version 2 database). */
async function openFramed(page: Page, frames: unknown[], objects: unknown[], view: View = UNIT): Promise<Opened> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedRaw(page, 2, { version: 2, title: 'Frames', frames, objects, viewport: view }, [PIC])
  await openApp(page)
  return { errors, at: await sceneToPage(page, view) }
}

/** Opens the app on a board written by the frozen milestone 1 store (version 1 database, no frames). */
async function openLegacy(page: Page, objects: unknown[], view: View = UNIT): Promise<Opened> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedMilestone1(page, { version: 1, title: 'Legacy', objects, viewport: view }, [PIC])
  await openApp(page)
  return { errors, at: await sceneToPage(page, view) }
}

/** A point on a frame's label: just above its top-left corner, in screen pixels. */
const labelOf = (o: Opened, f: { left: number; top: number }) => {
  const corner = o.at(f.left, f.top)
  return { x: corner.x + 10, y: corner.y - 14 }
}
const title = (page: Page) => page.locator('.inspector-title')
const obj = (doc: StoredBoard, id: string) => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no stored object ${id}`)
  return found
}
const frameOf = (doc: StoredBoard, id: string) => {
  const found = (doc.frames ?? []).find((f) => f.id === id)
  if (!found) throw new Error(`no stored frame ${id}`)
  return found
}
/** Waits until the stored board satisfies `check`, then returns it. */
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}

test.describe('drawing a frame with the Frame tool', () => {
  test('a frame drawn round images owns nothing; moving the images afterwards makes them members; reload is identical', async ({ page }) => {
    const o = await openLegacy(page, [image('i1', 300, 200), image('i2', 560, 260)])
    expect(await dbVersion(page)).toBe(1)

    await page.keyboard.press('f')
    await drag(page, o.at(250, 150), o.at(820, 450))
    await expect(title(page)).toHaveText('Frame') // created, selected, back in the Select tool
    await waitSaved(page)
    const drawn = await storedWhen(page, (d) => (d.frames ?? []).length === 1)
    expect(drawn.version).toBe(2)
    expect(await dbVersion(page)).toBe(2) // the first framed save promoted the database
    expect(drawn.frames![0]).toMatchObject({ name: 'Frame 1', left: 250, top: 150, width: 570, height: 300 })
    expect(drawn.objects.map((x) => x.frameId)).toEqual([undefined, undefined]) // drawing a frame adopts nothing
    expect(drawn.objects.map((x) => x.id)).toEqual(['i1', 'i2']) // and the frame is not among the content

    // Marquee the two images (the selected frame's interior is click-through) and nudge them.
    await drag(page, o.at(262, 162), o.at(800, 440))
    await expect(title(page)).toHaveText('2 objects')
    await drag(page, o.at(400, 260), o.at(410, 268))
    const frameId = drawn.frames![0]!.id
    const owned = await storedWhen(page, (d) => d.objects.every((x) => x.frameId === frameId))
    expect(obj(owned, 'i1')).toMatchObject({ left: 310, top: 208 })
    expect(obj(owned, 'i2')).toMatchObject({ left: 570, top: 268 })
    await waitSaved(page)

    const before = await snapshotIdb(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before) // loading rewrote nothing
    await expect(undoButton(page)).toBeDisabled()
    expect(o.errors).toEqual([])
  })

  test('Esc mid-draft: no frame, nothing stored, Undo stays disabled, and a new draft then works', async ({ page }) => {
    const o = await openLegacy(page, [image('i1', 300, 200)])
    const before = await snapshotIdb(page)
    await page.keyboard.press('f')
    await drag(page, o.at(600, 150), o.at(900, 400), { hold: true })
    await page.keyboard.press('Escape')
    await page.mouse.move(o.at(950, 450).x, o.at(950, 450).y, { steps: 3 })
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    expect(await dbVersion(page)).toBe(1)
    await expect(undoButton(page)).toBeDisabled()
    await expect(page.locator('.inspector')).toHaveCount(0)

    await page.keyboard.press('f')
    await drag(page, o.at(600, 150), o.at(900, 400))
    await expect(title(page)).toHaveText('Frame')
    const doc = await storedWhen(page, (d) => (d.frames ?? []).length === 1)
    expect(doc.frames![0]).toMatchObject({ left: 600, top: 150, width: 300, height: 250 })
    expect(o.errors).toEqual([])
  })

  test('F then the right button, clicked or dragged, creates nothing and writes nothing; a primary drag then draws', async ({ page }) => {
    const o = await openLegacy(page, [image('i1', 300, 200)])
    const before = await snapshotIdb(page)
    await page.keyboard.press('f')
    const p = o.at(650, 200)
    await page.mouse.move(p.x, p.y)
    await page.mouse.down({ button: 'right' }) // press and release
    await page.mouse.up({ button: 'right' })
    await page.mouse.down({ button: 'right' }) // a right-button drag
    await page.mouse.move(p.x + 200, p.y + 150, { steps: 5 })
    await page.mouse.up({ button: 'right' })
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    const after = await snapshotIdb(page)
    expect(after).toEqual(before) // byte-equal document, same updatedAt, same assets
    expect(await dbVersion(page)).toBe(1)
    await expect(undoButton(page)).toBeDisabled()
    expect(JSON.parse(after.doc).frames).toBeUndefined()

    await drag(page, p, { x: p.x + 200, y: p.y + 150 }) // the tool is still armed for the primary button
    await expect(title(page)).toHaveText('Frame')
    await storedWhen(page, (d) => (d.frames ?? []).length === 1)
    expect(o.errors).toEqual([])
  })

  test('a plain click with the Frame tool makes a default frame of 640 x 480 screen pixels', async ({ page }) => {
    const view: View = { zoom: 0.5, panX: 100, panY: 60 }
    const o = await openLegacy(page, [image('i1', 100, 100)], view)
    await page.keyboard.press('f')
    const p = o.at(600, 300)
    await page.mouse.click(p.x, p.y)
    const doc = await storedWhen(page, (d) => (d.frames ?? []).length === 1)
    expect(doc.frames![0]).toMatchObject({ left: 600, top: 300, width: 1280, height: 960 })
  })
})

test.describe('hit testing and selection precedence', () => {
  // Zoomed out and panned, so nothing here is at default coordinates.
  const view: View = { zoom: 0.5, panX: 100, panY: 60 }
  const A = frameRec('A', 200, 200, 800, 600)
  const B = frameRec('B', 1400, 200, 400, 300)
  const C = frameRec('C', 1400, 800, 300, 200)
  const D = frameRec('D', 1400, 800, 300, 200) // exactly on top of C, and in front of it
  const scene = (): [unknown[], unknown[]] => [
    [A, B, C, D],
    [
      image('bleed', 100, 100, { scaleX: 6, scaleY: 6 }), // 1200 x 720: covers all of A and its label
      image('small', 1500, 300, { scaleX: 0.5, scaleY: 0.5 }), // 100 x 60, inside B
    ],
  ]

  test('label and edge win over a full-bleed image on top; the interior belongs to the image', async ({ page }) => {
    const o = await openFramed(page, ...scene(), view)
    const label = labelOf(o, A)
    await page.mouse.click(label.x, label.y)
    await expect(title(page)).toHaveText('Frame')
    await page.keyboard.press('Escape')

    for (const edge of [o.at(600, 200), o.at(1000, 500), o.at(600, 800), o.at(200, 500)]) {
      await page.mouse.click(edge.x, edge.y) // top, right, bottom, left edges, all under the image
      await expect(title(page)).toHaveText('Frame')
      await page.keyboard.press('Escape')
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
    const band = o.at(600, 200)
    await page.mouse.click(band.x, band.y + 5) // 5 screen pixels inside the edge: still the frame
    await expect(title(page)).toHaveText('Frame')
    await page.keyboard.press('Escape')
    await page.mouse.click(band.x, band.y + 9) // 9 screen pixels inside: the image
    await expect(title(page)).toHaveText('Image')
    await page.keyboard.press('Escape')

    const inside = o.at(600, 500)
    await page.mouse.click(inside.x, inside.y)
    await expect(title(page)).toHaveText('Image')
    expect(o.errors).toEqual([])
  })

  test('a selected frame is still click-through: content inside it can be grabbed', async ({ page }) => {
    const o = await openFramed(page, ...scene(), view)
    const label = labelOf(o, B)
    await page.mouse.click(label.x, label.y)
    await expect(title(page)).toHaveText('Frame')
    const small = o.at(1550, 330)
    await page.mouse.click(small.x, small.y)
    await expect(title(page)).toHaveText('Image')
  })

  test('empty interior starts a marquee; a partial marquee excludes the frame, full enclosure includes it', async ({ page }) => {
    const o = await openFramed(page, ...scene(), view)
    // Starts and ends inside B, well clear of its edges, and encloses the small image.
    await drag(page, o.at(1430, 230), o.at(1770, 470))
    await expect(title(page)).toHaveText('Image')
    await page.keyboard.press('Escape')
    await expect(page.locator('.inspector')).toHaveCount(0)

    // Crossing B's edge without enclosing B: still only the image.
    await drag(page, o.at(1350, 280), o.at(1700, 420))
    await expect(title(page)).toHaveText('Image')
    await page.keyboard.press('Escape')

    // Enclosing all of B: the frame is taken too.
    await drag(page, o.at(1360, 130), o.at(1830, 540))
    await expect(title(page)).toHaveText('2 objects')
    await page.keyboard.press('Delete')
    const doc = await storedWhen(page, (d) => d.objects.length === 1)
    expect((doc.frames ?? []).map((f) => f.id)).toEqual(['A', 'C', 'D']) // B went, with the image inside it
    expect(o.errors).toEqual([])
  })

  test('where two frames coincide the front-most one is grabbed', async ({ page }) => {
    const o = await openFramed(page, ...scene(), view)
    const label = labelOf(o, D)
    await page.mouse.click(label.x, label.y)
    await expect(title(page)).toHaveText('Frame')
    await page.keyboard.press('Delete')
    const doc = await storedWhen(page, (d) => (d.frames ?? []).length === 3)
    expect(doc.frames!.map((f) => f.id)).toEqual(['A', 'B', 'C']) // D, the one in front, was the one selected
  })

  test('Shift-click on a label lying over a selected object toggles the frame, not the object', async ({ page }) => {
    const F1 = frameRec('F1', 300, 300, 400, 300)
    // p1 lies over the frame's label (which is at y 276..296) and over its top-left corner.
    const o = await openFramed(page, [F1], [image('p1', 250, 200), image('p2', 800, 500)])
    const p1 = o.at(270, 220)
    const p2 = o.at(900, 560)
    const label = labelOf(o, F1)

    await page.mouse.click(p1.x, p1.y)
    await expect(title(page)).toHaveText('Image')
    await page.keyboard.down('Shift')
    await page.mouse.click(p2.x, p2.y)
    await expect(title(page)).toHaveText('2 objects')
    await page.mouse.click(label.x, label.y) // inside the multi-selection's box, on the frame's label
    await expect(title(page)).toHaveText('3 objects') // the frame was added; both images stay selected
    await page.mouse.click(label.x, label.y)
    await expect(title(page)).toHaveText('2 objects') // and removed again, alone
    await page.keyboard.up('Shift')

    await page.keyboard.press('Delete') // proves WHICH two are left: the images
    const doc = await storedWhen(page, (d) => d.objects.length === 0)
    expect((doc.frames ?? []).map((f) => f.id)).toEqual(['F1'])
    expect(o.errors).toEqual([])
  })
})

test.describe('moving and resizing frames', () => {
  const A = frameRec('A', 300, 200, 400, 300)

  test('dragging a frame by its label moves it and its members by one delta; one undo, one redo', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' }), image('loose', 800, 500)])
    const before = await storedDoc(page)
    const label = labelOf(o, A)
    await drag(page, label, { x: label.x + 120, y: label.y + 80 })
    const moved = await storedWhen(page, (d) => frameOf(d, 'A').left === 420)
    expect(frameOf(moved, 'A')).toMatchObject({ left: 420, top: 280, width: 400, height: 300 })
    expect(obj(moved, 'member')).toMatchObject({ left: 470, top: 330, frameId: 'A' }) // carried, exactly once
    expect(obj(moved, 'loose')).toEqual(obj(before, 'loose'))

    await undoButton(page).click()
    await expect(undoButton(page)).toBeDisabled() // one step for the frame and everything it carried
    const undone = await storedWhen(page, (d) => frameOf(d, 'A').left === 300)
    expect(undone.frames).toEqual(before.frames)
    expect(undone.objects).toEqual(before.objects)

    await redoButton(page).click()
    const redone = await storedWhen(page, (d) => frameOf(d, 'A').left === 420)
    expect(redone.objects).toEqual(moved.objects)
    expect(o.errors).toEqual([])
  })

  test('a frame selected together with one member: the member moves once, an unselected member is carried once', async ({ page }) => {
    const o = await openFramed(page, [A], [image('picked', 350, 250, { frameId: 'A' }), image('carried', 460, 360, { frameId: 'A', scaleX: 0.5, scaleY: 0.5 })])
    const label = labelOf(o, A)
    await page.mouse.click(label.x, label.y)
    await expect(title(page)).toHaveText('Frame')
    await page.keyboard.down('Shift')
    const picked = o.at(400, 290)
    await page.mouse.click(picked.x, picked.y)
    await page.keyboard.up('Shift')
    await expect(title(page)).toHaveText('2 objects')

    // Dragged by the selected member (inside the selection's box).
    await drag(page, picked, { x: picked.x + 50, y: picked.y + 30 })
    let doc = await storedWhen(page, (d) => frameOf(d, 'A').left === 350)
    expect(frameOf(doc, 'A')).toMatchObject({ left: 350, top: 230 })
    expect(obj(doc, 'picked')).toMatchObject({ left: 400, top: 280, frameId: 'A' }) // once, not twice
    expect(obj(doc, 'carried')).toMatchObject({ left: 510, top: 390, frameId: 'A' }) // carried once
    await expect(title(page)).toHaveText('2 objects')

    // Dragged by the frame's label, which lies outside the selection's box: still the whole selection.
    const moved = { x: label.x + 50, y: label.y + 30 }
    await drag(page, moved, { x: moved.x + 40, y: moved.y + 20 })
    doc = await storedWhen(page, (d) => frameOf(d, 'A').left === 390)
    expect(frameOf(doc, 'A')).toMatchObject({ left: 390, top: 250 })
    expect(obj(doc, 'picked')).toMatchObject({ left: 440, top: 300, frameId: 'A' })
    expect(obj(doc, 'carried')).toMatchObject({ left: 550, top: 410, frameId: 'A' })
    await expect(title(page)).toHaveText('2 objects') // the press on the label did not collapse the selection

    await undoButton(page).click()
    await undoButton(page).click()
    await expect(undoButton(page)).toBeDisabled() // two drags, two steps
    doc = await storedWhen(page, (d) => frameOf(d, 'A').left === 300)
    expect(obj(doc, 'picked')).toMatchObject({ left: 350, top: 250 })
    expect(obj(doc, 'carried')).toMatchObject({ left: 460, top: 360 })
    expect(o.errors).toEqual([])
  })

  test('in a selection: Shift-click on a member frame label removes just that frame; an unselected frame label inside the box does not beat the selection', async ({ page }) => {
    // B's label (y 316..336) lies inside the box of the selection {A, picked, far}.
    const B = frameRec('B', 420, 340, 200, 120)
    const o = await openFramed(page, [A, B], [image('picked', 350, 250, { frameId: 'A' }), image('far', 760, 420)])
    const before = await storedDoc(page)
    const labelA = labelOf(o, A)
    await page.mouse.click(labelA.x, labelA.y)
    await page.keyboard.down('Shift')
    await page.mouse.click(o.at(380, 270).x, o.at(380, 270).y) // picked
    await page.mouse.click(o.at(860, 480).x, o.at(860, 480).y) // far
    await page.keyboard.up('Shift')
    await expect(title(page)).toHaveText('3 objects')

    // Plain press on the unselected frame B's label, inside the selection's box: the selection is dragged, B stays.
    const labelB = labelOf(o, B)
    await drag(page, labelB, { x: labelB.x + 40, y: labelB.y + 20 })
    const moved = await storedWhen(page, (d) => frameOf(d, 'A').left === 340)
    expect(frameOf(moved, 'B')).toEqual(frameOf(before, 'B')) // the multi-selection body won (D2)
    expect(obj(moved, 'picked')).toMatchObject({ left: 390, top: 270 })
    expect(obj(moved, 'far')).toMatchObject({ left: 800, top: 440 })
    await expect(title(page)).toHaveText('3 objects')

    // Shift-click on member frame A's label: only A leaves the selection.
    const labelAMoved = { x: labelA.x + 40, y: labelA.y + 20 }
    await page.keyboard.down('Shift')
    await page.mouse.click(labelAMoved.x, labelAMoved.y)
    await page.keyboard.up('Shift')
    await expect(title(page)).toHaveText('2 objects')
    await page.keyboard.press('Delete') // proves which two were left: the images
    const after = await storedWhen(page, (d) => d.objects.length === 0)
    expect((after.frames ?? []).map((f) => f.id)).toEqual(['A', 'B'])
    expect(o.errors).toEqual([])
  })

  test('six lone resizes out and back, and Esc mid-resize, leave a frame exactly where it started', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
    const before = await storedDoc(page)
    const label = labelOf(o, A)
    await page.mouse.click(label.x, label.y)
    for (let i = 0; i < 3; i++) {
      await drag(page, o.at(700, 500), o.at(823, 571))
      await storedWhen(page, (d) => frameOf(d, 'A').width === 523)
      await drag(page, o.at(823, 571), o.at(700, 500))
      await storedWhen(page, (d) => frameOf(d, 'A').width === 400)
    }
    expect(await storedDoc(page)).toEqual(before) // frame and member records exact after six gestures
    await waitSaved(page)

    const untouched = await snapshotIdb(page)
    await drag(page, o.at(700, 500), o.at(900, 640), { hold: true })
    await page.keyboard.press('Escape') // interrupted
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(untouched)
    for (let i = 0; i < 6; i++) await undoButton(page).click()
    await expect(undoButton(page)).toBeDisabled() // six steps: the cancelled one left nothing
    expect(o.errors).toEqual([])
  })

  test('a frame moved over a loose image does not adopt it; moving the image itself does; reload keeps both states', async ({ page }) => {
    const small = frameRec('A', 100, 200, 300, 250)
    const o = await openFramed(page, [small], [image('pic', 600, 250)]) // centre (700, 310)
    let label = labelOf(o, small)
    await drag(page, label, { x: label.x + 500, y: label.y }) // A is now 600..900 x 200..450: over the image
    let doc = await storedWhen(page, (d) => frameOf(d, 'A').left === 600)
    expect(obj(doc, 'pic')).not.toHaveProperty('frameId')

    label = { x: label.x + 500, y: label.y }
    await drag(page, label, { x: label.x + 20, y: label.y + 20 }) // moved again: the image stays put
    doc = await storedWhen(page, (d) => frameOf(d, 'A').left === 620)
    expect(obj(doc, 'pic')).toMatchObject({ left: 600, top: 250 })
    expect(obj(doc, 'pic')).not.toHaveProperty('frameId')
    await waitSaved(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    expect(obj(await storedDoc(page), 'pic')).not.toHaveProperty('frameId') // still loose after a reload

    // Dragging the image a little, inside the frame, is what makes it a member.
    await drag(page, o.at(700, 310), o.at(710, 320))
    doc = await storedWhen(page, (d) => obj(d, 'pic').frameId === 'A')
    expect(obj(doc, 'pic')).toMatchObject({ left: 610, top: 260 })

    label = { x: label.x + 20, y: label.y + 20 }
    await drag(page, label, { x: label.x - 200, y: label.y }) // and now it travels with the frame
    doc = await storedWhen(page, (d) => frameOf(d, 'A').left === 420)
    expect(obj(doc, 'pic')).toMatchObject({ left: 410, top: 260, frameId: 'A' })
    await waitSaved(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    expect(obj(await storedDoc(page), 'pic')).toMatchObject({ left: 410, top: 260, frameId: 'A' })
    expect(o.errors).toEqual([])
  })

  test('an owner is sticky: a member in two overlapping frames keeps the back frame through reload, move and undo', async ({ page }) => {
    const back = frameRec('back', 100, 100, 400, 300)
    const front = frameRec('front', 300, 100, 400, 300)
    const o = await openFramed(page, [back, front], [image('s', 320, 180, { frameId: 'back' })]) // centre (420, 240): in the overlap
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    const before = await storedDoc(page)
    expect(obj(before, 's').frameId).toBe('back')

    const label = labelOf(o, back)
    await drag(page, label, { x: label.x + 30, y: label.y + 30 })
    const moved = await storedWhen(page, (d) => frameOf(d, 'back').left === 130)
    expect(obj(moved, 's')).toMatchObject({ left: 350, top: 210, frameId: 'back' }) // carried by its owner, not by the frame in front

    await undoButton(page).click()
    await storedWhen(page, (d) => frameOf(d, 'back').left === 100)
    await waitSaved(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    const after = await storedDoc(page)
    expect(after.frames).toEqual(before.frames)
    expect(after.objects).toEqual(before.objects)
  })

  test('a frame resized alone changes freely, leaves its contents alone, and releases what it no longer contains', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })]) // centre (450, 310)
    const before = await storedDoc(page)
    const label = labelOf(o, A)
    await page.mouse.click(label.x, label.y)
    await expect(title(page)).toHaveText('Frame')

    await drag(page, o.at(700, 500), o.at(560, 420)) // bottom-right handle: 400 x 300 -> 260 x 220, not proportional
    let doc = await storedWhen(page, (d) => frameOf(d, 'A').width === 260)
    expect(frameOf(doc, 'A')).toEqual({ ...A, width: 260, height: 220 }) // top-left corner fixed
    expect(doc.objects).toEqual(before.objects) // the member did not move, scale, or change owner

    await drag(page, o.at(560, 420), o.at(420, 290)) // 120 x 90: the member's centre is now outside
    doc = await storedWhen(page, (d) => frameOf(d, 'A').width === 120)
    expect(frameOf(doc, 'A')).toEqual({ ...A, width: 120, height: 90 })
    expect(obj(doc, 'member')).toEqual(image('member', 350, 250)) // released, and still exactly where it was

    await drag(page, o.at(420, 290), o.at(800, 600)) // grown back over it: growing never adopts
    doc = await storedWhen(page, (d) => frameOf(d, 'A').width === 500)
    expect(obj(doc, 'member')).not.toHaveProperty('frameId')

    await drag(page, o.at(800, 600), o.at(310, 205)) // squeezed to 10 x 5: each side stops at the minimum
    doc = await storedWhen(page, (d) => frameOf(d, 'A').width === 24)
    expect(frameOf(doc, 'A')).toEqual({ ...A, width: 24, height: 24 })
    expect(o.errors).toEqual([])
  })

  test('deleting the last frame keeps its images and stores a plain board again, in the same database', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
    const label = labelOf(o, A)
    await page.mouse.click(label.x, label.y)
    await page.keyboard.press('Delete')
    const doc = await storedWhen(page, (d) => d.version === 1)
    expect(doc).not.toHaveProperty('frames')
    expect(doc.objects).toEqual([image('member', 350, 250)]) // the image remains, loose
    expect(await dbVersion(page)).toBe(2) // the database is not demoted

    await undoButton(page).click()
    const back = await storedWhen(page, (d) => d.version === 2)
    expect(obj(back, 'member').frameId).toBe('A') // undo restores the owner
    expect(o.errors).toEqual([])
  })

  for (const button of ['right', 'middle'] as const) {
    test(`a ${button}-button press and release during a label drag does not end the drag`, async ({ page }) => {
      const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
      const start = labelOf(o, A)
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x + 50, start.y + 20, { steps: 4 })
      await page.mouse.down({ button })
      await page.mouse.move(start.x + 80, start.y + 30, { steps: 4 })
      await page.mouse.up({ button })
      await page.mouse.move(start.x + 110, start.y + 40, { steps: 4 })
      await page.mouse.move(start.x + 110, 10, { steps: 4 }) // outside the canvas
      await page.mouse.move(start.x + 160, start.y + 60, { steps: 4 })
      await page.mouse.up()
      const doc = await storedWhen(page, (d) => frameOf(d, 'A').left === 460)
      expect(frameOf(doc, 'A')).toMatchObject({ left: 460, top: 260 }) // followed the pointer to the end
      expect(obj(doc, 'member')).toMatchObject({ left: 510, top: 310, frameId: 'A' })
      expect(doc.viewport).toEqual(UNIT) // the middle button did not pan

      await waitSaved(page)
      const settled = await snapshotIdb(page)
      await page.mouse.move(start.x + 400, start.y + 300, { steps: 4 }) // after the release nothing follows the pointer
      await page.waitForTimeout(AUTOSAVE_QUIET_MS)
      expect(await snapshotIdb(page)).toEqual(settled)

      await undoButton(page).click()
      await expect(undoButton(page)).toBeDisabled() // exactly one step
      expect(o.errors).toEqual([])
    })
  }
})

test.describe('new text inside a frame', () => {
  test('a text that is opened and abandoned untouched is never stored, even if the view is panned meanwhile', async ({ page }) => {
    const A = frameRec('A', 300, 200, 400, 300)
    const o = await openFramed(page, [A], [])
    await page.keyboard.press('t')
    const p = o.at(360, 260)
    await page.mouse.click(p.x, p.y)
    await page.mouse.wheel(0, 120) // pans: the board is saved for a reason unrelated to the text
    const panned = await storedWhen(page, (d) => d.viewport.panY !== 0)
    expect(panned.objects).toEqual([])
    await page.keyboard.press('Escape')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect((await storedDoc(page)).objects).toEqual([])
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('Frame') // only the frame: no invisible text came back
    expect(o.errors).toEqual([])
  })

  test('is owned before its first save: after a reload in the middle of typing it belongs to the frame and moves with it', async ({ page }) => {
    const A = frameRec('A', 300, 200, 400, 300)
    const o = await openFramed(page, [A], [])
    await page.keyboard.press('t')
    const p = o.at(360, 260)
    await page.mouse.click(p.x, p.y)
    await page.keyboard.type('typed inside')
    const typed = await storedWhen(page, (d) => d.objects.length === 1 && d.objects[0]!.text === 'typed inside')
    expect(typed.objects[0]).toMatchObject({ type: 'text', frameId: 'A' }) // owner stored by the save made while typing
    await waitSaved(page)

    await page.reload() // without ever leaving the edit
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    const textId = typed.objects[0]!.id
    const left = typed.objects[0]!.left

    const label = labelOf(o, A)
    await drag(page, label, { x: label.x + 100, y: label.y })
    const moved = await storedWhen(page, (d) => frameOf(d, 'A').left === 400)
    expect(obj(moved, textId)).toMatchObject({ left: left + 100, frameId: 'A' })
    expect(o.errors).toEqual([])
  })
})

test.describe('frame panel and toolbar', () => {
  const A = frameRec('A', 300, 200, 400, 300, 'Cover')
  const nameField = (page: Page) => page.getByLabel('Name')
  const itemCount = (page: Page) => page.getByTestId('frame-item-count')
  const withContents = (page: Page) => page.getByRole('button', { name: 'Select with contents' })

  test('the Frame button arms the tool, draws a frame, and releases itself', async ({ page }) => {
    const o = await openLegacy(page, [image('i1', 300, 200)])
    const button = page.getByRole('button', { name: 'Frame', exact: true })
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await button.click() // clicking again puts it away
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()
    await drag(page, o.at(600, 150), o.at(900, 400))
    await expect(button).toHaveAttribute('aria-pressed', 'false') // single-use
    await expect(title(page)).toHaveText('Frame')
    await expect(nameField(page)).toHaveValue('Frame 1')
    await expect(itemCount(page)).toHaveText('Nothing yet')
    await expect(withContents(page)).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Delete frame' })).toBeVisible()
    await storedWhen(page, (d) => (d.frames ?? []).length === 1)
    expect(o.errors).toEqual([])
  })

  test('renaming in the panel: Enter commits, Esc reverts, blank falls back; one undo restores the old name', async ({ page }) => {
    const o = await openFramed(page, [A], [])
    const label = labelOf(o, A)
    await page.mouse.click(label.x, label.y)
    const name = nameField(page)
    await expect(name).toHaveValue('Cover')

    await name.fill('  Back   cover ')
    await name.press('Enter')
    await expect(name).toHaveValue('Back cover') // normalized, and shown as stored
    let doc = await storedWhen(page, (d) => frameOf(d, 'A').name === 'Back cover')
    expect(doc.frames).toEqual([{ ...A, name: 'Back cover' }]) // nothing but the name changed
    await expect(title(page)).toHaveText('Frame') // still selected

    await name.fill('Thrown away')
    await name.press('Escape')
    await expect(name).toHaveValue('Back cover')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(frameOf(await storedDoc(page), 'A').name).toBe('Back cover')

    // Typing a name must not trigger canvas shortcuts: real key presses for tools, zoom, layers, pan and delete.
    await name.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('vht fi x[]0=-')
    await page.keyboard.press('Space')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Enter')
    doc = await storedWhen(page, (d) => frameOf(d, 'A').name === 'vht fi x[]0=-')
    expect(doc.frames).toHaveLength(1) // the frame was not deleted
    expect(doc.viewport).toEqual(UNIT) // nothing zoomed or panned
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true') // no tool was switched
    await expect(title(page)).toHaveText('Frame')

    await page.waitForTimeout(1000) // past the coalescing window: the next rename is a step of its own
    await name.fill('   ')
    await name.press('Enter')
    await expect(name).toHaveValue('Frame')
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'Frame')

    await undoButton(page).click()
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'vht fi x[]0=-') // exactly the name before it
    expect(o.errors).toEqual([])
  })

  test('a name being typed is kept when the pointer goes elsewhere: the board, the frame own label, a drag, a panel button', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
    const label = labelOf(o, A)
    const name = nameField(page)
    const typeName = async (text: string) => {
      await page.mouse.click(label.x, label.y)
      await name.click()
      await page.keyboard.press('Control+a')
      await page.keyboard.type(text)
    }

    await typeName('Clicked away')
    const empty = o.at(900, 600)
    await page.mouse.click(empty.x, empty.y) // empty board: this also deselects the frame
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'Clicked away')
    await expect(page.locator('.inspector')).toHaveCount(0)

    await typeName('Clicked the label')
    await page.mouse.click(label.x, label.y)
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'Clicked the label')
    await expect(name).toHaveValue('Clicked the label')

    await typeName('Dragged')
    await drag(page, label, { x: label.x + 60, y: label.y + 30 }) // the same press commits the name and moves the frame
    const moved = await storedWhen(page, (d) => frameOf(d, 'A').left === 360)
    expect(frameOf(moved, 'A')).toMatchObject({ name: 'Dragged', left: 360, top: 230 })
    expect(obj(moved, 'member')).toMatchObject({ left: 410, top: 280 })

    const now = { x: label.x + 60, y: label.y + 30 }
    await page.mouse.click(now.x, now.y)
    await name.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('With contents')
    await withContents(page).click()
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'With contents')
    await expect(title(page)).toHaveText('2 objects')

    // Clicking Undo with a name still being typed: the name is committed, and is the step Undo takes back.
    // Nothing is lost: Redo returns it.
    await page.keyboard.press('Escape')
    await page.mouse.click(now.x, now.y)
    await page.waitForTimeout(1000) // past the coalescing window, so this rename is a step of its own
    await name.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Typed then undone')
    await undoButton(page).click()
    await expect(name).toHaveValue('With contents')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(frameOf(await storedDoc(page), 'A').name).toBe('With contents')
    await redoButton(page).click()
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'Typed then undone')
    await undoButton(page).click()
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'With contents')

    // Esc is still the way to throw a typed name away.
    await page.keyboard.press('Escape')
    await page.mouse.click(now.x, now.y)
    await name.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Discarded')
    await page.keyboard.press('Escape')
    await page.mouse.click(empty.x, empty.y)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(frameOf(await storedDoc(page), 'A').name).toBe('With contents')
    expect(o.errors).toEqual([])
  })

  test('double-clicking a frame label puts the cursor in the name field', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
    const label = labelOf(o, A)
    await page.mouse.dblclick(label.x, label.y)
    await expect(nameField(page)).toBeFocused()
    await page.keyboard.type('Typed over it')
    await page.keyboard.press('Enter')
    await storedWhen(page, (d) => frameOf(d, 'A').name === 'Typed over it')
    await expect(undoButton(page)).toBeEnabled()
    await undoButton(page).click()
    await expect(undoButton(page)).toBeDisabled() // the double-click itself moved nothing and recorded nothing
    expect(o.errors).toEqual([])
  })

  test('the item count shows what a frame owns, not what merely sits inside it', async ({ page }) => {
    const o = await openFramed(page, [A], [image('owned', 320, 220, { frameId: 'A' }), image('guest', 480, 360)]) // both inside A
    const label = labelOf(o, A)
    await page.mouse.click(label.x, label.y)
    await expect(itemCount(page)).toHaveText('1 item')
    await withContents(page).click()
    await expect(title(page)).toHaveText('2 objects') // the frame and the one thing it owns
    await page.keyboard.press('Escape')

    await drag(page, o.at(580, 420), o.at(585, 424)) // nudge the guest: now it belongs
    await storedWhen(page, (d) => obj(d, 'guest').frameId === 'A')
    await page.mouse.click(label.x, label.y)
    await expect(itemCount(page)).toHaveText('2 items')
    expect(o.errors).toEqual([])
  })

  test('Select with contents: frame, a rotated image and a text scale together proportionally, each exactly once', async ({ page }) => {
    const view: View = { zoom: 0.5, panX: 100, panY: 60 }
    const big = frameRec('A', 200, 200, 1000, 700)
    const text = { type: 'text', id: 'txt', left: 300, top: 650, angle: 0, text: 'Caption', fontSize: 40, width: 400, frameId: 'A' }
    const o = await openFramed(
      page,
      [big],
      [image('tilted', 500, 350, { angle: 20, scaleX: 2, scaleY: 2, frameId: 'A' }), text, image('guest', 900, 300)], // "guest" sits inside A but is loose
      view,
    )
    const before = await storedDoc(page)
    const label = labelOf(o, big)
    await page.mouse.click(label.x, label.y)
    await expect(itemCount(page)).toHaveText('2 items')
    await withContents(page).click()
    await expect(title(page)).toHaveText('3 objects')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(page)).toEqual(before) // selecting records nothing
    await expect(undoButton(page)).toBeDisabled()

    // Bottom-right corner of the selection (the frame is its bounding box) dragged inward: 1000 -> 750 wide.
    await drag(page, o.at(1200, 900), o.at(950, 725), { steps: 10 })
    const scaled = await storedWhen(page, (d) => frameOf(d, 'A').width !== 1000)
    const k = frameOf(scaled, 'A').width / 1000
    expect(k).toBeGreaterThan(0.7)
    expect(k).toBeLessThan(0.8)
    const check = (doc: StoredBoard) => {
      const f = frameOf(doc, 'A')
      expect(f.left).toBe(200) // anchored at the selection's top-left corner
      expect(f.top).toBe(200)
      expect(f.height).toBeCloseTo(700 * k, 1) // proportional, although a frame alone would be free
      const img = obj(doc, 'tilted')
      expect(img.scaleX).toBeCloseTo(2 * k, 3) // once, not k squared
      expect(img.scaleY).toBeCloseTo(2 * k, 3)
      expect(img.angle).toBe(20)
      expect(img.left).toBeCloseTo(200 + (500 - 200) * k, 1)
      expect(img.top).toBeCloseTo(200 + (350 - 200) * k, 1)
      const t = obj(doc, 'txt')
      expect(t.fontSize).toBeCloseTo(40 * k, 1) // folded into the font size
      expect(t.width).toBeCloseTo(400 * k, 1)
      expect(t.left).toBeCloseTo(200 + (300 - 200) * k, 1)
      expect(t.top).toBeCloseTo(200 + (650 - 200) * k, 1)
      expect(img.frameId).toBe('A')
      expect(t.frameId).toBe('A')
      expect(obj(doc, 'guest')).toEqual(obj(before, 'guest')) // not part of it: untouched and still loose
    }
    check(scaled)
    await waitSaved(page)

    await page.keyboard.press('Escape') // deselecting changes nothing: scales were folded and baked
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(page)).toEqual(scaled)

    await undoButton(page).click()
    await storedWhen(page, (d) => frameOf(d, 'A').width === 1000)
    expect((await storedDoc(page)).objects).toEqual(before.objects) // exact pre-gesture records
    expect((await storedDoc(page)).frames).toEqual(before.frames)
    await redoButton(page).click()
    await storedWhen(page, (d) => frameOf(d, 'A').width !== 1000)
    expect(await storedDoc(page)).toEqual(scaled)

    await waitSaved(page)
    await page.reload()
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(page)).toEqual(scaled) // no drift from loading

    // The same selection dragged: everything moves once; the loose guest stays.
    const moved = labelOf(o, big)
    await page.mouse.click(moved.x, moved.y)
    await withContents(page).click()
    await expect(title(page)).toHaveText('3 objects')
    const grab = o.at(250, 250)
    await drag(page, grab, { x: grab.x + 40, y: grab.y + 30 }) // 80 x 60 in the scene at zoom 0.5
    const dragged = await storedWhen(page, (d) => frameOf(d, 'A').left === 280)
    expect(frameOf(dragged, 'A')).toMatchObject({ left: 280, top: 260 })
    expect(obj(dragged, 'tilted').left).toBeCloseTo(obj(scaled, 'tilted').left + 80, 1)
    expect(obj(dragged, 'tilted').top).toBeCloseTo(obj(scaled, 'tilted').top + 60, 1)
    expect(obj(dragged, 'txt').left).toBeCloseTo(obj(scaled, 'txt').left + 80, 1)
    expect(obj(dragged, 'txt').top).toBeCloseTo(obj(scaled, 'txt').top + 60, 1)
    expect(obj(dragged, 'guest')).toEqual(obj(before, 'guest'))
    expect(o.errors).toEqual([])
  })
})

// =================================================================================================
// Mixed selections, the single scale factor, and gestures on frames
// =================================================================================================

/** Reloads and waits until the board is editable again and nothing more is being written. */
async function reloadSettled(page: Page) {
  await waitSaved(page)
  await page.reload()
  await expect(page.locator('.toolbar')).toBeVisible()
  await expect(status(page)).toContainText('Saved on this device')
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
}

/** Undo gives the exact earlier board, redo the exact later one, and a reload changes neither. */
async function expectStableThroughUndoRedoReload(page: Page, before: StoredBoard, after: StoredBoard, changed: (d: StoredBoard) => boolean) {
  await undoButton(page).click()
  await storedWhen(page, (d) => !changed(d))
  const undone = await storedDoc(page)
  expect(undone.frames).toEqual(before.frames)
  expect(undone.objects).toEqual(before.objects) // exact pre-gesture records
  await redoButton(page).click()
  await storedWhen(page, changed)
  const redone = await storedDoc(page)
  expect(redone.frames).toEqual(after.frames)
  expect(redone.objects).toEqual(after.objects)
  await reloadSettled(page)
  const reloaded = await storedDoc(page)
  expect(reloaded.frames).toEqual(after.frames)
  expect(reloaded.objects).toEqual(after.objects) // no drift from loading
}

test.describe('a mixed selection', () => {
  test('frame + member + text + a rotated loose image: each moves once, the follower is carried, and a Shift-held corner scale stays uniform with no drift', async ({ page }) => {
    const A = frameRec('A', 300, 200, 500, 400)
    const cap = { type: 'text', id: 'cap', left: 340, top: 470, angle: 0, text: 'Caption', fontSize: 24, width: 200, frameId: 'A' }
    const o = await openFramed(page, [A], [
      image('picked', 340, 240, { frameId: 'A' }),
      image('carried', 560, 440, { scaleX: 0.5, scaleY: 0.5, frameId: 'A' }), // a member that is NOT selected
      cap,
      image('tilted', 900, 300, { angle: 30 }), // loose, outside the frame, rotated
    ])
    const selectFour = async (dx: number, dy: number) => {
      const label = labelOf(o, { left: A.left + dx, top: A.top + dy })
      await page.mouse.click(label.x, label.y)
      await page.keyboard.down('Shift')
      for (const [x, y] of [
        [440, 300], // picked
        [400, 482], // cap
        [960, 420], // tilted (inside its rotated body)
      ] as const) {
        const p = o.at(x + dx, y + dy)
        await page.mouse.click(p.x, p.y)
      }
      await page.keyboard.up('Shift')
      await expect(title(page)).toHaveText('4 objects')
    }
    const before = await storedDoc(page)

    await selectFour(0, 0)
    const grab = o.at(440, 300)
    await drag(page, grab, { x: grab.x + 40, y: grab.y + 20 })
    const moved = await storedWhen(page, (d) => frameOf(d, 'A').left === 340)
    expect(frameOf(moved, 'A')).toMatchObject({ left: 340, top: 220, width: 500, height: 400 })
    expect(obj(moved, 'picked')).toMatchObject({ left: 380, top: 260, frameId: 'A' }) // once
    expect(obj(moved, 'cap')).toMatchObject({ left: 380, top: 490, frameId: 'A' })
    expect(obj(moved, 'carried')).toMatchObject({ left: 600, top: 460, frameId: 'A' }) // the follower, once
    expect(obj(moved, 'tilted')).toMatchObject({ left: 940, top: 320, angle: 30 })
    expect(obj(moved, 'tilted')).not.toHaveProperty('frameId') // moved together with A: stays loose

    // The follower is a real object at its new place: it can be selected there.
    await page.keyboard.press('Escape')
    const follower = o.at(650, 490)
    await page.mouse.click(follower.x, follower.y)
    await expect(title(page)).toHaveText('Image')
    await page.keyboard.press('Escape')
    await waitSaved(page)

    // Scale from the selection's top-left handle (the frame's corner) with Shift held.
    await selectFour(40, 20)
    const handle = o.at(340, 220)
    await page.keyboard.down('Shift')
    await drag(page, handle, { x: handle.x + 90, y: handle.y + 20 }, { steps: 10 })
    await page.keyboard.up('Shift')
    const scaled = await storedWhen(page, (d) => frameOf(d, 'A').width !== 500)
    const k = frameOf(scaled, 'A').width / 500
    expect(k).toBeGreaterThan(0.6)
    expect(k).toBeLessThan(0.98)
    const f = frameOf(scaled, 'A')
    expect(f.height).toBeCloseTo(400 * k, 1) // uniform although Shift was held
    expect(f.top + f.height).toBeCloseTo(620, 1) // the bottom edge (the anchor's y) did not move
    expect(obj(scaled, 'picked').scaleX).toBeCloseTo(k, 3)
    expect(obj(scaled, 'picked').scaleY).toBeCloseTo(k, 3)
    expect(obj(scaled, 'picked').left - f.left).toBeCloseTo(40 * k, 1)
    expect(obj(scaled, 'picked').top - f.top).toBeCloseTo(40 * k, 1)
    expect(obj(scaled, 'cap').fontSize).toBeCloseTo(24 * k, 1)
    expect(obj(scaled, 'cap').width).toBeCloseTo(200 * k, 1)
    expect(obj(scaled, 'cap').left - f.left).toBeCloseTo(40 * k, 1)
    expect(obj(scaled, 'cap').top - f.top).toBeCloseTo(270 * k, 1)
    expect(obj(scaled, 'tilted').scaleX).toBeCloseTo(k, 3)
    expect(obj(scaled, 'tilted').angle).toBe(30)
    expect(obj(scaled, 'tilted').left - f.left).toBeCloseTo(600 * k, 1)
    expect(obj(scaled, 'tilted').top - f.top).toBeCloseTo(100 * k, 1)
    expect(obj(scaled, 'carried')).toEqual(obj(moved, 'carried')) // not selected: not scaled, still inside, still A's
    expect(obj(scaled, 'picked').frameId).toBe('A')
    expect(obj(scaled, 'cap').frameId).toBe('A')
    expect(obj(scaled, 'tilted')).not.toHaveProperty('frameId')
    await waitSaved(page)

    await page.keyboard.press('Escape') // deselect: nothing changes
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await storedDoc(page)).toEqual(scaled)
    await expectStableThroughUndoRedoReload(page, moved, scaled, (d) => frameOf(d, 'A').width !== 500)
    expect(before.frames).toEqual([A])
    expect(o.errors).toEqual([])
  })
})

test.describe('gestures on a frame', () => {
  const A = frameRec('A', 300, 200, 400, 300)

  test('a save during a held frame drag stores the new title and the pre-drag frame and members; release stores the final ones', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
    const before = await storedDoc(page)
    const titleInput = page.locator('input[aria-label="Board title"]')
    await titleInput.fill('Renamed mid-drag')
    await titleInput.press('Enter')
    const label = labelOf(o, A)
    await drag(page, label, { x: label.x + 150, y: label.y + 90 }, { hold: true })
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    const during = await storedDoc(page)
    expect(during.title).toBe('Renamed mid-drag')
    expect(during.frames).toEqual(before.frames) // not the half-dragged frame
    expect(during.objects).toEqual(before.objects) // nor its half-carried member

    await page.mouse.up()
    const after = await storedWhen(page, (d) => frameOf(d, 'A').left === 450)
    expect(frameOf(after, 'A')).toMatchObject({ left: 450, top: 290 })
    expect(obj(after, 'member')).toMatchObject({ left: 500, top: 340, frameId: 'A' })
    expect(o.errors).toEqual([])
  })

  test('Esc during a frame drag puts the frame and its members back and records nothing', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
    const before = await snapshotIdb(page)
    const label = labelOf(o, A)
    await drag(page, label, { x: label.x + 200, y: label.y + 120 }, { hold: true })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before)
    await expect(undoButton(page)).toBeDisabled()
    // The member is back too: it is grabbed where it was.
    await drag(page, o.at(450, 310), o.at(460, 310))
    const doc = await storedWhen(page, (d) => obj(d, 'member').left === 360)
    expect(obj(doc, 'member').frameId).toBe('A')
    expect(o.errors).toEqual([])
  })

  test('a file chosen during a frame drag becomes its own undo step after the drag', async ({ page }) => {
    const o = await openFramed(page, [A], [image('member', 350, 250, { frameId: 'A' })])
    const label = labelOf(o, A)
    await page.mouse.move(label.x, label.y)
    await page.mouse.down()
    await page.mouse.move(label.x + 100, label.y + 40, { steps: 4 })
    await page.setInputFiles('input[type=file]', [imageFile('late.png', 80, 60, 3)])
    await page.waitForTimeout(400) // decoding ends while the pointer is still held
    expect((await storedDoc(page)).objects).toHaveLength(1)
    await page.mouse.up()
    const both = await storedWhen(page, (d) => d.objects.length === 2 && frameOf(d, 'A').left === 400)
    expect(obj(both, 'member')).toMatchObject({ left: 450, top: 290 })

    await undoButton(page).click() // first: only the import
    const noImport = await storedWhen(page, (d) => d.objects.length === 1)
    expect(frameOf(noImport, 'A').left).toBe(400)
    await undoButton(page).click() // second: the drag, frame and member together
    const original = await storedWhen(page, (d) => frameOf(d, 'A').left === 300)
    expect(obj(original, 'member')).toMatchObject({ left: 350, top: 250 })
    await expect(undoButton(page)).toBeDisabled() // exactly two steps

    const again = labelOf(o, A)
    await drag(page, again, { x: again.x - 50, y: again.y }) // a following drag works
    await storedWhen(page, (d) => frameOf(d, 'A').left === 250)
    expect(o.errors).toEqual([])
  })
})

test.describe('one scale factor for everything in a selection that contains a frame', () => {
  test('text-limited enlargement: a 300px text stops the frame, the image and itself at exactly 400/300', async ({ page }) => {
    const view: View = { zoom: 0.25, panX: 200, panY: 100 }
    const F1 = frameRec('F', 400, 400, 1600, 1000)
    const text = { type: 'text', id: 'txt', left: 500, top: 900, angle: 0, text: 'Big', fontSize: 300, width: 900, frameId: 'F' }
    const o = await openFramed(page, [F1], [image('img', 500, 500, { scaleX: 2, scaleY: 2, frameId: 'F' }), text], view)
    const before = await storedDoc(page)
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('3 objects')
    const handle = o.at(400, 400) // top-left of the selection, which is the frame; the anchor is its bottom-right (2000, 1400)
    await drag(page, handle, { x: handle.x - 380, y: handle.y - 240 }, { steps: 12 }) // asks for about 2x
    const after = await storedWhen(page, (d) => obj(d, 'txt').fontSize === 400)
    const k = 400 / 300
    expect(obj(after, 'txt')).toMatchObject({ fontSize: 400, frameId: 'F' }) // the limit, exactly
    expect(obj(after, 'txt').width).toBeCloseTo(900 * k, 1)
    expect(obj(after, 'txt').left).toBeCloseTo(2000 - 1500 * k, 1)
    expect(obj(after, 'txt').top).toBeCloseTo(1400 - 500 * k, 1)
    expect(obj(after, 'img').scaleX).toBeCloseTo(2 * k, 4) // the same factor, not 2x
    expect(obj(after, 'img').scaleY).toBeCloseTo(2 * k, 4)
    expect(obj(after, 'img').left).toBeCloseTo(2000 - 1500 * k, 1)
    expect(obj(after, 'img').top).toBeCloseTo(1400 - 900 * k, 1)
    const f = frameOf(after, 'F')
    expect(f.width).toBeCloseTo(1600 * k, 1)
    expect(f.height).toBeCloseTo(1000 * k, 1)
    expect(f.left + f.width).toBeCloseTo(2000, 1) // the anchor corner stayed put
    expect(f.top + f.height).toBeCloseTo(1400, 1)
    await expectStableThroughUndoRedoReload(page, before, after, (d) => obj(d, 'txt').fontSize !== 300)
    expect(o.errors).toEqual([])
  })

  test('frame-limited reduction: a 30-unit frame stops itself and its contents at exactly 24/30', async ({ page }) => {
    const view: View = { zoom: 8, panX: -600, panY: -600 }
    const small = frameRec('S', 100, 100, 30, 40)
    const text = { type: 'text', id: 'txt', left: 105, top: 120, angle: 0, text: 'ab', fontSize: 8, width: 20, frameId: 'S' }
    const o = await openFramed(page, [small], [image('img', 105, 105, { scaleX: 0.05, scaleY: 0.05, frameId: 'S' }), text], view)
    const before = await storedDoc(page)
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('3 objects')
    const handle = o.at(130, 140) // bottom-right; the anchor is the top-left (100, 100)
    await drag(page, handle, o.at(114, 119), { steps: 12 }) // asks for about half
    const after = await storedWhen(page, (d) => frameOf(d, 'S').width !== 30)
    const k = 24 / 30
    expect(frameOf(after, 'S')).toEqual({ ...small, width: 24, height: 32 }) // exactly the minimum on its smaller side
    expect(obj(after, 'img').scaleX).toBeCloseTo(0.05 * k, 5) // the contents stopped with it, not at one half
    expect(obj(after, 'img').scaleY).toBeCloseTo(0.05 * k, 5)
    expect(obj(after, 'img')).toMatchObject({ left: 104, top: 104, frameId: 'S' })
    expect(obj(after, 'txt')).toMatchObject({ fontSize: 6.4, width: 16, left: 104, top: 116, frameId: 'S' })
    await expectStableThroughUndoRedoReload(page, before, after, (d) => frameOf(d, 'S').width !== 30)
    expect(o.errors).toEqual([])
  })

  test('an out-of-range 500px text: the selection may shrink (everything by the same factor) but not grow, and the text is never snapped to 400', async ({ page }) => {
    const view: View = { zoom: 0.25, panX: 200, panY: 100 }
    const F1 = frameRec('F', 400, 400, 2400, 1400)
    const text = { type: 'text', id: 'txt', left: 500, top: 700, angle: 0, text: 'Huge', fontSize: 500, width: 2000, frameId: 'F' }
    const o = await openFramed(page, [F1], [image('img', 500, 450, { frameId: 'F' }), text], view)
    const before = await storedDoc(page)
    const untouched = await snapshotIdb(page)
    await page.keyboard.press('Control+a')
    const handle = o.at(400, 400)

    await drag(page, handle, { x: handle.x - 100, y: handle.y - 60 }, { steps: 10 }) // about 1.2x: not allowed at all
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(untouched) // nothing changed, nothing saved
    await expect(undoButton(page)).toBeDisabled()

    await drag(page, handle, { x: handle.x + 30, y: handle.y + 18 }, { steps: 10 }) // about 0.95x
    const after = await storedWhen(page, (d) => obj(d, 'txt').fontSize !== 500)
    const k = obj(after, 'txt').fontSize! / 500
    expect(k).toBeGreaterThan(0.9)
    expect(k).toBeLessThan(0.99)
    expect(obj(after, 'txt').width).toBeCloseTo(2000 * k, 0)
    expect(obj(after, 'img').scaleX).toBeCloseTo(k, 3)
    expect(frameOf(after, 'F').width).toBeCloseTo(2400 * k, 0)
    expect(frameOf(after, 'F').height).toBeCloseTo(1400 * k, 0)
    await expectStableThroughUndoRedoReload(page, before, after, (d) => obj(d, 'txt').fontSize !== 500)
    expect(o.errors).toEqual([])
  })

  test('a frame already below the minimum: the selection cannot shrink and is not snapped up, but it can grow; alone, its small side cannot shrink either', async ({ page }) => {
    const view: View = { zoom: 4, panX: -200, panY: -300 }
    const thin = frameRec('T', 100, 100, 10, 100)
    const o = await openFramed(page, [thin], [image('img', 102, 110, { scaleX: 0.02, scaleY: 0.02, frameId: 'T' })], view)
    const before = await storedDoc(page)
    const untouched = await snapshotIdb(page)
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('2 objects')
    const handle = o.at(110, 200) // bottom-right; anchor top-left

    await drag(page, handle, o.at(107, 170), { steps: 8 }) // shrink: blocked, and NOT pushed up to 24
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(untouched)

    await drag(page, handle, o.at(115, 250), { steps: 8 }) // about 1.5x: fine
    const grown = await storedWhen(page, (d) => frameOf(d, 'T').width !== 10)
    const k = frameOf(grown, 'T').width / 10
    expect(k).toBeGreaterThan(1.3)
    expect(k).toBeLessThan(1.7)
    expect(frameOf(grown, 'T').height).toBeCloseTo(100 * k, 1)
    expect(obj(grown, 'img').scaleX).toBeCloseTo(0.02 * k, 4)
    expect(obj(grown, 'img').left).toBeCloseTo(100 + 2 * k, 1)
    expect(obj(grown, 'img').top).toBeCloseTo(100 + 10 * k, 1)
    await expectStableThroughUndoRedoReload(page, before, grown, (d) => frameOf(d, 'T').width !== 10)

    // Alone: its narrow side cannot shrink (and is not snapped up); its long side can, down to the minimum; and it can grow.
    const width = frameOf(grown, 'T').width
    const bottom = 100 + frameOf(grown, 'T').height
    const label = labelOf(o, thin)
    await page.mouse.click(label.x, label.y)
    await expect(title(page)).toHaveText('Frame')
    await drag(page, o.at(100 + width, bottom), o.at(103, 160), { steps: 8 })
    const squeezed = await storedWhen(page, (d) => frameOf(d, 'T').height === 60)
    expect(frameOf(squeezed, 'T')).toMatchObject({ left: 100, top: 100, width, height: 60 })
    await drag(page, o.at(100 + width, 160), o.at(140, 180), { steps: 8 })
    const widened = await storedWhen(page, (d) => frameOf(d, 'T').width === 40)
    expect(frameOf(widened, 'T')).toMatchObject({ width: 40, height: 80 })
    expect(o.errors).toEqual([])
  })

  test('a tiny image scale survives: 0.00001 scaled to 0.4 of itself is stored as a positive number and the board reloads editable', async ({ page }) => {
    const A = frameRec('A', 300, 200, 400, 300)
    const o = await openFramed(page, [A], [image('speck', 400, 300, { scaleX: 0.00001, scaleY: 0.00001, frameId: 'A' })])
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('2 objects')
    await drag(page, o.at(700, 500), o.at(460, 320), { steps: 12 }) // the frame to 160 x 120: a factor of 0.4
    const after = await storedWhen(page, (d) => frameOf(d, 'A').width !== 400)
    const k = frameOf(after, 'A').width / 400
    expect(k).toBeCloseTo(0.4, 2)
    const speck = obj(after, 'speck')
    expect(speck.scaleX).toBeGreaterThan(0) // plain 5-decimal rounding would have stored 0 and made the board unreadable
    expect(speck.scaleX! / 0.00001).toBeCloseTo(k, 3)
    expect(speck.scaleY).toBe(speck.scaleX)
    await reloadSettled(page)
    await expect(page.getByTestId('readonly-banner')).toHaveCount(0) // the stored document still parses
    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('2 objects') // frame and image both intact
    expect(o.errors).toEqual([])
  })
})

test.describe('a drifted owner', () => {
  test('a frame text that grew out of its frame is still the frame after Ctrl+A and move, and a loose image inside the frame still is not', async ({ page }) => {
    const A = frameRec('A', 300, 200, 400, 300)
    const note = { type: 'text', id: 'note', left: 340, top: 440, angle: 0, text: 'note', fontSize: 24, width: 200, frameId: 'A' }
    const o = await openFramed(page, [A], [note, image('guest', 400, 240)]) // "guest" sits inside A, loose
    const inside = o.at(350, 452)
    await page.mouse.dblclick(inside.x, inside.y) // edit the existing text
    await page.keyboard.press('Control+End')
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('Enter')
      await page.keyboard.type('more')
    }
    await page.keyboard.press('Escape')
    const grown = await storedWhen(page, (d) => (obj(d, 'note').text ?? '').split('\n').length === 10)
    expect(obj(grown, 'note').frameId).toBe('A') // re-editing never changes the owner, although its centre is now below the frame
    await waitSaved(page)

    await page.keyboard.press('Control+a')
    await expect(title(page)).toHaveText('3 objects')
    const grab = o.at(500, 300) // on the guest image, inside the selection
    await drag(page, grab, { x: grab.x + 60, y: grab.y + 20 })
    const moved = await storedWhen(page, (d) => frameOf(d, 'A').left === 360)
    expect(obj(moved, 'note')).toMatchObject({ left: 400, top: 460, frameId: 'A' })
    expect(obj(moved, 'guest')).toMatchObject({ left: 460, top: 260 })
    expect(obj(moved, 'guest')).not.toHaveProperty('frameId') // moved together with the frame: still loose

    await reloadSettled(page)
    const label = labelOf(o, { left: 360, top: 220 })
    await drag(page, label, { x: label.x + 100, y: label.y })
    const carried = await storedWhen(page, (d) => frameOf(d, 'A').left === 460)
    expect(obj(carried, 'note')).toMatchObject({ left: 500, top: 460, frameId: 'A' }) // the frame alone carries its text ...
    expect(obj(carried, 'guest')).toEqual(obj(moved, 'guest')) // ... and leaves the image behind
    expect(o.errors).toEqual([])
  })
})
