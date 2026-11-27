import { round } from './doc.ts'
import type { Rect } from './viewport.ts'

export type Align = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'
export type Distribute = 'space-x' | 'space-y'
export type Layout = Align | Distribute

export interface LayoutOffsets {
  axis: 'x' | 'y'
  amounts: number[]
}

/** Aligns scene-space bounds, or spaces their edges evenly between the two outer items. */
export function layoutOffsets(boxes: readonly Rect[], op: Layout): LayoutOffsets | null {
  const spacing = op === 'space-x' || op === 'space-y'
  if (boxes.length < (spacing ? 3 : 2)) return null
  const horizontal = op === 'left' || op === 'center-x' || op === 'right' || op === 'space-x'
  const axis = horizontal ? 'x' : 'y'
  const intervals = boxes.map((b) => horizontal ? [b.left, b.right] as const : [b.top, b.bottom] as const)
  let amounts: number[]

  if (spacing) {
    // Centre order is stable for equal centres because callers supply canvas stack order.
    const sorted = intervals.map(([start, end], i) => ({ start, end, i }))
      .sort((a, b) => (a.start / 2 + a.end / 2) - (b.start / 2 + b.end / 2))
    const first = sorted[0]!
    const last = sorted[sorted.length - 1]!
    const middle = sorted.slice(1, -1)
    const lengths = middle.reduce((sum, item) => sum + (item.end - item.start), 0)
    const gap = (last.start - first.end - lengths) / (sorted.length - 1)
    if (!Number.isFinite(gap) || round(gap) < 0) return null
    let end = first.end
    amounts = Array<number>(boxes.length).fill(0)
    for (const item of middle) {
      const start = end + Math.max(0, gap)
      amounts[item.i] = start - item.start
      end = start + (item.end - item.start)
    }
  } else {
    const min = intervals.reduce((edge, [start]) => Math.min(edge, start), Infinity)
    const max = intervals.reduce((edge, [, end]) => Math.max(edge, end), -Infinity)
    if (op === 'left' || op === 'top') amounts = intervals.map(([start]) => min - start)
    else if (op === 'right' || op === 'bottom') amounts = intervals.map(([, end]) => max - end)
    else amounts = intervals.map(([start, end]) => (min / 2 + max / 2) - (start / 2 + end / 2))
  }

  return amounts.every(Number.isFinite) ? { axis, amounts: amounts.map((delta) => round(delta)) } : null
}
