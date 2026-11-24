import { expect, test } from '@playwright/test'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import type { FeedbackSnapshot } from '../src/editor/feedbackLayer.ts'
import type { Scene } from '../src/model/types.ts'
import { fabricReference } from './fabricReference.ts'
import { AUTOSAVE_QUIET_MS, dropImage, openApp, openBlank, pngBuffer, sceneToPage, seedRaw, snapshotIdb, status, storedDoc, tamperIdb } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredFrame, StoredObject, View } from './helpers.ts'

/**
 * The scene layer (plan Slice 2c-i) in real Chromium: frame paper, images and text drawn by the
 * scene layer under a transparent Fabric canvas of proxies. The paired tests compare it with the
 * Fabric renderer it replaced, through frozen references of what that renderer gave for the same
 * script (`fabricReference.ts`, recorded by running it before it was deleted). A probe on the normal app instance (like `feel-helpers.ts`) reads the proxies and the
 * layer; it lives in this test route only.
 *
 * In this slice text is static on the DOM path (no live editing); everything here is what a
 * board does without typing: loading, drawing, selecting, moving, scaling, rotating, frame
 * ownership, undo, saving and whole-box formatting.
 */

type Corner = { x: number; y: number }

interface DomProbe {
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
  /** Crop mode: a crop handle's centre (or the box's, for 'move') in page pixels; null when crop mode is closed. */
  cropPoint: (handle: string) => Corner | null
  /** What the editor shows beyond the board: selection ids, layer rows, crop mode, undo, viewport. */
  state: () => ProbeState
  feedback: () => FeedbackSnapshot
  /** Ids of the layer items drawn lifted. */
  lifted: () => string[]
  /** Replaces an image with a generated PNG, as a picked file would (resolves once applied or staged). */
  replace: (id: string, base64: string, type?: string, name?: string) => Promise<void>
  /** Renders a frame's tour preview and returns its data URL. */
  preview: (frameId: string) => Promise<string>
}

interface ProbeState {
  selected: string[]
  layers: Array<{ id: string; kind: string; label: string; selected: boolean; frameName: string | null; locked: boolean }>
  cropping: boolean
  canUndo: boolean
  canRedo: boolean
  viewport: { zoom: number; panX: number; panY: number }
  jumpReturns: boolean
}

