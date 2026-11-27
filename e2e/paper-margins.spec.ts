/**
 * The margin-press rule of a paper text (Slice 5), tested as a rule: seeded random paper texts of
 * every kind of line, at random zoom, angle, alignment, size and scroll; for every press beside the
 * words the expected caret is worked out here, independently of the code under test, from the
 * characters as the browser laid them out (their rectangles, taken back into the card's own
 * coordinates from the record and the view); one character is typed, and the stored text compared.
 *
 * The rule: the candidates are the visual rows (each wrapped row; each row of a code block; an
 * empty line; never a divider); only rows at least half shown in the words' viewport count; the
 * row whose height holds the press is taken, else the nearest shown one above or below; a press
 * left of its characters puts the caret before its first character, right of them after its last
 * (before the wrap, for a row that wraps), in reading order. Set PAPER_SEED to replay a run.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { editedText, openApp, openBlank, seedRaw, storedDoc } from './helpers.ts'
import type { View } from './helpers.ts'

test.use({ storageState: { cookies: [], origins: [] } })

declare global {
  interface Window {
    __margins: { viewport: () => View; setView: (view: View) => void; height: (id: string) => number; width: (id: string) => number; editing: () => boolean }
  }
}

async function open(page: Page, rec: Record<string, unknown>, view: View) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedRaw(page, 3, { version: 3, title: 'Margins', frames: [], objects: [rec], viewport: view })
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    let response
    for (let i = 0; ; i++) {
      try {
        response = await route.fetch()
        break
      } catch (e) {
        if (i >= 2) throw e
      }
    }
    const source = await response.text()
    await route.fulfill({
      response,
      body: `
      import { Editor as MarginEditor } from '/src/editor/Editor.ts'
      import { idOf as marginIdOf } from '/src/editor/objects.ts'
      const marginInit = MarginEditor.prototype.init
      MarginEditor.prototype.init = function () {
        const ed = this
        window.__margins = {
          viewport: () => ed.getViewport(),
          setView: (v) => ed.setViewport(v, false),
          height: (id) => ed.canvas.getObjects().find((o) => marginIdOf(o) === id).height,
          width: (id) => ed.canvas.getObjects().find((o) => marginIdOf(o) === id).width,
          editing: () => ed.getState().editingText,
        }
        return marginInit.call(this)
      }
      ${source}
    `,
    })
  })
  await openApp(page)
  return errors
}

// ---- a seeded random text ----------------------------------------------------------------------

function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Block = Record<string, unknown>
const para = (text?: string): Block => (text ? { type: 'paragraph', content: [{ text }] } : { type: 'paragraph' })
const WORDS = ['warm', 'bassline', 'under', 'everything,', 'the', 'drums', 'a', 'little', 'behind', 'beat', 'and', 'voice', 'never', 'raises', 'itself']

function textOf(next: () => number, kind: number): string {
  if (kind === 0) return 'iii' // very narrow
  if (kind === 1) return 'WWW MMM' // very wide
  const n = 3 + Math.floor(next() * 16)
  const words = Array.from({ length: n }, () => WORDS[Math.floor(next() * WORDS.length)]!)
  return `${words.join(' ')}${['.', '!', '?', ',', '.'][Math.floor(next() * 5)]}`
}

function blocksOf(next: () => number): Block[] {
  const line = () => textOf(next, Math.floor(next() * 8))
  const kinds: Array<() => Block> = [
    () => para(line()),
    () => para(line()),
    () => ({ type: 'heading', level: 1 + Math.floor(next() * 3), content: [{ text: line() }] }),
    () => ({ type: 'bulletList', items: [{ blocks: [para(line()), { type: 'bulletList', items: [{ blocks: [para(line()), { type: 'bulletList', items: [{ blocks: [para(line())] }] }] }] }] }, { blocks: [para(line())] }] }),
    () => ({ type: 'orderedList', start: 1, items: [{ blocks: [para(line())] }, { blocks: [para(line())] }] }),
    () => ({ type: 'taskList', items: [{ checked: next() < 0.5, blocks: [para(line())] }, { checked: false, blocks: [para(line())] }] }),
    () => ({ type: 'blockquote', blocks: [para(line())] }),
    () => ({ type: 'blockquote', blocks: [{ type: 'bulletList', items: [{ blocks: [para(line())] }] }] }),
    () => ({ type: 'codeBlock', text: `alpha\nM\n${next() < 0.5 ? 'last long row of the code that wraps onto another row of the block' : 'last long row'}` }),
    () => para(),
    () => ({ type: 'divider' }),
  ]
  const n = 6 + Math.floor(next() * 5)
  const out: Block[] = [para(line())]
  for (let i = 0; i < n; i++) out.push(kinds[Math.floor(next() * kinds.length)]!())
  out.push(para(line()))
  return out
}

interface Case {
  seed: number
  index: number
  zoom: number
  angle: number
  align?: 'center' | 'right'
  fontSize: number
  width: number
  fixed: boolean
  scroll: number
  blocks: Block[]
}

function caseOf(seed: number, index: number): Case {
  const next = random(seed * 1000 + index)
  const fontSize = 12 + Math.floor(next() * 37)
  const fixed = next() < 0.6
  const zoom = [0.5, 1, 2][Math.floor(next() * 3)]!
  return {
    seed,
    index,
    zoom,
    angle: [0, 25, 115][Math.floor(next() * 3)]!,
    align: ([undefined, 'center', 'right'] as const)[Math.floor(next() * 3)],
    fontSize,
    // On screen whole across (at most 900 screen pixels wide).
    width: Math.min(Math.round(fontSize * (14 + next() * 12)), Math.round(900 / zoom)),
    fixed,
    scroll: fixed ? Math.floor(next() * fontSize * 10) : 0,
    blocks: blocksOf(next),
  }
}

// ---- the laid-out text, measured here --------------------------------------------------------------

interface MeasuredBlock {
  divider: boolean
  base: number
  lineHeight: number
  /** For an empty block (and a divider): its middle on the page and its height. */
  middle: { x: number; y: number }
  height: number
  chars: Array<{ ch: string; i: number; x: number; y: number }>
}

