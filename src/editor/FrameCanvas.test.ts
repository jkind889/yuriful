import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_HIT_TOLERANCE, LABEL_GAP, LABEL_HEIGHT } from '../model/frames.ts'
import type { FrameRecord, ImageRecord } from '../model/types.ts'
import { FrameCanvas } from './FrameCanvas.ts'
import { fitLabel, frameOverlay, hitsFrameOverlay } from './frameLayer.ts'
import { createFrame, createObject, idOf } from './objects.ts'
import { ActiveSelection, Point } from './testing/fakeFabric.ts'
import type { FakeObject } from './testing/fakeFabric.ts'

vi.mock('fabric', () => import('./testing/fakeFabric.ts'))

/**
 * The fake canvas supplies plain base implementations of Fabric's target search (the
 * top-most object whose box contains the point), so these tests cover the DECISIONS
 * FrameCanvas makes on top of them. Real geometry and Fabric's real call order are
 * covered in the browser (e2e/frames.spec.ts).
 */
type Any = never
const el = { naturalWidth: 200, naturalHeight: 200 } as HTMLImageElement
const frame = (id: string, left: number, top: number, width = 400, height = 300, name = id): FrameRecord => ({ id, name, left, top, width, height })
const image = (id: string, left: number, top: number): ImageRecord => ({ type: 'image', id, left, top, angle: 0, assetId: 'a', scaleX: 1, scaleY: 1 })

let canvas: FrameCanvas
const add = (...objs: unknown[]) => (canvas as unknown as { add: (...o: unknown[]) => void }).add(...objs)
const at = (x: number, y: number) => new Point(x, y) as Any
const targetAt = (x: number, y: number, among?: unknown[]) => {
  const objects = (among ?? (canvas as unknown as { getObjects: () => unknown[] }).getObjects()) as Any
  const found = canvas.searchPossibleTargets(objects, at(x, y)).target
  return found ? idOf(found) : undefined
}
const setView = (zoom: number, panX: number, panY: number) => {
  ;(canvas as unknown as { viewportTransform: number[] }).viewportTransform = [zoom, 0, 0, zoom, panX, panY]
}

beforeEach(() => {
  canvas = new FrameCanvas(document.createElement('canvas'), { width: 800, height: 600 })
})

describe('frame overlay geometry', () => {
  it('maps the frame rectangle to viewport pixels and puts the label above its top-left corner', () => {
    const f = createFrame(frame('f', 100, 200, 400, 300, 'Cover'))
    const o = frameOverlay(f, [2, 0, 0, 2, -50, 30])
    expect(o.outline).toEqual({ left: 150, top: 430, width: 800, height: 600 })
    expect(o.label.left).toBe(150)
    expect(o.label.top).toBe(430 - LABEL_GAP - LABEL_HEIGHT)
    expect(o.label.height).toBe(LABEL_HEIGHT)
    expect(o.text).toBe('Cover')
  })

  it('the label keeps its screen size at any zoom', () => {
    const f = createFrame(frame('f', 0, 0, 400, 300, 'Cover'))
    const near = frameOverlay(f, [4, 0, 0, 4, 0, 0]).label
    const far = frameOverlay(f, [0.1, 0, 0, 0.1, 0, 0]).label
    expect(near.width).toBe(far.width)
    expect(near.height).toBe(far.height)
  })

  it('shortens a long name with an ellipsis and caches the result', () => {
    const long = 'A very long frame name '.repeat(10)
    const fitted = fitLabel(long)
    expect(fitted.text.endsWith('…')).toBe(true)
    expect(fitted.text.length).toBeLessThan(long.length)
    expect(fitLabel(long)).toBe(fitted)
    expect(fitLabel('Short').text).toBe('Short')
  })

  it('hits the label and the outline band but not the interior', () => {
    const o = frameOverlay(createFrame(frame('f', 100, 100)), [1, 0, 0, 1, 0, 0])
    expect(hitsFrameOverlay(o, { x: 104, y: 100 - LABEL_GAP - 3 })).toBe(true) // label
    expect(hitsFrameOverlay(o, { x: 300, y: 100 + FRAME_HIT_TOLERANCE })).toBe(true) // top edge band
    expect(hitsFrameOverlay(o, { x: 300, y: 250 })).toBe(false) // interior
  })
})

