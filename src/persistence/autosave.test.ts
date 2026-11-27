// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createEmptyDoc } from '../model/doc.ts'
import type { BoardDoc, SaveState, StoredAsset } from '../model/types.ts'
import { Autosaver, CONFLICT_MESSAGE, NEWER_BUILD_MESSAGE } from './autosave.ts'
import { ABSENT, BoardConflictError, MissingAssetError, NewerBoardError, StorageBusyError } from './boardStore.ts'
import type { AssetBytes, BoardStore, RevisionToken } from './boardStore.ts'

const asset = (id: string): StoredAsset => ({ id, name: `${id}.png`, type: 'image/png', bytes: new ArrayBuffer(4) })
const STORED: RevisionToken = { kind: 'rev', rev: 'stored' }

/** `hydrated: false` leaves the saver in its pre-hydration (inert) state. */
function setup({ hydrated = true } = {}) {
  const statuses: SaveState[] = []
  const saves: Array<{ doc: BoardDoc; expected: RevisionToken; bytes: AssetBytes }> = []
  const conflicts: string[] = []
  const timers: Array<{ fn: () => void; ms: number; id: number; live: boolean }> = []
  const gate = { fail: null as Error | null, hold: null as Promise<void> | null, attempts: 0 }
  const store: BoardStore = {
    load: async () => null,
    pruneAssets: async () => {},
    save: async (doc, expected, bytes) => {
      gate.attempts++
      if (gate.hold) await gate.hold
      if (gate.fail) throw gate.fail
      saves.push({ doc, expected, bytes })
      return { kind: 'rev', rev: `r${saves.length}` }
    },
  }
  const session = new Map<string, StoredAsset>()
  let version = 0
  const saver = new Autosaver({
    store,
    getDoc: () => ({ ...createEmptyDoc(), title: `v${++version}` }),
    bytes: (id) => session.get(id),
    onStatus: (s) => statuses.push(s),
    onConflict: (m) => conflicts.push(m),
    now: () => 1234,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: timers.length, live: true }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      ;(h as (typeof timers)[number]).live = false
    },
  })
  if (hydrated) saver.markLoaded(ABSENT)
  statuses.length = 0
  const fire = async () => {
    const live = timers.filter((t) => t.live)
    for (const t of live) {
      t.live = false
      t.fn()
    }
    await saver.flush() // lets an in-flight save settle
  }
  return { saver, statuses, saves, conflicts, timers, gate, session, fire, kinds: () => statuses.map((s) => s.kind) }
}

