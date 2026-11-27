import { describe, expect, it } from 'vitest'
import {
  FRAME_HIT_TOLERANCE,
  LABEL_GAP,
  LABEL_HEIGHT,
  LABEL_MAX_TEXT_WIDTH,
  LABEL_PAD_X,
  MIN_FRAME_SIZE,
  allowedScaleFactor,
  containsPoint,
  labelBox,
  membersToRelease,
  minFrameSide,
  nearOutline,
  nextFrameName,
  overlayHit,
  ownerAfterManipulation,
  rectFromDrag,
} from './frames.ts'
import type { Box } from './frames.ts'
import type { FrameRecord, Viewport } from './types.ts'

const frame = (id: string, left: number, top: number, width = 100, height = 100): FrameRecord => ({ id, name: id, left, top, width, height })
// Back to front: A, then B overlapping A's right half, then C far away.
const A = frame('A', 0, 0, 200, 200)
const B = frame('B', 100, 0, 200, 200)
const C = frame('C', 1000, 1000)
const frames = [A, B, C]
const none = new Set<string>()
const ids = (...list: string[]) => new Set(list)

describe('ownerAfterManipulation (O1)', () => {
  it('joins the front-most containing frame when unowned', () => {
    expect(ownerAfterManipulation(undefined, { x: 50, y: 50 }, frames, none)).toBe('A')
    expect(ownerAfterManipulation(undefined, { x: 150, y: 50 }, frames, none)).toBe('B') // overlap: B is in front
    expect(ownerAfterManipulation(undefined, { x: 250, y: 50 }, frames, none)).toBe('B')
  })

  it('is loose when outside every frame', () => {
    expect(ownerAfterManipulation(undefined, { x: 500, y: 500 }, frames, none)).toBeUndefined()
    expect(ownerAfterManipulation('A', { x: 500, y: 500 }, frames, none)).toBeUndefined()
  })

  it('keeps a containing owner even when another frame is in front (sticky)', () => {
    expect(ownerAfterManipulation('A', { x: 150, y: 50 }, frames, none)).toBe('A')
    expect(ownerAfterManipulation('A', { x: 150, y: 50 }, [B, A, C], none)).toBe('A') // whatever the z-order
  })

  it('moves to another frame once it leaves its owner', () => {
    expect(ownerAfterManipulation('A', { x: 250, y: 50 }, frames, none)).toBe('B')
    expect(ownerAfterManipulation('B', { x: 50, y: 50 }, frames, none)).toBe('A')
  })

  it('step 1: keeps a co-transformed owner without any containment test', () => {
    expect(ownerAfterManipulation('A', { x: 5000, y: 5000 }, frames, ids('A'))).toBe('A')
    expect(ownerAfterManipulation('A', { x: 250, y: 50 }, frames, ids('A'))).toBe('A') // even though B contains it
    expect(ownerAfterManipulation('A', { x: 50, y: 50 }, frames, ids('A', 'B', 'C'))).toBe('A')
  })

  it('step 3: a co-transformed frame is never chosen for a loose object', () => {
    expect(ownerAfterManipulation(undefined, { x: 50, y: 50 }, frames, ids('A'))).toBeUndefined()
    expect(ownerAfterManipulation(undefined, { x: 150, y: 50 }, frames, ids('B'))).toBe('A') // falls through to the unselected one
    expect(ownerAfterManipulation(undefined, { x: 150, y: 50 }, frames, ids('A', 'B'))).toBeUndefined()
  })

  it('step 3: nor for an object that left a non-transformed owner', () => {
    // Owned by C (stationary), now centred in A's exclusive area while A was co-transformed.
    expect(ownerAfterManipulation('C', { x: 50, y: 50 }, frames, ids('A'))).toBeUndefined()
    // In the A/B overlap with A co-transformed: only B is a candidate.
    expect(ownerAfterManipulation('C', { x: 150, y: 50 }, frames, ids('A'))).toBe('B')
  })

  it('step 2: an owner that was not transformed and still contains it wins over co-transformed frames', () => {
    expect(ownerAfterManipulation('B', { x: 150, y: 50 }, frames, ids('A'))).toBe('B')
  })

  it('treats an owner that no longer exists as no owner', () => {
    expect(ownerAfterManipulation('gone', { x: 50, y: 50 }, frames, none)).toBe('A')
    expect(ownerAfterManipulation('gone', { x: 50, y: 50 }, frames, ids('gone'))).toBe('A')
    expect(ownerAfterManipulation('gone', { x: 900, y: 50 }, frames, none)).toBeUndefined()
  })

  it('counts the frame edge as inside', () => {
    expect(containsPoint(A, { x: 200, y: 200 })).toBe(true)
    expect(containsPoint(A, { x: 200.01, y: 200 })).toBe(false)
  })
})