/** The text's blocks as laid out: each character's middle on the page and its offset in the plain text (lines joined by line breaks). */
const measure = (page: Page) =>
  page.evaluate(() => {
    const body = document.querySelector('.scene-text[data-id="t"] > .scene-text-body')!
    const out: MeasuredBlock[] = []
    let base = 0
    for (const el of Array.from(body.querySelectorAll('p, h1, h2, h3, pre, hr')) as HTMLElement[]) {
      const box = el.getBoundingClientRect()
      const middle = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      if (el.tagName === 'HR') {
        out.push({ divider: true, base, lineHeight: 0, middle, height: el.offsetHeight, chars: [] })
        continue
      }
      const lay = el.tagName === 'PRE' ? (el.querySelector('code') as HTMLElement) : el
      const chars: MeasuredBlock['chars'] = []
      let i = 0
      const walker = document.createTreeWalker(lay, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        for (let k = 0; k < n.data.length; ) {
          const len = (n.data.codePointAt(k) ?? 0) > 0xffff ? 2 : 1
          const ch = n.data.slice(k, k + len)
          let x = NaN
          let y = NaN
          if (ch !== '\n') {
            range.setStart(n, k)
            range.setEnd(n, k + len)
            const r = Array.from(range.getClientRects()).find((q) => q.width > 0 || q.height > 0) ?? range.getBoundingClientRect()
            x = r.left + r.width / 2
            y = r.top + r.height / 2
          }
          chars.push({ ch, i, x, y })
          i += len
          k += len
        }
      }
      // The block's line height (a code block's `code` has none of its own).
      out.push({ divider: false, base, lineHeight: parseFloat(getComputedStyle(el).lineHeight), middle, height: el.offsetHeight, chars })
      base += i + 1
    }
    return out
  })