declare global {
  interface Window {
    __dom: DomProbe
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
      import { cropOverlay as probeCropOverlay } from '/src/editor/cropLayer.ts'
      import { CROP_HANDLES as probeCropHandles } from '/src/model/crop.ts'
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
          cropPoint: (handle) => {
            const s = ed.crop
            if (!s) return null
            const o = probeCropOverlay(s.full, s.size, s.rect, ed.canvas.viewportTransform)
            const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
            if (handle === 'move') {
              const x = o.box.reduce((n, p) => n + p.x, 0) / 4
              const y = o.box.reduce((n, p) => n + p.y, 0) / 4
              return { x: r.left + x, y: r.top + y }
            }
            const i = probeCropHandles.findIndex((h) => h.handle === handle)
            const p = o.handles[i]
            return p ? { x: r.left + p.x, y: r.top + p.y } : null
          },
          state: () => {
            const st = ed.getState()
            return {
              selected: ed.selectedIds(),
              layers: st.layers.map((l) => ({ ...l })),
              cropping: st.cropping,
              canUndo: st.canUndo,
              canRedo: st.canRedo,
              viewport: { ...st.viewport },
              jumpReturns: st.jumpReturns,
            }
          },
          feedback: () => ed.getFeedbackSnapshot(),
          lifted: () => [...document.querySelectorAll('.scene-item.is-lifted')].map((e) => e.dataset.id),
          replace: async (id, base64, type = 'image/png', name = 'replacement.png') => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
            await ed.replaceImageFile(id, new File([bytes], name, { type }))
          },
          preview: async (frameId) => {
            const tour = ed.startFrameTour()
            if (!tour) throw new Error('no tour')
            return tour.renderFrame(frameId, new AbortController().signal)
          },
        }
        return probeInit.call(this)
      }
      ${source}
    `,
    })
  })
}

const errorsOf = (page: Page) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/** Seeds a board, then opens the app on it. */
async function openBoard(page: Page, board: StoredBoard, assets: SeedAsset[]) {
  await openBlank(page)
  await seedRaw(page, board.frames?.length ? 2 : 1, board as unknown as Record<string, unknown>, assets)
  await installProbe(page)
  await openApp(page)
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
    await installProbe(page)
    await page.goto('/')
    await expect(page.locator('.toolbar')).toBeVisible()
    await expect(page.getByTestId('readonly-banner')).toContainText('could not be loaded')
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

  test('a board edited and saved on the DOM renderer reopens identically on the Fabric renderer', async ({ page }) => {
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

    // The same board in a page on the Fabric renderer: nothing in it changes on load or on the next
    // save. The reference holds the board it was given (what the DOM renderer saved when it was
    // recorded), what Fabric loaded and saved from it, and where Fabric put every box.
    const reopened = fabricReference<{ given: StoredBoard; scene: Scene; saved: StoredBoard; bounds: Array<{ left: number; top: number; right: number; bottom: number }> }>('reopened', { doc, edits: 'move img, scale loose, bold and centre note' })
    // Fabric changed nothing in the board it was given, on load or on its next save.
    expect(reopened.scene.frames).toEqual(reopened.given.frames)
    expect(reopened.scene.objects).toEqual(reopened.given.objects)
    expect(reopened.saved.version).toBe(2)
    expect(reopened.saved.frames).toEqual(reopened.given.frames)
    expect(reopened.saved.objects).toEqual(reopened.given.objects)
    // What the DOM renderer saves is what Fabric keeps (a text's measured geometry within the tolerance).
    expect(domSaved.frames).toEqual(reopened.saved.frames)
    expectSameRecords(domSaved.objects as never, reopened.saved.objects as never, 'saved on the DOM renderer, kept by Fabric')
    // It looks the same: every box where the DOM renderer had it (text boxes within a pixel of each other's layout).
    reopened.bounds.forEach((b, i) => {
      const d = domBounds[i]!
      for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(b[k] - d![k]), `${i} ${k}`).toBeLessThanOrEqual(1)
    })
    expect(errors).toEqual([])
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
    // The text is still selected after the move. (A click on it here would start an edit, as it
    // does on the canvas, and an edited text has no handles to drag.)
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
    const runAll = async () => {
      const context: BrowserContext = await browser.newContext()
      const page = await context.newPage()
      const errors = errorsOf(page)
      await openBoard(page, doc, ASSETS)
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
    const dom = await runAll()
    const fabric = fabricReference<unknown[]>('commands', { doc, steps })
    expect(dom).toEqual(fabric)
  })
})

// ---- paired with the Fabric renderer ------------------------------------------------------------
//
// The oracle the renderer switch depended on: the same board and the same actions give the same
// saved records as the Fabric renderer gave (its frozen reference, recorded by running the same
// script on it in a browser context of its own); the scene after every step and the stored board
// at the end are compared field by field.
//
// Tolerance: every field is compared exactly except a text's `left`, `top` and `width`, which may
// differ by at most GEOMETRY_TOLERANCE scene units. Those are the only values that depend on how
// a text is measured: the DOM lays a card out with CSS where Fabric measures with Canvas 2D, and
// the two agree within 0.08 px per box in height and 0.04 px in minimum width (Slice 2b,
// plan Section 6). A side handle anchors the middle of the opposite edge, so half a height
// difference reaches `top`; a word wider than the box sets `width` from its measured width; and
// stored values are rounded to 0.01, which can turn a 0.004 difference into 0.01.

const GEOMETRY_TOLERANCE = 0.1
/** A caption's snapped position is a fraction of the edge, taken from the text's measured centre: GEOMETRY_TOLERANCE over the shortest edge here. */
const CAPTION_POSITION_TOLERANCE = 0.001
const MEASURED = new Set(['left', 'top', 'width'])

type Step =
  | { select: string; also?: string }
  | { selectContents: string }
  | { handle: string; dx: number; dy: number }
  | { run: string; args?: unknown[] }

async function runScript(browser: Browser, doc: StoredBoard, steps: readonly Step[]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = errorsOf(page)
  await openBoard(page, doc, ASSETS)
  const scenes: Array<{ step: string; scene: Scene }> = []
  for (const step of steps) {
    if ('select' in step) {
      await page.evaluate(({ id, also }) => {
        window.__dom.run('selectLayer', id)
        if (also) window.__dom.run('selectLayer', also, { toggle: true })
      }, { id: step.select, also: step.also })
      await frames(page, 2)
      continue
    }
    if ('selectContents' in step) {
      await page.evaluate((id) => {
        window.__dom.run('selectLayer', id)
        window.__dom.run('selectFrameContents')
      }, step.selectContents)
      await frames(page, 2)
      continue
    }
    if ('run' in step) {
      await page.evaluate(({ method, args }) => window.__dom.run(method, ...args), { method: step.run, args: step.args ?? [] })
    } else {
      const h = (await page.evaluate(() => window.__dom.controls()))?.[step.handle]
      if (!h) throw new Error(`no ${step.handle} handle`)
      await page.mouse.move(h.x, h.y)
      await page.mouse.down()
      await page.mouse.move(h.x + step.dx, h.y + step.dy, { steps: 8 })
      await page.mouse.up()
    }
    await frames(page, 2)
    scenes.push({ step: JSON.stringify(step), scene: (await page.evaluate(() => window.__dom.scene())) as Scene })
  }
  await expect(status(page)).toContainText('Saved on this device')
  await page.waitForTimeout(700)
  const saved = await stored(page)
  expect(errors).toEqual([])
  await context.close()
  return { scenes, saved }
}

/** Every record field equal, a text's measured geometry within the tolerance; the largest difference found, for the report. */
function expectSameRecords(dom: readonly Record<string, unknown>[], fabric: readonly Record<string, unknown>[], where: string): number {
  expect(dom.map((r) => r.id), where).toEqual(fabric.map((r) => r.id))
  let worst = 0
  dom.forEach((d, i) => {
    const f = fabric[i]!
    expect(Object.keys(d).sort(), `${where} ${String(d.id)} keys`).toEqual(Object.keys(f).sort())
    for (const key of Object.keys(f)) {
      if (d.type === 'text' && key === 'captionPosition') {
        // A snap stores where the text's centre lies along the edge: it moves with the text's measured height or width.
        expect(Math.abs((d[key] as number) - (f[key] as number)), `${where} ${String(d.id)}.${key}: dom ${String(d[key])}, fabric ${String(f[key])}`).toBeLessThanOrEqual(CAPTION_POSITION_TOLERANCE)
      } else if (d.type === 'text' && MEASURED.has(key)) {
        const diff = Math.abs((d[key] as number) - (f[key] as number))
        worst = Math.max(worst, diff)
        expect(diff, `${where} ${String(d.id)}.${key}: dom ${String(d[key])}, fabric ${String(f[key])}`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
      } else {
        expect(d[key], `${where} ${String(d.id)}.${key}`).toEqual(f[key])
      }
    }
  })
  return worst
}

async function expectPaired(browser: Browser, doc: StoredBoard, steps: readonly Step[]) {
  const fabric = fabricReference<Awaited<ReturnType<typeof runScript>>>('script', { doc, steps })
  const dom = await runScript(browser, doc, steps)
  let worst = 0
  fabric.scenes.forEach((f, i) => {
    const d = dom.scenes[i]!
    worst = Math.max(worst, expectSameRecords(d.scene.objects as never, f.scene.objects as never, `after ${f.step}`))
    expect(d.scene.frames, `frames after ${f.step}`).toEqual(f.scene.frames)
  })
  worst = Math.max(worst, expectSameRecords(dom.saved.objects as never, fabric.saved.objects as never, 'saved'))
  expect(dom.saved.frames).toEqual(fabric.saved.frames)
  expect(dom.saved.version).toBe(fabric.saved.version)
  return { worst, fabric, dom }
}

/**
 * Narrow from the right, narrow from the left, then widen from each side. Widths stay at 70 or
 * more: a long card drifts by about 0.0125 px per line (plan Section 6, a known limit), which a
 * box one letter wide would multiply past the tolerance.
 */
const sideHandles = (id: string, narrowRight: number, narrowLeft: number, widen = 120): Step[] => [
  { select: id },
  { handle: 'mr', dx: -narrowRight, dy: 0 },
  { handle: 'ml', dx: narrowLeft, dy: 0 },
  { handle: 'mr', dx: widen, dy: 0 },
  { handle: 'ml', dx: -widen / 2, dy: 0 },
]

test.describe('the DOM renderer saves what the Fabric renderer saves (paired)', () => {
  const WORDS = 'the blue chair by the red door'
  const LONG = 'see supercalifragilistic here'

  test('side handles on click-created and drawn texts, left, centred and right aligned, with and without a word wider than the new width', async ({ browser }) => {
    const objects: StoredObject[] = [
      text('cl', 40, 60, WORDS, { width: 300 }),
      text('cc', 40, 190, WORDS, { width: 300, align: 'center' }),
      text('cr', 40, 320, LONG, { width: 330, align: 'right' }),
      text('dl', 470, 60, LONG, { width: 330, minHeight: 30 }),
      text('dc', 470, 190, WORDS, { width: 300, minHeight: 30, align: 'center' }),
      text('dr', 470, 320, LONG, { width: 330, minHeight: 0, align: 'right' }),
    ]
    const steps = [
      ...sideHandles('cl', 190, 30),
      ...sideHandles('cc', 150, 70),
      ...sideHandles('cr', 250, 60), // narrower than "supercalifragilistic": stops at it
      ...sideHandles('dl', 220, 40), // a drawn box cuts the word instead
      ...sideHandles('dc', 210, 20),
      ...sideHandles('dr', 230, 30),
    ]
    const { worst } = await expectPaired(browser, board([], objects), steps)
    console.log(`side handles, upright: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('side handles on rotated texts, at zoom and pan', async ({ browser }) => {
    const objects: StoredObject[] = [
      text('r1', 120, 120, WORDS, { width: 300, angle: 30 }),
      text('r2', 560, 140, LONG, { width: 320, minHeight: 20, angle: -20, align: 'center' }),
      text('r3', 200, 420, LONG, { width: 330, angle: 12, align: 'right' }),
    ]
    const steps = [...sideHandles('r1', 160, 50), ...sideHandles('r2', 200, 40), ...sideHandles('r3', 240, 60)]
    const { worst } = await expectPaired(browser, board([], objects, { zoom: 1.2, panX: -40, panY: -30 }), steps)
    console.log(`side handles, rotated: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('a text inside a frame near its edge keeps its owner exactly as on Fabric when a side handle makes it taller', async ({ browser }) => {
    // The frame ends at y = 255; the text starts at 225, one line high. Narrowed to wrap over
    // several lines, it grows about its middle (the handle's anchor), so its centre stays inside.
    const F: StoredFrame = { id: 'F', name: 'Edge', left: 300, top: 100, width: 420, height: 155 }
    const objects: StoredObject[] = [
      text('t', 330, 225, WORDS, { width: 350, minHeight: 0, frameId: 'F' }),
      text('u', 330, 120, WORDS, { width: 350, frameId: 'F' }),
    ]
    const steps: Step[] = [
      { select: 't' },
      { handle: 'mr', dx: -254, dy: 0 },
      { select: 'u' },
      { handle: 'ml', dx: 230, dy: 0 },
    ]
    const { dom, fabric } = await expectPaired(browser, board([F], objects), steps)
    for (const run of [dom, fabric]) expect(run.saved.objects.map((o) => [o.id, o.frameId])).toEqual([['t', 'F'], ['u', 'F']])
    expect(dom.saved.objects[0]!.top).toBeLessThan(200) // it grew upwards, as a text box does
  })

  test('corner scale of a text and of a frame with its contents', async ({ browser }) => {
    const F: StoredFrame = { id: 'F', name: 'Scaled', left: 420, top: 150, width: 360, height: 300 }
    const objects: StoredObject[] = [
      text('s', 80, 120, WORDS, { width: 220, minHeight: 90 }),
      text('w', 80, 360, WORDS, { width: 240 }),
      image('i', 450, 180, { frameId: 'F', scaleX: 0.75, scaleY: 0.75 }),
      text('m', 450, 330, WORDS, { width: 200, minHeight: 80, frameId: 'F' }),
    ]
    const steps: Step[] = [
      { select: 's' },
      { handle: 'br', dx: 70, dy: 40 },
      { select: 'w' },
      { handle: 'br', dx: 60, dy: 20 },
      { selectContents: 'F' },
      { handle: 'br', dx: 90, dy: 60 },
      { handle: 'tl', dx: 40, dy: 30 },
    ]
    const { worst } = await expectPaired(browser, board([F], objects), steps)
    console.log(`corner scale: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('a stored width narrower than the widest word is saved as Fabric saves it, after a title-only save', async ({ browser }) => {
    const objects: StoredObject[] = [
      text('narrow', 280, 260, 'supercalifragilisticexpialidocious', { width: 30, align: 'right' }),
      text('drawn', 280, 420, 'supercalifragilisticexpialidocious', { width: 10, minHeight: 0, align: 'center' }),
    ]
    const { dom, worst } = await expectPaired(browser, board([], objects), [{ run: 'setTitle', args: ['Renamed'] }])
    expect(dom.saved.title).toBe('Renamed')
    expect(dom.saved.objects[0]!.width).toBeGreaterThan(300)
    expect(dom.saved.objects[0]!.left).toBe(280) // widened from its left edge, as on load in Fabric
    console.log(`narrow stored width: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('Make caption gives the same caption as on Fabric', async ({ browser }) => {
    const objects: StoredObject[] = [image('pic', 300, 200), text('note', 520, 420, 'A caption for the picture', { width: 260 })]
    const { dom, worst } = await expectPaired(browser, board([], objects), [{ select: 'pic', also: 'note' }, { run: 'makeCaption' }])
    expect(dom.saved.objects.find((o) => o.id === 'note')?.captionOf).toBe('pic')
    console.log(`make caption: largest geometry difference ${worst.toFixed(3)}`)
  })
})

test.describe('the DOM renderer keeps the layer and the proxies together', () => {
  test('a text proxy that Make caption puts in place of a text is sized from its card before it is selected or committed', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [image('pic', 300, 200), text('note', 520, 420, 'A caption for the picture', { width: 260 })]), ASSETS)
    await page.evaluate(() => {
      window.__dom.run('selectLayer', 'pic')
      window.__dom.run('selectLayer', 'note', { toggle: true })
      window.__dom.run('makeCaption')
    })
    await expect(status(page)).toContainText('Saved on this device')
    const proxy = (await page.evaluate(() => window.__dom.proxy('note')))!
    expect(proxy[3]!.y - proxy[0]!.y).toBeGreaterThan(10) // a hit box as tall as the caption, not zero
    await expectTracked(page, ['note', 'pic'], 'after Make caption')
    expect(errors).toEqual([])
  })

  test('a text that grows into view is drawn (culling follows any change of size)', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('far', -900, 410, 'supercalifragilistic', { fontSize: 12, width: 140 }), image('img', 220, 330)]), ASSETS)
    const culled = () => page.evaluate(() => document.querySelector('.scene-layer [data-id="far"]')!.classList.contains('is-culled'))
    expect(await culled()).toBe(true)
    await page.evaluate(() => {
      window.__dom.run('selectLayer', 'far')
      window.__dom.run('setFontSize', 260)
    })
    await frames(page, 3)
    expect((await page.evaluate(() => window.__dom.bounds('far')))!.right).toBeGreaterThan(100)
    expect(await culled()).toBe(false)
    await expectTracked(page, ['far'], 'after growing into view')
    expect(errors).toEqual([])
  })

  test('a font that finishes loading during a gesture changes no card until the gesture has settled, then card and proxy change together', async ({ page }) => {
    const errors = errorsOf(page)
    const at = await openBoard(page, board([], [text('t', 350, 220, 'iiiiiiiiiiiiiiiiiii', { width: 35 }), image('i', 270, 380)]), ASSETS)
    const before = await snapshotIdb(page)
    await page.addStyleTag({ content: '.yuriful-prose, .yuriful-prose * { font-family: probefont, system-ui !important }' })
    await frames(page, 2)
    const p = at(300, 410)
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x + 12, p.y + 12, { steps: 4 })
    await expectTracked(page, ['t', 'i'], 'before the font loads')
    const widthBefore = await page.evaluate(() => (document.querySelector('.scene-layer [data-id="t"]') as HTMLElement).style.width)
    await page.evaluate(async () => {
      const face = new FontFace('probefont', 'local("Courier New")')
      document.fonts.add(face)
      await face.load()
      await document.fonts.ready
    })
    await frames(page, 4)
    await expectTracked(page, ['t', 'i'], 'while the font loads during the drag')
    expect(await page.evaluate(() => (document.querySelector('.scene-layer [data-id="t"]') as HTMLElement).style.width)).toBe(widthBefore)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await frames(page, 4)
    await expectTracked(page, ['t', 'i'], 'after the gesture')
    expect(await page.evaluate(() => (document.querySelector('.scene-layer [data-id="t"]') as HTMLElement).style.width)).not.toBe(widthBefore)
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(before) // a font load writes nothing
    expect(errors).toEqual([])
  })
})

test.describe('the live width floor is the text as formatted, not the plain-sans width a box is built with (paired)', () => {
  // A box built from a record is laid out in plain sans first and never narrows (effectiveCardWidth);
  // once it exists, a side handle stops at, and a change widens it to, its widest word as formatted.
  const WORD = 'SOUNDTRACK'

  test('side handles stop at the formatted word, from either side, in every alignment, for fonts narrower and wider than sans, bold and a heading', async ({ browser }) => {
    // Frame F ends at x = 372: narrowed to the monospace word, the first text's centre comes inside it.
    const F: StoredFrame = { id: 'F', name: 'Edge', left: 100, top: 240, width: 272, height: 200 }
    const objects: StoredObject[] = [
      text('mono', 300, 300, WORD, { width: 300, font: 'mono' }),
      text('monoC', 300, 380, WORD, { width: 300, font: 'mono', align: 'center' }),
      text('monoR', 300, 460, WORD, { width: 300, font: 'mono', align: 'right' }),
      text('impact', 700, 60, WORD, { width: 300, font: 'display', align: 'right' }),
      text('hand', 700, 160, WORD, { width: 320, font: 'hand' }),
      text('bold', 700, 260, WORD, { width: 300, align: 'center', spans: [{ start: 0, end: 10, bold: true }] }),
      text('head', 700, 360, WORD, { width: 340, headings: [1] }),
      text('span', 700, 480, `see ${WORD} now`, { width: 300, spans: [{ start: 4, end: 14, font: 'mono' }] }),
    ]
    const steps: Step[] = []
    for (const o of objects) steps.push({ select: o.id }, { handle: 'mr', dx: -250, dy: 0 }, { handle: 'ml', dx: 250, dy: 0 })
    const { dom, worst } = await expectPaired(browser, board([F], objects), steps)
    // The reviewer's case: stopped at the monospace word, inside F by its own movement.
    const mono = dom.saved.objects.find((o) => o.id === 'mono')!
    expect(mono.frameId).toBe('F')
    expect(mono.width!).toBeLessThan(145)
    console.log(`live floor, side handles: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('a font size change up and down on formatted text widens only as far as the formatted text needs', async ({ browser }) => {
    const W10 = 'WWWWWWWWWW'
    const objects: StoredObject[] = [
      text('l', 60, 80, W10, { width: 250, font: 'mono' }),
      text('c', 60, 200, W10, { width: 250, font: 'mono', align: 'center' }),
      text('r', 60, 320, W10, { width: 250, font: 'mono', align: 'right' }),
      text('mix', 500, 80, `a ${WORD} b\nsecond line`, { width: 240, headings: [2, 0], spans: [{ start: 2, end: 12, font: 'display' }] }),
      text('drawn', 500, 300, `${WORD} words`, { width: 200, minHeight: 20, font: 'mono', spans: [{ start: 0, end: 10, bold: true }] }),
    ]
    const steps: Step[] = []
    for (const o of objects) steps.push({ select: o.id }, { run: 'setFontSize', args: [42] }, { run: 'setFontSize', args: [16] }, { run: 'setFontSize', args: [30] })
    const { dom, worst } = await expectPaired(browser, board([], objects), steps)
    expect(dom.saved.objects.find((o) => o.id === 'l')!.width).toBe(250) // ten monospace W at 42 fit in 250 on Fabric
    console.log(`live floor, font size: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('undo and redo rebuild a narrowed box from its record, as Fabric builds it (plain sans counts again)', async ({ browser }) => {
    const objects: StoredObject[] = [text('mono', 300, 300, WORD, { width: 300, font: 'mono' }), text('head', 300, 420, WORD, { width: 340, headings: [1] })]
    const steps: Step[] = [
      { select: 'mono' },
      { handle: 'mr', dx: -250, dy: 0 },
      { run: 'undo' },
      { run: 'redo' },
      { select: 'head' },
      { handle: 'ml', dx: 250, dy: 0 },
      { run: 'undo' },
      { run: 'redo' },
    ]
    await expectPaired(browser, board([], objects), steps)
  })
})

test.describe('Fit only moves the view', () => {
  test('after the layout changed under a card (a late font), Fit measures for the view and changes no stored width', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('s', 300, 300, 'Georgia words here', { width: 155, font: 'serif' }), image('i', 700, 500)], { zoom: 0.5, panX: -100, panY: 300 }), ASSETS)
    // A late font with other metrics, simulated: wider glyphs, then the browser's "fonts loaded" signal.
    await page.addStyleTag({ content: '.yuriful-prose, .yuriful-prose * { letter-spacing: 12px !important }' })
    await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')))
    await frames(page, 3)
    await page.evaluate(() => window.__dom.run('setTitle', 'Renamed'))
    await expect(status(page)).toContainText('Saved on this device')
    await page.waitForTimeout(700)
    expect((await stored(page)).objects[0]!.width).toBe(155)
    await page.evaluate(() => window.__dom.run('fit'))
    await expect.poll(async () => (await stored(page)).viewport).not.toEqual({ zoom: 0.5, panX: -100, panY: 300 })
    expect((await stored(page)).objects[0]!.width).toBe(155)
    await expectTracked(page, ['s', 'i'], 'after Fit')
    expect(errors).toEqual([])
  })
})

// ---- Slice 2c-iii: the base branch's features on the DOM renderer -------------------------------
//
// Crop mode, Fit, Fill and Replace, captions and caption snapping, duplicate, locks, the layer list,
// the drag feedback and frame navigation, each run as one script from the same seeded board and
// compared with what the Fabric renderer gave for it (its frozen reference). After every step the scene, the history, what the editor shows (selection, layer
// rows, crop mode, undo, viewport) and, mid-drag, the feedback are compared; at the end the stored
// board. Same tolerance as above: only a text's left, top and width may differ, by at most
// GEOMETRY_TOLERANCE, and the measured parts of a snap preview likewise. Fresh ids (duplicates) are
// compared by the order in which they first appear.

type FeatureStep =
  | { select: string; also?: string[] }
  | { run: string; args?: unknown[] }
  | { key: string }
  /** Drags an item (grabbed at a fraction of its box, default its centre) so that its bounding box's top-left lands at `left`, `top`. */
  | { moveTo: string; left: number; top: number; at?: [number, number]; hold?: boolean; ctrl?: boolean }
  | { drag: string; dx: number; dy: number; at?: [number, number]; hold?: boolean }
  | { release: true; ctrl?: boolean }
  | { handle: string; dx: number; dy: number; hold?: boolean }
  | { crop: string; dx: number; dy: number }
  | { click: [number, number] }
  | { dblclick: string }
  | { replace: string; width: number; height: number; seed?: number }
  | { label: string; dx: number; dy: number }
  | { blur: true }

interface FeatureRecord {
  step: string
  scene: Scene
  history: Scene
  state: ProbeState
  feedback?: FeedbackSnapshot
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Fresh ids replaced by `~1`, `~2`... in the order they first appear. */
function normalizeIds<T>(value: T): T {
  const seen = new Map<string, string>()
  return JSON.parse(
    JSON.stringify(value).replace(UUID, (id) => {
      if (!seen.has(id)) seen.set(id, `~${seen.size + 1}`)
      return seen.get(id)!
    }),
  ) as T
}

/** A page point inside an item: its proxy's box at the fractions `at` (rotation included). */
async function pointIn(page: Page, id: string, at: [number, number] = [0.5, 0.5]): Promise<Corner> {
  const c = await page.evaluate((id) => window.__dom.proxy(id), id)
  if (!c) throw new Error(`no proxy ${id}`)
  const [fx, fy] = at
  const top = { x: c[0]!.x + (c[1]!.x - c[0]!.x) * fx, y: c[0]!.y + (c[1]!.y - c[0]!.y) * fx }
  const bottom = { x: c[3]!.x + (c[2]!.x - c[3]!.x) * fx, y: c[3]!.y + (c[2]!.y - c[3]!.y) * fx }
  return { x: top.x + (bottom.x - top.x) * fy, y: top.y + (bottom.y - top.y) * fy }
}

async function scenePoint(page: Page, x: number, y: number): Promise<Corner> {
  const box = await page.locator('.canvas-host').boundingBox()
  const v = (await page.evaluate(() => window.__dom.state())).viewport
  return { x: box!.x + x * v.zoom + v.panX, y: box!.y + y * v.zoom + v.panY }
}

async function pressAndMove(page: Page, from: Corner, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 })
}

/** A release where the pointer already is, Ctrl held when asked (Ctrl or Cmd at release suppresses a caption snap). */
async function releaseAt(page: Page, at: Corner, ctrl = false) {
  if (ctrl) {
    await page.keyboard.down('Control')
    await page.mouse.move(at.x + 0.5, at.y)
    await page.mouse.move(at.x, at.y)
  }
  await page.mouse.up()
  if (ctrl) await page.keyboard.up('Control')
}

async function runFeatureScript(browser: Browser, doc: StoredBoard, steps: readonly FeatureStep[], assets: SeedAsset[] = ASSETS) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = errorsOf(page)
  await openBoard(page, doc, assets)
  const records: FeatureRecord[] = []
  let last: Corner = { x: 0, y: 0 }
  for (const step of steps) {
    let feedback = false
    if ('select' in step) {
      await page.evaluate(
        ({ id, also }) => {
          window.__dom.run('selectLayer', id)
          for (const other of also) window.__dom.run('selectLayer', other, { toggle: true })
        },
        { id: step.select, also: step.also ?? [] },
      )
    } else if ('run' in step) {
      await page.evaluate(({ method, args }) => window.__dom.run(method, ...args), { method: step.run, args: step.args ?? [] })
    } else if ('key' in step) {
      await page.keyboard.press(step.key)
    } else if ('moveTo' in step) {
      const b = (await page.evaluate((id) => window.__dom.bounds(id), step.moveTo))!
      const v = (await page.evaluate(() => window.__dom.state())).viewport
      const from = await pointIn(page, step.moveTo, step.at)
      const dx = (step.left - b.left) * v.zoom
      const dy = (step.top - b.top) * v.zoom
      await pressAndMove(page, from, dx, dy)
      last = { x: from.x + dx, y: from.y + dy }
      if (step.hold) feedback = true
      else await releaseAt(page, last, step.ctrl)
    } else if ('drag' in step) {
      const from = await pointIn(page, step.drag, step.at)
      await pressAndMove(page, from, step.dx, step.dy)
      last = { x: from.x + step.dx, y: from.y + step.dy }
      if (step.hold) feedback = true
      else await releaseAt(page, last)
    } else if ('release' in step) {
      await releaseAt(page, last, step.ctrl)
    } else if ('handle' in step) {
      const h = (await page.evaluate(() => window.__dom.controls()))?.[step.handle]
      if (!h) throw new Error(`no ${step.handle} handle`)
      await pressAndMove(page, h, step.dx, step.dy)
      last = { x: h.x + step.dx, y: h.y + step.dy }
      if (step.hold) feedback = true
      else await releaseAt(page, last)
    } else if ('crop' in step) {
      const p = await page.evaluate((h) => window.__dom.cropPoint(h), step.crop)
      if (!p) throw new Error(`crop mode is not open (${step.crop})`)
      await pressAndMove(page, p, step.dx, step.dy)
      await page.mouse.up()
    } else if ('click' in step) {
      const p = await scenePoint(page, ...step.click)
      await page.mouse.click(p.x, p.y)
    } else if ('dblclick' in step) {
      const p = await pointIn(page, step.dblclick)
      await page.mouse.dblclick(p.x, p.y)
    } else if ('replace' in step) {
      const png = pngBuffer(step.width, step.height, step.seed ?? 5).toString('base64')
      await page.evaluate(({ id, png }) => window.__dom.replace(id, png), { id: step.replace, png })
    } else if ('label' in step) {
      const b = (await page.evaluate((id) => window.__dom.bounds(id), step.label))!
      const p = await scenePoint(page, b.left, b.top)
      await pressAndMove(page, { x: p.x + 12, y: p.y - 9 }, step.dx, step.dy)
      await page.mouse.up()
    } else {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    }
    await frames(page, 2)
    records.push({
      step: JSON.stringify(step),
      ...(await page.evaluate(() => ({ scene: window.__dom.scene(), history: window.__dom.history(), state: window.__dom.state() }))),
      ...(feedback && { feedback: await page.evaluate(() => window.__dom.feedback()) }),
    })
  }
  await page.waitForTimeout(800)
  await expect(status(page)).toContainText('Saved on this device')
  const saved = await stored(page)
  expect(errors).toEqual([])
  await context.close()
  return normalizeIds({ records, saved })
}

/** Two feedback snapshots agree: exact, except the measured parts of a snap preview, within the tolerance. */
function expectSameFeedback(dom: FeedbackSnapshot, fabric: FeedbackSnapshot, where: string): number {
  const { snap: ds, ...dRest } = dom
  const { snap: fs, ...fRest } = fabric
  expect(dRest, `${where} feedback`).toEqual(fRest)
  expect(ds === null, `${where} snap offered`).toBe(fs === null)
  if (!ds || !fs) return 0
  expect([ds.imageId, ds.side, ds.textId, ds.frameId], `${where} snap target`).toEqual([fs.imageId, fs.side, fs.textId, fs.frameId])
  expect(ds.bounds, `${where} snap image bounds`).toEqual(fs.bounds)
  expect(Math.abs(ds.position - fs.position), `${where} snap position`).toBeLessThanOrEqual(0.002)
  let worst = 0
  const pairs: Array<[string, number, number]> = [
    ...(Object.keys(fs.box) as Array<keyof typeof fs.box>).map((k): [string, number, number] => [`box.${k}`, ds.box[k], fs.box[k]]),
    ...(Object.keys(fs.size) as Array<keyof typeof fs.size>).map((k): [string, number, number] => [`size.${k}`, ds.size[k], fs.size[k]]),
  ]
  for (const [key, a, b] of pairs) {
    const diff = Math.abs(a - b)
    worst = Math.max(worst, diff)
    expect(diff, `${where} snap ${key}: dom ${a}, fabric ${b}`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
  }
  return worst
}

async function expectFeaturePaired(browser: Browser, doc: StoredBoard, steps: readonly FeatureStep[], assets: SeedAsset[] = ASSETS) {
  const fabric = fabricReference<Awaited<ReturnType<typeof runFeatureScript>>>('script', { doc, steps, assets })
  const dom = await runFeatureScript(browser, doc, steps, assets)
  let worst = 0
  fabric.records.forEach((f, i) => {
    const d = dom.records[i]!
    const where = `after ${f.step}`
    worst = Math.max(worst, expectSameRecords(d.scene.objects as never, f.scene.objects as never, where))
    expect(d.scene.frames, `frames ${where}`).toEqual(f.scene.frames)
    worst = Math.max(worst, expectSameRecords(d.history.objects as never, f.history.objects as never, `history ${where}`))
    expect(d.history.frames, `history frames ${where}`).toEqual(f.history.frames)
    expect(d.state, `state ${where}`).toEqual(f.state)
    expect(d.feedback === undefined, `feedback recorded ${where}`).toBe(f.feedback === undefined)
    if (d.feedback && f.feedback) worst = Math.max(worst, expectSameFeedback(d.feedback, f.feedback, where))
  })
  worst = Math.max(worst, expectSameRecords(dom.saved.objects as never, fabric.saved.objects as never, 'saved'))
  expect(dom.saved.frames, 'saved frames').toEqual(fabric.saved.frames)
  expect(dom.saved.version).toBe(fabric.saved.version)
  expect(dom.saved.viewport).toEqual(fabric.saved.viewport)
  return { worst, fabric, dom }
}

test.describe('the base branch features on the DOM renderer save what the Fabric renderer saves (paired, Slice 2c-iii)', () => {
  test('crop mode: every handle and the box, applied by Enter, Done and an outside press, cancelled by Esc; rotated, scaled and cropped images; Fit, Fill and Replace afterwards; ownership after a crop', async ({ browser }) => {
    const F1: StoredFrame = { id: 'F1', name: 'Left', left: 80, top: 60, width: 300, height: 260 }
    const F2: StoredFrame = { id: 'F2', name: 'Right', left: 440, top: 420, width: 300, height: 200 }
    const objects: StoredObject[] = [
      image('P', 120, 100, { frameId: 'F1' }),
      image('P2', 290, 200, { frameId: 'F1' }),
      image('R', 560, 110, { angle: 30, scaleX: 0.8, scaleY: 0.8, crop: { x: 20, y: 10, width: 110, height: 90 } }),
      image('E', 300, 430),
    ]
    const steps: FeatureStep[] = [
      { select: 'P' },
      { run: 'startCrop' },
      { crop: 'br', dx: -40, dy: -30 },
      { crop: 'tl', dx: 20, dy: 10 },
      { crop: 'move', dx: 10, dy: 5 },
      { crop: 't', dx: 0, dy: 6 },
      { crop: 'b', dx: 0, dy: -6 },
      { crop: 'tr', dx: -5, dy: 5 },
      { crop: 'bl', dx: 5, dy: -5 },
      { key: 'Enter' },
      { dblclick: 'P' },
      { crop: 'r', dx: 15, dy: 0 },
      { run: 'applyCrop' },
      { run: 'startCrop' },
      { crop: 'l', dx: 10, dy: 0 },
      { click: [760, 380] },
      { run: 'startCrop' },
      { crop: 't', dx: 0, dy: 20 },
      { key: 'Escape' },
      { run: 'fillImage' },
      { run: 'fitImage' },
      { select: 'R' },
      { run: 'startCrop' },
      { crop: 'br', dx: -20, dy: -20 },
      { crop: 'tl', dx: 10, dy: 15 },
      { key: 'Enter' },
      { run: 'startCrop' },
      { crop: 'l', dx: -30, dy: 0 },
      { key: 'Enter' },
      { run: 'fillImage' },
      { run: 'fitImage' },
      { run: 'fillImage' },
      { select: 'E' },
      { run: 'startCrop' },
      { crop: 'l', dx: 140, dy: 0 },
      { key: 'Enter' },
      { select: 'P2' },
      { run: 'startCrop' },
      { crop: 'l', dx: 40, dy: 0 },
      { key: 'Enter' },
      { run: 'undo' },
      { run: 'redo' },
      { select: 'P' },
      { replace: 'P', width: 300, height: 100 },
      { run: 'fitImage' },
      { run: 'undo' },
      { run: 'undo' },
      { run: 'redo' },
      { select: 'R' },
      { replace: 'R', width: 90, height: 200, seed: 7 },
      { run: 'startCrop' },
      { crop: 'b', dx: 0, dy: -40 },
      { key: 'Enter' },
    ]
    const { dom, worst } = await expectFeaturePaired(browser, board([F1, F2], objects, { zoom: 1.1, panX: -20, panY: 10 }), steps)
    const saved = (id: string) => dom.saved.objects.find((o) => o.id === id)!
    expect(saved('E').frameId).toBe('F2') // the crop moved its centre into F2: it joined
    expect(saved('P2').frameId).toBeUndefined() // and out of F1: it left
    expect(saved('R').crop).toBeDefined()
    console.log(`crop: largest geometry difference ${worst.toFixed(3)}`)
  })

  const captionBoard = () =>
    board(
      [{ id: 'F', name: 'Sleeve', left: 60, top: 520, width: 640, height: 260 }],
      [
        image('P', 100, 100),
        image('Q', 380, 100),
        image('R', 100, 330),
        image('S', 380, 330),
        text('T', 760, 80, 'Caption words here', { fontSize: 16, width: 150 }),
        text('D', 760, 160, 'Side note', { fontSize: 16, width: 100, minHeight: 0 }),
        text('U', 760, 240, 'Top label', { fontSize: 16, width: 120 }),
        text('L', 760, 320, 'Left', { fontSize: 16, width: 60, minHeight: 0 }),
      ],
    )

  test('caption snapping at each edge and along it, Ctrl to skip, Esc and blur mid-drag; captions follow a move, a resize, a rotation, a crop and a change of frame; background on and off; detach; a caption in a multi-selection', async ({ browser }) => {
    const steps: FeatureStep[] = [
      // Under P, previewed then dropped.
      { moveTo: 'T', left: 130, top: 226, hold: true },
      { release: true },
      // Right of Q: Ctrl at release skips the snap; then a plain drop snaps.
      { moveTo: 'D', left: 546, top: 140, ctrl: true },
      { moveTo: 'D', left: 546, top: 150, hold: true },
      { release: true },
      // Above R: Esc mid-drag, then a window blur mid-drag, bring the scene back; then the drop.
      { moveTo: 'U', left: 120, top: 304, hold: true },
      { key: 'Escape' },
      { release: true },
      { moveTo: 'U', left: 120, top: 304, hold: true },
      { blur: true },
      { release: true },
      { moveTo: 'U', left: 120, top: 304 },
      // Left of S.
      { moveTo: 'L', left: 314, top: 360, hold: true },
      { release: true },
      // The captions follow their images.
      { drag: 'P', dx: 40, dy: 30 },
      { select: 'Q' },
      { handle: 'br', dx: 40, dy: 30 },
      { select: 'R' },
      { handle: 'mtr', dx: 60, dy: 10 },
      { select: 'S' },
      { run: 'startCrop' },
      { crop: 'l', dx: 30, dy: 0 },
      { crop: 'b', dx: 0, dy: -20 },
      { key: 'Enter' },
      { moveTo: 'P', left: 200, top: 580, at: [0.3, 0.3] },
      // Backgrounds.
      { select: 'T' },
      { run: 'setCaptionBackground', args: ['#ffd0a0'] },
      { run: 'setCaptionBackground', args: ['#c0e0ff'] },
      { run: 'setCaptionBackground' },
      { select: 'Q' },
      { run: 'setCaptionBackground', args: ['#e0ffe0'] },
      // Detach by the command, then by dragging a caption away.
      { select: 'D' },
      { run: 'detachCaption' },
      { drag: 'U', dx: 0, dy: -90 },
      // A caption in a multi-selection with its image moves once.
      { select: 'P', also: ['T'] },
      { drag: 'P', dx: -30, dy: -20, at: [0.3, 0.3] },
      { run: 'undo' },
      { run: 'redo' },
    ]
    const { dom, worst } = await expectFeaturePaired(browser, captionBoard(), steps)
    const saved = (id: string) => dom.saved.objects.find((o) => o.id === id)!
    expect(saved('T')).toMatchObject({ captionOf: 'P', frameId: 'F' })
    expect(saved('L')).toMatchObject({ captionOf: 'S', captionSide: 'left' })
    expect(saved('D').captionOf).toBeUndefined()
    expect(saved('U').captionOf).toBeUndefined()
    console.log(`captions: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('the ownership preview while dragging and scaling: frames that may gain or lose items, carried members, and a text whose folded size leaves its frame', async ({ browser }) => {
    const F: StoredFrame = { id: 'F', name: 'Edge', left: 100, top: 100, width: 360, height: 260 }
    const G: StoredFrame = { id: 'G', name: 'Other', left: 560, top: 100, width: 300, height: 300 }
    const objects: StoredObject[] = [
      image('I', 140, 150, { frameId: 'F', scaleX: 0.5, scaleY: 0.5 }),
      text('T', 300, 300, 'a note near the edge', { fontSize: 18, width: 140, frameId: 'F' }),
      text('W', 600, 420, 'loose words', { fontSize: 18, width: 120, minHeight: 0 }),
    ]
    const steps: FeatureStep[] = [
      { drag: 'I', dx: 470, dy: 40, hold: true },
      { release: true },
      { select: 'T' },
      { handle: 'br', dx: 260, dy: 130, hold: true },
      { release: true },
      { label: 'G', dx: -60, dy: 0 },
      { select: 'W' },
      { handle: 'tl', dx: -40, dy: -30, hold: true },
      { key: 'Escape' },
      { release: true },
    ]
    const { fabric, worst } = await expectFeaturePaired(browser, board([F, G], objects), steps)
    // The preview showed something to compare: G may gain the dragged image, F may lose the scaled text.
    expect(fabric.records[0]!.feedback!.gaining).toContain('G')
    expect(fabric.records[3]!.feedback!.losing).toContain('F')
    console.log(`feedback: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('duplicate: single items, a multi-selection, a frame with owned items including locked ones, a cropped image and a captioned image; stacking, the counterparts selected, one undo step', async ({ browser }) => {
    const F: StoredFrame = { id: 'F', name: 'Album', left: 100, top: 80, width: 460, height: 340 }
    const objects: StoredObject[] = [
      image('A', 130, 110, { frameId: 'F', crop: { x: 10, y: 5, width: 120, height: 90 }, angle: 8 }),
      text('K', 300, 120, 'Locked words', { frameId: 'F', locked: true, width: 160 }),
      image('B', 300, 200, { frameId: 'F', scaleX: 0.6, scaleY: 0.6 }),
      text('C', 300, 278, 'Its caption', { frameId: 'F', width: 96, minHeight: 0, captionOf: 'B', captionBackground: '#fff0c0' }),
      image('Lk', 140, 300, { frameId: 'F', locked: true, assetId: 'grad', scaleX: 0.5, scaleY: 0.5 }),
      text('T', 640, 120, 'Loose heading\nbody', { width: 200, headings: [1], spans: [{ start: 14, end: 18, italic: true }] }),
      image('I', 640, 300, { assetId: 'grad', scaleX: 0.7, scaleY: 0.7 }),
      // Loose just above F: its copy (24 screen pixels lower) has its centre inside F only once its height counts.
      text('E', 330, 40, 'Two line\nnote', { width: 120 }),
    ]
    const steps: FeatureStep[] = [
      { select: 'E' },
      { run: 'duplicateSelection' },
      { select: 'F' },
      { run: 'duplicateSelection' },
      { run: 'undo' },
      { run: 'redo' },
      { select: 'T' },
      { key: 'Control+d' },
      { select: 'I', also: ['T'] },
      { run: 'duplicateSelection' },
      { select: 'B' },
      { run: 'duplicateSelection' },
      { select: 'C' },
      { run: 'duplicateSelection' },
      { select: 'K' },
      { run: 'duplicateSelection' },
      { run: 'undo' },
    ]
    const { dom, worst } = await expectFeaturePaired(browser, board([F], objects, { zoom: 0.8, panX: 10, panY: 20 }), steps)
    expect(dom.saved.frames).toHaveLength(2)
    expect(dom.saved.objects.filter((o) => o.locked)).toHaveLength(2) // copies start unlocked
    expect(dom.saved.objects.find((o) => o.id === '~1')).toMatchObject({ type: 'text', text: 'Two line\nnote', frameId: 'F' })
    console.log(`duplicate: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('locks: inspector, padlock and shortcut; click-through; Select all; locked members follow their frame; a selection that holds a locked item holds nothing else', async ({ browser }) => {
    const F: StoredFrame = { id: 'F', name: 'Spread', left: 100, top: 80, width: 420, height: 320 }
    const objects: StoredObject[] = [
      image('A', 140, 120, { frameId: 'F' }),
      text('K', 320, 140, 'Member note', { frameId: 'F', width: 150 }),
      image('I', 640, 120, { assetId: 'grad', scaleX: 0.6, scaleY: 0.6 }),
      text('T', 640, 300, 'Loose words', { width: 160 }),
    ]
    const steps: FeatureStep[] = [
      { select: 'A' },
      { run: 'setSelectionLocked', args: [true] },
      { select: 'K' },
      { key: 'Control+Shift+L' },
      { select: 'T', also: ['I'] },
      { run: 'setSelectionLocked', args: [true] },
      { run: 'toggleLayerLock', args: ['I'] },
      { run: 'selectAll' },
      { select: 'I', also: ['A'] },
      { click: [220, 180] }, // on locked A, inside F's click-through interior: the board
      { label: 'F', dx: 60, dy: 40 },
      { select: 'A' },
      { run: 'deleteSelection' },
      { run: 'arrange', args: ['front'] },
      { key: 'Delete' },
      { select: 'F' },
      { run: 'selectFrameContents' },
      { select: 'A' },
      { key: 'Control+Shift+L' },
      { run: 'toggleLayerLock', args: ['K'] },
      { run: 'undo' },
      { run: 'redo' },
    ]
    const { dom, worst } = await expectFeaturePaired(browser, board([F], objects), steps)
    expect(dom.saved.objects.find((o) => o.id === 'T')!.locked).toBe(true)
    console.log(`locks: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('the layer list: selecting, reordering by keys and in the list, labels through whole-box changes and Make caption', async ({ browser }) => {
    const objects: StoredObject[] = [
      image('A', 120, 120),
      text('T', 360, 140, 'First words of a longer note that runs past the label limit', { width: 220 }),
      image('B', 120, 360, { assetId: 'grad' }),
      text('U', 360, 380, 'Second', { width: 120, minHeight: 0 }),
    ]
    const frames2: StoredFrame[] = [
      { id: 'F', name: 'Back', left: 80, top: 80, width: 300, height: 260 },
      { id: 'G', name: '', left: 400, top: 300, width: 300, height: 260 },
    ]
    const steps: FeatureStep[] = [
      { select: 'A' },
      { key: ']' },
      { key: '[' },
      { key: 'Control+]' },
      { key: 'Control+[' },
      { run: 'moveLayer', args: ['T', 'A', 'before'] },
      { run: 'moveLayer', args: ['U', 'B', 'after'] },
      { run: 'moveLayer', args: ['G', 'F', 'before'] },
      { select: 'T' },
      { run: 'setHeading', args: [1] },
      { run: 'toggleMark', args: ['bold'] },
      { select: 'U', also: ['A'] },
      { run: 'selectLayer', args: ['B', { toggle: true }] },
      { select: 'A', also: ['U'] },
      { run: 'makeCaption' },
      { run: 'undo' },
    ]
    const { dom } = await expectFeaturePaired(browser, board(frames2, objects), steps)
    const rows = dom.records.at(-2)!.state.layers
    expect(rows.find((r) => r.id === 'U')).toMatchObject({ kind: 'text', label: 'Second' })
    expect(rows.find((r) => r.id === 'B')).toMatchObject({ kind: 'image', label: 'grad.png' })
  })

  test('frame navigation: jumps share one return point, return restores the view exactly, a tour changes nothing', async ({ browser }) => {
    const frames2: StoredFrame[] = [
      { id: 'F', name: 'One', left: 80, top: 80, width: 300, height: 260 },
      { id: 'G', name: 'Two', left: 1400, top: 900, width: 500, height: 300 },
    ]
    const objects: StoredObject[] = [image('A', 120, 120, { frameId: 'F' }), text('T', 1450, 950, 'Far away', { frameId: 'G' })]
    const steps: FeatureStep[] = [
      { run: 'jumpToFrame', args: ['G'] },
      { run: 'jumpToFrame', args: ['F'] },
      { run: 'jumpToFrame', args: ['F'] },
      { run: 'returnFromJump' },
      { run: 'jumpToFrame', args: ['G'] },
      { run: 'startFrameTour' },
      { run: 'returnFromJump' },
    ]
    await expectFeaturePaired(browser, board(frames2, objects, { zoom: 0.9, panX: 30, panY: -10 }), steps)
  })
})

test.describe('what a person sees on the DOM renderer (Slice 2c-iii)', () => {
  const ACCENT_RGB = hex('#6c7bf2')
  const BOARD_RGB = hex('#f1f3f8')
  const DIM: readonly number[] = [17, 20, 28]
  const dimmed = (c: readonly number[]) => c.map((v, i) => 0.45 * v + 0.55 * DIM[i]!)

  test('crop mode shows the whole original in place, dimmed outside the box, with eight handles above it; the kept pixels do not move when it is applied', async ({ page }) => {
    const errors = errorsOf(page)
    const at = await openBoard(page, board([], [image('P', 200, 150)]), ASSETS)
    const kept = { x: at(210, 160).x, y: at(210, 160).y, width: 90, height: 70 }
    const outside = at(345, 255)
    await shot(page, { x: at(0, 0).x, y: at(0, 0).y, width: 600, height: 400 })
    const local = (p: Corner) => ({ x: p.x - at(0, 0).x, y: p.y - at(0, 0).y })
    const original = await pixel(page, local(outside).x, local(outside).y)
    const before = await page.screenshot({ clip: kept })

    await page.evaluate(() => window.__dom.run('selectLayer', 'P'))
    await page.evaluate(() => window.__dom.run('startCrop'))
    await frames(page, 2)
    expect(await page.screenshot({ clip: kept }), 'entering crop mode moves nothing').toEqual(before)
    const br = (await page.evaluate(() => window.__dom.cropPoint('br')))!
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x - 40, br.y - 30, { steps: 6 })
    await page.mouse.up()
    await frames(page, 2)
    expect(await page.screenshot({ clip: kept }), 'the kept part, while cropping').toEqual(before)
    // Outside the box: the original, dimmed (drawn by the canvas over the layer's whole image).
    await shot(page, { x: at(0, 0).x, y: at(0, 0).y, width: 600, height: 400 })
    const dim = await pixel(page, local(outside).x, local(outside).y)
    expect(near(dim, dimmed(original), 6), `dimmed original outside the box: ${dim} from ${original}`).toBe(true)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.scene-image[data-id="P"]')!).width)).toBe('160px')
    // Eight handles, drawn by the canvas above the layer.
    for (const h of ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l']) {
      const p = (await page.evaluate((h) => window.__dom.cropPoint(h), h))!
      expect(await page.evaluate(({ x, y }) => window.__dom.canvasAlpha(x, y), p), `handle ${h}`).toBe(255)
    }

    await page.keyboard.press('Enter')
    await frames(page, 2)
    expect(await page.screenshot({ clip: kept }), 'the kept part, after applying').toEqual(before)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.scene-image[data-id="P"]')!).width)).toBe('120px')
    await page.evaluate(() => window.__dom.run('selectLayer', 'P')) // still selected; deselect to see the board
    await page.keyboard.press('Escape')
    await frames(page, 2)
    await shot(page, { x: at(0, 0).x, y: at(0, 0).y, width: 600, height: 400 })
    expect(near(await pixel(page, local(outside).x, local(outside).y), BOARD_RGB, 8), 'the cropped-away part is gone').toBe(true)
    await expectTracked(page, ['P'], 'after the crop')
    expect(errors).toEqual([])
  })

  test('a dragged item is drawn lifted and the frame it may join is marked; a snap preview shows where a caption lands; a caption background is drawn', async ({ page }) => {
    const errors = errorsOf(page)
    const F: StoredFrame = { id: 'F', name: 'Spread', left: 100, top: 100, width: 300, height: 260 }
    const objects: StoredObject[] = [
      image('I', 500, 120, { scaleX: 0.5, scaleY: 0.5 }),
      image('P', 500, 380),
      text('T', 820, 300, 'Caption here', { fontSize: 16, width: 120 }),
    ]
    const at = await openBoard(page, board([F], objects), ASSETS)
    const origin = at(0, 0)
    const local = (x: number, y: number) => ({ x: at(x, y).x - origin.x, y: at(x, y).y - origin.y })
    const area = { x: origin.x, y: origin.y, width: 1000, height: 640 }

    // Lifted while dragged, with the frame it would join marked.
    const grab = await pointIn(page, 'I')
    await pressAndMove(page, grab, -300, 60)
    await frames(page, 2)
    expect(await page.evaluate(() => window.__dom.lifted())).toEqual(['I'])
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.scene-item[data-id="I"]')!).filter)).toContain('url("#yuriful-lift-')
    expect((await page.evaluate(() => window.__dom.feedback())).gaining).toEqual(['F'])
    await shot(page, area)
    const column = Math.round(local(100, 0).x)
    const outline = await Promise.all([column - 1, column, column + 1].map((x) => pixel(page, x, local(0, 300).y)))
    expect(outline.some((c) => near(c, ACCENT_RGB, 30)), `the frame that may gain it is marked ${JSON.stringify(outline)}`).toBe(true)
    // The shadow: just below the dragged image the board is darker than before.
    await page.mouse.up()
    await frames(page, 2)
    expect(await page.evaluate(() => window.__dom.lifted())).toEqual([])
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.scene-item[data-id="I"]')!).filter)).toBe('none')

    // The caption snap preview: an accent outline where the text will land.
    const b = (await page.evaluate(() => window.__dom.bounds('T')))!
    const from = await pointIn(page, 'T')
    await pressAndMove(page, from, 530 - b.left, 506 - b.top)
    await frames(page, 2)
    const snap = (await page.evaluate(() => window.__dom.feedback())).snap
    expect(snap).toMatchObject({ imageId: 'P', side: 'under' })
    await shot(page, area)
    const left = Math.round(local(snap!.box.left, 0).x)
    const samples: number[][] = []
    for (let y = Math.ceil(local(0, snap!.box.top).y) + 1; y < local(0, snap!.box.bottom).y - 1; y++) {
      for (const x of [left - 1, left, left + 1]) samples.push(await pixel(page, x, y))
    }
    expect(samples.some((c) => near(c, ACCENT_RGB, 30)), 'the preview outline').toBe(true)
    await page.mouse.up()
    await frames(page, 2)
    const caption = ((await page.evaluate(() => window.__dom.scene())) as Scene).objects.find((o) => o.id === 'T')!
    expect(caption).toMatchObject({ captionOf: 'P' })

    // A caption's background is drawn by the layer (an empty spot in the box: its right end).
    await page.evaluate(() => {
      window.__dom.run('selectLayer', 'T')
      window.__dom.run('setCaptionBackground', '#ff40c0')
      window.__dom.run('selectLayer', 'P')
    })
    await page.keyboard.press('Escape')
    await frames(page, 2)
    const tb = (await page.evaluate(() => window.__dom.bounds('T')))!
    const spot = local(tb.right - 4, (tb.top + tb.bottom) / 2)
    await shot(page, area)
    expect(near(await pixel(page, spot.x, spot.y), hex('#ff40c0'), 10), 'the background').toBe(true)
    await page.evaluate(() => {
      window.__dom.run('selectLayer', 'T')
      window.__dom.run('setCaptionBackground')
    })
    await page.keyboard.press('Escape')
    await frames(page, 2)
    await shot(page, area)
    expect(near(await pixel(page, spot.x, spot.y), BOARD_RGB, 8), 'no background').toBe(true)
    expect(errors).toEqual([])
  })

  test('a frame preview draws images and text in true stacking order, a text in front of an image and an image in front of a text, crops included', async ({ page }) => {
    const errors = errorsOf(page)
    const A = text('A', 260, 200, 'Under', { captionBackground: '#ff40c0', width: 200, minHeight: 120 })
    const I = image('I', 380, 230)
    const B = text('B', 470, 300, 'Over', { captionBackground: '#20c0b0', width: 200, minHeight: 80 })
    const K = image('K', 240, 420, { crop: { x: 80, y: 60, width: 80, height: 60 } })
    // Turned: a detached Fabric canvas draws its glyphs directly, the compositor resamples the card's
    // bitmap, so the two give different pixels and the comparison below tells which one drew it.
    const R = text('R', 560, 160, 'Turned words', { width: 140, angle: 15 })
    await openBoard(page, board([frame()], [A, I, B, K, R]), ASSETS)
    const url = await page.evaluate(() => window.__dom.preview('F'))
    expect(url.startsWith('data:image/png')).toBe(true)
    // Drawn by the compositor, from the same cards the layer draws (not a detached Fabric canvas).
    const composited = await page.evaluate(async () => {
      const path = '/src/editor/renderFrameBitmap.ts'
      const { renderFrameToCanvas } = await import(/* @vite-ignore */ path)
      const images = new Map([...document.querySelectorAll('.scene-image[data-id] img')].map((img) => [(img.closest('[data-id]') as HTMLElement).dataset.id, img as HTMLImageElement]))
      const scene = window.__dom.history()
      const byAsset = new Map(scene.objects.flatMap((o) => (o.type === 'image' ? [[o.assetId, images.get(o.id)]] : [])))
      const canvas = await renderFrameToCanvas(scene, 'F', { getImage: (id: string) => byAsset.get(id) })
      return canvas.toDataURL('image/png')
    })
    expect(url).toBe(composited)
    const f = frame()
    const scale = Math.min(2, 1600 / Math.max(f.width, f.height))
    const sample = (x: number, y: number) =>
      page.evaluate(async ({ url, x, y }) => {
        const img = new Image()
        img.src = url
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        return Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3))
      }, { url, x: (x - f.left) * scale, y: (y - f.top) * scale })
    expect(near(await sample(680, 520), [255, 255, 255], 3), 'paper').toBe(true)
    expect(near(await sample(300, 280), hex('#ff40c0')), 'text A where nothing covers it').toBe(true)
    const iOverA = await sample(392, 242)
    expect(iOverA[0]! > 100 && iOverA[1]! < 80 && iOverA[2]! < 80, `image I in front of text A ${iOverA}`).toBe(true)
    expect(near(await sample(500, 320), hex('#20c0b0')), 'text B in front of image I').toBe(true)
    const crop = await sample(250, 430)
    expect(crop[0]! > 100 && crop[1]! > 90 && crop[2]! < 60, `the cropped image shows only its kept quadrant ${crop}`).toBe(true)
    expect(errors).toEqual([])
  })
})

test.describe('crop mode on the DOM renderer through interruptions (Slice 2c-iii)', () => {
  const P = () => image('P', 200, 150)
  const pRecord = async (page: Page) => ((await page.evaluate(() => window.__dom.scene())) as Scene).objects.find((o) => o.id === 'P')!
  const open = async (page: Page) => {
    await page.evaluate(() => {
      window.__dom.run('selectLayer', 'P')
      window.__dom.run('startCrop')
    })
    await frames(page, 2)
  }
  const shownWidth = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector('.scene-image[data-id="P"]')!).width)

  test('Esc, a window blur mid-drag, a second button, a lost release, autosave, an import, undo and redo, a reload', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [P()]), ASSETS)
    const start = await snapshotIdb(page)
    const before = await pRecord(page)

    // Esc restores the image exactly; nothing recorded or saved.
    await open(page)
    expect(await shownWidth(page)).toBe('160px')
    let br = (await page.evaluate(() => window.__dom.cropPoint('br')))!
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x - 50, br.y - 40, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.press('Escape')
    await frames(page, 2)
    expect((await page.evaluate(() => window.__dom.state())).cropping).toBe(false)
    expect(await pRecord(page)).toEqual(before)
    expect(await shownWidth(page)).toBe('160px')
    await expectTracked(page, ['P'], 'after Esc')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(page)).toEqual(start)
    expect((await page.evaluate(() => window.__dom.state())).canUndo).toBe(false)

    // A blur mid-drag returns that drag to where it began and keeps crop mode open.
    await open(page)
    br = (await page.evaluate(() => window.__dom.cropPoint('br')))!
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x - 50, br.y - 40, { steps: 5 })
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.mouse.up()
    await frames(page, 2)
    expect((await page.evaluate(() => window.__dom.state())).cropping).toBe(true)
    expect(await page.evaluate(() => window.__dom.cropPoint('br'))).toEqual(br)

    // A second button during the drag changes nothing; the primary release ends it.
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x - 20, br.y - 10, { steps: 3 })
    await page.mouse.down({ button: 'right' })
    await page.mouse.up({ button: 'right' })
    await page.mouse.move(br.x - 40, br.y - 30, { steps: 3 })
    await page.mouse.up()
    const moved = (await page.evaluate(() => window.__dom.cropPoint('br')))!
    expect(Math.abs(moved.x - (br.x - 40))).toBeLessThan(1)
    expect(Math.abs(moved.y - (br.y - 30))).toBeLessThan(1)

    // A lost release: the next move without the button ends the drag where it is.
    await page.mouse.move(moved.x, moved.y)
    await page.mouse.down()
    await page.mouse.move(moved.x - 10, moved.y - 10, { steps: 3 })
    await page.evaluate(({ x, y }) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: 0 })), { x: moved.x - 10, y: moved.y - 10 })
    await page.evaluate(({ x, y }) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, buttons: 0 })), { x: moved.x - 60, y: moved.y - 60 })
    const healed = (await page.evaluate(() => window.__dom.cropPoint('br')))!
    expect(Math.abs(healed.x - (moved.x - 10))).toBeLessThan(1)
    await page.mouse.up()

    // Autosave while crop mode is open stores the board from before it (here: the title changes).
    await page.evaluate(() => window.__dom.run('setTitle', 'Mid crop'))
    await expect.poll(async () => (await stored(page)).title).toBe('Mid crop')
    expect((await stored(page)).objects[0]).toEqual(before)

    // An import that completes applies the crop first, as its own step, then adds the image.
    await dropImage(page, 'late.png', pngBuffer(60, 40, 2).toString('base64'), { x: 900, y: 600 })
    await expect.poll(async () => (await stored(page)).objects.length).toBe(2)
    expect((await page.evaluate(() => window.__dom.state())).cropping).toBe(false)
    const cropped = (await stored(page)).objects[0]!
    expect(cropped.crop).toBeDefined()
    expect(await shownWidth(page)).toBe(`${cropped.crop!.width}px`)
    await page.evaluate(() => window.__dom.run('undo'))
    await expect.poll(async () => (await stored(page)).objects.length).toBe(1)
    expect((await stored(page)).objects[0]).toEqual(cropped)
    await page.evaluate(() => window.__dom.run('undo'))
    await frames(page, 2)
    expect(await pRecord(page)).toEqual(before)
    expect(await shownWidth(page)).toBe('160px')
    await page.evaluate(() => window.__dom.run('redo'))
    await frames(page, 2)
    expect(await pRecord(page)).toEqual(cropped)
    expect(await shownWidth(page)).toBe(`${cropped.crop!.width}px`)
    await expectTracked(page, ['P'], 'after undo and redo')

    // A reload with crop mode open: the board as it was before crop mode.
    await expect(status(page)).toContainText('Saved on this device')
    await open(page)
    br = (await page.evaluate(() => window.__dom.cropPoint('tl')))!
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x + 20, br.y + 20, { steps: 3 })
    await page.mouse.up()
    await page.reload()
    await expect(status(page)).toContainText('Saved on this device')
    await frames(page, 2)
    expect(await pRecord(page)).toEqual(cropped)
    expect(errors).toEqual([])
  })

  test('the board going read-only cancels crop mode and writes nothing', async ({ page, context }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [P()]), ASSETS)
    const before = await pRecord(page)
    await open(page)
    const br = (await page.evaluate(() => window.__dom.cropPoint('br')))!
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(br.x - 50, br.y - 40, { steps: 5 })
    await page.mouse.up()
    // Another tab writes the board; this tab's next save finds it changed and goes read-only.
    const other = await context.newPage()
    await openBlank(other)
    await other.evaluate(
      (doc) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('yuriful')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const tx = open.result.transaction('boards', 'readwrite')
            tx.objectStore('boards').put({ id: 'current', doc, rev: 'other-tab', updatedAt: 2 })
            tx.oncomplete = () => {
              open.result.close()
              resolve()
            }
          }
        }),
      { ...board([], [image('P', 10, 10)]), title: 'Other tab' },
    )
    const written = await snapshotIdb(other)
    await page.evaluate(() => window.__dom.run('setTitle', 'Conflict'))
    await expect(page.getByTestId('readonly-banner')).toBeVisible()
    await frames(page, 2)
    expect((await page.evaluate(() => window.__dom.state())).cropping).toBe(false)
    expect(await pRecord(page)).toEqual(before)
    expect(await shownWidth(page)).toBe('160px')
    await page.waitForTimeout(AUTOSAVE_QUIET_MS)
    expect(await snapshotIdb(other)).toEqual(written)
    expect(errors).toEqual([])
  })
})

// ---- Slice 2c-iii follow-up: frame previews, the lifted look's shadow ---------------------------

/** A picture whose HTML content taints a canvas it is drawn on (Chromium: an SVG image holding a `<foreignObject>`). */
const TAINTING_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><foreignObject x="0" y="0" width="120" height="80">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" style="width:120px;height:80px;background:#0a8">html</div></foreignObject></svg>'

test.describe('a frame preview draws only what overlaps the frame (Slice 2c-iii follow-up)', () => {
  /** Opens the board, replaces `target` with the tainting picture, and renders frame F's tour preview. */
  async function previewAfterReplacing(browser: Browser, target: string) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = errorsOf(page)
    const objects: StoredObject[] = [
      text('T', 260, 200, 'Words in the frame', { width: 220 }),
      image('IN', 420, 300),
      image('OUT', 1400, 1000), // well outside F (200..720 × 120..540)
    ]
    await openBoard(page, board([frame()], objects), ASSETS)
    await page.evaluate(({ id, b64 }) => window.__dom.replace(id, b64, 'image/svg+xml', 'html.svg'), { id: target, b64: Buffer.from(TAINTING_SVG).toString('base64') })
    await expect.poll(() => page.evaluate((id) => (window.__dom.scene().objects.find((o) => o.id === id) as { assetId?: string }).assetId, target)).not.toBe('quad')
    const outcome = await page.evaluate(() =>
      window.__dom.preview('F').then(
        (url) => ({ drawn: url.startsWith('data:image/png'), error: null as string | null }),
        (e: Error) => ({ drawn: false, error: e.name }),
      ),
    )
    expect(errors).toEqual([])
    await context.close()
    return outcome
  }

  test('an image outside the frame cannot break its preview; an image inside it that taints a canvas fails the preview on both renderers alike', async ({ browser }) => {
    const fabricPreview = (target: string) => fabricReference<{ drawn: boolean; error: string | null }>(target, { target, svg: TAINTING_SVG })
    const outside = { fabric: fabricPreview('OUT'), dom: await previewAfterReplacing(browser, 'OUT') }
    expect(outside.fabric).toEqual({ drawn: true, error: null })
    expect(outside.dom).toEqual(outside.fabric)
    // Inside the frame both renderers draw it, as they must, and the browser refuses the tainted bitmap.
    const inside = { fabric: fabricPreview('IN'), dom: await previewAfterReplacing(browser, 'IN') }
    expect(inside.fabric).toEqual({ drawn: false, error: 'SecurityError' })
    expect(inside.dom).toEqual(inside.fabric)
  })

  test('a text card outside the frame is never rasterized, and with the layer\'s sizes never laid out either; one within its ink bleed is', async ({ page }) => {
    const errors = errorsOf(page)
    const objects: StoredObject[] = [
      text('T', 260, 200, 'Words in the frame', { width: 220 }),
      text('NEAR', 730, 300, 'Just past the edge', { width: 160 }), // 10 beyond F's right edge: its ink may reach in
      text('FAR', 1400, 1000, 'Far away words', { width: 160 }),
    ]
    await openBoard(page, board([frame()], objects), ASSETS)
    const watch = () =>
      page.evaluate(() => {
        const w = window as unknown as { __rasterized: string[]; __laidOut: string[] }
        w.__rasterized = []
        w.__laidOut = []
        const decode = HTMLImageElement.prototype.decode
        HTMLImageElement.prototype.decode = function () {
          if (this.src.startsWith('data:image/svg+xml')) w.__rasterized.push(decodeURIComponent(this.src).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
          return decode.call(this)
        }
        new MutationObserver((records) => {
          for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains('scene-text-body') && !n.closest('.scene-layer')) w.__laidOut.push(n.textContent ?? '')
        }).observe(document.body, { childList: true, subtree: true })
      })
    const seen = () => page.evaluate(() => {
      const w = window as unknown as { __rasterized: string[]; __laidOut: string[] }
      return { rasterized: w.__rasterized.map((t) => t.replace(/^.*?(Words|Just|Far)/, '$1')), laidOut: [...w.__laidOut] }
    })
    await watch()
    expect(await page.evaluate(() => window.__dom.preview('F').then((url) => url.length > 0))).toBe(true)
    let s = await seen()
    expect(s.rasterized.map((t) => t.split(' ')[0])).toEqual(['Words', 'Just'])
    expect(s.laidOut).toEqual(['Words in the frame', 'Just past the edge'])
    // Without the layer's sizes (the compositor on its own): FAR is laid out to learn its size, then left out.
    await page.evaluate(async () => {
      const w = window as unknown as { __rasterized: string[]; __laidOut: string[] }
      w.__rasterized = []
      w.__laidOut = []
      const path = '/src/editor/renderFrameBitmap.ts'
      const { renderFrameToCanvas } = await import(/* @vite-ignore */ path)
      await renderFrameToCanvas(window.__dom.history(), 'F', { getImage: () => undefined })
    })
    s = await seen()
    expect(s.rasterized.map((t) => t.split(' ')[0])).toEqual(['Words', 'Just'])
    expect(s.laidOut).toEqual(['Words in the frame', 'Just past the edge', 'Far away words'])
    expect(errors).toEqual([])
  })
})

test.describe('the lifted look casts the canvas\'s shadow (Slice 2c-iii follow-up)', () => {
  /** Drags image I by (dx, dy) and holds; returns the screen around it and its corners, in clip pixels. */
  async function liftedShot(browser: Browser, doc: StoredBoard, dx: number, dy: number, clipIn?: { x: number; y: number; width: number; height: number }) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = errorsOf(page)
    await openBoard(page, doc, ASSETS)
    await pressAndMove(page, await pointIn(page, 'I'), dx, dy)
    await frames(page, 3)
    const corners = (await page.evaluate(() => window.__dom.proxy('I')))!
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    const clip = clipIn ?? { x: Math.floor(Math.min(...xs)) - 40, y: Math.floor(Math.min(...ys)) - 40, width: Math.ceil(Math.max(...xs) - Math.min(...xs)) + 80, height: Math.ceil(Math.max(...ys) - Math.min(...ys)) + 80 }
    const png = (await page.screenshot({ clip })).toString('base64')
    const lifted = await page.evaluate(() => window.__dom.feedback().lifted)
    await page.mouse.up()
    expect(errors).toEqual([])
    await context.close()
    return { png, clip, corners: corners.map((p) => ({ x: p.x - clip.x, y: p.y - clip.y })), lifted }
  }

  /**
   * Compares the two screens outside the image, beyond 5 screen pixels of its edges (the moving
   * selection border, which the canvas draws 2 units out on both renderers, and the edge's
   * anti-aliasing): the largest per-channel difference, and each screen's red channel at distances
   * straight below the image's centre, from its lower edge.
   */
  async function compareShadows(page: Page, a: string, b: string, corners: Corner[]) {
    return page.evaluate(async ({ a, b, corners }) => {
      const decode = async (b64: string) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, c.width, c.height)
      }
      const [da, db] = [await decode(a), await decode(b)]
      // Signed distance from the image's quadrilateral (negative inside).
      const dist = (x: number, y: number) => {
        let inside = false
        let best = Infinity
        for (let i = 0; i < 4; i++) {
          const p = corners[i]!
          const q = corners[(i + 1) % 4]!
          if ((p.y > y) !== (q.y > y) && x < ((q.x - p.x) * (y - p.y)) / (q.y - p.y) + p.x) inside = !inside
          const t = Math.max(0, Math.min(1, ((x - p.x) * (q.x - p.x) + (y - p.y) * (q.y - p.y)) / ((q.x - p.x) ** 2 + (q.y - p.y) ** 2)))
          best = Math.min(best, Math.hypot(x - (p.x + t * (q.x - p.x)), y - (p.y + t * (q.y - p.y))))
        }
        return inside ? -best : best
      }
      let worst = 0
      let darkest = 255
      for (let y = 0; y < da.height; y++) {
        for (let x = 0; x < da.width; x++) {
          if (dist(x + 0.5, y + 0.5) < 5) continue
          const i = (y * da.width + x) * 4
          for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(da.data[i + k]! - db.data[i + k]!))
          darkest = Math.min(darkest, db.data[i]!)
        }
      }
      // Straight below the image's centre, from its lower edge.
      const cx = corners.reduce((s, p) => s + p.x, 0) / 4
      let edge = -Infinity
      for (let k = 0; k < 4; k++) {
        const p = corners[k]!
        const q = corners[(k + 1) % 4]!
        if ((p.x - cx) * (q.x - cx) <= 0 && p.x !== q.x) edge = Math.max(edge, p.y + ((cx - p.x) * (q.y - p.y)) / (q.x - p.x))
      }
      const below = [4, 8, 12, 15, 20].map((d) => {
        const i = (Math.round(edge + d) * da.width + Math.round(cx)) * 4
        return { d, a: da.data[i]!, b: db.data[i]! }
      })
      return { worst, darkest, below }
    }, { a, b, corners })
  }

  test('same extent and darkness at every distance: upright over frame paper at 100%, turned and scaled at 150%', async ({ browser, page }) => {
    await openBlank(page)
    const big: StoredFrame = { id: 'F', name: 'Paper', left: 60, top: 60, width: 900, height: 600 }
    const cases: Array<{ name: string; doc: StoredBoard; dx: number; dy: number }> = [
      { name: 'upright, 100%', doc: board([big], [image('I', 300, 200, { frameId: 'F' })]), dx: 40, dy: 30 },
      { name: 'turned 30° at 0.6, 150%', doc: board([big], [image('I', 260, 160, { frameId: 'F', angle: 30, scaleX: 0.6, scaleY: 0.6 })], { zoom: 1.5, panX: -60, panY: -40 }), dx: 30, dy: 20 },
    ]
    for (const c of cases) {
      const fabric = fabricReference<{ png: string; clip: { x: number; y: number; width: number; height: number }; corners: Corner[] }>(c.name, c)
      const dom = await liftedShot(browser, c.doc, c.dx, c.dy, fabric.clip)
      expect(dom.lifted).toEqual(['I'])
      const r = await compareShadows(page, fabric.png, dom.png, fabric.corners)
      console.log(`lift shadow, ${c.name}: red below the image (fabric/dom) ${r.below.map((s) => `${s.d}px ${s.a}/${s.b}`).join(', ')}; largest difference ${r.worst}`)
      expect(r.darkest, `${c.name}: there is a shadow to compare`).toBeLessThan(235)
      expect(r.worst, `${c.name}: largest per-channel difference outside the image`).toBeLessThanOrEqual(3)
    }
  })
})
