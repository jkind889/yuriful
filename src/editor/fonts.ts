import type { FontId } from '../model/types.ts'

/**
 * What each font choice draws with: fonts already on the machine, nothing downloaded.
 * Each chain lists fonts commonly preinstalled on Windows and on macOS and ends in a
 * generic family, so the exact typeface (and so where lines wrap) can differ between
 * machines. The board stores only the id, so a later build can back an id differently.
 */
export const FONT_STACKS: Readonly<Record<FontId, string>> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'Consolas, "Cascadia Mono", Menlo, Monaco, "Courier New", monospace',
  hand: '"Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive',
  display: 'Impact, Haettenschweiler, "Arial Black", "Franklin Gothic Bold", sans-serif',
}

/** The font choice a canvas font family belongs to; anything unknown is the default. */
export function fontIdOf(family: string): FontId {
  for (const [id, stack] of Object.entries(FONT_STACKS) as Array<[FontId, string]>) if (stack === family) return id
  return 'sans'
}
