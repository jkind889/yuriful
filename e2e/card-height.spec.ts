/**
 * Real-browser tests (real Fabric, real IndexedDB, the real text engine, real layout) for Slice 4:
 * a text box with a fixed height. Dragging its bottom handle fixes the height; text that does not
 * fit scrolls inside the box, with the wheel over it (a wheel gesture belongs to whatever it
 * started on), with fades at the ends and a thin thumb while it scrolls; Auto height, or a
 * double-click on the bottom handle, takes it back to growing with its words. Scrolling is view
 * state: never stored, never in history. There is no earlier canvas to compare these with: every
 * expectation is stated here.
 *
 * Wheel events with controlled timing are dispatched in the page as `WheelEvent`s at the pointer,
 * spaced by a busy wait (so the gaps inside a burst are exact); `page.mouse.wheel` is used where a
 * trusted wheel matters.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, dbVersion, decodePng, drag, editedText, fetchRetrying, openApp, openBlank, seedMilestone1, seedRaw, snapshotIdb, status, storedDoc } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredObject, View } from './helpers.ts'

// The platform's own scrollbars, as a person sees them (Playwright hides them by default): on Windows a
// scrollbar takes width from what it scrolls, which a fixed-height text must never let it do.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }
/** `WHEEL_LATCH_MS` in `src/editor/wheelGesture.ts`: a gap longer than this starts a new wheel gesture. */
const LATCH = 180
const NEW_GESTURE_MS = LATCH + 150
/**
 * How far (scene px) the caret's character keeps from an edge where the text fades. The editor keeps
 * the caret's line 20 px (the fade's length) from the edge; the character sits a little inside its
 * line, and a little higher (the baseline shift).
 */
const CARET_CLEAR = 18

/** Lines of a long review: one wraps in a 360-wide box at 18 px. */
const lines = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => (i === 2 ? `Line ${i + from}: a longer line of the review that has to wrap onto a second line in the box` : `Line ${i + from} of the review`)).join('\n')

const textRec = (id: string, left: number, top: number, extra: Record<string, unknown> = {}) => ({ type: 'text', id, left, top, angle: 0, text: lines(30), fontSize: 18, width: 360, ...extra })

type Block = Record<string, unknown>
const p = (text?: string): Block => (text ? { type: 'paragraph', content: [{ text }] } : { type: 'paragraph' })

interface CardProbe {
  state: () => { viewport: View; canUndo: boolean; canRedo: boolean; dirty: boolean; selected: string[]; editing: boolean; readOnly: string | null }
  select: (id: string) => void
  controls: () => Record<string, { x: number; y: number }> | null
  proxy: (id: string) => { width: number; height: number; angle: number; left: number; top: number } | null
  preview: (frameId: string) => Promise<string>
  /** A fixed-height card's exact scroll position, as the layer keeps it, and how far it can go. */
  scroll: (id: string) => { top: number; max: number } | null
}
declare global {
  interface Window {
    __cards: CardProbe
  }
}

/** A probe on the app's editor (this test route only): its state, selecting by id, the selected object's handles, a proxy's size, frame previews. */
async function installProbe(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    const response = await fetchRetrying(route)
    const source = await response.text()
    await route.fulfill({
      response,
      body: `
      import { Editor as CardsEditor } from '/src/editor/Editor.ts'
      import { idOf as cardsIdOf } from '/src/editor/objects.ts'
      const cardsInit = CardsEditor.prototype.init
      CardsEditor.prototype.init = function () {
        const ed = this
        window.__cards = {
          state: () => ({
            viewport: ed.getViewport(),
            canUndo: ed.history.canUndo,
            canRedo: ed.history.canRedo,
            dirty: ed.autosaver.hasUnsavedChanges,
            selected: ed.canvas.getActiveObjects().map((o) => cardsIdOf(o)),
            editing: ed.getState().editingText,
            readOnly: ed.getState().readOnly,
          }),
          select: (id) => ed.selectLayer(id),
          controls: () => {
            const a = ed.canvas.getActiveObject()
            if (!a) return null
            const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
            const out = {}
            for (const [k, c] of Object.entries(a.oCoords)) out[k] = { x: r.left + c.x, y: r.top + c.y }
            return out
          },
          proxy: (id) => {
            const o = ed.canvas.getObjects().find((x) => cardsIdOf(x) === id)
            return o ? { width: o.width, height: o.height, angle: o.angle, left: o.left, top: o.top } : null
          },
          scroll: (id) => ed.scene.layer.scrollOf(id),
          preview: async (frameId) => {
            ed.selectLayer(frameId)
            const tour = ed.startFrameTour()
            if (!tour) throw new Error('no tour')
            return tour.renderFrame(frameId, new AbortController().signal)
          },
        }
        return cardsInit.call(this)
      }
      ${source}
    `,
    })
  })
}

/** Opens a board: version 1 as milestone 1 wrote it for plain texts without frames, version 2 with frames, version 3 with a rich field. */
async function open(page: Page, objects: unknown[], opts: { frames?: unknown[]; view?: View; assets?: SeedAsset[]; appearance?: unknown } = {}) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openBlank(page)
  const frames = opts.frames ?? []
  const viewport = opts.view ?? UNIT
  const rich = objects.some((o) => (o as { blocks?: unknown; height?: unknown }).blocks !== undefined || (o as { height?: unknown }).height !== undefined)
  const extra = opts.appearance ? { appearance: opts.appearance } : {}
  if (rich) await seedRaw(page, 3, { version: 3, title: 'Heights', frames, objects, viewport, ...extra }, opts.assets)
  else if (frames.length > 0 || opts.assets) await seedRaw(page, 2, { version: 2, title: 'Heights', frames, objects, viewport, ...extra }, opts.assets)
  else await seedMilestone1(page, { version: 1, title: 'Heights', objects, viewport })
  await installProbe(page)
  await openApp(page)
  return { errors }
}

const probe = (page: Page) => page.evaluate(() => window.__cards.state())

/** Scene point to page point, for the board's viewport right now. */
async function pt(page: Page, x: number, y: number) {
  const view = (await probe(page)).viewport
  const box = await page.locator('.canvas-host').boundingBox()
  if (!box) throw new Error('canvas host not found')
  return { x: box.x + x * view.zoom + view.panX, y: box.y + y * view.zoom + view.panY }
}

/** A fixed-height card's scroll, read from the page. */
function scrollOf(page: Page, id: string) {
  return page.evaluate((id) => {
    const b = document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"] > .scene-text-body`)!
    const card = b.parentElement!
    return {
      top: b.scrollTop,
      // How far it can go: the editor's own answer (the fades, the thumb and the wheel share it).
      max: window.__cards.scroll(id)?.max ?? b.scrollHeight - b.clientHeight,
      clientHeight: b.clientHeight,
      clientWidth: b.clientWidth,
      offsetWidth: b.offsetWidth,
      fadeTop: card.classList.contains('fade-top'),
      fadeBottom: card.classList.contains('fade-bottom'),
      fixed: card.classList.contains('is-fixed'),
      mask: getComputedStyle(b).maskImage,
    }
  }, id)
}

interface WheelStep {
  x: number
  y: number
  dy: number
  dx?: number
  ctrl?: boolean
  shift?: boolean
  /** The mouse buttons held, as Chromium reports them on a real wheel event (Playwright's own wheel always says none). */
  buttons?: number
}

/** Wheel events dispatched at page points, `gapMs` apart (a busy wait, so the gaps are exact). */
async function wheel(page: Page, steps: WheelStep[], gapMs = 20) {
  await page.evaluate(
    ({ steps, gapMs }) => {
      const spin = (ms: number) => {
        const end = performance.now() + ms
        while (performance.now() < end) {
          /* wait */
        }
      }
      steps.forEach((s, i) => {
        if (i > 0) spin(gapMs)
        const target = document.elementFromPoint(s.x, s.y) ?? document.body
        target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: s.x, clientY: s.y, deltaX: s.dx ?? 0, deltaY: s.dy, deltaMode: 0, ctrlKey: !!s.ctrl, shiftKey: !!s.shift, buttons: s.buttons ?? 0 }))
      })
    },
    { steps, gapMs },
  )
}

/** `n` wheel events at one page point. */
const at = (point: { x: number; y: number }, dy: number, n: number, extra: Partial<WheelStep> = {}): WheelStep[] => Array.from({ length: n }, () => ({ ...point, dy, ...extra }))

const byId = (doc: StoredBoard, id: string): StoredObject & Record<string, unknown> => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no object ${id}`)
  return found as StoredObject & Record<string, unknown>
}
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}

/** Every character of a card: its left, top and width on the page (clipped characters included: they keep their layout). */
function characterBoxes(page: Page, id: string) {
  return page.evaluate((id) => {
    const body = document.querySelector(`.scene-text[data-id="${id}"] > .scene-text-body`)!
    const out: number[][] = []
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (let i = 0; i < (n as Text).data.length; i++) {
        range.setStart(n, i)
        range.setEnd(n, i + 1)
        const r = range.getBoundingClientRect()
        out.push([r.left, r.top, r.width])
      }
    }
    return out
  }, id)
}

function expectSameBoxes(a: number[][], b: number[][], tolerance = 0.02) {
  expect(a.length).toBe(b.length)
  a.forEach((box, i) => box.forEach((v, k) => expect(Math.abs(v - b[i]![k]!), `character ${i}`).toBeLessThanOrEqual(tolerance)))
}

/**
 * Whatever has scrolled on the page apart from the text cards and the floating panels, once the
 * frame has been drawn (the editor puts back an ancestor the browser scrolls before it paints).
 */
function nothingElseScrolled(page: Page) {
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(r))
    const moved: string[] = []
    if (window.scrollX !== 0 || window.scrollY !== 0) moved.push('window')
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (el.classList.contains('scene-text-body') || el.closest('.floating')) continue
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) moved.push(`${el.localName}.${el.className}`)
    }
    return moved
  })
}

/**
 * The caret of the edited text is shown in its card (an upright card: its page rectangle is its box):
 * its middle inside the box, at most a third of it outside (a line box sits a few pixels above its
 * text's top, as the baseline shift moves it). With `clear` (page pixels): on each side where the
 * text fades (there is more text beyond), the caret's character keeps at least that far from the edge.
 */
function caretInView(page: Page, id: string, clear = 0) {
  return page.evaluate(({ id, clear }) => {
    const body = document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"] > .scene-text-body`)!
    const sel = getSelection()
    if (!sel || sel.rangeCount === 0) return { ok: false, why: 'no selection' }
    const range = sel.getRangeAt(0).cloneRange()
    range.collapse(false)
    let rect: DOMRect | undefined = Array.from(range.getClientRects()).find((r) => r.height > 0)
    if (!rect) {
      const n = sel.focusNode!
      rect = (n.nodeType === 1 ? (n as Element) : n.parentElement!).getBoundingClientRect()
    }
    const box = body.getBoundingClientRect()
    const card = body.parentElement!
    const mid = (rect.top + rect.bottom) / 2
    const slack = rect.height / 3
    const gapTop = rect.top - box.top
    const gapBottom = box.bottom - rect.bottom
    const fadeTop = card.classList.contains('fade-top')
    const fadeBottom = card.classList.contains('fade-bottom')
    const shown = mid > box.top && mid < box.bottom && gapTop >= -slack && gapBottom >= -slack
    const clearOfFades = (!fadeTop || gapTop >= clear) && (!fadeBottom || gapBottom >= clear)
    return { ok: shown && clearOfFades, gapTop, gapBottom, fadeTop, fadeBottom }
  }, { id, clear })
}

