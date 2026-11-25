/**
 * Real-browser tests (real Fabric, real IndexedDB, real layout) for Slice 5: paper. A text box made
 * with the Text tool sits on a padded sheet; the panel's Paper button turns it off or on for any text,
 * and the words stay exactly where they were; older boxes and captions made with Add caption stay
 * bare. There is no earlier canvas to compare these with: every expectation is stated here.
 *
 * Every other browser test starts with a storage state in which new text boxes are bare (see
 * `playwright.config.ts`); this file starts from an empty one, so a new box gets paper, as it does for
 * a person.
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { AUTOSAVE_QUIET_MS, dbVersion, decodePng, drag, editedText, openApp, openBlank, seedMilestone1, seedRaw, snapshotIdb, storedDoc } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredObject, View } from './helpers.ts'

test.use({ storageState: { cookies: [], origins: [] }, launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

const UNIT: View = { zoom: 1, panX: 0, panY: 0 }
/** `PAPER_PAD_X_EM` and `PAPER_PAD_Y_EM` in `src/model/paper.ts`. */
const PAD_X_EM = 1
const PAD_Y_EM = 0.75

const lines = (n: number) => Array.from({ length: n }, (_, i) => (i === 1 ? `Line ${i + 1}: a longer line of the review that has to wrap onto a second line` : `Line ${i + 1} of the review`)).join('\n')
const textRec = (id: string, left: number, top: number, extra: Record<string, unknown> = {}) => ({ type: 'text', id, left, top, angle: 0, text: lines(6), fontSize: 18, width: 320, ...extra })
type Block = Record<string, unknown>
const p = (text?: string): Block => (text ? { type: 'paragraph', content: [{ text }] } : { type: 'paragraph' })
const EVERY_BLOCK: Block[] = [
  { type: 'heading', level: 2, content: [{ text: 'Blue Lines' }] },
  { type: 'paragraph', content: [{ text: 'A review with ' }, { text: 'inline code', code: true }, { text: ' and more.' }] },
  { type: 'bulletList', items: [{ blocks: [p('Warm bassline')] }, { blocks: [p('Second bullet that wraps onto a second line')] }] },
  { type: 'orderedList', start: 9, items: [{ blocks: [p('nine')] }, { blocks: [p('ten')] }] },
  { type: 'taskList', items: [{ checked: true, blocks: [p('Check the remaster')] }, { checked: false, blocks: [p('Listen to side B')] }] },
  { type: 'blockquote', blocks: [p('A record that sounds like a city at night.')] },
  { type: 'divider' },
  { type: 'codeBlock', text: 'const side = "B"\nplay(side)' },
  p('The end.'),
]

interface PaperProbe {
  state: () => { viewport: View; canUndo: boolean; canRedo: boolean; dirty: boolean; selected: string[]; editing: boolean }
  select: (id: string) => void
  controls: () => Record<string, { x: number; y: number }> | null
  proxy: (id: string) => { width: number; height: number; angle: number; left: number; top: number } | null
  preview: (frameId: string) => Promise<string>
  history: () => number
  selectAll: () => void
  /** What saving would store for an object right now (during a gesture too). */
  record: (id: string) => Record<string, unknown> & { id: string }
}
declare global {
  interface Window {
    __paper: PaperProbe
  }
}

/** A probe on the app's editor (this test route only). */
async function installProbe(page: Page) {
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
      import { Editor as PaperEditor } from '/src/editor/Editor.ts'
      import { idOf as paperIdOf, toRecord as paperToRecord } from '/src/editor/objects.ts'
      const paperInit = PaperEditor.prototype.init
      PaperEditor.prototype.init = function () {
        const ed = this
        window.__paper = {
          state: () => ({ viewport: ed.getViewport(), canUndo: ed.history.canUndo, canRedo: ed.history.canRedo, dirty: ed.autosaver.hasUnsavedChanges, selected: ed.canvas.getActiveObjects().map((o) => paperIdOf(o)), editing: ed.getState().editingText }),
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
            const o = ed.canvas.getObjects().find((x) => paperIdOf(x) === id)
            return o ? { width: o.width, height: o.height, angle: o.angle, left: o.left, top: o.top } : null
          },
          preview: async (frameId) => {
            ed.selectLayer(frameId)
            const tour = ed.startFrameTour()
            if (!tour) throw new Error('no tour')
            return tour.renderFrame(frameId, new AbortController().signal)
          },
          history: () => ed.history.index,
          selectAll: () => ed.selectAll(),
          record: (id) => paperToRecord(ed.canvas.getObjects().find((x) => paperIdOf(x) === id)),
        }
        return paperInit.call(this)
      }
      ${source}
    `,
    })
  })
}

async function open(page: Page, objects: unknown[], opts: { frames?: unknown[]; view?: View; assets?: SeedAsset[]; version?: 1 | 2 | 3 } = {}) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openBlank(page)
  const frames = opts.frames ?? []
  const viewport = opts.view ?? UNIT
  const rich = objects.some((o) => ['blocks', 'height', 'surface'].some((k) => (o as Record<string, unknown>)[k] !== undefined))
  const version = opts.version ?? (rich ? 3 : frames.length > 0 || opts.assets ? 2 : 1)
  if (version === 1) await seedMilestone1(page, { version: 1, title: 'Paper', objects, viewport }, opts.assets)
  else await seedRaw(page, version, { version, title: 'Paper', frames, objects, viewport }, opts.assets)
  await installProbe(page)
  await openApp(page)
  return { errors }
}

const probe = (page: Page) => page.evaluate(() => window.__paper.state())

async function pt(page: Page, x: number, y: number) {
  const view = (await probe(page)).viewport
  const box = (await page.locator('.canvas-host').boundingBox())!
  return { x: box.x + x * view.zoom + view.panX, y: box.y + y * view.zoom + view.panY }
}

const byId = (doc: StoredBoard, id: string): StoredObject & Record<string, unknown> => {
  const found = doc.objects.find((o) => o.id === id)
  if (!found) throw new Error(`no object ${id}`)
  return found as StoredObject & Record<string, unknown>
}
const texts = (doc: StoredBoard) => doc.objects.filter((o) => o.type === 'text') as Array<StoredObject & Record<string, unknown>>
async function storedWhen(page: Page, check: (doc: StoredBoard) => boolean): Promise<StoredBoard> {
  await expect.poll(async () => check(await storedDoc(page)), { timeout: 5000 }).toBe(true)
  return storedDoc(page)
}

async function selectById(page: Page, id: string) {
  await page.evaluate((id) => window.__paper.select(id), id)
  await expect.poll(async () => (await probe(page)).selected).toEqual([id])
}

async function handle(page: Page, key: string) {
  const c = await page.evaluate(() => window.__paper.controls())
  if (!c?.[key]) throw new Error(`no ${key} handle`)
  return c[key]!
}

const paperButton = (page: Page) => page.getByRole('button', { name: 'Paper', exact: true })

/** The middle of every character of a card on the page (its box's middle, however it is turned), and the card's look. */
function glyphs(page: Page, id: string) {
  return page.evaluate((id) => {
    const card = document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"]`)!
    const body = card.firstElementChild as HTMLElement
    const out: number[][] = []
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (let i = 0; i < (n as Text).data.length; i++) {
        range.setStart(n, i)
        range.setEnd(n, i + 1)
        const r = range.getBoundingClientRect()
        out.push([r.left + r.width / 2, r.top + r.height / 2])
      }
    }
    return out
  }, id)
}

