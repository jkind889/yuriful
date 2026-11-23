import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openBlank } from './helpers.ts'

/**
 * The DOM scene layer (`src/editor/sceneLayer.ts`) and the frame bitmap compositor
 * (`src/editor/renderFrameBitmap.ts`) in real Chromium, before the app mounts either: the page
 * is a blank app-origin page with the app's stylesheet, and the modules are loaded from the
 * dev server, as the storage specs load app modules.
 */

async function openHarness(page: Page) {
  await openBlank(page)
  await page.evaluate(async () => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/src/styles.css'
    const loaded = new Promise((resolve, reject) => {
      link.onload = resolve
      link.onerror = reject
    })
    document.head.append(link)
    await loaded
    document.body.style.margin = '0'
  })
}

test('the bitmap inlines the stylesheet’s prose rules exactly, and frame paper is the canvas’s frame fill', async ({ page }) => {
  await openHarness(page)
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const block = css.match(/\/\* prose:start[^\n]*\r?\n([\s\S]*?)\/\* prose:end \*\//)?.[1]
  expect(block, 'the prose:start / prose:end block').toBeDefined()
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { PROSE_CSS } = (await load('/src/editor/renderFrameBitmap.ts')) as typeof import('../src/editor/renderFrameBitmap.ts')
    const { FRAME_FILL } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(document.body)
    layer.setRecords({ frames: [{ id: 'f', name: 'F', left: 0, top: 0, width: 10, height: 10 }], objects: [] })
    const probe = document.createElement('div')
    probe.style.background = FRAME_FILL
    document.body.append(probe)
    return { prose: PROSE_CSS, paper: getComputedStyle(layer.elementOf('f')!).backgroundColor, fill: getComputedStyle(probe).backgroundColor }
  })
  // A checkout with core.autocrlf gives the stylesheet CRLF line endings: compare the rules, not the line endings.
  const lf = (t: string) => t.replace(/\r\n/g, '\n').trim()
  expect(lf(out.prose)).toBe(lf(block!))
  expect(out.paper).toBe(out.fill)
})

type Ink = { top: number; bottom: number; left: number; right: number } | null

interface LineReport {
  line: number
  text: string
  fabric: Ink
  dom: Ink
  /** Anything but paper in the line's band (dark or coloured: an emoji, a caption background). */
  fabricPresent: boolean
  domPresent: boolean
}

interface TypographyCase {
  name: string
  fabricHeight: number
  domHeight: number
  /** The box's width as drawn: Fabric's own, and the layer's effective width. */
  fabricWidth: number
  domWidth: number
  fabricLines: string[]
  domLines: string[]
  lines: LineReport[]
}

/**
 * Lays each record out with Fabric (the shipped frame preview, `framePreview.ts`, at scale 2)
 * and with the scene layer (zoom 2, then a screenshot), and reports per line where the ink is
 * in both, the wrapped lines and the box heights.
 */
async function compareTypography(page: Page, recs: Array<Record<string, unknown>>): Promise<TypographyCase[]> {
  await page.setViewportSize({ width: 1280, height: 1800 })
  const out: TypographyCase[] = []
  for (const rec of recs) {
    const prepared = await page.evaluate(async (rec) => {
      const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
      const { createObject } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
      const { renderFramePreview } = (await load('/src/editor/framePreview.ts')) as typeof import('../src/editor/framePreview.ts')
      const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
      const text = rec as unknown as import('../src/model/types.ts').TextRecord
      const tb = createObject(text, () => undefined) as unknown as {
        width: number
        height: number
        _textLines: string[][]
        getHeightOfLine(i: number): number
      }
      const margin = 20
      // Fabric's own box: a click-created box is at least as wide as its widest word.
      const frame = { id: 'f', name: '', left: -margin, top: -margin, width: Math.ceil(Math.max(text.width, tb.width)) + 2 * margin, height: Math.ceil(tb.height) + 2 * margin }
      const scale = 2
      const lineTops: number[] = []
      const pitches: number[] = []
      let y = 0
      tb._textLines.forEach((_, i) => {
        lineTops.push(y)
        pitches.push(tb.getHeightOfLine(i))
        y += tb.getHeightOfLine(i)
      })
      const png = await renderFramePreview({ frames: [frame], objects: [text] }, 'f', () => undefined)

      document.querySelector('#harness')?.remove()
      const host = document.createElement('div')
      host.id = 'harness'
      host.style.cssText = `position:fixed;left:0;top:0;width:${frame.width * scale}px;height:${frame.height * scale}px;background:#fff;overflow:hidden`
      document.body.append(host)
      const layer = new SceneLayer({ getImage: () => undefined })
      layer.mount(host)
      layer.setRecords({ frames: [frame], objects: [text] })
      layer.setViewport({ zoom: scale, panX: margin * scale, panY: margin * scale })
      const body = layer.bodyOf(text.id)!
      const domHeight = layer.measureCard(text.id)!.height
      // The wrapped lines as laid out: characters grouped by the top of their box.
      const rows = new Map<number, string>()
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text
        for (let i = 0; i < t.data.length; i++) {
          range.setStart(t, i)
          range.setEnd(t, i + 1)
          const r = range.getClientRects()[0]
          if (!r) continue
          const key = Math.round(r.top + r.height / 2)
          let rowKey = [...rows.keys()].find((k) => Math.abs(k - key) <= 2)
          if (rowKey === undefined) {
            rowKey = key
            rows.set(rowKey, '')
          }
          rows.set(rowKey, rows.get(rowKey)! + t.data[i])
        }
      }
      // A line of spaces alone is left out on both sides (a drawn box can start a line with the
      // space that did not fit after a word); the box heights still count every line.
      // A tab is compared as the space it is drawn as (Fabric's click-created box even stores it as one in its lines).
      const domLines = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s.replace(/\t/g, ' ').replace(/ +$/, '')).filter((l) => l !== '')
      const fabricLines = tb._textLines.map((l) => l.join('').replace(/\t/g, ' ').replace(/ +$/, '')).filter((l) => l !== '')
      return { png, frame, scale, margin, lineTops, pitches, fabricHeight: tb.height, fabricWidth: tb.width, domHeight, domWidth: layer.widthOf(text.id)!, domLines, fabricLines, lines: tb._textLines.map((l) => l.join('')) }
    }, rec)
    const shot = await page.screenshot({ clip: { x: 0, y: 0, width: prepared.frame.width * prepared.scale, height: prepared.frame.height * prepared.scale } })
    const lines = await page.evaluate(
      async ({ prepared, shot }) => {
        const pixels = async (src: string) => {
          const img = new Image()
          img.src = src
          await img.decode()
          const c = document.createElement('canvas')
          c.width = img.naturalWidth
          c.height = img.naturalHeight
          const ctx = c.getContext('2d')!
          ctx.drawImage(img, 0, 0)
          return ctx.getImageData(0, 0, c.width, c.height)
        }
        const fab = await pixels(prepared.png)
        const dom = await pixels(`data:image/png;base64,${shot}`)
        const inkIn = (data: ImageData, y0: number, y1: number): { top: number; bottom: number; left: number; right: number } | null => {
          let top = -1
          let bottom = -1
          let left = Infinity
          let right = -1
          for (let y = Math.max(0, y0); y < Math.min(data.height, y1); y++) {
            for (let x = 0; x < data.width; x++) {
              const i = (y * data.width + x) * 4
              const lum = 0.299 * data.data[i]! + 0.587 * data.data[i + 1]! + 0.114 * data.data[i + 2]!
              if (lum >= 140) continue
              if (top < 0) top = y
              bottom = y
              left = Math.min(left, x)
              right = Math.max(right, x)
            }
          }
          return top < 0 ? null : { top: top / prepared.scale, bottom: (bottom + 1) / prepared.scale, left: left / prepared.scale, right: (right + 1) / prepared.scale }
        }
        const present = (data: ImageData, y0: number, y1: number): boolean => {
          for (let y = Math.max(0, y0); y < Math.min(data.height, y1); y++) {
            for (let x = 0; x < data.width; x++) {
              const i = (y * data.width + x) * 4
              if (data.data[i]! < 235 || data.data[i + 1]! < 235 || data.data[i + 2]! < 235) return true
            }
          }
          return false
        }
        const s = prepared.scale
        return prepared.lineTops.map((t, i) => {
          const y0 = Math.round((t + prepared.margin) * s)
          const y1 = Math.round((t + prepared.pitches[i]! + prepared.margin) * s)
          return { line: i, text: prepared.lines[i]!, fabric: inkIn(fab, y0, y1), dom: inkIn(dom, y0, y1), fabricPresent: present(fab, y0, y1), domPresent: present(dom, y0, y1) }
        })
      },
      { prepared, shot: shot.toString('base64') },
    )
    out.push({ name: String(rec.id), fabricHeight: prepared.fabricHeight, domHeight: prepared.domHeight, fabricWidth: prepared.fabricWidth, domWidth: prepared.domWidth, fabricLines: prepared.fabricLines, domLines: prepared.domLines, lines })
  }
  return out
}

const FONTS = ['sans', 'serif', 'mono', 'hand', 'display'] as const

