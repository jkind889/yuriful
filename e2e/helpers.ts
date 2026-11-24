import { expect } from '@playwright/test'
import type { APIResponse, BrowserContext, Page, Route } from '@playwright/test'
import zlib from 'node:zlib'

/**
 * `route.fetch()` for a route that rewrites a dev-server module (the test probes on `/src/main.tsx`),
 * tried again on a network error: on a busy machine the dev server can reset the connection while
 * a page reloads (`route.fetch: read ECONNRESET`). Any other error, and the first error when every
 * try fails, is thrown as it came.
 */
export async function fetchRetrying(route: Route, tries = 4): Promise<APIResponse> {
  let first: unknown = null
  for (let i = 0; ; i++) {
    try {
      return await route.fetch()
    } catch (e) {
      first ??= e
      const network = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/i.test(String(e))
      if (!network || i + 1 >= tries) throw first
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)))
    }
  }
}

/** The autosave debounce is 500ms; "nothing was written" checks wait well past it. */
export const AUTOSAVE_QUIET_MS = 1500

/**
 * How long a test waits for the app to appear after a page is opened or reloaded. Several browser
 * suites running at once on one machine can make the dev server slow to answer; the default five
 * seconds then fails a test that has nothing wrong with it.
 */
export const APP_READY_MS = 20_000

// ---- deterministic image fixtures (no binary files in the repo) -------------------------

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Quadrant base colours of `quadrantsPng`: top-left, top-right, bottom-left, bottom-right. */
export const QUADRANT_COLOURS = { tl: [220, 40, 40], tr: [40, 180, 60], bl: [40, 70, 220], br: [230, 200, 30] } as const

/**
 * Four coloured quadrants (see `QUADRANT_COLOURS`) overlaid with an 8-pixel checker that
 * darkens every other cell, so that a region of the canvas changes visibly if the image moves
 * by even one pixel, and so that a sample says which part of the original it shows.
 */
function quadrantPixel(x: number, y: number, width: number, height: number): readonly number[] {
  const q = y < height / 2 ? (x < width / 2 ? QUADRANT_COLOURS.tl : QUADRANT_COLOURS.tr) : x < width / 2 ? QUADRANT_COLOURS.bl : QUADRANT_COLOURS.br
  const dark = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 1
  return dark ? q.map((c) => Math.round(c * 0.55)) : q
}

/** A valid RGB PNG with a diagonal gradient, so different sizes/seeds differ byte-for-byte; or `quadrantsPng`'s pattern. */
export function pngBuffer(width: number, height: number, seed = 0, pattern: 'gradient' | 'quadrants' = 'gradient'): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3
      if (pattern === 'quadrants') {
        const [r, g, b] = quadrantPixel(x, y, width, height)
        raw[i] = r!
        raw[i + 1] = g!
        raw[i + 2] = b!
        continue
      }
      raw[i] = Math.floor((x / width) * 255)
      raw[i + 1] = (120 + seed * 40) % 256
      raw[i + 2] = Math.floor((y / height) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const imageFile = (name: string, width: number, height: number, seed = 0) => ({
  name,
  mimeType: 'image/png',
  buffer: pngBuffer(width, height, seed),
})

// ---- reading what is really persisted ------------------------------------------------------

export interface IdbSnapshot {
  /** The stored document, serialized exactly as stored. */
  doc: string
  updatedAt: number | null
  /** id -> byte length + sha256 prefix + mime type. */
  assets: Record<string, { len: number; sha: string; type: string }>
}

/** Reads the persisted board and every asset's bytes (hashed) straight from IndexedDB. */
export function snapshotIdb(page: Page): Promise<IdbSnapshot> {
  return page.evaluate(
    () =>
      new Promise<IdbSnapshot>((resolve, reject) => {
        const open = indexedDB.open('yuriful')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['boards', 'assets'], 'readonly')
          const board = tx.objectStore('boards').get('current')
          const all = tx.objectStore('assets').getAll()
          tx.oncomplete = async () => {
            db.close()
            const assets: IdbSnapshot['assets'] = {}
            for (const a of all.result as Array<{ id: string; bytes: ArrayBuffer; type: string }>) {
              const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', a.bytes))
              const sha = Array.from(hash.slice(0, 8), (n) => n.toString(16).padStart(2, '0')).join('')
              assets[a.id] = { len: a.bytes.byteLength, sha, type: a.type }
            }
            resolve({ doc: JSON.stringify(board.result?.doc ?? null), updatedAt: board.result?.updatedAt ?? null, assets })
          }
        }
      }),
  )
}

