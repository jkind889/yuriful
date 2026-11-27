// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createEmptyDoc, serializeDoc } from '../model/doc.ts'
import type { BoardDoc, StoredAsset } from '../model/types.ts'
import {
  ABSENT,
  BoardConflictError,
  IndexedDbBoardStore,
  MissingAssetError,
  NewerBoardError,
  StorageBusyError,
  UnreadableBoardError,
  tokensMatch,
} from './boardStore.ts'
import type { AssetBytes, RevisionToken } from './boardStore.ts'
import { LegacyStoreV1 } from './testing/legacyStoreV1.ts'
import type { LegacyDocV1 } from './testing/legacyStoreV1.ts'

const bytes = (...n: number[]) => new Uint8Array(n).buffer
const asset = (id: string, ...b: number[]): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: bytes(...b) })
/** The session's retained bytes, as the editor's asset cache would supply them. */
const having =
  (...assets: StoredAsset[]): AssetBytes =>
  (id) =>
    assets.find((a) => a.id === id)
const none: AssetBytes = () => undefined

const docWith = (assetId: string, title = 'Saved'): BoardDoc => ({
  ...createEmptyDoc(),
  title,
  objects: [
    { type: 'image', id: 'o1', left: 1, top: 2, angle: 0, assetId, scaleX: 1, scaleY: 1 },
    { type: 'text', id: 'o2', left: 3, top: 4, angle: 0, text: 'note', fontSize: 20, width: 200 },
  ],
})
const textOnly = (title = 'Text only'): BoardDoc => ({ ...createEmptyDoc(), title, objects: [docWith('x').objects[1]!] })
const withFrame = (doc: BoardDoc): BoardDoc => ({
  ...doc,
  frames: [{ id: 'f1', name: 'Frame 1', left: 0, top: 0, width: 640, height: 480 }],
  objects: doc.objects.map((o) => ({ ...o, frameId: 'f1' })),
})
/** A milestone 1 document as that build would have held it. */
const legacyDoc = (title = 'Legacy'): LegacyDocV1 => serializeDoc(textOnly(title)) as LegacyDocV1

const newStore = (factory = new IDBFactory(), deadlineMs = 5000) => ({ factory, store: new IndexedDbBoardStore(factory, { deadlineMs }) })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

interface Raw {
  version: number
  row: { doc: Record<string, unknown>; rev?: string; updatedAt?: number } | undefined
  assets: Record<string, number[]>
}

/** Reads the database version, the stored row and every asset without going through the store under test. */
function readRaw(factory: IDBFactory): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const open = factory.open('yuriful')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['boards', 'assets'], 'readonly')
      const row = tx.objectStore('boards').get('current')
      const all = tx.objectStore('assets').getAll()
      tx.oncomplete = () => {
        const assets: Raw['assets'] = {}
        for (const a of all.result as StoredAsset[]) assets[a.id] = [...new Uint8Array(a.bytes)]
        const version = db.version
        db.close()
        resolve({ version, row: row.result, assets })
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/** Writes a row straight into the boards store, creating a database of `version` if there is none. */
function putRaw(factory: IDBFactory, row: Record<string, unknown>, version?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = version === undefined ? factory.open('yuriful') : factory.open('yuriful', version)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('boards')) open.result.createObjectStore('boards', { keyPath: 'id' })
      if (!open.result.objectStoreNames.contains('assets')) open.result.createObjectStore('assets', { keyPath: 'id' })
    }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('boards', 'readwrite')
      tx.objectStore('boards').put({ id: 'current', ...row })
      tx.oncomplete = () => {
        open.result.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/** A connection that never lets go, like a tab that ignores `versionchange`. */
function stubbornConnection(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open('yuriful')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      open.result.onversionchange = () => {}
      resolve(open.result)
    }
  })
}