interface Residual {
  name: string
  /** DOM minus Fabric, scene px. */
  height: number
  width: number
  /** Lines with text that one renderer drew nothing on. */
  missing: string[]
  wraps: boolean
  top: number[]
  bottom: number[]
  left: number[]
  right: number[]
}

/**
 * Colour emoji are painted differently by the canvas and the DOM (measured: on some lines the
 * canvas gives 🎧 no dark pixel at all, and 😀's outline starts 2.5 px apart while the glyphs sit
 * in the same place), so a line holding one is compared on its wrap, height, top and bottom, not
 * on where its dark pixels start and end across.
 */
const EMOJI = /\p{Extended_Pictographic}/u

function residuals(cases: TypographyCase[]): Residual[] {
  return cases.map((c) => {
    const both = c.lines.filter((l) => l.fabric && l.dom)
    const across = both.filter((l) => !EMOJI.test(l.text))
    return {
      name: c.name,
      height: +(c.domHeight - c.fabricHeight).toFixed(3),
      width: +(c.domWidth - c.fabricWidth).toFixed(3),
      missing: c.lines.filter((l) => l.text.trim() !== '' && !(l.fabricPresent && l.domPresent)).map((l) => `${JSON.stringify(l.text)} (Fabric ${l.fabricPresent}, DOM ${l.domPresent})`),
      wraps: JSON.stringify(c.domLines) === JSON.stringify(c.fabricLines),
      top: both.map((l) => l.dom!.top - l.fabric!.top),
      bottom: both.map((l) => l.dom!.bottom - l.fabric!.bottom),
      left: across.map((l) => l.dom!.left - l.fabric!.left),
      right: across.map((l) => l.dom!.right - l.fabric!.right),
    }
  })
}

/** The residuals, one line per case (DOM minus Fabric, scene px), for the record. */
function report(rs: Residual[], cases: TypographyCase[]) {
  for (const r of rs) console.log(r.name.padEnd(16), 'height', String(r.height).padStart(7), 'width', String(r.width).padStart(6), 'wraps', r.wraps, '| top', r.top.join(','), '| bottom', r.bottom.join(','), '| left', r.left.join(','), '| right', r.right.join(','))
  for (const c of cases) if (JSON.stringify(c.domLines) !== JSON.stringify(c.fabricLines)) console.log(c.name, JSON.stringify(c.fabricLines), JSON.stringify(c.domLines))
}

/**
 * What the comparison allows, measured on Chromium: something drawn on every line that has text,
 * in both; the box height within 0.1 px (Chromium keeps line heights to 1/64 px) and its width
 * within 0.05 px; the same wrap points; and every line's ink within one device pixel at 2x
 * (0.5 scene px) of where Fabric draws it, on all four sides.
 */
function expectMatch(rs: Residual[]) {
  for (const r of rs) {
    expect(r.missing, `${r.name}: lines drawn by both`).toEqual([])
    expect(Math.abs(r.width), `${r.name}: width`).toBeLessThanOrEqual(0.05)
    expect(Math.abs(r.height), `${r.name}: height`).toBeLessThanOrEqual(0.1)
    expect(r.wraps, `${r.name}: wrap points`).toBe(true)
    expect(r.top.length, `${r.name}: lines compared`).toBeGreaterThan(0)
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      for (const d of r[side]) expect(Math.abs(d), `${r.name}: ${side} of a line`).toBeLessThanOrEqual(0.5)
    }
  }
}

test('typography matches the canvas: box height, wrap points and where each line is drawn, per font and heading level', async ({ page }) => {
  test.setTimeout(180_000)
  await openHarness(page)
  const recs: Array<Record<string, unknown>> = []
  for (const font of FONTS) {
    for (const fontSize of [20, 13, 31]) {
      recs.push({
        type: 'text', id: `${font}-${fontSize}`, left: 0, top: 0, angle: 0, width: 300, fontSize,
        text: 'Heading One\nHeading Two\nHeading Three\nBody text that wraps over a couple of lines in this box, Hamburgefonts.\n\nLast Line',
        headings: [1, 2, 3], ...(font === 'sans' ? {} : { font }),
      })
    }
  }
  const cases = await compareTypography(page, recs)
  const rs = residuals(cases)
  report(rs, cases)
  expectMatch(rs)
})

test('typography matches the canvas with alignment, marks, span fonts, drawn boxes and caption backgrounds', async ({ page }) => {
  test.setTimeout(180_000)
  await openHarness(page)
  const base = { type: 'text', left: 0, top: 0, angle: 0, width: 260, fontSize: 18 }
  const para = 'The quick brown fox jumps over the lazy dog while Hamburgefonts wraps again and again.'
  const recs: Array<Record<string, unknown>> = [
    { ...base, id: 'center', align: 'center', text: `Centred title\n${para}`, headings: [2] },
    { ...base, id: 'right', align: 'right', text: `Right title\n${para}`, headings: [1] },
    { ...base, id: 'marks', text: para, spans: [{ start: 4, end: 9, bold: true }, { start: 10, end: 15, italic: true }, { start: 20, end: 25, underline: true }, { start: 26, end: 30, strike: true }, { start: 40, end: 48, bold: true, italic: true }] },
    { ...base, id: 'span-fonts', text: para, spans: [{ start: 4, end: 15, font: 'display' }, { start: 26, end: 39, font: 'hand' }, { start: 49, end: 62, font: 'mono' }] },
    { ...base, id: 'serif-span-sans', font: 'serif', text: para, spans: [{ start: 0, end: 19, font: 'sans' }] },
    { ...base, id: 'colour-caption', color: '#c4372f', captionBackground: '#fff3c4', text: para },
    { ...base, id: 'drawn', minHeight: 40, text: 'Drawn box with an extraordinarilylongwordthatmustsplit and more words.' },
    { ...base, id: 'drawn-tall', minHeight: 220, text: 'Short text in a tall drawn box.' },
    { ...base, id: 'drawn-center', minHeight: 0, align: 'center', text: para },
    { ...base, id: 'emoji', text: 'Emoji 😀 and 👩‍💻 with flags 🇯🇵 on a line that wraps around.' },
    { ...base, id: 'empty-lines', text: '\n\nMiddle\n\n', headings: [0, 1, 0, 2] },
    { ...base, id: 'spaces', text: 'Triple   spaces   and trailing   \n  leading spaces' },
    { ...base, id: 'drawn-spaces', minHeight: 0, text: 'Triple   spaces   and trailing   \n  leading spaces' },
    { ...base, id: 'tokens', width: 300, text: 'A state-of-the-art build, 2012—2014, and/or https://example.com/a-b/c?d=e and 日本語のテキストです in one line.' },
    { ...base, id: 'tokens-narrow', width: 180, text: 'Ab state-of-the-art cd 2012—2014 ef and/or gh 日本語のテキストです ij' },
    { ...base, id: 'tokens-marked', width: 180, text: 'Ab state-of-the-art cd 2012—2014 ef', spans: [{ start: 3, end: 8, bold: true }, { start: 8, end: 9, italic: true }, { start: 23, end: 28, bold: true }] },
    { ...base, id: 'drawn-tokens', minHeight: 0, width: 230, text: 'A state-of-the-art build, 2012—2014, and/or https://example.com/a-b/c?d=e and 日本語のテキストです in one line.' },
  ]
  const cases = await compareTypography(page, recs)
  const rs = residuals(cases)
  report(rs, cases)
  expectMatch(rs)
})

/** Breakable words common in music writing, and the other kinds of word CSS could break inside. */
const BREAKABLE_WORDS = ['K-pop', 'lo-fi', 'hip-hop', 'state-of-the-art', '2012—2014', 'and/or', '日本語のテキストです', '😀🎧🎶', 'https://example.com/a-b/c?d=e']

test('drawn boxes keep a breakable word whole as Fabric does: at a line end, without room for its space, exactly fitting, and too wide', async ({ page }) => {
  test.setTimeout(240_000)
  await openHarness(page)
  // Widths measured as the scene layer lays the line out: "Ab W", "Ab W " and W alone.
  const measured = await page.evaluate(async (words) => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    const out = []
    for (const [i, w] of words.entries()) {
      // Bold inside some words, so pieces cross mark boundaries.
      const spans = i % 3 === 2 ? [{ start: 3, end: 5, bold: true as const }] : undefined
      const text = `Ab ${w} cd ef gh`
      layer.setRecords({ frames: [], objects: [{ type: 'text', id: 't', left: 0, top: 0, angle: 0, width: 3000, fontSize: 18, minHeight: 0, text, ...(spans && { spans }) }] })
      const body = layer.bodyOf('t')!
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
      const point = (offset: number) => {
        let o = offset
        for (const node of nodes) {
          if (o <= node.data.length) return { node, o }
          o -= node.data.length
        }
        throw new Error('offset')
      }
      const width = (a: number, b: number) => {
        const r = document.createRange()
        const pa = point(a)
        const pb = point(b)
        r.setStart(pa.node, pa.o)
        r.setEnd(pb.node, pb.o)
        return r.getBoundingClientRect().width
      }
      const end = 3 + w.length
      out.push({ word: w, text, spans, line: width(0, end), lineSpace: width(0, end + 1), alone: width(3, end) })
    }
    return out
  }, BREAKABLE_WORDS)
  const up = (n: number) => Math.ceil(n * 100 - 1e-6) / 100
  const recs: Array<Record<string, unknown>> = []
  for (const m of measured) {
    const base = { type: 'text', left: 0, top: 0, angle: 0, fontSize: 18, minHeight: 0, text: m.text, ...(m.spans && { spans: m.spans }) }
    const widths: Array<[string, number]> = [
      // The word ends the first line, its space fits after it.
      ['line-end', up(m.lineSpace + 0.5)],
      // The word fits, the space after it does not: Fabric moves the word to the next line.
      ['no-room-for-space', up((m.line + m.lineSpace) / 2)],
      // The word alone fills a line exactly.
      ['exact', up(m.alone)],
      // One pixel narrower than the word: it is cut.
      ['too-wide', up(m.alone) - 1],
      // Cut into three or more pieces.
      ['much-too-wide', up(m.alone * 0.4)],
    ]
    for (const [kind, width] of widths) recs.push({ ...base, id: `${m.word} ${kind}`, width })
  }
  recs.push({ type: 'text', id: 'centred hip-hop', left: 0, top: 0, angle: 0, fontSize: 18, minHeight: 0, align: 'center', width: up(measured[2]!.alone), text: measured[2]!.text })
  const cases = await compareTypography(page, recs)
  const rs = residuals(cases)
  report(rs, cases)
  expectMatch(rs)
})

