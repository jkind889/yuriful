import { expect, test } from '@playwright/test'
import type { Browser, CDPSession, Page } from '@playwright/test'
import type { Scene } from '../src/model/types.ts'
import { openApp, openBlank, redoButton, seedRaw, status, storedDoc, undoButton } from './helpers.ts'
import type { SeedAsset, StoredBoard, StoredFrame, StoredObject, View } from './helpers.ts'

/**
 * Live text editing on the DOM renderer (plan Slice 2c-ii) in real Chromium: the text engine's
 * view mounted in the edited card, pointer routing while a text is edited, in-edit undo, and what
 * the editor saves and records. The renderer is chosen only by `window.__YURIFUL_RENDERER__ =
 * 'dom'`, set before the app mounts. A probe on the normal app instance (as in
 * `interleaving.spec.ts`) reads the editor; it lives in this test route only.
 *
 * Paired tests run the same script of real key presses and pointer actions on the Fabric renderer
 * and on the DOM renderer from the same seeded board, and compare, after every step, the scene,
 * the history, what the editor shows (selection, the edit and its caret, the formatting readout,
 * the layer list) and at the end the stored board.
 */

type Corner = { x: number; y: number }

interface EditInfo {
  id: string
  text: string
  /** The selection as UTF-16 offsets into the text. */
  anchor: number
  head: number
  focused: boolean
  /** DOM renderer: the selection the page shows in the edited card, as UTF-16 offsets (null when it shows none there). */
  shown?: { from: number; to: number } | null
}

interface ProbeState {
  selected: string[]
  editing: boolean
  canUndo: boolean
  canRedo: boolean
  layers: string[]
  tool: string
  text: unknown
  fontSize: number | null
  viewport: View
}

interface EditProbe {
  renderer: () => 'dom' | 'fabric'
  scene: () => Scene
  history: () => { current: Scene; index: number; length: number }
  state: () => ProbeState
  /** The text being edited, or null. */
  edit: () => EditInfo | null
  /** An object's four corners (tl, tr, br, bl) in page pixels. */
  corners: (id: string) => Corner[] | null
  run: (method: string, ...args: unknown[]) => unknown
  /** DOM renderer: calls a method of the edit session of the text being edited. */
  session: (method: string, ...args: unknown[]) => unknown
  /** The DOM renderer's card for an id: its body's computed height, whether it holds the live editor, its HTML. */
  card: (id: string) => { height: number; live: boolean; html: string } | null
  /** Every text's box height (scene units): the proxy's on the DOM renderer, the text box's on Fabric. */
  boxes: () => Record<string, number>
  /** An object's handle positions (Fabric's `oCoords`) in page pixels, shown or not. */
  handles: (id: string) => Record<string, Corner> | null
}

declare global {
  interface Window {
    __edit: EditProbe
    __YURIFUL_RENDERER__?: string
  }
}

async function installProbe(page: Page) {
  await page.route(/\/src\/main\.tsx(?:\?|$)/, async (route) => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: `
      import { Editor as ProbeEditor } from '/src/editor/Editor.ts'
      import { idOf as probeIdOf } from '/src/editor/objects.ts'
      import { textOffsetAt as probeOffsetAt } from '/src/editor/textSchema.ts'
      const probeInit = ProbeEditor.prototype.init
      ProbeEditor.prototype.init = function () {
        const ed = this
        const find = (id) => ed.canvas.getObjects().find((o) => probeIdOf(o) === id)
        const toPage = (sx, sy) => {
          const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
          const v = ed.canvas.viewportTransform
          return { x: r.left + v[0] * sx + v[2] * sy + v[4], y: r.top + v[1] * sx + v[3] * sy + v[5] }
        }
        window.__edit = {
          renderer: () => (ed.scene ? 'dom' : 'fabric'),
          scene: () => ed.snapshot(),
          history: () => ({ current: ed.history.current, index: ed.history.index, length: ed.history.stack.length }),
          state: () => {
            const st = ed.getState()
            return {
              selected: ed.selectedIds(),
              editing: st.editingText,
              canUndo: st.canUndo,
              canRedo: st.canRedo,
              layers: st.layers.map((l) => l.id + ':' + l.label + (l.selected ? '*' : '')),
              tool: st.tool,
              text: st.selection?.text ?? null,
              fontSize: st.selection?.fontSize ?? null,
              viewport: { ...st.viewport },
            }
          },
          edit: () => {
            if (ed.scene) {
              const s = ed.text.editSession()
              if (!s) return null
              const sel = s.selection()
              let shown = null
              const ds = getSelection()
              if (s.view && ds && ds.anchorNode && s.view.dom.contains(ds.anchorNode) && s.view.dom.contains(ds.focusNode)) {
                const a = probeOffsetAt(s.state.doc, s.view.posAtDOM(ds.anchorNode, ds.anchorOffset), -1)
                const b = probeOffsetAt(s.state.doc, s.view.posAtDOM(ds.focusNode, ds.focusOffset), -1)
                shown = { from: Math.min(a, b), to: Math.max(a, b) }
              }
              return { id: probeIdOf(ed.text.editedTarget()), text: s.content().text, anchor: sel.anchor, head: sel.head, focused: !!s.view && s.view.hasFocus(), shown }
            }
            const t = ed.canvas.getActiveObject()
            if (!t || !t.isEditing) return null
            const ta = t.hiddenTextarea
            const back = t._selectionDirection === 'left' && ta.selectionStart !== ta.selectionEnd
            return { id: probeIdOf(t), text: ta.value, anchor: back ? ta.selectionEnd : ta.selectionStart, head: back ? ta.selectionStart : ta.selectionEnd, focused: document.activeElement === ta }
          },
          corners: (id) => {
            const o = find(id)
            if (!o) return null
            const m = o.calcTransformMatrix()
            const w = o.width / 2
            const h = o.height / 2
            return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => toPage(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]))
          },
          run: (method, ...args) => ed[method](...args),
          session: (method, ...args) => { const s = ed.scene && ed.text.editSession(); return s ? s[method](...args) : undefined },
          boxes: () => {
            const out = {}
            for (const o of ed.canvas.getObjects()) if (ed.text.isText(o) && !ed.text.isBlank(o)) out[probeIdOf(o) ?? ''] = Math.round(o.height * o.scaleY * 100) / 100
            return out
          },
          handles: (id) => {
            const o = find(id)
            if (!o) return null
            o.setCoords()
            const r = ed.canvas.upperCanvasEl.getBoundingClientRect()
            const out = {}
            for (const [k, c] of Object.entries(o.oCoords)) out[k] = { x: r.left + c.x, y: r.top + c.y }
            return out
          },
          card: (id) => {
            const el = document.querySelector('.scene-layer [data-id="' + id + '"]')
            const body = el && el.firstElementChild
            if (!body) return null
            return { height: parseFloat(getComputedStyle(body).height), live: body.classList.contains('ProseMirror'), html: body.innerHTML }
          },
        }
        return probeInit.call(this)
      }
      ${source}
    `,
    })
  })
}

const chooseDomRenderer = (page: Page) =>
  page.addInitScript(() => {
    window.__YURIFUL_RENDERER__ = 'dom'
  })

const errorsOf = (page: Page) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

async function openBoard(page: Page, doc: StoredBoard, assets: SeedAsset[] = [], renderer: 'dom' | 'fabric' = 'dom') {
  await openBlank(page)
  await seedRaw(page, doc.frames?.length ? 2 : 1, doc as unknown as Record<string, unknown>, assets)
  if (renderer === 'dom') await chooseDomRenderer(page)
  await installProbe(page)
  await openApp(page)
  expect(await page.evaluate(() => window.__edit.renderer())).toBe(renderer)
  await frames(page, 2)
}

const frames = (page: Page, n = 2) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise<number>((resolve) => requestAnimationFrame(resolve))
  }, n)

const ASSETS: SeedAsset[] = [
  { id: 'quad', name: 'quad.png', width: 160, height: 120, pattern: 'quadrants' },
  { id: 'grad', name: 'grad.png', width: 200, height: 100, seed: 3 },
]

const frame = (patch: Partial<StoredFrame> = {}): StoredFrame => ({ id: 'F', name: 'Spread', left: 200, top: 120, width: 520, height: 420, ...patch })
const image = (id: string, left: number, top: number, patch: Partial<StoredObject> = {}): StoredObject => ({ type: 'image', id, assetId: 'quad', left, top, angle: 0, scaleX: 1, scaleY: 1, ...patch })
const text = (id: string, left: number, top: number, value: string, patch: Partial<StoredObject> = {}): StoredObject => ({ type: 'text', id, left, top, angle: 0, text: value, fontSize: 24, width: 260, ...patch })
const board = (frames: StoredFrame[], objects: StoredObject[], viewport: View = { zoom: 1, panX: 0, panY: 0 }): StoredBoard => ({
  version: frames.length ? 2 : 1,
  title: 'Editing',
  ...(frames.length && { frames }),
  objects,
  viewport,
})

/** A page point inside an object: its box at the fractions `at` (rotation included). */
async function pointIn(page: Page, id: string, at: [number, number] = [0.5, 0.5]): Promise<Corner> {
  const c = await page.evaluate((id) => window.__edit.corners(id), id)
  if (!c) throw new Error(`no object ${id}`)
  const [fx, fy] = at
  const top = { x: c[0]!.x + (c[1]!.x - c[0]!.x) * fx, y: c[0]!.y + (c[1]!.y - c[0]!.y) * fx }
  const bottom = { x: c[3]!.x + (c[2]!.x - c[3]!.x) * fx, y: c[3]!.y + (c[2]!.y - c[3]!.y) * fx }
  return { x: top.x + (bottom.x - top.x) * fy, y: top.y + (bottom.y - top.y) * fy }
}

