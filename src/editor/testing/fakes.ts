import type { BoardDoc, StoredAsset } from '../../model/types.ts'
import type { AssetBytes, BoardStore, LoadedBoard, RevisionToken } from '../../persistence/boardStore.ts'
import type { AssetSource } from '../assets.ts'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** What a test stores: the token defaults to a revisioned row. */
export type StoredBoard = Omit<LoadedBoard, 'token'> & { token?: RevisionToken }

export interface SpySave {
  doc: BoardDoc
  /** The token the editor believed was stored when it saved. */
  expected: RevisionToken
  /** Ids of referenced assets the editor could supply bytes for at save time. */
  assets: string[]
}

/**
 * In-memory BoardStore whose load() and save() can be held open, recording every
 * write attempt. Each successful save returns a fresh revision token.
 */
export class SpyStore implements BoardStore {
  readonly gate = deferred<LoadedBoard | null>()
  /** Successful saves, in order. */
  readonly saves: SpySave[] = []
  /** Every save call, including held and failed ones. */
  readonly attempts: SpySave[] = []
  readonly prunes: Array<{ keep: string[]; expected: RevisionToken }> = []
  holdLoad = true
  /** While set, save() waits on it before finishing. */
  saveGate: Deferred<void> | null = null
  /** While set, save() rejects with it (after any gate). */
  saveError: Error | null = null
  private seq = 0
  private readonly stored: LoadedBoard | null

  constructor(stored: StoredBoard | null) {
    this.stored = stored ? { ...stored, token: stored.token ?? { kind: 'rev', rev: 'stored' } } : null
  }
  releaseLoad() {
    this.gate.resolve(this.stored)
  }
  failLoad(e: unknown) {
    this.gate.reject(e)
  }
  load() {
    return this.holdLoad ? this.gate.promise : Promise.resolve(this.stored)
  }
  async save(doc: BoardDoc, expected: RevisionToken, bytes: AssetBytes): Promise<RevisionToken> {
    const assets = doc.objects.flatMap((o) => (o.type === 'image' && bytes(o.assetId) ? [o.assetId] : []))
    const attempt: SpySave = { doc, expected, assets: [...new Set(assets)] }
    this.attempts.push(attempt)
    if (this.saveGate) await this.saveGate.promise
    if (this.saveError) throw this.saveError
    this.saves.push(attempt)
    return { kind: 'rev', rev: `spy-${++this.seq}` }
  }
  async pruneAssets(keep: ReadonlySet<string>, expected: RevisionToken) {
    this.prunes.push({ keep: [...keep], expected })
  }
}

/**
 * Asset source that "decodes" instantly as 200 x 100, except for ids (or file names) in
 * `broken`. A file named like `wide-400x100.png` decodes at that size, and a decode can be held
 * open by file name with `hold(name)` (released by resolving the returned deferred).
 */
export class FakeAssets implements AssetSource {
  readonly loaded: string[] = []
  private readonly cache = new Map<string, { el: HTMLImageElement; asset: StoredAsset }>()
  private readonly holds = new Map<string, Deferred<void>>()
  constructor(private readonly broken: ReadonlySet<string> = new Set()) {}
  hold(name: string): Deferred<void> {
    const d = deferred<void>()
    this.holds.set(name, d)
    return d
  }
  get(id: string) {
    return this.cache.get(id)?.el
  }
  bytes(id: string) {
    return this.cache.get(id)?.asset
  }
  async load(asset: StoredAsset) {
    const held = this.holds.get(asset.name)
    if (held) {
      this.holds.delete(asset.name)
      await held.promise
    }
    if (this.broken.has(asset.id) || this.broken.has(asset.name)) throw new Error(`${asset.name} could not be decoded as an image.`)
    this.loaded.push(asset.id)
    const m = /(\d+)x(\d+)\.\w+$/.exec(asset.name)
    const el = { naturalWidth: m ? Number(m[1]) : 200, naturalHeight: m ? Number(m[2]) : 100 } as HTMLImageElement
    this.cache.set(asset.id, { el, asset })
    return el
  }
  dispose() {
    this.cache.clear()
  }
}
