import { describe, expect, it, vi } from 'vitest'
import { createPrefsStore, PREFS_KEY } from '../persistence/prefsStore.ts'
import { DEFAULT_PREFS, parsePrefs, serializePrefs } from './prefs.ts'

describe('canvas preferences', () => {
  it('defaults absent and malformed fields independently', () => {
    for (const value of [undefined, null, false, 'true', []]) {
      expect(parsePrefs(value)).toEqual({ feedback: true, captionSnap: true })
    }
    expect(parsePrefs({ feedback: false })).toEqual({ feedback: false, captionSnap: true })
    expect(parsePrefs({ feedback: false, captionSnap: 'yes', extra: true })).toEqual({ feedback: false, captionSnap: true })
    expect(parsePrefs({ feedback: 0, captionSnap: true })).toEqual({ feedback: true, captionSnap: true })
    expect(parsePrefs({ captionSnap: false })).toEqual({ feedback: true, captionSnap: false })
  })

  it('round-trips every combination', () => {
    for (const feedback of [true, false]) {
      for (const captionSnap of [true, false]) {
        const prefs = { feedback, captionSnap }
        expect(parsePrefs(JSON.parse(serializePrefs(prefs)))).toEqual(prefs)
      }
    }
  })

  it('reads only its key, notifies on a change and persists for the next session', () => {
    const data = new Map([[PREFS_KEY, 'broken']])
    const storage = () => ({
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
      clear: vi.fn(), key: vi.fn(), removeItem: vi.fn(), length: 1,
    })
    const prefs = createPrefsStore(storage)
    expect(prefs.get()).toEqual(DEFAULT_PREFS)
    const change = vi.fn()
    const unsubscribe = prefs.subscribe(change)
    prefs.set('feedback', false)
    prefs.set('feedback', false)
    expect(change).toHaveBeenCalledTimes(1)
    unsubscribe()
    prefs.set('captionSnap', false)
    expect(change).toHaveBeenCalledTimes(1)
    expect([...data.keys()]).toEqual([PREFS_KEY])
    expect(createPrefsStore(storage).get()).toEqual({ feedback: false, captionSnap: false })
  })

  it('uses defaults when storage throws and keeps changes for the current session', () => {
    const prefs = createPrefsStore(() => { throw new Error('denied') })
    expect(prefs.get()).toEqual(DEFAULT_PREFS)
    expect(() => prefs.set('feedback', false)).not.toThrow()
    expect(prefs.get().feedback).toBe(false)
  })
})