interface ExpectedRow {
  top: number
  bottom: number
  centre: number
  inkLeft: number
  inkRight: number
  start: number
  end: number
  text: string
}

/** A page point in the card's own coordinates, from the record and the view (not the app's code). */
function localOf(c: Case, rec: { left: number; top: number }, view: View, host: { x: number; y: number }) {
  const a = (c.angle * Math.PI) / 180
  return (x: number, y: number) => {
    const sx = (x - host.x - view.panX) / view.zoom - rec.left
    const sy = (y - host.y - view.panY) / view.zoom - rec.top
    return { x: sx * Math.cos(a) + sy * Math.sin(a), y: -sx * Math.sin(a) + sy * Math.cos(a) }
  }
}

function rowsOf(blocks: MeasuredBlock[], local: (x: number, y: number) => { x: number; y: number }, value: string) {
  const rows: ExpectedRow[] = []
  const dividers: number[] = []
  for (const b of blocks) {
    if (b.divider) {
      dividers.push(local(b.middle.x, b.middle.y).y)
      continue
    }
    const half = b.lineHeight / 2
    type Raw = { chars: Array<{ ch: string; i: number; x: number; y: number }>; endsAtBreak: boolean; at?: number; cy?: number }
    const raw: Raw[] = []
    let cur: Raw | null = null
    let afterBreak = true
    b.chars.forEach((ch, k) => {
      if (ch.ch === '\n') {
        if (cur) cur.endsAtBreak = true
        else raw.push({ chars: [], endsAtBreak: true, at: b.base + ch.i })
        cur = null
        afterBreak = true
        if (k === b.chars.length - 1) raw.push({ chars: [], endsAtBreak: false, at: b.base + ch.i + 1 })
        return
      }
      const p = local(ch.x, ch.y)
      if (!cur || afterBreak || Math.abs(p.y - cur.cy!) > half) {
        cur = { chars: [], endsAtBreak: false }
        raw.push(cur)
      }
      cur.chars.push({ ...ch, x: p.x, y: p.y })
      const ink = cur.chars.filter((q) => !/\s/u.test(q.ch))
      const use = ink.length ? ink : cur.chars
      cur.cy = use.reduce((s, q) => s + q.y, 0) / use.length
      afterBreak = false
    })
    if (raw.length === 0) {
      const m = local(b.middle.x, b.middle.y)
      rows.push({ top: m.y - b.height / 2, bottom: m.y + b.height / 2, centre: m.y, inkLeft: m.x, inkRight: m.x, start: b.base, end: b.base, text: '' })
      continue
    }
    raw.forEach((r, k) => {
      if (r.cy === undefined) {
        const prev = raw.slice(0, k).reverse().find((q) => q.cy !== undefined)
        const nxt = raw.slice(k + 1).find((q) => q.cy !== undefined)
        r.cy = prev ? prev.cy! + b.lineHeight * (k - raw.indexOf(prev)) : nxt!.cy! - b.lineHeight * (raw.indexOf(nxt!) - k)
      }
    })
    const mx = local(b.middle.x, b.middle.y).x
    raw.forEach((r, k) => {
      const cy = r.cy!
      if (r.chars.length === 0) {
        rows.push({ top: cy - half, bottom: cy + half, centre: cy, inkLeft: mx, inkRight: mx, start: r.at!, end: r.at!, text: '' })
        return
      }
      const wraps = !r.endsAtBreak && k < raw.length - 1
      let last = r.chars.length - 1
      if (wraps) while (last > 0 && /\s/u.test(r.chars[last]!.ch)) last--
      const ink = r.chars.filter((q) => !/\s/u.test(q.ch))
      const xs = (ink.length ? ink : r.chars).map((q) => q.x)
      const start = b.base + r.chars[0]!.i
      const end = b.base + r.chars[last]!.i + r.chars[last]!.ch.length
      rows.push({ top: cy - half, bottom: cy + half, centre: cy, inkLeft: Math.min(...xs), inkRight: Math.max(...xs), start, end, text: value.slice(start, end) })
    })
  }
  return { rows, dividers }
}