test('keeping drawn words whole costs little on a 1,500-word card, on every step of a side-handle resize', async ({ page }) => {
  test.setTimeout(120_000)
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer, measureDrawnTokens, noWrapRanges } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    type TextRecord = import('../src/model/types.ts').TextRecord
    const vocab = ['the', 'K-pop', 'record', 'lo-fi', 'beats,', 'and/or', 'a', 'hip-hop', '2012—2014', 'sound', 'of', 'state-of-the-art', 'mix.', '日本語', 'synth-pop', 'bass', 'drop', 'is', 'warm', 'https://example.com/x-y']
    const words: string[] = []
    for (let i = 0; i < 1500; i++) words.push(vocab[(i * 7 + (i >> 3)) % vocab.length]!)
    const paragraphs: string[] = []
    for (let i = 0; i < words.length; i += 100) paragraphs.push(words.slice(i, i + 100).join(' '))
    const text = paragraphs.join('\n')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    const rec: TextRecord = { type: 'text', id: 'long', left: 0, top: 0, angle: 0, width: 600, fontSize: 16, minHeight: 0, text, spans: [{ start: 4, end: 9, bold: true }] }
    // Measuring the words of a new text (nothing cached: a font size not seen before), the first
    // time in the page and again, then the whole first render of the card.
    let t = performance.now()
    measureDrawnTokens({ ...rec, fontSize: 16.01 })
    const measureFirstInPage = performance.now() - t
    t = performance.now()
    const tokens = measureDrawnTokens({ ...rec, fontSize: 16.02 })
    const measure = performance.now() - t
    t = performance.now()
    layer.setRecords({ frames: [], objects: [rec] })
    const first = performance.now() - t
    const rule: number[] = []
    const step: number[] = []
    let rerenders = 0
    let last = layer.bodyOf('long')!.firstChild
    // Down past the URL's width, so it becomes wider than the box and is cut into pieces.
    for (let width = 600; width >= 120; width -= 4) {
      const next = { ...rec, width }
      t = performance.now()
      noWrapRanges(next)
      rule.push(performance.now() - t)
      t = performance.now()
      layer.updateItem(next)
      layer.measureCard('long')
      step.push(performance.now() - t)
      const now = layer.bodyOf('long')!.firstChild
      if (now !== last) rerenders++
      last = now
    }
    // An edit to one paragraph (a word typed at its end): only that line is measured again, and
    // the new word is kept whole.
    const edited = { ...rec, width: 300, text: text.replace('\n', ' neo-soul\n') }
    t = performance.now()
    measureDrawnTokens(edited)
    const editMeasure = performance.now() - t
    t = performance.now()
    layer.updateItem(edited)
    const editRender = performance.now() - t
    const editedLine = layer.bodyOf('long')!.firstElementChild!
    const newWordKept = editedLine.lastElementChild?.className === 'yp-nowrap' && editedLine.lastElementChild.textContent === 'neo-soul'
    const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!
    const breakable = tokens.reduce((n, line) => n + line.length, 0)
    return { words: words.length, breakable, measureFirstInPage, measure, first, editMeasure, editRender, newWordKept, steps: step.length, rerenders, ruleP50: pct(rule, 0.5), ruleMax: Math.max(...rule), stepP50: pct(step, 0.5), stepP95: pct(step, 0.95), stepMax: Math.max(...step) }
  })
  console.log(JSON.stringify(out, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)))
  expect(out.words).toBe(1500)
  expect(out.breakable).toBeGreaterThan(300)
  // Working out the ranges for a new width only compares cached widths.
  expect(out.ruleMax).toBeLessThan(16)
  // An edit measures only the paragraph it changed.
  expect(out.editMeasure).toBeLessThan(16)
  expect(out.newWordKept).toBe(true)
})

test('a word with only opening punctuation before it and closing punctuation after it has no break opportunity in Chromium', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { breakableTokenRanges } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const plain = ['beats,', 'mix.', '(word)', '[x]', '{y}', '"quoted"', "'tis", "rock'n'roll", '“curly”', '‘single’', '«mot»', '¿qué?', '¡sí!', 'wow!!', 'end…', 'semi;', 'colon:', 'ok.”', '(K-pop', 'a.b']
    // Words Chromium does break inside (it keeps 'and/or' whole, which is listed all the same: a span is harmless).
    const breakable = ['K-pop', 'state-of-the-art', '2012—2014', '日本語', '😀😀']
    const minContent = (token: string) => {
      // A click-created card's own rules; the narrowest it can be laid out is its widest unbreakable piece.
      const d = document.createElement('div')
      d.className = 'yuriful-prose'
      d.dataset.font = 'sans'
      d.style.cssText = 'position:absolute;left:0;top:0;font-size:20px;width:min-content'
      const p = document.createElement('p')
      p.textContent = token
      d.append(p)
      document.body.append(d)
      const narrow = d.getBoundingClientRect().width
      d.style.whiteSpace = 'pre'
      d.style.width = 'max-content'
      const whole = d.getBoundingClientRect().width
      d.remove()
      return { token, narrow, whole, listed: breakableTokenRanges(token).length > 0 }
    }
    return { plain: plain.map(minContent), breakable: breakable.map(minContent) }
  })
  for (const r of out.plain) {
    // Left without a span, and CSS cannot break it anyway: its narrowest layout is the whole word.
    if (r.token === '(K-pop' || r.token === 'a.b') continue
    expect(r.listed, r.token).toBe(false)
    expect(r.narrow, r.token).toBeCloseTo(r.whole, 2)
  }
  // Breakable inside: listed, and CSS would break it.
  expect(out.plain.find((r) => r.token === '(K-pop')!.listed).toBe(true)
  for (const r of out.breakable) {
    expect(r.listed, r.token).toBe(true)
    expect(r.narrow, r.token).toBeLessThan(r.whole - 1)
  }
})

test('click-created boxes wrap only between words: state-of-the-art, 2012—2014, and/or, a URL and a CJK run stay whole', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { createObject } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    type TextRecord = import('../src/model/types.ts').TextRecord
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    const preWidth = (body: HTMLElement, token: string) => {
      const s = document.createElement('span')
      s.style.whiteSpace = 'pre'
      s.textContent = token
      const p = body.firstElementChild!
      p.append(s)
      const w = s.getBoundingClientRect().width
      s.remove()
      return w
    }
    const linesOf = (body: HTMLElement) => {
      const rows = new Map<number, string>()
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text
        for (let i = 0; i < t.data.length; i++) {
          range.setStart(t, i)
          range.setEnd(t, i + 1)
          const r = range.getClientRects()[0]
          if (!r) continue
          const key = [...rows.keys()].find((k) => Math.abs(k - r.top) < 3) ?? r.top
          rows.set(key, (rows.get(key) ?? '') + t.data[i])
        }
      }
      return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s.trimEnd())
    }
    const tokens = ['state-of-the-art', '2012—2014', 'and/or', 'https://example.com/a-b/c?d=e', '日本語のテキストです']
    const results = []
    for (const marked of [false, true]) {
      for (const token of tokens) {
        const text = `Ab ${token} cd`
        // Marks inside the token (a bold piece, then an italic one) put element boundaries inside it.
        const spans = marked ? [{ start: 3, end: 5, bold: true as const }, { start: 5, end: 6, italic: true as const }] : undefined
        const rec: TextRecord = { type: 'text', id: 't', left: 20, top: 20, angle: 0, width: 1000, fontSize: 18, text, ...(spans && { spans }) }
        layer.setRecords({ frames: [], objects: [rec] })
        const wide = layer.measureCard('t')!
        const longest = preWidth(layer.bodyOf('t')!, token)
        // As narrow as the box may be: the token fits alone, and "Ab " plus the token does not.
        const narrow = { ...rec, width: wide.minWidth }
        layer.setRecords({ frames: [], objects: [narrow] })
        const dom = linesOf(layer.bodyOf('t')!)
        const tb = createObject(narrow, () => undefined) as unknown as { width: number; dynamicMinWidth: number; _textLines: string[][] }
        const fabric = tb._textLines.map((l) => l.join('').trimEnd())
        results.push({ token, marked, minWidth: wide.minWidth, longest, fabricWidth: tb.width, fabricLongest: tb.dynamicMinWidth, dom, fabric, nowrapSpans: layer.bodyOf('t')!.querySelectorAll('.yp-nowrap').length })
      }
    }
    return results
  })
  console.log(out.map((r) => `${r.token} marked=${r.marked}: min width ${r.minWidth}, Fabric's longest word ${r.fabricLongest.toFixed(3)}`).join(String.fromCharCode(10)))
  for (const r of out) {
    // The measured minimum width is the token's own width, rounded up to 0.01 (unmarked: as
    // one `white-space: pre` run; where a run starts moves its width by up to 1/64 px), and
    // Fabric finds no wider word: at that width it does not widen the box.
    if (!r.marked) {
      expect(r.minWidth, r.token).toBeGreaterThanOrEqual(r.longest - 0.001)
      expect(r.minWidth - r.longest, r.token).toBeLessThan(0.03)
    }
    expect(r.fabricWidth, r.token).toBe(r.minWidth)
    expect(Math.abs(r.fabricLongest - r.minWidth), r.token).toBeLessThan(0.5)
    // The token is whole on a line of its own, exactly as Fabric wraps it.
    expect(r.dom, `${r.token} marked=${r.marked}`).toContain(r.token)
    expect(r.dom, `${r.token} marked=${r.marked}`).toEqual(r.fabric)
    expect(r.nowrapSpans).toBeGreaterThan(0)
  }
})

