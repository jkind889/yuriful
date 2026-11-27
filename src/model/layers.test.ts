import { describe, expect, it } from 'vitest'
import { canReorder, canReorderLayered, reorder, reorderLayered } from './layers.ts'

const order = ['a', 'b', 'c', 'd', 'e']
const sel = (...ids: string[]) => new Set(ids)

describe('reorder', () => {
  it('brings a single item forward and backward by one slot', () => {
    expect(reorder(order, sel('b'), 'forward')).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(reorder(order, sel('b'), 'backward')).toEqual(['b', 'a', 'c', 'd', 'e'])
  })

  it('moves to the front and back', () => {
    expect(reorder(order, sel('b'), 'front')).toEqual(['a', 'c', 'd', 'e', 'b'])
    expect(reorder(order, sel('d'), 'back')).toEqual(['d', 'a', 'b', 'c', 'e'])
  })

  it('keeps relative order of a multi-selection', () => {
    expect(reorder(order, sel('b', 'd'), 'front')).toEqual(['a', 'c', 'e', 'b', 'd'])
    expect(reorder(order, sel('b', 'd'), 'back')).toEqual(['b', 'd', 'a', 'c', 'e'])
  })

  it('moves an adjacent multi-selection as a block', () => {
    expect(reorder(order, sel('b', 'c'), 'forward')).toEqual(['a', 'd', 'b', 'c', 'e'])
    expect(reorder(order, sel('c', 'd'), 'backward')).toEqual(['a', 'c', 'd', 'b', 'e'])
  })

  it('does not let selected items leapfrog each other', () => {
    expect(reorder(order, sel('d', 'e'), 'forward')).toEqual(order)
    expect(reorder(order, sel('a', 'b'), 'backward')).toEqual(order)
  })

  it('does not mutate the input', () => {
    const copy = [...order]
    reorder(copy, sel('a'), 'front')
    expect(copy).toEqual(order)
  })
})

describe('canReorder', () => {
  it('is false at the extremes and true otherwise', () => {
    expect(canReorder(order, sel('e'), 'front')).toBe(false)
    expect(canReorder(order, sel('e'), 'forward')).toBe(false)
    expect(canReorder(order, sel('e'), 'back')).toBe(true)
    expect(canReorder(order, sel('a'), 'back')).toBe(false)
    expect(canReorder(order, sel('a'), 'backward')).toBe(false)
    expect(canReorder(order, sel('c'), 'forward')).toBe(true)
  })
})

describe('reorderLayered', () => {
  const layered = { frames: ['f1', 'f2', 'f3'], objects: ['a', 'b', 'c'] }

  it('moves content only within the content band', () => {
    expect(reorderLayered(layered, sel('a'), 'front')).toEqual({ frames: ['f1', 'f2', 'f3'], objects: ['b', 'c', 'a'] })
    expect(reorderLayered(layered, sel('c'), 'back')).toEqual({ frames: ['f1', 'f2', 'f3'], objects: ['c', 'a', 'b'] })
  })

  it('never lets a frame rise above content, whatever the operation', () => {
    for (const op of ['front', 'forward', 'backward', 'back'] as const) {
      const next = reorderLayered(layered, sel('f1', 'f3'), op)
      expect(next.objects).toEqual(layered.objects)
      expect([...next.frames].sort()).toEqual(['f1', 'f2', 'f3'])
    }
    expect(reorderLayered(layered, sel('f1'), 'front').frames).toEqual(['f2', 'f3', 'f1'])
    expect(reorderLayered(layered, sel('f3'), 'front').frames).toEqual(['f1', 'f2', 'f3']) // already front-most frame
  })

  it('reorders a mixed selection inside each band independently', () => {
    expect(reorderLayered(layered, sel('f1', 'a'), 'forward')).toEqual({ frames: ['f2', 'f1', 'f3'], objects: ['b', 'a', 'c'] })
  })

  it('reports whether anything would move', () => {
    expect(canReorderLayered(layered, sel('f3'), 'front')).toBe(false)
    expect(canReorderLayered(layered, sel('f3'), 'back')).toBe(true)
    expect(canReorderLayered(layered, sel('f3', 'a'), 'front')).toBe(true) // the content can still move
    expect(canReorderLayered(layered, sel('f3', 'c'), 'front')).toBe(false)
    expect(canReorderLayered({ frames: ['f1'], objects: [] }, sel('f1'), 'front')).toBe(false)
  })
})