function expectSameGlyphs(a: number[][], b: number[][], tolerance = 0.5) {
  expect(a.length).toBe(b.length)
  let worst = 0
  a.forEach((g, i) => (worst = Math.max(worst, Math.abs(g[0]! - b[i]![0]!), Math.abs(g[1]! - b[i]![1]!))))
  expect(worst).toBeLessThanOrEqual(tolerance)
}

const look = (page: Page, id: string) =>
  page.evaluate((id) => {
    const card = document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"]`)!
    const cs = getComputedStyle(card)
    return { paper: card.classList.contains('has-paper'), background: cs.backgroundColor, shadow: cs.boxShadow, padding: cs.padding }
  }, id)

// ---- the plan's acceptance tests ------------------------------------------------------------------

test('new-box-has-paper-old-box-and-new-caption-stay-bare', async ({ page }) => {
  const image = { type: 'image', id: 'img', assetId: 'a1', left: 700, top: 120, angle: 0, scaleX: 1, scaleY: 1 }
  const old = textRec('old', 100, 400, { text: 'Written before paper' })
  const { errors } = await open(page, [old, image], { assets: [{ id: 'a1', name: 'a.png', width: 200, height: 120 }] })
  // A board from before paper: its text is bare, and opening it wrote nothing.
  const before = await snapshotIdb(page)
  expect(await look(page, 'old')).toMatchObject({ paper: false, background: 'rgba(0, 0, 0, 0)', shadow: 'none' })
  expect(await dbVersion(page)).toBe(2)
  // A new box left blank: discarded, nothing written, the database as it was.
  await page.keyboard.press('t')
  const blankAt = await pt(page, 150, 120)
  await page.mouse.click(blankAt.x, blankAt.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(AUTOSAVE_QUIET_MS + 300)
  expect(await snapshotIdb(page)).toEqual(before)
  expect(await dbVersion(page)).toBe(2)
  // A click-created box: paper, stored, and its first save upgrades the database in the same step.
  await page.keyboard.press('t')
  const clickAt = await pt(page, 150, 120)
  await page.mouse.click(clickAt.x, clickAt.y)
  await page.keyboard.type('clicked')
  const typed = await storedWhen(page, (d) => texts(d).some((t) => t.text === 'clicked'))
  const clicked = texts(typed).find((t) => t.text === 'clicked')!
  expect(clicked.surface).toBe('card')
  expect(typed.version).toBe(3)
  expect(await dbVersion(page)).toBe(3)
  await page.keyboard.press('Escape')
  expect(await look(page, clicked.id)).toMatchObject({ paper: true })
  // A drawn box: paper too.
  await page.keyboard.press('t')
  await drag(page, await pt(page, 150, 250), await pt(page, 450, 340))
  await page.keyboard.type('drawn')
  const drawnDoc = await storedWhen(page, (d) => texts(d).some((t) => t.text === 'drawn'))
  const drawn = texts(drawnDoc).find((t) => t.text === 'drawn')!
  expect(drawn).toMatchObject({ surface: 'card', width: 300, minHeight: 90 })
  await page.keyboard.press('Escape')
  // Add caption: bare.
  await selectById(page, 'img')
  await page.getByRole('button', { name: 'Add caption', exact: true }).click()
  await page.keyboard.type('a caption')
  const captioned = await storedWhen(page, (d) => texts(d).some((t) => t.text === 'a caption'))
  const caption = texts(captioned).find((t) => t.text === 'a caption')!
  expect(caption.captionOf).toBe('img')
  expect(caption).not.toHaveProperty('surface')
  // The old text was never touched.
  expect(byId(captioned, 'old')).toEqual(old)
  expect(errors).toEqual([])
})

for (const [angle, align, fontSize] of [[30, 'center', 18], [-20, 'right', 27.35], [0, undefined, 18]] as const) {
  test(`paper-toggle-keeps-words-in-place-and-is-one-undo-step (${angle}°, ${align ?? 'left'}, ${fontSize} px)`, async ({ page }) => {
    const frame = { id: 'f1', name: 'Spread', left: 40, top: 40, width: 900, height: 600 }
    const rec = textRec('t', 250, 200, { angle, fontSize, frameId: 'f1', ...(align && { align }) })
    const { errors } = await open(page, [rec], { frames: [frame] })
    await selectById(page, 't')
    const g0 = await glyphs(page, 't')
    const h0 = await page.evaluate(() => window.__paper.history())
    await paperButton(page).click()
    const on = await storedWhen(page, (d) => byId(d, 't').surface === 'card')
    const t1 = byId(on, 't')
    // The words did not move or re-wrap (every glyph within half a pixel), the box grew by the padding.
    expectSameGlyphs(await glyphs(page, 't'), g0)
    expect(Math.abs((t1.width as number) - (320 + 2 * PAD_X_EM * fontSize))).toBeLessThanOrEqual(0.011)
    expect(t1.frameId).toBe('f1')
    await expect(paperButton(page)).toHaveAttribute('aria-pressed', 'true')
    expect(await look(page, 't')).toMatchObject({ paper: true })
    expect(await page.evaluate(() => window.__paper.history())).toBe(h0 + 1) // one undo step
    // And off again: back to where it was, the same words in the same places.
    await paperButton(page).click()
    const off = await storedWhen(page, (d) => byId(d, 't').surface === undefined)
    expect(byId(off, 't')).toEqual(rec)
    expectSameGlyphs(await glyphs(page, 't'), g0)
    // Undo gives back the paper box exactly, and undo again the bare one.
    await page.keyboard.press('Control+z')
    await storedWhen(page, (d) => byId(d, 't').surface === 'card')
    expect(byId(await storedDoc(page), 't')).toEqual(t1)
    await page.keyboard.press('Control+z')
    await storedWhen(page, (d) => byId(d, 't').surface === undefined)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    expect(errors).toEqual([])
  })
}

test('paper-box-geometry-floors-and-click-origin', async ({ page }) => {
  const { errors } = await open(page, [textRec('bare', 100, 420, { text: 'Antidisestablishment words', width: 400 })])
  // A click puts the words, not the sheet, at the press point.
  await page.keyboard.press('t')
  const at = await pt(page, 180, 140)
  await page.mouse.click(at.x, at.y)
  await page.keyboard.type('Ink here')
  const doc = await storedWhen(page, (d) => texts(d).some((t) => t.text === 'Ink here'))
  const made = texts(doc).find((t) => t.text === 'Ink here')!
  const fs = made.fontSize as number
  expect(made).toMatchObject({ surface: 'card', left: 180 - PAD_X_EM * fs, top: 140 - PAD_Y_EM * fs, width: 10 * fs + 2 * PAD_X_EM * fs })
  await page.keyboard.press('Escape')
  const first = (await glyphs(page, made.id))[0]!
  const letter = await page.evaluate((id) => {
    const body = document.querySelector(`.scene-text[data-id="${id}"] > .scene-text-body`)!
    const range = document.createRange()
    const t = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!
    range.setStart(t, 0)
    range.setEnd(t, 1)
    return range.getBoundingClientRect().left
  }, made.id)
  expect(Math.abs(letter - at.x)).toBeLessThanOrEqual(1)
  expect(first[1]).toBeGreaterThan(at.y) // the first line hangs from the press point
  // The side handle cannot narrow a paper box below its widest word plus the padding: the floor of the
  // same words without paper (measured on a bare twin) and 2 × padX.
  await selectById(page, 'bare')
  let mr = await handle(page, 'mr')
  await drag(page, mr, { x: mr.x - 600, y: mr.y })
  const bareFloor = byId(await storedWhen(page, (d) => (byId(d, 'bare').width as number) < 400), 'bare').width as number
  await paperButton(page).click()
  await storedWhen(page, (d) => byId(d, 'bare').surface === 'card')
  expect(byId(await storedDoc(page), 'bare').width).toBeCloseTo(bareFloor + 2 * PAD_X_EM * 18, 1)
  mr = await handle(page, 'mr')
  await drag(page, mr, { x: mr.x - 600, y: mr.y })
  await page.waitForTimeout(400)
  expect(byId(await storedDoc(page), 'bare').width).toBeCloseTo(bareFloor + 2 * PAD_X_EM * 18, 1)
  // A corner scale by k scales the padding with the font size and stores no extra field.
  const before = byId(await storedDoc(page), 'bare')
  const tl = await handle(page, 'tl')
  const br = await handle(page, 'br')
  await drag(page, br, { x: tl.x + (br.x - tl.x) * 1.5, y: tl.y + (br.y - tl.y) * 1.5 }, { steps: 10 })
  const scaled = byId(await storedWhen(page, (d) => byId(d, 'bare').fontSize !== 18), 'bare')
  const k = (scaled.fontSize as number) / 18
  expect(Object.keys(scaled).sort()).toEqual(Object.keys(before).sort())
  // Both stored at two decimals: the width and the font size scaled by the same factor.
  expect(Math.abs((scaled.width as number) / (before.width as number) - k)).toBeLessThan(0.001)
  // The margins are rounded as records are (two decimals), so turning paper off and on is exact.
  const r2 = (n: number) => Math.round(n * 100) / 100
  expect(await look(page, 'bare')).toMatchObject({ padding: `${r2(PAD_Y_EM * (scaled.fontSize as number))}px ${r2(PAD_X_EM * (scaled.fontSize as number))}px` })
  expect(errors).toEqual([])
})

test('paper-renders-in-frame-preview-and-with-caption-background', async ({ page }) => {
  const frame = { id: 'f1', name: 'Spread', left: 0, top: 0, width: 800, height: 520 }
  const image = { type: 'image', id: 'img', assetId: 'a1', left: 480, top: 80, angle: 0, scaleX: 1, scaleY: 1, frameId: 'f1' }
  const paperText = textRec('p', 60, 60, { surface: 'card', text: 'Paper in a preview', width: 320, frameId: 'f1' })
  const caption = textRec('cap', 480, 210, { surface: 'card', text: 'A paper caption', width: 200, captionOf: 'img', minHeight: 0, frameId: 'f1' })
  const { errors } = await open(page, [paperText, image, caption], { frames: [frame], assets: [{ id: 'a1', name: 'a.png', width: 200, height: 120 }] })
  // The preview draws the sheet at its place: the paper's colour in its padding, and its shadow below it.
  const url = await page.evaluate(() => window.__paper.preview('f1'))
  const png = decodePng(Buffer.from(url.split(',')[1]!, 'base64'))
  const scale = png.width / frame.width
  const px = (x: number, y: number) => {
    const i = (Math.round(y * scale) * png.width + Math.round(x * scale)) * 4
    return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
  }
  const box = (await page.evaluate(() => window.__paper.proxy('p')))!
  const inPadding = px(60 + 4, 60 + box.height / 2)
  expect(inPadding).toEqual([255, 253, 248]) // --paper-fill, not the frame's white
  // The edge (--paper-edge): a hairline ring just outside the sheet. On its left side halfway down it
  // reads about 225; the shadow alone takes it only to about 245 there.
  const ring = px(60 - 0.5, 60 + box.height / 2)
  expect(ring[0]).toBeLessThan(235)
  const belowEdge = px(60 + 160, 60 + box.height + 2)
  expect(belowEdge[0]).toBeLessThan(255) // the shadow, drawn past the sheet, not clipped
  const farBelow = px(60 + 160, 60 + box.height + 40)
  expect(farBelow).toEqual([255, 255, 255])
  // A paper caption keeps its paper when attached; a caption background fills the sheet instead.
  expect(await look(page, 'cap')).toMatchObject({ paper: true, background: 'rgb(255, 253, 248)' })
  await selectById(page, 'img')
  await page.getByRole('checkbox', { name: 'Caption background' }).check()
  await storedWhen(page, (d) => byId(d, 'cap').captionBackground !== undefined)
  const withBackground = byId(await storedDoc(page), 'cap')
  expect(withBackground).toMatchObject({ surface: 'card', captionOf: 'img', captionBackground: '#ffffff' })
  expect(await look(page, 'cap')).toMatchObject({ paper: true, background: 'rgb(255, 255, 255)' })
  expect(errors).toEqual([])
})

// ---- more of paper ----------------------------------------------------------------------------------

test('the toggle on a text holding every writing block, and on a fixed-height text scrolled to its middle', async ({ page }) => {
  const blocks = textRec('b', 80, 60, { text: 'x', blocks: EVERY_BLOCK, width: 380 })
  const fixed = textRec('f', 560, 60, { text: lines(30), height: 200 })
  const { errors } = await open(page, [blocks, fixed])
  for (const id of ['b', 'f']) {
    if (id === 'f') {
      const at = await pt(page, 700, 150)
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: 150 })), at)
    }
    await page.waitForTimeout(250)
    await selectById(page, id)
    const scrolled = await page.evaluate((id) => document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"] > .scene-text-body`)!.scrollTop, id)
    const g0 = await glyphs(page, id)
    await paperButton(page).click()
    await storedWhen(page, (d) => byId(d, id).surface === 'card')
    expectSameGlyphs(await glyphs(page, id), g0)
    // A fixed-height text stays where it was scrolled: the same lines show.
    expect(await page.evaluate((id) => document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"] > .scene-text-body`)!.scrollTop, id)).toBe(scrolled)
  }
  expect(byId(await storedDoc(page), 'f').height).toBe(200 + 2 * PAD_Y_EM * 18)
  // The fades are on the words, never on the sheet: the card has no mask, its body does.
  const masks = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.scene-text[data-id="f"]')!
    return { card: getComputedStyle(card).maskImage, body: getComputedStyle(card.firstElementChild as HTMLElement).maskImage, fades: card.classList.contains('fade-top') && card.classList.contains('fade-bottom') }
  })
  expect(masks).toMatchObject({ card: 'none', fades: true })
  expect(masks.body).toContain('gradient')
  expect(byId(await storedDoc(page), 'b').blocks).toEqual(EVERY_BLOCK)
  expect(errors).toEqual([])
})