describe('target priority', () => {
  it('a frame interior is click-through: content inside it is hit, empty interior is nothing', () => {
    add(createFrame(frame('f', 100, 100)), createObject(image('img', 150, 150), () => el))
    expect(targetAt(200, 200)).toBe('img')
    expect(targetAt(450, 380)).toBeUndefined() // inside the frame, beside the image
  })

  it('a frame label or outline wins over content lying on top of it', () => {
    // The image covers the whole frame and more, label included.
    add(createFrame(frame('f', 100, 100)), createObject({ ...image('img', 0, 0), scaleX: 4, scaleY: 4 }, () => el))
    expect(targetAt(104, 100 - LABEL_GAP - 3)).toBe('f') // label over image
    expect(targetAt(300, 100)).toBe('f') // top edge over image
    expect(targetAt(500, 250)).toBe('f') // right edge over image
    expect(targetAt(300, 250)).toBe('img') // interior over image
  })

  it('the front-most frame wins where two overlays coincide', () => {
    add(createFrame(frame('back', 100, 100)), createFrame(frame('front', 100, 100)))
    expect(targetAt(300, 100)).toBe('front')
    expect(targetAt(104, 100 - LABEL_GAP - 3)).toBe('front')
  })

  it('uses viewport pixels: the band is 6 screen pixels at any zoom and pan', () => {
    add(createFrame(frame('f', 100, 100)))
    for (const [zoom, panX, panY] of [
      [0.25, 310, -40],
      [4, -700, 120],
    ] as const) {
      setView(zoom, panX, panY)
      const sceneX = (px: number) => (px - panX) / zoom
      const sceneY = (py: number) => (py - panY) / zoom
      const edge = 100 * zoom + panX // left edge in viewport pixels
      const midY = (100 + 150) * zoom + panY
      expect(targetAt(sceneX(edge + FRAME_HIT_TOLERANCE), sceneY(midY))).toBe('f')
      expect(targetAt(sceneX(edge - FRAME_HIT_TOLERANCE), sceneY(midY))).toBe('f')
      expect(targetAt(sceneX(edge + FRAME_HIT_TOLERANCE + 2), sceneY(midY))).toBeUndefined()
      expect(targetAt(sceneX(edge - FRAME_HIT_TOLERANCE - 2), sceneY(midY))).toBeUndefined()
    }
  })

  it('a single selected frame is found only by its overlay, so its interior stays click-through', () => {
    const f = createFrame(frame('f', 100, 100))
    add(f)
    expect(targetAt(300, 250, [f])).toBeUndefined() // what Fabric asks about the active object
    expect(targetAt(300, 100, [f])).toBe('f')
    expect(canvas._checkTarget(f as Any, at(300, 250))).toBe(false)
    expect(canvas._checkTarget(f as Any, at(300, 100))).toBe(true)
  })

  it('a multi-selection is still grabbed anywhere in its box', () => {
    const f = createFrame(frame('f', 100, 100)) as unknown as FakeObject
    const img = createObject(image('img', 150, 150), () => el) as unknown as FakeObject
    add(f, img)
    const selection = new ActiveSelection([f, img])
    Object.assign(selection, { left: 100, top: 100, width: 400, height: 300 })
    expect(canvas.searchPossibleTargets([selection] as Any, at(450, 380)).target).toBe(selection)
  })

  it('the label of a frame that is part of the multi-selection acts on the whole selection', () => {
    const f = createFrame(frame('f', 100, 100)) as unknown as FakeObject
    const img = createObject(image('img', 150, 150), () => el) as unknown as FakeObject
    add(f, img)
    const selection = new ActiveSelection([f, img])
    f.group = selection // as Fabric marks the members of the active selection
    img.group = selection
    ;(canvas as unknown as { setActiveObject: (o: unknown) => void }).setActiveObject(selection)
    const objects = (canvas as unknown as { _objects: unknown[] })._objects as Any
    // The label lies above the frame, outside the selection's box: Fabric would otherwise see the lone frame.
    expect(canvas.searchPossibleTargets(objects, at(104, 100 - LABEL_GAP - 3)).target).toBe(selection)
    expect(canvas.searchPossibleTargets(objects, at(100 - 3, 250)).target).toBe(selection) // outer half of the edge band
    // When Fabric searches among the members themselves (Shift-click), it still gets the member.
    expect(canvas.searchPossibleTargets([f, img] as Any, at(104, 100 - LABEL_GAP - 3)).target).toBe(f)
    // A frame that is not part of the selection is still found as itself.
    const other = createFrame(frame('other', 900, 100)) as unknown as FakeObject
    add(other)
    expect(targetAt(904, 100 - LABEL_GAP - 3)).toBe('other')
  })

  it('ignores a hidden or non-evented frame', () => {
    const f = createFrame(frame('f', 100, 100))
    add(f)
    Object.assign(f, { visible: false })
    expect(targetAt(300, 100)).toBeUndefined()
    Object.assign(f, { visible: true, evented: false })
    expect(targetAt(300, 100)).toBeUndefined()
  })
})