async function selectById(page: Page, id: string) {
  await page.evaluate((id) => window.__cards.select(id), id)
  await expect.poll(async () => (await probe(page)).selected).toEqual([id])
}

async function handle(page: Page, key: string) {
  const c = await page.evaluate(() => window.__cards.controls())
  if (!c?.[key]) throw new Error(`no ${key} handle`)
  return c[key]!
}

/** Enters editing of the text under `point` (a double-click selects the word there). */
async function editAt(page: Page, point: { x: number; y: number }) {
  await page.mouse.dblclick(point.x, point.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
}

// ---- the plan's acceptance tests ------------------------------------------------------------------

test('a scrollable element of this browser takes width for its scrollbar (so the next test can tell)', async ({ page }) => {
    await page.setContent('<div style="width:200px;height:50px;overflow-y:auto"><div style="height:400px"></div></div>')
    const taken = await page.evaluate(() => {
      const el = document.querySelector('div')!
      return el.offsetWidth - el.clientWidth
    })
    test.skip(taken === 0, 'this platform draws overlay scrollbars: nothing to take width from')
    expect(taken).toBeGreaterThan(0)
  })

test('bottom-handle-drag-fixes-height-no-rewrap-and-scrolls-without-panning', async ({ page }) => {
  const { errors } = await open(page, [textRec('rev', 200, 80, { text: lines(14) })])
  expect(await dbVersion(page)).toBe(1)
  const before = await characterBoxes(page, 'rev')
  const auto = await page.evaluate(() => window.__cards.proxy('rev')!)
  await selectById(page, 'rev')
  // Drag the bottom handle 150 px up: shorter than the text.
  const mb = await handle(page, 'mb')
  await drag(page, mb, { x: mb.x, y: mb.y - 150 }, { steps: 10 })
  const fixed = await storedWhen(page, (d) => byId(d, 'rev').height !== undefined)
  const height = byId(fixed, 'rev').height as number
  expect(Math.abs(height - (auto.height - 150))).toBeLessThanOrEqual(1)
  expect(byId(fixed, 'rev')).toMatchObject({ width: 360, left: 200, top: 80, fontSize: 18 })
  // The first fixed height is what makes the board version 3, in the same save.
  expect(fixed.version).toBe(3)
  expect(await dbVersion(page)).toBe(3)
  // Not one character moved or re-wrapped: no scrollbar took any width (Windows included).
  expectSameBoxes(await characterBoxes(page, 'rev'), before)
  const s0 = await scrollOf(page, 'rev')
  expect(s0).toMatchObject({ top: 0, fixed: true, fadeTop: false, fadeBottom: true })
  expect(s0.clientWidth).toBe(s0.offsetWidth)
  expect(Math.abs(s0.max - 150)).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => window.__cards.proxy('rev')!.height)).toBe(height)

  // While editing, the wheel (a real one) scrolls the text and never moves the board.
  const view = (await probe(page)).viewport
  await editAt(page, await pt(page, 230, 90))
  const inside = await pt(page, 300, 120)
  await page.mouse.move(inside.x, inside.y)
  await page.mouse.wheel(0, 100)
  await expect.poll(async () => (await scrollOf(page, 'rev')).top).toBeGreaterThan(0)
  const scrolled = (await scrollOf(page, 'rev')).top
  expect(scrolled).toBe(100)
  expect((await probe(page)).viewport).toEqual(view)
  expect((await probe(page)).editing).toBe(true)
  // Leaving the edit keeps the position, with a fade at both ends.
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await probe(page)).editing).toBe(false)
  expect(await scrollOf(page, 'rev')).toMatchObject({ top: scrolled, fadeTop: true, fadeBottom: true })
  expect((await scrollOf(page, 'rev')).mask).not.toBe('none')

  // A double-click on the bottom handle takes the box back to growing with its words.
  await selectById(page, 'rev')
  const mb2 = await handle(page, 'mb')
  await page.mouse.dblclick(mb2.x, mb2.y)
  const cleared = await storedWhen(page, (d) => byId(d, 'rev').height === undefined)
  expect(byId(cleared, 'rev')).toMatchObject({ width: 360, left: 200, top: 80 })
  expect(cleared.version).toBe(1) // no rich field is left: the older form, the database stays at 3
  expect(await dbVersion(page)).toBe(3)
  expect(await scrollOf(page, 'rev')).toMatchObject({ top: 0, fixed: false, fadeTop: false, fadeBottom: false })
  expect(await page.evaluate(() => window.__cards.proxy('rev')!.height)).toBeCloseTo(auto.height, 1)
  expectSameBoxes(await characterBoxes(page, 'rev'), before)
  expect(errors).toEqual([])
})

test('corner-scale-scales-fixed-height-once-and-undo-restores', async ({ page }) => {
  const rec = textRec('rev', 200, 100, { width: 300, height: 150 })
  const { errors } = await open(page, [rec])
  await selectById(page, 'rev')
  const tl = await handle(page, 'tl')
  const br = await handle(page, 'br')
  // Drag the bottom-right corner out along the diagonal by half the box again.
  await drag(page, br, { x: tl.x + (br.x - tl.x) * 1.5, y: tl.y + (br.y - tl.y) * 1.5 }, { steps: 12 })
  const scaled = await storedWhen(page, (d) => byId(d, 'rev').fontSize !== 18)
  const r = byId(scaled, 'rev')
  const k = (r.fontSize as number) / 18
  expect(k).toBeGreaterThan(1.3)
  expect(Math.abs((r.width as number) - 300 * k)).toBeLessThanOrEqual(0.02)
  expect(Math.abs((r.height as number) - 150 * k)).toBeLessThanOrEqual(0.02)
  // Folded once: the proxy is unscaled and exactly the stored box.
  expect(await page.evaluate(() => window.__cards.proxy('rev'))).toMatchObject({ width: r.width, height: r.height, angle: 0 })
  expect((await scrollOf(page, 'rev')).clientHeight).toBe(Math.round(r.height as number))
  await page.keyboard.press('Control+z')
  await storedWhen(page, (d) => byId(d, 'rev').fontSize === 18)
  expect(byId(await storedDoc(page), 'rev')).toEqual(rec)
  await page.keyboard.press('Control+Shift+z')
  await storedWhen(page, (d) => byId(d, 'rev').fontSize !== 18)
  expect(byId(await storedDoc(page), 'rev')).toEqual(r)
  expect(errors).toEqual([])
})

for (const zoom of [0.5, 2]) {
  test(`rotated-zoomed-card-never-uses-bounding-client-rect (zoom ${zoom})`, async ({ page }) => {
    // A text turned 45° in a frame; the view centred on it.
    const frame = { id: 'f1', name: 'Spread', left: 100, top: 100, width: 500, height: 330 }
    const rec = textRec('rot', 220, 150, { text: 'A turned note\nwith two lines', width: 200, angle: 45, frameId: 'f1' })
    const view = { zoom, panX: 640 - 320 * zoom, panY: 360 - 230 * zoom }
    const { errors } = await open(page, [rec], { frames: [frame], view })
    const centre = async () => {
      const proxy = (await page.evaluate(() => window.__cards.proxy('rot')))!
      const d = byId(await storedDoc(page), 'rot')
      const a = ((d.angle as number) * Math.PI) / 180
      const w = d.width as number
      return { x: (d.left as number) + (w / 2) * Math.cos(a) - (proxy.height / 2) * Math.sin(a), y: (d.top as number) + (w / 2) * Math.sin(a) + (proxy.height / 2) * Math.cos(a), proxy, d }
    }
    // Type into it: two more lines.
    const c0 = await centre()
    await editAt(page, await pt(page, c0.x, c0.y))
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nthree\nfour')
    await page.keyboard.press('Escape')
    await storedWhen(page, (d) => (byId(d, 'rot').text as string).endsWith('four'))
    // The proxy's height is the text's own laid-out height, whatever the zoom and the turn; never its turned, zoomed bounding box.
    const sizes = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.scene-text[data-id="rot"] > .scene-text-body')!
      return { layout: parseFloat(getComputedStyle(body).height), box: body.getBoundingClientRect().height }
    })
    const c1 = await centre()
    expect(Math.abs(c1.proxy.height - sizes.layout)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(c1.proxy.height - sizes.box / zoom)).toBeGreaterThan(20)
    expect(c1.proxy.height).toBeGreaterThan(18 * 1.4125 * 3)
    // Ownership after a small move is decided by the centre of that box.
    await selectById(page, 'rot')
    const from = await pt(page, c1.x, c1.y)
    await drag(page, from, { x: from.x + 4, y: from.y + 4 }, { steps: 4 })
    const moved = await storedWhen(page, (d) => byId(d, 'rot').left !== c1.d.left)
    const c2 = await centre()
    const inside = c2.x >= frame.left && c2.x <= frame.left + frame.width && c2.y >= frame.top && c2.y <= frame.top + frame.height
    expect(inside).toBe(true)
    expect(byId(moved, 'rot').frameId).toBe('f1')
    expect(errors).toEqual([])
  })
}