describe('IndexedDbBoardStore: basics', () => {
  it('returns null when nothing has been saved', async () => {
    expect(await newStore().store.load()).toBeNull()
  })

  it('round-trips the document and the exact image bytes', async () => {
    const { store } = newStore()
    await store.save(docWith('a1'), ABSENT, having(asset('a1', 1, 2, 3, 250)))
    const loaded = await store.load()
    expect(loaded?.doc).toEqual(docWith('a1'))
    const stored = loaded?.assets.get('a1')
    expect(stored && [...new Uint8Array(stored.bytes)]).toEqual([1, 2, 3, 250])
    expect(stored?.type).toBe('image/png')
  })

  it('stores a frameless board as a raw milestone 1 row in a version 1 database', async () => {
    const { factory, store } = newStore()
    await store.save(docWith('a1'), ABSENT, having(asset('a1', 1)))
    const { version, row } = await readRaw(factory)
    expect(version).toBe(1)
    expect(Object.keys(row!.doc)).toEqual(['version', 'title', 'objects', 'viewport'])
    expect(row!.doc.version).toBe(1)
    expect(JSON.stringify(row!.doc)).not.toContain('frame')
    expect(typeof row!.rev).toBe('string')
  })

  it('keeps previously stored assets when later saves supply none', async () => {
    const { store } = newStore()
    const t1 = await store.save(docWith('a1'), ABSENT, having(asset('a1', 9)))
    await store.save(docWith('a1', 'Renamed'), t1, none) // already stored: no bytes needed
    const loaded = await store.load()
    expect(loaded?.doc.title).toBe('Renamed')
    expect(loaded?.assets.has('a1')).toBe(true)
  })

  it('never rewrites bytes that are already stored', async () => {
    const { factory, store } = newStore()
    const t1 = await store.save(docWith('a1'), ABSENT, having(asset('a1', 1, 2)))
    await store.save(docWith('a1', 'Again'), t1, having(asset('a1', 99))) // a different payload under the same id
    expect((await readRaw(factory)).assets).toEqual({ a1: [1, 2] })
  })

  it('overwrites the single current board', async () => {
    const { store } = newStore()
    const t1 = await store.save(docWith('a1'), ABSENT, having(asset('a1', 1)))
    await store.save({ ...createEmptyDoc(), title: 'Second' }, t1, none)
    expect((await store.load())?.doc.objects).toHaveLength(0)
  })

  it('throws UnreadableBoardError for stored data it cannot parse, without touching it', async () => {
    const { factory, store } = newStore()
    await putRaw(factory, { doc: { version: 99, junk: true }, updatedAt: 0 }, 1)
    await expect(store.load()).rejects.toBeInstanceOf(UnreadableBoardError)
    await expect(store.load()).rejects.toBeInstanceOf(UnreadableBoardError) // still there, still unreadable
    expect((await readRaw(factory)).row).toEqual({ id: 'current', doc: { version: 99, junk: true }, updatedAt: 0 })
  })

  it('writes nothing when a save fails midway (atomic document + assets)', async () => {
    const { factory, store } = newStore()
    const t1 = await store.save(docWith('a1'), ABSENT, having(asset('a1', 1)))
    const before = await readRaw(factory)
    // The document needs two new assets; the second is not cloneable, so its put throws.
    const doc: BoardDoc = {
      ...docWith('a2', 'Should not persist'),
      objects: [...docWith('a2').objects, { type: 'image', id: 'o3', left: 0, top: 0, angle: 0, assetId: 'bad', scaleX: 1, scaleY: 1 }],
    }
    const bad = { id: 'bad', name: 'bad', type: 'image/png', bytes: () => 1 } as unknown as StoredAsset
    await expect(store.save(doc, t1, having(asset('a2', 2), bad))).rejects.toThrow()
    expect(await readRaw(factory)).toEqual(before) // not even a2, which was put first
    expect((await store.load())?.doc.title).toBe('Saved')
    await store.save(docWith('a1', 'Still works'), t1, none) // and the token is still good
  })

  it('rejects with a readable error when IndexedDB is unavailable', async () => {
    const store = new IndexedDbBoardStore(undefined)
    await expect(store.load()).rejects.toThrow(/not available/)
    await expect(store.save(createEmptyDoc(), ABSENT, none)).rejects.toThrow(/not available/)
    await expect(store.save(withFrame(createEmptyDoc()), ABSENT, none)).rejects.toThrow(/not available/)
  })

  it('prunes assets the document no longer references', async () => {
    const { factory, store } = newStore()
    const token = await store.save(docWith('a1'), ABSENT, having(asset('a1', 1)))
    await putRawAsset(factory, asset('orphan', 2))
    await store.pruneAssets(new Set(['a1']), token)
    const loaded = await store.load()
    expect([...(loaded?.assets.keys() ?? [])]).toEqual(['a1'])
  })
})

