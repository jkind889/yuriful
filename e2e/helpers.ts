import { expect } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import zlib from 'node:zlib'

/** The autosave debounce is 500ms; "nothing was written" checks wait well past it. */
export const AUTOSAVE_QUIET_MS = 1500

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
}
export interface StoredFrame {
  id: string
  name: string
  left: number
  top: number
  width: number
  height: number
}
export interface StoredBoard {
  version: number
  title: string
  frames?: StoredFrame[]
  objects: StoredObject[]
  viewport: { zoom: number; panX: number; panY: number }
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
  await expect(page.locator('.toolbar')).toBeVisible()
  await expect(status(page)).toContainText('Saved on this device')
}

export const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo' })
export const redoButton = (page: Page) => page.getByRole('button', { name: 'Redo' })
