import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import type { Scene } from '../src/model/types.ts'
import { AUTOSAVE_QUIET_MS, openApp, openBlank, sceneToPage, seedRaw, snapshotIdb, status, storedDoc, tamperIdb } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredFrame, StoredObject, View } from './helpers.ts'

/**
 * The DOM renderer (plan Slice 2c-i) in real Chromium: frame paper, images and text drawn by the
 * scene layer under a transparent Fabric canvas of proxies. The renderer is chosen only by
 * `window.__YURIFUL_RENDERER__ = 'dom'`, set before the app mounts (as nothing else can reach
 * it). A probe on the normal app instance (like `feel-helpers.ts`) reads the proxies and the
 * layer; it lives in this test route only.
 *
 * In this slice text is static on the DOM path (no live editing); everything here is what a
 * board does without typing: loading, drawing, selecting, moving, scaling, rotating, frame
 * ownership, undo, saving and whole-box formatting.
 */

type Corner = { x: number; y: number }

interface DomProbe {
  renderer: () => 'dom' | 'fabric'
  scene: () => Scene
  history: () => Scene
  /** A proxy's four corners (tl, tr, br, bl) in page pixels, from its live matrix and size. */
  proxy: (id: string) => Corner[] | null
  /** The four corners of the layer's element for an id, in page pixels, as the browser lays it out. */
  dom: (id: string) => Corner[] | null
  /** The DOM order of the layer's items, back to front. */
  order: () => { frames: string[]; objects: string[] }
  /** Fabric's handle positions of the active object, in page pixels. */
  controls: () => Record<string, Corner> | null
  /** The alpha of the canvas's own pixels (lower canvas) at a page point: proxies paint nothing. */
  canvasAlpha: (x: number, y: number) => number
  run: (method: string, ...args: unknown[]) => void
  /** Scene-space bounds of an object (Fabric's bounding rect). */
  bounds: (id: string) => { left: number; top: number; right: number; bottom: number } | null
}

declare global {
  interface Window {
    __dom: DomProbe
    __YURIFUL_RENDERER__?: string
  }
}

/** Observes the normal app instance (route-only hook, as `feel-helpers.ts` does). */
async function installProbe(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: `
      import { Editor as ProbeEditor } from '/src/editor/Editor.ts'
      import { idOf as probeIdOf } from '/src/editor/objects.ts'
      const probeInit = ProbeEditor.prototype.init
      ProbeEditor.prototype.init = function () {
        const ed = this
        const find = (id) => ed.canvas.getObjects().find((o) => probeIdOf(o) === id)
        const toPage = (sx, sy) => {
          const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
          const v = ed.canvas.viewportTransform
          return { x: r.left + v[0] * sx + v[2] * sy + v[4], y: r.top + v[1] * sx + v[3] * sy + v[5] }
        }
        window.__dom = {
          renderer: () => (ed.scene ? 'dom' : 'fabric'),
          scene: () => ed.snapshot(),
          history: () => ed.history.current,
          proxy: (id) => {
            const o = find(id)
            if (!o) return null
            const m = o.calcTransformMatrix()
            const w = o.width / 2
            const h = o.height / 2
            return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => toPage(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]))
          },
          dom: (id) => {
            const el = document.querySelector('.scene-layer [data-id="' + id + '"]')
            if (!el) return null
            return [['tl', '0', '0'], ['tr', '100%', '0'], ['br', '100%', '100%'], ['bl', '0', '100%']].map(([k, left, top]) => {
              let mark = el.querySelector(':scope > [data-probe="' + k + '"]')
              if (!mark) {
                mark = document.createElement('i')
                mark.dataset.probe = k
                mark.style.cssText = 'position:absolute;width:0;height:0;left:' + left + ';top:' + top
                el.append(mark)
              }
              const r = mark.getBoundingClientRect()
              return { x: r.left, y: r.top }
            })
          },
          order: () => ({
            frames: [...document.querySelectorAll('.scene-frames > [data-id]')].map((e) => e.dataset.id),
            objects: [...document.querySelectorAll('.scene-objects > [data-id]')].map((e) => e.dataset.id),
          }),
          controls: () => {
            const a = ed.canvas.getActiveObject()
            if (!a) return null
            const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
            const out = {}
            for (const [k, c] of Object.entries(a.oCoords)) out[k] = { x: r.left + c.x, y: r.top + c.y }
            return out
          },
          canvasAlpha: (x, y) => {
            const el = ed.canvas.lowerCanvasEl
            const r = el.getBoundingClientRect()
            const ratio = el.width / r.width
            return el.getContext('2d').getImageData(Math.floor((x - r.left) * ratio), Math.floor((y - r.top) * ratio), 1, 1).data[3]
          },
          run: (method, ...args) => ed[method](...args),
          bounds: (id) => {
            const o = find(id)
            if (!o) return null
            const b = o.getBoundingRect()
            return { left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height }
          },
        }
        return probeInit.call(this)
      }
      ${source}
    `,
    })
  })
}