/** Runs `fn` against the raw IndexedDB (used to tamper with stored data in tests). */
export function tamperIdb(page: Page, fn: 'corrupt-second-asset' | 'add-orphan' | 'unreadable-board'): Promise<void> {
  return page.evaluate(
    (action) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('yuriful')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['boards', 'assets'], 'readwrite')
          const assets = tx.objectStore('assets')
          if (action === 'corrupt-second-asset') {
            const all = assets.getAll()
            all.onsuccess = () => {
              const victim = [...all.result].sort((a, b) => (a.id < b.id ? -1 : 1))[1]
              assets.put({ ...victim, bytes: new TextEncoder().encode('definitely not an image').buffer })
            }
          } else if (action === 'add-orphan') {
            assets.put({ id: 'orphan-asset', name: 'orphan.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3, 4]).buffer })
          } else {
            tx.objectStore('boards').put({ id: 'current', doc: { version: 99, junk: true }, updatedAt: 1 })
          }
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    fn,
  )
}

// ---- driving the app --------------------------------------------------------------------------

export const status = (page: Page) => page.locator('.save-status')

export async function waitSaved(page: Page) {
  await expect(status(page)).toContainText('Saved on this device')
}

/**
 * Builds a saved board through the real UI: two images (600x400, 300x500) and one text.
 * Returns the (still open) page, which doubles as an independent reader of IndexedDB.
 */
export async function seedBoard(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.locator('.empty-state')).toBeVisible()
  await page.setInputFiles('input[type=file]', [imageFile('wide.png', 600, 400, 0), imageFile('tall.png', 300, 500, 1)])
  await expect(page.locator('.inspector-title')).toHaveText('Image')
  await page.keyboard.press('Escape')
  await page.keyboard.press('t')
  await page.mouse.click(90, 440)
  await page.keyboard.type('persist me')
  await page.keyboard.press('Escape')
  await waitSaved(page)
  return page
}

/**
 * Stalls hydration for real: the IndexedDB open() "success" event is held back until
 * `releaseHydration(page)` is called, so the editor mounts but its stored board is unavailable.
 */
export function stallHydration(page: Page) {
  return page.addInitScript(() => {
    const w = window as unknown as { __releaseHydration: () => void }
    const gate = new Promise<void>((resolve) => (w.__releaseHydration = resolve))
    const realOpen = IDBFactory.prototype.open
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
      const req = realOpen.apply(this, args)
      let handler: ((this: IDBRequest, ev: Event) => unknown) | null = null
      Object.defineProperty(req, 'onsuccess', {
        configurable: true,
        get: () => handler,
        set: (fn: typeof handler) => {
          handler = fn
          req.addEventListener('success', (e) => void gate.then(() => fn?.call(req, e)))
        },
      })
      return req
    }
  })
}

export const releaseHydration = (page: Page) => page.evaluate(() => (window as unknown as { __releaseHydration: () => void }).__releaseHydration())

/** Simulates storage that cannot be opened at all (e.g. blocked by browser settings). */
export function makeStorageUnavailable(page: Page) {
  return page.addInitScript(() => {
    IDBFactory.prototype.open = () => {
      throw new DOMException('Storage access denied', 'SecurityError')
    }
  })
}

/** Dispatches a real DragEvent drop of an image file onto the workspace. */
export function dropImage(page: Page, name: string, base64: string, at = { x: 400, y: 300 }) {
  return page.evaluate(
    ({ name, base64, at }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], name, { type: 'image/png' }))
      const ws = document.querySelector('.workspace')!
      const make = (type: string) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at.x, clientY: at.y })
      ws.dispatchEvent(make('dragenter'))
      ws.dispatchEvent(make('dragover'))
      ws.dispatchEvent(make('drop'))
    },
    { name, base64, at },
  )
}

// ---- seeding IndexedDB directly (boards that the UI cannot easily produce) -------------------

export interface SeedAsset {
  id: string
  name: string
  width: number
  height: number
  seed?: number
  /** The pixels: a gradient (default), or coloured quadrants with a checker (for position checks). */
  pattern?: 'gradient' | 'quadrants'
}