describe('membersToRelease (O3)', () => {
  const members = [
    { id: 'in', centre: { x: 10, y: 10 } },
    { id: 'edge', centre: { x: 50, y: 50 } },
    { id: 'out', centre: { x: 60, y: 10 } },
    { id: 'below', centre: { x: 10, y: 51 } },
  ]

  it('returns only the members whose centre left the frame', () => {
    expect(membersToRelease({ left: 0, top: 0, width: 50, height: 50 }, members)).toEqual(['out', 'below'])
    expect(membersToRelease({ left: 0, top: 0, width: 500, height: 500 }, members)).toEqual([])
    expect(membersToRelease({ left: 0, top: 0, width: 50, height: 50 }, [])).toEqual([])
  })

  it('only names ids to release: it never reassigns, reorders or mutates anything', () => {
    const before = JSON.stringify(members)
    const out = membersToRelease({ left: 100, top: 100, width: 10, height: 10 }, members)
    expect(out).toEqual(['in', 'edge', 'out', 'below']) // even those another frame might contain
    expect(JSON.stringify(members)).toBe(before)
  })
})

describe('allowedScaleFactor', () => {
  const text = (fontSize: number) => ({ fontSize })
  const box = (width: number, height: number) => ({ width, height })

  it('passes any factor through when only images are involved', () => {
    expect(allowedScaleFactor(0.001, [], [])).toBe(0.001)
    expect(allowedScaleFactor(250, [], [])).toBe(250)
  })

  it('limits enlargement and reduction of text from its pre-gesture font size', () => {
    expect(allowedScaleFactor(2, [], [text(300)])).toBeCloseTo(400 / 300, 12)
    expect(allowedScaleFactor(1.2, [], [text(300)])).toBe(1.2)
    expect(allowedScaleFactor(0.1, [], [text(24)])).toBeCloseTo(6 / 24, 12)
    expect(allowedScaleFactor(0.5, [], [text(24)])).toBe(0.5)
  })

  it('limits reduction of a frame by its smaller side', () => {
    expect(allowedScaleFactor(0.5, [box(30, 300)], [])).toBeCloseTo(24 / 30, 12)
    expect(allowedScaleFactor(0.5, [box(300, 30)], [])).toBeCloseTo(24 / 30, 12)
    expect(allowedScaleFactor(0.5, [box(480, 640)], [])).toBe(0.5)
    expect(allowedScaleFactor(40, [box(30, 300)], [])).toBe(40) // frames have no upper limit
  })

  it('combines several members to the tightest limit', () => {
    expect(allowedScaleFactor(3, [box(100, 100)], [text(100), text(300), text(200)])).toBeCloseTo(400 / 300, 12)
    expect(allowedScaleFactor(0.01, [box(48, 48), box(240, 240)], [text(60)])).toBeCloseTo(0.5, 12) // frame 48 -> 24 beats font 60 -> 6
  })

  it('an out-of-range text may move toward the range but not further out, and is never snapped', () => {
    expect(allowedScaleFactor(0.95, [], [text(500)])).toBe(0.95)
    expect(allowedScaleFactor(1.2, [], [text(500)])).toBe(1)
    expect(allowedScaleFactor(2, [], [text(3)])).toBe(2)
    expect(allowedScaleFactor(0.5, [], [text(3)])).toBe(1)
  })

  it('a sub-minimum frame may grow but not shrink, and is never snapped', () => {
    expect(allowedScaleFactor(1.5, [box(10, 200)], [])).toBe(1.5)
    expect(allowedScaleFactor(0.5, [box(10, 200)], [])).toBe(1)
  })

  it('a 300px text with a 500px text allows no enlargement', () => {
    expect(allowedScaleFactor(1.2, [], [text(300), text(500)])).toBe(1)
    expect(allowedScaleFactor(0.9, [], [text(300), text(500)])).toBe(0.9)
  })

  it('never returns an unusable factor', () => {
    expect(allowedScaleFactor(Number.NaN, [box(100, 100)], [text(20)])).toBe(1)
    expect(allowedScaleFactor(0, [], [])).toBe(1)
    expect(allowedScaleFactor(-2, [], [])).toBe(1)
    expect(allowedScaleFactor(Number.POSITIVE_INFINITY, [], [])).toBe(1)
  })

  it('per-axis minimum for a frame resized alone starts from its own size', () => {
    expect(minFrameSide(300)).toBe(MIN_FRAME_SIZE)
    expect(minFrameSide(24)).toBe(24)
    expect(minFrameSide(10)).toBe(10)
  })
})

