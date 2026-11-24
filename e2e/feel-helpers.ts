import type { Page } from '@playwright/test'
import type { FeedbackSnapshot } from '../src/editor/feedbackLayer.ts'
import type { CanvasPrefs } from '../src/model/prefs.ts'
import type { Scene, Viewport } from '../src/model/types.ts'
import type { Rect } from '../src/model/viewport.ts'
import { albumSpread, fetchRetrying, openApp, openBlank, pagePixels, pngBuffer, sceneToPage, seedRaw } from './helpers.ts'
import type { SeedAsset, StoredBoard } from './helpers.ts'

export const VIEW: Viewport = { zoom: 1, panX: 0, panY: 0 }
export const FRAME = { id: 'back', name: 'Back', left: 200, top: 160, width: 340, height: 320 }
export const FRONT = { id: 'front', name: 'Front', left: 490, top: 150, width: 390, height: 340 }
export const IMAGE = { type: 'image', id: 'picture', left: 300, top: 250, angle: 0, assetId: 'fixture', scaleX: 1, scaleY: 1, frameId: FRAME.id }
export const CENTRE = { x: 350, y: 280 }
export const ASSET = { id: IMAGE.assetId, name: 'fixture.png', width: 100, height: 60 }
export const NO_FEEDBACK: FeedbackSnapshot = { gaining: [], losing: [], lifted: [], carried: [], drop: null, snap: null }

interface FeelProbe {
  feedback: () => FeedbackSnapshot
  viewport: () => Viewport
  scene: () => Scene
  history: () => Scene
  controls: () => Record<string, { x: number; y: number }> | undefined
  bounds: (id: string) => Rect | null
  viewSamples: () => Viewport[]
  stagedImports: () => number
  dispose: () => void
}

declare global {
  interface Window {
    __feel: FeelProbe
  }
}

/** Observe the normal app instance. This hook lives in the browser test route only. */
async function installFeelProbe(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    const response = await fetchRetrying(route)
    const source = await response.text()
    await route.fulfill({ response, body: `
      import { Editor as FeelEditor } from '/src/editor/Editor.ts'
      import { idOf as feelIdOf } from '/src/editor/objects.ts'
      const initFeelEditor = FeelEditor.prototype.init
      FeelEditor.prototype.init = function () {
        const views = []
        let lastView = this.getViewport()
        this.subscribe(() => {
          const view = this.getViewport()
          if (view.panX !== lastView.panX || view.panY !== lastView.panY || view.zoom !== lastView.zoom) views.push(view)
          lastView = view
        })
        window.__feel = {
          feedback: () => this.getFeedbackSnapshot(),
          viewport: () => this.getViewport(),
          scene: () => this.snapshot(),
          history: () => this.history.current,
          controls: () => this.canvas.getActiveObject()?.oCoords,
          bounds: (id) => {
            const obj = this.canvas.getObjects().find((obj) => feelIdOf(obj) === id)
            if (!obj) return null
            const { left, top, width, height } = obj.getBoundingRect()
            return { left, top, right: left + width, bottom: top + height }
          },
          viewSamples: () => views.splice(0),
          stagedImports: () => this.stagedImports.length,
          dispose: () => this.dispose(),
        }
        return initFeelEditor.call(this)
      }
      ${source}
    ` })
  })
}

export async function openFeel(page: Page, {
  frames = [FRAME, FRONT],
  objects = [IMAGE],
  viewport = VIEW,
  assets = [ASSET],
  feedback = true,
}: { frames?: typeof FRAME[]; objects?: Array<Record<string, unknown>>; viewport?: Viewport; assets?: SeedAsset[]; feedback?: boolean } = {}) {
  return openFeelBoard(page, { version: 2, title: 'Canvas feel', frames, objects, viewport }, assets, { feedback })
}

export async function openAlbumFeel(page: Page, change?: (doc: StoredBoard) => void, prefs: Partial<CanvasPrefs> = {}) {
  const { doc, assets } = albumSpread()
  change?.(doc)
  const at = await openFeelBoard(page, { ...doc }, assets, prefs)
  return { at, before: doc }
}

async function openFeelBoard(page: Page, board: Record<string, unknown> & { viewport: Viewport }, assets: SeedAsset[], prefs: Partial<CanvasPrefs>) {
  await openBlank(page)
  await seedRaw(page, 2, board, assets)
  if (Object.keys(prefs).length > 0) await page.evaluate((value) => localStorage.setItem('yuriful.prefs.v1', JSON.stringify(value)), prefs)
  await installFeelProbe(page)
  await openApp(page)
  return sceneToPage(page, board.viewport)
}

/**
 * Whether the page paints the drag lift's shadow under an object: a strip just below its bottom
 * edge (a fifth to two fifths of the way along, clear of the corner and middle handles) is
 * darkened by it. The strip is compared with the same strip with the scene layer's filters taken
 * away, so a lifted item whose shadow is not actually painted reads as not lifted.
 */
export async function liftShadow(page: Page, id: string): Promise<boolean> {
  const { rect, view } = await page.evaluate((id) => ({ rect: window.__feel.bounds(id), view: window.__feel.viewport() }), id)
  if (!rect) return false
  const box = await canvasBox(page)
  const width = Math.max(4, (rect.right - rect.left) * view.zoom * 0.2)
  const x = box.x + rect.left * view.zoom + view.panX + width
  const y = box.y + rect.bottom * view.zoom + view.panY + 2
  const shown = await pagePixels(page, x, y, width, 6)
  const bare = await pagePixels(page, x, y, width, 6, { style: '.scene-layer .scene-item { filter: none !important; }' })
  let most = 0
  for (let i = 0; i < shown.data.length; i++) most = Math.max(most, Math.abs(shown.data[i]! - bare.data[i]!))
  return most > 8
}

export const albumLayer = (page: Page, id: string) => page.getByRole('option').and(page.locator(`[data-layer-id="${id}"]`))

export const readFeedback = (page: Page) => page.evaluate(() => window.__feel.feedback())
export const readView = (page: Page) => page.evaluate(() => window.__feel.viewport())

export async function canvasBox(page: Page) {
  const box = await page.locator('.canvas-host').boundingBox()
  if (!box) throw new Error('canvas host not found')
  return box
}

export async function sampleViewTwice(page: Page) {
  const before = await readView(page)
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise<number>((resolve) => requestAnimationFrame(resolve))
  })
  const after = await readView(page)
  return { before, after }
}

/** Native drag events with a synthetic PNG payload, through the app's workspace listeners. */
export async function fileDrag(
  page: Page,
  kind: 'dragenter' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  point: { x: number; y: number },
  outside = false,
) {
  await page.evaluate(({ kind, point, png, outside }) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'drop.png', { type: 'image/png' }))
    const target = outside || kind === 'dragend' ? window : document.querySelector('.workspace')!
    target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer, clientX: point.x, clientY: point.y }))
  }, { kind, point, png: pngBuffer(80, 40).toString('base64'), outside })
}
