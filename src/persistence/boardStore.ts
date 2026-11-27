import { parseDoc, referencedAssetIds, serializeDoc } from '../model/doc.ts'
import { newId } from '../model/id.ts'
import type { BoardDoc, StoredAsset, StoredDoc } from '../model/types.ts'

/**
 * What a tab believes is stored, captured when it loaded or last saved. Every write
 * re-checks it inside its own transaction, so a tab whose view is stale can never
 * overwrite (or prune under) a board another tab has changed.
 */
export type RevisionToken =
  /** No row at all. */
  | { kind: 'absent' }
  /** A row written by this build: an opaque id that changes on every write. */
  | { kind: 'rev'; rev: string }
  /**
   * A row written by milestone 1, which has no revision id. It is identified by its
   * timestamp and its exact document, so two legacy rows that match are byte-identical
   * documents and writing over them loses nothing. `updatedAt` is null when the row has
   * no numeric timestamp. `docJson` is null when the stored document cannot be
   * serialized; such a token never matches anything.
   */
  | { kind: 'legacy'; updatedAt: number | null; docJson: string | null }

export const ABSENT: RevisionToken = { kind: 'absent' }

export interface LoadedBoard {
  doc: BoardDoc
  assets: Map<string, StoredAsset>
  token: RevisionToken
}

/** Supplies the original bytes of an asset this session has seen, if it still has them. */
export type AssetBytes = (assetId: string) => StoredAsset | undefined

/** Thrown by load() when something is stored but cannot be understood. */
export class UnreadableBoardError extends Error {
  constructor(message = 'The saved board could not be read.') {
    super(message)
    this.name = 'UnreadableBoardError'
  }
}

/** The database was written by a newer build; this one must neither read nor write it. */
export class NewerBoardError extends Error {
  constructor(message = 'This board was saved by a newer version of yuriful.') {
    super(message)
    this.name = 'NewerBoardError'
  }
}

/** The stored board is not the one this tab loaded or last saved. Nothing was written. */
export class BoardConflictError extends Error {
  constructor(message = 'This board was changed in another tab.') {
    super(message)
    this.name = 'BoardConflictError'
  }
}

/** The document references an image whose bytes are neither stored nor available. Nothing was written. */
export class MissingAssetError extends Error {
  constructor(message = 'An image on this board has no stored data, so the board was not saved.') {
    super(message)
    this.name = 'MissingAssetError'
  }
}

/** Storage did not become available in time (another tab is holding it). Nothing was written; retry later. */
export class StorageBusyError extends Error {
  constructor(message = 'Storage is held by another yuriful tab. Close other yuriful tabs, then Retry.') {
    super(message)
    this.name = 'StorageBusyError'
  }
}

export interface BoardStore {
  /** Resolves null when nothing has been saved yet (the token is then `ABSENT`). */
  load(): Promise<LoadedBoard | null>
  /**
   * Atomically writes the document, provided the stored board still matches `expected`,
   * together with the bytes of any referenced asset that is not stored. Resolves with
   * the token of the new revision only once the write is durable.
   */
  save(doc: BoardDoc, expected: RevisionToken, bytes: AssetBytes): Promise<RevisionToken>
  /** Best-effort cleanup of asset bytes the document no longer references. Does nothing when `expected` is stale. */
  pruneAssets(keep: ReadonlySet<string>, expected: RevisionToken): Promise<void>
}

const DB_NAME = 'yuriful'
/** Version of a database that holds (or has held) a board with frames. Milestone 1 cannot open it. */
const FENCED_DB_VERSION = 2
const BOARDS = 'boards'
const ASSETS = 'assets'
/** There is a single board; the key leaves room for a board list later. */
const CURRENT_BOARD = 'current'
const DEFAULT_DEADLINE_MS = 5000
const SUPERSEDED = 'A newer save replaced this one before it could be written.'

/** As written. On read every field is untrusted. */
interface BoardRow {
  id: string
  doc: StoredDoc
  rev: string
  updatedAt: number
}

const describe = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

/** instanceof breaks across realms (iframes, test environments); the tag does not. */
const isArrayBuffer = (v: unknown): v is ArrayBuffer => Object.prototype.toString.call(v) === '[object ArrayBuffer]'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