test('wheel-belongs-to-where-it-started', async ({ page }) => {
  const frame = { id: 'f1', name: 'Spread', left: 320, top: 180, width: 300, height: 300 }
  const card = textRec('c', 300, 100, { height: 160 })
  const image = { type: 'image', id: 'img', assetId: 'a1', left: 560, top: 200, angle: 0, scaleX: 1, scaleY: 1 }
  const { errors } = await open(page, [card, image], { frames: [frame], assets: [{ id: 'a1', name: 'a.png', width: 200, height: 120 }] })
  const max = (await scrollOf(page, 'c')).max
  expect(max).toBeGreaterThan(400)
  const panY = async () => (await probe(page)).viewport.panY
  const top = async () => (await scrollOf(page, 'c')).top

  // (a) A burst that starts on empty canvas and goes on over the card pans the board all the way; the card stays at the top.
  const empty = await pt(page, 100, 560)
  const over = await pt(page, 420, 130)
  const path: WheelStep[] = Array.from({ length: 8 }, (_, i) => ({ x: empty.x + ((over.x - empty.x) * i) / 7, y: empty.y + ((over.y - empty.y) * i) / 7, dy: -30 }))
  await wheel(page, path)
  expect(await panY()).toBe(240)
  expect(await top()).toBe(0)
  await page.waitForTimeout(NEW_GESTURE_MS)

  // (b) A burst that starts over the card scrolls it, by the board's distance in scene units, and the board never moves, even after the card reaches its end.
  const cardAt = await pt(page, 420, 130)
  await wheel(page, at(cardAt, 40, 2))
  expect(await top()).toBe(80)
  await wheel(page, at(cardAt, 100, 12)) // a new burst: past the end
  expect(await top()).toBeCloseTo(max, 0)
  expect(await panY()).toBe(240)
  await page.waitForTimeout(NEW_GESTURE_MS)

  // (c) A new burst in the same direction over the card at its end pans the board.
  await wheel(page, at(await pt(page, 420, 130), 50, 3))
  expect(await panY()).toBe(90)
  expect(await top()).toBeCloseTo(max, 0)
  await page.waitForTimeout(NEW_GESTURE_MS)
  // A burst the other way over it scrolls it back.
  await wheel(page, at(await pt(page, 420, 130), -100, 3))
  expect(await top()).toBeCloseTo(max - 300, 0)
  expect(await panY()).toBe(90)
  await page.waitForTimeout(NEW_GESTURE_MS)

  // (d) The image in front of the card, the frame's label or its outline over the card: the burst pans.
  const kept = await top()
  let y = 90
  for (const [sx, sy] of [[610, 230], [330, 166], [450, 180]] as const) {
    await wheel(page, at(await pt(page, sx, sy), 20, 2))
    y -= 40
    expect(await panY(), `burst at ${sx}, ${sy}`).toBe(y)
    expect(await top()).toBe(kept)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }

  // (e) Ctrl+wheel over the card zooms (and ends the gesture: a plain event straight after picks again).
  const zoom = (await probe(page)).viewport.zoom
  const cardNow = await pt(page, 420, 130)
  await wheel(page, [{ ...cardNow, dy: -100, ctrl: true }, { ...cardNow, dy: 30 }])
  expect((await probe(page)).viewport.zoom).toBeGreaterThan(zoom)
  expect(await top()).toBeCloseTo(kept + 30 / (await probe(page)).viewport.zoom, 0)
  // Shift, or a mostly sideways wheel, pans.
  await page.waitForTimeout(NEW_GESTURE_MS)
  const t1 = await top()
  const pan0 = (await probe(page)).viewport
  await wheel(page, [{ ...(await pt(page, 420, 130)), dy: 40, shift: true }])
  await page.waitForTimeout(NEW_GESTURE_MS)
  await wheel(page, [{ ...(await pt(page, 420, 130)), dy: 10, dx: 40 }])
  expect(await top()).toBe(t1)
  expect((await probe(page)).viewport.panX).toBe(pan0.panX - 80)
  // Scrolling marked nothing: no history step.
  expect((await probe(page)).canUndo).toBe(false)
  expect(errors).toEqual([])
})

test('wheel-belongs-to-where-it-started (f): on a read-only board the card scrolls and the board pans, and nothing is written', async ({ page }) => {
  // An image whose bytes are missing: the board cannot be fully restored and opens read-only.
  const card = textRec('c', 300, 100, { height: 160 })
  const image = { type: 'image', id: 'gone', assetId: 'missing', left: 900, top: 500, angle: 0, scaleX: 1, scaleY: 1 }
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  await seedRaw(page, 3, { version: 3, title: 'Heights', frames: [], objects: [card, image], viewport: UNIT })
  await installProbe(page)
  await page.goto('/')
  await expect.poll(async () => (await page.evaluate(() => window.__cards?.state().readOnly)) ?? null).not.toBeNull()
  const written = await snapshotIdb(page)
  const panY = async () => (await probe(page)).viewport.panY
  const top = async () => (await scrollOf(page, 'c')).top
  const max = (await scrollOf(page, 'c')).max
  // (a)
  const empty = await pt(page, 100, 560)
  const over = await pt(page, 420, 130)
  await wheel(page, Array.from({ length: 6 }, (_, i) => ({ x: empty.x + ((over.x - empty.x) * i) / 5, y: empty.y + ((over.y - empty.y) * i) / 5, dy: -30 })))
  expect(await panY()).toBe(180)
  expect(await top()).toBe(0)
  await page.waitForTimeout(NEW_GESTURE_MS)
  // (b)
  await wheel(page, at(await pt(page, 420, 130), 100, 12))
  expect(await top()).toBeCloseTo(max, 0)
  expect(await panY()).toBe(180)
  await page.waitForTimeout(NEW_GESTURE_MS)
  // (c)
  await wheel(page, at(await pt(page, 420, 130), 50, 2))
  expect(await panY()).toBe(80)
  await page.waitForTimeout(AUTOSAVE_QUIET_MS + 300)
  expect(await snapshotIdb(page)).toEqual(written)
  expect(errors).toEqual([])
})

test('scrolling-is-view-state-only', async ({ page }) => {
  const frame = { id: 'f1', name: 'Spread', left: 80, top: 60, width: 760, height: 520 }
  const card = textRec('c', 120, 100, { height: 220, frameId: 'f1' })
  const other = textRec('t', 540, 100, { text: 'another note', width: 200, frameId: 'f1' })
  const { errors } = await open(page, [card, other], { frames: [frame] })
  await selectById(page, 't')
  const fromTop = await page.evaluate(() => window.__cards.preview('f1'))
  await selectById(page, 't')
  const stored = await snapshotIdb(page)
  // Scrolling an idle card: no history step, no save, no change of selection.
  await wheel(page, at(await pt(page, 200, 160), 60, 4))
  expect((await scrollOf(page, 'c')).top).toBe(240)
  expect(await probe(page)).toMatchObject({ canUndo: false, dirty: false, selected: ['t'], editing: false })
  await page.waitForTimeout(AUTOSAVE_QUIET_MS + 300)
  expect(await snapshotIdb(page)).toEqual(stored) // the same row, written at the same time
  expect(await status(page).textContent()).toContain('Saved on this device')
  // Undo then redo of an unrelated move keeps the card where it was scrolled.
  const from = await pt(page, 600, 110)
  await drag(page, from, { x: from.x + 40, y: from.y + 20 })
  await storedWhen(page, (d) => byId(d, 't').left !== 540)
  await page.keyboard.press('Control+z')
  await storedWhen(page, (d) => byId(d, 't').left === 540)
  expect((await scrollOf(page, 'c')).top).toBe(240)
  await page.keyboard.press('Control+Shift+z')
  await storedWhen(page, (d) => byId(d, 't').left !== 540)
  expect((await scrollOf(page, 'c')).top).toBe(240)
  // The frame preview shows the card from the top while it is scrolled on screen.
  expect(await page.evaluate(() => window.__cards.preview('f1'))).not.toBe('')
  await page.keyboard.press('Control+z')
  await storedWhen(page, (d) => byId(d, 't').left === 540)
  expect(await page.evaluate(() => window.__cards.preview('f1'))).toBe(fromTop)
  expect((await scrollOf(page, 'c')).top).toBe(240)
  // From the top, clipped to the fixed box: ink in the box, none below it (the text goes on far past it).
  const png = decodePng(Buffer.from(fromTop.split(',')[1]!, 'base64'))
  const scale = png.width / frame.width
  const inkIn = (x0: number, y0: number, x1: number, y1: number) => {
    let n = 0
    for (let y = Math.round((y0 - frame.top) * scale); y < (y1 - frame.top) * scale; y++) {
      for (let x = Math.round((x0 - frame.left) * scale); x < (x1 - frame.left) * scale; x++) {
        const i = (y * png.width + x) * 4
        if (png.data[i]! < 160) n++
      }
    }
    return n
  }
  expect(inkIn(120, 100, 480, 320)).toBeGreaterThan(500)
  expect(inkIn(120, 330, 480, 570)).toBe(0)
  // A reload starts every card at the top.
  await page.reload()
  await expect(status(page)).toContainText('Saved on this device')
  expect((await scrollOf(page, 'c')).top).toBe(0)
  expect(errors).toEqual([])
})

// ---- editing in a fixed-height text -----------------------------------------------------------------