const shownRow = (r: ExpectedRow, top: number, bottom: number) => Math.min(r.bottom, bottom) - Math.max(r.top, top) >= (r.bottom - r.top) / 2

/**
 * The rows the rule allows for a press at height `y`: the shown row whose height holds it, or the
 * nearest shown one. Measured positions are good to a fraction of a unit, so where a decision is
 * within half a unit (a row about exactly half shown, two rows about as near) either row is allowed.
 */
const TOLERANCE = 0.5
const gapOf = (r: ExpectedRow, y: number) => (y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0)
function allowedRows(rows: ExpectedRow[], y: number, top: number, bottom: number): ExpectedRow[] {
  const out = new Set<ExpectedRow>()
  for (const slack of [-TOLERANCE, 0, TOLERANCE]) {
    const shown = rows.filter((r) => Math.min(r.bottom, bottom) - Math.max(r.top, top) >= (r.bottom - r.top) / 2 + slack)
    if (shown.length === 0) continue
    const least = Math.min(...shown.map((r) => gapOf(r, y)))
    let near = shown.filter((r) => gapOf(r, y) <= least + TOLERANCE)
    if (least === 0 && near.length > 1) {
      const centre = Math.min(...near.map((r) => Math.abs(y - r.centre)))
      near = near.filter((r) => Math.abs(y - r.centre) <= centre + TOLERANCE)
    }
    near.forEach((r) => out.add(r))
  }
  return [...out]
}

// ---- the test ------------------------------------------------------------------------------------

const SEED = Number(process.env.PAPER_SEED ?? 20261124)
const CASES = 12