describe('Shift-click inside a multi-selection', () => {
  const shift = { shiftKey: true, clientX: 0, clientY: 0 }
  const multi = (e: object, target?: unknown) =>
    (canvas as unknown as { handleMultiSelection: (e: object, t?: unknown) => boolean }).handleMultiSelection(e, target)
  const lastToggled = () => (canvas as unknown as { multiSelectionCalls: Array<{ target?: unknown }> }).multiSelectionCalls.at(-1)?.target

  function selectTwoImagesUnderLabel() {
    const f = createFrame(frame('f', 100, 100))
    // Both images are in front of the frame; the first lies under the frame's label.
    const a = createObject(image('a', 80, 20), () => el) as unknown as FakeObject
    const b = createObject(image('b', 600, 400), () => el) as unknown as FakeObject
    add(f, a, b)
    const selection = new ActiveSelection([a, b])
    ;(canvas as unknown as { setActiveObject: (o: unknown) => void }).setActiveObject(selection)
    ;(canvas as unknown as { selection: boolean }).selection = true
    return { f, a, b, selection }
  }

  it('toggles the frame whose label is under the pointer, not the selected image beneath the label', () => {
    const { f, selection } = selectTwoImagesUnderLabel()
    multi({ ...shift, clientX: 104, clientY: 100 - LABEL_GAP - 3 }, selection) // Fabric passes the selection as target
    expect(lastToggled()).toBe(f)
  })

  it('leaves Fabric alone when no frame overlay is under the pointer', () => {
    const { selection } = selectTwoImagesUnderLabel()
    multi({ ...shift, clientX: 650, clientY: 450 }, selection)
    expect(lastToggled()).toBe(selection)
  })

  it('leaves Fabric alone without the selection key, or when the active object is not a multi-selection', () => {
    const { a, selection } = selectTwoImagesUnderLabel()
    multi({ shiftKey: false, clientX: 104, clientY: 100 - LABEL_GAP - 3 }, selection)
    expect(lastToggled()).toBe(selection)
    ;(canvas as unknown as { setActiveObject: (o: unknown) => void }).setActiveObject(a)
    multi({ ...shift, clientX: 104, clientY: 100 - LABEL_GAP - 3 }, a)
    expect(lastToggled()).toBe(a)
  })
})

describe('marquee', () => {
  const collect = (left: number, top: number, width: number, height: number) => canvas.collectObjects({ left, top, width, height }).map((o) => idOf(o as never))

  it('takes a frame only when it encloses the whole frame', () => {
    add(createFrame(frame('f', 100, 100)), createObject(image('img', 150, 150), () => el))
    expect(collect(120, 120, 300, 200)).toEqual(['img']) // inside the frame: content only
    expect(collect(50, 50, 200, 200)).toEqual(['img']) // crosses the frame edge: still not the frame
    expect(collect(90, 90, 420, 320)).toEqual(['img', 'f']) // full enclosure (top to bottom)
  })

  it('a click on empty interior collects nothing', () => {
    add(createFrame(frame('f', 100, 100)))
    expect(collect(300, 250, 0, 0)).toEqual([])
  })
})