describe('Autosaver status machine', () => {
  it('reports "new" for a board with nothing stored and "saved" after loading one', () => {
    const a = setup()
    a.saver.markLoaded(ABSENT)
    expect(a.saver.state.kind).toBe('new')
    a.saver.markLoaded(STORED)
    expect(a.saver.state).toEqual({ kind: 'saved', at: 1234 })
    a.saver.markLoaded({ kind: 'legacy', updatedAt: 1, docJson: '{}' }) // a milestone 1 row is a stored board too
    expect(a.saver.state.kind).toBe('saved')
  })

  it('goes dirty -> saving -> saved and writes the live document', async () => {
    const a = setup()
    a.saver.markLoaded(ABSENT)
    a.saver.markDirty()
    expect(a.saver.state.kind).toBe('dirty')
    expect(a.saves).toHaveLength(0) // debounced, nothing written yet
    await a.fire()
    expect(a.kinds().slice(-3)).toEqual(['dirty', 'saving', 'saved'])
    expect(a.saves).toHaveLength(1)
  })

  it('debounces bursts into a single save', async () => {
    const a = setup()
    for (let i = 0; i < 10; i++) a.saver.markDirty()
    expect(a.timers.filter((t) => t.live)).toHaveLength(1)
    await a.fire()
    expect(a.saves).toHaveLength(1)
  })

  it('surfaces a failed save as an error and retries with the same token', async () => {
    const a = setup()
    a.saver.markLoaded(STORED)
    a.gate.fail = new Error('quota exceeded')
    a.saver.markDirty()
    await a.fire()
    expect(a.saver.state).toEqual({ kind: 'error', message: 'quota exceeded' })
    expect(a.saver.hasUnsavedChanges).toBe(true)

    a.gate.fail = null
    await a.saver.retry()
    expect(a.saver.state.kind).toBe('saved')
    expect(a.saves[0]?.expected).toEqual(STORED) // the failure did not advance or lose the token
    expect(a.saver.hasUnsavedChanges).toBe(false)
  })

  it('retry is a no-op unless the last save failed', async () => {
    const a = setup()
    a.saver.markLoaded(STORED)
    await a.saver.retry()
    expect(a.saves).toHaveLength(0)
  })

  it('a new edit after a failure schedules a fresh attempt', async () => {
    const a = setup()
    a.gate.fail = new Error('nope')
    a.saver.markDirty()
    await a.fire()
    a.gate.fail = null
    a.saver.markDirty()
    expect(a.saver.state.kind).toBe('dirty')
    await a.fire()
    expect(a.saver.state.kind).toBe('saved')
  })

  it('edits made while saving trigger another save instead of claiming "saved"', async () => {
    const a = setup()
    let release!: () => void
    a.gate.hold = new Promise<void>((r) => (release = r))
    a.saver.markDirty()
    for (const t of a.timers.filter((t) => t.live)) {
      t.live = false
      t.fn()
    }
    expect(a.saver.state.kind).toBe('saving')
    a.saver.markDirty() // user keeps editing mid-save
    a.gate.hold = null
    release()
    await a.fire()
    await a.fire()
    expect(a.saves.length).toBe(2)
    expect(a.saver.state.kind).toBe('saved')
    expect(a.saves[1]?.doc.title).toBe('v2') // the second save used a fresh snapshot
  })

  it('disable() blocks all writes and keeps the reason visible', async () => {
    const a = setup()
    a.saver.disable('storage unavailable')
    a.saver.markDirty()
    await a.saver.flush()
    expect(a.saves).toHaveLength(0)
    expect(a.timers.filter((t) => t.live)).toHaveLength(0)
    expect(a.saver.state).toEqual({ kind: 'unavailable', message: 'storage unavailable' })
    expect(a.saver.hasUnsavedChanges).toBe(false)
  })

  it('flush saves pending edits immediately (page hide)', async () => {
    const a = setup()
    a.saver.markDirty()
    await a.saver.flush()
    expect(a.saves).toHaveLength(1)
    expect(a.saver.state.kind).toBe('saved')
  })

  it('is inert until a successful load arms it: early edits never write', async () => {
    const a = setup({ hydrated: false }) // still hydrating: markLoaded() has not run
    a.saver.markDirty()
    a.saver.markDirty()
    expect(a.timers.filter((t) => t.live)).toHaveLength(0) // not even scheduled
    await a.saver.flush()
    await a.saver.retry()
    expect(a.saves).toHaveLength(0)
    expect(a.saver.state.kind).toBe('loading')
    expect(a.saver.hasUnsavedChanges).toBe(false)

    a.saver.markLoaded(STORED) // hydration finished
    a.saver.markDirty()
    await a.fire()
    expect(a.saves).toHaveLength(1)
  })

  it('a timer armed before disable() cannot write afterwards', async () => {
    const a = setup()
    a.saver.markLoaded(STORED)
    a.saver.markDirty() // debounce timer pending
    a.saver.disable('stored board could not be fully loaded')
    for (const t of a.timers) t.fn() // even if the timer fires anyway
    await a.saver.flush()
    expect(a.saves).toHaveLength(0)
    expect(a.saver.state.kind).toBe('unavailable')
  })

  it('markLoaded after disable() cannot re-enable saving', async () => {
    const a = setup()
    a.saver.disable('blocked')
    a.saver.markLoaded(STORED)
    a.saver.markDirty()
    await a.saver.flush()
    expect(a.saves).toHaveLength(0)
    expect(a.saver.state.kind).toBe('unavailable')
  })

  it('treats a throwing getDoc as a save error rather than crashing', async () => {
    const statuses: SaveState[] = []
    const saver = new Autosaver({
      store: { load: async () => null, pruneAssets: async () => {}, save: async () => STORED },
      getDoc: () => {
        throw new Error('serialize failed')
      },
      bytes: () => undefined,
      onStatus: (s) => statuses.push(s),
      setTimer: (fn) => fn,
      clearTimer: () => {},
    })
    saver.markLoaded(STORED)
    saver.markDirty()
    await saver.flush()
    expect(saver.state).toEqual({ kind: 'error', message: 'serialize failed' })
  })
})

