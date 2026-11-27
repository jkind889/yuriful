import { expect, it } from 'vitest'
import { fitBoardMap, mapViewportRect } from './boardMap.ts'
import { collectFrameDestinations } from './frameDestinations.ts'
import { frameTourPath } from './frameTour.ts'
import type { Scene } from './types.ts'

const viewport = { zoom: 0.8, panX: 20, panY: -10 }
const canvas = { width: 640, height: 480 }
const bounds = { left: 0, top: 0, right: canvas.width, bottom: canvas.height }
const scene: Scene = {
  frames: [
    { id: 'late', name: 'Late', left: 20, top: 400, width: 140, height: 120 },
    { id: 'remote', name: 'Remote', left: 1500, top: 0, width: 120, height: 120, locked: true },
    { id: 'early', name: 'Early', left: 200, top: 20, width: 180, height: 100 },
  ],
  objects: [{ id: 'note', type: 'text', text: 'Paper', left: 210, top: 40, angle: 0, width: 100, fontSize: 14, frameId: 'early' }],
}

it('takes visible frames in reading order or the explicit frame selection', () => {
  const destinations = collectFrameDestinations(scene)
  expect(destinations.find(({ id }) => id === 'early')?.itemCount).toBe(1)
  expect(frameTourPath(destinations, new Set(), viewport, bounds).map(({ id }) => id)).toEqual(['early', 'late'])
  expect(frameTourPath(destinations, new Set(['remote']), viewport, bounds).map(({ id }) => id)).toEqual(['remote'])
})

it('updates the board map viewport as the editor view moves off the map', () => {
  const map = fitBoardMap(collectFrameDestinations(scene))!
  expect(mapViewportRect(viewport, canvas, map)).not.toBeNull()
  expect(mapViewportRect({ ...viewport, panX: -8000, panY: -8000 }, canvas, map)).toBeNull()
  expect(fitBoardMap([])).toBeNull()
})
