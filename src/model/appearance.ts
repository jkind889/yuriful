export type BoardPattern = 'dots' | 'grid' | 'none'

export interface BoardStyle {
  background: string
  pattern: BoardPattern
  patternColor: string
}

export interface AppearancePreset {
  name: string
  style: BoardStyle
}

/** Omitted fields use the built-in style and an empty custom preset list. */
export interface BoardAppearance {
  style?: BoardStyle
  presets?: readonly AppearancePreset[]
}

export const DEFAULT_BOARD_STYLE: Readonly<BoardStyle> = Object.freeze({
  background: '#f1f3f8',
  pattern: 'dots',
  patternColor: '#c8cddb',
})

export const BUILTIN_APPEARANCES: readonly AppearancePreset[] = [
  { name: 'Default dots', style: DEFAULT_BOARD_STYLE },
  { name: 'Warm paper', style: { background: '#f3e9d6', pattern: 'none', patternColor: '#cdbda0' } },
  { name: 'Blue grid', style: { background: '#e9f2fa', pattern: 'grid', patternColor: '#c2d6e7' } },
]

const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw)
const isColor = (raw: unknown): raw is string => typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw)

export function boardStyle(raw: unknown): BoardStyle | undefined {
  if (!isRecord(raw)) return
  const { background, pattern, patternColor } = raw
  if (!isColor(background) || !isColor(patternColor) || (pattern !== 'dots' && pattern !== 'grid' && pattern !== 'none')) return
  return { background: background.toLowerCase(), pattern, patternColor: patternColor.toLowerCase() }
}

export function sameBoardStyle(a: BoardStyle, b: BoardStyle): boolean {
  return a.background === b.background && a.pattern === b.pattern && a.patternColor === b.patternColor
}

export function normalizePresetName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 40).trimEnd()
}

/** One storage path for both versions. Invalid style and preset data is ignored independently. */
export function boardAppearance(raw: unknown): BoardAppearance | undefined {
  if (!isRecord(raw)) return
  const style = boardStyle(raw.style)
  const presets: AppearancePreset[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.presets)) {
    for (const item of raw.presets) {
      if (!isRecord(item) || typeof item.name !== 'string') continue
      const name = normalizePresetName(item.name)
      const presetStyle = boardStyle(item.style)
      const key = name.toLowerCase()
      if (!name || !presetStyle || seen.has(key)) continue
      seen.add(key)
      presets.push({ name, style: presetStyle })
    }
  }
  const custom = style && !sameBoardStyle(style, DEFAULT_BOARD_STYLE)
  if (!custom && presets.length === 0) return
  return { ...(custom && { style }), ...(presets.length > 0 && { presets }) }
}
