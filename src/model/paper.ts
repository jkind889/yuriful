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

/**
 * The padding (scene units) of a text of base size `fontSize` with or without paper, rounded as
 * records are (two decimals): each margin is one stored-precision number, so the Paper toggle adds
 * and takes away exactly the same amount and on then off gives back the record it started from.
 */
export function paperPad(rec: Pick<TextRecord, 'fontSize' | 'surface'>): PaperPad {
  return rec.surface === 'card' ? { x: round(rec.fontSize * PAPER_PAD_X_EM), y: round(rec.fontSize * PAPER_PAD_Y_EM) } : NO_PAD
}

/**
 * The least fixed height of a text of base size `fontSize` (scene units): one and a half font sizes,
 * rounded, so a line of body text always shows whole (a text's last line is 1.13 font sizes tall);
 * on paper, the padding above and below on top of that, so the words' own viewport has the same
 * least height either way. A stored fixed height is never below it: whatever raises it above a
 * text's height (a font size, paper turned on) raises the height with it, and a stored height below
 * it (from an older build) is drawn at it, the record left as it is (`innerText`).
 */
export function minFixedHeight(fontSize: number, surface?: 'card'): number {
  return round(Math.max(1, Math.round(fontSize * 1.5)) + 2 * paperPad({ fontSize, surface }).y)
}

/** A fixed height held to the least one for the text's size and paper (`minFixedHeight`). */
export function heldFixedHeight(height: number, fontSize: number, surface?: 'card'): number {
  return Math.max(height, minFixedHeight(fontSize, surface))
}

/**
 * The words' own box inside a text, as it is drawn: the record with its width, drawn minimum height
 * and fixed height less the padding (never below zero, a fixed height never below one), rounded as
 * records are, and a fixed height first held to `minFixedHeight`. A bare text whose height (if any)
 * is not below its least one is returned as it is. Everything that lays the words out (wrapping, the
 * words' floor, the no-wrap pieces of a drawn box, the measured height) works on this; the sheet adds
 * the padding back.
 */
export function innerText<T extends Pick<TextRecord, 'fontSize' | 'width' | 'minHeight' | 'height' | 'surface'>>(rec: T): T {
  const pad = paperPad(rec)
  const height = rec.height === undefined ? undefined : heldFixedHeight(rec.height, rec.fontSize, rec.surface)
  if (pad === NO_PAD && height === rec.height) return rec
  const out: T = { ...rec }
  if (pad !== NO_PAD) {
    out.width = Math.max(0, round(rec.width - 2 * pad.x))
    if (rec.minHeight !== undefined) out.minHeight = Math.max(0, round(rec.minHeight - 2 * pad.y))
  }
  if (height !== undefined) out.height = Math.max(1, round(height - 2 * pad.y))
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
 *
 * Every amount is worked out once as a stored-precision number (the margins, and the corner's shift
 * along the turned axes) and added or taken away as it is, so off then on, or on then off, gives back
 * the box exactly, however many times. A fixed height ends no lower than `minFixedHeight` for the
 * new surface (it only bites on a height already below the least one before the toggle).
 */
export function paperToggle(
  box: { left: number; top: number; angle: number; width: number; minHeight?: number; height?: number; fontSize: number },
  on: boolean,
): PaperToggle {
  const pad = paperPad({ fontSize: box.fontSize, surface: 'card' })
  const sign = on ? 1 : -1
  const r = (box.angle * Math.PI) / 180
  const cos = box.angle === 0 ? 1 : Math.cos(r)
  const sin = box.angle === 0 ? 0 : Math.sin(r)
  // The centre is the corner plus the turned half-size: keep it while the half-size grows by the margins.
  const shiftX = round(cos * pad.x - sin * pad.y)
  const shiftY = round(sin * pad.x + cos * pad.y)
  const out: PaperToggle = {
    left: round(box.left - sign * shiftX),
    top: round(box.top - sign * shiftY),
    width: roundPositive(Math.max(1, box.width + sign * 2 * pad.x)),
  }
  if (box.minHeight !== undefined) out.minHeight = round(Math.max(0, box.minHeight + sign * 2 * pad.y))
  if (box.height !== undefined) out.height = heldFixedHeight(roundPositive(Math.max(1, box.height + sign * 2 * pad.y)), box.fontSize, on ? 'card' : undefined)
  return out
}