/** A scene point in page pixels, at the editor's current view. */
async function scenePoint(page: Page, x: number, y: number): Promise<Corner> {
  const box = await page.locator('.canvas-host').boundingBox()
  const v = (await page.evaluate(() => window.__edit.state())).viewport
  return { x: box!.x + x * v.zoom + v.panX, y: box!.y + y * v.zoom + v.panY }
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const stored = async (page: Page) => (await storedDoc(page)) as StoredBoard

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Fresh ids replaced by `~1`, `~2`... in the order they first appear. */
function normalizeIds<T>(value: T): T {
  const seen = new Map<string, string>()
  return JSON.parse(
    JSON.stringify(value).replace(UUID, (id) => {
      if (!seen.has(id)) seen.set(id, `~${seen.size + 1}`)
      return seen.get(id)!
    }),
  ) as T
}

// ---- paired scripts -------------------------------------------------------------------------------

type Step = BaseStep & {
  /**
   * Fields of what the editor shows that are not compared after this step, each for a reason given
   * where it is used (`layers`: Fabric does not refresh the layer list after a Backspace revert).
   */
  skip?: ReadonlyArray<'layers'>
}

type BaseStep =
  /** A double-click inside an object, at the fractions `at` of its box; `then`: keys pressed straight after it, with nothing awaited between. */
  | { dblclick: string; at?: [number, number]; then?: string[]; pause?: number }
  /** A click inside an object; with Shift held when asked. */
  | { click: string; at?: [number, number]; shift?: boolean }
  /** A click at a scene point. */
  | { clickAt: [number, number]; shift?: boolean }
  /** A press at a scene point, moved to another and released (a Text-tool box, a marquee). */
  | { dragAt: [number, number]; to: [number, number] }
  /** A press inside an object, moved by (dx, dy) screen pixels and released. */
  | { drag: string; dx: number; dy: number; at?: [number, number]; alt?: boolean }
  /** A press on a frame's label, released where it was. */
  | { label: string }
  | { key: string }
  | { type: string }
  /** Keys pressed, then text typed, with nothing awaited between (text that comes before the browser reports the caret the keys moved). */
  | { press: string[]; thenType: string }
  /** A toolbar or inspector button, by its exact accessible name. */
  | { button: string }
  /** A row of the layer list. */
  | { row: string }
  /** Types a value into the Font size field (focus moves there; the edit stays open). */
  | { fontSize: number }
  /** Puts focus in the board title and types (the edit stays open). */
  | { title: string }
  /** The window loses focus (the edit stays open). */
  | { blur: true }
  /** Puts plain text (and optionally HTML) on the system clipboard. */
  | { clipboard: string; html?: string }
  /** An IME composition update (CDP `Input.imeSetComposition`), its commit (`Input.insertText`), or the commit and a key in the same instant. */
  | { ime: string }
  | { commit: string }
  | { commitKey: [string, string] }
  /** A press inside an object, then the pointer moved by each (dx, dy) screen pixels in turn from the press point, then released. */
  | { pressMove: string; at?: [number, number]; moves: Array<[number, number]> }
  /** A press at one of an object's handles (shown or hidden), `offset` screen pixels from it, dragged by `by`. */
  | { handlePress: string; handle: string; offset?: [number, number]; by: [number, number]; shift?: boolean }
  /** A pause, as a person makes between gestures. */
  | { wait: number }
  | { run: string; args?: unknown[] }

interface StepRecord {
  step: string
  scene: Scene
  history: { current: Scene; index: number; length: number }
  state: ProbeState
  edit: EditInfo | null
  boxes: Record<string, number>
}

async function runStep(page: Page, step: Step, frameRects: Map<string, StoredFrame>, cdp: CDPSession) {
  if ('dblclick' in step) {
    const p = await pointIn(page, step.dblclick, step.at)
    await page.mouse.dblclick(p.x, p.y)
    if (step.pause) await page.waitForTimeout(step.pause)
    for (const key of step.then ?? []) await page.keyboard.press(key)
  } else if ('ime' in step) {
    await cdp.send('Input.imeSetComposition', { text: step.ime, selectionStart: step.ime.length, selectionEnd: step.ime.length })
  } else if ('commit' in step) {
    await cdp.send('Input.insertText', { text: step.commit })
  } else if ('commitKey' in step) {
    await Promise.all([cdp.send('Input.insertText', { text: step.commitKey[0] }), page.keyboard.press(step.commitKey[1])])
  } else if ('click' in step) {
    const p = await pointIn(page, step.click, step.at)
    if (step.shift) await page.keyboard.down('Shift')
    await page.mouse.click(p.x, p.y)
    if (step.shift) await page.keyboard.up('Shift')
  } else if ('clickAt' in step) {
    const p = await scenePoint(page, ...step.clickAt)
    if (step.shift) await page.keyboard.down('Shift')
    await page.mouse.click(p.x, p.y)
    if (step.shift) await page.keyboard.up('Shift')
  } else if ('dragAt' in step) {
    const a = await scenePoint(page, ...step.dragAt)
    const b = await scenePoint(page, ...step.to)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 8 })
    await page.mouse.up()
  } else if ('drag' in step) {
    const a = await pointIn(page, step.drag, step.at)
    if (step.alt) await page.keyboard.down('Alt')
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(a.x + step.dx, a.y + step.dy, { steps: 8 })
    await page.mouse.up()
    if (step.alt) await page.keyboard.up('Alt')
  } else if ('wait' in step) {
    await page.waitForTimeout(step.wait)
  } else if ('pressMove' in step) {
    const a = await pointIn(page, step.pressMove, step.at)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    for (const [dx, dy] of step.moves) await page.mouse.move(a.x + dx, a.y + dy)
    await page.mouse.up()
  } else if ('handlePress' in step) {
    const h = (await page.evaluate((id) => window.__edit.handles(id), step.handlePress))?.[step.handle]
    if (!h) throw new Error(`no ${step.handle} handle on ${step.handlePress}`)
    const [ox, oy] = step.offset ?? [0, 0]
    if (step.shift) await page.keyboard.down('Shift')
    await page.mouse.move(h.x + ox, h.y + oy)
    await page.mouse.down()
    await page.mouse.move(h.x + ox + step.by[0], h.y + oy + step.by[1], { steps: 6 })
    await page.mouse.up()
    if (step.shift) await page.keyboard.up('Shift')
  } else if ('label' in step) {
    const f = frameRects.get(step.label)!
    const p = await scenePoint(page, f.left, f.top)
    await page.mouse.click(p.x + 12, p.y - 9)
  } else if ('key' in step) {
    await page.keyboard.press(step.key)
  } else if ('type' in step) {
    await page.keyboard.type(step.type)
  } else if ('press' in step) {
    for (const k of step.press) await page.keyboard.press(k)
    await page.keyboard.type(step.thenType)
  } else if ('button' in step) {
    await button(page, step.button).click()
  } else if ('row' in step) {
    await page.locator(`[data-layer-id="${step.row}"]`).click()
  } else if ('fontSize' in step) {
    await page.getByLabel('Font size').fill(String(step.fontSize))
  } else if ('title' in step) {
    const title = page.getByRole('textbox', { name: /title/i })
    await title.click()
    await page.keyboard.type(step.title)
  } else if ('blur' in step) {
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  } else if ('clipboard' in step) {
    await page.evaluate(async ({ text, html }) => {
      const items: Record<string, Blob> = { 'text/plain': new Blob([text], { type: 'text/plain' }) }
      if (html !== undefined) items['text/html'] = new Blob([html], { type: 'text/html' })
      await navigator.clipboard.write([new ClipboardItem(items)])
    }, { text: step.clipboard, html: step.html })
  } else {
    await page.evaluate(({ method, args }) => window.__edit.run(method, ...args), { method: step.run, args: step.args ?? [] })
  }
  await frames(page, 2)
}

async function runScript(browser: Browser, renderer: 'dom' | 'fabric', doc: StoredBoard, steps: readonly Step[], assets: SeedAsset[] = ASSETS, clipboard = false) {
  const context = await browser.newContext()
  if (clipboard) await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  const errors = errorsOf(page)
  await openBoard(page, doc, assets, renderer)
  const frameRects = new Map((doc.frames ?? []).map((f) => [f.id, f]))
  const cdp = await context.newCDPSession(page)
  const records: StepRecord[] = []
  for (const step of steps) {
    await runStep(page, step, frameRects, cdp)
    records.push({
      step: JSON.stringify(step),
      ...(await page.evaluate(() => ({ scene: window.__edit.scene(), history: window.__edit.history(), state: window.__edit.state(), edit: window.__edit.edit(), boxes: window.__edit.boxes() }))),
    })
  }
  // Leave any edit open at the end as it is: typing is saved as it happens.
  await page.waitForTimeout(800)
  await expect(status(page)).toContainText('Saved on this device')
  const saved = await stored(page)
  expect(errors, renderer).toEqual([])
  await context.close()
  return normalizeIds({ records, saved })
}

// A text's `left`, `top` and `width` depend on how it is measured (CSS on the DOM renderer, Canvas 2D
// on Fabric), which agree within 0.08 px per box in height and 0.04 px in minimum width (plan
// Section 6); a new text centred on a point or a side handle moves `left`/`top` by part of that.
const GEOMETRY_TOLERANCE = 0.1
const MEASURED = new Set(['left', 'top', 'width'])

/** Record fields not compared (`id.key`): a difference between the renderers named where it is declared. */
type Omitted = ReadonlySet<string>

function without(r: Record<string, unknown>, omit: Omitted): Record<string, unknown> {
  const out = { ...r }
  for (const k of Object.keys(out)) if (omit.has(`${String(r.id)}.${k}`)) delete out[k]
  return out
}