// ---- images, measuring, the bitmap, editing -------------------------------------------------

/** Defines `window.__quadrants(w, h)`: a decoded PNG of four quadrants (red, green / blue, yellow), as `AssetSource.get` gives one. */
const QUADRANTS = `
window.__quadrants = async (w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const x = c.getContext('2d')
  x.fillStyle = 'rgb(220,40,40)'; x.fillRect(0, 0, w / 2, h / 2)
  x.fillStyle = 'rgb(40,180,60)'; x.fillRect(w / 2, 0, w / 2, h / 2)
  x.fillStyle = 'rgb(40,70,220)'; x.fillRect(0, h / 2, w / 2, h / 2)
  x.fillStyle = 'rgb(230,200,30)'; x.fillRect(w / 2, h / 2, w / 2, h / 2)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const img = new Image()
  img.src = URL.createObjectURL(blob)
  await img.decode()
  return img
}`
const RED = [220, 40, 40]
const GREEN = [40, 180, 60]
const BLUE = [40, 70, 220]
const YELLOW = [230, 200, 30]
const WHITE = [255, 255, 255]

/** The screen's pixels in `clip`, decoded in the page as `window.__shot` (an ImageData). */
async function shotIntoPage(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  const png = (await page.screenshot({ clip })).toString('base64')
  await page.evaluate(async (png) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    ;(window as unknown as { __shot: ImageData }).__shot = ctx.getImageData(0, 0, c.width, c.height)
  }, png)
}

const sampleShot = (page: Page, points: ReadonlyArray<{ x: number; y: number }>) =>
  page.evaluate((points) => {
    const shot = (window as unknown as { __shot: ImageData }).__shot
    return points.map((p) => Array.from(shot.data.slice((p.y * shot.width + p.x) * 4, (p.y * shot.width + p.x) * 4 + 3)))
  }, points)

const near = (a: number[], b: number[], tol = 12) => a.length >= 3 && a.slice(0, 3).every((v, i) => Math.abs(v - b[i]!) <= tol)

test('cropped-image-wrapper-clips-and-crop-mode-reveals-original', async ({ page }) => {
  await openHarness(page)
  await page.addScriptTag({ content: QUADRANTS })
  const setup = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const { sourceToScene, uncroppedPlacement } = (await load('/src/model/crop.ts')) as typeof import('../src/model/crop.ts')
    const img = await (window as unknown as { __quadrants: (w: number, h: number) => Promise<HTMLImageElement> }).__quadrants(200, 160)
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;background:#fff'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: (id) => (id === 'a' ? img : undefined) })
    ;(window as unknown as { __layer: unknown }).__layer = layer
    layer.mount(host)
    // Turned, scaled and zoomed; the crop keeps source (60, 30) 120 × 100: parts of all four quadrants.
    const rec = { type: 'image' as const, id: 'i', assetId: 'a', left: 300, top: 150, angle: 30, scaleX: 1.5, scaleY: 1.5, crop: { x: 60, y: 30, width: 120, height: 100 } }
    const view = { zoom: 1.25, panX: -120, panY: -60 }
    layer.setRecords({ frames: [], objects: [rec] })
    layer.setViewport(view)
    const el = layer.elementOf('i')!
    const inner = el.querySelector('img')!
    // Where the whole original lies (crop.ts, as crop mode places it), and its colour at a source pixel.
    const full = uncroppedPlacement(rec, rec.crop)
    const points = [
      { u: 80, v: 50, inside: true }, { u: 150, v: 50, inside: true }, { u: 80, v: 110, inside: true }, { u: 160, v: 120, inside: true },
      { u: 20, v: 15, inside: false }, { u: 190, v: 10, inside: false }, { u: 30, v: 150, inside: false }, { u: 190, v: 150, inside: false },
    ].map((p) => {
      const s = sourceToScene({ x: p.u, y: p.v }, full)
      return { ...p, x: Math.round(s.x * view.zoom + view.panX), y: Math.round(s.y * view.zoom + view.panY) }
    })
    return { points, overflow: getComputedStyle(el).overflow, box: [el.style.width, el.style.height], innerTransform: inner.style.transform, innerSize: [inner.style.width, inner.style.height] }
  })
  const colourOf = (p: { u: number; v: number }) => (p.v < 80 ? (p.u < 100 ? RED : GREEN) : p.u < 100 ? BLUE : YELLOW)
  // The wrapper is the cropped box and clips; the original inside it is moved by the crop's corner.
  expect(setup.overflow).toBe('hidden')
  expect(setup.box).toEqual(['120px', '100px'])
  expect(setup.innerSize).toEqual(['200px', '160px'])
  expect(setup.innerTransform).toBe('translate(-60px, -30px)')

  const clip = { x: 0, y: 0, width: 900, height: 700 }
  const reveal = (on: boolean) => page.evaluate((on) => (window as unknown as { __layer: { revealUncropped(id: string, on: boolean): void } }).__layer.revealUncropped('i', on), on)

  await shotIntoPage(page, clip)
  const idle = await sampleShot(page, setup.points)
  setup.points.forEach((p, i) => expect(near(idle[i]!, p.inside ? colourOf(p) : WHITE), `idle (${p.u}, ${p.v}): ${idle[i]}`).toBe(true))

  await reveal(true)
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.scene-image')!).overflow)).toBe('visible')
  await shotIntoPage(page, clip)
  const revealed = await sampleShot(page, setup.points)
  // The whole original, every pixel where crop mode shows it: the kept part has not moved.
  setup.points.forEach((p, i) => expect(near(revealed[i]!, colourOf(p)), `revealed (${p.u}, ${p.v}): ${revealed[i]}`).toBe(true))

  await reveal(false)
  await shotIntoPage(page, clip)
  const again = await sampleShot(page, setup.points)
  setup.points.forEach((p, i) => expect(near(again[i]!, p.inside ? colourOf(p) : WHITE), `clipped again (${p.u}, ${p.v}): ${again[i]}`).toBe(true))
})

test('dom-card-measurer-ignores-zoom-and-rotation', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const { createObject } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
    type TextRecord = import('../src/model/types.ts').TextRecord
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:700px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    const recs: TextRecord[] = [
      { type: 'text', id: 'click', left: 100, top: 80, angle: 0, width: 233, fontSize: 17, text: 'Fractional heights\nA paragraph of 17 px text gives lines of a fractional height, so the card is a fractional height too.', headings: [2] },
      { type: 'text', id: 'drawn', left: 400, top: 80, angle: 0, width: 150, fontSize: 21, minHeight: 30, text: 'Drawn 👩‍👩‍👧‍👦 box with an overlongunbreakableword inside' },
    ]
    const results = []
    for (const rec of recs) {
      layer.setRecords({ frames: [], objects: [rec] })
      layer.setViewport({ zoom: 1, panX: 0, panY: 0 })
      const base = layer.measureCard(rec.id)!
      const fabric = createObject(rec, () => undefined) as unknown as { height: number; dynamicMinWidth: number }
      const runs = []
      for (const [zoom, angle] of [[0.5, 45], [2, 45], [0.5, 0], [2, -30], [1.37, 17]] as const) {
        layer.updateItem({ ...rec, angle })
        layer.setViewport({ zoom, panX: 50, panY: -20 })
        const m = layer.measureCard(rec.id)!
        runs.push({ zoom, angle, height: m.height, minWidth: m.minWidth, transformedBox: layer.bodyOf(rec.id)!.getBoundingClientRect().height })
      }
      // A culled card is brought back for the measurement, and culled again after it.
      layer.updateItem(rec)
      layer.setViewport({ zoom: 1, panX: -20000, panY: 0 })
      layer.cull({ width: 1000, height: 700 })
      const culled = layer.isCulled(rec.id)
      const whileCulled = layer.measureCard(rec.id)!
      results.push({ id: rec.id, base, fabricHeight: fabric.height, fabricMinWidth: fabric.dynamicMinWidth, runs, culled, whileCulled, stillCulled: layer.isCulled(rec.id) })
    }
    return results
  })
  for (const r of out) {
    console.log(`${r.id}: height ${r.base.height} (Fabric ${r.fabricHeight.toFixed(3)}), min width ${r.base.minWidth} (Fabric ${r.fabricMinWidth.toFixed(3)})`)
    expect(r.base.height).toBeGreaterThan(30)
    expect(r.base.height % 1, 'a fractional height is kept').not.toBe(0)
    expect(Math.abs(r.base.height - r.fabricHeight), r.id).toBeLessThanOrEqual(0.1)
    expect(Math.abs(r.base.minWidth - r.fabricMinWidth), r.id).toBeLessThan(0.5)
    for (const run of r.runs) {
      // The same untransformed numbers at every zoom and angle...
      expect(run.height, `${r.id} at ${run.zoom}x ${run.angle}°`).toBe(r.base.height)
      expect(run.minWidth, `${r.id} at ${run.zoom}x ${run.angle}°`).toBe(r.base.minWidth)
    }
    // ...where the transformed bounding box (what must never be used) changes with both.
    expect(new Set(r.runs.map((run) => Math.round(run.transformedBox))).size).toBeGreaterThan(3)
    expect(r.culled).toBe(true)
    expect(r.whileCulled).toEqual(r.base)
    expect(r.stillCulled).toBe(true)
  }
})