for (const zoom of [1, 2]) {
  test(`the caret stays in view in a fixed-height text, and nothing else scrolls (zoom ${zoom})`, async ({ page }) => {
    const view = { zoom, panX: 300 - 200 * zoom, panY: 100 - 100 * zoom }
    const { errors } = await open(page, [textRec('c', 200, 100, { text: lines(20), height: 120 })], { view })
    await page.evaluate(() => navigator.clipboard.writeText('pasted one\npasted two\npasted three'))
    const fixedView = (await probe(page)).viewport
    // After every key: the caret is shown, and clear of a fade wherever there is one (CARET_CLEAR scene px).
    const check = async (what: string) => {
      // A caret key the browser handles is scrolled to by the browser first (to the very edge), then
      // clear of the fade once the engine has read the move: within a frame or two.
      await expect.poll(async () => (await caretInView(page, 'c', CARET_CLEAR * zoom)).ok, { message: what, timeout: 1000 }).toBe(true)
      expect(await nothingElseScrolled(page), what).toEqual([])
      expect((await probe(page)).viewport, what).toEqual(fixedView)
    }
    await editAt(page, await pt(page, 230, 110))
    await page.keyboard.press('Control+End')
    await check('Ctrl+End')
    expect((await scrollOf(page, 'c')).top).toBeCloseTo((await scrollOf(page, 'c')).max, 0)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Enter')
    await page.keyboard.type('typed at the end')
    await check('typing and Enter')
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowUp')
    await check('ArrowUp')
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
    await check('ArrowDown')
    await page.keyboard.press('PageUp')
    await check('PageUp')
    await page.keyboard.press('PageDown')
    await check('PageDown')
    await page.keyboard.press('End')
    await check('End')
    await page.keyboard.press('Home')
    await check('Home')
    await page.keyboard.press('Control+Home')
    await check('Ctrl+Home')
    expect((await scrollOf(page, 'c')).top).toBe(0)
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Control+v')
    await check('paste')
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+z') // the paste goes: the caret goes back to the end
    await check('undo')
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+Shift+z')
    await check('redo')
    expect((await probe(page)).editing).toBe(true)
    expect(errors).toEqual([])
  })
}

test('entering and leaving an edit while scrolled moves nothing on screen, and the caret lands on the word pressed', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 200, 100, { height: 200 })])
  await wheel(page, at(await pt(page, 300, 150), 70, 3))
  expect((await scrollOf(page, 'c')).top).toBe(210)
  const idle = await characterBoxes(page, 'c')
  // The word "review" of the line now near the card's top.
  const word = await page.evaluate(() => {
    const body = document.querySelector('.scene-text[data-id="c"] > .scene-text-body')!
    const box = body.getBoundingClientRect()
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n as Text).data.indexOf('review')
      if (i < 0) continue
      range.setStart(n, i + 2)
      range.setEnd(n, i + 3)
      const r = range.getBoundingClientRect()
      if (r.top > box.top + 60 && r.bottom < box.bottom - 60) return { x: r.left + r.width / 2, y: r.top + r.height / 2, line: (n as Text).data }
    }
    return null
  })
  expect(word).not.toBeNull()
  await editAt(page, word!)
  expect((await scrollOf(page, 'c')).top).toBe(210)
  expectSameBoxes(await characterBoxes(page, 'c'), idle)
  const edited = (await editedText(page))!
  expect(edited.value.slice(edited.start!, edited.end!)).toBe('review')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await probe(page)).editing).toBe(false)
  expect((await scrollOf(page, 'c')).top).toBe(210)
  expectSameBoxes(await characterBoxes(page, 'c'), idle)
  expect(errors).toEqual([])
})

test('every writing block in a fixed-height text: scrolled, ticked, typed into, saved and reloaded', async ({ page }) => {
  const blocks: Block[] = [
    { type: 'heading', level: 2, content: [{ text: 'Blue Lines' }] },
    p('A review with some words.'),
    { type: 'bulletList', items: [{ blocks: [p('Warm bassline')] }, { blocks: [p('Second bullet')] }] },
    { type: 'orderedList', start: 9, items: [{ blocks: [p('nine')] }, { blocks: [p('ten')] }] },
    { type: 'taskList', items: [{ checked: false, blocks: [p('Check the remaster')] }, { checked: false, blocks: [p('Listen to side B')] }] },
    { type: 'blockquote', blocks: [p('A record that sounds like a city at night.')] },
    { type: 'divider' },
    { type: 'codeBlock', text: 'const side = "B"\nplay(side)' },
    ...Array.from({ length: 8 }, (_, i) => p(`Closing paragraph ${i + 1}.`)),
  ]
  const rec = textRec('c', 200, 100, { text: 'x', blocks, height: 180 })
  const { errors } = await open(page, [rec])
  // Scroll the checklist into the middle of the box.
  const boxTop = async (sel: string, i = 0) =>
    page.evaluate(({ sel, i }) => {
      const el = document.querySelectorAll(`.scene-text[data-id="c"] ${sel}`)[i]!
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, { sel, i })
  await wheel(page, at(await pt(page, 300, 150), 60, 3))
  const scrolled = (await scrollOf(page, 'c')).top
  expect(scrolled).toBe(180)
  await editAt(page, await boxTop('blockquote p'))
  expect((await scrollOf(page, 'c')).top).toBe(scrolled)
  // A click on a checkbox while scrolled ticks it and scrolls nothing.
  const check = await boxTop('.yp-check', 1)
  await page.mouse.click(check.x, check.y)
  await storedWhen(page, (d) => JSON.stringify(byId(d, 'c').blocks).includes('"checked":true'))
  expect((await scrollOf(page, 'c')).top).toBe(scrolled)
  // Type in the code block.
  const code = await boxTop('pre')
  await page.mouse.click(code.x, code.y)
  await page.keyboard.press('End')
  await page.keyboard.type(' // typed')
  const typed = await storedWhen(page, (d) => (byId(d, 'c').text as string).includes('// typed'))
  await page.keyboard.press('Escape')
  const after = byId(typed, 'c')
  expect(after.height).toBe(180)
  expect(typed.version).toBe(3)
  // Reloaded: the same blocks and height, from the top.
  await page.reload()
  await expect(status(page)).toContainText('Saved on this device')
  expect(byId(await storedDoc(page), 'c')).toEqual(after)
  expect(await scrollOf(page, 'c')).toMatchObject({ top: 0, fadeTop: false, fadeBottom: true })
  await expect(page.locator('.scene-text[data-id="c"] hr')).toHaveCount(1)
  await expect(page.locator('.scene-text[data-id="c"] pre')).toContainText('// typed')
  expect(errors).toEqual([])
})

// ---- the cues ------------------------------------------------------------------------------------------

test('fades: none when the words fit; at the bottom from the top; at both ends in the middle; at the top at the end', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 200, 100, { height: 160 }), textRec('fits', 700, 100, { text: 'short', width: 200, height: 80 })])
  expect(await scrollOf(page, 'fits')).toMatchObject({ fixed: true, fadeTop: false, fadeBottom: false, mask: 'none' })
  expect(await scrollOf(page, 'c')).toMatchObject({ top: 0, fadeTop: false, fadeBottom: true })
  await wheel(page, at(await pt(page, 300, 150), 50, 1))
  expect(await scrollOf(page, 'c')).toMatchObject({ top: 50, fadeTop: true, fadeBottom: true })
  await wheel(page, at(await pt(page, 300, 150), 400, 4))
  const end = await scrollOf(page, 'c')
  expect(end.top).toBeCloseTo(end.max, 0)
  expect(end).toMatchObject({ fadeTop: true, fadeBottom: false })
  expect(end.mask).toContain('gradient')
  // The fades take no room: the words are where they were before any fade.
  expect(errors).toEqual([])
})

test('the thumb shows while the text scrolls, fades out after, and drags the text while it is edited', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 200, 100, { height: 200 })])
  const thumb = page.locator('.scene-text[data-id="c"] .scene-text-thumb')
  await wheel(page, at(await pt(page, 300, 150), 40, 2))
  await expect(thumb).toHaveClass(/is-shown/)
  // On screen it is 6 px wide on the card's right edge.
  const box = (await thumb.boundingBox())!
  expect(box.width).toBeCloseTo(6, 0)
  const card = (await page.locator('.scene-text[data-id="c"]').boundingBox())!
  expect(card.x + card.width - (box.x + box.width)).toBeCloseTo(2, 0)
  await page.waitForTimeout(400)
  await expect(thumb).toHaveClass(/is-shown/)
  await expect(thumb).not.toHaveClass(/is-shown/, { timeout: 1500 })
  // While editing: shown by the wheel, and dragged it scrolls the text; the edit and its caret stay.
  await editAt(page, await pt(page, 230, 120))
  const caret = (await editedText(page))!
  await page.mouse.move(card.x + card.width / 2, card.y + 40)
  await page.mouse.wheel(0, 20)
  await expect(thumb).toHaveClass(/is-shown/)
  const t0 = (await scrollOf(page, 'c')).top
  const tb = (await thumb.boundingBox())!
  await drag(page, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 }, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 + 40 }, { steps: 8 })
  const t1 = (await scrollOf(page, 'c')).top
  expect(t1).toBeGreaterThan(t0 + 60)
  expect(await probe(page)).toMatchObject({ editing: true })
  expect(await editedText(page)).toMatchObject({ start: caret.start, end: caret.end, focused: true })
  await page.mouse.move(10, 10)
  await expect(thumb).not.toHaveClass(/is-shown/, { timeout: 2000 })
  expect(errors).toEqual([])
})

// ---- transforms, captions, frames ----------------------------------------------------------------------

test('a side handle on a fixed-height text changes only its wrap width', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 200, 100, { height: 160 })])
  await selectById(page, 'c')
  const before = await scrollOf(page, 'c')
  const mr = await handle(page, 'mr')
  await drag(page, mr, { x: mr.x - 80, y: mr.y })
  const narrowed = await storedWhen(page, (d) => (byId(d, 'c').width as number) < 360)
  expect(Math.abs((byId(narrowed, 'c').width as number) - 280)).toBeLessThanOrEqual(1)
  expect(byId(narrowed, 'c')).toMatchObject({ height: 160, left: 200, top: 100 })
  const after = await scrollOf(page, 'c')
  expect(after.clientHeight).toBe(before.clientHeight)
  expect(after.max).toBeGreaterThan(before.max) // the narrower text is longer
  expect(after.clientWidth).toBe(after.offsetWidth)
  expect(errors).toEqual([])
})

