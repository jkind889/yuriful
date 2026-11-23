export interface CanvasPrefs {
  readonly feedback: boolean
  readonly captionSnap: boolean
}

export const DEFAULT_PREFS: CanvasPrefs = Object.freeze({ feedback: true, captionSnap: true })

/** Invalid fields fall back independently so a usable preference can still be read. */
export function parsePrefs(value: unknown): CanvasPrefs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_PREFS
  const { feedback, captionSnap } = value as Partial<CanvasPrefs>
  return Object.freeze({
    feedback: typeof feedback === 'boolean' ? feedback : DEFAULT_PREFS.feedback,
    captionSnap: typeof captionSnap === 'boolean' ? captionSnap : DEFAULT_PREFS.captionSnap,
  })
}

export function serializePrefs(prefs: CanvasPrefs): string {
  return JSON.stringify({ feedback: prefs.feedback, captionSnap: prefs.captionSnap })
}