test('inside an edit the toggle is part of the edit’s one step; a locked text refuses it', async ({ page }) => {
  const { errors } = await open(page, [textRec('t', 100, 100, { text: 'one' }), textRec('l', 500, 100, { text: 'locked', locked: true })])
  const at = await pt(page, 120, 110)
  await page.mouse.dblclick(at.x, at.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' two')
  await paperButton(page).click()
  await storedWhen(page, (d) => byId(d, 't').surface === 'card')
  expect(await editedText(page)).toMatchObject({ focused: true }) // the edit goes on
  await page.keyboard.type(' three')
  await page.keyboard.press('Escape')
  await storedWhen(page, (d) => byId(d, 't').text === 'one two three')
  await page.keyboard.press('Control+z')
  const undone = await storedWhen(page, (d) => byId(d, 't').text === 'one')
  expect(byId(undone, 't')).not.toHaveProperty('surface') // words and paper come back together
  // Locked: the button is there but refused.
  await selectById(page, 'l')
  await expect(paperButton(page)).toBeDisabled()
  expect(errors).toEqual([])
})

test('a paper box: least fixed height, ownership by the sheet’s centre, duplicate', async ({ page }) => {
  const frame = { id: 'f1', name: 'Spread', left: 40, top: 40, width: 600, height: 300 }
  const rec = textRec('t', 80, 200, { surface: 'card', text: lines(3), frameId: 'f1' })
  const { errors } = await open(page, [rec], { frames: [frame] })
  await selectById(page, 't')
  // The bottom handle stops at one and a half lines plus the padding above and below.
  const mb = await handle(page, 'mb')
  await drag(page, mb, { x: mb.x, y: mb.y - 400 })
  const short = byId(await storedWhen(page, (d) => byId(d, 't').height !== undefined), 't')
  expect(short.height).toBe(Math.round(18 * (1.5 + 2 * PAD_Y_EM)))
  // Taller, until the sheet's centre leaves the frame (which ends at 340): loose.
  const mb2 = await handle(page, 'mb')
  await drag(page, mb2, { x: mb2.x, y: (await pt(page, 0, 200 + 320)).y })
  const tall = byId(await storedWhen(page, (d) => (byId(d, 't').height as number) > 300), 't')
  expect(tall.frameId).toBeUndefined()
  // Duplicate copies the paper.
  await page.keyboard.press('Control+d')
  const dup = await storedWhen(page, (d) => texts(d).length === 2)
  expect(texts(dup).every((t) => t.surface === 'card')).toBe(true)
  expect(errors).toEqual([])
})