function expectSameRecords(domIn: readonly Record<string, unknown>[], fabricIn: readonly Record<string, unknown>[], where: string, omit: Omitted = new Set()): number {
  const dom = domIn.map((r) => without(r, omit))
  const fabric = fabricIn.map((r) => without(r, omit))
  expect(dom.map((r) => r.id), where).toEqual(fabric.map((r) => r.id))
  let worst = 0
  dom.forEach((d, i) => {
    const f = fabric[i]!
    expect(Object.keys(d).sort(), `${where} ${String(d.id)} keys`).toEqual(Object.keys(f).sort())
    for (const key of Object.keys(f)) {
      if (d.type === 'text' && MEASURED.has(key)) {
        const diff = Math.abs((d[key] as number) - (f[key] as number))
        worst = Math.max(worst, diff)
        expect(diff, `${where} ${String(d.id)}.${key}: dom ${String(d[key])}, fabric ${String(f[key])}`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
      } else if (d.type === 'text' && key === 'captionPosition') {
        expect(Math.abs((d[key] as number) - (f[key] as number)), `${where} ${String(d.id)}.${key}`).toBeLessThanOrEqual(0.001)
      } else {
        expect(d[key], `${where} ${String(d.id)}.${key}`).toEqual(f[key])
      }
    }
  })
  return worst
}

/**
 * The same script on both renderers: after every step the same scene, history (its current scene,
 * its length and position), selection, edit (which text, its text, its selection, focus), formatting
 * readout and layer list; Undo and Redo's availability only outside an edit (inside one the DOM
 * renderer offers the edit's own history: Owner Decision 11). Then the same stored board.
 */
/**
 * Box heights: Fabric's text box and the DOM card agree within 0.08 px per line box (plan Section 6);
 * a box of many lines gathers a little more.
 */
const BOX_TOLERANCE = 1

async function expectPaired(browser: Browser, doc: StoredBoard, steps: readonly Step[], opts: { assets?: SeedAsset[]; clipboard?: boolean; omit?: Omitted } = {}) {
  const omit = opts.omit ?? new Set<string>()
  const fabric = await runScript(browser, 'fabric', doc, steps, opts.assets, opts.clipboard)
  const dom = await runScript(browser, 'dom', doc, steps, opts.assets, opts.clipboard)
  let worst = 0
  if (process.env.DEBUG_STEPS) {
    fabric.records.forEach((f, i) => {
      const d = dom.records[i]!
      console.log(i, f.step, '\n  fabric', JSON.stringify(f.edit), f.state.selected, f.state.editing, '\n  dom   ', JSON.stringify(d.edit), d.state.selected, d.state.editing)
    })
  }
  fabric.records.forEach((f, i) => {
    const d = dom.records[i]!
    const where = `after step ${i} ${f.step}`
    worst = Math.max(worst, expectSameRecords(d.scene.objects as never, f.scene.objects as never, where, omit))
    expect(d.scene.frames, `frames ${where}`).toEqual(f.scene.frames)
    worst = Math.max(worst, expectSameRecords(d.history.current.objects as never, f.history.current.objects as never, `history ${where}`, omit))
    // What is drawn while editing as well as after: every text box is as tall as on Fabric.
    expect(Object.keys(d.boxes).sort(), `boxes ${where}`).toEqual(Object.keys(f.boxes).sort())
    for (const [id, h] of Object.entries(f.boxes)) expect(Math.abs(d.boxes[id]! - h), `${where} ${id} box height: dom ${d.boxes[id]}, fabric ${h}`).toBeLessThanOrEqual(BOX_TOLERANCE)
    expect([d.history.index, d.history.length], `history position ${where}`).toEqual([f.history.index, f.history.length])
    // A selection as its two ends: Fabric keeps a stale direction after select-all (its `_selectionDirection`).
    const ends = (e: EditInfo | null) => e && { id: e.id, text: e.text, from: Math.min(e.anchor, e.head), to: Math.max(e.anchor, e.head), focused: e.focused }
    expect(ends(d.edit), `edit ${where}`).toEqual(ends(f.edit))
    const skip = new Set((JSON.parse(f.step) as Step).skip ?? [])
    const { canUndo: du, canRedo: dr, layers: dl, ...dState } = d.state
    const { canUndo: fu, canRedo: fr, layers: fl, ...fState } = f.state
    if (!skip.has('layers')) expect(dl, `layers ${where}`).toEqual(fl)
    expect(dState, `state ${where}`).toEqual(fState)
    if (!f.state.editing) expect([du, dr], `undo and redo ${where}`).toEqual([fu, fr])
  })
  worst = Math.max(worst, expectSameRecords(dom.saved.objects as never, fabric.saved.objects as never, 'saved', omit))
  expect(dom.saved.frames, 'saved frames').toEqual(fabric.saved.frames)
  expect(dom.saved.version).toBe(fabric.saved.version)
  return { worst, fabric, dom }
}

test.describe('text edited on the DOM renderer saves and records what the Fabric renderer does (paired)', () => {
  test.describe.configure({ timeout: 120_000 })

  test('creating text by click and by drag, typing, leaving by Esc and by a click on the board; blank texts discarded; undo and redo afterwards', async ({ browser }) => {
    const doc = board([frame()], [text('a', 40, 40, 'alpha')])
    const steps: Step[] = [
      { button: 'Text' },
      { clickAt: [300, 200] },
      { type: 'Hello there' },
      { key: 'Escape' },
      { button: 'Text' },
      { dragAt: [260, 300], to: [470, 380] },
      { type: 'Drawn box words and more words' },
      { clickAt: [950, 650] },
      { button: 'Text' },
      { clickAt: [800, 100] },
      { key: 'Escape' },
      { button: 'Text' },
      { clickAt: [800, 160] },
      { type: 'x' },
      { key: 'Backspace' },
      { clickAt: [950, 650] },
      { dblclick: 'a' },
      { key: 'Control+a' },
      { key: 'Backspace' },
      { key: 'Escape' },
      { key: 'Control+z' },
      { key: 'Control+z' },
      { key: 'Control+Shift+z' },
    ]
    const { worst, dom } = await expectPaired(browser, doc, steps)
    // Not two renderers doing nothing alike: the new texts exist, the blank ones do not, the emptied one is back after undo and redo.
    expect(dom.saved.objects.map((o) => (o as { text?: string }).text)).toEqual(['alpha', 'Hello there', 'Drawn box words and more words'])
    expect((dom.saved.objects[2] as { minHeight?: number }).minHeight).toBe(80)
    console.log(`create and leave: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('every way of leaving an edit: Esc, Tab, the board, another object (selecting and dragging it), Shift-click, a frame label, a tool button, an inspector button, Delete, the layer list; a window blur and the title keep it open', async ({ browser }) => {
    const doc = board([frame()], [text('A', 240, 160, 'first note', { frameId: 'F' }), text('B', 420, 420, 'second note', { frameId: 'F' }), image('I', 820, 380), text('C', 40, 40, 'loose')])
    const steps: Step[] = [
      { dblclick: 'A', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' one' },
      { click: 'B' }, // ends the edit and selects B, in one press
      { dblclick: 'B', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' two' },
      { click: 'A', shift: true }, // ends the edit and forms {B, A}
      { clickAt: [950, 680] },
      { dblclick: 'C', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' three' },
      { label: 'F' }, // the frame label wins: ends the edit and selects the frame
      { dblclick: 'C', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' four' },
      { button: 'Frame' }, // a tool button
      { key: 'Escape' },
      { dblclick: 'C', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' five' },
      { button: 'Send to back' }, // an inspector button that is not a formatting control
      { dblclick: 'C', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' six' },
      { button: 'Delete' },
      { key: 'Control+z' },
      { dblclick: 'A', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' seven' },
      { row: 'B' },
      { dblclick: 'A', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' eight' },
      { drag: 'I', dx: 40, dy: 30 }, // one press ends the edit and drags the image
      { dblclick: 'A', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' nine' },
      { key: 'Tab' },
      { dblclick: 'A', at: [0.08, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' x' },
      { blur: true },
      { type: 'y' },
      { title: ' board' },
      { click: 'A', at: [0.02, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: 'z' },
      { key: 'Escape' },
      { key: 'Control+z' },
      { key: 'Control+z' },
      { key: 'Control+Shift+z' },
    ]
    const { worst, dom } = await expectPaired(browser, doc, steps)
    expect(dom.saved.objects.map((o) => [o.id, (o as { text?: string }).text])).toEqual([
      ['C', 'loose three four five six'], // Delete commits the typing first, as its own step
      ['A', 'first note one seven eight nine'],
      ['B', 'second note two'],
      ['I', undefined],
    ])
    console.log(`leaving: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('headings and their Enter and Backspace rules, typing shortcuts, Backspace straight after one, and the literal cases', async ({ browser }) => {
    const doc = board([], [text('T', 100, 100, 'Title\nbody text', { headings: [1], width: 420 })])
    const steps: Step[] = [
      { dblclick: 'T', at: [0.04, 0.1] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { key: 'Enter' },
      { type: '# Big one' },
      { key: 'Enter' }, // at the end of a heading: a body line
      { type: 'after' },
      { key: 'Home' },
      { key: 'Backspace' }, // joins onto the heading line above
      { type: ' **bold**' },
      // Straight after the shortcut: the markers come back. Fabric leaves the layer list's label as it was until the next change.
      { key: 'Backspace', skip: ['layers'] },
      { type: ' *it*' },
      { type: ' plain' },
      { key: 'Enter' },
      { type: '## sub' },
      { key: 'Backspace' },
      { key: 'Backspace' },
      { key: 'Backspace' },
      { key: 'Backspace' }, // an empty heading line joins the line above
      { key: 'Enter' },
      { type: '### x' },
      { key: 'ArrowLeft' },
      { key: 'Enter' }, // in the middle of a heading: splits it
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { key: 'Enter' },
      { type: '2 * 3 * 4 snake*case* #tag a ** b ***x*** #### four' },
      { key: 'Enter' },
      { type: '**' },
      { key: 'Enter' },
      { type: '* item' },
      { key: 'Escape' },
      { key: 'Control+z' },
      { key: 'Control+Shift+z' },
    ]
    const { worst, dom } = await expectPaired(browser, doc, steps)
    const t = dom.saved.objects[0] as { text: string; headings?: number[]; spans?: unknown[] }
    // The heading shortcut, the italic one, the reverted bold one kept literal, and every literal case literal.
    expect(t.text).toBe('Title\nbody text\nBig one **bold** it plain\n\nxafter\n2 * 3 * 4 snake*case* #tag a ** b ***x*** #### four\n**\n* item')
    expect(t.headings).toEqual([1, 0, 1, 3, 3])
    expect(t.spans).toEqual([{ start: 33, end: 35, italic: true }])
    console.log(`headings and shortcuts: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('marks on a range and pending at a caret, Ctrl/Cmd+B, I, U, headings, fonts, alignment, colour and font size while editing; then the whole box', async ({ browser }) => {
    const doc = board([], [text('T', 100, 100, 'one two three\nfour five', { width: 420 })])
    const steps: Step[] = [
      { dblclick: 'T', at: [0.04, 0.1] }, // selects "one"
      { button: 'Bold' },
      { key: 'Control+a' },
      { button: 'Italic' },
      { key: 'ArrowRight' },
      { button: 'Underline' }, // pending at the caret
      { type: ' u' },
      { key: 'Control+b' },
      { type: 'b' },
      { key: 'ArrowLeft' }, // a caret move drops what is pending
      { type: 'p' },
      { key: 'Shift+Home' },
      { button: 'H2 (Heading 2)' },
      { button: 'Serif' },
      { key: 'Shift+ArrowLeft' },
      { key: 'Control+u' },
      { button: 'Strikethrough' },
      { button: 'Align centre' },
      { button: 'Red' },
      { fontSize: 40 },
      { click: 'T', at: [0.5, 0.06] },
      { key: 'Control+a' },
      { key: 'ArrowLeft' },
      { button: 'Mono' }, // a font chosen at a caret: pending
      { type: 'Z' },
      { key: 'Control+i' },
      { type: 'y' },
      { key: 'Escape' },
      { button: 'Bold' }, // the whole box, as its own step
      { key: 'Control+u' },
      { button: 'Body' },
      { button: 'Display' },
      { key: 'Control+z' },
      { key: 'Control+z' },
      { key: 'Control+z' },
      { key: 'Control+z' },
      { key: 'Control+z' },
      { key: 'Control+Shift+z' },
    ]
    const { worst, dom } = await expectPaired(browser, doc, steps)
    const t = dom.saved.objects[0] as { text: string; spans?: unknown[]; align?: string; color?: string; fontSize: number }
    expect([t.align, t.color, t.fontSize]).toEqual(['center', '#d92d20', 40])
    expect(t.spans?.length).toBeGreaterThan(2)
    console.log(`formatting: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('ownership of a new text is decided when it is made and once more when its first edit ends; typing in an existing text never changes it', async ({ browser }) => {
    const doc = board([frame({ width: 520, height: 110 })], [text('E', 220, 140, 'in the frame', { frameId: 'F', width: 200 }), text('L', 760, 140, 'loose')])
    const steps: Step[] = [
      { button: 'Text' },
      { clickAt: [250, 190] },
      { type: 'line' },
      { key: 'Enter' },
      { type: 'two' },
      { key: 'Enter' },
      { type: 'three' },
      { key: 'Enter' },
      { type: 'four' },
      { key: 'Escape' }, // its centre is now below the frame: loose
      { dblclick: 'E', at: [0.04, 0.2] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { key: 'Enter' },
      { type: 'more' },
      { key: 'Enter' },
      { type: 'lines' },
      { key: 'Enter' },
      { type: 'below' },
      { key: 'Escape' }, // an existing text keeps its owner
      { button: 'Text' },
      { clickAt: [450, 128] },
      { type: 'inside' },
      { key: 'Escape' }, // stays in the frame
      { button: 'Text' },
      { clickAt: [480, 170] },
      { type: 'sized' },
      { fontSize: 60 }, // a step of its own, mid-edit, as on the Fabric renderer: history now holds the text (`~3`)
      { clickAt: [486, 200] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { key: 'Enter' },
      { type: 'x' },
      { key: 'Enter' },
      { type: 'y' },
      { key: 'Escape' },
      { dblclick: 'L', at: [0.1, 0.3] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' and longer' },
      { clickAt: [900, 650] },
    ]
    // A named difference: the text sized mid-edit (`~3`) grows far below the frame. The settled rule
    // decides a new text's owner again when its first edit ends: the DOM renderer does (it is loose);
    // Fabric judges "new" from history, which the size change has put it in, and keeps the frame.
    const { worst, dom, fabric } = await expectPaired(browser, doc, steps, { omit: new Set(['~3.frameId']) })
    expect(dom.saved.objects.map((o) => o.frameId ?? null)).toEqual(['F', null, null, 'F', null])
    expect(fabric.saved.objects.map((o) => o.frameId ?? null)).toEqual(['F', null, null, 'F', 'F'])
    console.log(`ownership: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('captions added and edited: Add caption, Enter on a captioned image, typing that grows a caption above or below its image', async ({ browser }) => {
    const doc = board([], [
      image('I', 120, 220),
      image('J', 420, 220),
      text('cap', 420, 350, 'old caption', { width: 160, minHeight: 0, captionOf: 'J', captionPosition: 0.5 }),
      image('K', 720, 260),
      text('top', 720, 200, 'above', { width: 160, minHeight: 0, captionOf: 'K', captionSide: 'top', captionPosition: 0.5, captionBackground: '#fdf3c4' }),
    ])
    const steps: Step[] = [
      { click: 'I' },
      { button: 'Add caption' },
      { type: 'A caption for the first picture' },
      { key: 'Escape' },
      { click: 'J' },
      { key: 'Enter' },
      { type: ' with more words that wrap' },
      { key: 'Escape' },
      { click: 'K' },
      { button: 'Edit caption' },
      { key: 'Enter' },
      { type: 'second line' },
      { key: 'Enter' },
      { type: 'third' },
      { clickAt: [1000, 650] },
      { dblclick: 'cap', at: [0.1, 0.2] },
      { key: 'Control+a' },
      { key: 'Backspace' },
      { key: 'Escape' }, // an emptied caption is discarded
      { key: 'Control+z' },
      { click: 'I' },
      { button: 'Edit caption' },
      { fontSize: 30 },
      { key: 'Escape' },
    ]
    const { worst, dom } = await expectPaired(browser, doc, steps, { assets: ASSETS })
    expect(dom.saved.objects.filter((o) => o.type === 'text').map((o) => (o as { text: string }).text)).toContain('A caption for the first picture')
    console.log(`captions: largest geometry difference ${worst.toFixed(3)}`)
  })

  test('double-clicks on rotated texts at a zoom and pan pick the same words; plain text pasted at a caret and over a selection', async ({ browser }) => {
    const doc = board(
      [],
      [
        text('R', 120, 80, 'turned words here', { angle: 30, width: 300 }),
        text('S', 420, 260, 'another tilted note', { angle: -20, width: 280, minHeight: 40 }),
      ],
      { zoom: 1.6, panX: -40, panY: -30 },
    )
    const steps: Step[] = [
      { dblclick: 'R', at: [0.45, 0.4] },
      { type: 'W' },
      { key: 'Escape' },
      { dblclick: 'S', at: [0.12, 0.3] },
      { type: 'V' },
      { clipboard: 'pasted\nlines' },
      { key: 'Control+v' },
      { key: 'Shift+ArrowLeft' },
      { key: 'Shift+ArrowLeft' },
      { key: 'Control+v' },
      { button: 'Bold' },
      { key: 'ArrowRight' },
      { key: 'Control+b' },
      { clipboard: 'X' },
      { key: 'Control+v' },
      { key: 'Escape' },
      { key: 'Control+z' },
      { key: 'Control+Shift+z' },
    ]
    const { worst, dom } = await expectPaired(browser, doc, steps, { clipboard: true })
    expect((dom.saved.objects[0] as { text: string }).text).toBe('turned W here')
    console.log(`rotation, zoom and paste: largest geometry difference ${worst.toFixed(3)}`)
  })
})

test.describe('a box too narrow for what is typed widens as on the Fabric renderer (paired)', () => {
  test.describe.configure({ timeout: 120_000 })

  test('about its alignment edge on click-created boxes, left, centred and right, also after a heading is joined onto a line; a drawn box splits the word instead', async ({ browser }) => {
    const doc = board([], [
      text('l', 80, 60, 'abc', { width: 160 }),
      text('c', 380, 60, 'abc', { width: 160, align: 'center' }),
      text('r', 680, 60, 'abc', { width: 160, align: 'right' }),
      text('h', 380, 220, 'abc\nWWW', { width: 160, headings: [0, 1], align: 'center' }),
      text('d', 80, 380, 'abc', { width: 160, minHeight: 30, align: 'center' }),
    ])
    const word = 'XYZXYZXYZXYZXYZ'
    const atEnd = (id: string): Step[] => [{ dblclick: id, at: [0.1, 0.3] }, { key: 'Control+a' }, { key: 'ArrowRight' }]
    const steps: Step[] = [
      ...atEnd('l'),
      { type: word },
      { key: 'Escape' },
      ...atEnd('c'),
      { type: word },
      { key: 'Escape' },
      ...atEnd('r'),
      { type: word },
      { key: 'Escape' },
      { dblclick: 'h', at: [0.1, 0.1] },
      { key: 'Control+a' },
      { key: 'ArrowLeft' },
      { key: 'ArrowDown' },
      { key: 'Home' },
      { key: 'Backspace' },
      { type: 'XYZXYZXYZXYZ' },
      { key: 'Escape' },
      ...atEnd('d'),
      { type: word },
      { key: 'Escape' },
      // An emoji inserted with no keydown straight after Ctrl+A and Left, before a bold span: the span stays.
      { dblclick: 'l', at: [0.1, 0.3], pause: 100, then: ['Control+a', 'ArrowLeft'] }, // a pause beyond ProseMirror's 20 ms focus callback (see the double-click test)
      { key: 'Control+b' },
      { type: 'B' },
      { press: ['Control+a', 'ArrowLeft'], thenType: '😀' },
      { key: 'Escape' },
      { dblclick: 'l', at: [0.5, 0.3] },
      { press: ['Control+a', 'ArrowLeft'], thenType: '😀' },
      { key: 'Escape' },
      { dblclick: 'l', at: [0.5, 0.3] },
      { press: ['Control+a', 'ArrowLeft'], thenType: '😀' },
      { key: 'Escape' },
    ]
    const { worst, dom } = await expectPaired(browser, doc, steps)
    const byId = new Map(dom.saved.objects.map((o) => [o.id, o as unknown as { left: number; width: number; text: string; spans?: unknown }]))
    expect(byId.get('c')!.left + byId.get('c')!.width / 2).toBeCloseTo(380 + 80, 1) // the centre stays
    expect(byId.get('r')!.left + byId.get('r')!.width).toBeCloseTo(680 + 160, 1) // the right edge stays
    expect(byId.get('d')!.width).toBe(160) // a drawn box keeps its width
    // At a line's start a character takes the style of the one after it, as on the canvas: each emoji is bold, the rest is not.
    expect(byId.get('l')!.spans).toEqual([{ start: 0, end: 7, bold: true }])
    expect(byId.get('l')!.text.startsWith('😀😀😀Babc')).toBe(true)
    console.log(`widening: largest geometry difference ${worst.toFixed(3)}`)
  })
})

test.describe('typing straight after entering an edit, and IME compositions, in the real card (paired)', () => {
  test.describe.configure({ timeout: 120_000 })

  test('keys pressed at once after a double-click (select all then Left, Home) and compositions at a caret and over a selection, committed by a key', async ({ browser }) => {
    const doc = board([], [text('T', 100, 100, 'alpha beta gamma', { width: 400 }), text('U', 100, 260, 'second text', { width: 400 }), text('W', 100, 420, 'K-pop and state-of-the-art', { width: 400 })])
    const steps: Step[] = [
      // Keys come 100 ms after the double-click: inside the 200 ms in which ProseMirror ignores a caret
      // move to the very start (what this test is about), and safely after the callback ProseMirror
      // runs 20 ms after the editor gains focus (prosemirror-view `input.ts`, the focus handler), which
      // puts its own selection back. A key pressed within those 20 ms can be undone by it: the key is then
      // visibly ignored (what the page shows and what the next key edits still agree), a known limit no
      // person can reach, since nobody presses a key within milliseconds of releasing a double-click.
      { dblclick: 'T', at: [0.3, 0.4], pause: 100, then: ['Control+a', 'ArrowLeft'] },
      { type: 'X' },
      { key: 'Escape' },
      { dblclick: 'U', at: [0.6, 0.4], pause: 100, then: ['Home'] },
      { type: 'Y' },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { ime: 'k' },
      { ime: 'ka' },
      { commit: 'カ' },
      { key: 'Shift+ArrowLeft' },
      { key: 'Shift+ArrowLeft' },
      { ime: 'n' },
      { ime: 'に' },
      { commitKey: ['に', 'Space'] },
      { ime: 'h' },
      { commitKey: ['ほ', 'Enter'] },
      { key: 'Escape' },
      // Spaces typed at the end of, and inside, words drawn as no-wrap pieces are ordinary spaces.
      { dblclick: 'W', at: [0.04, 0.4] },
      { key: 'ArrowRight' },
      { type: ' x' },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { key: 'ArrowLeft' },
      { key: 'ArrowLeft' },
      { key: 'ArrowLeft' },
      { type: ' y ' },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' 日本' },
      { ime: 'g' },
      { commitKey: ['語', 'Space'] },
      { key: 'Escape' },
      { key: 'Control+z' },
      { key: 'Control+Shift+z' },
    ]
    const { dom } = await expectPaired(browser, doc, steps)
    // What the page shows as the selection is what the next key edits, after every step outside a composition.
    for (const r of dom.records) {
      if (!r.edit || /"ime"/.test(r.step)) continue
      expect(r.edit.shown, `shown selection after ${r.step}`).toEqual({ from: Math.min(r.edit.anchor, r.edit.head), to: Math.max(r.edit.anchor, r.edit.head) })
    }
    const texts = dom.saved.objects.map((o) => (o as { text: string }).text)
    expect(texts).toEqual(['Xalpha beta gamma', 'Ysecond texに ほ\n', 'K-p xop and state-of-the- y art 日本語 '])
    expect(texts.join('')).not.toContain('\u00a0')
  })
})

// ---- the six tests named by the plan (Section 12, Slice 2c-ii) ------------------------------------

/** The CSS cursor shown at a page point: the computed cursor of the element the browser hits there. */
const cursorAt = (page: Page, p: Corner) =>
  page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return el ? getComputedStyle(el).cursor : null
  }, p)

const edit = (page: Page) => page.evaluate(() => window.__edit.edit())
const state = (page: Page) => page.evaluate(() => window.__edit.state())
const sceneNow = (page: Page) => page.evaluate(() => window.__edit.scene())
const historyNow = (page: Page) => page.evaluate(() => window.__edit.history())

async function dblclickIn(page: Page, id: string, at: [number, number]) {
  const p = await pointIn(page, id, at)
  await page.mouse.dblclick(p.x, p.y)
  await frames(page)
}

async function clickIn(page: Page, id: string, at: [number, number]) {
  const p = await pointIn(page, id, at)
  await page.mouse.click(p.x, p.y)
  await frames(page)
}

test.describe('the DOM renderer while a text is edited (Slice 2c-ii)', () => {
  test('covering-image-shows-default-cursor-and-click-ends-edit-to-select-image: what is in front of the edited text wins, at a zoom and turned, and a locked one lets presses through', async ({ page }) => {
    const errors = errorsOf(page)
    // A, under image I (turned, unlocked) and image L (locked); frame F's label and outline lie over A's lower part.
    const doc = board(
      [frame({ left: 150, top: 262, width: 500, height: 200 })],
      [
        text('A', 160, 200, 'covered words of a long note under two pictures', { width: 360 }),
        image('I', 330, 170, { angle: 12, scaleX: 0.6, scaleY: 0.6 }),
        image('L', 440, 205, { assetId: 'grad', scaleX: 0.25, scaleY: 0.25, locked: true }),
      ],
      { zoom: 1.25, panX: -60, panY: -40 },
    )
    await openBoard(page, doc, ASSETS)
    await dblclickIn(page, 'A', [0.05, 0.15])
    expect((await state(page)).editing).toBe(true)
    // Over A where nothing covers it: the text caret. Over I: the default pointer. Over the locked L: A's caret (L lets presses through).
    // (`auto` over editable text is the browser's text caret.)
    expect(await cursorAt(page, await pointIn(page, 'A', [0.1, 0.2]))).toBe('auto')
    expect(await cursorAt(page, await pointIn(page, 'I', [0.2, 0.3]))).toBe('default')
    const throughL = await pointIn(page, 'L', [0.6, 0.3])
    expect(await cursorAt(page, throughL)).toBe('auto')
    // A press on the locked L lands in A: the edit stays open and the caret moves there.
    const before = (await edit(page))!
    await page.mouse.click(throughL.x, throughL.y)
    await frames(page)
    expect((await state(page)).editing).toBe(true)
    expect((await edit(page))!.anchor).not.toBe(before.anchor)
    // A press on I where it covers A ends the edit and selects I, and the same press drags it.
    const onI = await pointIn(page, 'I', [0.25, 0.4])
    const iBefore = (await sceneNow(page)).objects.find((o) => o.id === 'I')!
    await page.mouse.move(onI.x, onI.y)
    await page.mouse.down()
    await page.mouse.move(onI.x + 50, onI.y + 20, { steps: 6 })
    await page.mouse.up()
    await frames(page)
    expect((await state(page)).editing).toBe(false)
    expect((await state(page)).selected).toEqual(['I'])
    const iAfter = (await sceneNow(page)).objects.find((o) => o.id === 'I')!
    expect(Math.round(iAfter.left - iBefore.left)).toBe(40) // 50 screen pixels at zoom 1.25
    // The frame's label, lying over A, wins over it: the press ends the edit and selects the frame.
    await dblclickIn(page, 'A', [0.05, 0.15])
    expect((await state(page)).editing).toBe(true)
    const label = await scenePoint(page, 150, 262)
    await page.mouse.click(label.x + 14, label.y - 9)
    await frames(page)
    expect((await state(page)).editing).toBe(false)
    expect((await state(page)).selected).toEqual(['F'])
    // And its outline.
    await page.keyboard.press('Escape')
    await dblclickIn(page, 'A', [0.05, 0.15])
    expect((await state(page)).editing).toBe(true)
    const outline = await scenePoint(page, 300, 262)
    await page.mouse.click(outline.x, outline.y)
    await frames(page)
    expect((await state(page)).editing).toBe(false)
    expect((await state(page)).selected).toEqual(['F'])
    expect(errors).toEqual([])
  })

  test('outside-click-ends-edit-and-blur-keeps-edit-open: one press ends the edit and drags another object; Shift-press out of a blank text; a Text-tool box after an edit; the font size field, the title and a window blur keep the edit', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('A', 100, 100, 'first'), text('B', 500, 300, 'second')]), ASSETS)
    await dblclickIn(page, 'A', [0.1, 0.5])
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type(' one')
    // One press on B: the edit ends (one history step) and B is dragged 80 pixels.
    const b = await pointIn(page, 'B')
    await page.mouse.move(b.x, b.y)
    await page.mouse.down()
    await page.mouse.move(b.x + 80, b.y, { steps: 8 })
    await page.mouse.up()
    await frames(page)
    expect((await sceneNow(page)).objects.map((o) => [o.id, (o as { text: string }).text, o.left])).toEqual([['A', 'first one', 100], ['B', 'second', 580]])
    expect((await historyNow(page)).length).toBe(3)
    // A blank new text, then a Shift-press on B: the blank text is gone and B alone is selected.
    await button(page, 'Text').click()
    const empty = await scenePoint(page, 300, 500)
    await page.mouse.click(empty.x, empty.y)
    await frames(page)
    expect((await state(page)).editing).toBe(true)
    await page.keyboard.down('Shift')
    await page.mouse.click(b.x + 80, b.y)
    await page.keyboard.up('Shift')
    await frames(page)
    expect((await state(page)).selected).toEqual(['B'])
    expect((await sceneNow(page)).objects).toHaveLength(2)
    expect((await historyNow(page)).length).toBe(3)
    // The Text tool chosen while editing ends the edit; a box drawn then is a new text being edited.
    await dblclickIn(page, 'A', [0.1, 0.5])
    expect((await state(page)).editing).toBe(true)
    await button(page, 'Text').click()
    expect((await state(page)).editing).toBe(false)
    const from = await scenePoint(page, 100, 450)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 220, from.y + 90, { steps: 8 })
    await page.mouse.up()
    await frames(page)
    expect((await state(page)).editing).toBe(true)
    await page.keyboard.type('drawn')
    // Focus to the font size field, the title, and a window blur: the edit stays open and typing goes on where the caret was.
    await page.keyboard.press('ArrowLeft')
    await frames(page) // the browser moves the caret; the view reads it on `selectionchange`
    const caret = (await edit(page))!.anchor
    expect(caret).toBe(4)
    await page.getByLabel('Font size').fill('30')
    await frames(page)
    expect((await state(page)).editing).toBe(true)
    await page.getByRole('textbox', { name: 'Board title' }).click()
    await page.keyboard.type('!')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await frames(page)
    expect((await state(page)).editing).toBe(true)
    expect((await edit(page))!.anchor).toBe(caret)
    // Back into the text by Tab from the title: the caret where it was.
    for (let i = 0; i < 40 && !(await edit(page))!.focused; i++) await page.keyboard.press('Tab')
    expect((await edit(page))!.focused).toBe(true)
    expect((await edit(page))!.anchor).toBe(caret)
    await page.keyboard.type('Q')
    expect((await edit(page))!.text).toBe('drawQn')
    expect((await sceneNow(page)).objects.find((o) => (o as { text: string }).text === 'drawQn')).toMatchObject({ fontSize: 30, minHeight: 90 })
    expect(errors).toEqual([])
  })

  test('enter-exit-edit-zero-jump-and-typing-shortcut-roundtrip: entering and leaving an edit moves nothing and keeps every line break; # and **bold**, Backspace, in-edit Ctrl+Z and board Undo', async ({ page }) => {
    const errors = errorsOf(page)
    const rec = text('T', 120, 100, 'Heading here\nA state-of-the-art build, 2012—2014, and/or 日本語のテキストです\tafter a tab and more', {
      width: 300,
      headings: [1],
      spans: [{ start: 15, end: 20, bold: true }, { start: 20, end: 21, italic: true }, { start: 35, end: 40, underline: true }],
    })
    const drawn = text('D', 520, 100, 'A state-of-the-art build, 2012—2014, and/or 日本語のテキストです and on', { width: 230, minHeight: 0, spans: [{ start: 3, end: 8, bold: true }] })
    // "state-" is bold and "of-the-art" is not: the break after the hyphen falls where two pieces of the word meet.
    const hyphen = text('M', 120, 420, 'aaaa aaaa state-of-the-art and more', { width: 230, spans: [{ start: 10, end: 16, bold: true }] })
    const cjk = text('J', 520, 420, 'ab 日本語のテキストです cd', { width: 240, spans: [{ start: 3, end: 5, bold: true }, { start: 5, end: 6, italic: true }] })
    await openBoard(page, board([], [rec, drawn, hyphen, cjk]), ASSETS)
    for (const id of ['T', 'D', 'M', 'J']) {
      const shape = () =>
        page.evaluate((id) => {
          const body = document.querySelector(`.scene-layer [data-id="${id}"] > .scene-text-body`) as HTMLElement
          const range = document.createRange()
          range.selectNodeContents(body)
          const tops = [...new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top * 10) / 10))]
          // Where each character sits: the same breaks put every character on the same line at the same x.
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          const chars: string[] = []
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            for (let i = 0; i < (n as Text).data.length; i++) {
              const r = document.createRange()
              r.setStart(n, i)
              r.setEnd(n, i + 1)
              const b = r.getBoundingClientRect()
              chars.push(`${Math.round(b.left)},${Math.round(b.top)}`)
            }
          }
          const box = body.getBoundingClientRect()
          return { height: parseFloat(getComputedStyle(body).height), left: box.left, top: box.top, tops: tops.length, chars: chars.join(' ') }
        }, id)
      const idle = await shape()
      await dblclickIn(page, id, [0.03, 0.03])
      expect((await page.evaluate((id) => window.__edit.card(id), id))!.live, id).toBe(true)
      const live = await shape()
      await page.keyboard.press('Escape')
      await frames(page)
      const after = await shape()
      for (const [k, v] of Object.entries({ live, after })) {
        expect(Math.abs(v.height - idle.height), `${id} height ${k}`).toBeLessThanOrEqual(0.5)
        expect(Math.abs(v.left - idle.left) + Math.abs(v.top - idle.top), `${id} position ${k}`).toBeLessThanOrEqual(0.5)
        expect(v.tops, `${id} lines ${k}`).toBe(idle.tops)
        expect(v.chars, `${id} where every character sits ${k}`).toBe(idle.chars)
      }
    }
    // The typing shortcuts, the Backspace revert, in-edit Ctrl+Z, then the board's Undo.
    await dblclickIn(page, 'T', [0.03, 0.03])
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await page.keyboard.type('# Big')
    let saved = (await sceneNow(page)).objects[0] as { text: string; headings?: number[] }
    expect(saved.text.endsWith('\nBig')).toBe(true)
    expect(saved.headings).toEqual([1, 0, 1])
    await page.keyboard.type(' **bold**')
    saved = (await sceneNow(page)).objects[0] as never
    expect(saved.text.endsWith('\nBig bold')).toBe(true)
    await page.keyboard.press('Backspace') // the markers come back, nothing deleted
    expect((await edit(page))!.text.endsWith('\nBig **bold**')).toBe(true)
    await page.keyboard.type(' *it*')
    expect((await edit(page))!.text.endsWith('\nBig **bold** it')).toBe(true)
    await page.keyboard.press('Control+z') // undoes the conversion only: the markers come back
    expect((await edit(page))!.text.endsWith('\nBig **bold** *it*')).toBe(true)
    await page.keyboard.press('Control+z') // then the typed text
    expect((await edit(page))!.text.endsWith('\nBig **bold**')).toBe(true)
    expect((await state(page)).editing).toBe(true)
    await page.keyboard.press('Escape')
    await frames(page)
    expect((await historyNow(page)).length).toBe(2) // the whole edit: one board step
    await undoButton(page).click()
    await frames(page)
    expect((await sceneNow(page)).objects[0]).toMatchObject({ text: rec.text, headings: [1] })
    expect(errors).toEqual([])
  })

  test('toolbar-undo-steps-typing-and-keeps-the-edit-open: the toolbar Undo and Redo step through the edit and keep it open; after Esc the same button undoes the whole edit', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('T', 100, 100, 'start')]), ASSETS)
    await dblclickIn(page, 'T', [0.1, 0.5])
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await expect(undoButton(page)).toBeDisabled() // nothing typed yet in this edit
    await page.keyboard.type(' one')
    await page.waitForTimeout(700) // a pause: the next word is a step of its own
    await page.keyboard.type(' two')
    await expect(undoButton(page)).toBeEnabled()
    await undoButton(page).click()
    expect(await edit(page)).toMatchObject({ text: 'start one', anchor: 9, head: 9, focused: true })
    expect((await state(page)).editing).toBe(true)
    await expect(redoButton(page)).toBeEnabled()
    await redoButton(page).click()
    expect(await edit(page)).toMatchObject({ text: 'start one two', focused: true })
    await undoButton(page).click()
    await undoButton(page).click()
    expect(await edit(page)).toMatchObject({ text: 'start', focused: true })
    await expect(undoButton(page)).toBeDisabled()
    // Typing goes on at the caret after the buttons.
    await page.keyboard.type('!')
    expect((await edit(page))!.text).toBe('start!')
    await page.keyboard.press('Backspace')
    expect((await edit(page))!.text).toBe('start')
    expect((await historyNow(page)).length).toBe(1) // no board step while editing
    await page.keyboard.type(' again')
    await page.keyboard.press('Escape')
    await frames(page)
    expect((await historyNow(page)).length).toBe(2)
    await expect(undoButton(page)).toBeEnabled()
    await undoButton(page).click()
    await frames(page)
    expect((await sceneNow(page)).objects[0]).toMatchObject({ text: 'start' })
    expect((await state(page)).editing).toBe(false)
    expect(errors).toEqual([])
  })

  test('in-edit-undo-skips-whole-box-settings: a font size changed mid-edit stays when in-edit undo takes the typing back; board Undo after Esc restores both', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('T', 100, 100, 'words', { width: 300 })]), ASSETS)
    await dblclickIn(page, 'T', [0.1, 0.5])
    await page.getByLabel('Font size').fill('40')
    await frames(page)
    await clickIn(page, 'T', [0.95, 0.4])
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type(' more')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    expect(await edit(page)).toMatchObject({ text: 'words' })
    expect((await sceneNow(page)).objects[0]).toMatchObject({ text: 'words', fontSize: 40 })
    await page.keyboard.press('Escape')
    await frames(page)
    await undoButton(page).click()
    await frames(page)
    expect((await sceneNow(page)).objects[0]).toMatchObject({ text: 'words', fontSize: 24 })
    expect(errors).toEqual([])
  })

  test('entering and leaving an edit moves nothing for words wider than their box with a mark on any part of them: bold, italic, underline, strike and both, on drawn and click-created boxes', async ({ page }) => {
    test.setTimeout(180_000)
    const errors = errorsOf(page)
    // `. ` then a word of emoji and accented letters, and a long Latin word: each wider than a 62-unit box.
    const words = [
      { text: '. 🎧é🔥🎧é🔥🎧é🔥🎧é🔥', parts: [[2, 4], [4, 5], [5, 7], [7, 9], [12, 14], [15, 17]] },
      { text: 'Ab supercalifragilistic end', parts: [[3, 4], [4, 8], [7, 9], [12, 20], [19, 23]] },
    ]
    const marks: Array<Record<string, true>> = [{ bold: true }, { italic: true }, { underline: true }, { strike: true }, { underline: true, strike: true }]
    const cards: StoredObject[] = []
    for (const w of words) {
      for (const [start, end] of w.parts) {
        for (const m of marks) {
          for (const drawn of [true, false]) {
            if (!drawn && Object.keys(m).length > 1) continue
            for (const fontSize of [18, 24]) cards.push(text(`c${cards.length}`, 0, 0, w.text, { width: 62, fontSize, ...(drawn && { minHeight: 0 }), spans: [{ start, end, ...m }] }))
          }
        }
      }
    }
    const shape = (id: string) =>
      page.evaluate((id) => {
        const body = document.querySelector(`.scene-layer [data-id="${id}"] > .scene-text-body`) as HTMLElement
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        const chars: string[] = []
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (let i = 0; i < (n as Text).data.length; i++) {
            const r = document.createRange()
            r.setStart(n, i)
            r.setEnd(n, i + 1)
            const b = r.getBoundingClientRect()
            chars.push(`${Math.round(b.left)},${Math.round(b.top)}`)
          }
        }
        // The decorations drawn on each character: an underline or strike lost in the live editor shows here.
        const decos: string[] = []
        const w2 = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        for (let n = w2.nextNode(); n; n = w2.nextNode()) {
          let u = false
          let s = false
          for (let el = n.parentElement; el && el !== body; el = el.parentElement) {
            const st = getComputedStyle(el)
            if (st.textDecorationLine.includes('underline') && el.localName === 'u') u = true
            if (st.textDecorationLine.includes('underline') && el.localName === 's') s = true
            if (st.display === 'inline-block') break // an inline block is not decorated by its ancestors
          }
          decos.push(`${u ? 'u' : ''}${s ? 's' : ''}x${(n as Text).data.length}`)
        }
        return { height: parseFloat(getComputedStyle(body).height), chars: chars.join(' '), decos: decos.join(' ') }
      }, id)
    const perBoard = 8
    let checked = 0
    for (let b = 0; b < cards.length; b += perBoard) {
      const batch = cards.slice(b, b + perBoard).map((c, i) => ({ ...c, left: 110 + (i % 4) * 225, top: 60 + Math.floor(i / 4) * 330 }))
      await openBoard(page, board([], batch))
      for (const c of batch) {
        const idle = await shape(c.id)
        await dblclickIn(page, c.id, [0.5, 0.03])
        expect((await page.evaluate((id) => window.__edit.card(id), c.id))!.live, c.id).toBe(true)
        const live = await shape(c.id)
        await page.keyboard.press('Escape')
        await frames(page)
        const after = await shape(c.id)
        const what = `${c.id} ${JSON.stringify((c as { spans: unknown }).spans)} ${(c as { minHeight?: number }).minHeight === 0 ? 'drawn' : 'click-created'}`
        for (const [k, v] of Object.entries({ live, after })) {
          expect(Math.abs(v.height - idle.height), `${what} height ${k}`).toBeLessThanOrEqual(0.5)
          expect(v.chars, `${what} where every character sits ${k}`).toBe(idle.chars)
        }
        // The decorations hold per character, whatever pieces the text is split into.
        const flat = (d: string) => d.split(' ').flatMap((p) => { const [mk, n] = p.split('x'); return Array<string>(Number(n)).fill(mk!) }).join('')
        expect(flat(live.decos), `${what} underline and strike while editing`).toBe(flat(idle.decos))
        checked++
      }
    }
    expect(checked).toBe(cards.length)
    expect(errors).toEqual([])
  })

  test('pasted-html-is-inert-and-keeps-marks-only: no request leaves the page, and a heading and bold text arrive bold at normal size', async ({ page }) => {
    const errors = errorsOf(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openBoard(page, board([], [text('T', 100, 100, 'x', { width: 300 })]), ASSETS)
    const requests: string[] = []
    await page.route('**/*', (route) => {
      requests.push(route.request().url())
      return route.continue()
    })
    await dblclickIn(page, 'T', [0.3, 0.5])
    await page.keyboard.press('Control+a')
    await page.evaluate(async () => {
      const html = '<img src="https://example.invalid/x.png"><style>@import url(https://example.invalid/a.css);</style><h2>Head</h2><p><strong>ok</strong></p>'
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob(['Head\nok'], { type: 'text/plain' }) })])
    })
    await page.keyboard.press('Control+v')
    await frames(page, 4)
    await page.waitForTimeout(300)
    expect(requests.filter((u) => u.includes('example.invalid'))).toEqual([])
    const t = (await sceneNow(page)).objects[0] as { text: string; spans?: unknown; headings?: unknown; fontSize: number }
    expect(t.text).toBe('Head\nok')
    expect(t.spans).toEqual([{ start: 0, end: 7, bold: true }]) // canonical: one span across the line break
    expect(t.headings).toBeUndefined()
    expect(t.fontSize).toBe(24)
    expect(errors).toEqual([])
  })
})

test.describe('the caret where a person clicks, in the real card (Slice 2c-ii)', () => {
  test.describe.configure({ timeout: 180_000 })

  /** For every point, the caret a click there puts in the already selected text (an edit started by a click). */
  async function caretsAt(browser: Browser, renderer: 'dom' | 'fabric', doc: StoredBoard, id: string, points: Array<[number, number]>) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = errorsOf(page)
    await openBoard(page, doc, [], renderer)
    await clickIn(page, id, [0.5, 0.5]) // selects it
    const out: number[] = []
    for (const at of points) {
      await clickIn(page, id, at) // a click on the selected text: the edit starts with the caret there
      const e = await edit(page)
      out.push(e ? e.anchor : -1)
      await page.keyboard.press('Escape') // leaves the edit; the text stays selected
      await frames(page, 1)
    }
    expect(errors, renderer).toEqual([])
    await context.close()
    return out
  }

  test('a click puts the caret on the same character as on the Fabric renderer, at a zoom, turned 30°, and on a drawn box', async ({ browser }) => {
    const doc = board(
      [],
      [
        text('Z', 80, 60, 'Sleeve notes, pressed in 1991 — side A', { width: 470 }),
        text('R', 160, 180, 'Turned words to click between', { width: 380, angle: 30 }),
        text('D', 80, 380, 'A drawn box with words', { width: 380, minHeight: 20, align: 'center' }),
      ],
      { zoom: 1.5, panX: 0, panY: 0 },
    )
    const points: Array<[number, number]> = []
    for (let x = 0.03; x < 0.98; x += 0.03) points.push([Math.round(x * 1000) / 1000, 0.5])
    let same = 0
    let near = 0
    let total = 0
    const report: string[] = []
    for (const id of ['Z', 'R', 'D']) {
      const fabric = await caretsAt(browser, 'fabric', doc, id, points)
      const dom = await caretsAt(browser, 'dom', doc, id, points)
      fabric.forEach((f, i) => {
        total++
        if (dom[i] === f) same++
        else if (Math.abs(dom[i]! - f) === 1) near++
        else report.push(`${id} at ${points[i]![0]}: fabric ${f}, dom ${dom[i]}`)
      })
      expect(dom.every((o) => o >= 0), `${id}: every click started an edit`).toBe(true)
    }
    console.log(`caret by click: ${same}/${total} on the same character, ${near} one character apart; others: ${report.join('; ') || 'none'}`)
    expect(report).toEqual([]) // never more than one character apart
    expect(same / total).toBeGreaterThanOrEqual(0.9)
  })
})

test.describe('the other mouse buttons while a text is edited (Slice 2c-ii)', () => {
  test('the middle button ends the edit and pans; the right button opens the browser menu in the card only', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('T', 100, 100, 'words here'), text('O', 500, 400, 'other')]))
    await dblclickIn(page, 'T', [0.1, 0.5])
    const prevented = (p: Corner) =>
      page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y)!
        const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 })
        target.dispatchEvent(e)
        return e.defaultPrevented
      }, p)
    expect(await prevented(await pointIn(page, 'T', [0.3, 0.5]))).toBe(false) // the browser's menu (copy, paste...) in the card
    expect(await prevented(await scenePoint(page, 700, 150))).toBe(true) // elsewhere, as on the canvas
    const inCard = await pointIn(page, 'T', [0.3, 0.5])
    await page.mouse.click(inCard.x, inCard.y, { button: 'right' })
    await frames(page)
    expect((await state(page)).editing).toBe(true) // a right press in the card keeps the edit
    await page.keyboard.press('Escape') // (closes nothing on the canvas: the edit ends)
    await dblclickIn(page, 'T', [0.1, 0.5])
    const start = (await state(page)).viewport
    const from = await scenePoint(page, 700, 300)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(from.x + 60, from.y + 40, { steps: 5 })
    await page.mouse.up({ button: 'middle' })
    await frames(page)
    expect((await state(page)).editing).toBe(false)
    const end = (await state(page)).viewport
    expect([end.panX - start.panX, end.panY - start.panY]).toEqual([60, 40])
    expect(errors).toEqual([])
  })

  test('a caret typed below the visible area scrolls nothing: the board, the layer and the card stay where they are', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('T', 300, 560, 'near the bottom', { width: 300 })]))
    const where = () =>
      page.evaluate(() => ({
        scrolls: [...document.querySelectorAll('.workspace, .canvas-host, .scene-layer, .scene-text-body')].map((el) => (el as HTMLElement).scrollTop + (el as HTMLElement).scrollLeft),
        page: document.scrollingElement!.scrollTop,
        world: (document.querySelector('.scene-world') as HTMLElement).style.transform,
      }))
    const before = await where()
    await dblclickIn(page, 'T', [0.1, 0.5])
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    for (let i = 0; i < 12; i++) await page.keyboard.press('Enter')
    await page.keyboard.type('far below')
    await page.keyboard.press('Control+z') // in-edit undo scrolls its selection into view
    await page.keyboard.press('Control+Shift+z')
    await frames(page)
    expect(await where()).toEqual(before)
    expect((await state(page)).viewport).toEqual({ zoom: 1, panX: 0, panY: 0 })
    expect(errors).toEqual([])
  })

  test('typing is saved as it happens: a reload in the middle of an edit keeps what was typed and a new text`s owner', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([frame()], [text('T', 240, 160, 'kept', { frameId: 'F' })]))
    await dblclickIn(page, 'T', [0.1, 0.5])
    await page.keyboard.press('Control+a')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type(' and typed')
    await button(page, 'Text').click().catch(() => undefined) // ends the edit (a tool button)
    const p = await scenePoint(page, 300, 300)
    await page.mouse.click(p.x, p.y)
    await page.keyboard.type('new one')
    await expect(status(page)).toContainText('Saved on this device', { timeout: 5000 })
    await page.waitForTimeout(1800)
    await page.reload()
    await expect(status(page)).toContainText('Saved on this device')
    const doc = await stored(page)
    expect(doc.objects.map((o) => [(o as { text: string }).text, o.frameId])).toEqual([
      ['kept and typed', 'F'],
      ['new one', 'F'],
    ])
    expect(errors).toEqual([])
  })
})

test.describe('the review follow-ups, paired with the Fabric renderer', () => {
  test.describe.configure({ timeout: 180_000 })

  test('a size, alignment and colour changed while editing show in the live card and its box at once (a drawn box with a word wider than it)', async ({ browser }) => {
    const doc = board([], [text('D', 120, 80, 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW and more', { width: 155, fontSize: 18, minHeight: 0 }), text('C', 520, 80, 'centred words here', { width: 200 })])
    const steps: Step[] = [
      { dblclick: 'D', at: [0.1, 0.05] },
      { fontSize: 48 }, // the box heights are compared after every step: the live card is laid out at the new size at once
      { fontSize: 30 },
      { button: 'Align centre' },
      { button: 'Red' },
      { click: 'D', at: [0.05, 0.02] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      { type: ' x' },
      { key: 'Escape' },
      { dblclick: 'C', at: [0.1, 0.2] },
      { fontSize: 40 },
      { button: 'Align right' },
      { key: 'Escape' },
    ]
    const { dom } = await expectPaired(browser, doc, steps)
    expect(dom.saved.objects[0]).toMatchObject({ fontSize: 30, align: 'center', color: '#d92d20' })
  })

  test('a press that ends an edit never acts on a handle of the text it leaves: corners, sides and the rotation handle, inside, on and just outside the box, at two zooms', async ({ browser }) => {
    for (const zoom of [1.7, 0.8]) {
      // One line: a side handle of a text of several lines sits on the boundary between two of them,
      // where the browser and Fabric divide lines a few pixels apart (a known difference).
      const doc = board([], [text('T', 120, 100, 'hidden handles', { width: 240 })], { zoom, panX: 0, panY: 0 })
      const steps: Step[] = []
      const cases: Array<[string, [number, number]]> = [
        ['br', [-2, -2]], ['br', [0, 0]], ['br', [2, 2]],
        ['tl', [2, 2]], ['tl', [-2, -2]],
        ['mr', [-2, 0]], ['mr', [0, 0]], ['mr', [2, 0]],
        ['ml', [2, 0]], ['ml', [-2, 0]],
        ['mtr', [0, 0]],
      ]
      for (const [handle, offset] of cases) steps.push({ dblclick: 'T', at: [0.2, 0.5] }, { handlePress: 'T', handle, offset, by: [30, 20] }, { key: 'Escape' })
      const { dom } = await expectPaired(browser, doc, steps)
      expect(dom.saved.objects[0]).toMatchObject({ width: 240, angle: 0, left: 120, top: 100 })
    }
  })

  test('a selected word dragged within its text moves, however far the pointer first moves', async ({ browser }) => {
    const doc = board([], [text('T', 100, 100, 'first second third fourth', { width: 500 })])
    const steps: Step[] = []
    for (const first of [1, 6, 12, 30]) {
      const moves: Array<[number, number]> = [[first, 0]]
      for (let x = first + 20; x <= 205; x += 20) moves.push([x, 0])
      moves.push([205, 0])
      steps.push({ dblclick: 'T', at: [0.03, 0.5] }, { wait: 600 }, { pressMove: 'T', at: [0.03, 0.5], moves }, { type: '!' }, { key: 'Escape' }, { key: 'Control+z' })
    }
    const { dom } = await expectPaired(browser, doc, steps)
    expect((dom.saved.objects[0] as { text: string }).text).toBe('first second third fourth')
    // Moved, and selected where it landed (as Fabric selects a dropped range): the next key replaces it.
    expect(dom.records.filter((r) => r.step.includes('pressMove')).map((r) => [r.edit?.text, r.edit?.anchor, r.edit?.head])).toEqual(Array(4).fill([' second third foufirstrth', 17, 22]))
  })

  test('Shift+click on a selected text selects from the caret it kept; Shift+click inside an edit extends its range', async ({ browser }) => {
    const doc = board([], [text('T', 100, 100, 'alpha beta gamma delta', { width: 400 })])
    const steps: Step[] = [
      { click: 'T', at: [0.5, 0.5] }, // selects it
      { click: 'T', at: [0.55, 0.5], shift: true }, // edit, from the start (a text never edited keeps its caret at 0)
      { key: 'ArrowRight' },
      { key: 'Escape' }, // the text keeps its caret where the selection starts
      { click: 'T', at: [0.2, 0.5], shift: true }, // back from that caret
      { key: 'ArrowLeft' },
      { key: 'Escape' },
      { click: 'T', at: [0.9, 0.5], shift: true },
      { click: 'T', at: [0.1, 0.5] }, // inside the edit: a caret
      { click: 'T', at: [0.5, 0.5], shift: true }, // inside the edit: the range grows
      { key: 'ArrowRight' },
      { key: 'Escape' },
      { drag: 'T', at: [0.9, 0.5], dx: 40, dy: 30 }, // a press on the selected text moves its caret there, then drags it
      { click: 'T', at: [0.3, 0.5], shift: true }, // from that press, which moved with the text
      { type: 'X' },
      { key: 'Escape' },
    ]
    const { dom } = await expectPaired(browser, doc, steps)
    expect((dom.saved.objects[0] as { text: string }).text).toBe('alpha beta X')
  })

  test('a new text drawn near the bottom of a frame, sized and lengthened in its first edit, has its owner decided again when that edit ends (a named difference)', async ({ browser }) => {
    const doc = board([frame({ left: 200, top: 120, width: 420, height: 150 })], [])
    const steps: Step[] = [
      { button: 'Text' },
      { dragAt: [240, 225], to: [460, 255] },
      { type: 'a line' },
      { fontSize: 40 },
      { clickAt: [246, 240] },
      { key: 'Control+a' },
      { key: 'ArrowRight' },
      ...Array.from({ length: 7 }, (_, i): Step => ({ type: `\nline ${i + 2}` })),
      { key: 'Escape' },
    ]
    // The settled rule: a new text's owner is decided again when its FIRST edit ends. The size change
    // puts the text in history mid-edit; the DOM renderer remembers it was made for this edit and
    // decides again (loose: its centre is far below the frame); Fabric judges by history and keeps it.
    const { dom, fabric } = await expectPaired(browser, doc, steps, { omit: new Set(['~1.frameId']) })
    expect(dom.saved.objects[0]!.frameId).toBeUndefined()
    expect(fabric.saved.objects[0]!.frameId).toBe('F')
  })
})

test.describe('the review follow-ups on the DOM renderer', () => {
  test('a size changed while editing re-lays the live card at once: nothing paints outside its box, and it is as tall as after the edit', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('D', 120, 80, 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', { width: 155, fontSize: 18, minHeight: 0 })]))
    await dblclickIn(page, 'D', [0.1, 0.05])
    await page.getByLabel('Font size').fill('48')
    await frames(page)
    const live = await page.evaluate(() => {
      const body = document.querySelector('.scene-layer [data-id="D"] > .scene-text-body') as HTMLElement
      const range = document.createRange()
      range.selectNodeContents(body)
      const b = body.getBoundingClientRect()
      const right = Math.max(...Array.from(range.getClientRects()).map((r) => r.right))
      return { height: parseFloat(getComputedStyle(body).height), overhang: right - b.right, box: window.__edit.boxes().D }
    })
    expect(live.overhang).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')
    await frames(page)
    const after = await page.evaluate(() => ({ height: parseFloat(getComputedStyle(document.querySelector('.scene-layer [data-id="D"] > .scene-text-body')!).height), box: window.__edit.boxes().D }))
    expect(Math.abs(live.height - after.height)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(live.box! - after.box!)).toBeLessThanOrEqual(0.5)
    expect(errors).toEqual([])
  })

  test('the edited text is a text box to assistive technology, named Text, and nothing focusable is hidden; idle cards are not read out', async ({ page }) => {
    const errors = errorsOf(page)
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/aria-hidden/i.test(m.text())) warnings.push(m.text())
    })
    await openBoard(page, board([], [text('T', 100, 100, 'notes on the sleeve'), text('U', 100, 300, 'another idle note')]))
    const tree = () => page.locator('.canvas-host').ariaSnapshot()
    expect(await tree()).not.toContain('notes on the sleeve')
    await dblclickIn(page, 'T', [0.1, 0.5])
    const box = page.getByRole('textbox', { name: 'Text', exact: true })
    await expect(box).toBeFocused()
    await expect(box).toHaveText('notes on the sleeve')
    expect(await box.getAttribute('aria-multiline')).toBe('true')
    expect(await page.evaluate(() => document.activeElement?.closest('[aria-hidden="true"]') === null)).toBe(true)
    const editing = await tree()
    expect(editing).toContain('textbox "Text"')
    expect(editing).not.toContain('another idle note')
    await page.keyboard.press('Escape')
    await frames(page)
    expect(await page.getByRole('textbox', { name: 'Text', exact: true }).count()).toBe(0)
    expect(await tree()).not.toContain('notes on the sleeve')
    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  test('a caption carried by its image is drawn with the same lettering while it moves as at rest', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [image('I', 200, 160), text('cap', 200, 290, 'Front sleeve, 1991 pressing', { width: 160, minHeight: 0, captionOf: 'I', captionPosition: 0.5 })]), ASSETS)
    /** Pixels darker than each threshold (sum of channels) inside the caption's box, 3 px in from its edges. */
    const ink = async () => {
      const c = (await page.evaluate(() => window.__edit.corners('cap')))!
      const clip = { x: c[0]!.x + 3, y: c[0]!.y + 3, width: c[1]!.x - c[0]!.x - 6, height: c[3]!.y - c[0]!.y - 6 }
      const png = await page.screenshot({ clip })
      return page.evaluate(async (b64) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const ctx = cv.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data
        return [150, 450].map((t) => {
          let n = 0
          for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! < t) n++
          return n
        })
      }, png.toString('base64'))
    }
    await clickIn(page, 'I', [0.5, 0.5]) // the image alone: the caption follows it
    const rest = await ink()
    expect(rest[0]).toBeGreaterThan(50)
    const from = await pointIn(page, 'I')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 6 })
    await frames(page, 3)
    const moving = await ink() // the caption has moved with its image: its corners are read again
    await page.mouse.up()
    rest.forEach((r, i) => expect(Math.abs(moving[i]! - r), `dark pixels at rest ${rest}, while moving ${moving}`).toBeLessThanOrEqual(Math.max(3, r * 0.02)))
    expect(errors).toEqual([])
  })
})

test.describe('the last review follow-ups', () => {
  test.describe.configure({ timeout: 120_000 })

  test('an Alt-drag over an image that covers the edited text selects in the text, as on Fabric (paired)', async ({ browser }) => {
    const doc = board([], [text('A', 160, 200, 'covered words of a long note under one picture', { width: 360 }), image('I', 330, 170, { scaleX: 0.6, scaleY: 0.6 })])
    const steps: Step[] = [
      { dblclick: 'A', at: [0.05, 0.3] },
      { drag: 'A', at: [0.6, 0.3], dx: 48, dy: 6, alt: true }, // over the image: with Alt the press is the edited text's
      { type: 'Q' },
      { key: 'Escape' },
    ]
    const { dom } = await expectPaired(browser, doc, steps, { assets: ASSETS })
    expect(dom.saved.objects.find((o) => o.id === 'A')).toMatchObject({ left: 160, top: 200 })
    expect(dom.records[1]!.edit).not.toBeNull()
  })

  test('Shift+click in the selection padding of the edited text extends from the caret (paired)', async ({ browser }) => {
    const doc = board([], [text('T', 100, 100, 'alpha beta gamma delta', { width: 400 })])
    const steps: Step[] = [
      { dblclick: 'T', at: [0.05, 0.5] },
      { key: 'ArrowRight' }, // the caret after "alpha"
      { handlePress: 'T', handle: 'mr', offset: [-1, 0], by: [0, 0], shift: true }, // one pixel beyond the right edge
      { type: 'X' },
      { key: 'Escape' },
    ]
    const { dom } = await expectPaired(browser, doc, steps)
    expect((dom.saved.objects[0] as { text: string }).text).toBe('alphaX')
  })

  test('a box font set while editing lays the live card out in that font at once (the no-wrap pieces follow it)', async ({ page }) => {
    const errors = errorsOf(page)
    await openBoard(page, board([], [text('B', 120, 80, 'i'.repeat(64), { width: 68, fontSize: 18, minHeight: 0 })]))
    await dblclickIn(page, 'B', [0.5, 0.02])
    await page.evaluate(() => window.__edit.session('setBox', { font: 'mono' }))
    await frames(page)
    const live = await page.evaluate(() => window.__edit.boxes().B!)
    await page.keyboard.press('Escape')
    await frames(page)
    const after = await page.evaluate(() => window.__edit.boxes().B!)
    expect((await page.evaluate(() => window.__edit.scene())).objects[0]).toMatchObject({ font: 'mono' })
    expect(Math.abs(live - after), `live ${live}, after the edit ${after}`).toBeLessThanOrEqual(0.5)
    expect(errors).toEqual([])
  })
})
