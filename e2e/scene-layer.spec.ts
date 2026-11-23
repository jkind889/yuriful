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
  const block = css.match(/\/\* prose:start[^\n]*\n([\s\S]*?)\/\* prose:end \*\//)?.[1]
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
  expect(out.prose.trim()).toBe(block!.trim())
  expect(out.paper).toBe(out.fill)
})

type Ink = { top: number; bottom: number; left: number; right: number } | null

interface LineReport {
  line: number
  text: string
  fabric: Ink
  dom: Ink
}

interface TypographyCase {
  name: string
  fabricHeight: number
  domHeight: number
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
        height: number
        _textLines: string[][]
        getHeightOfLine(i: number): number
      }
      const margin = 20
      const frame = { id: 'f', name: '', left: -margin, top: -margin, width: text.width + 2 * margin, height: Math.ceil(tb.height) + 2 * margin }
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
      const domLines = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s.replace(/[ \t]+$/, ''))
      const fabricLines = tb._textLines.map((l) => l.join('').replace(/[ \t]+$/, '')).filter((l) => l !== '')
      return { png, frame, scale, margin, lineTops, pitches, fabricHeight: tb.height, domHeight, domLines, fabricLines, lines: tb._textLines.map((l) => l.join('')) }
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
        const s = prepared.scale
        return prepared.lineTops.map((t, i) => {
          const y0 = Math.round((t + prepared.margin) * s)
          const y1 = Math.round((t + prepared.pitches[i]! + prepared.margin) * s)
          return { line: i, text: prepared.lines[i]!, fabric: inkIn(fab, y0, y1), dom: inkIn(dom, y0, y1) }
        })
      },
      { prepared, shot: shot.toString('base64') },
    )
    out.push({ name: String(rec.id), fabricHeight: prepared.fabricHeight, domHeight: prepared.domHeight, fabricLines: prepared.fabricLines, domLines: prepared.domLines, lines })
  }
  return out
}

const FONTS = ['sans', 'serif', 'mono', 'hand', 'display'] as const

interface Residual {
  name: string
  /** DOM minus Fabric, scene px. */
  height: number
  wraps: boolean
  top: number[]
  bottom: number[]
  left: number[]
  right: number[]
}

function residuals(cases: TypographyCase[]): Residual[] {
  return cases.map((c) => {
    const both = c.lines.filter((l) => l.fabric && l.dom)
    return {
      name: c.name,
      height: +(c.domHeight - c.fabricHeight).toFixed(3),
      wraps: JSON.stringify(c.domLines) === JSON.stringify(c.fabricLines),
      top: both.map((l) => l.dom!.top - l.fabric!.top),
      bottom: both.map((l) => l.dom!.bottom - l.fabric!.bottom),
      left: both.map((l) => l.dom!.left - l.fabric!.left),
      right: both.map((l) => l.dom!.right - l.fabric!.right),
    }
  })
}

/** The residuals, one line per case (DOM minus Fabric, scene px), for the record. */
function report(rs: Residual[], cases: TypographyCase[]) {
  for (const r of rs) console.log(r.name.padEnd(16), 'height', String(r.height).padStart(7), 'wraps', r.wraps, '| top', r.top.join(','), '| bottom', r.bottom.join(','), '| left', r.left.join(','), '| right', r.right.join(','))
  for (const c of cases) if (JSON.stringify(c.domLines) !== JSON.stringify(c.fabricLines)) console.log(c.name, JSON.stringify(c.fabricLines), JSON.stringify(c.domLines))
}

/**
 * What the comparison allows, measured on Chromium: the box height within 0.1 px (Chromium
 * keeps line heights to 1/64 px), the same wrap points, and every line's ink within one device
 * pixel at 2x (0.5 scene px) of where Fabric draws it, on all four sides.
 */
function expectMatch(rs: Residual[]) {
  for (const r of rs) {
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
  ]
  const cases = await compareTypography(page, recs)
  const rs = residuals(cases)
  report(rs, cases)
  expectMatch(rs)
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
    // one `white-space: pre` run), and Fabric finds no wider word: at that width it does not widen the box.
    if (!r.marked) {
      expect(r.minWidth, r.token).toBeGreaterThanOrEqual(r.longest - 0.001)
      expect(r.minWidth - r.longest, r.token).toBeLessThan(0.011)
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