describe('drawing', () => {
  it('draws on the main context only, and nothing when there is no frame and no draft', () => {
    const calls: string[] = []
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => (typeof prop === 'string' ? (...args: unknown[]) => void calls.push(`${prop}(${args.join(',')})`) : undefined),
        set: () => true,
      },
    )
    const c = canvas as unknown as { fire: (n: string, p: unknown) => void; getContext: () => unknown; mainContext: unknown }
    c.mainContext = ctx
    c.fire('after:render', { ctx })
    expect(calls).toEqual([])

    add(createFrame(frame('f', 100, 100, 400, 300, 'Cover')))
    c.fire('after:render', { ctx: {} }) // some other context, e.g. an export
    expect(calls).toEqual([])
    c.fire('after:render', { ctx })
    expect(calls).toContain('strokeRect(100.5,100.5,400,300)')
    expect(calls.some((s) => s.startsWith('fillText(Cover,'))).toBe(true)

    calls.length = 0
    canvas.draft = { left: 10, top: 20, width: 30, height: 40 }
    setView(2, 5, 5)
    c.fire('after:render', { ctx })
    expect(calls).toContain('setLineDash(6,4)')
    expect(calls).toContain('strokeRect(25.5,45.5,60,80)') // the draft is in scene units and follows the view
    expect(calls.filter((s) => s === 'save()')).toHaveLength(1)
    expect(calls.filter((s) => s === 'restore()')).toHaveLength(1)
  })

  it('draws the rectangle of the very first frame while it is being drawn, and skips hidden frames', () => {
    const calls: string[] = []
    const ctx = new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? (...args: unknown[]) => void calls.push(`${prop}(${args.join(',')})`) : undefined), set: () => true })
    const c = canvas as unknown as { fire: (n: string, p: unknown) => void; mainContext: unknown }
    c.mainContext = ctx
    canvas.draft = { left: 10, top: 20, width: 30, height: 40 } // no frame exists yet
    c.fire('after:render', { ctx })
    expect(calls).toContain('strokeRect(10.5,20.5,30,40)')

    calls.length = 0
    canvas.draft = null
    const hidden = createFrame(frame('f', 100, 100, 400, 300, 'Hidden'))
    Object.assign(hidden, { visible: false })
    add(hidden)
    c.fire('after:render', { ctx })
    expect(calls).toEqual([])
  })

  it('snaps lines to device pixels at any pixel ratio, from both corners', () => {
    const run = (ratio: number, f: FrameRecord) => {
      const seen: { strokes: number[][]; lineWidth: number } = { strokes: [], lineWidth: 0 }
      const ctx = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === 'strokeRect' ? (...a: number[]) => void seen.strokes.push(a) : () => {}),
          set: (_t, prop, value) => {
            if (prop === 'lineWidth') seen.lineWidth = value as number
            return true
          },
        },
      )
      const fresh = new FrameCanvas(document.createElement('canvas'), { width: 800, height: 600 })
      const c = fresh as unknown as { fire: (n: string, p: unknown) => void; mainContext: unknown; retinaScaling: number; add: (o: unknown) => void }
      c.mainContext = ctx
      c.retinaScaling = ratio
      c.add(createFrame(f))
      c.fire('after:render', { ctx })
      return seen
    }
    for (const ratio of [1, 1.25, 1.5, 2, 3]) {
      const { strokes, lineWidth } = run(ratio, frame('f', 100.3, 50.7, 333.3, 222.2))
      const [x, y, w, h] = strokes[0]!
      const device = Math.max(1, Math.round(ratio))
      expect(lineWidth * ratio).toBeCloseTo(device, 9) // a whole number of device pixels wide
      const offset = (device % 2) / 2 // an odd-width line is centred on a device pixel, an even one between two
      for (const edge of [x!, y!, x! + w!, y! + h!]) {
        const devicePos = edge * ratio - offset
        expect(Math.abs(devicePos - Math.round(devicePos))).toBeLessThan(1e-9)
      }
    }
    // Both corners are snapped: the far edge is where the frame's far edge rounds to, not left + rounded width.
    const [x, , w] = run(1, frame('f', 0.4, 0, 100.4, 50)).strokes[0]!
    expect(x! + w!).toBe(101.5) // round(100.8) + 0.5; "round(0.4) + round(100.4)" would give 100.5
  })

  it('a very long stored name is cut before it is measured', () => {
    const name = 'x'.repeat(100_000)
    const fitted = fitLabel(name)
    expect(fitted.text.length).toBeLessThan(260)
    expect(fitted.text.endsWith('…')).toBe(true)
  })
})