/** An app-origin page that does not run the app, so storage can be prepared before the app loads. */
export async function openBlank(page: Page) {
  await page.route('**/__blank', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' }))
  await page.goto('/__blank')
}

const assetPayload = (assets: readonly SeedAsset[]) =>
  assets.map((a) => ({ id: a.id, name: a.name, type: 'image/png', base64: pngBuffer(a.width, a.height, a.seed ?? 0, a.pattern).toString('base64') }))

/**
 * Writes a board exactly as milestone 1 did: through the frozen copy of that build's own
 * store code (version 1 database, version 1 row without a revision id). Call on a blank page.
 */
export function seedMilestone1(page: Page, doc: Record<string, unknown>, assets: readonly SeedAsset[] = []): Promise<void> {
  return page.evaluate(
    async ({ doc, assets }) => {
      const path = '/src/persistence/testing/legacyStoreV1.ts'
      const { LegacyStoreV1 } = await import(/* @vite-ignore */ path)
      const store = new LegacyStoreV1()
      const decoded = assets.map((a) => ({ id: a.id, name: a.name, type: a.type, bytes: Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0)).buffer }))
      await store.save(doc, decoded)
      await store.close()
    },
    { doc, assets: assetPayload(assets) },
  )
}

/** Writes a row and assets straight into a database of the given version (for boards with frames). Call on a blank page. */
export function seedRaw(page: Page, version: number, doc: Record<string, unknown>, assets: readonly SeedAsset[] = []): Promise<void> {
  return page.evaluate(
    ({ version, doc, assets }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('yuriful', version)
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains('boards')) open.result.createObjectStore('boards', { keyPath: 'id' })
          if (!open.result.objectStoreNames.contains('assets')) open.result.createObjectStore('assets', { keyPath: 'id' })
        }
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['boards', 'assets'], 'readwrite')
          for (const a of assets) {
            tx.objectStore('assets').put({ id: a.id, name: a.name, type: a.type, bytes: Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0)).buffer })
          }
          tx.objectStore('boards').put({ id: 'current', doc, rev: 'seeded', updatedAt: 1 })
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    { version, doc, assets: assetPayload(assets) },
  )
}

export interface StoredObject {
  id: string
  type: 'image' | 'text'
  left: number
  top: number
  angle: number
  frameId?: string
  locked?: true
  assetId?: string
  scaleX?: number
  scaleY?: number
  fontSize?: number
  width?: number
  minHeight?: number
  text?: string
  crop?: { x: number; y: number; width: number; height: number }
  font?: string
  align?: string
  color?: string
  spans?: Array<{ start: number; end: number; bold?: true; italic?: true; underline?: true; strike?: true; font?: string }>
  headings?: number[]
  height?: number
  blocks?: unknown[]
  surface?: 'card'
  captionOf?: string
  captionSide?: 'top' | 'left' | 'right'
  captionPosition?: number
  captionBackground?: string
}
export interface StoredFrame {
  id: string
  name: string
  left: number
  top: number
  width: number
  height: number
  locked?: true
}
export interface StoredBoard {
  version: number
  title: string
  frames?: StoredFrame[]
  objects: StoredObject[]
  viewport: { zoom: number; panX: number; panY: number }
}

