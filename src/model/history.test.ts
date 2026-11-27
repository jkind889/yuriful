import { describe, expect, it } from 'vitest'
import { History } from './history.ts'

const make = (opts = {}) => {
  let t = 0
  const h = new History<number>(0, { now: () => t, ...opts })
  return { h, tick: (ms: number) => (t += ms) }
}

describe('History', () => {
  it('starts with nothing to undo or redo', () => {
    const { h } = make()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.current).toBe(0)
  })

  it('undoes and redoes through pushed states', () => {
    const { h } = make()
    h.push(1)
    h.push(2)
    expect(h.undo()).toBe(1)
    expect(h.undo()).toBe(0)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe(1)
    expect(h.redo()).toBe(2)
    expect(h.redo()).toBeNull()
  })

  it('ignores pushes equal to the current state', () => {
    const { h } = make()
    expect(h.push(0)).toBe(false)
    expect(h.canUndo).toBe(false)
    h.push(1)
    expect(h.push(1)).toBe(false)
    h.undo()
    expect(h.current).toBe(0)
  })

  it('uses the supplied equality for object snapshots', () => {
    const h = new History<{ a: number }>({ a: 1 }, { equals: (x, y) => x.a === y.a })
    expect(h.push({ a: 1 })).toBe(false)
    expect(h.push({ a: 2 })).toBe(true)
  })

  it('drops the redo branch when a new state is pushed after undo', () => {
    const { h } = make()
    h.push(1)
    h.push(2)
    h.undo()
    h.push(3)
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBe(1)
  })

  it('caps the number of undo steps', () => {
    const { h } = make({ limit: 3 })
    for (let i = 1; i <= 10; i++) h.push(i)
    let steps = 0
    while (h.undo() !== null) steps++
    expect(steps).toBe(3)
    expect(h.current).toBe(7)
  })

  it('coalesces rapid pushes sharing a key into one step', () => {
    const { h, tick } = make()
    h.push(1) // an unrelated earlier change
    h.push(10, 'font')
    tick(100)
    h.push(11, 'font')
    tick(100)
    h.push(12, 'font')
    expect(h.undo()).toBe(1) // all font edits collapsed together
    expect(h.redo()).toBe(12)
  })

  it('does not coalesce across the time window, other keys, or after undo', () => {
    const { h, tick } = make({ coalesceMs: 500 })
    h.push(1)
    h.push(2, 'k')
    tick(600)
    h.push(3, 'k') // outside the window
    expect(h.undo()).toBe(2)
    h.push(4, 'k') // right after an undo: starts a fresh step
    expect(h.undo()).toBe(2)
    h.redo()
    h.push(5, 'other')
    h.push(6, 'k')
    expect(h.undo()).toBe(5)
  })

  it('a coalesced step that returns to where it started disappears instead of leaving a no-op undo', () => {
    const { h } = make()
    h.push(1)
    h.push(2, 'k')
    h.push(3, 'k')
    expect(h.push(1, 'k')).toBe(true) // typed back to the value from before the step
    expect(h.current).toBe(1)
    expect(h.undo()).toBe(0) // the next undo goes straight to the step before
    expect(h.canUndo).toBe(false)
    h.redo()
    expect(h.canRedo).toBe(false)
    h.push(5, 'k') // and the key does not linger: this is a fresh step
    expect(h.undo()).toBe(1)
  })

  it('never coalesces into the initial state', () => {
    const { h } = make()
    h.push(1, 'k')
    expect(h.undo()).toBe(0)
  })

  it('reset replaces everything', () => {
    const { h } = make()
    h.push(1)
    h.reset(9)
    expect(h.current).toBe(9)
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
  })
})