for (let index = 0; index < CASES; index++) {
  test(`margin-press rule, seeded case ${index} (seed ${SEED})`, async ({ page }) => {
    test.setTimeout(240_000)
    const c = caseOf(SEED, index)
    const padX = Math.round(c.fontSize * 100) / 100
    const padY = Math.round(c.fontSize * 0.75 * 100) / 100
    const W0 = c.width
    // A fixed height of five to eight rows, at most 560 screen pixels.
    const H0 = c.fixed ? Math.min(Math.round(padY * 2 + c.fontSize * 1.4125 * (5 + (index % 4))), Math.round(560 / c.zoom)) : c.fontSize * 30
    const a = (c.angle * Math.PI) / 180
    const cx = 200 + (W0 / 2) * Math.cos(a) - (H0 / 2) * Math.sin(a)
    const cy = 150 + (W0 / 2) * Math.sin(a) + (H0 / 2) * Math.cos(a)
    const rec = { type: 'text', id: 't', left: 200, top: 150, angle: c.angle, text: 'x', blocks: c.blocks, fontSize: c.fontSize, width: W0, surface: 'card', ...(c.align && { align: c.align }), ...(c.fixed && { height: H0 }) }
    const errors = await open(page, rec, { zoom: c.zoom, panX: Math.round(640 - c.zoom * cx), panY: Math.round(400 - c.zoom * cy) })
    const host = (await page.locator('.canvas-host').boundingBox())!
    const H = await page.evaluate(() => window.__margins.height('t'))
    // The sheet as drawn: never narrower than its widest word and the margins, whatever the record says.
    const W = await page.evaluate(() => window.__margins.width('t'))
    // The view centred on the sheet as it came out (a text that grows is only known once laid out).
    const mx = 200 + (W / 2) * Math.cos(a) - (H / 2) * Math.sin(a)
    const my = 150 + (W / 2) * Math.sin(a) + (H / 2) * Math.cos(a)
    const view = { zoom: c.zoom, panX: Math.round(560 - c.zoom * mx), panY: Math.round(400 - c.zoom * my) }
    await page.evaluate((v) => window.__margins.setView(v), view)
    await expect.poll(() => page.evaluate(() => window.__margins.viewport())).toEqual(view)
    const toPage = (x: number, y: number) => {
      const sx = rec.left + x * Math.cos(a) - y * Math.sin(a)
      const sy = rec.top + x * Math.sin(a) + y * Math.cos(a)
      return { x: host.x + view.panX + sx * c.zoom, y: host.y + view.panY + sy * c.zoom }
    }
    if (c.fixed && c.scroll > 0) {
      const mid = toPage(W / 2, H / 2)
      await page.mouse.move(mid.x, mid.y)
      await page.mouse.wheel(0, c.scroll * c.zoom)
      await page.waitForTimeout(250)
    }
    // Into the words, on a row near the middle of what is shown.
    const local = localOf(c, rec, (await page.evaluate(() => window.__margins.viewport())) as View, host)
    const startRows = rowsOf(await measure(page), local, '').rows
    const viewTop = padY
    const viewBottom = c.fixed ? H - padY : Infinity
    const middle = startRows.filter((r) => shownRow(r, viewTop, viewBottom) && r.inkRight > r.inkLeft).sort((p, q) => Math.abs(p.centre - H / 2) - Math.abs(q.centre - H / 2))[0]!
    const into = toPage((middle.inkLeft + middle.inkRight) / 2, middle.centre)
    await page.mouse.dblclick(into.x, into.y)
    await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
    await page.waitForTimeout(650)
    const original = (await editedText(page))!.value
    const viewport0 = await page.evaluate(() => window.__margins.viewport())
    const describe = (what: string, extra = '') => `seed ${SEED} case ${index} ${JSON.stringify({ zoom: c.zoom, angle: c.angle, align: c.align ?? 'left', fontSize: c.fontSize, width: W, fixed: c.fixed, scroll: c.scroll })}: ${what}${extra}`

    // The presses, worked out afresh before each one (typing can scroll the text).
    type Press = { what: string; at: (rows: ExpectedRow[], dividers: number[]) => { x: number; y: number } | null; exact: boolean }
    const presses: Press[] = []
    const shownNow = (rows: ExpectedRow[]) => rows.filter((r) => shownRow(r, viewTop, viewBottom))
    for (let k = 0; k < 40; k++) {
      for (const side of ['left', 'right'] as const) {
        presses.push({ what: `${side} margin beside shown row ${k}`, exact: true, at: (rows) => { const r = shownNow(rows)[k]; return r ? { x: side === 'left' ? padX / 2 : W - padX / 2, y: r.centre } : null } })
      }
    }
    for (let k = 0; k < 4; k++) {
      for (const [side, dy] of [['left', 0.3], ['right', -0.3]] as const) {
        presses.push({ what: `${side} margin beside divider ${k}, ${dy > 0 ? 'below' : 'above'} its middle`, exact: true, at: (_rows, dividers) => { const d = dividers.filter((y) => y > viewTop && y < viewBottom)[k]; return d === undefined ? null : { x: side === 'left' ? padX / 2 : W - padX / 2, y: d + dy * c.fontSize } } })
      }
    }
    for (const [where, y] of [['top', padY / 2], ['bottom', H - padY / 2]] as const) {
      presses.push({ what: `${where}-left corner`, exact: true, at: () => ({ x: padX / 2, y }) })
      presses.push({ what: `${where}-right corner`, exact: true, at: () => ({ x: W - padX / 2, y }) })
      presses.push({ what: `${where} margin, level with the words`, exact: false, at: () => ({ x: W / 2, y }) })
    }

    let pressed = 0
    for (const press of presses) {
      const local1 = localOf(c, rec, viewport0, host)
      const { rows, dividers } = rowsOf(await measure(page), local1, original)
      const at = press.at(rows, dividers)
      if (!at) continue
      const point = toPage(at.x, at.y)
      if (point.x < host.x + 4 || point.x > host.x + host.width - 4 || point.y < host.y + 4 || point.y > host.y + host.height - 4) continue
      // On the sheet, not on the scroll thumb or anything else.
      const target = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y)
        return el?.closest('.scene-text-thumb.is-shown') ? 'thumb' : el?.closest('.canvas-host') ? 'board' : 'other'
      }, point)
      if (target === 'thumb') await page.waitForTimeout(1200)
      if (target === 'other') continue
      // Where the rule puts the caret: before the first character of an allowed row (a press left of its characters), after its last (right of them), or somewhere in it (level with them).
      const allowed = allowedRows(rows, at.y, viewTop, viewBottom)
      const exact = allowed.map((r) => (at.x < r.inkLeft ? r.start : at.x > r.inkRight ? r.end : null))
      const ranges = allowed.map((r) => [r.start, r.end] as const)
      await page.mouse.click(point.x, point.y)
      const caret = (await editedText(page))?.start
      await page.keyboard.type('X')
      const what = describe(press.what, ` (expected ${allowed.map((r, k) => `the row ${JSON.stringify(r.text)} at ${exact[k] ?? `${r.start}-${r.end}`}`).join(' or ')})`)
      await expect.poll(async () => (await editedText(page))?.value.length, { message: what, timeout: 3000 }).toBe(original.length + 1)
      const value = (await editedText(page))!.value
      const typedAt = value.indexOf('X')
      const ok = press.exact && exact.every((e) => e !== null) ? exact.includes(typedAt) : ranges.some(([from, to]) => typedAt >= from && typedAt <= to)
      if (!ok || value !== original.slice(0, typedAt) + 'X' + original.slice(typedAt)) {
        // The failing case in full: where the X went, and the rows as measured here.
        console.log(`${what}
  typed at ${typedAt}, the caret after the press at ${caret} (press at ${at.x.toFixed(1)}, ${at.y.toFixed(1)} in the card)
  rows: ${JSON.stringify(shownNow(rows).map((r) => [r.text, r.start, r.end, +r.top.toFixed(1), +r.bottom.toFixed(1), +r.inkLeft.toFixed(1), +r.inkRight.toFixed(1)]))}`)
      }
      expect(ok, `${what}: typed at ${typedAt}`).toBe(true)
      await expect.poll(async () => (await storedDoc(page)).objects[0]!.text, { message: `${what}: stored`, timeout: 4000 }).toBe(value)
      expect(await page.evaluate(() => window.__margins.editing()), what).toBe(true)
      expect(await page.evaluate(() => window.__margins.viewport()), what).toEqual(viewport0)
      await page.keyboard.press('Backspace')
      await expect.poll(async () => (await editedText(page))?.value, { message: `${what}: back`, timeout: 3000 }).toBe(original)
      pressed++
    }
    console.log(`margin-press seed ${SEED} case ${index}: ${pressed} presses`)
    expect(pressed).toBeGreaterThanOrEqual(4) // a large text at 200% shows few of its margins
    expect(errors).toEqual([])
  })
}