describe('frame overlay geometry', () => {
  /** What frameOverlay does for an unrotated frame: scene rect -> screen rect. */
  const toScreen = (f: FrameRecord, vp: Viewport): Box => ({
    left: f.left * vp.zoom + vp.panX,
    top: f.top * vp.zoom + vp.panY,
    width: f.width * vp.zoom,
    height: f.height * vp.zoom,
  })
  const viewports: Viewport[] = [
    { zoom: 1, panX: 0, panY: 0 },
    { zoom: 0.25, panX: 310, panY: -40 },
    { zoom: 3.5, panX: -900, panY: 120 },
  ]
  const f = frame('F', 100, 200, 400, 300)

  it('hits the label and the outline band, and misses the interior, at any pan and zoom', () => {
    for (const vp of viewports) {
      const outline = toScreen(f, vp)
      const label = labelBox(outline, 60)
      const hit = (x: number, y: number) => overlayHit({ x, y }, outline, label)
      const right = outline.left + outline.width
      const bottom = outline.top + outline.height
      const midX = outline.left + outline.width / 2
      const midY = outline.top + outline.height / 2

      expect(hit(label.left + 3, label.top + 3)).toBe(true) // label
      expect(hit(label.left + label.width - 1, label.top + label.height - 1)).toBe(true)
      expect(hit(label.left + label.width + 8, label.top + 3)).toBe(false) // beside the label

      expect(hit(midX, outline.top)).toBe(true) // each edge
      expect(hit(midX, bottom)).toBe(true)
      expect(hit(outline.left, midY)).toBe(true)
      expect(hit(right, midY)).toBe(true)
      expect(hit(right + FRAME_HIT_TOLERANCE, midY)).toBe(true) // band is in screen pixels, both sides
      expect(hit(right - FRAME_HIT_TOLERANCE, midY)).toBe(true)
      expect(hit(right + FRAME_HIT_TOLERANCE + 1, midY)).toBe(false)
      expect(hit(right - FRAME_HIT_TOLERANCE - 1, midY)).toBe(false)

      expect(hit(midX, midY)).toBe(false) // interior is click-through
      expect(hit(outline.left + 20, outline.top + 20)).toBe(false)
      expect(hit(outline.left - 40, midY)).toBe(false) // well outside
    }
  })

  it('places the label above the top-left corner with a fixed screen size', () => {
    const outline = { left: 50, top: 80, width: 10, height: 10 }
    expect(labelBox(outline, 40)).toEqual({ left: 50, top: 80 - LABEL_GAP - LABEL_HEIGHT, width: 40 + LABEL_PAD_X * 2, height: LABEL_HEIGHT })
    expect(labelBox(outline, 9999).width).toBe(LABEL_MAX_TEXT_WIDTH + LABEL_PAD_X * 2) // long names are capped
  })

  it('a frame smaller than the band is all outline', () => {
    const tiny = { left: 0, top: 0, width: 8, height: 8 }
    expect(nearOutline({ x: 4, y: 4 }, tiny)).toBe(true)
  })
})

describe('rectFromDrag', () => {
  it('normalizes a drag in any direction', () => {
    const expected = { left: 10, top: 20, width: 30, height: 40 }
    expect(rectFromDrag({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected)
    expect(rectFromDrag({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected)
    expect(rectFromDrag({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected)
    expect(rectFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ left: 5, top: 5, width: 0, height: 0 })
  })
})

describe('nextFrameName', () => {
  it('numbers frames one past the highest used number', () => {
    expect(nextFrameName([])).toBe('Frame 1')
    expect(nextFrameName(['Frame 1', 'Frame 2'])).toBe('Frame 3')
    expect(nextFrameName(['Frame 7', 'Cover', 'Frame 2'])).toBe('Frame 8')
    expect(nextFrameName(['Cover', 'Frame', 'Frame 2b', 'My Frame 9'])).toBe('Frame 1')
  })

  it('ignores absurdly large numbers instead of producing a repeated or exponent name', () => {
    expect(nextFrameName(['Frame 99999999999999999999', 'Frame 4'])).toBe('Frame 5')
    expect(nextFrameName(['Frame 999999999'])).toBe('Frame 1000000000')
    expect(nextFrameName(['Frame 999999999', 'Frame 1000000000'])).toBe('Frame 1000000001') // its own output still counts
  })
})