/**
 * Resolves on commit. A failing request first raises `error` (when the transaction has
 * no error of its own yet) and then aborts the transaction, so the rejection waits for
 * `abort` and reports the most specific cause it saw.
 */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let cause: unknown = null
    tx.oncomplete = () => resolve()
    tx.onerror = (event) => {
      cause ??= (event.target as IDBRequest | null)?.error ?? null
    }
    tx.onabort = () => reject(tx.error ?? cause ?? new Error('IndexedDB transaction aborted'))
  })
}

function abortQuietly(tx: IDBTransaction) {
  try {
    tx.abort()
  } catch {
    /* already finished */
  }
}

function tokenOf(row: unknown): RevisionToken {
  if (!isRecord(row)) return ABSENT
  if (typeof row.rev === 'string') return { kind: 'rev', rev: row.rev }
  let docJson: string | null
  try {
    docJson = JSON.stringify(row.doc) ?? null
  } catch {
    docJson = null
  }
  const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : null
  return { kind: 'legacy', updatedAt, docJson }
}

/** Different kinds never match, so a legacy write over a revisioned row (or the reverse) is always a mismatch. */
export function tokensMatch(actual: RevisionToken, expected: RevisionToken): boolean {
  if (actual.kind === 'absent') return expected.kind === 'absent'
  if (actual.kind === 'rev') return expected.kind === 'rev' && actual.rev === expected.rev
  // Equal JSON means byte-identical documents, so a write over the row loses nothing even
  // when neither row has a usable timestamp (null on both sides).
  return expected.kind === 'legacy' && actual.docJson !== null && actual.docJson === expected.docJson && actual.updatedAt === expected.updatedAt
}

function ensureStores(db: IDBDatabase) {
  if (!db.objectStoreNames.contains(BOARDS)) db.createObjectStore(BOARDS, { keyPath: 'id' })
  if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' })
}

/**
 * The single write routine. Runs entirely inside `tx` (which must cover both stores)
 * and throws without having put the row when anything is wrong; the caller aborts.
 */
async function writeBoard(tx: IDBTransaction, doc: BoardDoc, wire: StoredDoc, expected: RevisionToken, bytes: AssetBytes): Promise<string> {
  const boards = tx.objectStore(BOARDS)
  const assets = tx.objectStore(ASSETS)
  const row: unknown = await request(boards.get(CURRENT_BOARD))
  if (!tokensMatch(tokenOf(row), expected)) throw new BoardConflictError()
  // A document is never written with a reference that has no stored bytes.
  const referenced = referencedAssetIds(doc.objects)
  if (referenced.size > 0) {
    const stored = new Set<IDBValidKey>(await request(assets.getAllKeys()))
    for (const id of referenced) {
      if (stored.has(id)) continue
      const asset = bytes(id)
      if (!asset) throw new MissingAssetError()
      assets.put(asset)
    }
  }
  const next: BoardRow = { id: CURRENT_BOARD, doc: wire, rev: newId(), updatedAt: Date.now() }
  boards.put(next)
  return next.rev
}

const isDomainError = (e: unknown) => e instanceof BoardConflictError || e instanceof MissingAssetError || e instanceof StorageBusyError

export interface IndexedDbBoardStoreOptions {
  /** How long the first save of a framed board may wait for other tabs to let go before failing with a retryable error. */
  deadlineMs?: number
  /**
   * How long any open may wait. An open only waits when it is queued behind a promotion
   * (this tab's or another's) that other tabs are blocking. Longer than `deadlineMs` by
   * default so that a merely slow start never turns a board read-only.
   */
  openDeadlineMs?: number
}

