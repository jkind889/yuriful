// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, StoredAsset } from '../model/types.ts'
import { UnreadableBoardError } from './boardStore.ts'
import { NewerBoardError, StorageBusyError } from './boardStore.ts'
import type { BoardStore, LoadedBoard, RevisionToken } from './boardStore.ts'
import { hydrateBoard } from './hydrate.ts'

const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new ArrayBuffer(3) })
const doc = (): BoardDoc => ({
  ...createEmptyDoc(),
  objects: [
    { type: 'image', id: 'i1', left: 0, top: 0, angle: 0, assetId: 'a1', scaleX: 1, scaleY: 1 },
    { type: 'text', id: 't1', left: 0, top: 0, angle: 0, text: 'x', fontSize: 20, width: 100 },
    { type: 'image', id: 'i2', left: 0, top: 0, angle: 0, assetId: 'a2', scaleX: 1, scaleY: 1 },
  ],
})
const TOKEN: RevisionToken = { kind: 'legacy', updatedAt: 42, docJson: '{"version":1}' }
const board = (ids = ['a1', 'a2']): LoadedBoard => ({ doc: doc(), assets: new Map(ids.map((i) => [i, asset(i)] as const)), token: TOKEN })
const framedBoard = (ids = ['a1', 'a2']): LoadedBoard => ({
  ...board(ids),
  doc: {
    ...doc(),
    frames: [{ id: 'f1', name: 'Cover', left: 0, top: 0, width: 300, height: 200 }],
    objects: doc().objects.map((o) => ({ ...o, frameId: 'f1' })),
  },
})

function store(load: () => Promise<LoadedBoard | null>) {
  const writes: string[] = []
  const s: BoardStore = {
    load,
    save: async () => {
      writes.push('save')
      return TOKEN
    },
    pruneAssets: async () => void writes.push('prune'),
  }
  return { s, writes }
}
const decodeAll = async () => {}

describe('hydrateBoard', () => {
  it('stays pending until the store answers, and writes nothing meanwhile', async () => {
    let release!: (b: LoadedBoard | null) => void
    const { s, writes } = store(() => new Promise((r) => (release = r)))
    let settled = false
    const p = hydrateBoard(s, decodeAll).then((o) => ((settled = true), o))
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    release(board())
    expect((await p).kind).toBe('restored')
    expect(writes).toEqual([])
  })

  it('reports an empty store as a new board', async () => {
    expect(await hydrateBoard(store(async () => null).s, decodeAll)).toEqual({ kind: 'empty' })
  })

  it('restores when every image decodes', async () => {
    const out = await hydrateBoard(store(async () => board()).s, decodeAll)
    expect(out).toMatchObject({ kind: 'restored' })
    expect(out.kind === 'restored' && out.doc.objects).toHaveLength(3)
  })

  it('passes the stored revision token and the frames through a successful restore', async () => {
    const out = await hydrateBoard(store(async () => framedBoard()).s, decodeAll)
    expect(out.kind).toBe('restored')
    if (out.kind !== 'restored') return
    expect(out.token).toBe(TOKEN)
    expect(out.doc.frames.map((f) => f.id)).toEqual(['f1'])
    expect(out.doc.objects.map((o) => o.frameId)).toEqual(['f1', 'f1', 'f1'])
  })

  it('keeps frames and ownership in the partial board shown when an image fails', async () => {
    const out = await hydrateBoard(store(async () => framedBoard(['a1'])).s, decodeAll)
    expect(out.kind).toBe('blocked')
    if (out.kind !== 'blocked') return
    expect(out.partial?.frames.map((f) => f.id)).toEqual(['f1'])
    expect(out.partial?.objects.map((o) => [o.id, o.frameId])).toEqual([
      ['i1', 'f1'],
      ['t1', 'f1'],
    ])
    expect(out).not.toHaveProperty('token') // a blocked board is never written, so it carries no token
  })

  it('blocks on a database from a newer build, with nothing to show', async () => {
    const out = await hydrateBoard(
      store(async () => {
        throw new NewerBoardError()
      }).s,
      decodeAll,
    )
    expect(out).toMatchObject({ kind: 'blocked', partial: null })
    expect(out.kind === 'blocked' && out.message).toMatch(/newer yuriful.*read-only/)
  })

  it('blocks when storage is held by another tab, telling the user to reload rather than retry', async () => {
    const out = await hydrateBoard(
      store(async () => {
        throw new StorageBusyError()
      }).s,
      decodeAll,
    )
    expect(out).toMatchObject({ kind: 'blocked', partial: null })
    expect(out.kind === 'blocked' && out.message).toMatch(/another yuriful tab.*reload/)
    expect(out.kind === 'blocked' && out.message).not.toMatch(/Retry/)
  })

  it('fails closed when one image fails to decode, exposing only the loaded part', async () => {
    const decode = async (a: StoredAsset) => {
      if (a.id === 'a2') throw new Error('corrupt')
    }
    const { s, writes } = store(async () => board())
    const out = await hydrateBoard(s, decode)
    expect(out.kind).toBe('blocked')
    if (out.kind !== 'blocked') return
    expect(out.message).toMatch(/1 saved image could not be loaded.*read-only/)
    expect(out.partial?.objects.map((o) => o.id)).toEqual(['i1', 't1'])
    expect(writes).toEqual([])
  })

  it('fails closed when an image asset is missing from storage', async () => {
    const out = await hydrateBoard(store(async () => board(['a1'])).s, decodeAll)
    expect(out.kind).toBe('blocked')
    expect(out.kind === 'blocked' && out.message).toMatch(/1 saved image could not be loaded/)
  })

  it('counts every failure, and keeps trying later images after one fails', async () => {
    const decoded: string[] = []
    const out = await hydrateBoard(store(async () => board()).s, async (a) => {
      decoded.push(a.id)
      throw new Error('nope')
    })
    expect(decoded).toEqual(['a1', 'a2'])
    expect(out.kind === 'blocked' && out.message).toMatch(/2 saved images could not be loaded/)
  })

  it('blocks on an unreadable stored document, with nothing to show', async () => {
    const out = await hydrateBoard(
      store(async () => {
        throw new UnreadableBoardError()
      }).s,
      decodeAll,
    )
    expect(out).toMatchObject({ kind: 'blocked', partial: null })
    expect(out.kind === 'blocked' && out.message).toMatch(/could not be read.*read-only/)
  })

  it('blocks when storage itself is unavailable', async () => {
    const out = await hydrateBoard(
      store(async () => {
        throw new Error('IndexedDB is not available in this browser.')
      }).s,
      decodeAll,
    )
    expect(out.kind === 'blocked' && out.message).toMatch(/unavailable.*not available.*read-only/)
  })
})