test('bitmap-compositor-preserves-text-image-text-z-order-and-crop', async ({ page }) => {
  await openHarness(page)
  await page.addScriptTag({ content: QUADRANTS })
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { renderFrameToCanvas } = (await load('/src/editor/renderFrameBitmap.ts')) as typeof import('../src/editor/renderFrameBitmap.ts')
    const { renderFramePreview } = (await load('/src/editor/framePreview.ts')) as typeof import('../src/editor/framePreview.ts')
    type Scene = import('../src/model/types.ts').Scene
    const img = await (window as unknown as { __quadrants: (w: number, h: number) => Promise<HTMLImageElement> }).__quadrants(200, 160)
    const getImage = (id: string) => (id === 'q' ? img : undefined)
    // Text A (red box), then image I cropped to its green quadrant overlapping A, then text B (blue box) overlapping I,
    // then texts C and D alone on the paper; a second image whose bytes are missing is left out.
    const scene: Scene = {
      frames: [{ id: 'f', name: 'F', left: 0, top: 0, width: 400, height: 300 }],
      objects: [
        { type: 'text', id: 'A', left: 20, top: 40, angle: 0, width: 200, fontSize: 28, minHeight: 100, text: 'Ag', captionBackground: '#ff0000' },
        { type: 'image', id: 'I', assetId: 'q', left: 150, top: 60, angle: 0, scaleX: 1, scaleY: 1, crop: { x: 100, y: 0, width: 100, height: 80 } },
        { type: 'image', id: 'M', assetId: 'missing', left: 0, top: 0, angle: 0, scaleX: 1, scaleY: 1 },
        { type: 'text', id: 'B', left: 220, top: 100, angle: 0, width: 150, fontSize: 24, minHeight: 80, text: 'Bg', captionBackground: '#0000ff' },
        { type: 'text', id: 'C', left: 40, top: 195, angle: 0, width: 350, fontSize: 24, text: 'Hamburgefonts', headings: [1] },
        // A word wider than its box, as on a board saved before the box was widened: not clipped.
        { type: 'text', id: 'D', left: 40, top: 262, angle: 0, width: 100, fontSize: 20, text: 'Hamburgefonts' },
      ],
    }
    const canvas = await renderFrameToCanvas(scene, 'f', { getImage })
    const ctx = canvas.getContext('2d')!
    const s = canvas.width / 400
    const px = (x: number, y: number) => Array.from(ctx.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data.slice(0, 3))
    const inkBox = (data: ImageData, x0: number, y0: number, x1: number, y1: number) => {
      let top = Infinity, bottom = -1, left = Infinity, right = -1, n = 0
      for (let y = Math.round(y0 * s); y < Math.round(y1 * s); y++) {
        for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) {
          const i = (y * data.width + x) * 4
          if (data.data[i]! > 90 || data.data[i + 1]! > 90 || data.data[i + 2]! > 90) continue
          n++
          top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x)
        }
      }
      return { n, top: top / s, bottom: (bottom + 1) / s, left: left / s, right: (right + 1) / s }
    }
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const all = ctx.getImageData(0, 0, canvas.width, canvas.height)
    // The shipped preview (Fabric) of texts C and D alone, for where their ink lies.
    const fabricPng = await renderFramePreview({ frames: scene.frames, objects: scene.objects.slice(4) }, 'f', getImage)
    const fabricImg = new Image()
    fabricImg.src = fabricPng
    await fabricImg.decode()
    const fc = document.createElement('canvas')
    fc.width = fabricImg.naturalWidth
    fc.height = fabricImg.naturalHeight
    fc.getContext('2d')!.drawImage(fabricImg, 0, 0)
    const fabricData = fc.getContext('2d')!.getImageData(0, 0, fc.width, fc.height)
    return {
      size: [canvas.width, canvas.height],
      blob: blob ? { size: blob.size, type: blob.type } : null,
      dataUrl: canvas.toDataURL('image/png').slice(0, 21),
      onlyA: px(100, 125),
      aUnderI: px(180, 100),
      iUnderB: px(235, 125),
      onlyI: px(240, 75),
      onlyB: px(320, 165),
      paper: px(380, 280),
      cropCorner: px(155, 65),
      inkA: inkBox(all, 20, 40, 120, 100).n,
      inkBOverI: inkBox(all, 220, 100, 250, 140).n,
      inkC: inkBox(all, 30, 190, 399, 258),
      fabricInkC: inkBox(fabricData, 30, 190, 399, 258),
      inkD: inkBox(all, 30, 258, 399, 299),
      fabricInkD: inkBox(fabricData, 30, 258, 399, 299),
    }
  })
  expect(out.size).toEqual([800, 600])
  // Not tainted: it encodes and reads back.
  expect(out.blob?.type).toBe('image/png')
  expect(out.blob!.size).toBeGreaterThan(2000)
  expect(out.dataUrl).toBe('data:image/png;base64')
  expect(near(out.onlyA, [255, 0, 0]), `A ${out.onlyA}`).toBe(true)
  expect(near(out.aUnderI, GREEN), `I in front of A ${out.aUnderI}`).toBe(true)
  expect(near(out.iUnderB, [0, 0, 255]), `B in front of I ${out.iUnderB}`).toBe(true)
  expect(near(out.onlyI, GREEN), `I ${out.onlyI}`).toBe(true)
  expect(near(out.onlyB, [0, 0, 255]), `B ${out.onlyB}`).toBe(true)
  expect(near(out.paper, WHITE), `paper ${out.paper}`).toBe(true)
  // The crop: the image's corner shows its kept (green) quadrant, not the original's red corner.
  expect(near(out.cropCorner, GREEN), `crop ${out.cropCorner}`).toBe(true)
  // Each text is drawn over its own box, and B's glyphs over the image.
  expect(out.inkA).toBeGreaterThan(50)
  expect(out.inkBOverI).toBeGreaterThan(20)
  // Texts C and D: their ink where Fabric draws it, within a device pixel.
  console.log('ink of C, compositor', JSON.stringify(out.inkC), 'Fabric', JSON.stringify(out.fabricInkC))
  console.log('ink of D, compositor', JSON.stringify(out.inkD), 'Fabric', JSON.stringify(out.fabricInkD))
  for (const [ours, fabric] of [[out.inkC, out.fabricInkC], [out.inkD, out.fabricInkD]] as const) {
    expect(ours.n).toBeGreaterThan(100)
    for (const side of ['top', 'bottom', 'left', 'right'] as const) expect(Math.abs(ours[side] - fabric[side]), side).toBeLessThanOrEqual(0.5)
  }
})

