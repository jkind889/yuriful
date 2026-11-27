import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LABEL_GAP } from '../model/frames.ts'
import type { FrameRecord, ImageRecord } from '../model/types.ts'
import { FrameCanvas } from './FrameCanvas.ts'
import { createFrame, createObject, idOf, setLocked } from './objects.ts'
import { ActiveSelection, Point } from './testing/fakeFabric.ts'
import type { FakeObject } from './testing/fakeFabric.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * What FrameCanvas decides about locked objects, on the fake's plain base implementations
 * (which, like Fabric, skip objects that are not `evented` when finding a target and
 * objects that are not `selectable` in a marquee). Real hit testing is covered in
 * e2e/locking.spec.ts.
 */
type Any = never
const el = { naturalWidth: 200, naturalHeight: 200 } as HTMLImageElement
const frame = (id: string, left: number, top: number, width = 400, height = 300, locked?: true): FrameRecord => ({ id, name: id, left, top, width, height, ...(locked && { locked }) })
const image = (id: string, left: number, top: number, scale = 1, locked?: true): ImageRecord => ({
  type: 'image',
  id,
  left,
  top,
  angle: 0,
  assetId: 'a',
  scaleX: scale,
  scaleY: scale,
  ...(locked && { locked }),
})

let canvas: FrameCanvas
const raw = () => canvas as unknown as { add: (...o: unknown[]) => void; getObjects: () => unknown[]; setActiveObject: (o: unknown) => void; selection: boolean; multiSelectionCalls: unknown[] }
const add = (...objs: unknown[]) => raw().add(...objs)
const targetAt = (x: number, y: number) => {
  const found = canvas.searchPossibleTargets(raw().getObjects() as Any, new Point(x, y) as Any).target
  return found ? idOf(found) : undefined
}
const collect = (left: number, top: number, width: number, height: number) => canvas.collectObjects({ left, top, width, height }).map((o) => idOf(o as never))

beforeEach(() => {
  canvas = new FrameCanvas(document.createElement('canvas'), { width: 800, height: 600 })
})

describe('a locked object is never the target of a press', () => {
  it('a press on a locked image reaches the image beneath it, or nothing', () => {
    add(createObject(image('small', 300, 200), () => el), createObject(image('big', 250, 150, 2, true), () => el))
    expect(targetAt(350, 250)).toBe('small')
    expect(targetAt(600, 500)).toBeUndefined() // only the locked image is there: the empty board
  })

  it('unlocking makes it a target again', () => {
    const big = createObject(image('big', 250, 150, 2, true), () => el)!
    add(createObject(image('small', 300, 200), () => el), big)
    setLocked(big, false)
    expect(targetAt(350, 250)).toBe('big')
  })

  it('a locked frame’s label and outline are not grabbable, so content under them is hit', () => {
    add(createFrame(frame('f', 100, 100, 400, 300, true)), createObject(image('img', 0, 0, 4), () => el))
    expect(targetAt(104, 100 - LABEL_GAP - 3)).toBe('img') // label over image
    expect(targetAt(300, 100)).toBe('img') // top edge over image
  })

  it('a locked frame’s label is not hit on the empty board either', () => {
    add(createFrame(frame('f', 100, 100, 400, 300, true)))
    expect(targetAt(104, 100 - LABEL_GAP - 3)).toBeUndefined()
    expect(targetAt(300, 100)).toBeUndefined()
  })
})

describe('a marquee skips locked things', () => {
  it('takes the unlocked objects it touches, never a locked one, nor a locked frame it fully encloses', () => {
    add(
      createFrame(frame('lf', 100, 100, 400, 300, true)),
      createFrame(frame('f', 600, 100, 100, 100)),
      createObject(image('img', 150, 150), () => el),
      createObject(image('locked', 200, 200, 1, true), () => el),
    )
    expect(collect(50, 50, 700, 400)).toEqual(['img', 'f'])
  })
})

describe('Shift-click and a locked selection', () => {
  const shift = { shiftKey: true, clientX: 700, clientY: 500 }
  const multi = (target?: unknown) => (canvas as unknown as { handleMultiSelection: (e: object, t?: unknown) => boolean }).handleMultiSelection(shift, target)

  it('does not add anything to a single locked selection (Fabric is never asked to group)', () => {
    const locked = createObject(image('locked', 0, 0, 1, true), () => el)!
    const other = createObject(image('other', 600, 400), () => el)!
    add(locked, other)
    raw().setActiveObject(locked)
    raw().selection = true
    expect(multi(other)).toBe(false)
    expect(raw().multiSelectionCalls).toEqual([])
  })

  it('leaves an unlocked selection to Fabric as before', () => {
    const a = createObject(image('a', 0, 0), () => el) as unknown as FakeObject
    const b = createObject(image('b', 600, 400), () => el) as unknown as FakeObject
    add(a, b)
    raw().setActiveObject(a)
    raw().selection = true
    multi(b)
    expect(raw().multiSelectionCalls).toHaveLength(1)
    raw().setActiveObject(new ActiveSelection([a, b]))
    multi(b)
    expect(raw().multiSelectionCalls).toHaveLength(2)
  })
})