/** The same synthetic album spread for the interactive canvas milestones. */
export function albumSpread(): { doc: StoredBoard; assets: SeedAsset[] } {
  const frame = { id: 'sleeve', name: 'Sleeve, side A', left: 140, top: 90, width: 610, height: 465 }
  const image = (id: string, left: number, top: number, patch: Partial<StoredObject> = {}): StoredObject =>
    ({ type: 'image', id, assetId: id, left, top, angle: 0, scaleX: 1, scaleY: 1, frameId: frame.id, ...patch })
  const text = (id: string, left: number, top: number, value: string, patch: Partial<StoredObject> = {}): StoredObject =>
    ({ type: 'text', id, left, top, angle: 0, text: value, fontSize: 24, width: 150, minHeight: 0, frameId: frame.id, ...patch })
  const loose = image('loose', 620, 450)
  delete loose.frameId
  return {
    doc: {
      version: 2, title: 'Album spread', frames: [frame], viewport: { zoom: 1, panX: 0, panY: 0 },
      objects: [
        image('front', 210, 150),
        text('caption', 210, 280, 'Front sleeve', { captionOf: 'front' }),
        image('back', 520, 154, { angle: 90 }),
        image('detail', 575, 175, { crop: { x: 25, y: 10, width: 90, height: 70 } }),
        image('stack-bottom', 335, 355),
        image('stack-top', 385, 385),
        text('notes', 535, 350, 'Design notes\nUse uncoated stock', { width: 200, headings: [2] }),
        image('locked-image', 205, 405, { locked: true }),
        text('locked-text', 350, 485, 'Master proof', { locked: true }),
        loose,
      ],
    },
    assets: [
      { id: 'front', name: 'Front cover.png', width: 150, height: 120, pattern: 'quadrants' },
      { id: 'back', name: 'Back cover.png', width: 120, height: 100, seed: 1 },
      { id: 'detail', name: 'Printing detail.png', width: 160, height: 100, seed: 2 },
      { id: 'stack-bottom', name: 'Printed insert.png', width: 110, height: 80, seed: 3 },
      { id: 'stack-top', name: 'Paper sample.png', width: 100, height: 70, seed: 4 },
      { id: 'locked-image', name: 'Archive scan.png', width: 98, height: 91, seed: 5 },
      { id: 'loose', name: 'Loose reference.png', width: 80, height: 75, seed: 6 },
    ],
  }
}

/** The stored document, parsed. */
export async function storedDoc(page: Page): Promise<StoredBoard> {
  return JSON.parse((await snapshotIdb(page)).doc) as StoredBoard
}

export function dbVersion(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('yuriful')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const v = open.result.version
          open.result.close()
          resolve(v)
        }
      }),
  )
}

// ---- pointing at things on the canvas ------------------------------------------------------

export interface View {
  zoom: number
  panX: number
  panY: number
}

/** Converts scene coordinates to page coordinates for the given viewport. */
export async function sceneToPage(page: Page, view: View) {
  const box = await page.locator('.canvas-host').boundingBox()
  if (!box) throw new Error('canvas host not found')
  return (x: number, y: number) => ({ x: box.x + x * view.zoom + view.panX, y: box.y + y * view.zoom + view.panY })
}

/** Presses at `from`, moves to `to` in steps, and (unless `hold`) releases. */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { hold?: boolean; steps?: number } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 8 })
  if (!opts.hold) await page.mouse.up()
}

/** Loads the app on a seeded board and waits until it is editable. */
export async function openApp(page: Page) {
  await page.goto('/')
  await expect(page.locator('.toolbar')).toBeVisible({ timeout: APP_READY_MS })
  await expect(status(page)).toContainText('Saved on this device')
}

export const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo' })
export const redoButton = (page: Page) => page.getByRole('button', { name: 'Redo' })

// ---- the text being edited -------------------------------------------------------------------

export interface EditedText {
  /** The text, one `\n` per line break. */
  value: string
  /** The selection the page shows in the text, as UTF-16 offsets (`start <= end`); both null when the page shows none in it. */
  start: number | null
  end: number | null
  /** The edited text has the keyboard: it is focused and the page's selection is in it. */
  focused: boolean
}

/**
 * The text being edited, as the page shows it, or null when none is. The edited card holds the
 * text engine's live view: its text, and the page's own selection inside it (mapped to text
 * offsets by the engine's pure `textOffsetAt`); with no selection in it, `start` and `end` are
 * null and it does not have the keyboard.
 */
export function editedText(page: Page): Promise<EditedText | null> {
  return page.evaluate(async () => {
    type Desc = { node: unknown; posFromDOM: (node: Node, offset: number, bias: number) => number }
    const root = document.querySelector<HTMLElement & { pmViewDesc?: Desc }>('.scene-layer [contenteditable="true"].ProseMirror')
    if (!root?.pmViewDesc) return null
    const path = '/src/editor/textSchema.ts'
    const { plainTextOfDoc, textOffsetAt } = await import(/* @vite-ignore */ path)
    const desc = root.pmViewDesc
    const doc = desc.node
    const sel = getSelection()
    let start: number | null = null
    let end: number | null = null
    if (sel && sel.rangeCount > 0 && sel.anchorNode && sel.focusNode && root.contains(sel.anchorNode) && root.contains(sel.focusNode)) {
      const a = textOffsetAt(doc, desc.posFromDOM(sel.anchorNode, sel.anchorOffset, -1), -1) as number
      const b = textOffsetAt(doc, desc.posFromDOM(sel.focusNode, sel.focusOffset, -1), -1) as number
      start = Math.min(a, b)
      end = Math.max(a, b)
    }
    return { value: plainTextOfDoc(doc) as string, start, end, focused: document.activeElement === root && start !== null }
  })
}