test('a card shows the same height and lines static and with the live editor mounted in it (0 px)', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const { createEditSession } = (await load('/src/editor/textSession.ts')) as typeof import('../src/editor/textSession.ts')
    type TextRecord = import('../src/model/types.ts').TextRecord
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    const recs: TextRecord[] = [
      { type: 'text', id: 'rich', left: 40, top: 40, angle: 0, width: 280, fontSize: 18, text: 'A heading\n\nEmpty above, then a paragraph that wraps across lines with bold and a font.\n\nSmaller heading\n', headings: [1, 0, 0, 0, 3], spans: [{ start: 50, end: 54, bold: true }, { start: 61, end: 65, font: 'serif', italic: true }] },
      { type: 'text', id: 'centred', left: 40, top: 40, angle: 0, width: 220, fontSize: 22, font: 'hand', align: 'center', text: 'Centred hand lettering that wraps\nand a second line', headings: [2] },
      { type: 'text', id: 'drawn', left: 40, top: 40, angle: 0, width: 160, fontSize: 16, minHeight: 120, text: 'Drawn box   with spaces and an overlongunbreakablewordhere', color: '#3f9a6b' },
    ]
    const geometry = (body: HTMLElement) => {
      const b = body.getBoundingClientRect()
      return {
        height: parseFloat(getComputedStyle(body).height),
        blocks: Array.from(body.children).map((el) => {
          const r = el.getBoundingClientRect()
          return [+(r.top - b.top).toFixed(3), +r.height.toFixed(3), +(r.right - b.left).toFixed(3)]
        }),
        lastGlyphs: Array.from(body.children).map((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0)
          const last = rects[rects.length - 1]
          return last ? [+(last.right - b.left).toFixed(3), +(last.top - b.top).toFixed(3)] : null
        }),
      }
    }
    const results = []
    for (const rec of recs) {
      layer.setRecords({ frames: [], objects: [rec] })
      layer.setViewport({ zoom: 1, panX: 0, panY: 0 })
      const body = layer.bodyOf(rec.id)!
      const before = geometry(body)
      const session = createEditSession(rec)!
      const view = session.mount(body)
      layer.setEditing(rec.id)
      const editing = geometry(body)
      const mountedInPlace = view.dom === body && body.classList.contains('ProseMirror') && body.classList.contains('yuriful-prose')
      // Turned and zoomed while editing: still the same untransformed height.
      layer.updateItem({ ...rec, angle: 30 })
      layer.setViewport({ zoom: 2, panX: 100, panY: 0 })
      const editingTurned = parseFloat(getComputedStyle(body).height)
      layer.updateItem(rec)
      layer.setViewport({ zoom: 1, panX: 0, panY: 0 })
      session.finish()
      layer.setEditing(null)
      const after = geometry(body)
      results.push({ id: rec.id, before, editing, editingTurned, after, mountedInPlace, leftovers: body.className + (body.hasAttribute('contenteditable') ? ' contenteditable' : '') })
    }
    return results
  })
  for (const r of out) {
    expect(r.mountedInPlace, r.id).toBe(true)
    expect(r.editing.height - r.before.height, `${r.id}: height on entering the edit`).toBe(0)
    expect(r.editingTurned - r.before.height, `${r.id}: height while turned and zoomed`).toBe(0)
    expect(r.after.height - r.before.height, `${r.id}: height on leaving the edit`).toBe(0)
    expect(r.editing.blocks, r.id).toEqual(r.before.blocks)
    expect(r.editing.lastGlyphs, r.id).toEqual(r.before.lastGlyphs)
    expect(r.after, r.id).toEqual(r.before)
    expect(r.leftovers, r.id).toBe('scene-text-body yuriful-prose' + (r.id === 'drawn' ? ' is-drawn' : r.id === 'centred' ? ' is-center' : ''))
  }
})


// ---- review findings on e802163 -----------------------------------------------------------------

test('typography matches the canvas with tabs, and with a word wider than its click-created box', async ({ page }) => {
  test.setTimeout(180_000)
  await openHarness(page)
  const base = { type: 'text', left: 0, top: 0, angle: 0 }
  const recs: Array<Record<string, unknown>> = [
    { ...base, id: 'tabs', fontSize: 24, width: 120, text: 'A\tB\tC' },
    { ...base, id: 'tabs drawn', fontSize: 24, width: 120, minHeight: 0, text: 'A\tB\tC' },
    { ...base, id: 'tabs wrapping', fontSize: 18, width: 200, text: 'Tab\tseparated\twords that wrap\tacross lines\tagain and again' },
    { ...base, id: 'tabs wrapping drawn', fontSize: 18, width: 200, minHeight: 0, text: 'Tab\tseparated\twords that wrap\tacross lines\tagain and again' },
    { ...base, id: 'tabs centred', fontSize: 18, width: 260, align: 'center', text: 'Centred\ttab\tline\nand\ta second' },
    { ...base, id: 'tabs in a heading', fontSize: 16, width: 300, text: 'Head\ting\nbody\ttext', headings: [1] },
    // 30 Ms at 18 px are about 480 px wide: Fabric widens the 110 px box to the word, keeping its left edge.
    { ...base, id: 'wide caption', fontSize: 18, width: 110, captionBackground: '#fff3c4', text: 'M'.repeat(30) },
    { ...base, id: 'wide right', fontSize: 18, width: 110, align: 'right', text: `${'M'.repeat(30)} short` },
    { ...base, id: 'wide centred', fontSize: 18, width: 110, align: 'center', text: `${'M'.repeat(20)} tail words here` },
    { ...base, id: 'wide heading', fontSize: 12, width: 60, text: 'Heading Supercalifragilistic\nbody', headings: [1] },
  ]
  const cases = await compareTypography(page, recs)
  const rs = residuals(cases)
  report(rs, cases)
  expectMatch(rs)
  // The over-wide boxes really are drawn wider than stored, as Fabric draws them.
  for (const name of ['wide caption', 'wide right', 'wide centred', 'wide heading']) {
    const c = cases.find((x) => x.name === name)!
    expect(c.domWidth, name).toBeGreaterThan(Number(recs.find((r) => r.id === name)!.width) + 50)
  }
})

test('underline and strikethrough sit where Fabric draws them, in every font, on a paragraph and a heading', async ({ page }) => {
  test.setTimeout(180_000)
  await openHarness(page)
  await page.setViewportSize({ width: 1280, height: 1000 })
  const results: Array<{ name: string; line: number; fabric: number[]; dom: number[] }> = []
  for (const font of FONTS) {
    for (const mark of ['underline', 'strike'] as const) {
      const text = 'x x x\nx x x'
      const rec = { type: 'text', id: `${font} ${mark}`, left: 0, top: 0, angle: 0, width: 300, fontSize: 32, text, headings: [0, 2], spans: [{ start: 0, end: text.length, [mark]: true }], ...(font === 'sans' ? {} : { font }) }
      const prepared = await page.evaluate(async (rec) => {
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
        const { createObject } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
        const { renderFramePreview } = (await load('/src/editor/framePreview.ts')) as typeof import('../src/editor/framePreview.ts')
        const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
        const text = rec as unknown as import('../src/model/types.ts').TextRecord
        const tb = createObject(text, () => undefined) as unknown as { height: number; _textLines: string[][]; getHeightOfLine(i: number): number }
        const margin = 20
        const scale = 2
        const frame = { id: 'f', name: '', left: -margin, top: -margin, width: text.width + 2 * margin, height: Math.ceil(tb.height) + 2 * margin }
        const bands: Array<[number, number]> = []
        let y = 0
        tb._textLines.forEach((_, i) => {
          bands.push([Math.round((y + margin) * scale), Math.round((y + tb.getHeightOfLine(i) + margin) * scale)])
          y += tb.getHeightOfLine(i)
        })
        const png = await renderFramePreview({ frames: [frame], objects: [text] }, 'f', () => undefined)
        document.querySelector('#harness')?.remove()
        const host = document.createElement('div')
        host.id = 'harness'
        host.style.cssText = `position:fixed;left:0;top:0;width:${frame.width * scale}px;height:${frame.height * scale}px;background:#fff;overflow:hidden`
        document.body.append(host)
        const layer = new SceneLayer({ getImage: () => undefined })
        layer.mount(host)
        layer.setRecords({ frames: [frame], objects: [text] })
        layer.setViewport({ zoom: scale, panX: margin * scale, panY: margin * scale })
        // The middle of the first space of each line: only the decoration is drawn there.
        const columns = Array.from(layer.bodyOf(text.id)!.children).map((block) => {
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = (n as Text).data.indexOf(' ')
            if (i < 0) continue
            const r = document.createRange()
            r.setStart(n, i)
            r.setEnd(n, i + 1)
            const box = r.getBoundingClientRect()
            return Math.round((box.left + box.right) / 2)
          }
          return 0
        })
        return { png, bands, columns, size: [frame.width * scale, frame.height * scale] }
      }, rec)
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: prepared.size[0]!, height: prepared.size[1]! } })
      const rows = await page.evaluate(
        async ({ prepared, shot }) => {
          const pixels = async (src: string) => {
            const img = new Image()
            img.src = src
            await img.decode()
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            c.getContext('2d')!.drawImage(img, 0, 0)
            return c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
          }
          const dark = (data: ImageData, x: number, y0: number, y1: number) => {
            const out: number[] = []
            for (let y = y0; y < y1; y++) {
              const i = (y * data.width + x) * 4
              if (0.299 * data.data[i]! + 0.587 * data.data[i + 1]! + 0.114 * data.data[i + 2]! < 128) out.push(y)
            }
            return out
          }
          const fab = await pixels(prepared.png)
          const dom = await pixels(`data:image/png;base64,${shot}`)
          return prepared.bands.map(([y0, y1], i) => ({ fabric: dark(fab, prepared.columns[i]!, y0, y1), dom: dark(dom, prepared.columns[i]!, y0, y1) }))
        },
        { prepared, shot: shot.toString('base64') },
      )
      rows.forEach((r, line) => results.push({ name: rec.id, line, ...r }))
    }
  }
  for (const r of results) console.log(`${r.name.padEnd(18)} line ${r.line}: Fabric rows ${r.fabric[0]}–${r.fabric.at(-1)}, DOM rows ${r.dom[0]}–${r.dom.at(-1)} (device px at 2x)`)
  for (const r of results) {
    expect(r.fabric.length, `${r.name} ${r.line}: Fabric draws it`).toBeGreaterThan(0)
    expect(r.dom.length, `${r.name} ${r.line}: the layer draws it`).toBeGreaterThan(0)
    // Within one CSS pixel (2 device pixels at 2x), at both edges: Chromium rounds a decoration's
    // offset and thickness to whole CSS pixels, Fabric draws them where they fall.
    expect(Math.abs(r.dom[0]! - r.fabric[0]!), `${r.name} line ${r.line}: top`).toBeLessThanOrEqual(2)
    expect(Math.abs(r.dom.at(-1)! - r.fabric.at(-1)!), `${r.name} line ${r.line}: bottom`).toBeLessThanOrEqual(2)
  }
})