export class IndexedDbBoardStore implements BoardStore {
  private dbPromise: Promise<IDBDatabase> | null = null
  private readonly deadlineMs: number
  private readonly openDeadlineMs: number
  /** Identifies the newest promotion attempt; an older one that runs late must not write. */
  private fenceSeq = 0

  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    opts: IndexedDbBoardStoreOptions = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
    this.openDeadlineMs = opts.openDeadlineMs ?? this.deadlineMs * 3
  }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error('IndexedDB is not available in this browser.'))
    if (!this.dbPromise) {
      const opening = this.connect(this.factory)
      this.dbPromise = opening
      // A failed open must be retryable.
      opening.catch(() => {
        if (this.dbPromise === opening) this.dbPromise = null
      })
    }
    return this.dbPromise
  }

  /** Keeps `db` as this store's connection, giving it up as soon as another tab needs to change the version. */
  private adopt(db: IDBDatabase): Promise<IDBDatabase> {
    const mine = Promise.resolve(db)
    const release = () => {
      db.close()
      if (this.dbPromise === mine) this.dbPromise = null
    }
    db.onversionchange = release
    db.onclose = release
    this.dbPromise = mine
    return mine
  }

  /**
   * Opens without naming a version: connects to whatever exists (version 1 or 2), or
   * creates version 1 with the two stores. Never changes an existing database.
   */
  private connect(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest
      try {
        req = factory.open(DB_NAME)
      } catch (e) {
        reject(new Error(describe(e, 'Could not open local storage.')))
        return
      }
      let abandoned = false
      // An open normally answers at once. It only waits when it is queued behind a promotion
      // request that other tabs are blocking; then it gives up with a retryable error.
      const timer = setTimeout(() => {
        abandoned = true
        reject(new StorageBusyError())
      }, this.openDeadlineMs)
      req.onupgradeneeded = () => ensureStores(req.result) // only when the database did not exist
      req.onsuccess = () => {
        clearTimeout(timer)
        const db = req.result
        if (abandoned) {
          db.close()
          return
        }
        if (db.version > FENCED_DB_VERSION) {
          db.close()
          reject(new NewerBoardError())
          return
        }
        void this.adopt(db)
        resolve(db)
      }
      req.onerror = () => {
        clearTimeout(timer)
        if (!abandoned) reject(new Error(describe(req.error, 'Could not open local storage.')))
      }
    })
  }

  async load(): Promise<LoadedBoard | null> {
    const db = await this.open()
    const tx = db.transaction([BOARDS, ASSETS], 'readonly')
    const row: unknown = await request(tx.objectStore(BOARDS).get(CURRENT_BOARD))
    if (row === undefined) return null
    const doc = parseDoc(isRecord(row) ? row.doc : undefined)
    if (!doc) throw new UnreadableBoardError()
    const all = (await request(tx.objectStore(ASSETS).getAll())) as StoredAsset[]
    const assets = new Map<string, StoredAsset>()
    for (const a of all) {
      if (a && typeof a.id === 'string' && isArrayBuffer(a.bytes)) assets.set(a.id, a)
    }
    return { doc, assets, token: tokenOf(row) }
  }

  async save(doc: BoardDoc, expected: RevisionToken, bytes: AssetBytes): Promise<RevisionToken> {
    const wire = serializeDoc(doc)
    let db = await this.open()
    if (wire.version === 2 && db.version < FENCED_DB_VERSION) {
      // The first save of a board with a frame: promote the database and write the
      // board in one atomic step, so milestone 1 can never open (and flatten) it.
      const fenced = await this.fence(doc, wire, expected, bytes)
      if ('token' in fenced) return fenced.token
      db = fenced.db // another tab promoted first: an ordinary write on that connection
    }
    const rev = await this.transact(db, (tx) => writeBoard(tx, doc, wire, expected, bytes))
    return { kind: 'rev', rev }
  }

  async pruneAssets(keep: ReadonlySet<string>, expected: RevisionToken): Promise<void> {
    const db = await this.open()
    await this.transact(db, async (tx) => {
      const row: unknown = await request(tx.objectStore(BOARDS).get(CURRENT_BOARD))
      // Stale view (the board changed since `keep` was computed): deleting could remove bytes it now needs.
      if (!tokensMatch(tokenOf(row), expected)) return
      const store = tx.objectStore(ASSETS)
      const keys = (await request(store.getAllKeys())) as IDBValidKey[]
      for (const k of keys) if (typeof k === 'string' && !keep.has(k)) store.delete(k)
    })
  }

  /** Runs `work` in one read-write transaction over both stores; any failure aborts all of it. */
  private async transact<T>(db: IDBDatabase, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    let tx: IDBTransaction
    try {
      tx = db.transaction([BOARDS, ASSETS], 'readwrite')
    } catch (e) {
      throw new Error(describe(e, 'Could not write to local storage.'), { cause: e })
    }
    const done = transactionDone(tx)
    done.catch(() => {}) // surfaced via the awaits below; avoid an unhandled duplicate
    let result: T
    try {
      result = await work(tx)
    } catch (e) {
      abortQuietly(tx)
      await done.catch(() => {})
      if (isDomainError(e)) throw e
      throw new Error(describe(e, 'Could not write to local storage.'), { cause: e })
    }
    try {
      await done
    } catch (e) {
      throw new Error(describe(e, 'Could not write to local storage (it may be full).'), { cause: e })
    }
    return result
  }

  /**
   * Promotes the database to the fenced version and writes the board inside the very
   * same `versionchange` transaction. Either both happen or neither does: a conflict,
   * missing bytes, a failed write or an expired attempt aborts the upgrade, which leaves
   * the row and the database version exactly as they were.
   */
  private fence(doc: BoardDoc, wire: StoredDoc, expected: RevisionToken, bytes: AssetBytes): Promise<{ token: RevisionToken } | { db: IDBDatabase }> {
    const factory = this.factory
    if (!factory) return Promise.reject(new Error('IndexedDB is not available in this browser.'))
    const attempt = ++this.fenceSeq
    return this.releaseConnection().then(
      () =>
        new Promise((resolve, reject) => {
          let req: IDBOpenDBRequest
          try {
            req = factory.open(DB_NAME, FENCED_DB_VERSION)
          } catch (e) {
            reject(new Error(describe(e, 'Could not open local storage.')))
            return
          }
          let expired = false
          let rev: string | null = null
          let failure: unknown = null
          // `blocked` is not an error: the request waits for other tabs. We only wait so long.
          const timer = setTimeout(() => {
            expired = true
            reject(new StorageBusyError())
          }, this.deadlineMs)

          req.onupgradeneeded = () => {
            const tx = req.transaction
            // Throwing here aborts the upgrade, which is the only safe outcome without a transaction to write in.
            if (!tx) throw new Error('IndexedDB gave no upgrade transaction.')
            // An attempt that was given up on, or replaced by a newer one, must never write,
            // however late it finally gets to run.
            if (expired) {
              abortQuietly(tx)
              return
            }
            if (attempt !== this.fenceSeq) {
              failure = new StorageBusyError(SUPERSEDED)
              abortQuietly(tx)
              return
            }
            clearTimeout(timer) // from here on the outcome is decided by the transaction alone
            ensureStores(req.result)
            tx.addEventListener('error', (event) => {
              failure ??= (event.target as IDBRequest | null)?.error ?? null // the request that failed says why
            })
            tx.addEventListener('abort', () => {
              failure ??= tx.error // e.g. out of space at commit, with no failing request
            })
            writeBoard(tx, doc, wire, expected, bytes).then(
              (written) => {
                rev = written
              },
              (e: unknown) => {
                failure = e
                abortQuietly(tx)
              },
            )
          }
          req.onsuccess = () => {
            clearTimeout(timer)
            const db = req.result
            if (expired) {
              db.close() // nobody is waiting for this connection any more
              return
            }
            void this.adopt(db)
            if (rev !== null) resolve({ token: { kind: 'rev', rev } })
            else if (attempt !== this.fenceSeq) reject(new StorageBusyError(SUPERSEDED)) // a newer save owns the board now
            else resolve({ db }) // no upgrade ran: the database was already promoted
          }
          req.onerror = (event) => {
            event.preventDefault()
            clearTimeout(timer)
            if (expired) return
            if (isDomainError(failure)) reject(failure)
            else reject(new Error(describe(failure ?? req.error, 'Could not write to local storage (it may be full).'), { cause: failure ?? req.error }))
          }
        }),
    )
  }

  /** Closes this store's own connection so that it cannot block its own version change. */
  private async releaseConnection(): Promise<void> {
    const current = this.dbPromise
    this.dbPromise = null
    if (!current) return
    try {
      ;(await current).close()
    } catch {
      /* it never opened */
    }
  }
}