/** The text being edited has the keyboard (see `editedText`). */
export const editHasFocus = async (page: Page) => (await editedText(page))?.focused === true

// ---- what the page shows -----------------------------------------------------------------------

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what Playwright's screenshots are) to RGBA. */
export function decodePng(png: Buffer): { width: number; height: number; data: Uint8Array } {
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat: Buffer[] = []
  while (pos < png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.toString('ascii', pos + 4, pos + 8)
    const body = png.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0) throw new Error('decodePng: only 8-bit, non-interlaced images')
      colorType = body[9]!
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`decodePng: colour type ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0
      const b = prev[i]!
      const c = i >= channels ? prev[i - channels]! : 0
      const x = line[i]!
      let v: number
      if (filter === 0) v = x
      else if (filter === 1) v = x + a
      else if (filter === 2) v = x + b
      else if (filter === 3) v = x + ((a + b) >> 1)
      else {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      cur[i] = v & 0xff
    }
    for (let px = 0; px < width; px++) {
      const o = (y * width + px) * 4
      out[o] = cur[px * channels]!
      out[o + 1] = cur[px * channels + 1]!
      out[o + 2] = cur[px * channels + 2]!
      out[o + 3] = channels === 4 ? cur[px * channels + 3]! : 255
    }
    prev = cur
  }
  return { width, height, data: out }
}

/**
 * The board's backdrop while `screenPixels` samples it: its colour with no dots, so that a pixel
 * where nothing is drawn reads as exactly this.
 */
export const BOARD_BACKDROP = [241, 243, 248, 255] as const

/**
 * What the page shows in a rectangle of the canvas (CSS pixels from the canvas host's top-left,
 * the coordinates of Fabric's canvas element): a composited screenshot, so frame paper, images
 * and text drawn by the scene layer and the canvas's frame outlines, labels and selection chrome
 * are all in it, as a person sees them. The panels over the board, the board's dots and the caret
 * are left out while it is taken. RGBA, `width * height * 4` bytes, one pixel per CSS pixel.
 */
export async function screenPixels(page: Page, left: number, top: number, width: number, height: number) {
  const box = await page.locator('.canvas-host').boundingBox()
  if (!box) throw new Error('canvas host not found')
  return pagePixels(page, box.x + left, box.y + top, width, height)
}

/** What `pagePixels` may change while it takes its screenshot. */
export interface ShotOptions {
  /** A stylesheet applied for the screenshot only, after the one that hides the panels and dots. */
  style?: string
  /** The board's backdrop colour for this screenshot (RGB), instead of `BOARD_BACKDROP`. */
  backdrop?: readonly number[]
}

/** As `screenPixels`, for a rectangle in page coordinates. */
export async function pagePixels(page: Page, left: number, top: number, width: number, height: number, opts: ShotOptions = {}) {
  const backdrop = [...(opts.backdrop ?? BOARD_BACKDROP).slice(0, 3), 255]
  const vp = page.viewportSize()!
  // Only the part inside the viewport can be captured; the rest reads as the backdrop.
  const x0 = Math.max(0, Math.round(left))
  const y0 = Math.max(0, Math.round(top))
  const x1 = Math.min(vp.width, Math.round(left) + Math.round(width))
  const y1 = Math.min(vp.height, Math.round(top) + Math.round(height))
  const w = Math.round(width)
  const h = Math.round(height)
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < data.length; i += 4) data.set(backdrop, i)
  if (x1 > x0 && y1 > y0) {
    const png = await page.screenshot({
      clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      scale: 'css',
      animations: 'disabled',
      caret: 'hide',
      style: `.overlays { visibility: hidden !important; } .workspace { background-image: none !important; background-color: rgb(${backdrop.slice(0, 3).join(',')}) !important; } ${opts.style ?? ''}`,
    })
    const shot = decodePng(png)
    const dx = x0 - Math.round(left)
    const dy = y0 - Math.round(top)
    for (let y = 0; y < shot.height && y + dy < h; y++) {
      for (let x = 0; x < shot.width && x + dx < w; x++) {
        const s = (y * shot.width + x) * 4
        data.set(shot.data.subarray(s, s + 4), ((y + dy) * w + x + dx) * 4)
      }
    }
  }
  return { width: w, height: h, data }
}

/** One pixel the page shows at a point of the canvas (see `screenPixels`), RGBA. */
export async function screenPixel(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  const { data } = await screenPixels(page, Math.round(x), Math.round(y), 1, 1)
  return [data[0]!, data[1]!, data[2]!, data[3]!]
}

/** A second backdrop colour, far from the first, for telling "nothing painted here" from "painted the backdrop's colour". */
const OTHER_BACKDROP = [20, 160, 90] as const

/**
 * Whether anything is painted at a point of the canvas: the pixel is the backdrop under two very
 * different backdrop colours only where nothing covers the board there, so something opaque
 * painted in the backdrop's own colour still counts.
 */
export async function paintedAt(page: Page, x: number, y: number): Promise<boolean> {
  const box = await page.locator('.canvas-host').boundingBox()
  if (!box) throw new Error('canvas host not found')
  const at = (backdrop: readonly number[]) => pagePixels(page, box.x + Math.round(x), box.y + Math.round(y), 1, 1, { backdrop })
  const [a, b] = [(await at(BOARD_BACKDROP)).data, (await at(OTHER_BACKDROP)).data]
  const same = (d: Uint8Array, c: readonly number[]) => d[0] === c[0] && d[1] === c[1] && d[2] === c[2]
  return !(same(a, BOARD_BACKDROP) && same(b, OTHER_BACKDROP))
}

// ---- the lettering the page paints ---------------------------------------------------------------

/** Lettering in a sampled rectangle: how many pixels, and their extent within it (Infinity / -Infinity when none). */
export interface Lettering {
  count: number
  left: number
  right: number
  top: number
  bottom: number
}

/** Hides the lettering of every text card, the edited one included, and nothing else (layout, outlines and highlights stay). */
const NO_LETTERING = '.scene-layer .scene-text-body, .scene-layer .scene-text-body * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important; text-shadow: none !important; }'

/**
 * The text lettering the page paints in a rectangle of the page: the pixels that change when the
 * lettering is taken away, that is every card's text colour (the card being edited included), so
 * lettering that is invisible, clipped or out of place in the live editor shows here as missing
 * or moved.
 */
export async function letteringAt(page: Page, left: number, top: number, width: number, height: number): Promise<Lettering> {
  const shown = await pagePixels(page, left, top, width, height)
  const bare = await pagePixels(page, left, top, width, height, { style: NO_LETTERING })
  const ink: Lettering = { count: 0, left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
  const d = shown.data
  const e = bare.data
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.max(Math.abs(d[i]! - e[i]!), Math.abs(d[i + 1]! - e[i + 1]!), Math.abs(d[i + 2]! - e[i + 2]!))
    if (diff <= 48) continue
    const x = (i / 4) % shown.width
    const y = Math.floor(i / 4 / shown.width)
    ink.count++
    ink.left = Math.min(ink.left, x)
    ink.right = Math.max(ink.right, x)
    ink.top = Math.min(ink.top, y)
    ink.bottom = Math.max(ink.bottom, y)
  }
  return ink
}

/** As `letteringAt`, for a rectangle of the canvas (CSS pixels from the canvas host's top-left). */
export async function letteringIn(page: Page, left: number, top: number, width: number, height: number): Promise<Lettering> {
  const box = await page.locator('.canvas-host').boundingBox()
  if (!box) throw new Error('canvas host not found')
  return letteringAt(page, box.x + left, box.y + top, width, height)
}

/**
 * The lettering painted while a text is edited is the lettering painted once the edit has ended:
 * visible (enough of it), in the same place (within 2 px), and as much of it (within 10 %).
 */
export function expectSameLettering(live: Lettering, idle: Lettering, min = 100) {
  expect(idle.count, 'lettering once the edit has ended').toBeGreaterThan(min)
  expect(live.count, 'lettering while editing').toBeGreaterThan(idle.count * 0.9)
  expect(live.count, 'lettering while editing').toBeLessThan(idle.count * 1.1)
  for (const side of ['left', 'right', 'top', 'bottom'] as const) expect(Math.abs(live[side] - idle[side]), `lettering's ${side} edge while editing`).toBeLessThanOrEqual(2)
}