test('updating the edited card leaves the live editor alone: its text, its selection, and where the next key goes', async ({ page }) => {
  await openHarness(page)
  const before = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const { createEditSession } = (await load('/src/editor/textSession.ts')) as typeof import('../src/editor/textSession.ts')
    type TextRecord = import('../src/model/types.ts').TextRecord
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:600px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    const rec: TextRecord = { type: 'text', id: 't', left: 100, top: 100, angle: 0, width: 300, fontSize: 24, text: 'alpha beta gamma' }
    layer.setRecords({ frames: [], objects: [rec] })
    const body = layer.bodyOf('t')!
    const session = createEditSession(rec)!
    const view = session.mount(body)
    layer.setEditing('t')
    view.focus()
    session.select(6, 10) // "beta"
    const textNode = body.querySelector('p')!.firstChild
    // The board moves the card (an angle) and restyles it while it is edited; the record even says
    // something else (as a stale record might).
    layer.updateItem({ ...rec, angle: 30, color: '#c4372f', text: 'something else entirely' })
    const w = window as unknown as { __session: typeof session; __layer: typeof layer; __rec: TextRecord }
    w.__session = session
    w.__layer = layer
    w.__rec = rec
    const sel = view.state.selection
    return {
      selection: [sel.from, sel.to],
      text: body.textContent,
      sameTextNode: body.querySelector('p')!.firstChild === textNode && textNode!.isConnected,
      domSelection: document.getSelection()!.toString(),
      transformed: layer.elementOf('t')!.style.transform !== 'matrix(1, 0, 0, 1, 100, 100)',
      colour: body.style.color,
    }
  })
  expect(before.selection).toEqual([7, 11])
  expect(before.text).toBe('alpha beta gamma')
  expect(before.sameTextNode).toBe(true)
  expect(before.domSelection).toBe('beta')
  expect(before.transformed).toBe(true)
  expect(before.colour).toBe('rgb(196, 55, 47)')
  await page.keyboard.type('X')
  const after = await page.evaluate(() => {
    const w = window as unknown as {
      __session: { content(): { text: string }; finish(): void }
      __layer: { setEditing(id: string | null): void; bodyOf(id: string): HTMLElement | undefined; updateItem(rec: unknown): void }
      __rec: Record<string, unknown>
    }
    const typed = w.__session.content().text
    // Ending the edit: finish the session, then the card is rendered again from its record.
    w.__session.finish()
    w.__layer.updateItem({ ...w.__rec, text: typed })
    w.__layer.setEditing(null)
    return { typed, shown: w.__layer.bodyOf('t')!.textContent, editable: w.__layer.bodyOf('t')!.isContentEditable }
  })
  expect(after.typed).toBe('alpha X gamma')
  expect(after.shown).toBe('alpha X gamma')
  expect(after.editable).toBe(false)
})

