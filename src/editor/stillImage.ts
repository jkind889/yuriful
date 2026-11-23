/**
 * A still of an image that can animate: its first frame, as a PNG. The canvas draws every image
 * still today (an animated GIF shows its first frame), while an `<img>` in the DOM scene layer
 * would play it; whether references should animate is a product decision not yet made, so the
 * layer shows this still instead (`SceneLayerOptions.getStill`). Nothing in the app uses it yet.
 *
 * Only formats that can hold an animation are considered (GIF, PNG, WebP, AVIF). Where the
 * browser has `ImageDecoder`, an image is re-encoded only when it really has more than one
 * frame, so a static PNG or WebP is left alone; without it, only a GIF is (drawn from its
 * decoded element). A photo (JPEG and the rest) is never re-encoded.
 */

/** The image types that can hold an animation. */
const CAN_ANIMATE = new Set(['image/gif', 'image/png', 'image/apng', 'image/webp', 'image/avif'])

export const canAnimate = (type: string): boolean => CAN_ANIMATE.has(type.toLowerCase())

/** A canvas drawing as a PNG blob. */
function pngOf(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

/** The first frame through `ImageDecoder`, or null when the image has a single frame. Undefined when the decoder cannot read it. */
async function firstFrameDecoded(bytes: Blob | ArrayBuffer, type: string, doc: Document): Promise<Blob | null | undefined> {
  if (typeof ImageDecoder === 'undefined') return undefined
  try {
    if (!(await ImageDecoder.isTypeSupported(type))) return undefined
  } catch {
    return undefined
  }
  const data = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes
  const decoder = new ImageDecoder({ data, type })
  try {
    // The tracks are known once tracks.ready settles, every frame once completed does.
    await decoder.tracks.ready
    await decoder.completed
    const track = decoder.tracks.selectedTrack
    // One frame is a still image, even when the file says it may animate (a GIF with a frame delay does).
    if (!track || track.frameCount <= 1) return null
    const { image } = await decoder.decode({ frameIndex: 0 })
    try {
      const canvas = doc.createElement('canvas')
      canvas.width = image.displayWidth
      canvas.height = image.displayHeight
      canvas.getContext('2d')?.drawImage(image, 0, 0)
      return await pngOf(canvas)
    } finally {
      image.close()
    }
  } catch {
    return undefined
  } finally {
    decoder.close()
  }
}

/**
 * The first frame of an image that animates, as a PNG blob; null for one that cannot or does not
 * animate (show the original). `element` is the image already decoded from the same bytes, used
 * for a GIF where `ImageDecoder` is not available.
 */
export async function stillFrame(asset: { bytes: Blob | ArrayBuffer; type: string }, element: HTMLImageElement, doc: Document = document): Promise<Blob | null> {
  if (!canAnimate(asset.type)) return null
  const decoded = await firstFrameDecoded(asset.bytes, asset.type, doc)
  if (decoded !== undefined) return decoded
  if (asset.type.toLowerCase() !== 'image/gif') return null
  // No decoder: a freshly decoded GIF element draws its first frame.
  const width = element.naturalWidth
  const height = element.naturalHeight
  if (!(width > 0 && height > 0)) return null
  const canvas = doc.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.drawImage(element, 0, 0)
  return pngOf(canvas)
}
