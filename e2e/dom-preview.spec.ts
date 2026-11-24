import { expect, test } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import type { FeedbackSnapshot } from '../src/editor/feedbackLayer.ts'
import { openApp, openBlank, seedRaw } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredFrame, StoredObject } from './helpers.ts'

/**
 * The DOM renderer's frame previews and drag lift against the Fabric renderer's, in Chromium (plan
 * Slice 2c-iii): the same seeded board and the same actions on both renderers, compared by the
 * pixels each one shows. The renderer is chosen as in `e2e/interleaving.spec.ts`, by
 * `window.__YURIFUL_RENDERER__ = 'dom'` set before the app mounts; a probe on the app's own editor
 * (route-only, as `feel-helpers.ts`) reads proxies, handles, feedback and previews.
 */

type Corner = { x: number; y: number }

interface PreviewProbe {
  renderer: () => 'dom' | 'fabric'
  /** An object's four corners (tl, tr, br, bl) in page pixels. */
  proxy: (id: string) => Corner[] | null
  /** Fabric's handle positions of the active object, in page pixels. */
  controls: () => Record<string, Corner> | null
  select: (id: string) => void
  /** Pans the view (zoom kept) so that an object's centre is in the middle of the canvas. */
  centre: (id: string) => void
  feedback: () => FeedbackSnapshot
  /** A frame's tour preview as a data URL. */
  preview: (frameId: string) => Promise<string>
  saved: () => Promise<void>
}

declare global {
  interface Window {
    __preview: PreviewProbe
    __YURIFUL_RENDERER__?: string
  }
}

async function installProbe(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: `
      import { Editor as PreviewEditor } from '/src/editor/Editor.ts'
      import { idOf as previewIdOf } from '/src/editor/objects.ts'
      const previewInit = PreviewEditor.prototype.init
      PreviewEditor.prototype.init = function () {
        const ed = this
        const find = (id) => ed.canvas.getObjects().find((o) => previewIdOf(o) === id)
        const toPage = (sx, sy) => {
          const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
          const v = ed.canvas.viewportTransform
          return { x: r.left + v[0] * sx + v[2] * sy + v[4], y: r.top + v[1] * sx + v[3] * sy + v[5] }
        }
        window.__preview = {
          renderer: () => (ed.scene ? 'dom' : 'fabric'),
          proxy: (id) => {
            const o = find(id)
            if (!o) return null
            const m = o.calcTransformMatrix()
            const w = o.width / 2
            const h = o.height / 2
            return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => toPage(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]))
          },
          controls: () => {
            const a = ed.canvas.getActiveObject()
            if (!a) return null
            const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
            const out = {}
            for (const [k, c] of Object.entries(a.oCoords)) out[k] = { x: r.left + c.x, y: r.top + c.y }
            return out
          },
          select: (id) => ed.selectLayer(id),
          centre: (id) => {
            const c = find(id).getCenterPoint()
            const vp = ed.getViewport()
            ed.setViewport({ zoom: vp.zoom, panX: ed.canvas.getWidth() / 2 - c.x * vp.zoom, panY: ed.canvas.getHeight() / 2 - c.y * vp.zoom })
          },
          feedback: () => ed.getFeedbackSnapshot(),
          preview: async (frameId) => {
            ed.selectLayer(frameId) // a selected frame is toured whether or not it is in view
            const tour = ed.startFrameTour()
            if (!tour) throw new Error('no tour')
            return tour.renderFrame(frameId, new AbortController().signal)
          },
        }
        return previewInit.call(this)
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

const frames = (page: Page, n = 2) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise<number>((resolve) => requestAnimationFrame(resolve))
  }, n)

/** Seeds a board and opens the app on it with the given renderer, in a context of its own. */
async function open(browser: Browser, renderer: 'dom' | 'fabric', doc: StoredBoard, assets: SeedAsset[]) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = errorsOf(page)
  await openBlank(page)
  await seedRaw(page, doc.frames?.length ? 2 : 1, doc as unknown as Record<string, unknown>, assets)
  if (renderer === 'dom') {
    await page.addInitScript(() => {
      window.__YURIFUL_RENDERER__ = 'dom'
    })
  }
  await installProbe(page)
  await openApp(page)
  expect(await page.evaluate(() => window.__preview.renderer())).toBe(renderer)
  await frames(page, 2)
  return {
    page,
    close: async () => {
      expect(errors, renderer).toEqual([])
      await context.close()
    },
  }
}

const board = (frames: StoredFrame[], objects: StoredObject[], viewport = { zoom: 1, panX: 0, panY: 0 }): StoredBoard => ({
  version: 2,
  title: 'Previews',
  frames,
  objects,
  viewport,
})

/** Decodes a PNG (base64 or data URL) in the page and returns its pixels. */
async function pixelsOf(page: Page, png: string): Promise<{ width: number; height: number; data: number[] }> {
  return page.evaluate(async (png) => {
    const img = new Image()
    img.src = png.startsWith('data:') ? png : `data:image/png;base64,${png}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return { width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) }
  }, png)
}

