import { describe, expect, it } from 'vitest'
import { boardAppearance, DEFAULT_BOARD_STYLE } from './appearance.ts'
import { createEmptyDoc, parseDoc, serializeDoc } from './doc.ts'

const grid = { background: '#e9f2fa', pattern: 'grid', patternColor: '#c2d6e7' } as const

describe('board appearance', () => {
  it('keeps legacy omissions and drops a default style and empty preset list', () => {
    const doc = createEmptyDoc()
    expect(serializeDoc({ ...doc, appearance: { style: DEFAULT_BOARD_STYLE, presets: [] } })).toEqual(serializeDoc(doc))
    expect(parseDoc(serializeDoc(doc))).toEqual(doc)
  })

  it('normalizes colors and names and keeps valid presets alongside invalid data', () => {
    expect(boardAppearance({
      style: { ...grid, background: 'red' },
      presets: [
        { name: ' Aurora  sky ', style: { ...grid, patternColor: '#C2D6E7' } },
        { name: 'aurora sky', style: DEFAULT_BOARD_STYLE },
        { name: 'Bad', style: { ...grid, pattern: 'stars' } },
        { name: '', style: grid },
      ],
    })).toEqual({ presets: [{ name: 'Aurora sky', style: grid }] })
    expect(boardAppearance({ style: { ...grid, pattern: 'stars' }, presets: 'bad' })).toBeUndefined()
  })

  it.each([false, true])('keeps fresh style and preset snapshots on both wire versions, framed=%s', (framed) => {
    const doc = createEmptyDoc()
    if (framed) doc.frames.push({ id: 'f1', name: 'Frame', left: 0, top: 0, width: 200, height: 100 })
    doc.appearance = { style: { ...grid }, presets: [{ name: 'Aurora', style: { ...grid } }] }
    const stored = serializeDoc(doc)
    expect(stored.version).toBe(framed ? 2 : 1)
    expect(stored.appearance).toEqual(doc.appearance)
    expect(stored.appearance?.style).not.toBe(doc.appearance.style)
    expect(stored.appearance?.presets?.[0]?.style).not.toBe(doc.appearance.presets?.[0]?.style)
    expect(parseDoc(stored)).toEqual(doc)
  })
})