for (const zoom of [0.5, 2]) {
  test(`a turned fixed-height text at zoom ${zoom} scrolls along its own axis by the wheel's distance`, async ({ page }) => {
    const angle = 30
    const view = { zoom, panX: 640 - 380 * zoom, panY: 360 - 200 * zoom }
    const { errors } = await open(page, [textRec('c', 200, 100, { height: 200, angle })], { view })
    const glyph = () =>
      page.evaluate(() => {
        const body = document.querySelector('.scene-text[data-id="c"] > .scene-text-body')!
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = (n as Text).data.indexOf('Line 6 ')
          if (i < 0) continue
          const range = document.createRange()
          range.setStart(n, i)
          range.setEnd(n, i + 1)
          const r = range.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }
        throw new Error('no glyph')
      })
    // The box's centre, where the wheel is.
    const a = (angle * Math.PI) / 180
    const centre = await pt(page, 200 + 180 * Math.cos(a) - 100 * Math.sin(a), 100 + 180 * Math.sin(a) + 100 * Math.cos(a))
    const g0 = await glyph()
    await wheel(page, [{ ...centre, dy: 60 }])
    const g1 = await glyph()
    expect((await scrollOf(page, 'c')).top).toBeCloseTo(60 / zoom, 1)
    // The text moved up its own axis by the wheel's 60 screen pixels.
    expect(g1.x - g0.x).toBeCloseTo(60 * Math.sin(a), 0)
    expect(g1.y - g0.y).toBeCloseTo(-60 * Math.cos(a), 0)
    expect((await probe(page)).viewport).toEqual(view)
    expect(errors).toEqual([])
  })
}

test('a fixed-height caption is placed against its image by its fixed box, below and above', async ({ page }) => {
  const image = { type: 'image', id: 'img', assetId: 'a1', left: 200, top: 150, angle: 0, scaleX: 1, scaleY: 1 }
  const below = textRec('below', 200, 0, { text: lines(6), width: 200, captionOf: 'img', minHeight: 0 })
  const image2 = { type: 'image', id: 'img2', assetId: 'a1', left: 650, top: 300, angle: 0, scaleX: 1, scaleY: 1 }
  const above = textRec('above', 650, 0, { text: lines(6), width: 200, captionOf: 'img2', captionSide: 'top', minHeight: 0 })
  const { errors } = await open(page, [image, below, image2, above], { assets: [{ id: 'a1', name: 'a.png', width: 200, height: 120 }] })
  // (Stored where an earlier build left them: a caption is placed again against its image when it changes.)
  const gap = Math.round(0.4 * 18)
  await selectById(page, 'below')
  const p0 = (await page.evaluate(() => window.__cards.proxy('below')))!
  const mb = await handle(page, 'mb')
  await drag(page, mb, { x: mb.x, y: mb.y - 50 })
  const d1 = await storedWhen(page, (d) => byId(d, 'below').height !== undefined)
  // Below its image: its top edge against the image's bottom edge, its fixed height as dragged.
  expect(byId(d1, 'below')).toMatchObject({ captionOf: 'img', top: 150 + 120 + gap })
  expect(Math.abs((byId(d1, 'below').height as number) - (p0.height - 50))).toBeLessThanOrEqual(1)
  // Above its image: its bottom edge stays against the image once the drag is settled.
  await selectById(page, 'above')
  const mb2 = await handle(page, 'mb')
  await drag(page, mb2, { x: mb2.x, y: mb2.y - 40 })
  const d2 = await storedWhen(page, (d) => byId(d, 'above').height !== undefined)
  const a1 = byId(d2, 'above')
  expect(a1.captionOf).toBe('img2')
  expect(Math.abs((a1.top as number) + (a1.height as number) - (300 - gap))).toBeLessThanOrEqual(0.02)
  expect(errors).toEqual([])
})

test('frame ownership is decided by the fixed box', async ({ page }) => {
  const frame = { id: 'f1', name: 'Spread', left: 100, top: 50, width: 600, height: 300 }
  const { errors } = await open(page, [textRec('c', 150, 200, { text: lines(3), frameId: 'f1' })], { frames: [frame] })
  await selectById(page, 'c')
  // Taller: its centre (top 200 + half the height) leaves the frame, which ends at 350.
  const mb = await handle(page, 'mb')
  await drag(page, mb, { x: mb.x, y: (await pt(page, 0, 200 + 400)).y })
  const loose = await storedWhen(page, (d) => (byId(d, 'c').height as number) > 300)
  expect(byId(loose, 'c').frameId).toBeUndefined()
  // Shorter again: its centre is back inside, and it joins the frame by its own resize.
  const mb2 = await handle(page, 'mb')
  const target = await pt(page, 0, 200 + 100)
  await drag(page, mb2, { x: mb2.x, y: target.y })
  const back = await storedWhen(page, (d) => (byId(d, 'c').height as number) < 150)
  expect(byId(back, 'c').frameId).toBe('f1')
  expect(errors).toEqual([])
})

// ---- history, storage and read-only ---------------------------------------------------------------------

test('undo and redo of fixing, changing and clearing a height', async ({ page }) => {
  const rec = textRec('c', 200, 100, { text: lines(12) })
  const { errors } = await open(page, [rec])
  const height = async () => byId(await storedDoc(page), 'c').height as number | undefined
  await selectById(page, 'c')
  let mb = await handle(page, 'mb')
  await drag(page, mb, { x: mb.x, y: mb.y - 100 })
  await storedWhen(page, (d) => byId(d, 'c').height !== undefined)
  const first = (await height())!
  mb = await handle(page, 'mb')
  await drag(page, mb, { x: mb.x, y: mb.y - 40 })
  await storedWhen(page, (d) => byId(d, 'c').height !== first)
  const second = (await height())!
  expect(Math.abs(second - (first - 40))).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: 'Auto height', exact: true }).click()
  await storedWhen(page, (d) => byId(d, 'c').height === undefined)
  await expect(page.getByRole('button', { name: 'Auto height', exact: true })).toHaveCount(0)
  for (const want of [second, first, undefined]) {
    await page.keyboard.press('Control+z')
    await storedWhen(page, (d) => byId(d, 'c').height === want)
    expect((await scrollOf(page, 'c')).fixed).toBe(want !== undefined)
  }
  expect(byId(await storedDoc(page), 'c')).toEqual(rec)
  for (const want of [first, second, undefined]) {
    await page.keyboard.press('Control+Shift+z')
    await storedWhen(page, (d) => byId(d, 'c').height === want)
  }
  expect(errors).toEqual([])
})

test('a board that goes read-only mid-edit in a scrolled fixed-height text keeps it on screen, where it was, and writes nothing', async ({ context }) => {
  const seed = await context.newPage()
  await openBlank(seed)
  await seedRaw(seed, 3, { version: 3, title: 'Heights', frames: [], objects: [textRec('c', 200, 100, { height: 160 })], viewport: UNIT })
  await seed.close()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await installProbe(page)
  await openApp(page)
  await wheel(page, at(await pt(page, 300, 150), 90, 2))
  expect((await scrollOf(page, 'c')).top).toBe(180)
  await editAt(page, await pt(page, 240, 180))
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await storedWhen(page, (d) => (byId(d, 'c').text as string).includes('!'))
  const top = (await scrollOf(page, 'c')).top
  expect(top).toBe(180) // the caret, in the middle of the box, needed no scroll
  // Another tab writes the board.
  const other = await context.newPage()
  await openBlank(other)
  await other.evaluate(async () => {
    const path = '/src/persistence/boardStore.ts'
    const { IndexedDbBoardStore } = await import(/* @vite-ignore */ path)
    const store = new IndexedDbBoardStore()
    const loaded = await store.load()
    await store.save({ ...loaded.doc, title: 'Other tab' }, loaded.token, () => undefined)
    store.close?.()
  })
  const written = await snapshotIdb(other)
  await page.bringToFront()
  await page.keyboard.type(' more')
  await expect(page.getByTestId('readonly-banner')).toContainText('changed in another tab')
  await expect.poll(() => editedText(page)).toBeNull()
  expect((await scrollOf(page, 'c')).top).toBe(top)
  // The wheel still scrolls it, and nothing is written.
  await page.waitForTimeout(NEW_GESTURE_MS)
  await wheel(page, at(await pt(page, 300, 150), -90, 1))
  expect((await scrollOf(page, 'c')).top).toBe(top - 90)
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(await snapshotIdb(page)).toEqual(written)
  expect(errors).toEqual([])
})

test('a card culled off screen and brought back is where it was scrolled; a fixed-height text’s background never fades', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 200, 100, { height: 160, captionBackground: '#ffe8a3' })])
  await wheel(page, at(await pt(page, 300, 150), 70, 2))
  expect((await scrollOf(page, 'c')).top).toBe(140)
  // The background is the card's, the fades are the text's (its body).
  const look = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.scene-text[data-id="c"]')!
    const body = card.firstElementChild as HTMLElement
    return { card: getComputedStyle(card).backgroundColor, body: getComputedStyle(body).backgroundColor, cardMask: getComputedStyle(card).maskImage, bodyMask: getComputedStyle(body).maskImage }
  })
  expect(look).toMatchObject({ card: 'rgb(255, 232, 163)', body: 'rgba(0, 0, 0, 0)', cardMask: 'none' })
  expect(look.bodyMask).toContain('gradient')
  // Pan far away (on empty canvas): the card is culled; pan back: it is shown where it was.
  await page.waitForTimeout(NEW_GESTURE_MS)
  const empty = await pt(page, 900, 600)
  await wheel(page, at(empty, 400, 8))
  await expect(page.locator('.scene-text[data-id="c"]')).toHaveClass(/is-culled/)
  await page.waitForTimeout(NEW_GESTURE_MS)
  await wheel(page, at(empty, -400, 8))
  await expect(page.locator('.scene-text[data-id="c"]')).not.toHaveClass(/is-culled/)
  expect(await scrollOf(page, 'c')).toMatchObject({ top: 140, fadeTop: true, fadeBottom: true })
  expect((await probe(page)).viewport).toEqual(UNIT)
  // Auto height: the background goes back to the text itself, which no longer fades.
  await selectById(page, 'c')
  await page.getByRole('button', { name: 'Auto height', exact: true }).click()
  await storedWhen(page, (d) => byId(d, 'c').height === undefined)
  const auto = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.scene-text[data-id="c"]')!
    const body = card.firstElementChild as HTMLElement
    return { card: getComputedStyle(card).backgroundColor, body: getComputedStyle(body).backgroundColor, bodyMask: getComputedStyle(body).maskImage }
  })
  expect(auto).toEqual({ card: 'rgba(0, 0, 0, 0)', body: 'rgb(255, 232, 163)', bodyMask: 'none' })
  expect(errors).toEqual([])
})