// ---- 1. a narrowed click-created text in its frame's preview ---------------------------------

test.describe('a text narrowed with a side handle stays in its frame\'s preview as on Fabric', () => {
  // Thirty Ws and eight more in Mono: narrowed as far as it goes, the box is as wide as the Mono
  // word, but a preview builds it from its record, as Fabric builds a click-created box: as wide
  // as the longest word in plain sans, which is wider and reaches into the frame (here by more
  // than the room the preview allows a card's ink).
  const WORDS = `${'W'.repeat(30)} ${'W'.repeat(8)}`
  const text = (patch: Partial<StoredObject>): StoredObject => ({ type: 'text', id: 'T', left: 100, top: 120, angle: 0, text: WORDS, fontSize: 32, width: 760, font: 'mono', ...patch }) // its right handle clear of the inspector

  /** Narrows T from its right side handle (towards its left one) as far as it goes, then renders the frame's preview and counts its ink. */
  async function narrowedInk(browser: Browser, renderer: 'dom' | 'fabric', doc: StoredBoard, frameId: string) {
    const { page, close } = await open(browser, renderer, doc, [])
    await page.evaluate(() => window.__preview.select('T'))
    await frames(page, 2)
    const c = (await page.evaluate(() => window.__preview.controls()))!
    const mr = c.mr!
    const ml = c.ml!
    const len = Math.hypot(ml.x - mr.x, ml.y - mr.y)
    const ux = (ml.x - mr.x) / len
    const uy = (ml.y - mr.y) / len
    await page.mouse.move(mr.x, mr.y)
    await page.mouse.down()
    await page.mouse.move(mr.x + ux * (len - 40), mr.y + uy * (len - 40), { steps: 12 })
    await page.mouse.up()
    await expect(page.locator('.save-status')).toContainText('Saved on this device')
    await frames(page, 2)
    const url = await page.evaluate((id) => window.__preview.preview(id), frameId)
    const { data } = await pixelsOf(page, url)
    let ink = 0
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 110 && data[i + 1]! < 110 && data[i + 2]! < 110) ink++
    await close()
    return ink
  }

  const cases: Array<{ name: string; doc: StoredBoard; frameId: string }> = [
    { name: 'right-aligned', doc: board([{ id: 'F', name: 'Right', left: 756, top: 60, width: 420, height: 300 }], [text({ align: 'right' })]), frameId: 'F' },
    { name: 'centred', doc: board([{ id: 'F', name: 'Right', left: 756, top: 60, width: 420, height: 300 }], [text({ align: 'center' })]), frameId: 'F' },
    { name: 'left-aligned', doc: board([{ id: 'F', name: 'Right', left: 756, top: 60, width: 420, height: 300 }], [text({})]), frameId: 'F' },
    // Turned half a turn about its top-left, the box grows to the left on screen: into a frame on that side.
    { name: 'turned half a turn, reaching a frame on its other side', doc: board([{ id: 'G', name: 'Left', left: 60, top: 250, width: 480, height: 320 }], [text({ left: 1220, top: 420, angle: 180, align: 'right' })]), frameId: 'G' },
  ]
  for (const c of cases) {
    test(`${c.name}: the preview shows its ink in the frame as the Fabric preview does`, async ({ browser }) => {
      test.slow() // two boards, one per renderer
      const fabric = await narrowedInk(browser, 'fabric', c.doc, c.frameId)
      const dom = await narrowedInk(browser, 'dom', c.doc, c.frameId)
      console.log(`narrowed text, ${c.name}: ink pixels in the frame's preview fabric ${fabric}, dom ${dom}`)
      expect(fabric, 'the Fabric preview shows the text in the frame').toBeGreaterThan(500)
      expect(Math.abs(dom - fabric), `dom ${dom}, fabric ${fabric}`).toBeLessThanOrEqual(Math.max(30, fabric * 0.03))
    })
  }
})

// ---- 2. the lifted look's shadow at every scale ----------------------------------------------

