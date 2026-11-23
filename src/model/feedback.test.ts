import { describe, expect, it } from 'vitest'
import { captionWillDetach, previewOwnership } from './feedback.ts'
import { ownerAfterManipulation } from './frames.ts'
import type { FrameRecord, ImageRecord, Scene } from './types.ts'

const frame = (id: string, left: number): FrameRecord => ({ id, name: id, left, top: 0, width: 100, height: 100 })
const back = frame('back', 0)
const front = frame('front', 50)
const frames = [back, front]
const image = (id: string, frameId?: string): ImageRecord => ({ id, type: 'image', assetId: 'asset', left: 20, top: 20, angle: 0, scaleX: 1, scaleY: 1, ...(frameId && { frameId }) })
const none = new Set<string>()

describe('ownership feedback', () => {
  it('agrees with the settled rule across a seeded sweep, sticky owners and co-transformed frames', () => {
    let seed = 291
    const coordinate = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 201) - 25
    for (const owner of [undefined, 'back', 'front']) {
      const before: Scene = { frames, objects: [image('moved', owner), image('stationary')] }
      for (const co of [none, new Set(['back']), new Set(['front']), new Set(['front', 'back'])]) {
        for (let i = 0; i < 200; i++) {
          const centre = { x: coordinate(), y: coordinate() }
          const next = ownerAfterManipulation(owner, centre, frames, co)
          const preview = previewOwnership(before, new Map([['moved', centre]]), frames, co)
          expect(preview.gaining).toEqual(next !== owner && next !== undefined ? [next] : [])
          expect(preview.losing).toEqual(next !== owner && owner !== undefined ? [owner] : [])
        }
      }
    }
  })

  it('shows a transfer, keeps a sticky owner and leaves untransformed loose content alone', () => {
    const before = { frames, objects: [image('moving', 'back'), image('sticky', 'back'), image('loose')] }
    const positions = new Map([['moving', { x: 130, y: 70 }], ['sticky', { x: 75, y: 40 }]])
    expect(previewOwnership(before, positions, frames, none)).toEqual({ gaining: ['front'], losing: ['back'] })
    expect(previewOwnership(before, positions, frames, new Set(['back']))).toEqual({ gaining: [], losing: [] })
  })

  it('previews the release of a stationary member from a resized frame without transferring it', () => {
    const before = { frames, objects: [image('member', 'back'), image('loose')] }
    const resized = [{ ...back, width: 60 }, front]
    const centres = new Map([['member', { x: 80, y: 50 }], ['loose', { x: 35, y: 25 }]])
    expect(previewOwnership(before, new Map(), resized, new Set(['back']), centres)).toEqual({ gaining: [], losing: ['back'] })
    expect(previewOwnership(before, centres, resized, new Set(['back']))).toEqual({ gaining: [], losing: [] })
  })

  it('uses the image outcome while a caption stays attached and the text centre after detachment', () => {
    const caption = { type: 'text' as const, id: 'caption', captionOf: 'picture', frameId: back.id, text: 'Caption', width: 80, fontSize: 20, left: 90, top: 60, angle: 0 }
    const before = { frames, objects: [image('picture', back.id), caption] }
    const centres = new Map([['picture', { x: 40, y: 50 }], ['caption', { x: 115, y: 60 }]])
    expect(previewOwnership(before, centres, frames, none)).toEqual({ gaining: [], losing: [] })
    const detached = new Set(['caption'])
    expect(previewOwnership(before, centres, frames, none, new Map(), detached)).toEqual({ gaining: [front.id], losing: [back.id] })
    expect(previewOwnership(before, new Map([['caption', centres.get('caption')!]]), frames, none, new Map(), detached)).toEqual({ gaining: [front.id], losing: [back.id] })
    expect(previewOwnership(before, new Map(), [{ ...back, width: 70 }, front], new Set([back.id]), centres)).toEqual({ gaining: [], losing: [] })
    expect(captionWillDetach(caption, caption, detached)).toBe(false)
    expect(captionWillDetach(caption, { ...caption, left: 110 }, detached)).toBe(true)
    expect(captionWillDetach(caption, { ...caption, left: 110 }, new Set(['caption', 'picture']))).toBe(false)
    expect(captionWillDetach(caption, { ...caption, angle: 15 }, new Set(['caption', 'picture']))).toBe(true)
  })
})