test('a drawn box’s minimum height counts for nothing while its height is fixed, and again after Auto height', async ({ page }) => {
  // Drawn 260 tall, three short lines: the box is as tall as drawn.
  const { errors } = await open(page, [textRec('d', 200, 100, { text: lines(3), minHeight: 260 })])
  expect((await page.evaluate(() => window.__cards.proxy('d')))!.height).toBe(260)
  await selectById(page, 'd')
  const mb = await handle(page, 'mb')
  await drag(page, mb, { x: mb.x, y: mb.y - 160 })
  const fixed = await storedWhen(page, (d) => byId(d, 'd').height !== undefined)
  const height = byId(fixed, 'd').height as number
  expect(Math.abs(height - 100)).toBeLessThanOrEqual(1)
  expect(byId(fixed, 'd').minHeight).toBe(260) // kept: it still says the box was drawn (it wraps as a drawn box)
  expect((await page.evaluate(() => window.__cards.proxy('d')))!.height).toBe(height)
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.scene-text[data-id="d"] > .scene-text-body')!).height))).toBeCloseTo(height, 1)
  // While it is edited, Auto height (a panel button) keeps the edit and its caret, and the box is as tall as drawn again.
  await editAt(page, await pt(page, 230, 110))
  const caret = (await editedText(page))!
  await page.getByRole('button', { name: 'Auto height', exact: true }).click()
  await storedWhen(page, (d) => byId(d, 'd').height === undefined)
  expect(await editedText(page)).toMatchObject({ start: caret.start, end: caret.end, focused: true })
  expect((await page.evaluate(() => window.__cards.proxy('d')))!.height).toBe(260)
  await page.keyboard.type('!')
  await storedWhen(page, (d) => (byId(d, 'd').text as string).includes('!'))
  await page.keyboard.press('Escape')
  // One board step for the edit: the fixed height and the words come back together.
  await page.keyboard.press('Control+z')
  await storedWhen(page, (d) => byId(d, 'd').height === height)
  expect(byId(await storedDoc(page), 'd').text).toBe(lines(3))
  expect(errors).toEqual([])
})

// ---- found by review (4032b1b) ------------------------------------------------------------------

/** The layer's exact scroll position of a card (a fraction included) and how far it can go. */
const exactOf = (page: Page, id: string) => page.evaluate((id) => window.__cards.scroll(id)!, id)

for (const zoom of [0.5, 1, 2, 4]) {
  test(`fine wheel scrolling moves the text by exactly the sum of the wheel's distances, and stops exactly at the ends (zoom ${zoom})`, async ({ page }) => {
    const view = { zoom, panX: 350 - 260 * zoom, panY: 140 - 150 * zoom }
    const { errors } = await open(page, [textRec('c', 260, 150, { height: 150 })], { view })
    const p = await pt(page, 300, 175)
    await page.mouse.move(p.x, p.y)
    // Trusted wheel events, one, three and a hundred pixels at a time, down and back up.
    let sum = 0
    for (const d of [1, 3]) {
      for (let i = 0; i < 32; i++) await page.mouse.wheel(0, d)
      sum += (32 * d) / zoom
      await expect.poll(async () => (await exactOf(page, 'c')).top).toBe(sum)
      expect(Math.abs((await scrollOf(page, 'c')).top - sum)).toBeLessThan(1) // the page shows it rounded
    }
    for (const d of [3, 1]) {
      for (let i = 0; i < 32; i++) await page.mouse.wheel(0, -d)
      sum -= (32 * d) / zoom
      await expect.poll(async () => (await exactOf(page, 'c')).top).toBe(sum)
    }
    expect(sum).toBe(0)
    expect(await scrollOf(page, 'c')).toMatchObject({ top: 0, fadeTop: false, fadeBottom: true })
    const { max } = await exactOf(page, 'c')
    for (let i = 0; i < Math.ceil((max * zoom) / 100) + 2; i++) await page.mouse.wheel(0, 100)
    await expect.poll(async () => (await exactOf(page, 'c')).top).toBe(max)
    expect(await scrollOf(page, 'c')).toMatchObject({ top: max, fadeTop: true, fadeBottom: false })
    for (let i = 0; i < Math.ceil((max * zoom) / 100) + 2; i++) await page.mouse.wheel(0, -100)
    await expect.poll(async () => (await exactOf(page, 'c')).top).toBe(0)
    expect(await scrollOf(page, 'c')).toMatchObject({ top: 0, fadeTop: false, fadeBottom: true })
    expect((await probe(page)).viewport).toEqual(view)
    expect(errors).toEqual([])
  })
}

test('anything pressed and held on the board gives the wheel to the board; a selection dragged in the edited text scrolls it', async ({ page }) => {
  const card = textRec('c', 300, 130, { height: 160 })
  const other = textRec('t', 760, 420, { text: 'another note', width: 160 })
  const { errors } = await open(page, [card, other])
  let panY = 0
  /** The card scrolled to 100, so that it could take a wheel either way; then a new wheel gesture. */
  const middle = async () => {
    const now = (await exactOf(page, 'c')).top
    if (now !== 100) await wheel(page, [{ ...(await cardPoint()), dy: 100 - now }])
    expect((await exactOf(page, 'c')).top).toBe(100)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }
  /**
   * A wheel over the card while the primary button is held (an event that says so, as Chromium's real
   * wheel events do), in a direction the card could scroll (up, unless a bottom-handle drag has just
   * taken it back to its top): the board pans, the card stays where it was.
   */
  const wheelPans = async (what: string, buttons = 1) => {
    const before = (await exactOf(page, 'c')).top
    const dy = before > 0 ? -40 : 40
    await wheel(page, [{ ...(await cardPoint()), dy, buttons }])
    panY -= dy
    await expect.poll(async () => (await probe(page)).viewport.panY, { message: what }).toBe(panY)
    expect((await exactOf(page, 'c')).top, what).toBe(before)
  }
  const press = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
  }
  const cardPoint = () => pt(page, 420, 170)
  // A marquee from empty canvas over the card.
  await middle()
  await press(await pt(page, 200, 60), await cardPoint())
  await wheelPans('marquee')
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(NEW_GESTURE_MS)
  // Another text dragged over the card (Esc puts it back).
  await middle()
  await press(await pt(page, 790, 430), await cardPoint())
  await wheelPans('move')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForTimeout(NEW_GESTURE_MS)
  // The card's own bottom handle and its rotation handle, held with the pointer over the card.
  for (const key of ['mb', 'mtr']) {
    await middle()
    await selectById(page, 'c')
    const h = await handle(page, key)
    await press(h, await cardPoint())
    await wheelPans(key)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForTimeout(NEW_GESTURE_MS)
  }
  // A frame being drawn over it.
  await page.keyboard.press('Escape')
  await middle()
  await page.keyboard.press('f')
  await press(await pt(page, 200, 60), await cardPoint())
  await wheelPans('frame draft')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForTimeout(NEW_GESTURE_MS)
  // A layer row held, the pointer then over the card.
  const row = page.locator('.layer-row').first()
  await middle()
  const r = (await row.boundingBox())!
  await press({ x: r.x + 30, y: r.y + r.height / 2 }, await cardPoint())
  await wheelPans('layer row')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.waitForTimeout(NEW_GESTURE_MS)
  expect(byId(await storedDoc(page), 't')).toMatchObject({ left: 760, top: 420 })
  expect(byId(await storedDoc(page), 'c')).toMatchObject({ height: 160, angle: 0 })
  // The thumb held while editing.
  await editAt(page, await pt(page, 330, 140))
  await wheel(page, at(await cardPoint(), 30, 1))
  const thumb = page.locator('.scene-text[data-id="c"] .scene-text-thumb')
  await expect(thumb).toHaveClass(/is-shown/)
  await page.waitForTimeout(NEW_GESTURE_MS) // a new wheel gesture
  const tb = (await thumb.boundingBox())!
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2)
  await page.mouse.down()
  const held = (await exactOf(page, 'c')).top
  await wheel(page, [{ x: tb.x + tb.width / 2, y: tb.y + tb.height / 2, dy: -40, buttons: 1 }])
  panY += 40
  await expect.poll(async () => (await probe(page)).viewport.panY).toBe(panY)
  expect((await exactOf(page, 'c')).top).toBe(held)
  await page.mouse.up()
  await page.waitForTimeout(NEW_GESTURE_MS)
  // A selection dragged inside the edited text is the text's own: the wheel scrolls the text.
  const inText = await pt(page, 330, 200)
  await page.mouse.move(inText.x, inText.y)
  await page.mouse.down()
  await page.mouse.move(inText.x + 40, inText.y + 10, { steps: 4 })
  const before = (await exactOf(page, 'c')).top
  await wheel(page, [{ x: inText.x + 40, y: inText.y + 10, dy: 40, buttons: 1 }])
  await expect.poll(async () => (await exactOf(page, 'c')).top).toBe(before + 40)
  expect((await probe(page)).viewport.panY).toBe(panY)
  await page.mouse.up()
  // So is a press inside it that has not moved yet.
  await page.waitForTimeout(NEW_GESTURE_MS)
  await page.mouse.move(inText.x, inText.y)
  await page.mouse.down()
  const still = (await exactOf(page, 'c')).top
  await wheel(page, [{ ...inText, dy: -30, buttons: 1 }])
  await expect.poll(async () => (await exactOf(page, 'c')).top).toBe(still - 30)
  expect((await probe(page)).viewport.panY).toBe(panY)
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await probe(page)).editing).toBe(false)
  // The right button held over the card: the board.
  await page.waitForTimeout(NEW_GESTURE_MS)
  const right = await cardPoint()
  await page.mouse.move(right.x, right.y)
  await page.mouse.down({ button: 'right' })
  const r0 = (await exactOf(page, 'c')).top
  await wheel(page, [{ ...right, dy: -40, buttons: 2 }])
  panY += 40
  await expect.poll(async () => (await probe(page)).viewport.panY).toBe(panY)
  expect((await exactOf(page, 'c')).top).toBe(r0)
  await page.mouse.up({ button: 'right' })
  // A wheel that says no button is held (the release happened outside the window) is free again,
  // whatever the editor last saw: here a marquee press it still counts as held.
  await page.waitForTimeout(NEW_GESTURE_MS)
  await press(await pt(page, 200, 60), right)
  await wheel(page, [{ ...right, dy: -20 }])
  expect((await exactOf(page, 'c')).top).toBe(r0 - 20)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(errors).toEqual([])
})