test('a board from before paper: loading writes nothing, and an edit stores it in its old form', async ({ page }) => {
  const old = textRec('old', 100, 100, { text: 'plain' })
  const { errors } = await open(page, [old])
  const before = await snapshotIdb(page)
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(await snapshotIdb(page)).toEqual(before)
  await selectById(page, 'old')
  const from = await pt(page, 130, 110)
  await drag(page, from, { x: from.x + 30, y: from.y + 10 })
  const moved = await storedWhen(page, (d) => byId(d, 'old').left !== 100)
  expect(moved.version).toBe(1)
  expect(byId(moved, 'old')).not.toHaveProperty('surface')
  expect(await dbVersion(page)).toBe(1)
  // Paper turned on upgrades it, once; turned off again it is stored in its old form, the database left at 3.
  await paperButton(page).click()
  expect((await storedWhen(page, (d) => byId(d, 'old').surface === 'card')).version).toBe(3)
  expect(await dbVersion(page)).toBe(3)
  await paperButton(page).click()
  expect((await storedWhen(page, (d) => byId(d, 'old').surface === undefined)).version).toBe(1)
  expect(await dbVersion(page)).toBe(3)
  expect(errors).toEqual([])
})

test('a press on the sheet round the words, while they are edited, puts the caret in the words and keeps the edit', async ({ page }) => {
  const { errors } = await open(page, [textRec('t', 100, 100, { surface: 'card', text: 'first line\nsecond line' })])
  const inWords = await pt(page, 100 + PAD_X_EM * 18 + 20, 100 + PAD_Y_EM * 18 + 8)
  await page.mouse.dblclick(inWords.x, inWords.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.waitForTimeout(700) // not a third click of the double-click
  // In the left padding, beside the first line: the caret at its start.
  const padding = await pt(page, 100 + 4, 100 + PAD_Y_EM * 18 + 8)
  await page.mouse.click(padding.x, padding.y)
  await expect.poll(async () => await editedText(page)).toMatchObject({ start: 0, end: 0, focused: true })
  expect((await probe(page)).editing).toBe(true)
  await page.keyboard.type('X')
  await storedWhen(page, (d) => byId(d, 't').text === 'Xfirst line\nsecond line')
  expect(errors).toEqual([])
})

// ---- the first review's faults --------------------------------------------------------------------

/** "Line 1" … "Line n", one to a line, and where line `k` (from 0) starts and ends in it. */
const shortLines = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n')
const lineStart = (k: number) => Array.from({ length: k }, (_, i) => `Line ${i + 1}`.length + 1).reduce((a, b) => a + b, 0)
const lineEnd = (k: number) => lineStart(k) + `Line ${k + 1}`.length

/** A point given in a box's own coordinates (its top-left corner at 0, 0, turned with it) on the page. */
function local(page: Page, box: { left: number; top: number; angle: number }, x: number, y: number) {
  const a = (box.angle * Math.PI) / 180
  return pt(page, box.left + x * Math.cos(a) - y * Math.sin(a), box.top + x * Math.sin(a) + y * Math.cos(a))
}

/** The height of one line of a card whose body holds `n` single lines (its own layout, untransformed). */
const lineHeight = (page: Page, id: string, n: number) =>
  page.evaluate(({ id, n }) => parseFloat(getComputedStyle(document.querySelector(`.scene-text[data-id="${id}"] > .scene-text-body`)!).height) / n, { id, n })

const NOT_A_DOUBLE_CLICK_MS = 650

/** Selects "Line" at the start of line 5 with the keyboard. */
async function selectLine5Word(page: Page) {
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => editedText(page)).toMatchObject({ start: lineStart(4), end: lineStart(4) + 4 })
}

