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
      import { idOf as paperIdOf } from '/src/editor/objects.ts'
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
  expect(await look(page, 'bare')).toMatchObject({ padding: `${+(PAD_Y_EM * (scaled.fontSize as number)).toFixed(4)}px ${+(PAD_X_EM * (scaled.fontSize as number)).toFixed(4)}px` })
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
