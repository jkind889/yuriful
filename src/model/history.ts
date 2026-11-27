export interface HistoryOptions<T> {
  /** Maximum number of undo steps kept. */
  limit?: number
  equals?: (a: T, b: T) => boolean
  now?: () => number
  /** Pushes with the same coalesce key inside this window replace each other. */
  coalesceMs?: number
}

/**
 * Snapshot history. Entries are whole-document snapshots, treated as immutable.
 * `current` is always the state the UI is showing.
 */
export class History<T> {
  private stack: T[]
  private index = 0
  private lastKey: string | null = null
  private lastAt = 0
  private readonly limit: number
  private readonly equals: (a: T, b: T) => boolean
  private readonly now: () => number
  private readonly coalesceMs: number

  constructor(initial: T, opts: HistoryOptions<T> = {}) {
    this.stack = [initial]
    this.limit = opts.limit ?? 100
    this.equals = opts.equals ?? ((a, b) => a === b)
    this.now = opts.now ?? (() => Date.now())
    this.coalesceMs = opts.coalesceMs ?? 800
  }

  get current(): T {
    return this.stack[this.index] as T
  }
  get canUndo(): boolean {
    return this.index > 0
  }
  get canRedo(): boolean {
    return this.index < this.stack.length - 1
  }

  /** Records a new state. Returns false when it equals the current state (no-op). */
  push(state: T, coalesceKey?: string): boolean {
    if (this.equals(this.current, state)) return false
    const t = this.now()
    const coalesce =
      coalesceKey !== undefined && coalesceKey === this.lastKey && t - this.lastAt <= this.coalesceMs && this.index > 0
    this.stack.length = this.index + 1 // drop redo branch
    if (coalesce && this.equals(this.stack[this.index - 1] as T, state)) {
      // The coalesced step went back to where it started (a name typed and then typed back):
      // drop it, so that Undo is not left with a step that does nothing.
      this.stack.length = this.index
      this.index--
      this.lastKey = null
      return true
    }
    if (coalesce) {
      this.stack[this.index] = state
    } else {
      this.stack.push(state)
      this.index++
      if (this.stack.length > this.limit + 1) {
        this.stack.shift()
        this.index--
      }
    }
    this.lastKey = coalesceKey ?? null
    this.lastAt = t
    return true
  }

  undo(): T | null {
    if (!this.canUndo) return null
    this.index--
    this.lastKey = null
    return this.current
  }

  redo(): T | null {
    if (!this.canRedo) return null
    this.index++
    this.lastKey = null
    return this.current
  }

  reset(state: T): void {
    this.stack = [state]
    this.index = 0
    this.lastKey = null
  }
}
