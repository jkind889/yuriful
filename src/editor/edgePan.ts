import type { Transform } from 'fabric'
import type { Point } from '../model/viewport.ts'
import type { FrameCanvas } from './FrameCanvas.ts'

const EDGE = 40
const FAST = 18
const REDUCED = 6

/** Screen-pixel pan toward the closest edges. Diagonal movement keeps the same speed cap. */
function edgeDelta(rect: DOMRect, pointer: MouseEvent, reduced: boolean): Point {
  const speedAt = (distance: number) => {
    if (distance > EDGE) return 0
    if (reduced) return REDUCED
    return 1 + (FAST - 1) * Math.min(1, (EDGE - distance) / EDGE)
  }
  const x = speedAt(pointer.clientX - rect.left) - speedAt(rect.right - pointer.clientX)
  const y = speedAt(pointer.clientY - rect.top) - speedAt(rect.bottom - pointer.clientY)
  const length = Math.hypot(x, y)
  if (length === 0) return { x: 0, y: 0 }
  const speed = Math.max(Math.abs(x), Math.abs(y))
  return { x: x * speed / length, y: y * speed / length }
}

/** Keeps the pointer of a performed primary move and runs edge pan when enabled. */
export class EdgePan {
  private transform: Transform | null = null
  private pointer: MouseEvent | null = null
  private frame: number | null = null
  private replayed = false
  private motion: MediaQueryList | undefined

  constructor(
    private readonly canvas: FrameCanvas,
    private readonly host: HTMLElement,
    private readonly panBy: (dx: number, dy: number) => void,
  ) {}

  start(transform: Transform) {
    this.stop()
    this.transform = transform
  }

  update(event: Event, edgePanEnabled: boolean) {
    if (!this.transform?.actionPerformed || !(event instanceof MouseEvent) || !(event.buttons & 1)) return
    this.pointer = event
    if (edgePanEnabled && document.visibilityState !== 'hidden' && this.delta(event)) {
      this.frame ??= requestAnimationFrame(this.step)
    } else this.pause()
  }

  /** Called after the viewport changes, whether or not edge pan is enabled. */
  replay() {
    const { pointer, transform } = this
    if (!pointer || !transform || transform !== this.canvas._currentTransform) return
    this.replayed = true
    // Rebuild Fabric's CSS-to-scene cache at the new view. Replaying the same drag
    // retains its grab offset and lets object:moving place the followers.
    this.canvas._cacheTransformEventData(pointer)
    try {
      this.canvas._transformObject(pointer)
    } finally {
      this.canvas._resetTransformEventData()
    }
  }

  stop(release?: MouseEvent) {
    const finish = this.replayed && this.transform !== null && this.transform === this.canvas._currentTransform
    this.pause()
    this.transform = null
    this.pointer = null
    this.replayed = false
    // Fabric has cached the release's pointer at the current viewport but has not finalized
    // the transform yet. Include a last pointer or zoom change in the ordinary settlement.
    if (finish && release) this.canvas._transformObject(release)
  }

  pause() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }

  private delta(event: MouseEvent) {
    this.motion ??= window.matchMedia('(prefers-reduced-motion: reduce)')
    const { x, y } = edgeDelta(this.host.getBoundingClientRect(), event, this.motion.matches)
    return x || y ? { x, y } : null
  }

  private step = () => {
    this.frame = null
    if (document.visibilityState === 'hidden') return
    const { pointer, transform } = this
    if (!pointer || !transform || transform !== this.canvas._currentTransform) {
      this.stop()
      return
    }
    const delta = this.delta(pointer)
    if (!delta) return
    // Schedule first so a pause during the viewport update can cancel the next step.
    this.frame = requestAnimationFrame(this.step)
    this.panBy(delta.x, delta.y)
  }
}