describe('Autosaver: revision token and asset bytes', () => {
  it('passes the loaded token to the first save and the returned token to the next', async () => {
    const a = setup()
    a.saver.markLoaded(STORED)
    a.saver.markDirty()
    await a.fire()
    a.saver.markDirty()
    await a.fire()
    a.saver.markDirty()
    await a.fire()
    expect(a.saves.map((s) => s.expected)).toEqual([STORED, { kind: 'rev', rev: 'r1' }, { kind: 'rev', rev: 'r2' }])
  })

  it('a brand-new board saves against "nothing stored"', async () => {
    const a = setup()
    a.saver.markDirty()
    await a.fire()
    expect(a.saves[0]?.expected).toEqual(ABSENT)
  })

  it('hands every save the session bytes lookup (no one-shot pending list)', async () => {
    const a = setup()
    a.session.set('x', asset('x'))
    a.saver.markDirty()
    await a.fire()
    a.saver.markDirty()
    await a.fire()
    for (const s of a.saves) {
      expect(s.bytes('x')?.id).toBe('x') // still available on a later save, e.g. after another tab pruned it
      expect(s.bytes('unknown')).toBeUndefined()
    }
  })

  it('a conflict disables saving for good and is never retried', async () => {
    const a = setup()
    a.saver.markLoaded(STORED)
    a.gate.fail = new BoardConflictError()
    a.saver.markDirty()
    await a.fire()
    expect(a.conflicts).toEqual([CONFLICT_MESSAGE])
    expect(a.saver.state).toEqual({ kind: 'unavailable', message: CONFLICT_MESSAGE })
    expect(a.saver.hasUnsavedChanges).toBe(false)
    expect(a.gate.attempts).toBe(1)

    a.gate.fail = null // even if the store would now accept a write
    a.saver.markDirty()
    await a.saver.retry()
    await a.saver.flush()
    for (const t of a.timers) t.fn()
    await a.saver.flush()
    expect(a.gate.attempts).toBe(1)
    expect(a.saves).toHaveLength(0)
    expect(a.timers.filter((t) => t.live)).toHaveLength(0)
    expect(a.conflicts).toHaveLength(1)
  })

  it('a database taken over by a newer build is final too, with its own reason', async () => {
    const a = setup()
    a.saver.markLoaded(STORED)
    a.gate.fail = new NewerBoardError()
    a.saver.markDirty()
    await a.fire()
    expect(a.conflicts).toEqual([NEWER_BUILD_MESSAGE])
    expect(a.saver.state).toEqual({ kind: 'unavailable', message: NEWER_BUILD_MESSAGE })
    a.gate.fail = null
    a.saver.markDirty()
    await a.saver.retry()
    await a.saver.flush()
    expect(a.gate.attempts).toBe(1)
  })

  it('a save that succeeds after saving was switched off does not claim "saved" or reschedule', async () => {
    const a = setup()
    let release!: () => void
    a.gate.hold = new Promise<void>((r) => (release = r))
    a.saver.markDirty()
    for (const t of a.timers.filter((t) => t.live)) {
      t.live = false
      t.fn()
    }
    a.saver.markDirty() // changed while saving: would normally schedule another save
    a.saver.disable('read-only now')
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.saves).toHaveLength(1)
    expect(a.saver.state).toEqual({ kind: 'unavailable', message: 'read-only now' })
    expect(a.timers.filter((t) => t.live)).toHaveLength(0)
  })

  it('a save that succeeds after saving was switched off, with nothing else pending, still does not claim "saved"', async () => {
    const a = setup()
    let release!: () => void
    a.gate.hold = new Promise<void>((r) => (release = r))
    a.saver.markDirty()
    for (const t of a.timers.filter((t) => t.live)) {
      t.live = false
      t.fn()
    }
    a.saver.disable('read-only now') // no edit arrived mid-save
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.saves).toHaveLength(1)
    expect(a.saver.state).toEqual({ kind: 'unavailable', message: 'read-only now' })
    expect(a.kinds()).not.toContain('saved')
  })

  it('missing bytes and a storage deadline are ordinary retryable errors', async () => {
    for (const failure of [new MissingAssetError(), new StorageBusyError()]) {
      const a = setup()
      a.saver.markLoaded(STORED)
      a.gate.fail = failure
      a.saver.markDirty()
      await a.fire()
      expect(a.saver.state).toEqual({ kind: 'error', message: failure.message })
      expect(a.conflicts).toEqual([])
      a.gate.fail = null
      await a.saver.retry()
      expect(a.saver.state.kind).toBe('saved')
      expect(a.saves[0]?.expected).toEqual(STORED) // nothing was written by the failed attempt
    }
  })

  it('a save that fails after saving was switched off keeps the switch-off reason', async () => {
    const a = setup()
    let release!: () => void
    a.gate.hold = new Promise<void>((r) => (release = r))
    a.gate.fail = new Error('late failure')
    a.saver.markDirty()
    for (const t of a.timers.filter((t) => t.live)) {
      t.live = false
      t.fn()
    }
    a.saver.disable('read-only now')
    release()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.saver.state).toEqual({ kind: 'unavailable', message: 'read-only now' })
  })
})

