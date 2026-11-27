/**
 * FROZEN copy of milestone 1's storage code (src/persistence/boardStore.ts at commit
 * 71627fe): how that build opened the database, saved a board and pruned assets.
 * Tests use it to produce genuine milestone 1 rows and to play the part of a stale
 * milestone 1 tab. Do not "fix" or modernize it: its value is that it does exactly
 * what the old build did. Only for tests (unit and e2e); the app never imports it.
 */

/** A milestone 1 document. That build wrote whatever object it was handed, unchanged. */
export interface LegacyDocV1 {
  version: 1
  title: string
  objects: unknown[]
  viewport: { zoom: number; panX: number; panY: number }
}

export interface LegacyAsset {
  id: string
  name: string
  type: string
  bytes: ArrayBuffer
}

const DB_NAME = 'yuriful'
const DB_VERSION = 1
const BOARDS = 'boards'
const ASSETS = 'assets'
const CURRENT_BOARD = 'current'

interface BoardRow {
  id: string
  doc: LegacyDocV1
  updatedAt: number
}

const describe = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export class LegacyStoreV1 {
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error('IndexedDB is not available in this browser.'))
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest
      try {
        req = this.factory!.open(DB_NAME, DB_VERSION)
      } catch (e) {
        reject(new Error(describe(e, 'Could not open local storage.')))
        return
      }
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(BOARDS)) db.createObjectStore(BOARDS, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => {
          db.close()
          this.dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => reject(new Error(describe(req.error, 'Could not open local storage.')))
      req.onblocked = () => reject(new Error('Local storage is blocked by another yuriful tab.'))
    })
    // A failed open must be retryable.
    this.dbPromise.catch(() => {
      this.dbPromise = null
    })
    return this.dbPromise
  }

  /** The raw stored row (milestone 1 parsed `doc` afterwards; the fixture leaves that to the caller). */
  async loadRaw(): Promise<{ doc: unknown; updatedAt: number } | null> {
    const db = await this.open()
    const tx = db.transaction([BOARDS, ASSETS], 'readonly')
    const row = (await request(tx.objectStore(BOARDS).get(CURRENT_BOARD))) as BoardRow | undefined
    return row ?? null
  }

  async save(doc: LegacyDocV1, newAssets: readonly LegacyAsset[]): Promise<void> {
    const db = await this.open()
    const tx = db.transaction([BOARDS, ASSETS], 'readwrite')
    const done = transactionDone(tx)
    done.catch(() => {}) // surfaced via the await below; avoid an unhandled duplicate
    try {
      const assets = tx.objectStore(ASSETS)
      for (const a of newAssets) assets.put(a)
      const row: BoardRow = { id: CURRENT_BOARD, doc, updatedAt: Date.now() }
      tx.objectStore(BOARDS).put(row)
    } catch (e) {
      try {
        tx.abort()
      } catch {
        /* already finished */
      }
      throw new Error(describe(e, 'Could not write to local storage.'), { cause: e })
    }
    try {
      await done
    } catch (e) {
      throw new Error(describe(e, 'Could not write to local storage (it may be full).'), { cause: e })
    }
  }

  async pruneAssets(keep: ReadonlySet<string>): Promise<void> {
    const db = await this.open()
    const tx = db.transaction(ASSETS, 'readwrite')
    const done = transactionDone(tx)
    const store = tx.objectStore(ASSETS)
    const keys = (await request(store.getAllKeys())) as IDBValidKey[]
    for (const k of keys) if (typeof k === 'string' && !keep.has(k)) store.delete(k)
    await done
  }

  /** Not in milestone 1: lets a test drop the connection the way closing the tab would. */
  async close(): Promise<void> {
    const current = this.dbPromise
    this.dbPromise = null
    if (current) (await current).close()
  }
}
