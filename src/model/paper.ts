import { round, roundPositive } from './doc.ts'
import type { TextRecord } from './types.ts'

/**
 * Paper (Slice 5, plan Section 6, Owner Decision 10): a text with `surface: 'card'` sits on a sheet
 * with padding around its words. Only the flag is stored; the sheet's look is CSS (`--paper-*` in
 * `src/styles.css`), and its padding is these two numbers, in em of the text's base font size, so
 * a corner scale (which folds into the font size) scales the padding with the text and no field
 * holds it. The box is the paper: `width`, `minHeight` and `height` are the sheet's outer size, and
 * the words wrap inside it, `2 × padX` narrower.
 *
 * Frozen once this ships: changing either number re-wraps every paper text ever saved.
 */
export const PAPER_PAD_X_EM = 1
export const PAPER_PAD_Y_EM = 0.75

export interface PaperPad {
  x: number
  y: number
}

const NO_PAD: PaperPad = { x: 0, y: 0 }

/** The padding (scene units) of a text of base size `fontSize` with or without paper. */
export function paperPad(rec: Pick<TextRecord, 'fontSize' | 'surface'>): PaperPad {
  return rec.surface === 'card' ? { x: rec.fontSize * PAPER_PAD_X_EM, y: rec.fontSize * PAPER_PAD_Y_EM } : NO_PAD
}

/**
 * The words' own box inside a paper text: the record with its width, drawn minimum height and fixed
 * height less the padding (never below zero, a fixed height never below one). A text without paper
 * is returned as it is. Everything that lays the words out (wrapping, the words' floor, the no-wrap
 * pieces of a drawn box, the measured height) works on this; the sheet adds the padding back.
 */
export function innerText<T extends Pick<TextRecord, 'fontSize' | 'width' | 'minHeight' | 'height' | 'surface'>>(rec: T): T {
  const pad = paperPad(rec)
  if (pad === NO_PAD) return rec
  const out: T = { ...rec, width: Math.max(0, rec.width - 2 * pad.x) }
  if (rec.minHeight !== undefined) out.minHeight = Math.max(0, rec.minHeight - 2 * pad.y)
  if (rec.height !== undefined) out.height = Math.max(1, rec.height - 2 * pad.y)
  return out
}

/** What a box's place and size become when its paper is turned on or off (`setTextSurface`). */
export interface PaperToggle {
  left: number
  top: number
  width: number
  minHeight?: number
  height?: number
}

/**
 * The paper toggle, as a pure transform: turning paper on keeps the box's centre and grows it by the
 * padding on every side (`width` by `2 × padX`; a drawn `minHeight` and a fixed `height`, when
 * present, by `2 × padY`); turning it off shrinks it by the same. The words keep their own box, so
 * they do not move or re-wrap. The box's height (fixed, or the height its words give it) changes by
 * `2 × padY` too, so its centre stays where it was; `angle` turns the box about its top-left corner,
 * as records do, so the corner moves along the turned axes.
 */
export function paperToggle(
  box: { left: number; top: number; angle: number; width: number; minHeight?: number; height?: number; fontSize: number },
  on: boolean,
): PaperToggle {
  const pad = paperPad({ fontSize: box.fontSize, surface: 'card' })
  const sign = on ? 1 : -1
  const dw = sign * 2 * pad.x
  const dh = sign * 2 * pad.y
  const r = (box.angle * Math.PI) / 180
  const cos = box.angle === 0 ? 1 : Math.cos(r)
  const sin = box.angle === 0 ? 0 : Math.sin(r)
  // The centre is the corner plus the turned half-size: keep it while the half-size changes by (dw/2, dh/2).
  const out: PaperToggle = {
    left: round(box.left - (cos * dw) / 2 + (sin * dh) / 2),
    top: round(box.top - (sin * dw) / 2 - (cos * dh) / 2),
    width: roundPositive(Math.max(1, box.width + dw)),
  }
  if (box.minHeight !== undefined) out.minHeight = round(Math.max(0, box.minHeight + dh))
  if (box.height !== undefined) out.height = roundPositive(Math.max(1, box.height + dh))
  return out
}
