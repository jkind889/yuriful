export type LayerOp = 'front' | 'forward' | 'backward' | 'back'
export type LayerDropSide = 'before' | 'after' // in the front-most-first layer list

/**
 * Pure z-order reordering for a selection (order is back to front).
 * Selected items keep their relative order. Forward/backward move the group
 * by one slot past unselected neighbours, so multi-selections behave sanely.
 */
export function reorder(order: readonly string[], selected: ReadonlySet<string>, op: LayerOp): string[] {
  const out = [...order]
  const isSel = (i: number) => selected.has(out[i] as string)
  const swap = (i: number, j: number) => {
    const t = out[i] as string
    out[i] = out[j] as string
    out[j] = t
  }
  switch (op) {
    case 'front':
      return [...out.filter((id) => !selected.has(id)), ...out.filter((id) => selected.has(id))]
    case 'back':
      return [...out.filter((id) => selected.has(id)), ...out.filter((id) => !selected.has(id))]
    case 'forward':
      for (let i = out.length - 2; i >= 0; i--) if (isSel(i) && !isSel(i + 1)) swap(i, i + 1)
      return out
    case 'backward':
      for (let i = 1; i < out.length; i++) if (isSel(i) && !isSel(i - 1)) swap(i, i - 1)
      return out
  }
}

export function canReorder(order: readonly string[], selected: ReadonlySet<string>, op: LayerOp): boolean {
  const next = reorder(order, selected, op)
  return next.some((id, i) => id !== order[i])
}

/** The two z-bands of a board, each back to front. Every frame sits behind every object. */
export interface LayeredOrder {
  frames: readonly string[]
  objects: readonly string[]
}

/**
 * Reorders a selection that may mix frames and content. Each kind moves only within
 * its own band, so a frame can never rise above content (or content sink below a frame).
 */
export function reorderLayered(order: LayeredOrder, selected: ReadonlySet<string>, op: LayerOp): { frames: string[]; objects: string[] } {
  return { frames: reorder(order.frames, selected, op), objects: reorder(order.objects, selected, op) }
}

export function canReorderLayered(order: LayeredOrder, selected: ReadonlySet<string>, op: LayerOp): boolean {
  return canReorder(order.frames, selected, op) || canReorder(order.objects, selected, op)
}