const chooseDomRenderer = (page: Page) =>
  page.addInitScript(() => {
    window.__YURIFUL_RENDERER__ = 'dom'
  })

const errorsOf = (page: Page) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/** Seeds a board, then opens the app on it with the given renderer (DOM unless said otherwise). */
async function openBoard(page: Page, board: StoredBoard, assets: SeedAsset[], renderer: 'dom' | 'fabric' = 'dom') {
  await openBlank(page)
  await seedRaw(page, board.frames?.length ? 2 : 1, board as unknown as Record<string, unknown>, assets)
  if (renderer === 'dom') await chooseDomRenderer(page)
  await installProbe(page)
  await openApp(page)
  expect(await page.evaluate(() => window.__dom.renderer())).toBe(renderer)
  await frames(page, 2)
  return sceneToPage(page, board.viewport)
}

/** Lets Fabric render (and so the layer follow) a few times. */
const frames = (page: Page, n = 2) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise<number>((resolve) => requestAnimationFrame(resolve))
  }, n)

/** The largest distance between a proxy's corners and its DOM item's corners, in page pixels. */
async function drift(page: Page, id: string): Promise<number> {
  const { proxy, dom } = await page.evaluate((id) => ({ proxy: window.__dom.proxy(id), dom: window.__dom.dom(id) }), id)
  if (!proxy || !dom) throw new Error(`no proxy or item for ${id}`)
  return Math.max(...proxy.map((p, i) => Math.hypot(p.x - dom[i]!.x, p.y - dom[i]!.y)))
}

async function expectTracked(page: Page, ids: readonly string[], when: string) {
  await frames(page, 2)
  for (const id of ids) expect(await drift(page, id), `${id} ${when}`).toBeLessThanOrEqual(0.5)
}

const stored = async (page: Page) => (await storedDoc(page)) as StoredBoard

const ASSETS: SeedAsset[] = [
  { id: 'quad', name: 'quad.png', width: 160, height: 120, pattern: 'quadrants' },
  { id: 'grad', name: 'grad.png', width: 200, height: 100, seed: 3 },
]

const frame = (patch: Partial<StoredFrame> = {}): StoredFrame => ({ id: 'F', name: 'Spread', left: 200, top: 120, width: 520, height: 420, ...patch })
const image = (id: string, left: number, top: number, patch: Partial<StoredObject> = {}): StoredObject => ({ type: 'image', id, assetId: 'quad', left, top, angle: 0, scaleX: 1, scaleY: 1, ...patch })
const text = (id: string, left: number, top: number, value: string, patch: Partial<StoredObject> = {}): StoredObject => ({ type: 'text', id, left, top, angle: 0, text: value, fontSize: 24, width: 220, ...patch })

const board = (frames: StoredFrame[], objects: StoredObject[], viewport: View = { zoom: 1, panX: 0, panY: 0 }): StoredBoard => ({
  version: frames.length ? 2 : 1,
  title: 'Interleaving',
  ...(frames.length && { frames }),
  objects,
  viewport,
})

/** The screen's pixels in `clip`, decoded in the page as `window.__shot`. */
async function shot(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const png = (await page.screenshot({ clip })).toString('base64')
  await page.evaluate(async (png) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    ;(window as unknown as { __shot: ImageData }).__shot = ctx.getImageData(0, 0, c.width, c.height)
  }, png)
}

const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(({ x, y }) => {
    const s = (window as unknown as { __shot: ImageData }).__shot
    const i = (Math.round(y) * s.width + Math.round(x)) * 4
    return [s.data[i]!, s.data[i + 1]!, s.data[i + 2]!]
  }, { x, y })

const near = (a: number[], b: readonly number[], tol = 14) => a.every((v, i) => Math.abs(v - b[i]!) <= tol)
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