test("a locked frame's label and outline over a card take the wheel as an unlocked frame's do: the board pans", async ({ page }) => {
  const frame = { id: 'f1', name: 'Spread', left: 320, top: 180, width: 300, height: 300, locked: true }
  const { errors } = await open(page, [textRec('c', 300, 100, { height: 160 })], { frames: [frame] })
  let panY = 0
  for (const [sx, sy] of [[330, 166], [450, 180]] as const) {
    await wheel(page, at(await pt(page, sx, sy), 20, 2))
    panY -= 40
    expect((await probe(page)).viewport.panY, `at ${sx}, ${sy}`).toBe(panY)
    expect((await exactOf(page, 'c')).top).toBe(0)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }
  // The card itself, away from the frame, still scrolls.
  await wheel(page, at(await pt(page, 500, 130), 20, 1))
  expect((await exactOf(page, 'c')).top).toBe(20)
  expect(errors).toEqual([])
})

test('the thumb always has room to move: in the shortest box, dragged end to end it covers the whole text', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 200, 100, { height: 27 })])
  await editAt(page, await pt(page, 228, 112))
  await wheel(page, at(await pt(page, 315, 113), 80, 1))
  expect((await exactOf(page, 'c')).top).toBe(80)
  const thumb = page.locator('.scene-text[data-id="c"] .scene-text-thumb')
  const box = (await thumb.boundingBox())!
  expect(box.height).toBeLessThanOrEqual((27 - 4) / 2 + 0.01) // at most half its track
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await drag(page, centre, { x: centre.x, y: centre.y + 60 }, { steps: 6 })
  const { max } = await exactOf(page, 'c')
  expect((await exactOf(page, 'c')).top).toBe(max)
  const b2 = (await thumb.boundingBox())!
  await drag(page, { x: b2.x + b2.width / 2, y: b2.y + b2.height / 2 }, { x: b2.x + b2.width / 2, y: b2.y - 60 }, { steps: 6 })
  expect((await exactOf(page, 'c')).top).toBe(0)
  expect(errors).toEqual([])
})

test('a wheel that starts anywhere inside a turned card scrolls it, on the row through its corner too', async ({ page }) => {
  const zoom = 2
  const view = { zoom, panX: 480 - 320 * zoom, panY: 190 - 150 * zoom }
  const { errors } = await open(page, [textRec('r', 320, 150, { width: 250, height: 140, angle: -45 })], { view })
  // The screen row through the top-left corner, well inside the card, and a pixel above and below it.
  const p = await pt(page, 320 + 70 * Math.SQRT2, 150)
  let top = 0
  for (const dy of [0, -1, 1]) {
    await wheel(page, [{ x: p.x, y: p.y + dy, dy: 20 }])
    top += 20 / zoom
    expect((await exactOf(page, 'r')).top, `row ${dy}`).toBe(top)
    expect((await probe(page)).viewport).toEqual(view)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }
  // Just outside the corner on that row: the board.
  const outside = await pt(page, 320 - 3, 150)
  await wheel(page, [{ ...outside, dy: 20 }])
  expect((await exactOf(page, 'r')).top).toBe(top)
  expect((await probe(page)).viewport.panY).toBe(view.panY - 20)
  expect(errors).toEqual([])
})

test('a card that can scroll by a single pixel shows its fade and its thumb, and takes the wheel', async ({ context }) => {
  // The text's own height first, as a box that grows with it shows it.
  const measure = await context.newPage()
  await open(measure, [textRec('b', 300, 100, { text: lines(30) })])
  const content = await measure.evaluate(() => window.__cards.proxy('b')!.height)
  await measure.close()
  const page = await context.newPage()
  const { errors } = await open(page, [textRec('b', 300, 100, { text: lines(30), height: Math.round((content - 1) * 100) / 100 })])
  const s0 = await exactOf(page, 'b')
  expect(s0.max).toBeGreaterThan(0)
  expect(s0.max).toBeLessThanOrEqual(1.5)
  expect(await scrollOf(page, 'b')).toMatchObject({ fadeTop: false, fadeBottom: true })
  await wheel(page, at(await pt(page, 400, 200), 3, 1))
  expect((await exactOf(page, 'b')).top).toBe(s0.max)
  expect(await scrollOf(page, 'b')).toMatchObject({ fadeTop: true, fadeBottom: false })
  await expect(page.locator('.scene-text[data-id="b"] .scene-text-thumb')).toHaveClass(/is-shown/)
  expect((await probe(page)).viewport).toEqual(UNIT)
  expect(errors).toEqual([])
})

test('the thumb stays 6 screen pixels wide when the zoom changes while it shows', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 200, 100, { height: 160 })])
  const thumb = page.locator('.scene-text[data-id="c"] .scene-text-thumb')
  await wheel(page, at(await pt(page, 300, 150), 40, 1))
  await expect(thumb).toHaveClass(/is-shown/)
  expect((await thumb.boundingBox())!.width).toBeCloseTo(6, 1)
  await wheel(page, at(await pt(page, 300, 150), -208, 1, { ctrl: true }))
  expect((await probe(page)).viewport.zoom).toBeGreaterThan(1.9)
  await expect(thumb).toHaveClass(/is-shown/)
  expect((await thumb.boundingBox())!.width).toBeCloseTo(6, 1)
  expect(errors).toEqual([])
})

for (const angle of [30, -45]) {
  for (const zoom of [0.5, 2]) {
    test(`a bottom-handle drag keeps a turned card's top-left corner where it was, on screen and stored (${angle}°, zoom ${zoom})`, async ({ page }) => {
      const view = { zoom, panX: 640 - 400 * zoom, panY: 380 - 190 * zoom }
      const rec = textRec('c', 300, 120, { text: lines(6), angle })
      const { errors } = await open(page, [rec], { view })
      await selectById(page, 'c')
      const tl = await handle(page, 'tl')
      const mb = await handle(page, 'mb')
      // The middle of the text's first character, as drawn on the page (its box's middle, however it is turned).
      const glyph = () =>
        page.evaluate(() => {
          const body = document.querySelector('.scene-text[data-id="c"] > .scene-text-body')!
          const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
          const range = document.createRange()
          range.setStart(text, 0)
          range.setEnd(text, 1)
          const r = range.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        })
      const g0 = await glyph()
      // 50 screen pixels up the card's own axis (shorter than its text), sampled after every move: the
      // handle's corner and the drawn text stay where they were while the handle is held, not only after.
      const a = (angle * Math.PI) / 180
      await page.mouse.move(mb.x, mb.y)
      await page.mouse.down()
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(mb.x + 5 * i * Math.sin(a), mb.y - 5 * i * Math.cos(a))
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)))
        const corner = await handle(page, 'tl')
        const g = await glyph()
        expect(Math.abs(corner.x - tl.x) + Math.abs(corner.y - tl.y), `corner, step ${i}`).toBeLessThan(0.5)
        expect(Math.abs(g.x - g0.x) + Math.abs(g.y - g0.y), `text, step ${i}`).toBeLessThan(0.5)
      }
      await page.mouse.up()
      const d = await storedWhen(page, (doc) => byId(doc, 'c').height !== undefined)
      expect(Math.abs((byId(d, 'c').left as number) - 300)).toBeLessThanOrEqual(0.01)
      expect(Math.abs((byId(d, 'c').top as number) - 120)).toBeLessThanOrEqual(0.01)
      const after = await handle(page, 'tl')
      expect(Math.abs(after.x - tl.x)).toBeLessThan(0.5)
      expect(Math.abs(after.y - tl.y)).toBeLessThan(0.5)
      expect(errors).toEqual([])
    })
  }
}

// ---- found by the second review (a5b5078) -------------------------------------------------------------

/** The page's own position of a card's text (what it shows, rounded as it rounds). */
const shownTop = (page: Page, id: string) => page.evaluate((id) => document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"] > .scene-text-body`)!.scrollTop, id)

for (const height of [133.23, 130, 140.27, 160]) {
test(`after the browser follows the caret, the next one-pixel wheel step moves the text one pixel (the reviewer's sequence, height ${height})`, async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 300, 180, { width: 250, height, text: lines(75) })])
  const at45 = await pt(page, 345, 200)
  await editAt(page, at45)
  await page.keyboard.press('Control+End')
  await page.waitForTimeout(230)
  await wheel(page, at(at45, -1, 17), 1)
  await page.waitForTimeout(NEW_GESTURE_MS)
  await page.keyboard.type(' writing')
  await page.waitForTimeout(270)
  const before = await shownTop(page, 'c')
  expect(before).toBe((await exactOf(page, 'c')).top) // the layer takes what the page shows
  await page.mouse.move(at45.x, at45.y)
  await page.mouse.wheel(0, -1)
  await expect.poll(() => shownTop(page, 'c')).toBe(before - 1)
  await page.waitForTimeout(150)
  expect(await shownTop(page, 'c')).toBe(before - 1)
  expect(errors).toEqual([])
})
}