function putRawAsset(factory: IDBFactory, a: StoredAsset): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = factory.open('yuriful')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('assets', 'readwrite')
      tx.objectStore('assets').put(a)
      tx.oncomplete = () => {
        open.result.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

describe('opening a milestone 1 board', () => {
  it('loads a row written by the milestone 1 store and does not rewrite it', async () => {
    const factory = new IDBFactory()
    const legacy = new LegacyStoreV1(factory)
    const original = serializeDoc(docWith('a1', 'From milestone 1')) as LegacyDocV1
    await legacy.save(original, [asset('a1', 7, 8, 9)])
    const before = await readRaw(factory)
    expect(before.version).toBe(1)
    expect(before.row).not.toHaveProperty('rev')

    const { store } = newStore(factory)
    const loaded = await store.load()
    expect(loaded?.doc).toEqual(docWith('a1', 'From milestone 1'))
    expect(loaded?.doc.frames).toEqual([])
    expect(loaded?.token).toEqual({ kind: 'legacy', updatedAt: before.row!.updatedAt, docJson: JSON.stringify(original) })
    expect(await readRaw(factory)).toEqual(before) // loading writes nothing, not even a revision id
  })

  it('a frameless edit stays wire version 1 in a version 1 database and gains a revision id', async () => {
    const factory = new IDBFactory()
    const legacy = new LegacyStoreV1(factory)
    await legacy.save(legacyDoc(), [])
    const { store } = newStore(factory)
    const loaded = await store.load()
    const token = await store.save({ ...loaded!.doc, title: 'Edited' }, loaded!.token, none)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(1)
    expect(raw.row!.doc.version).toBe(1)
    expect(raw.row!.doc.title).toBe('Edited')
    expect(token).toEqual({ kind: 'rev', rev: raw.row!.rev })
    // The milestone 1 build can still read and write this database.
    expect((await legacy.loadRaw())?.doc).toEqual(raw.row!.doc)
    await legacy.save(legacyDoc('Old build again'), [])
  })
})

describe('the fence: first save of a board with a frame', () => {
  it('promotes the database and writes the framed board in one step; milestone 1 is then locked out', async () => {
    const factory = new IDBFactory()
    const legacy = new LegacyStoreV1(factory)
    await legacy.save(legacyDoc(), []) // an old tab that stays open
    const { store } = newStore(factory)
    const loaded = await store.load()

    const framed = withFrame(loaded!.doc)
    const token = await store.save(framed, loaded!.token, none)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(2)
    expect(raw.row!.doc).toEqual(JSON.parse(JSON.stringify(serializeDoc(framed))))
    expect(raw.row!.doc.version).toBe(2)
    expect(token).toEqual({ kind: 'rev', rev: raw.row!.rev })

    await expect(legacy.save(legacyDoc('Stale overwrite'), [])).rejects.toThrow()
    await expect(new LegacyStoreV1(factory).loadRaw()).rejects.toThrow()
    expect(await readRaw(factory)).toEqual(raw) // the framed row survived the old build's attempts

    // Ordinary saves continue on the promoted database, and the board reloads with its frame.
    await store.save({ ...framed, title: 'After the fence' }, token, none)
    const again = await newStore(factory).store.load()
    expect(again?.doc.frames).toHaveLength(1)
    expect(again?.doc.objects[0]?.frameId).toBe('f1')
    expect(again?.doc.title).toBe('After the fence')
  })

  it('works for a brand-new board whose very first save has a frame', async () => {
    const { factory, store } = newStore()
    await store.save(withFrame(textOnly()), ABSENT, none)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(2)
    expect(raw.row!.doc.version).toBe(2)
  })

  it('conflict (a milestone 1 save landed first): nothing changes and the old build still works', async () => {
    const factory = new IDBFactory()
    const legacy = new LegacyStoreV1(factory)
    await legacy.save(legacyDoc('First'), [])
    const { store } = newStore(factory)
    const loaded = await store.load()
    await legacy.save(legacyDoc('Landed first'), [])
    const before = await readRaw(factory)

    await expect(store.save(withFrame(loaded!.doc), loaded!.token, none)).rejects.toBeInstanceOf(BoardConflictError)
    expect(await readRaw(factory)).toEqual(before)
    expect(before.version).toBe(1)
    await legacy.save(legacyDoc('Old build still fine'), []) // it reopens at version 1
    expect((await readRaw(factory)).row!.doc.title).toBe('Old build still fine')
  })

  it('missing bytes: the upgrade is aborted, the row and version are unchanged', async () => {
    const { factory, store } = newStore()
    const t1 = await store.save(textOnly(), ABSENT, none)
    const before = await readRaw(factory)
    await expect(store.save(withFrame(docWith('ghost')), t1, none)).rejects.toBeInstanceOf(MissingAssetError)
    expect(await readRaw(factory)).toEqual(before)
    expect(before.version).toBe(1)
    await store.save(textOnly('Still saving'), t1, none)
  })

  it('failed asset write: the upgrade is aborted, the row and version are unchanged', async () => {
    const { factory, store } = newStore()
    const t1 = await store.save(textOnly(), ABSENT, none)
    const before = await readRaw(factory)
    const bad = { id: 'a9', name: 'bad', type: 'image/png', bytes: () => 1 } as unknown as StoredAsset
    await expect(store.save(withFrame(docWith('a9')), t1, having(bad))).rejects.toThrow()
    expect(await readRaw(factory)).toEqual(before)
    expect(before.version).toBe(1)
    await store.save(withFrame(docWith('a9')), t1, having(asset('a9', 4))) // good bytes: now it goes through
    expect((await readRaw(factory)).version).toBe(2)
  })

  it('timeout then unblock: rejected at the deadline, and the abandoned request writes nothing when it finally runs', async () => {
    const factory = new IDBFactory()
    const { store } = newStore(factory, 40)
    const t1 = await store.save(textOnly(), ABSENT, none)
    const before = await readRaw(factory)
    const blocker = await stubbornConnection(factory) // another tab that will not close

    const started = Date.now()
    await expect(store.save(withFrame(textOnly()), t1, none)).rejects.toBeInstanceOf(StorageBusyError)
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    // A retry while still blocked queues behind the abandoned request and gives up the same way.
    await expect(store.save(withFrame(textOnly()), t1, none)).rejects.toBeInstanceOf(StorageBusyError)
    await expect(store.load()).rejects.toBeInstanceOf(StorageBusyError)

    blocker.close() // the other tab goes away: the abandoned upgrade now runs, and must abort itself
    await tick(20)
    expect(await readRaw(factory)).toEqual(before)
    expect(before.version).toBe(1)

    const t2 = await store.save(textOnly('Frameless after the timeout'), t1, none)
    const mid = await readRaw(factory)
    expect(mid.version).toBe(1)
    expect(mid.row!.doc.title).toBe('Frameless after the timeout')

    await store.save(withFrame(textOnly('Framed at last')), t2, none) // a fresh request succeeds
    const after = await readRaw(factory)
    expect(after.version).toBe(2)
    expect(after.row!.doc.title).toBe('Framed at last')
  })

  it('a promotion that commits is never reported as timed out, however slow its write was', async () => {
    const { factory, store } = newStore(new IDBFactory(), 30)
    const t1 = await store.save(textOnly(), ABSENT, none)
    const a5 = asset('a5', 5)
    const slow: AssetBytes = (id) => {
      const until = Date.now() + 90 // well past the deadline, inside the upgrade transaction
      while (Date.now() < until) {
        /* busy */
      }
      return id === 'a5' ? a5 : undefined
    }
    const token = await store.save(withFrame(docWith('a5')), t1, slow)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(2)
    expect(token).toEqual({ kind: 'rev', rev: raw.row!.rev })
    await store.save(withFrame(docWith('a5', 'Token is usable')), token, none)
  })

  it('an open from another tab queued behind a blocked promotion gives up with a retryable error and writes nothing', async () => {
    const factory = new IDBFactory()
    const a = newStore(factory).store // waits up to 5 s for its promotion
    const t1 = await a.save(textOnly(), ABSENT, none)
    const before = await readRaw(factory)
    const blocker = await stubbornConnection(factory)
    const promoting = a.save(withFrame(textOnly('A framed')), t1, none)
    await tick(5)

    const b = newStore(factory, 20).store // a second tab: its open queues behind A's request
    await expect(b.load()).rejects.toBeInstanceOf(StorageBusyError)
    await expect(b.save(textOnly('B'), t1, none)).rejects.toBeInstanceOf(StorageBusyError)

    blocker.close()
    await promoting
    const after = await readRaw(factory)
    expect(after.version).toBe(2)
    expect(after.row!.doc.title).toBe('A framed')
    expect(before.row!.doc.title).toBe('Text only')
    expect((await b.load())?.doc.title).toBe('A framed') // and the second tab recovers by itself
  })

  it('an attempt that timed out and later finds the database already promoted keeps no connection', async () => {
    const factory = new IDBFactory()
    const first = newStore(factory).store
    const second = newStore(factory, 30).store
    const t1 = await first.save(textOnly(), ABSENT, none)
    await second.load()
    const blocker = await stubbornConnection(factory)
    // Both promotion requests are issued in the same tick, so the second really queues behind
    // the first as a promotion (not as a plain open) and then times out while blocked.
    const promoting = first.save(withFrame(textOnly('First')), t1, none)
    const abandoned = second.save(withFrame(textOnly('Second')), t1, none)
    await expect(abandoned).rejects.toBeInstanceOf(StorageBusyError)
    blocker.close()
    await promoting
    await tick(20) // the abandoned request now opens at version 2 without an upgrade
    expect((await readRaw(factory)).row!.doc.title).toBe('First')
    // A leaked connection without a versionchange handler would block this forever.
    const upgraded = await Promise.race([
      new Promise<string>((resolve) => {
        const open = factory.open('yuriful', 3)
        open.onsuccess = () => {
          open.result.close()
          resolve('opened')
        }
        open.onerror = () => resolve('error')
      }),
      tick(500).then(() => 'blocked'),
    ])
    expect(upgraded).toBe('opened')
  })

  it('two overlapping framed saves on one store: only the newer one is ever written', async () => {
    const { factory, store } = newStore()
    const t1 = await store.save(textOnly(), ABSENT, none)
    const [older, newer] = await Promise.allSettled([store.save(withFrame(textOnly('Older')), t1, none), store.save(withFrame(textOnly('Newer')), t1, none)])
    expect(newer.status).toBe('fulfilled')
    expect(older.status).toBe('rejected')
    expect((older as PromiseRejectedResult).reason).toBeInstanceOf(StorageBusyError)
    expect((older as PromiseRejectedResult).reason.message).toMatch(/newer save/)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(2)
    expect(raw.row!.doc.title).toBe('Newer')
    expect(raw.row!.rev).toBe(((newer as PromiseFulfilledResult<RevisionToken>).value as { rev: string }).rev)
  })

  it('an abandoned request stays harmless even if the user has since undone the frame and saved', async () => {
    const factory = new IDBFactory()
    const { store } = newStore(factory, 40)
    const t1 = await store.save(textOnly(), ABSENT, none)
    const blocker = await stubbornConnection(factory)
    await expect(store.save(withFrame(textOnly('Framed')), t1, none)).rejects.toBeInstanceOf(StorageBusyError)
    blocker.close()
    // Immediately save the frameless board again; the abandoned upgrade is still queued ahead of it.
    await store.save(textOnly('Frame undone'), t1, none)
    await tick(20)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(1)
    expect(raw.row!.doc).toMatchObject({ version: 1, title: 'Frame undone' })
  })

  it('another store promoted first: this store writes on the regular path and gets a conflict', async () => {
    const factory = new IDBFactory()
    const a = newStore(factory).store
    const b = newStore(factory).store
    const t1 = await a.save(textOnly(), ABSENT, none)
    await b.load()
    const ta = await a.save(withFrame(textOnly('A framed')), t1, none)
    const before = await readRaw(factory)
    expect(before.version).toBe(2)
    await expect(b.save(withFrame(textOnly('B framed')), t1, none)).rejects.toBeInstanceOf(BoardConflictError)
    expect(await readRaw(factory)).toEqual(before)
    await a.save(withFrame(textOnly('A again')), ta, none)
  })

  it('two stores promoting at once: exactly one wins, the other falls through to a conflict', async () => {
    const factory = new IDBFactory()
    const a = newStore(factory).store
    const b = newStore(factory).store
    const t1 = await a.save(textOnly(), ABSENT, none)
    await b.load()
    const results = await Promise.allSettled([a.save(withFrame(textOnly('A')), t1, none), b.save(withFrame(textOnly('B')), t1, none)])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(BoardConflictError)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(2)
    expect(raw.row!.doc.title).toBe(results[0]!.status === 'fulfilled' ? 'A' : 'B')
    expect(raw.row!.rev).toBe(((won[0] as PromiseFulfilledResult<RevisionToken>).value as { rev: string }).rev)
  })

  it('a frameless board in an already promoted database is written as wire version 1 without touching the version', async () => {
    const { factory, store } = newStore()
    const t1 = await store.save(withFrame(textOnly()), ABSENT, none)
    await store.save(textOnly('Frame deleted'), t1, none)
    const raw = await readRaw(factory)
    expect(raw.version).toBe(2)
    expect(raw.row!.doc).toMatchObject({ version: 1, title: 'Frame deleted' })
    expect(raw.row!.doc).not.toHaveProperty('frames')
  })

  it('refuses to read or write a database from a newer build', async () => {
    const factory = new IDBFactory()
    await putRaw(factory, { doc: serializeDoc(textOnly()), rev: 'future', updatedAt: 1 }, 3)
    const before = await readRaw(factory)
    const { store } = newStore(factory)
    await expect(store.load()).rejects.toBeInstanceOf(NewerBoardError)
    await expect(store.save(textOnly('nope'), { kind: 'rev', rev: 'future' }, none)).rejects.toBeInstanceOf(NewerBoardError)
    await expect(store.save(withFrame(textOnly('nope')), { kind: 'rev', rev: 'future' }, none)).rejects.toBeInstanceOf(NewerBoardError)
    await expect(store.pruneAssets(new Set(), { kind: 'rev', rev: 'future' })).rejects.toBeInstanceOf(NewerBoardError)
    expect(await readRaw(factory)).toEqual(before)
    expect(before.version).toBe(3)
  })
})

describe('revision tokens: a stale tab never overwrites', () => {
  it('absent, legacy and rev tokens never match across kinds', () => {
    const rev: RevisionToken = { kind: 'rev', rev: 'r1' }
    const legacy: RevisionToken = { kind: 'legacy', updatedAt: 5, docJson: '{}' }
    const all = [ABSENT, rev, legacy]
    for (const a of all) for (const b of all) expect(tokensMatch(a, b)).toBe(a === b)
    expect(tokensMatch({ kind: 'rev', rev: 'r1' }, { kind: 'rev', rev: 'r2' })).toBe(false)
    expect(tokensMatch({ kind: 'legacy', updatedAt: 5, docJson: '{}' }, { kind: 'legacy', updatedAt: 6, docJson: '{}' })).toBe(false)
    expect(tokensMatch({ kind: 'legacy', updatedAt: 5, docJson: '{}' }, { kind: 'legacy', updatedAt: 5, docJson: '{ }' })).toBe(false)
    // A legacy row whose document could not be identified never matches, not even itself.
    const unknown: RevisionToken = { kind: 'legacy', updatedAt: 5, docJson: null }
    expect(tokensMatch(unknown, unknown)).toBe(false)
    // Without a usable timestamp the exact document alone identifies the row.
    const untimed: RevisionToken = { kind: 'legacy', updatedAt: null, docJson: '{}' }
    expect(tokensMatch(untimed, { ...untimed })).toBe(true)
    expect(tokensMatch(untimed, { ...untimed, docJson: '{ }' })).toBe(false)
    expect(tokensMatch(untimed, { ...untimed, updatedAt: 5 })).toBe(false)
  })

  it('a legacy row with a NaN timestamp is treated as having none, so it can still be saved', async () => {
    const factory = new IDBFactory()
    await putRaw(factory, { doc: legacyDoc('NaN timestamp'), updatedAt: Number.NaN }, 1)
    const { store } = newStore(factory)
    const loaded = await store.load()
    expect(loaded?.token).toMatchObject({ kind: 'legacy', updatedAt: null })
    await store.save({ ...loaded!.doc, title: 'Saved' }, loaded!.token, none)
    expect((await readRaw(factory)).row!.doc.title).toBe('Saved')
  })

  it('a legacy row without a numeric timestamp still loads editable and can be saved', async () => {
    const factory = new IDBFactory()
    await putRaw(factory, { doc: legacyDoc('No timestamp'), updatedAt: 'yesterday' }, 1)
    const { store } = newStore(factory)
    const loaded = await store.load()
    expect(loaded?.token).toMatchObject({ kind: 'legacy', updatedAt: null })
    await store.save({ ...loaded!.doc, title: 'Saved anyway' }, loaded!.token, none)
    expect((await readRaw(factory)).row!.doc.title).toBe('Saved anyway')
  })

  it('a row appearing where none was expected is a conflict, and so is a missing row', async () => {
    const { factory, store } = newStore()
    const other = newStore(factory).store
    await other.save(textOnly('Someone else'), ABSENT, none)
    const before = await readRaw(factory)
    await expect(store.save(textOnly('Mine'), ABSENT, none)).rejects.toBeInstanceOf(BoardConflictError)
    expect(await readRaw(factory)).toEqual(before)

    const empty = newStore().store
    await expect(empty.save(textOnly(), { kind: 'rev', rev: 'gone' }, none)).rejects.toBeInstanceOf(BoardConflictError)
    expect(await empty.load()).toBeNull()
  })

  it('two distinct legacy documents with the same timestamp are a conflict', async () => {
    const factory = new IDBFactory()
    await putRaw(factory, { doc: legacyDoc('One'), updatedAt: 5 }, 1)
    const { store } = newStore(factory)
    const loaded = await store.load()
    await putRaw(factory, { doc: legacyDoc('Two'), updatedAt: 5 })
    const before = await readRaw(factory)
    await expect(store.save({ ...loaded!.doc, title: 'Mine' }, loaded!.token, none)).rejects.toBeInstanceOf(BoardConflictError)
    expect(await readRaw(factory)).toEqual(before)
  })

  it('a legacy row rewritten byte-identically still matches (nothing would be lost)', async () => {
    const factory = new IDBFactory()
    await putRaw(factory, { doc: legacyDoc('Same'), updatedAt: 5 }, 1)
    const { store } = newStore(factory)
    const loaded = await store.load()
    await putRaw(factory, { doc: legacyDoc('Same'), updatedAt: 5 })
    await store.save({ ...loaded!.doc, title: 'Mine' }, loaded!.token, none)
    expect((await readRaw(factory)).row!.doc.title).toBe('Mine')
  })

  it('new -> legacy -> new: a reader of the first revision conflicts', async () => {
    const factory = new IDBFactory()
    const writer = newStore(factory).store
    const reader = newStore(factory).store
    await writer.save(textOnly('Rev 1'), ABSENT, none)
    const stale = await reader.load()
    expect(stale?.token.kind).toBe('rev')

    await new LegacyStoreV1(factory).save(legacyDoc('Old build overwrote it'), []) // the row loses its revision id
    const afterLegacy = await newStore(factory).store.load()
    expect(afterLegacy?.token.kind).toBe('legacy')
    // The reader's rev token must not match a legacy row.
    await expect(reader.save({ ...stale!.doc, title: 'Stale 1' }, stale!.token, none)).rejects.toBeInstanceOf(BoardConflictError)

    const third = newStore(factory).store
    await third.save(textOnly('Rev 3'), afterLegacy!.token, none)
    const before = await readRaw(factory)
    await expect(reader.save({ ...stale!.doc, title: 'Stale 2' }, stale!.token, none)).rejects.toBeInstanceOf(BoardConflictError)
    await expect(reader.save({ ...stale!.doc, title: 'Stale 3' }, afterLegacy!.token, none)).rejects.toBeInstanceOf(BoardConflictError)
    expect(await readRaw(factory)).toEqual(before)
  })

  it('two stores from one revision: the second conflicts and nothing of the first is touched', async () => {
    const factory = new IDBFactory()
    const seed = newStore(factory).store
    await seed.save(docWith('a1'), ABSENT, having(asset('a1', 1)))
    const a = newStore(factory).store
    const b = newStore(factory).store
    const [la, lb] = [await a.load(), await b.load()]
    expect(la!.token).toEqual(lb!.token)

    await a.save(docWith('a2', 'A won'), la!.token, having(asset('a2', 2)))
    const before = await readRaw(factory)
    await expect(b.save(docWith('a3', 'B lost'), lb!.token, having(asset('a3', 3)))).rejects.toBeInstanceOf(BoardConflictError)
    expect(await readRaw(factory)).toEqual(before) // neither the row nor a3's bytes
    expect(Object.keys(before.assets).sort()).toEqual(['a1', 'a2'])
  })
})

describe('asset presence', () => {
  it('re-stores bytes another tab pruned when an undo brings the image back', async () => {
    const factory = new IDBFactory()
    const first = newStore(factory).store
    const original = asset('a1', 10, 20, 30, 40)
    const t1 = await first.save(docWith('a1'), ABSENT, having(original))
    const t2 = await first.save(textOnly('Image deleted'), t1, having(original)) // user deleted the image

    const second = newStore(factory).store
    const seen = await second.load() // another tab opens that revision ...
    await second.pruneAssets(new Set(), seen!.token) // ... and legitimately prunes the unreferenced bytes
    expect((await readRaw(factory)).assets).toEqual({})

    await first.save(docWith('a1', 'Deletion undone'), t2, having(original)) // first tab undoes
    expect((await readRaw(factory)).assets).toEqual({ a1: [10, 20, 30, 40] })
    const reloaded = await newStore(factory).store.load()
    expect(reloaded?.doc.title).toBe('Deletion undone')
    expect([...new Uint8Array(reloaded!.assets.get('a1')!.bytes)]).toEqual([10, 20, 30, 40])
  })

  it('a referenced asset with no bytes anywhere fails the save and writes nothing', async () => {
    const { factory, store } = newStore()
    const t1 = await store.save(textOnly(), ABSENT, none)
    const before = await readRaw(factory)
    await expect(store.save(docWith('ghost'), t1, none)).rejects.toBeInstanceOf(MissingAssetError)
    expect(await readRaw(factory)).toEqual(before)
    await store.save(textOnly('Token still valid'), t1, none)
  })

  it('a prune from a stale view deletes nothing (delayed hydration)', async () => {
    const factory = new IDBFactory()
    const slow = newStore(factory).store
    const quick = newStore(factory).store
    const t1 = await quick.save(docWith('a1'), ABSENT, having(asset('a1', 1)))
    const slowView = await slow.load() // hydrated from revision 1 ...
    await quick.save(docWith('a2', 'Moved on'), t1, having(asset('a2', 2))) // ... which is replaced before its prune runs
    const before = await readRaw(factory)

    await slow.pruneAssets(new Set(['a1']), slowView!.token) // would have deleted a2
    expect(await readRaw(factory)).toEqual(before)
    expect(Object.keys(before.assets).sort()).toEqual(['a1', 'a2'])
  })
})

describe('locked items', () => {
  const lockedFirst = (doc: BoardDoc): BoardDoc => ({ ...doc, objects: doc.objects.map((o, i) => (i === 0 ? { ...o, locked: true as const } : o)) })

  it('a frameless board with a locked object stays wire version 1 in a version 1 database, and round-trips the lock', async () => {
    const { factory, store } = newStore()
    await store.save(lockedFirst(docWith('a1')), ABSENT, having(asset('a1', 1)))
    const raw = await readRaw(factory)
    expect(raw.version).toBe(1)
    expect(raw.row!.doc.version).toBe(1)
    const objects = raw.row!.doc.objects as Array<Record<string, unknown>>
    expect(objects[0]!.locked).toBe(true)
    expect(Object.keys(objects[1]!)).not.toContain('locked')
    expect((await store.load())?.doc).toEqual(lockedFirst(docWith('a1')))
  })

  it('a framed board stores locks on a frame and on content without any further upgrade', async () => {
    const { factory, store } = newStore()
    const framedDoc = withFrame(docWith('a1'))
    const doc: BoardDoc = { ...lockedFirst(framedDoc), frames: framedDoc.frames.map((f) => ({ ...f, locked: true as const })) }
    await store.save(doc, ABSENT, having(asset('a1', 1)))
    const raw = await readRaw(factory)
    expect(raw.version).toBe(2)
    expect((raw.row!.doc.frames as Array<Record<string, unknown>>)[0]!.locked).toBe(true)
    expect((await store.load())?.doc).toEqual(doc)
  })
})

describe('cropped images', () => {
  const croppedFirst = (doc: BoardDoc): BoardDoc => ({
    ...doc,
    objects: doc.objects.map((o, i) => (i === 0 && o.type === 'image' ? { ...o, crop: { x: 1.5, y: 2, width: 30, height: 40.25 } } : o)),
  })

  it('a frameless cropped board stays wire version 1 in a version 1 database, and round-trips the crop', async () => {
    const { factory, store } = newStore()
    await store.save(croppedFirst(docWith('a1')), ABSENT, having(asset('a1', 1)))
    const raw = await readRaw(factory)
    expect(raw.version).toBe(1)
    expect(raw.row!.doc.version).toBe(1)
    const objects = raw.row!.doc.objects as Array<Record<string, unknown>>
    expect(objects[0]!.crop).toEqual({ x: 1.5, y: 2, width: 30, height: 40.25 })
    expect(Object.keys(objects[1]!)).not.toContain('crop')
    expect((await store.load())?.doc).toEqual(croppedFirst(docWith('a1')))
  })

  it('a framed cropped board needs no further upgrade', async () => {
    const { factory, store } = newStore()
    const doc = croppedFirst(withFrame(docWith('a1')))
    await store.save(doc, ABSENT, having(asset('a1', 1)))
    expect((await readRaw(factory)).version).toBe(2)
    expect((await store.load())?.doc).toEqual(doc)
  })
})