test.describe('the DOM renderer, static (Slice 2c-i)', () => {
  test('z-order-text-image-text-with-frame-outline-and-paper-stack: text, image, text in stacking order over frame paper, with outline and label on top', async ({ page }) => {
    const errors = errorsOf(page)
    // Text A (pink box) under image I (quadrants) under text B (teal box), all over frame F's
    // paper; image J crosses the frame's left outline and lies under its label.
    const A = text('A', 260, 200, 'Under', { captionBackground: '#ff40c0', width: 200, minHeight: 120 })
    const I = image('I', 380, 230)
    const B = text('B', 470, 300, 'Over', { captionBackground: '#20c0b0', width: 200, minHeight: 80 })
    const J = image('J', 150, 90, { assetId: 'grad' })
    const at = await openBoard(page, board([frame()], [A, I, B, J]), ASSETS)

    expect(await page.evaluate(() => window.__dom.order())).toEqual({ frames: ['F'], objects: ['A', 'I', 'B', 'J'] })
    const origin = at(0, 0)
    await shot(page, { x: origin.x, y: origin.y, width: 900, height: 620 })
    const local = (x: number, y: number) => ({ x: at(x, y).x - origin.x, y: at(x, y).y - origin.y })
    const px = async (x: number, y: number) => {
      const p = local(x, y)
      return pixel(page, p.x, p.y)
    }
    // Paper inside the frame where nothing lies; the board backdrop outside it.
    expect(near(await px(680, 520), [255, 255, 255], 3), 'frame paper').toBe(true)
    expect(near(await px(760, 560), hex('#f1f3f8'), 8), 'board outside the frame').toBe(true)
    // A alone shows its box; where I covers A the image shows (top-left quadrant, red family).
    expect(near(await px(300, 280), hex('#ff40c0')), 'text A where nothing covers it').toBe(true)
    const underImage = await px(392, 242)
    expect(underImage[0]! > 100 && underImage[1]! < 80 && underImage[2]! < 80, `image I over text A ${underImage}`).toBe(true)
    // B over I: B's box shows where both lie.
    expect(near(await px(500, 320), hex('#20c0b0')), 'text B over image I').toBe(true)
    // The frame's outline and label are drawn over image J, which covers both.
    const outlineX = Math.round(local(200, 0).x)
    const columns = await Promise.all([outlineX - 1, outlineX, outlineX + 1].map((x) => pixel(page, x, local(0, 160).y)))
    expect(columns.some((c) => near(c, hex('#c2c8d6'), 20)), `outline over image J ${JSON.stringify(columns)}`).toBe(true)
    const label: number[][] = []
    for (let x = 6; x < 60; x += 1) label.push(await pixel(page, local(200, 0).x + x, local(0, 120).y - 9))
    expect(label.some((c) => c.every((v) => v < 140)), 'the label is drawn over image J').toBe(true)
    // The canvas itself paints no paper and no item: only chrome (nothing is selected here).
    for (const p of [at(680, 520), at(300, 280), at(392, 242), at(500, 320)]) expect(await page.evaluate(({ x, y }) => window.__dom.canvasAlpha(x, y), p)).toBe(0)
    // Every item lies exactly under its proxy.
    await expectTracked(page, ['F', 'A', 'I', 'B', 'J'], 'at rest')

    // Bringing A to the front draws it over I and B.
    await page.mouse.click(at(300, 280).x, at(300, 280).y)
    await page.keyboard.press('Control+]')
    await frames(page, 2)
    expect((await page.evaluate(() => window.__dom.order())).objects).toEqual(['I', 'B', 'J', 'A'])
    await page.keyboard.press('Escape')
    await frames(page, 2)
    await shot(page, { x: origin.x, y: origin.y, width: 900, height: 620 })
    expect(near(await px(392, 242), hex('#ff40c0')), 'A now over I').toBe(true)
    expect(errors).toEqual([])
  })

  test('group-scale-once-and-frame-ownership-on-dom-proxies: a frame with its text and image scales once, and ownership follows only movement', async ({ page }) => {
    const errors = errorsOf(page)
    const T = text('T', 240, 160, 'Notes on the sleeve', { frameId: 'F', width: 200 })
    const I = image('I', 420, 300, { frameId: 'F', scaleX: 0.5, scaleY: 0.5 })
    const L = image('L', 800, 200, { assetId: 'grad', scaleX: 0.5, scaleY: 0.5 })
    const view: View = { zoom: 0.8, panX: 40, panY: 30 }
    const at = await openBoard(page, board([frame()], [T, I, L], view), ASSETS)

    // Select the frame by its label, then the frame with its contents.
    await page.mouse.click(at(200, 120).x + 12, at(200, 120).y - 9)
    await page.getByRole('button', { name: 'Select with contents' }).click()
    const before = (await page.evaluate(() => window.__dom.scene())) as Scene
    const br = (await page.evaluate(() => window.__dom.controls()))!.br!
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x + 80, br.y + 60, { steps: 8 })
    await expectTracked(page, ['F', 'T', 'I'], 'during the group scale')
    await page.mouse.up()
    await expect(status(page)).toContainText('Saved on this device')
    await expectTracked(page, ['F', 'T', 'I', 'L'], 'after the group scale settled')

    const after = (await page.evaluate(() => window.__dom.scene())) as Scene
    const f0 = before.frames[0]!
    const f1 = after.frames[0]!
    const k = f1.width / f0.width
    expect(k).toBeGreaterThan(1.1)
    expect(f1.height / f0.height).toBeCloseTo(k, 2)
    const t0 = before.objects.find((o) => o.id === 'T')!
    const t1 = after.objects.find((o) => o.id === 'T')!
    const i0 = before.objects.find((o) => o.id === 'I')!
    const i1 = after.objects.find((o) => o.id === 'I')!
    if (t0.type !== 'text' || t1.type !== 'text' || i0.type !== 'image' || i1.type !== 'image') throw new Error('kinds')
    // Once, not twice: font size, wrap width and image scale grow by k, not k².
    expect(t1.fontSize / t0.fontSize).toBeCloseTo(k, 1)
    expect(t1.width / t0.width).toBeCloseTo(k, 1)
    expect(i1.scaleX / i0.scaleX).toBeCloseTo(k, 2)
    // Positions scale about the anchor (the frame's top-left) by the same k.
    expect((t1.left - f1.left) / (t0.left - f0.left)).toBeCloseTo(k, 1)
    expect((i1.top - f1.top) / (i0.top - f0.top)).toBeCloseTo(k, 1)
    // Stored as one step, with ownership unchanged.
    const saved = await stored(page)
    expect(saved.objects.map((o) => [o.id, o.frameId])).toEqual([['T', 'F'], ['I', 'F'], ['L', undefined]])

    // Moving the frame over the loose image leaves it loose; moving the text out of the frame frees it.
    await page.keyboard.press('Escape')
    const label = { x: at(f1.left, f1.top).x + 12, y: at(f1.left, f1.top).y - 9 }
    await page.mouse.move(label.x, label.y)
    await page.mouse.down()
    await page.mouse.move(label.x + 200 * view.zoom, label.y, { steps: 6 })
    await expectTracked(page, ['F', 'T', 'I'], 'members carried by the frame')
    await page.mouse.up()
    await expect(status(page)).toContainText('Saved on this device')
    await expectTracked(page, ['F', 'T', 'I', 'L'], 'after the frame moved')
    let scene = (await page.evaluate(() => window.__dom.scene())) as Scene
    expect(scene.objects.map((o) => [o.id, o.frameId])).toEqual([['T', 'F'], ['I', 'F'], ['L', undefined]])
    const t2 = scene.objects.find((o) => o.id === 'T')!
    const grab = at(t2.left + 20, t2.top + 10)
    await page.mouse.move(grab.x, grab.y)
    await page.mouse.down()
    await page.mouse.move(grab.x, grab.y + 900 * view.zoom > 780 ? 780 : grab.y + 600 * view.zoom, { steps: 6 })
    await page.mouse.up()
    await expect(status(page)).toContainText('Saved on this device')
    scene = (await page.evaluate(() => window.__dom.scene())) as Scene
    expect(scene.objects.find((o) => o.id === 'T')!.frameId).toBeUndefined()
    await expectTracked(page, ['T'], 'after the text left the frame')
    expect(errors).toEqual([])
  })

  test('readonly-dom-scene-blocks-selection-and-writes: a board that could not be fully restored is drawn by the layer and nothing selects or writes', async ({ page }) => {
    const errors = errorsOf(page)
    const T = text('T', 260, 420, 'Read only', { frameId: 'F' })
    const I = image('I', 300, 180, { frameId: 'F' })
    const I2 = image('I2', 520, 300, { assetId: 'grad', frameId: 'F' })
    const doc = board([frame()], [I, I2, T])
    await openBlank(page)
    await seedRaw(page, 2, doc as unknown as Record<string, unknown>, ASSETS)
    await tamperIdb(page, 'corrupt-second-asset') // 'quad' sorts second: image I no longer decodes
    const before = await snapshotIdb(page)
    await chooseDomRenderer(page)
    await installProbe(page)
    await page.goto('/')
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(page.getByTestId('readonly-banner')).toContainText('could not be loaded')
    expect(await page.evaluate(() => window.__dom.renderer())).toBe('dom')
    await frames(page, 2)
    // The layer draws what could be shown: the frame's paper, the text's card, the image that loaded.
    await expect(page.locator('.scene-frame[data-id="F"]')).toBeVisible()
    await expect(page.locator('.scene-text[data-id="T"]')).toHaveText('Read only')
    await expect(page.locator('.scene-image[data-id="I2"] img')).toHaveCount(1)
    await expectTracked(page, ['F', 'T', 'I2'], 'on a read-only board')

    const at = await sceneToPage(page, doc.viewport)
    await page.mouse.click(at(560, 340).x, at(560, 340).y) // the image that did load
    await page.mouse.click(at(212, 111).x, at(212, 111).y) // the frame's label
    await page.mouse.dblclick(at(280, 430).x, at(280, 430).y) // the text
    await page.keyboard.type('nope')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+b')
    await page.keyboard.press('Delete')
    await page.mouse.move(at(560, 340).x, at(560, 340).y)
    await page.mouse.down()
    await page.mouse.move(at(660, 400).x, at(660, 400).y, { steps: 5 }) // pans the view instead
    await page.mouse.up()
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expectTracked(page, ['F', 'T', 'I2'], 'after a pan on a read-only board')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    const after = await snapshotIdb(page)
    expect(after).toEqual(before) // not one byte written, pruned or upgraded
    await expect(status(page)).toContainText('Not saving')
    expect(errors).toEqual([])
  })

  test('every stored field round-trips through a load and a save on the DOM renderer', async ({ page }) => {
    const errors = errorsOf(page)
    const F2: StoredFrame = { id: 'G', name: 'Locked frame', left: 760, top: 120, width: 300, height: 260, locked: true }
    const objects: StoredObject[] = [
      image('crop', 240, 150, { frameId: 'F', crop: { x: 20.5, y: 10, width: 100.25, height: 80 }, scaleX: 1.25, scaleY: 1.25, angle: 12.5 }),
      image('plain', 470, 160, { assetId: 'grad', scaleX: 0.75, scaleY: 0.6, locked: true }),
      text('rich', 250, 330, 'Heading line\nbold and italic words', {
        frameId: 'F', fontSize: 20, width: 260.5, font: 'serif', align: 'center', color: '#2f5d8a',
        headings: [2], spans: [{ start: 13, end: 17, bold: true }, { start: 22, end: 28, italic: true, font: 'mono' }],
      }),
      text('drawn', 520, 360, 'drawn box', { fontSize: 18.5, width: 150, minHeight: 64.25, angle: -8, locked: true }),
      text('caption', 240, 255, 'A caption', { frameId: 'F', width: 125.31, minHeight: 0, captionOf: 'crop', captionSide: 'left', captionPosition: 0.5, captionBackground: '#fdf3c4' }),
      text('styled', 800, 200, 'Styled note', { frameId: 'G', captionBackground: '#e0f0ff', align: 'right' }),
    ]
    const doc = board([frame(), F2], objects, { zoom: 1.2, panX: -60, panY: -20 })
    await openBoard(page, doc, ASSETS)
    const loaded = (await page.evaluate(() => window.__dom.scene())) as Scene
    expect(loaded.frames).toEqual(doc.frames)
    expect(loaded.objects).toEqual(doc.objects)
    // A view change saves the board (its viewport): every record is written back exactly as stored.
    await page.mouse.move(640, 400)
    await page.mouse.wheel(0, 120)
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(700)
    const saved = await stored(page)
    expect(saved.version).toBe(2)
    expect(saved.frames).toEqual(doc.frames)
    expect(saved.objects).toEqual(doc.objects)
    expect(saved.objects.filter((o) => 'blocks' in o || 'height' in o || 'surface' in o)).toEqual([])
    expect(errors).toEqual([])
  })

  test('a board edited and saved on the DOM renderer reopens identically on the Fabric renderer', async ({ context, page }) => {
    const errors = errorsOf(page)
    const objects: StoredObject[] = [
      image('img', 260, 180, { frameId: 'F', crop: { x: 10, y: 10, width: 120, height: 90 } }),
      text('note', 250, 340, 'Front sleeve notes\nsecond line', { frameId: 'F', width: 260, headings: [1], spans: [{ start: 19, end: 25, italic: true }] }),
      text('loose', 760, 380, 'Loose words here', { width: 200, minHeight: 40 }),
    ]
    const doc = board([frame()], objects)
    const at = await openBoard(page, doc, ASSETS)
    // Edits on the DOM renderer: move the image, scale the loose text, make the note bold and centred.
    await page.mouse.move(at(300, 220).x, at(300, 220).y)
    await page.mouse.down()
    await page.mouse.move(at(340, 200).x, at(340, 200).y, { steps: 5 })
    await page.mouse.up()
    await page.mouse.click(at(780, 395).x, at(780, 395).y)
    const br = (await page.evaluate(() => window.__dom.controls()))!.br!
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x + 40, br.y + 20, { steps: 5 })
    await page.mouse.up()
    await page.mouse.click(at(270, 350).x, at(270, 350).y)
    await page.keyboard.press('Control+b')
    await page.evaluate(() => window.__dom.run('setTextAlign', 'center'))
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(700)
    const domSaved = await stored(page)
    expect(domSaved.version).toBe(2)
    expect(domSaved.objects.filter((o) => 'blocks' in o || 'height' in o || 'surface' in o)).toEqual([])
    const domBounds = await page.evaluate((ids) => ids.map((id) => window.__dom.bounds(id)), ['F', 'img', 'note', 'loose'])

    // The same board in a page with the default renderer: nothing in it changes on load or on the next save.
    const fabric = await context.newPage()
    const fabricErrors = errorsOf(fabric)
    await installProbe(fabric)
    await openApp(fabric)
    expect(await fabric.evaluate(() => window.__dom.renderer())).toBe('fabric')
    const fabricScene = (await fabric.evaluate(() => window.__dom.scene())) as Scene
    expect(fabricScene.frames).toEqual(domSaved.frames)
    expect(fabricScene.objects).toEqual(domSaved.objects)
    await fabric.mouse.move(640, 400)
    await fabric.mouse.wheel(0, 120)
    await expect(status(fabric)).toContainText('Saved on this device')
    await fabric.waitForTimeout(700)
    const fabricSaved = await stored(fabric)
    expect(fabricSaved.version).toBe(2)
    expect(fabricSaved.frames).toEqual(domSaved.frames)
    expect(fabricSaved.objects).toEqual(domSaved.objects)
    // It looks the same: every box where the DOM renderer had it (text boxes within a pixel of each other's layout).
    const fabricBounds = await fabric.evaluate((ids) => ids.map((id) => window.__dom.bounds(id)), ['F', 'img', 'note', 'loose'])
    fabricBounds.forEach((b, i) => {
      const d = domBounds[i]!
      for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(b![k] - d[k]), `${i} ${k}`).toBeLessThanOrEqual(1)
    })
    expect(errors).toEqual([])
    expect(fabricErrors).toEqual([])
  })

  test('items stay exactly under their proxies while a text, a cropped image, a multi-selection and a frame are moved, scaled and turned, at zoom and pan', async ({ page }) => {
    const errors = errorsOf(page)
    const T = text('T', 260, 170, 'A text that wraps over lines', { frameId: 'F', width: 180, headings: [0, 0] })
    const C = image('C', 430, 180, { frameId: 'F', crop: { x: 30, y: 20, width: 100, height: 70 }, angle: 15 })
    const M = image('M', 300, 360, { assetId: 'grad', frameId: 'F', scaleX: 0.6, scaleY: 0.6 })
    const ids = ['F', 'T', 'C', 'M']
    const view: View = { zoom: 1.35, panX: -140, panY: -70 }
    const at = await openBoard(page, board([frame()], [T, C, M], view), ASSETS)
    await expectTracked(page, ids, 'at rest')

    /** One gesture on the thing under `from`; `id`'s record must change by it (`what`: the fields that must). */
    const gesture = async (from: Corner, to: Corner, label: string, id: string, what: readonly string[]) => {
      const before = ((await page.evaluate(() => window.__dom.scene())) as Scene)
      const recordOf = (scene: Scene) => (scene.objects.find((o) => o.id === id) ?? scene.frames.find((o) => o.id === id)) as unknown as Record<string, unknown>
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
      await expectTracked(page, ids, `${label}, half-way`)
      await page.mouse.move(to.x, to.y, { steps: 4 })
      await expectTracked(page, ids, `${label}, held`)
      await page.mouse.up()
      await expect(status(page)).toContainText('Saved on this device')
      await expectTracked(page, ids, `${label}, settled`)
      const after = recordOf((await page.evaluate(() => window.__dom.scene())) as Scene)
      for (const field of what) expect(after[field], `${label} changes ${id}.${field}`).not.toEqual(recordOf(before)[field])
    }
    const handle = async (name: string) => (await page.evaluate(() => window.__dom.controls()))![name]!

    // A single text: move, corner scale, side resize (re-wraps), rotate.
    await gesture(at(280, 180), at(300, 200), 'text move', 'T', ['left', 'top'])
    await page.mouse.click(at(290, 190).x, at(290, 190).y)
    await gesture(await handle('br'), { x: (await handle('br')).x + 30, y: (await handle('br')).y + 20 }, 'text scale', 'T', ['fontSize', 'width'])
    await gesture(await handle('mr'), { x: (await handle('mr')).x - 40, y: (await handle('mr')).y }, 'text side resize', 'T', ['width'])
    await gesture(await handle('mtr'), { x: (await handle('mtr')).x + 60, y: (await handle('mtr')).y + 20 }, 'text rotate', 'T', ['angle'])
    // The cropped, turned image: move, scale, rotate.
    await page.keyboard.press('Escape')
    const c = ((await page.evaluate(() => window.__dom.scene())) as Scene).objects.find((o) => o.id === 'C')!
    await page.mouse.click(at(c.left + 30, c.top + 30).x, at(c.left + 30, c.top + 30).y)
    await gesture(at(c.left + 30, c.top + 30), at(c.left + 60, c.top + 10), 'image move', 'C', ['left', 'top'])
    await gesture(await handle('tl'), { x: (await handle('tl')).x - 25, y: (await handle('tl')).y - 25 }, 'image scale', 'C', ['scaleX', 'scaleY'])
    await gesture(await handle('mtr'), { x: (await handle('mtr')).x - 50, y: (await handle('mtr')).y + 10 }, 'image rotate', 'C', ['angle'])
    // A multi-selection of the text and both images: move, scale, rotate.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+a') // frames included: rotation is locked for a selection with a frame
    await page.keyboard.press('Escape')
    const scene = (await page.evaluate(() => window.__dom.scene())) as Scene
    const first = scene.objects.find((o) => o.id === 'M')!
    await page.mouse.click(at(first.left + 10, first.top + 10).x, at(first.left + 10, first.top + 10).y)
    for (const id of ['T', 'C']) {
      const b = (await page.evaluate((id) => window.__dom.bounds(id), id))!
      const p = at((b.left + b.right) / 2, (b.top + b.bottom) / 2)
      await page.keyboard.down('Shift')
      await page.mouse.click(p.x, p.y)
      await page.keyboard.up('Shift')
    }
    await expect(page.locator('.inspector-title')).toContainText('3')
    const mb = (await page.evaluate(() => window.__dom.bounds('M')))!
    const inM = at((mb.left + mb.right) / 2, (mb.top + mb.bottom) / 2)
    await gesture(inM, { x: inM.x + 40, y: inM.y - 30 }, 'selection move', 'M', ['left', 'top'])
    await gesture(await handle('br'), { x: (await handle('br')).x + 30, y: (await handle('br')).y + 30 }, 'selection scale', 'M', ['scaleX'])
    await gesture(await handle('mtr'), { x: (await handle('mtr')).x + 70, y: (await handle('mtr')).y + 30 }, 'selection rotate', 'M', ['angle'])
    // The frame with its members (carried as unselected followers), and the frame resized alone.
    await page.keyboard.press('Escape')
    const f = ((await page.evaluate(() => window.__dom.scene())) as Scene).frames[0]!
    const label = { x: at(f.left, f.top).x + 12, y: at(f.left, f.top).y - 9 }
    await gesture(label, { x: label.x - 60, y: label.y + 40 }, 'frame move', 'F', ['left', 'top'])
    await gesture(await handle('br'), { x: (await handle('br')).x + 50, y: (await handle('br')).y + 25 }, 'frame resize', 'F', ['width', 'height'])
    expect(errors).toEqual([])
  })

  test('undo, redo and Esc restore the DOM scene exactly', async ({ page }) => {
    const errors = errorsOf(page)
    const T = text('T', 260, 170, 'Undo me', { frameId: 'F' })
    const I = image('I', 430, 260, { frameId: 'F' })
    const ids = ['F', 'T', 'I']
    const at = await openBoard(page, board([frame()], [T, I], { zoom: 1.25, panX: -80, panY: -40 }), ASSETS)
    const start = (await page.evaluate(() => window.__dom.scene())) as Scene
    const domOf = () => page.evaluate((ids) => ids.map((id) => window.__dom.dom(id)), ids)
    const startDom = await domOf()

    // Esc in the middle of a drag: back where it was, nothing recorded or saved.
    await page.mouse.move(at(450, 280).x, at(450, 280).y)
    await page.mouse.down()
    await page.mouse.move(at(520, 330).x, at(520, 330).y, { steps: 5 })
    await expectTracked(page, ids, 'mid-drag')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expectTracked(page, ids, 'after Esc')
    expect(await page.evaluate(() => window.__dom.scene())).toEqual(start)
    expect(await domOf()).toEqual(startDom)

    // A drag, then undo and redo.
    await page.mouse.move(at(450, 280).x, at(450, 280).y)
    await page.mouse.down()
    await page.mouse.move(at(520, 330).x, at(520, 330).y, { steps: 5 })
    await page.mouse.up()
    await expect(status(page)).toContainText('Saved on this device')
    const moved = (await page.evaluate(() => window.__dom.scene())) as Scene
    const movedDom = await domOf()
    expect(moved).not.toEqual(start)
    await page.keyboard.press('Control+z')
    await expectTracked(page, ids, 'after undo')
    expect(await page.evaluate(() => window.__dom.scene())).toEqual(start)
    expect(await domOf()).toEqual(startDom)
    await page.keyboard.press('Control+Shift+z')
    await expectTracked(page, ids, 'after redo')
    expect(await page.evaluate(() => window.__dom.scene())).toEqual(moved)
    expect(await domOf()).toEqual(movedDom)

    // A whole-box format, undone: the card is drawn as it was.
    await page.mouse.click(at(275, 180).x, at(275, 180).y)
    const cardBefore = await page.locator('.scene-text[data-id="T"] .scene-text-body').innerHTML()
    await page.keyboard.press('Control+b')
    await expect(page.locator('.scene-text[data-id="T"] .scene-text-body strong')).toHaveCount(1)
    await page.keyboard.press('Control+z')
    await frames(page, 2)
    expect(await page.locator('.scene-text[data-id="T"] .scene-text-body').innerHTML()).toBe(cardBefore)
    await expectTracked(page, ids, 'after undoing a format')
    expect(errors).toEqual([])
  })

  test('whole-box text commands give the same records on the DOM renderer as on the Fabric renderer', async ({ browser }) => {
    const objects: StoredObject[] = [
      text('t', 240, 180, 'First line here\nsecond line', { frameId: 'F', width: 280, spans: [{ start: 6, end: 10, italic: true, font: 'mono' }] }),
      text('d', 260, 360, 'Drawn note', { frameId: 'F', width: 220, minHeight: 50, align: 'right' }),
    ]
    const doc = board([frame()], objects)
    const steps: Array<[string, string, unknown]> = [
      ['t', 'toggleMark', 'bold'],
      ['t', 'toggleMark', 'underline'],
      ['t', 'setHeading', 2],
      ['t', 'toggleMark', 'bold'],
      ['t', 'setTextFont', 'serif'],
      ['t', 'setTextAlign', 'center'],
      ['t', 'setTextColor', '#b33a3a'],
      ['t', 'setHeading', 0],
      ['t', 'setFontSize', 30],
      ['d', 'toggleMark', 'strike'],
      ['d', 'setTextColor', '#1d2230'],
      ['d', 'setHeading', 3],
      ['d', 'setTextAlign', 'left'],
    ]
    const runAll = async (renderer: 'dom' | 'fabric') => {
      const context: BrowserContext = await browser.newContext()
      const page = await context.newPage()
      const errors = errorsOf(page)
      await openBoard(page, doc, ASSETS, renderer)
      const out: unknown[] = []
      for (const [id, method, arg] of steps) {
        await page.evaluate(({ id }) => window.__dom.run('selectLayer', id), { id })
        await page.evaluate(({ method, arg }) => window.__dom.run(method, arg), { method, arg })
        out.push(await page.evaluate(() => window.__dom.scene().objects))
        out.push(await page.evaluate(() => window.__dom.history().objects))
      }
      await expect(status(page)).toContainText('Saved on this device')
      await page.waitForTimeout(700)
      out.push((await stored(page)).objects)
      expect(errors).toEqual([])
      await context.close()
      return out
    }
    const dom = await runAll('dom')
    const fabric = await runAll('fabric')
    expect(dom).toEqual(fabric)
  })
})