test('right to left: the left margin puts the caret before the row’s first character in reading order (drawn at its right), the right margin after its last', async ({ page }) => {
  const rec = { type: 'text', id: 't', left: 200, top: 150, angle: 0, text: 'שלום עולם', fontSize: 24, width: 400, surface: 'card' }
  const errors = await open(page, rec, { zoom: 1, panX: 0, panY: 0 })
  const host = (await page.locator('.canvas-host').boundingBox())!
  const y = host.y + 150 + 18 + 15
  await page.mouse.dblclick(host.x + 200 + 24 + 300, y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.waitForTimeout(650)
  await page.mouse.click(host.x + 200 + 12, y) // the left margin
  await page.keyboard.type('X')
  await expect.poll(async () => (await storedDoc(page)).objects[0]!.text).toBe('Xשלום עולם')
  await page.keyboard.press('Backspace')
  await page.mouse.click(host.x + 200 + 400 - 12, y) // the right margin
  await page.keyboard.type('Y')
  await expect.poll(async () => (await storedDoc(page)).objects[0]!.text).toBe('שלום עולםY')
  expect(errors).toEqual([])
})

test('a row with less than half of its height shown is not picked: the top corners give the next row (the reviewer’s row 9 / row 10 case)', async ({ page }) => {
  const text = Array.from({ length: 30 }, (_, i) => `Row ${i}`).join('\n')
  const rec = { type: 'text', id: 't', left: 280, top: 180, angle: 0, text, fontSize: 18, width: 270, height: 155, surface: 'card' }
  const zoom = 0.5
  const errors = await open(page, rec, { zoom, panX: 160, panY: 70 })
  const host = (await page.locator('.canvas-host').boundingBox())!
  const at = (x: number, y: number) => ({ x: host.x + 160 + (rec.left + x) * zoom, y: host.y + 70 + (rec.top + y) * zoom })
  const into = at(40, 13.5 + 30)
  await page.mouse.dblclick(into.x, into.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.waitForTimeout(650)
  // Scrolled so that about one unit of row 9 shows under the top of the words' viewport.
  const body = page.locator('.scene-text[data-id="t"] > .scene-text-body')
  const shownOf9 = await body.evaluate((e, z) => {
    const row = e.querySelectorAll('p')[9]!.getBoundingClientRect()
    e.scrollTop += Math.round((row.bottom - e.getBoundingClientRect().top) / z - 1.25)
    return (e.querySelectorAll('p')[9]!.getBoundingClientRect().bottom - e.getBoundingClientRect().top) / z
  }, zoom)
  await page.waitForTimeout(1000)
  expect(shownOf9).toBeGreaterThan(0)
  expect(shownOf9).toBeLessThan(25 / 2) // under half of its 25-unit row
  const original = (await editedText(page))!.value
  for (const [x, at10] of [[4, 0], [270 - 4, 6]] as const) {
    const scroll = await body.evaluate((e) => e.scrollTop)
    const p = at(x, 3)
    await page.mouse.click(p.x, p.y)
    await page.keyboard.type('X')
    const i = original.indexOf('Row 10') + at10
    await expect.poll(async () => (await storedDoc(page)).objects[0]!.text).toBe(original.slice(0, i) + 'X' + original.slice(i))
    await page.keyboard.press('Backspace')
    await body.evaluate((e, s) => (e.scrollTop = s), scroll)
    await page.waitForTimeout(1000)
  }
  expect(errors).toEqual([])
})

test('white space hung past the end of a wrapped row does not make the margin beside it part of the words: a press there goes to the row’s end', async ({ page }) => {
  // Twelve spaces at the wrap hang past the words into the right margin, where the browser counts them as the paragraph.
  const text = 'one two three four' + ' '.repeat(12) + 'five six seven eight nine ten'
  const errors = await open(page, { type: 'text', id: 't', left: 200, top: 150, angle: 0, text, fontSize: 24, width: 300, surface: 'card' }, { zoom: 1, panX: 0, panY: 0 })
  const host = (await page.locator('.canvas-host').boundingBox())!
  const y = host.y + 150 + 18 + 15
  await page.mouse.dblclick(host.x + 200 + 24 + 10, y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.waitForTimeout(650)
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: host.x + 200 + 300 - 12, y })).toBe('P') // what the browser says is there
  await page.mouse.click(host.x + 200 + 300 - 12, y)
  await page.keyboard.type('X')
  await expect.poll(async () => (await storedDoc(page)).objects[0]!.text).toBe(text.replace('four', 'fourX'))
  expect(errors).toEqual([])
})