test('a card measured again keeps its new size, and culling uses it', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    const text = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}`).join('\n')
    layer.setRecords({ frames: [], objects: [{ type: 'text', id: 't', left: 0, top: 0, angle: 0, width: 300, fontSize: 16, text }] })
    const first = layer.heightOf('t')!
    // Laid out taller since (as after a wider font loaded): measured again.
    layer.bodyOf('t')!.style.fontSize = '32px'
    const measured = layer.measureCard('t')!.height
    // A view that shows only what lies below the first height, well past the culling margin.
    layer.setViewport({ zoom: 1, panX: 0, panY: -(first + 400) })
    layer.cull({ width: 800, height: 600 })
    return { first, measured, kept: layer.heightOf('t'), culled: layer.isCulled('t') }
  })
  expect(out.measured).toBeGreaterThan(out.first * 1.8)
  expect(out.kept).toBe(out.measured)
  expect(out.culled).toBe(false)
})

test('typography measured before the stylesheet is not kept, and a font that loads lays the cards out again', async ({ page }) => {
  await openBlank(page)
  // No stylesheet yet: nothing measured is kept.
  const early = await page.evaluate(async () => {
    const { baselineShift, spaceWidth } = (await import(/* @vite-ignore */ ['/src/editor', 'sceneLayer.ts'].join('/'))) as typeof import('../src/editor/sceneLayer.ts')
    return { shift: baselineShift('mono', 97), space: spaceWidth('mono') }
  })
  await page.evaluate(async () => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/src/styles.css'
    await new Promise((resolve) => {
      link.onload = resolve
      document.head.append(link)
    })
  })
  const out = await page.evaluate(async () => {
    const { SceneLayer, baselineShift, resetTypography, spaceWidth } = (await import(/* @vite-ignore */ ['/src/editor', 'sceneLayer.ts'].join('/'))) as typeof import('../src/editor/sceneLayer.ts')
    const later = { shift: baselineShift('mono', 97), space: spaceWidth('mono') }
    resetTypography()
    const fresh = { shift: baselineShift('mono', 97), space: spaceWidth('mono') }
    // A mounted card in the mono font, then a font that changes what "mono" draws with.
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:800px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => undefined })
    layer.mount(host)
    layer.setRecords({ frames: [], objects: [{ type: 'text', id: 't', left: 0, top: 0, angle: 0, width: 600, fontSize: 97, font: 'mono', text: 'Mono\ttext\nagain' }] })
    const body = layer.bodyOf('t')!
    const before = { shift: body.style.getPropertyValue('--yp-shift-0'), height: layer.heightOf('t') }
    const face = new FontFace('Consolas', 'local("Impact")')
    document.fonts.add(face)
    await face.load()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const after = { shift: body.style.getPropertyValue('--yp-shift-0'), height: layer.heightOf('t'), measured: layer.measureCard('t')!.height }
    resetTypography()
    const expected = `${baselineShift('mono', 97)}px`
    return { later, fresh, before, after, expected }
  })
  expect(early).toEqual({ shift: 0, space: 0.25 })
  expect(out.later).toEqual(out.fresh)
  expect(out.fresh.shift).not.toBe(0)
  expect(out.after.shift).not.toBe(out.before.shift)
  expect(out.after.shift).toBe(out.expected)
  expect(out.after.height).toBe(out.after.measured)
})

test('an image applied before it has decoded is sized once it has', async ({ page }) => {
  await openHarness(page)
  await page.addScriptTag({ content: QUADRANTS })
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const decoded = await (window as unknown as { __quadrants: (w: number, h: number) => Promise<HTMLImageElement> }).__quadrants(120, 80)
    const blob = await (await fetch(decoded.src)).blob()
    const img = new Image()
    img.src = URL.createObjectURL(blob) // not decoded yet
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px'
    document.body.append(host)
    const layer = new SceneLayer({ getImage: () => img })
    layer.mount(host)
    const rec = { type: 'image' as const, id: 'i', assetId: 'a', left: 10, top: 10, angle: 0, scaleX: 1, scaleY: 1 }
    layer.setRecords({ frames: [], objects: [rec] })
    const atFirst = { natural: img.naturalWidth, width: layer.elementOf('i')!.style.width }
    await img.decode()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    const loaded = layer.elementOf('i')!.style.width
    layer.setRecords({ frames: [], objects: [rec] })
    return { atFirst, loaded, again: layer.elementOf('i')!.style.width, height: layer.elementOf('i')!.style.height }
  })
  console.log(JSON.stringify(out))
  expect(out.atFirst.natural).toBe(0)
  expect(out.loaded).toBe('120px')
  expect(out.again).toBe('120px')
  expect(out.height).toBe('80px')
})

/** A two-frame animated GIF, 1 × 1: red, then blue, 200 ms each, looping; and the same with only its first frame. */
function gifBytes(frames: 1 | 2): number[] {
  const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0xff, 0, 0, 0, 0, 0xff]
  const loop = [0x21, 0xff, 0x0b, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 3, 1, 0, 0, 0]
  const frame = (lzw: number) => [0x21, 0xf9, 4, 0, 20, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, lzw, 1, 0]
  return [...head, ...(frames === 2 ? loop : []), ...frame(0x44), ...(frames === 2 ? frame(0x4c) : []), 0x3b]
}

test('an animated GIF stays still on the board, from its first-frame still; still images are never re-encoded', async ({ page }) => {
  test.setTimeout(60_000)
  await openHarness(page)
  const out = await page.evaluate(
    async ({ two, one }) => {
      const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
      const { SceneLayer } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
      const { stillFrame } = (await load('/src/editor/stillImage.ts')) as typeof import('../src/editor/stillImage.ts')
      const decode = async (bytes: number[]) => {
        const img = new Image()
        img.src = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/gif' }))
        await img.decode()
        return img
      }
      const animated = await decode(two)
      const single = await decode(one)
      const still = await stillFrame({ bytes: new Uint8Array(two).buffer, type: 'image/gif' }, animated)
      const singleStill = await stillFrame({ bytes: new Uint8Array(one).buffer, type: 'image/gif' }, single)
      const jpegStill = await stillFrame({ bytes: new ArrayBuffer(8), type: 'image/jpeg' }, single)
      const stillUrl = still ? URL.createObjectURL(still) : undefined
      // Two layers side by side, the animated GIF scaled up to 100 × 100: with the still, and without it.
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px;background:#fff'
      document.body.append(host)
      const make = (left: number, getStill?: (id: string) => string | undefined) => {
        const box = document.createElement('div')
        box.style.cssText = `position:absolute;left:${left}px;top:0;width:150px;height:150px`
        host.append(box)
        const layer = new SceneLayer({ getImage: () => animated, ...(getStill && { getStill }) })
        layer.mount(box)
        layer.setRecords({ frames: [], objects: [{ type: 'image', id: 'g', assetId: 'g', left: 10, top: 10, angle: 0, scaleX: 100, scaleY: 100 }] })
      }
      make(0, () => stillUrl)
      make(200)
      return { still: still ? { type: still.type, size: still.size } : null, singleStill, jpegStill }
    },
    { two: gifBytes(2), one: gifBytes(1) },
  )
  expect(out.still?.type).toBe('image/png')
  expect(out.singleStill).toBeNull()
  expect(out.jpegStill).toBeNull()
  // Sampled over more than two animation cycles.
  const withStill: number[][] = []
  const without: number[][] = []
  for (let i = 0; i < 10; i++) {
    await shotIntoPage(page, { x: 0, y: 0, width: 400, height: 200 })
    const [a, b] = await sampleShot(page, [{ x: 60, y: 60 }, { x: 260, y: 60 }])
    withStill.push(a!)
    without.push(b!)
    await page.waitForTimeout(110)
  }
  console.log('with the still', JSON.stringify(withStill), 'without', JSON.stringify(without))
  for (const px of withStill) expect(near(px, [255, 0, 0]), `still ${px}`).toBe(true)
  // The control: the same GIF in a plain <img> plays.
  expect(without.some((px) => near(px, [0, 0, 255]))).toBe(true)
})

test('a card with characters XML cannot hold still draws, and one card that cannot be drawn does not stop the frame', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { renderFrameToCanvas } = (await load('/src/editor/renderFrameBitmap.ts')) as typeof import('../src/editor/renderFrameBitmap.ts')
    // Any card whose SVG mentions FAILME refuses to decode, as an SVG a browser rejects would.
    const decode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return decodeURIComponent(this.src).includes('FAILME') ? Promise.reject(new DOMException('refused', 'EncodingError')) : decode.call(this)
    }
    type Scene = import('../src/model/types.ts').Scene
    const scene: Scene = {
      frames: [{ id: 'f', name: 'F', left: 0, top: 0, width: 400, height: 300 }],
      objects: [
        { type: 'text', id: 'bad', left: 20, top: 20, angle: 0, width: 360, fontSize: 24, text: 'Nul \u0000 one \u0001 tab-v \u000b lone \ud800 end' },
        { type: 'text', id: 'refused', left: 20, top: 100, angle: 0, width: 360, fontSize: 24, text: 'FAILME FAILME' },
        { type: 'text', id: 'plain', left: 20, top: 180, angle: 0, width: 360, fontSize: 24, text: 'Plain text' },
      ],
    }
    try {
      const canvas = await renderFrameToCanvas(scene, 'f', { getImage: () => undefined })
      const ctx = canvas.getContext('2d')!
      const s = canvas.width / 400
      const ink = (x: number, y: number, w: number, h: number) => {
        const d = ctx.getImageData(x * s, y * s, w * s, h * s).data
        let n = 0
        for (let i = 0; i < d.length; i += 4) if (d[i]! < 100 && d[i + 1]! < 100 && d[i + 2]! < 100) n++
        return n
      }
      return { ok: true, bad: ink(20, 20, 360, 40), refused: ink(20, 100, 360, 40), plain: ink(20, 180, 360, 40) }
    } catch (e) {
      return { ok: false, error: String(e) }
    } finally {
      HTMLImageElement.prototype.decode = decode
    }
  })
  expect(out).toMatchObject({ ok: true })
  expect(out.bad).toBeGreaterThan(200)
  expect(out.refused).toBe(0)
  expect(out.plain).toBeGreaterThan(200)
})

test('mixed-direction text gets the minimum width Fabric gives it: bidi reordering does not widen a word', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { minCardWidth } = (await load('/src/editor/sceneLayer.ts')) as typeof import('../src/editor/sceneLayer.ts')
    const { createObject } = (await load('/src/editor/objects.ts')) as typeof import('../src/editor/objects.ts')
    const results = []
    for (const text of ['mix חדש 123 סוף!', 'abc שלום-עולם def', 'עברית English עברית']) {
      const rec = { type: 'text' as const, id: 't', left: 0, top: 0, angle: 0, width: 1000, fontSize: 24, text }
      const tb = createObject(rec, () => undefined) as unknown as { dynamicMinWidth: number }
      // What a bounding rectangle over each logical word gives (spanning the runs between its ends).
      const p = document.createElement('p')
      p.className = 'yuriful-prose'
      p.style.cssText = 'position:fixed;left:0;top:0;white-space:pre;font-size:24px;visibility:hidden'
      p.textContent = text
      document.body.append(p)
      const node = p.firstChild as Text
      const range = document.createRange()
      let union = 0
      let start = 0
      for (const word of text.split(' ')) {
        range.setStart(node, start)
        range.setEnd(node, start + word.length)
        union = Math.max(union, range.getBoundingClientRect().width)
        start += word.length + 1
      }
      p.remove()
      results.push({ text, ours: minCardWidth(rec), fabric: tb.dynamicMinWidth, union })
    }
    return results
  })
  for (const r of out) {
    console.log(`${r.text}: min width ${r.ours}, Fabric ${r.fabric.toFixed(2)}, bounding rectangles ${r.union.toFixed(2)}`)
    expect(Math.abs(r.ours - r.fabric), r.text).toBeLessThan(0.5)
  }
  // The trap is real: a logical range's rectangle spans the reordered runs between its ends.
  expect(out[0]!.union).toBeGreaterThan(out[0]!.ours + 50)
})

test('the bitmap draws a click-created card at its effective width: a caption wider than stored keeps all its background', async ({ page }) => {
  await openHarness(page)
  const out = await page.evaluate(async () => {
    const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path)
    const { renderFrameToCanvas } = (await load('/src/editor/renderFrameBitmap.ts')) as typeof import('../src/editor/renderFrameBitmap.ts')
    const { renderFramePreview } = (await load('/src/editor/framePreview.ts')) as typeof import('../src/editor/framePreview.ts')
    type Scene = import('../src/model/types.ts').Scene
    const scene: Scene = {
      frames: [{ id: 'f', name: 'F', left: 0, top: 0, width: 700, height: 120 }],
      objects: [
        { type: 'text', id: 'c', left: 20, top: 20, angle: 0, width: 110, fontSize: 18, captionBackground: '#00ff00', text: 'M'.repeat(30) },
        { type: 'text', id: 'r', left: 20, top: 60, angle: 0, width: 110, fontSize: 18, align: 'right', text: `${'M'.repeat(30)} short` },
      ],
    }
    const ours = await renderFrameToCanvas(scene, 'f', { getImage: () => undefined })
    const fabricImg = new Image()
    fabricImg.src = await renderFramePreview(scene, 'f', () => undefined)
    await fabricImg.decode()
    const fabric = document.createElement('canvas')
    fabric.width = fabricImg.naturalWidth
    fabric.height = fabricImg.naturalHeight
    fabric.getContext('2d')!.drawImage(fabricImg, 0, 0)
    const s = ours.width / 700
    // How far right the green background reaches on the caption's first line, and the right edge of "short".
    const greenRight = (c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, Math.round(30 * s), c.width, 1).data
      let right = -1
      for (let x = 0; x < c.width; x++) if (d[x * 4]! < 60 && d[x * 4 + 1]! > 200 && d[x * 4 + 2]! < 60) right = x
      return (right + 1) / s
    }
    const inkRight = (c: HTMLCanvasElement, y0: number, y1: number) => {
      const d = c.getContext('2d')!.getImageData(0, Math.round(y0 * s), c.width, Math.round((y1 - y0) * s)).data
      let right = -1
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 100 && d[i + 1]! < 100 && d[i + 2]! < 100) right = Math.max(right, (i / 4) % c.width)
      return (right + 1) / s
    }
    return {
      ours: { green: greenRight(ours), short: inkRight(ours, 82, 105) },
      fabric: { green: greenRight(fabric), short: inkRight(fabric, 82, 105) },
    }
  })
  console.log(JSON.stringify(out))
  expect(out.fabric.green).toBeGreaterThan(400)
  expect(Math.abs(out.ours.green - out.fabric.green)).toBeLessThanOrEqual(1)
  expect(out.fabric.short).toBeGreaterThan(400)
  expect(Math.abs(out.ours.short - out.fabric.short)).toBeLessThanOrEqual(1)
})
