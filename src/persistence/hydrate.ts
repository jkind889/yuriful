import type { BoardDoc, ObjectRecord, StoredAsset } from '../model/types.ts'
import { NewerBoardError, StorageBusyError, UnreadableBoardError } from './boardStore.ts'
import type { BoardStore, RevisionToken } from './boardStore.ts'

export type HydrationOutcome =
  /** Nothing stored yet: a genuinely new board. */
  | { kind: 'empty' }
  /**
   * Everything stored was restored; saving may be enabled. `token` identifies the
   * stored revision that was read, and every later write must still match it.
   */
  | { kind: 'restored'; doc: BoardDoc; token: RevisionToken }
  /**
   * The stored board could not be fully restored. The session must be read-only
   * (no edits, no saving, no pruning) so the original document and image bytes are
   * never replaced. `partial` (if any) is only what could be shown; it must never
   * be persisted.
   */
  | { kind: 'blocked'; message: string; partial: BoardDoc | null }

const reason = (e: unknown) => (e instanceof Error && e.message ? e.message : 'unknown error')

function describeLoadFailure(e: unknown): string {
  if (e instanceof UnreadableBoardError) return 'The saved board could not be read. It is shown read-only so it cannot be overwritten.'
  if (e instanceof NewerBoardError) return 'This board was saved by a newer yuriful. It is read-only here so that nothing in it is lost.'
  if (e instanceof StorageBusyError) {
    return 'Storage is held by another yuriful tab, so the board could not be loaded. Close other yuriful tabs, then reload this one.'
  }
  return `Local storage is unavailable (${reason(e)}). The board is read-only because changes could not be saved.`
}

/**
 * Loads the stored board and proves every image in it can be decoded. Fails
 * closed: any unreadable document, storage error, missing asset or undecodable
 * asset yields `blocked`, never a silently reduced board. Loading writes nothing.
 */
export async function hydrateBoard(store: BoardStore, decode: (asset: StoredAsset) => Promise<unknown>): Promise<HydrationOutcome> {
  let loaded
  try {
    loaded = await store.load()
  } catch (e) {
    return { kind: 'blocked', partial: null, message: describeLoadFailure(e) }
  }
  if (!loaded) return { kind: 'empty' }

  const usable: ObjectRecord[] = []
  let failed = 0
  for (const rec of loaded.doc.objects) {
    if (rec.type === 'text') {
      usable.push(rec)
      continue
    }
    const asset = loaded.assets.get(rec.assetId)
    if (!asset) {
      failed++
      continue
    }
    try {
      await decode(asset)
      usable.push(rec)
    } catch {
      failed++
    }
  }

  if (failed > 0) {
    return {
      kind: 'blocked',
      partial: { ...loaded.doc, objects: usable },
      message: `${failed} saved image${failed === 1 ? '' : 's'} could not be loaded. The board is read-only so the original and its images stay exactly as stored.`,
    }
  }
  return { kind: 'restored', doc: loaded.doc, token: loaded.token }
}
