import { StaticCanvas } from 'fabric'
import type { Scene } from '../model/types.ts'
import { createObject, FRAME_FILL } from './objects.ts'

/** Draw the frame's visible composition in a detached bitmap. The bitmap clips at its edges. */
export async function renderFramePreview(
  scene: Scene,
  frameId: string,
  getImage: (id: string) => HTMLImageElement | undefined,
): Promise<string> {
  const frame = scene.frames.find(({ id }) => id === frameId)
  if (!frame) throw new Error('The tour frame is unavailable.')
  const scale = Math.min(2, 1600 / Math.max(frame.width, frame.height))
  const width = Math.max(1, Math.round(frame.width * scale))
  const height = Math.max(1, Math.round(frame.height * scale))
  const scaleX = width / frame.width
  const scaleY = height / frame.height
  const panX = -frame.left * scaleX
  const panY = -frame.top * scaleY
  if (![scaleX, scaleY, panX, panY].every(Number.isFinite)) throw new Error('The frame cannot be rendered at this size.')

  const element = document.createElement('canvas')
  const canvas = new StaticCanvas(element, {
    width, height, backgroundColor: FRAME_FILL, backgroundVpt: false,
    enableRetinaScaling: false, renderOnAddRemove: false,
  })
  try {
    canvas.setViewportTransform([scaleX, 0, 0, scaleY, panX, panY])
    for (const record of scene.objects) {
      const object = createObject(record, getImage)
      if (!object) {
        if (record.type === 'image') continue // Read-only boards may have missing image bytes.
        throw new Error('The frame could not be rendered.')
      }
      canvas.add(object)
    }
    canvas.renderAll()
    return element.toDataURL('image/png')
  } finally {
    await canvas.dispose()
  }
}