test.describe('the lifted look casts the canvas\'s shadow at every scale', () => {
  const ASSETS: SeedAsset[] = [
    { id: 'quad', name: 'quad.png', width: 160, height: 120, pattern: 'quadrants' },
    { id: 'small', name: 'small.png', width: 32, height: 24, seed: 2 },
  ]
  const PAPER: StoredFrame = { id: 'P', name: 'Paper', left: -2000, top: -2000, width: 6000, height: 6000 }
  /** Four images at one scale: uncropped and cropped (24 × 20 of a larger picture), upright and turned, on frame paper. */
  const imagesAt = (scale: number): StoredObject[] => {
    // Far apart: each is brought to the middle of the view before it is dragged.
    const img = (id: string, i: number, patch: Partial<StoredObject>): StoredObject => ({
      type: 'image', id, assetId: 'small', left: i * 800, top: 100, angle: 0, scaleX: scale, scaleY: scale, frameId: 'P', ...patch,
    })
    return [
      img('u', 0, {}),
      img('ut', 1, { angle: 25 }),
      img('c', 2, { assetId: 'quad', crop: { x: 60, y: 40, width: 24, height: 20 } }),
      img('ct', 3, { assetId: 'quad', crop: { x: 60, y: 40, width: 24, height: 20 }, angle: -35 }),
    ]
  }

  /** Drags each image in turn and holds it; the screen around it and its corners, in clip pixels. */
  async function shots(browser: Browser, renderer: 'dom' | 'fabric', doc: StoredBoard, clips?: Array<{ x: number; y: number; width: number; height: number }>) {
    const { page, close } = await open(browser, renderer, doc, ASSETS)
    const out: Array<{ png: string; clip: { x: number; y: number; width: number; height: number }; corners: Corner[]; lifted: string[] }> = []
    for (const [i, rec] of doc.objects.entries()) {
      await page.evaluate((id) => window.__preview.centre(id), rec.id)
      await frames(page, 2)
      const c0 = (await page.evaluate((id) => window.__preview.proxy(id), rec.id))!
      const from = { x: c0.reduce((s, p) => s + p.x, 0) / 4, y: c0.reduce((s, p) => s + p.y, 0) / 4 }
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 24, from.y + 16, { steps: 6 })
      await frames(page, 3)
      const corners = (await page.evaluate((id) => window.__preview.proxy(id), rec.id))!
      const xs = corners.map((p) => p.x)
      const ys = corners.map((p) => p.y)
      const clip = clips?.[i] ?? { x: Math.floor(Math.min(...xs)) - 36, y: Math.floor(Math.min(...ys)) - 36, width: Math.ceil(Math.max(...xs) - Math.min(...xs)) + 72, height: Math.ceil(Math.max(...ys) - Math.min(...ys)) + 72 }
      const png = (await page.screenshot({ clip })).toString('base64')
      const lifted = (await page.evaluate(() => window.__preview.feedback().lifted)) as string[]
      await page.mouse.up()
      await frames(page, 2)
      out.push({ png, clip, corners: corners.map((p) => ({ x: p.x - clip.x, y: p.y - clip.y })), lifted })
    }
    return { out, page, close }
  }

  /**
   * The two screens outside the image, beyond 5 screen pixels of its edges (the moving selection
   * border, drawn by the canvas on both renderers, and the edge's anti-aliasing): the largest
   * per-channel difference, the darkest red, and each screen's red 8 pixels below the image's centre.
   */
  async function compare(page: Page, a: string, b: string, corners: Corner[]) {
    const [da, db] = [await pixelsOf(page, a), await pixelsOf(page, b)]
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
        darkest = Math.min(darkest, da.data[i]!)
      }
    }
    const cx = corners.reduce((s, p) => s + p.x, 0) / 4
    let edge = -Infinity
    for (let k = 0; k < 4; k++) {
      const p = corners[k]!
      const q = corners[(k + 1) % 4]!
      if ((p.x - cx) * (q.x - cx) <= 0 && p.x !== q.x) edge = Math.max(edge, p.y + ((cx - p.x) * (q.y - p.y)) / (q.x - p.x))
    }
    const i8 = (Math.round(edge + 8) * da.width + Math.round(cx)) * 4
    return { worst, darkest, at8: [da.data[i8]!, db.data[i8]!] }
  }

  for (const zoom of [1, 1.5]) {
    for (const scale of [0.5, 2.5, 6]) {
      test(`scale ${scale} at ${zoom * 100}%: uncropped and cropped, upright and turned`, async ({ browser }) => {
        test.slow() // two boards, four drags each
        const doc = board([PAPER], imagesAt(scale), { zoom, panX: 0, panY: 0 })
        const fabric = await shots(browser, 'fabric', doc)
        const dom = await shots(browser, 'dom', doc, fabric.out.map((s) => s.clip))
        const report: string[] = []
        for (const [i, rec] of doc.objects.entries()) {
          const r = await compare(dom.page, fabric.out[i]!.png, dom.out[i]!.png, fabric.out[i]!.corners)
          report.push(`${rec.id} red 8px below ${r.at8[0]}/${r.at8[1]}, largest difference ${r.worst}`)
          expect(dom.out[i]!.lifted, rec.id).toEqual([rec.id])
          expect(r.darkest, `${rec.id}: there is a shadow to compare`).toBeLessThan(240)
          expect(r.worst, `${rec.id}: largest per-channel difference outside the image`).toBeLessThanOrEqual(3)
        }
        console.log(`lift shadow, scale ${scale} at ${zoom * 100}% (fabric/dom): ${report.join('; ')}`)
        await fabric.close()
        await dom.close()
      })
    }
  }
})
