import { DEFAULT_PREFS, parsePrefs, serializePrefs } from '../model/prefs.ts'
import type { CanvasPrefs } from '../model/prefs.ts'

export const PREFS_KEY = 'yuriful.prefs.v1'

export function createPrefsStore(storage = () => window.localStorage) {
  const listeners = new Set<() => void>()
  let current: CanvasPrefs | undefined
  const get = (): CanvasPrefs => {
    if (!current) {
      try {
        current = parsePrefs(JSON.parse(storage().getItem(PREFS_KEY) ?? 'null'))
      } catch {
        current = DEFAULT_PREFS
      }
    }
    return current
  }
  return {
    get,
    set(key: keyof CanvasPrefs, value: boolean) {
      const before = get()
      if (before[key] === value) return
      current = Object.freeze({ ...before, [key]: value })
      try {
        storage().setItem(PREFS_KEY, serializePrefs(current))
      } catch {
        // The choice still works for this session when local storage is unavailable.
      }
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export const canvasPrefs = createPrefsStore()