test('the reviewer’s case: with a word selected on line 5, a click in the left margin beside line 1 puts a bare caret at its start', async ({ page }) => {
  const rec = textRec('t', 100, 40, { surface: 'card', text: shortLines(28), width: 220 })
  const { errors } = await open(page, [rec])
  const lh = await lineHeight(page, 't', 28)
  const into = await local(page, rec, 18 + 12, 13.5 + lh * 2.5)
  await page.mouse.dblclick(into.x, into.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.waitForTimeout(NOT_A_DOUBLE_CLICK_MS)
  await selectLine5Word(page)
  const margin = await local(page, rec, 9, 13.5 + lh * 0.5)
  await page.mouse.click(margin.x, margin.y)
  await expect.poll(() => editedText(page)).toMatchObject({ start: 0, end: 0, focused: true })
  await page.keyboard.type('X')
  await storedWhen(page, (d) => byId(d, 't').text === `X${shortLines(28)}`)
  expect(errors).toEqual([])
})

for (const zoom of [0.5, 1, 2]) {
  for (const angle of [0, 25]) {
    test(`a press in any margin of an edited paper text puts a bare caret at the nearest place on the line beside it; Shift extends (zoom ${zoom}, ${angle}°)`, async ({ page }) => {
      const N = 10
      const W = 256 // the words 220 wide inside 18 px margins
      const approxH = N * 22.5 + 27
      const a = (angle * Math.PI) / 180
      const cx = 200 + (W / 2) * Math.cos(a) - (approxH / 2) * Math.sin(a)
      const cy = 150 + (W / 2) * Math.sin(a) + (approxH / 2) * Math.cos(a)
      const rec = textRec('t', 200, 150, { surface: 'card', text: shortLines(N), width: W, angle })
      const { errors } = await open(page, [rec], { view: { zoom, panX: Math.round(640 - zoom * cx), panY: Math.round(400 - zoom * cy) } })
      const lh = await lineHeight(page, 't', N)
      const H = 27 + N * lh
      const press = async (x: number, y: number, expected: { start: number; end: number }, what: string, shift = false) => {
        const at = await local(page, rec, x, y)
        if (shift) await page.keyboard.down('Shift')
        await page.mouse.click(at.x, at.y)
        if (shift) await page.keyboard.up('Shift')
        await expect.poll(() => editedText(page), { message: what }).toMatchObject({ ...expected, focused: true })
        expect((await probe(page)).editing, what).toBe(true)
        await page.waitForTimeout(NOT_A_DOUBLE_CLICK_MS)
      }
      const into = await local(page, rec, 18 + 12, 13.5 + lh * 2.5)
      await page.mouse.dblclick(into.x, into.y)
      await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
      await page.waitForTimeout(NOT_A_DOUBLE_CLICK_MS)
      // With a selection: the left margin beside line 1 (its start), the right margin beside line 2 (its end).
      await selectLine5Word(page)
      await press(9, 13.5 + lh * 0.5, { start: 0, end: 0 }, 'left margin, a selection')
      await selectLine5Word(page)
      await press(W - 9, 13.5 + lh * 1.5, { start: lineEnd(1), end: lineEnd(1) }, 'right margin, a selection')
      // With a caret: the top margin, over the right of the first line (its end); the bottom margin, under the start of the last.
      await press(W - 18 - 3, 6.75, { start: lineEnd(0), end: lineEnd(0) }, 'top margin, a caret')
      await press(18 + 2, H - 6.75, { start: lineStart(N - 1), end: lineStart(N - 1) }, 'bottom margin, a caret')
      // Shift: from there to the start of line 3, beside it in the left margin.
      await press(9, 13.5 + lh * 2.5, { start: lineStart(2), end: lineStart(N - 1) }, 'left margin with Shift', true)
      await page.keyboard.type('X')
      await storedWhen(page, (d) => byId(d, 't').text === `${shortLines(N).slice(0, lineStart(2))}X${shortLines(N).slice(lineStart(N - 1))}`)
      expect(errors).toEqual([])
    })
  }
}

/** A card's drawn height (its body and any paper padding), its body's, the proxy's and the selection box's (scene units). */
async function heights(page: Page, id: string) {
  const drawn = await page.evaluate((id) => {
    const card = document.querySelector<HTMLElement>(`.scene-text[data-id="${id}"]`)!
    const body = parseFloat(getComputedStyle(card.firstElementChild as HTMLElement).height)
    const cs = getComputedStyle(card)
    return { card: body + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), body }
  }, id)
  const proxy = (await page.evaluate((id) => window.__paper.proxy(id), id))!
  const zoom = (await probe(page)).viewport.zoom
  const c = await page.evaluate(() => window.__paper.controls())
  const selection = c ? Math.hypot(c.mb!.x - c.mt!.x, c.mb!.y - c.mt!.y) / zoom : null
  return { ...drawn, proxy: proxy.height, selection }
}