for (const height of [133.23, 160]) {
test(`after every caret action the next one-pixel wheel step moves the text exactly one pixel on the page (height ${height})`, async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 300, 180, { width: 250, height, text: lines(75) })])
  await page.evaluate(() => navigator.clipboard.writeText('pasted one\npasted two'))
  const inside = await pt(page, 345, 200)
  await editAt(page, inside)
  const step = async (what: string) => {
    await page.waitForTimeout(NEW_GESTURE_MS) // the browser's own scroll and the engine's reveal settle; a new wheel gesture
    const s = await exactOf(page, 'c')
    const before = await shownTop(page, 'c')
    const dy = s.top > 1 ? -1 : 1
    await page.mouse.move(inside.x, inside.y)
    await page.mouse.wheel(0, dy)
    await expect.poll(() => shownTop(page, 'c'), { message: what }).toBe(before + dy)
    await page.waitForTimeout(120)
    expect(await shownTop(page, 'c'), what).toBe(before + dy)
  }
  await page.keyboard.press('Control+End')
  await step('Ctrl+End')
  await page.keyboard.type(' typed at the end')
  await step('typing at the end')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp')
  await step('ArrowUp')
  await page.keyboard.press('PageUp')
  await step('PageUp')
  await page.keyboard.press('PageDown')
  await step('PageDown')
  await page.keyboard.press('Control+Home')
  await step('Ctrl+Home')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+v')
  await step('paste')
  await page.keyboard.press('Control+z')
  await step('undo')
  expect((await probe(page)).editing).toBe(true)
  expect(errors).toEqual([])
})
}

for (const [zoom, height, fontSize] of [[0.25, 12, 8], [0.1, 27, 18]] as const) {
  test(`no thumb where there is no room for one: ${height}-unit box at ${zoom * 100}%; the wheel and the fades still work`, async ({ page }) => {
    const view = { zoom, panX: 400 - 200 * zoom, panY: 300 - 100 * zoom }
    const { errors } = await open(page, [textRec('c', 200, 100, { height, fontSize, width: 200 })], { view })
    expect(await scrollOf(page, 'c')).toMatchObject({ fadeTop: false, fadeBottom: true })
    await wheel(page, at(await pt(page, 300, 100 + height / 2), 4, 1))
    expect((await exactOf(page, 'c')).top).toBe(4 / zoom)
    expect(await scrollOf(page, 'c')).toMatchObject({ fadeTop: true, fadeBottom: true })
    // Right away (a thumb that was shown would fade out by itself 800 ms later).
    expect(await page.locator('.scene-text[data-id="c"] .scene-text-thumb.is-shown').count()).toBe(0)
    expect((await probe(page)).viewport).toEqual(view)
    expect(errors).toEqual([])
  })
}

test('whenever the page shows another position than the layer gave it, the page wins at once, fraction dropped', async ({ page }) => {
  const { errors } = await open(page, [textRec('c', 300, 180, { width: 250, height: 160, text: lines(75) })])
  const p = await pt(page, 345, 220)
  // A fractional position (as a reveal or a thumb drag leaves one): the page shows it rounded.
  await wheel(page, [{ ...p, dy: 100.37 }])
  expect((await exactOf(page, 'c')).top).toBe(100.37)
  const shown = await shownTop(page, 'c')
  expect(Math.abs(shown - 100.37)).toBeLessThan(1)
  // Something else moves the page by one pixel (as the browser does to follow a caret), less than a
  // pixel away from the remembered position: the page wins.
  for (const move of [1, -1]) {
    await page.waitForTimeout(NEW_GESTURE_MS)
    const from = await page.evaluate(({ id, move }) => {
      const b = document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"] > .scene-text-body`)!
      b.scrollTop = b.scrollTop + move
      return b.scrollTop
    }, { id: 'c', move })
    expect((await exactOf(page, 'c')).top).toBe(from)
    await page.mouse.move(p.x, p.y)
    await page.mouse.wheel(0, -1)
    await expect.poll(() => shownTop(page, 'c')).toBe(from - 1)
    expect((await exactOf(page, 'c')).top).toBe(from - 1)
  }
  expect(errors).toEqual([])
})

// ---- found by the third review (8afb65f) --------------------------------------------------------------

for (const zoom of [0.75, 1]) {
  for (const track of [11.75, 12, 12.043, 13]) {
    test(`a thumb shows exactly when its track is at least 12 screen pixels, from the box's exact height (track ${track} px at ${zoom * 100}%)`, async ({ page }) => {
      // The track is the box's height on screen less the thumb's 2 px inset at each end.
      const height = (track + 4) / zoom
      const view = { zoom, panX: 400 - 200 * zoom, panY: 190 - 100 * zoom }
      const { errors } = await open(page, [textRec('c', 200, 100, { height, fontSize: 8, width: 200 })], { view })
      const p = await pt(page, 250, 100 + height / 2)
      await editAt(page, p)
      await wheel(page, at(p, 10, 1))
      expect(await scrollOf(page, 'c')).toMatchObject({ fadeTop: true, fadeBottom: true })
      const thumb = page.locator('.scene-text[data-id="c"] .scene-text-thumb.is-shown')
      const shown = await thumb.count()
      expect(shown, `track ${track}`).toBe(track >= 12 ? 1 : 0)
      if (!shown) return
      const box = (await thumb.boundingBox())!
      expect(box.width).toBeCloseTo(6, 1)
      expect(box.height).toBeLessThanOrEqual(track / 2 + 0.01) // at most half the exact track
      const top = (await exactOf(page, 'c')).top
      const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await drag(page, c, { x: c.x, y: c.y + 4 }, { steps: 4 })
      expect((await exactOf(page, 'c')).top).toBeGreaterThan(top)
      expect(errors).toEqual([])
    })
  }
}

test('the wheel scrolls the edited text while only the left button is held over it, wherever that press began; any other button, or another text, gives it to the board', async ({ page, context }) => {
  // Decided from the wheel event alone: nothing is remembered about where a press began, so nothing can outlive a press.
  const { errors } = await open(page, [textRec('c', 260, 180, { height: 160 }), textRec('d', 620, 180, { height: 160 })])
  const p = await pt(page, 302, 218)
  const q = await pt(page, 662, 218)
  await editAt(page, p)
  await wheel(page, at(p, 75, 1))
  await page.waitForTimeout(NEW_GESTURE_MS)
  const cdp = await context.newCDPSession(page)
  const panY = async () => (await probe(page)).viewport.panY
  /** A wheel over the text with `buttons` held: the board pans and the text stays where it is. */
  const pans = async (what: string, buttons: number) => {
    const before = (await exactOf(page, 'c')).top
    const y = await panY()
    await wheel(page, [{ ...p, dy: -8, buttons }])
    expect(await panY(), what).toBe(y + 8)
    expect((await exactOf(page, 'c')).top, what).toBe(before)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }

  // The second button: a press in the text, released; then the right button held over the text.
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', buttons: 2, clickCount: 1 })
  await pans('right button after a press in the text', 2)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', buttons: 0, clickCount: 1 })

  // Both buttons held over the edited text: the board.
  await pans('left and right buttons over the edited text', 3)
  // The left button held over another scrollable text while this one is edited: the board, and that text stays at its top.
  {
    const y = await panY()
    await wheel(page, [{ ...q, dy: 8, buttons: 1 }])
    expect(await panY(), 'left button over another text').toBe(y - 8)
    expect((await exactOf(page, 'd')).top).toBe(0)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }

  // A press in the text whose release happens in another window; back with no button held; then a press
  // on a disabled panel button (Chromium sends no mousedown for it) dragged over the edited text: only the
  // left button is held over the edited text, so it scrolls, exactly as if the press had begun in it.
  const disabled = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll<HTMLButtonElement>('button:disabled')).find((b) => b.offsetWidth > 0)!
    const r = b.getBoundingClientRect()
    for (let x = r.left + 2; x < r.right - 1; x++) for (let y = r.top + 2; y < r.bottom - 1; y++) if (document.elementFromPoint(x, y) === b) return { x, y }
    return null
  })
  expect(disabled).not.toBeNull()
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  const other = await context.newPage()
  await other.setContent('<button>Another window</button>')
  await other.bringToFront()
  await other.mouse.up()
  await page.bringToFront()
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: disabled!.x, y: disabled!.y, buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: disabled!.x, y: disabled!.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 1 })
  {
    const before = (await exactOf(page, 'c')).top
    const y = await panY()
    await wheel(page, [{ ...p, dy: -8, buttons: 1 }])
    expect((await exactOf(page, 'c')).top, 'left button held over the edited text, pressed elsewhere').toBe(before - 8)
    expect(await panY()).toBe(y)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  // With no button held the ordinary rule is back at once: the text scrolls.
  {
    const before = (await exactOf(page, 'c')).top
    await wheel(page, [{ ...p, dy: -8, buttons: 0 }])
    expect((await exactOf(page, 'c')).top, 'no button held').toBe(before - 8)
    await page.waitForTimeout(NEW_GESTURE_MS)
  }
  // And a press that did begin in the text scrolls it too.
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  const before = (await exactOf(page, 'c')).top
  await wheel(page, [{ ...p, dy: -8, buttons: 1 }])
  expect((await exactOf(page, 'c')).top).toBe(before - 8)
  await page.mouse.up()
  expect(errors).toEqual([])
})

for (const zoom of [0.5, 1, 2]) {
  test(`a card's scroll end is what the browser's own layout gives for it (zoom ${zoom})`, async ({ page }) => {
    const view = { zoom, panX: 400 - 300 * zoom, panY: 200 - 100 * zoom }
    const heights = [100, 133.23, 160.5]
    const { errors } = await open(page, heights.map((height, i) => textRec(`c${i}`, 100 + i * 300, 100, { height, width: 260, text: lines(12 + 6 * i) })), { view })
    for (const [i, height] of heights.entries()) {
      // Measured here, independently: the text's own height from a copy of the card's body left to
      // grow, then where the browser lets the body scroll to for the text's end, and at most.
      const browser = await page.evaluate(({ id, height }) => {
        const body = document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"] > .scene-text-body`)!
        const copy = body.cloneNode(true) as HTMLElement
        copy.style.height = 'auto'
        copy.style.overflow = 'visible'
        body.parentElement!.append(copy)
        const natural = parseFloat(getComputedStyle(copy).height)
        copy.remove()
        const keep = body.scrollTop
        body.scrollTop = natural - height
        const end = body.scrollTop
        body.scrollTop = 1e7
        const most = body.scrollTop
        body.scrollTop = keep
        return { natural, end: Math.max(0, Math.min(end, most)) }
      }, { id: `c${i}`, height })
      expect(browser.natural).toBeGreaterThan(height)
      expect((await exactOf(page, `c${i}`)).max, `height ${height}`).toBe(browser.end)
    }
    expect(errors).toEqual([])
  })
}