describe('Autosaver after dispose', () => {
  it('a save in flight, a change, dispose, then completion: exactly one write, no timer left, no status, getDoc not asked again', async () => {
    const s = setup()
    let release!: () => void
    s.gate.hold = new Promise<void>((r) => (release = r))
    s.saver.markDirty()
    for (const t of s.timers.filter((x) => x.live)) {
      t.live = false
      t.fn() // the debounce fires: the save starts and waits
    }
    expect(s.gate.attempts).toBe(1)
    s.saver.markDirty() // something changed while it was saving
    s.saver.dispose()
    const statusesAtDispose = s.statuses.length
    release()
    await new Promise((r) => setTimeout(r, 0))
    await s.saver.flush()
    await s.saver.retry()
    s.saver.markDirty()
    s.saver.markLoaded(ABSENT)
    expect(s.saves).toHaveLength(1) // the in-flight one, with the document taken before dispose
    expect(s.saves[0]!.doc.title).toBe('v1')
    expect(s.gate.attempts).toBe(1)
    expect(s.timers.filter((t) => t.live)).toHaveLength(0)
    expect(s.statuses.length).toBe(statusesAtDispose)
  })

  it('an in-flight save that fails after dispose reports nothing', async () => {
    const s = setup()
    let release!: () => void
    s.gate.hold = new Promise<void>((r) => (release = r))
    s.gate.fail = new BoardConflictError()
    s.saver.markDirty()
    for (const t of s.timers.filter((x) => x.live)) {
      t.live = false
      t.fn()
    }
    s.saver.dispose()
    const before = s.statuses.length
    release()
    await new Promise((r) => setTimeout(r, 0))
    expect(s.conflicts).toEqual([])
    expect(s.statuses.length).toBe(before)
  })
})