for (const surface of ['card', undefined] as const) {
  test(`a larger font size raises a fixed height below the least one for it, in the same step, and everything agrees (${surface ?? 'bare'})`, async ({ page }) => {
    const rec = textRec('t', 100, 100, { text: shortLines(6), fontSize: 24, height: 72, ...(surface && { surface }) })
    const { errors } = await open(page, [rec])
    const least = surface ? 192 : 96 // 1.5 × 64, and on paper the 48 px margins above and below
    // The selection box is the proxy plus Fabric's own padding round it.
    await selectById(page, 't')
    const start = await heights(page, 't')
    const around = start.selection! - start.proxy
    const agree = async (what: string) => {
      const h = await heights(page, 't')
      expect(byId(await storedDoc(page), 't').height, what).toBe(least)
      expect(h.proxy, what).toBeCloseTo(least, 2)
      expect(h.card, what).toBeCloseTo(least, 2)
      expect(h.body, what).toBeCloseTo(96, 2) // a line and a half of words, never a sliver
      expect(Math.abs(h.selection! - around - least), what).toBeLessThanOrEqual(0.5)
    }
    // Outside an edit.
    await page.getByLabel('Font size').fill('64')
    await storedWhen(page, (d) => byId(d, 't').fontSize === 64)
    await agree('font size 64')
    if (surface) {
      // Off and on again: exactly as it was.
      await paperButton(page).click()
      await storedWhen(page, (d) => byId(d, 't').surface === undefined)
      expect(byId(await storedDoc(page), 't').height).toBe(96)
      await paperButton(page).click()
      await storedWhen(page, (d) => byId(d, 't').surface === 'card')
      await agree('off and on')
      await page.getByRole('button', { name: 'Undo', exact: true }).click() // not Ctrl+Z: the Font size field has the keyboard
      await page.getByRole('button', { name: 'Undo', exact: true }).click() // not Ctrl+Z: the Font size field has the keyboard
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click() // not Ctrl+Z: the Font size field has the keyboard
    await storedWhen(page, (d) => byId(d, 't').fontSize === 24)
    expect(byId(await storedDoc(page), 't')).toEqual(rec) // the size and the height come back together
    // While the text is edited.
    const into = await pt(page, 100 + (surface ? 24 : 0) + 20, 100 + (surface ? 18 : 0) + 12)
    await page.mouse.dblclick(into.x, into.y)
    await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
    await page.getByLabel('Font size').fill('64')
    await storedWhen(page, (d) => byId(d, 't').fontSize === 64)
    expect(byId(await storedDoc(page), 't').height).toBe(least)
    expect((await heights(page, 't')).body).toBeCloseTo(96, 2)
    const away = await pt(page, 900, 600)
    await page.mouse.click(away.x, away.y)
    await expect.poll(async () => (await probe(page)).editing).toBe(false)
    await page.getByRole('button', { name: 'Undo', exact: true }).click() // not Ctrl+Z: the Font size field has the keyboard
    await storedWhen(page, (d) => byId(d, 't').fontSize === 24)
    expect(byId(await storedDoc(page), 't')).toEqual(rec)
    expect(errors).toEqual([])
  })
}

test('a stored fixed height below the least one (an older build) opens as it is, drawn at the least one', async ({ page }) => {
  const rec = textRec('t', 100, 100, { text: shortLines(6), fontSize: 64, height: 72 })
  const { errors } = await open(page, [rec])
  const before = await snapshotIdb(page)
  await page.waitForTimeout(AUTOSAVE_QUIET_MS)
  expect(await snapshotIdb(page)).toEqual(before)
  const h = await heights(page, 't')
  expect(h.body).toBeCloseTo(96, 2)
  expect(h.proxy).toBeCloseTo(96, 2)
  expect(byId(await storedDoc(page), 't')).toEqual(rec)
  expect(errors).toEqual([])
})

test('the reviewer’s case: paper off and on for a corner-scaled, scrolled, fixed-height text keeps it where it was scrolled, and ten offs and ons give back the record exactly', async ({ page }) => {
  const rec = textRec('t', 140, 90, { fontSize: 24, width: 320, height: 138.33, minHeight: 60.17, text: lines(29), surface: 'card' })
  const { errors } = await open(page, [rec])
  await selectById(page, 't')
  const br = await handle(page, 'br')
  await drag(page, br, { x: br.x + 57, y: br.y + 23 }, { steps: 10 })
  const scaled = byId(await storedWhen(page, (d) => byId(d, 't').fontSize !== 24), 't')
  expect(Number.isInteger((scaled.fontSize as number) * 4)).toBe(false) // a fractional size: the case that drifted
  const inside = await pt(page, (scaled.left as number) + 100, (scaled.top as number) + 85)
  await page.mouse.move(inside.x, inside.y)
  await page.mouse.wheel(0, 235)
  await page.waitForTimeout(300)
  const shownTop = () => page.evaluate(() => document.querySelector<HTMLElement>('.scene-text[data-id="t"] > .scene-text-body')!.scrollTop)
  const scrolled = await shownTop()
  expect(scrolled).toBeGreaterThan(100)
  const g0 = await glyphs(page, 't')
  for (const surface of [undefined, 'card']) {
    await paperButton(page).click()
    await storedWhen(page, (d) => byId(d, 't').surface === surface)
    await page.waitForTimeout(100)
    expect(await shownTop()).toBe(scrolled)
    expectSameGlyphs(await glyphs(page, 't'), g0)
  }
  expect(byId(await storedDoc(page), 't')).toEqual(scaled)
  for (let i = 0; i < 9; i++) {
    await paperButton(page).click()
    await paperButton(page).click()
  }
  await expect(paperButton(page)).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(AUTOSAVE_QUIET_MS + 200)
  expect(JSON.stringify(byId(await storedDoc(page), 't'))).toBe(JSON.stringify(scaled))
  expect(await shownTop()).toBe(scrolled)
  expect(errors).toEqual([])
})

test('the Paper button on a new box before anything is typed shows what the box has and toggles every time; the box keeps that choice', async ({ page }) => {
  const { errors } = await open(page, [textRec('old', 100, 500, { text: 'old' })])
  const before = await snapshotIdb(page)
  await page.keyboard.press('t')
  const at = await pt(page, 300, 200)
  await page.mouse.click(at.x, at.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  const showing = async () => ({ pressed: await paperButton(page).getAttribute('aria-pressed'), paper: await page.locator('.scene-text.is-editing').evaluate((el) => el.classList.contains('has-paper')) })
  expect(await showing()).toEqual({ pressed: 'true', paper: true })
  for (const on of [false, true, false]) {
    await paperButton(page).click()
    await expect.poll(showing).toEqual({ pressed: String(on), paper: on })
  }
  // Left blank: discarded, nothing written.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(AUTOSAVE_QUIET_MS + 300)
  expect(await snapshotIdb(page)).toEqual(before)
  // Again, and typed into: stored as chosen, the words where the press put them.
  await page.keyboard.press('t')
  await page.mouse.click(at.x, at.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await paperButton(page).click()
  await expect.poll(showing).toEqual({ pressed: 'false', paper: false })
  await page.keyboard.type('bare by choice')
  const doc = await storedWhen(page, (d) => texts(d).some((t) => t.text === 'bare by choice'))
  const made = texts(doc).find((t) => t.text === 'bare by choice')!
  expect(made).not.toHaveProperty('surface')
  expect(made).toMatchObject({ left: 300, top: 200, width: 10 * (made.fontSize as number) })
  expect(errors).toEqual([])
})

test('an attached caption’s sheet stays against its image when paper is toggled, so its words move by the margin', async ({ page }) => {
  const image = { type: 'image', id: 'img', assetId: 'a1', left: 480, top: 80, angle: 0, scaleX: 1, scaleY: 1 }
  const caption = textRec('cap', 500, 207, { text: 'At a point on the edge', width: 160, captionOf: 'img', captionPosition: 0.5 })
  const { errors } = await open(page, [image, caption], { assets: [{ id: 'a1', name: 'a.png', width: 200, height: 120 }] })
  const edges = () =>
    page.evaluate(() => {
      const img = document.querySelector('.scene-image[data-id="img"]')!.getBoundingClientRect()
      const cap = document.querySelector('.scene-text[data-id="cap"]')!.getBoundingClientRect()
      return { gap: cap.top - img.bottom, centre: (cap.left + cap.right) / 2 - (img.left + img.right) / 2 }
    })
  const e0 = await edges()
  const g0 = await glyphs(page, 'cap')
  await selectById(page, 'cap')
  await paperButton(page).click()
  await storedWhen(page, (d) => byId(d, 'cap').surface === 'card')
  const e1 = await edges()
  // The sheet (the box) is placed against the image as the bare caption was: the same gap, the same place along the edge.
  expect(Math.abs(e1.gap - e0.gap)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(e1.centre - e0.centre)).toBeLessThanOrEqual(0.5)
  // So its words move down by the top margin (0.75 em of 18 px).
  const g1 = await glyphs(page, 'cap')
  expect(Math.abs(g1[0]![1]! - g0[0]![1]! - PAD_Y_EM * 18)).toBeLessThanOrEqual(0.5)
  expect(byId(await storedDoc(page), 'cap')).toMatchObject({ captionOf: 'img', captionPosition: 0.5 })
  expect(errors).toEqual([])
})

// ---- the second review's faults ---------------------------------------------------------------------

/** One line of every kind, nested lists three deep among them; in the order they are shown. */
const ALL_LINES: Block[] = [
  { type: 'heading', level: 2, content: [{ text: 'Heading line' }] },
  { type: 'bulletList', items: [{ blocks: [p('Parent'), { type: 'bulletList', items: [{ blocks: [p('Nested item'), { type: 'bulletList', items: [{ blocks: [p('Third deep')] }] }] }] }] }] },
  { type: 'taskList', items: [{ checked: true, blocks: [p('Ticked')] }, { checked: false, blocks: [p('Open')] }] },
  { type: 'blockquote', blocks: [p('Quoted')] },
  { type: 'blockquote', blocks: [{ type: 'bulletList', items: [{ blocks: [p('Quote list')] }] }] },
  { type: 'codeBlock', text: 'code one\ncode two' },
  p(),
  { type: 'divider' },
  p('After divider'),
]
/** The plain text's lines (a code block's lines are lines of it; a divider is none). */
const ALL_LINE_TEXTS = ['Heading line', 'Parent', 'Nested item', 'Third deep', 'Ticked', 'Open', 'Quoted', 'Quote list', 'code one', 'code two', '', 'After divider']
const startOfLine = (k: number) => ALL_LINE_TEXTS.slice(0, k).reduce((a, l) => a + l.length + 1, 0)

/** A page point in a box's own coordinates (the inverse of `local`). */
async function toLocal(page: Page, box: { left: number; top: number; angle: number }, clientX: number, clientY: number) {
  const view = (await probe(page)).viewport
  const host = (await page.locator('.canvas-host').boundingBox())!
  const sx = (clientX - host.x - view.panX) / view.zoom - box.left
  const sy = (clientY - host.y - view.panY) / view.zoom - box.top
  const a = (box.angle * Math.PI) / 180
  return { x: sx * Math.cos(a) + sy * Math.sin(a), y: -sx * Math.sin(a) + sy * Math.cos(a) }
}

/** The centre on the page of every line of the text `t` (and of its divider), in order, edited or not. */
const shownLines = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('.scene-text[data-id="t"] > .scene-text-body')!
    const out: Array<{ text: string; x: number; y: number; divider?: true }> = []
    const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    for (const el of Array.from(root.querySelectorAll('p, h1, h2, h3, pre, hr'))) {
      if (el.tagName === 'HR') out.push({ text: '', ...centre(el.getBoundingClientRect()), divider: true })
      else if (el.tagName !== 'PRE') out.push({ text: el.textContent ?? '', ...centre(el.getBoundingClientRect()) })
      else {
        const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() as Text
        let from = 0
        for (const line of node.data.split('\n')) {
          const range = document.createRange()
          range.setStart(node, from)
          range.setEnd(node, from + line.length)
          out.push({ text: line, ...centre(range.getBoundingClientRect()) })
          from += line.length + 1
        }
      }
    }
    return out
  })

const PLACEMENTS = [
  { name: 'upright', angle: 0, fixed: false },
  { name: 'turned 25°', angle: 25, fixed: false },
  { name: 'scrolled', angle: 0, fixed: true },
  { name: 'scrolled and turned 115°', angle: 115, fixed: true },
] as const

for (const align of [undefined, 'center', 'right'] as const) {
  for (const zoom of [0.5, 1, 2]) {
    for (const placement of PLACEMENTS) {
      test(`a margin press lands on the line level with it, at its start (left) or end (right), for every kind of line (${align ?? 'left'}, zoom ${zoom}, ${placement.name})`, async ({ page }) => {
        const W = 300
        const H = placement.fixed ? 260 : 420 // about the whole text when it grows
        const a = (placement.angle * Math.PI) / 180
        const cx = 200 + (W / 2) * Math.cos(a) - (H / 2) * Math.sin(a)
        const cy = 150 + (W / 2) * Math.sin(a) + (H / 2) * Math.cos(a)
        const rec = textRec('t', 200, 150, { surface: 'card', text: 'x', blocks: ALL_LINES, width: W, angle: placement.angle, ...(align && { align }), ...(placement.fixed && { height: H }) })
        const { errors } = await open(page, [rec], { view: { zoom, panX: Math.round(640 - zoom * cx), panY: Math.round(400 - zoom * cy) } })
        const into = (await shownLines(page)).find((l) => l.text === 'Heading line')!
        if (placement.fixed) {
          const mid = await local(page, rec, W / 2, H / 2)
          await page.mouse.move(mid.x, mid.y)
          await page.mouse.wheel(0, 90 * zoom)
          await page.waitForTimeout(1000) // the thumb fades: a press in the right margin is the sheet's
        }
        // Into the words: the line nearest the middle of what is shown.
        let target = into
        if (placement.fixed) {
          let best = Infinity
          for (const l of await shownLines(page)) {
            if (l.divider || l.text === '') continue
            const d = Math.abs((await toLocal(page, rec, l.x, l.y)).y - H / 2)
            if (d < best) [best, target] = [d, l]
          }
        }
        await page.mouse.dblclick(target.x, target.y)
        await expect.poll(async () => (await editedText(page))?.value.split('\n')).toEqual(ALL_LINE_TEXTS)
        await page.waitForTimeout(NOT_A_DOUBLE_CLICK_MS)
        const host = (await page.locator('.canvas-host').boundingBox())!
        let pressed = 0
        // Each line in turn, left margin then right: far apart, so no two presses make a double-click.
        for (let k = 0; k <= ALL_LINE_TEXTS.length; k++) {
          for (const side of ['left', 'right'] as const) {
            const lines = await shownLines(page)
            const words = lines.filter((l) => !l.divider)
            const line = k < ALL_LINE_TEXTS.length ? words[k]! : lines.find((l) => l.divider)!
            const at = await toLocal(page, rec, line.x, line.y)
            // Only lines well inside what is shown (the caret's reveal would scroll for one near a fade).
            if (placement.fixed && (at.y < 13.5 + 32 || at.y > H - 13.5 - 32)) continue
            const point = await local(page, rec, side === 'left' ? 9 : W - 9, at.y)
            if (point.x < host.x + 10 || point.x > host.x + host.width - 10 || point.y < host.y + 10 || point.y > host.y + host.height - 10) continue
            const onBoard = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.canvas-host'), point)
            if (!onBoard) continue
            await page.mouse.click(point.x, point.y)
            const what = `${side} margin beside ${line.divider ? 'the divider' : JSON.stringify(line.text)}`
            if (line.divider) {
              // The nearest line with words: the empty line above it, or the line below.
              const above = startOfLine(10)
              const below = startOfLine(11)
              const ends = side === 'left' ? [above, below] : [above, below + ALL_LINE_TEXTS[11]!.length]
              await expect.poll(async () => { const e = await editedText(page); return e?.start === e?.end && ends.includes(e!.start!) }, { message: what }).toBe(true)
            } else {
              const at0 = startOfLine(k) + (side === 'left' ? 0 : ALL_LINE_TEXTS[k]!.length)
              await expect.poll(() => editedText(page), { message: what }).toMatchObject({ start: at0, end: at0, focused: true })
            }
            pressed++
          }
        }
        expect(pressed).toBeGreaterThanOrEqual(placement.fixed ? 6 : 10)
        expect((await probe(page)).editing).toBe(true)
        expect(errors).toEqual([])
      })
    }
  }
}

test('the reviewer’s case: the left margin beside a nested item, typed into, puts the typing at its start', async ({ page }) => {
  const rec = textRec('t', 100, 80, { surface: 'card', text: 'x', blocks: [{ type: 'bulletList', items: [{ blocks: [p('Parent'), { type: 'bulletList', items: [{ blocks: [p('Nested item')] }] }] }] }], width: 300 })
  const { errors } = await open(page, [rec])
  const parent = (await shownLines(page)).find((l) => l.text === 'Parent')!
  await page.mouse.dblclick(parent.x, parent.y)
  await expect.poll(async () => (await editedText(page))?.focused).toBe(true)
  await page.waitForTimeout(NOT_A_DOUBLE_CLICK_MS)
  const nested = (await shownLines(page)).find((l) => l.text === 'Nested item')!
  const at = await toLocal(page, rec, nested.x, nested.y)
  const margin = await local(page, rec, 9, at.y)
  await page.mouse.click(margin.x, margin.y)
  await page.keyboard.type('X')
  await page.keyboard.press('Escape')
  const doc = await storedWhen(page, (d) => JSON.stringify(byId(d, 't').blocks).includes('XNested item'))
  expect(JSON.stringify(byId(doc, 't').blocks)).toContain('"Parent"')
  expect(errors).toEqual([])
})

test('a turned text loaded with a fixed height below its least one keeps it when another text changes', async ({ page }) => {
  const recs = [3, 70].flatMap((angle, i) => [
    textRec(`bare${angle}`, 100 + i * 500, 100, { text: 'I', fontSize: 64, width: 400, height: 72, angle }),
    textRec(`paper${angle}`, 100 + i * 500, 400, { text: 'I', fontSize: 64, width: 400, height: 72, angle, surface: 'card' }),
  ])
  const other = textRec('other', 100, 700, { text: 'another text' })
  const { errors } = await open(page, [...recs, other])
  // Drawn at the least one (96 bare, 192 on paper)…
  expect((await page.evaluate(() => window.__paper.proxy('bare3')))!.height).toBeCloseTo(96, 2)
  expect((await page.evaluate(() => window.__paper.proxy('paper70')))!.height).toBeCloseTo(192, 2)
  // …and stored as they were, after another text is changed and the board saved.
  await selectById(page, 'other')
  await paperButton(page).click()
  const doc = await storedWhen(page, (d) => byId(d, 'other').surface === 'card')
  for (const rec of recs) expect(byId(doc, rec.id), rec.id).toEqual(rec)
  expect(errors).toEqual([])
})

test('scaling a selection of a bare and a paper text at their least fixed heights holds both heights, during the drag and after it', async ({ page }) => {
  const bare = textRec('bare', 100, 100, { text: 'one', fontSize: 24, width: 200, height: 36 })
  const paper = textRec('paper', 360, 100, { text: 'two', fontSize: 24, width: 200, height: 72, surface: 'card' })
  const { errors } = await open(page, [bare, paper])
  await page.evaluate(() => window.__paper.selectAll())
  await expect.poll(async () => (await probe(page)).selected.sort()).toEqual(['bare', 'paper'])
  const least = (fontSize: number, onPaper: boolean) => Math.round(fontSize * 1.5) + (onPaper ? 2 * (Math.round(fontSize * 0.75 * 100) / 100) : 0)
  const br = await handle(page, 'br')
  const tl = await handle(page, 'tl')
  await page.mouse.move(br.x, br.y)
  await page.mouse.down()
  // About 1.9% larger: the heights scaled alone (36.64 and 73.27) fall just under the least ones (37 and 73.64).
  await page.mouse.move(tl.x + (br.x - tl.x) * 1.019, tl.y + (br.y - tl.y) * 1.019, { steps: 6 })
  const during = await page.evaluate(() => [window.__paper.record('bare'), window.__paper.record('paper')])
  for (const [rec, onPaper] of [[during[0]!, false], [during[1]!, true]] as const) {
    expect(rec.fontSize, 'scaled').not.toBe(24)
    expect(rec.height, `${rec.id} during the drag`).toBeGreaterThanOrEqual(least(rec.fontSize as number, onPaper))
  }
  await page.mouse.up()
  const doc = await storedWhen(page, (d) => byId(d, 'bare').fontSize !== 24 && byId(d, 'paper').fontSize !== 24)
  for (const [id, onPaper] of [['bare', false], ['paper', true]] as const) {
    const rec = byId(doc, id)
    expect(rec.height, `${id} after the drag`).toBeGreaterThanOrEqual(least(rec.fontSize as number, onPaper))
  }
  expect(errors).toEqual([])
})

// ---- the third review: what is drawn during a scale is what would be stored ----------------------

for (const [size, fontSize, zoom, factor] of [['1.9%', 24, 1, 1.019], ['10×', 8.32, 0.5, 10]] as const) {
  test(`a fixed-height text scaled in a selection is drawn at the height its record would have, during the drag and after it (${size})`, async ({ page }) => {
    const padY = Math.round(fontSize * 0.75 * 100) / 100
    const body = Math.round(fontSize * 1.5) // the least fixed height: what Slice 4's handle allows
    const bare = textRec('bare', 100, 100, { text: 'A', fontSize, width: fontSize * 8, height: body })
    const paper = textRec('paper', 100 + fontSize * 12, 100, { text: 'B', fontSize, width: fontSize * 8, height: Math.round((body + 2 * padY) * 100) / 100, surface: 'card' })
    const { errors } = await open(page, [bare, paper], { view: { zoom, panX: 80, panY: 80 } })
    await page.evaluate(() => window.__paper.selectAll())
    await expect.poll(async () => (await probe(page)).selected.sort()).toEqual(['bare', 'paper'])
    const br = await handle(page, 'br')
    const tl = await handle(page, 'tl')
    // Drawn (the card on the page) against stored (what saving would store now), in screen pixels.
    const compare = async (when: string) => {
      const rows = await page.evaluate(() =>
        ['bare', 'paper'].map((id) => ({ id, rec: window.__paper.record(id), drawn: document.querySelector(`.scene-text[data-id="${id}"]`)!.getBoundingClientRect().height })),
      )
      for (const { id, rec, drawn } of rows) {
        const least = Math.round((rec.fontSize as number) * 1.5) + (id === 'paper' ? 2 * (Math.round((rec.fontSize as number) * 0.75 * 100) / 100) : 0)
        expect(rec.height as number, `${id} ${when}: stored`).toBeGreaterThanOrEqual(least - 0.005)
        // Within a quarter of a screen pixel: the browser lays a card out in 1/64 px of its own, which a 10× scale makes about a tenth of a unit.
        expect(Math.abs(drawn - (rec.height as number) * zoom), `${id} ${when}: drawn ${drawn / zoom}, stored ${String(rec.height)}`).toBeLessThan(0.25)
      }
      return rows
    }
    await page.mouse.move(br.x, br.y)
    await page.mouse.down()
    await page.mouse.move(tl.x + (br.x - tl.x) * factor, tl.y + (br.y - tl.y) * factor, { steps: 10 })
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const during = await compare('during the drag')
    expect(during[0]!.rec.fontSize, 'scaled').not.toBe(fontSize)
    await page.mouse.up()
    await storedWhen(page, (d) => byId(d, 'bare').fontSize !== fontSize)
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const after = await compare('after the drag')
    // Nothing jumps on release (to within a pixel).
    for (let k = 0; k < 2; k++) expect(Math.abs(after[k]!.drawn - during[k]!.drawn), `${after[k]!.id} on release`).toBeLessThan(0.5)
    expect(errors).toEqual([])
  })
}
