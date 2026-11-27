import { ActiveSelection, Rect } from 'fabric'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TEXT_COLOR, HEADING_SCALE } from '../model/richText.ts'
import type { TextRecord } from '../model/types.ts'
import { FONT_STACKS } from './fonts.ts'
import { cardBleed, cardSvg, frameBitmapSize, PROSE_CSS, xmlSafe } from './renderFrameBitmap.ts'
import { CODE_PAD_X_EM, LIST_INDENT_EM, QUOTE_INDENT_EM,
  BASELINE_DEPTH,
  LAST_LINE_TRIM,
  LINE_PITCH,
  SceneLayer,
  boundsOf,
  candidateTokenRanges,
  FIT_SLACK,
  drawnNoWrapRanges,
  isOffscreen,
  matrixCss,
  projectMatrix,
  recordMatrix,
  noWrapRanges,
  renderCardBody,
  visibleScene,
} from './sceneLayer.ts'
import type { Matrix, MeasuredToken } from './sceneLayer.ts'

// The real Fabric (no fake): the projection must agree with Fabric's own geometry.

const apply = (m: Matrix, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
const STYLE = { originX: 'left', originY: 'top', strokeWidth: 0, padding: 2 } as const

/** The four corners of a DOM element of size w × h under `m`, against Fabric's own corners (tl, tr, br, bl). */
function cornersAgree(m: Matrix, w: number, h: number, coords: Array<{ x: number; y: number }>) {
  const ours = [apply(m, 0, 0), apply(m, w, 0), apply(m, w, h), apply(m, 0, h)]
  ours.forEach((p, i) => {
    expect(p.x).toBeCloseTo(coords[i]!.x, 1)
    expect(p.y).toBeCloseTo(coords[i]!.y, 1)
    expect(Math.abs(p.x - coords[i]!.x)).toBeLessThan(0.1)
    expect(Math.abs(p.y - coords[i]!.y)).toBeLessThan(0.1)
  })
}

describe('matrix-projection-matches-rotated-scaled-group-member', () => {
  for (const angle of [0, 45]) {
    it(`a standalone object at ${angle}°, scaled`, () => {
      const r = new Rect({ ...STYLE, left: 120, top: -40, width: 200, height: 80, angle, scaleX: 1.5, scaleY: 0.75 })
      r.setCoords()
      const m = projectMatrix(r.calcTransformMatrix(), r.width, r.height)
      cornersAgree(m, r.width, r.height, r.getCoords())
      // The record's own matrix (top-left corner, angle, scale) is the same placement.
      const tl = r.getCoords()[0]!
      const rec = recordMatrix(tl.x, tl.y, angle, 1.5, 0.75)
      rec.forEach((v, i) => expect(Math.abs(v - m[i]!)).toBeLessThan(1e-6))
    })

    it(`a member of a rotated, scaled multi-selection at ${angle}°`, () => {
      const a = new Rect({ ...STYLE, left: 0, top: 0, width: 100, height: 60, angle })
      const b = new Rect({ ...STYLE, left: 300, top: 150, width: 40, height: 140, angle: 10 })
      const sel = new ActiveSelection([a, b])
      sel.set({ angle: 30, scaleX: 1.25, scaleY: 1.25 })
      sel.setCoords()
      for (const obj of [a, b]) {
        // Inside the selection `left`/`top` are relative to it: only the full matrix places it.
        expect(obj.group).toBe(sel)
        const m = projectMatrix(obj.calcTransformMatrix(), obj.width, obj.height)
        cornersAgree(m, obj.width, obj.height, obj.getCoords())
      }
    })
  }

  it('is written as a CSS matrix with the six values in order', () => {
    expect(matrixCss([1, 0, 0, 1, 10, 20])).toBe('matrix(1, 0, 0, 1, 10, 20)')
  })
})

describe('viewport-culling-and-foreignobject-xhtml-escaping', () => {
  const size = { width: 1000, height: 600 }

  it('keeps items within the 256 px margin and culls those wholly beyond it, at any zoom', () => {
    for (const view of [{ zoom: 1, panX: 0, panY: 0 }, { zoom: 2, panX: -300, panY: 100 }, { zoom: 0.25, panX: 50, panY: 50 }]) {
      const vis = visibleScene(view, size)
      const z = view.zoom
      // In screen pixels: just inside the margin, and just beyond it, on each side.
      const at = (sx: number, sy: number, w = 10, h = 10) => boundsOf(recordMatrix((sx - view.panX) / z, (sy - view.panY) / z, 0), w / z, h / z)
      expect(isOffscreen(at(-256 - 9, 100), vis)).toBe(false)
      expect(isOffscreen(at(-256 - 11, 100), vis)).toBe(true)
      expect(isOffscreen(at(1000 + 255, 100), vis)).toBe(false)
      expect(isOffscreen(at(1000 + 257, 100), vis)).toBe(true)
      expect(isOffscreen(at(100, -256 - 11), vis)).toBe(true)
      expect(isOffscreen(at(100, 600 + 257), vis)).toBe(true)
      expect(isOffscreen(at(400, 300), vis)).toBe(false)
    }
  })

  it('uses the rotated bounds: a turned item reaching into the view is kept', () => {
    const vis = visibleScene({ zoom: 1, panX: 0, panY: 0 }, size, 0)
    // A 400 × 10 bar left of the view; turned 90° about its top-left it hangs down, still outside.
    expect(isOffscreen(boundsOf(recordMatrix(-20, 100, 0), 400, 10), vis)).toBe(false)
    expect(isOffscreen(boundsOf(recordMatrix(-20, 100, 90), 400, 10), vis)).toBe(true)
    expect(isOffscreen(boundsOf(recordMatrix(-20, 100, -45), 400, 10), vis)).toBe(false)
  })

  it('culls idle offscreen items in the layer and never the edited or moving one', () => {
    const layer = new SceneLayer({ getImage: () => undefined })
    const text = (id: string, left: number): TextRecord => ({ type: 'text', id, left, top: 10, angle: 0, width: 100, fontSize: 16, text: id, minHeight: 20 })
    layer.setRecords({ frames: [], objects: [text('near', 10), text('far', 5000), text('edited', 6000), text('moving', 7000)] })
    layer.setEditing('edited')
    layer.setMoving('moving', true)
    layer.cull(size)
    expect(layer.isCulled('near')).toBe(false)
    expect(layer.isCulled('far')).toBe(true)
    expect(layer.elementOf('far')!.classList.contains('is-culled')).toBe(true)
    expect(layer.isCulled('edited')).toBe(false)
    expect(layer.isCulled('moving')).toBe(false)
    layer.setViewport({ zoom: 1, panX: -4900, panY: 0 })
    layer.cull(size)
    expect(layer.isCulled('near')).toBe(true)
    expect(layer.isCulled('far')).toBe(false)
    layer.setMoving('moving', false)
    layer.setEditing(null)
    layer.cull(size)
    expect(layer.isCulled('moving')).toBe(true)
  })

  it('escapes < > & " in a card’s text and the inlined rules, so the SVG is well-formed XML', () => {
    const body = document.createElement('div')
    const nasty = 'a < b && c > "d" </foreignObject><script>x</script> \'e\''
    renderCardBody(body, { text: `${nasty}\n\n<br>`, fontSize: 16, width: 200, headings: [1], spans: [{ start: 0, end: 3, bold: true }] })
    const svg = cardSvg(body, { width: 200, height: 80 }, 32, 2)
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.documentElement.localName).toBe('svg')
    expect(parsed.documentElement.getAttribute('width')).toBe(String((200 + 64) * 2))
    expect(parsed.documentElement.getAttribute('viewBox')).toBe('0 0 264 144')
    const fo = parsed.documentElement.firstElementChild!
    expect(fo.localName).toBe('foreignObject')
    const html = fo.firstElementChild!
    expect(html.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    // The text comes back exactly, as text: nothing in it became markup.
    const prose = html.querySelector('.yuriful-prose')!
    expect(prose.querySelector('h1')!.textContent).toBe(nasty)
    expect(prose.querySelector('script')).toBeNull()
    expect(prose.querySelectorAll('br').length).toBe(1)
    expect(prose.lastElementChild!.textContent).toBe('<br>')
    expect(html.querySelector('style')!.textContent).toBe(PROSE_CSS)
    // Self-closing empty elements, as XML requires.
    expect(svg).toContain('<br />')
    expect(svg).not.toMatch(/<br>/)
  })

  it('replaces what XML cannot hold (controls, U+FFFE/U+FFFF, lone surrogates) with U+FFFD, and nothing else', () => {
    expect(xmlSafe('a\u0000b\u0001c\u000bd\u000ce\u001ff')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFDe\uFFFDf')
    expect(xmlSafe('tab\tline\nreturn\r ok')).toBe('tab\tline\nreturn\r ok')
    expect(xmlSafe('lone \ud800 high, lone \udc00 low, end high \ud83d')).toBe('lone \uFFFD high, lone \uFFFD low, end high \uFFFD')
    expect(xmlSafe('pair 😀 👩‍💻 \uFFFE \uFFFF')).toBe('pair 😀 👩‍💻 \uFFFD \uFFFD')
    const plain = 'nothing to replace'
    expect(xmlSafe(plain)).toBe(plain)
  })

  it('builds a well-formed SVG from a card holding characters XML cannot hold, without changing the card', () => {
    const body = document.createElement('div')
    const text = 'Nul \u0000 vt \u000b lone \ud800 end'
    renderCardBody(body, { text, fontSize: 16, width: 200 })
    const svg = cardSvg(body, { width: 200, height: 40 }, 32)
    expect(() => encodeURIComponent(svg)).not.toThrow()
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.querySelector('.yuriful-prose')!.textContent).toBe('Nul \uFFFD vt \uFFFD lone \uFFFD end')
    expect(body.textContent).toBe(text)
  })

  it('gives the bitmap the frame preview’s size rule and every card room for ink outside its box', () => {
    expect(frameBitmapSize({ width: 400, height: 300 })).toEqual({ width: 800, height: 600 })
    expect(frameBitmapSize({ width: 3200, height: 800 })).toEqual({ width: 1600, height: 400 })
    expect(cardBleed({ fontSize: 15.5 })).toBe(31)
  })
})

describe('click-created boxes keep words whole', () => {
  const tokens = (line: string) => candidateTokenRanges(line).map(({ start, end }) => line.slice(start, end))

  it('lists every word that must be measured: all but ASCII letters, digits and apostrophes, and single graphemes', () => {
    expect(tokens('a state-of-the-art 2012—2014 and/or plain words')).toEqual(['state-of-the-art', '2012—2014', 'and/or'])
    expect(tokens('see https://example.com/a-b?c=d now')).toEqual(['https://example.com/a-b?c=d'])
    expect(tokens('日本語のテキスト and 한국어 and ไทย (ＡＢＣ)')).toEqual(['日本語のテキスト', '한국어', 'ไทย', '(ＡＢＣ)'])
    expect(tokens("don't it’s 123 abc123 café Ünïcödé")).toEqual(['café', 'Ünïcödé'])
    expect(tokens('end. comma, 😀😀 x 😀 - —')).toEqual(['end.', 'comma,', '😀😀'])
    expect(tokens('tab\tsep-arated  double  spaces\r-x-')).toEqual(['sep-arated', '-x-'])
    expect(candidateTokenRanges('a-b c-d')).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }])
    expect(candidateTokenRanges('')).toEqual([])
  })

  it('wraps each such token in one no-wrap span that holds its marks', () => {
    // No layout here: every candidate counts as breakable (a no-wrap span is harmless).
    const body = document.createElement('div')
    const text = 'Ab state-of-the-art cd 日本語のテキスト'
    // A bold piece and an italic piece inside the first token; a bold mark that starts at its start.
    renderCardBody(body, { text, fontSize: 16, width: 200, spans: [{ start: 3, end: 8, bold: true }, { start: 8, end: 9, italic: true }, { start: 23, end: 26, bold: true }] })
    const spans = Array.from(body.querySelectorAll('.yp-nowrap'))
    expect(spans.map((s) => s.textContent)).toEqual(['state-of-the-art', '日本語のテキスト'])
    expect(spans[0]!.innerHTML).toBe('<strong>state</strong><em>-</em>of-the-art')
    expect(spans[1]!.innerHTML).toBe('<strong>日本語</strong>のテキスト')
    for (const s of spans) expect(s.parentElement!.localName).toBe('p')
    expect(body.textContent).toBe(text)
    // Nothing left behind: no empty mark element.
    expect(Array.from(body.querySelectorAll('strong, em')).every((el) => el.textContent !== '')).toBe(true)

    // A drawn box keeps the words that fit it whole too; with no layout here every width is 0, so all fit.
    const drawn = document.createElement('div')
    renderCardBody(drawn, { text, fontSize: 16, width: 200, minHeight: 0 })
    expect(drawn.classList.contains('is-drawn')).toBe(true)
    expect(Array.from(drawn.querySelectorAll('.yp-nowrap'), (el) => el.textContent)).toEqual(['state-of-the-art', '日本語のテキスト'])
    expect(noWrapRanges({ text: 'a\nk-pop lo-fi', fontSize: 16, width: 50, minHeight: 0 })).toEqual([[], [{ start: 0, end: 5 }, { start: 6, end: 11 }]])
  })

  it('puts each tab in its own tab span', () => {
    const body = document.createElement('div')
    renderCardBody(body, { text: 'a\tb\t\tc', fontSize: 16, width: 200 })
    expect(body.innerHTML).toBe('<p>a<span class="yp-tab">\t</span>b<span class="yp-tab">\t</span><span class="yp-tab">\t</span>c</p>')
  })
})

describe('drawn boxes keep a breakable word whole when it fits the box, and cut it as Fabric does when it does not', () => {
  /** A word whose graphemes are `w` px wide each (`kerned` after another), at `start` in its line. */
  const word = (start: number, text: string, w = 10, kerned = w): MeasuredToken => ({
    start,
    end: start + text.length,
    width: w + (text.length - 1) * kerned,
    graphemes: Array.from(text, (_, i) => ({ end: start + i + 1, width: w, kerned })),
  })

  it('keeps a word whole up to the box width, within FIT_SLACK', () => {
    const t = word(3, 'k-pop') // 50 px
    expect(drawnNoWrapRanges([t], 80)).toEqual([{ start: 3, end: 8 }])
    expect(drawnNoWrapRanges([t], 50)).toEqual([{ start: 3, end: 8 }])
    expect(drawnNoWrapRanges([t], 50 - FIT_SLACK)).toEqual([{ start: 3, end: 8 }])
    // Wider than the box: its first piece starts a line of its own; a last piece of one grapheme needs no span.
    expect(drawnNoWrapRanges([t], 49.9)).toEqual([{ start: 3, end: 7, cut: true }])
  })

  it('leaves alone a word CSS cannot break inside that fits', () => {
    expect(drawnNoWrapRanges([{ ...word(0, 'plain'), breakable: false }], 80)).toEqual([])
  })

  it('cuts a wider word into pieces that each fill the box, the first starting its own line, the last holding the rest', () => {
    expect(drawnNoWrapRanges([word(0, 'state-of-the-art')], 49)).toEqual([
      { start: 0, end: 4, cut: true }, { start: 4, end: 8 }, { start: 8, end: 12 }, { start: 12, end: 16 },
    ])
    expect(drawnNoWrapRanges([word(2, 'and/or')], 40)).toEqual([{ start: 2, end: 6, cut: true }, { start: 6, end: 8 }])
    // Cut even when CSS could not break inside it: the cut is where Fabric cuts.
    expect(drawnNoWrapRanges([{ ...word(0, 'abcdefgh'), breakable: false }], 45)).toEqual([{ start: 0, end: 4, cut: true }, { start: 4, end: 8 }])
  })

  it('always gives the first piece a span (it starts its own line), at least one grapheme each, even in a box narrower than a grapheme', () => {
    expect(drawnNoWrapRanges([word(0, 'a-b')], 20)).toEqual([{ start: 0, end: 2, cut: true }])
    expect(drawnNoWrapRanges([word(0, 'a-b')], 5)).toEqual([{ start: 0, end: 1, cut: true }])
  })

  it('fills a line as Fabric does: a grapheme’s own width first, then each next one’s kerned width', () => {
    // 10 + 8 + 8 = 26 fits 27 (adding own widths would give 30 and cut after two).
    expect(drawnNoWrapRanges([{ ...word(0, 'AVAVAV', 10, 8), width: 60 }], 27)).toEqual([{ start: 0, end: 3, cut: true }, { start: 3, end: 6 }])
    const uneven: MeasuredToken = {
      start: 0,
      end: 5,
      width: 50,
      graphemes: [5, 20, 5, 15, 5].map((w, i) => ({ end: i + 1, width: w, kerned: w })),
    }
    // 5 | 20 | 5 | 15 | 5 in a 26 px box: [5+20] [5+15+5]
    expect(drawnNoWrapRanges([uneven], 26)).toEqual([{ start: 0, end: 2, cut: true }, { start: 2, end: 5 }])
  })

  it('keeps whole a word the layout measures over the box but Fabric fits on one line', () => {
    expect(drawnNoWrapRanges([{ ...word(0, 'k-pop', 10, 9.9), width: 50.5 }], 50)).toEqual([{ start: 0, end: 5 }])
  })
})

describe('a card body', () => {
  it('carries the record’s font, size, alignment, colour, caption background and drawn height', () => {
    const body = document.createElement('div')
    renderCardBody(body, { text: 'x', fontSize: 18.5, width: 120, minHeight: 44, font: 'serif', align: 'right', color: '#c4372f', captionBackground: '#fff3c4' })
    expect(body.className).toBe('yuriful-prose is-drawn is-right')
    expect(body.dataset.font).toBe('serif')
    expect(body.style.fontSize).toBe('18.5px')
    expect(body.style.minHeight).toBe('44px')
    expect(body.style.color).toBe('rgb(196, 55, 47)')
    expect(body.style.backgroundColor).toBe('rgb(255, 243, 196)')
    // No layout in jsdom: nothing to correct.
    for (const level of [0, 1, 2, 3]) expect(body.style.getPropertyValue(`--yp-shift-${level}`)).toBe('0px')

    renderCardBody(body, { text: 'y', fontSize: 12, width: 120 })
    expect(body.className).toBe('yuriful-prose')
    expect(body.dataset.font).toBe('sans')
    expect(body.style.minHeight).toBe('')
    expect(body.style.color).toBe('')
    expect(body.style.backgroundColor).toBe('')
  })

  it('is rendered again only when its record changed, or when forced (after an edit session)', () => {
    const layer = new SceneLayer({ getImage: () => undefined })
    const rec: TextRecord = { type: 'text', id: 't', left: 0, top: 0, angle: 0, width: 120, fontSize: 12, text: 'a state-of-the-art b' }
    layer.setRecords({ frames: [], objects: [rec] })
    const body = layer.bodyOf('t')!
    expect(body.querySelector('.yp-nowrap')).not.toBeNull()
    body.innerHTML = '<p>a state-of-the-art b</p>' // what EditSession.finish() leaves
    layer.updateItem(rec)
    expect(body.querySelector('.yp-nowrap')).toBeNull()
    layer.updateItem(rec, true)
    expect(body.querySelector('.yp-nowrap')!.textContent).toBe('state-of-the-art')
    layer.updateItem({ ...rec, text: 'and/or' })
    expect(body.querySelector('.yp-nowrap')!.textContent).toBe('and/or')
  })

  it('shows a text this schema cannot read as its plain lines', () => {
    const body = document.createElement('div')
    renderCardBody(body, { text: 'one\n\ntwo', fontSize: 12, width: 120, blocks: [{ type: 'table' } as never] })
    expect(body.innerHTML).toBe('<p>one</p><p><br></p><p>two</p>')
  })

  it('shows rich blocks, with no-wrap spans and tabs on the lines inside them', () => {
    const body = document.createElement('div')
    renderCardBody(
      body,
      { text: '', fontSize: 12, width: 120, blocks: [{ type: 'bulletList', items: [{ blocks: [{ type: 'paragraph', content: [{ text: 'a\tb' }] }] }] }, { type: 'divider' }, { type: 'codeBlock', text: 'c' }] },
      [[{ start: 0, end: 3 }], []],
    )
    expect(body.innerHTML).toBe('<ul><li><p><span class="yp-nowrap">a<span class="yp-tab">\t</span>b</span></p></li></ul><hr><pre><code>c</code></pre>')
  })
})

describe('the prose rules', () => {
  // PROSE_CSS is the stylesheet's own block: e2e/scene-layer.spec.ts reads both and keeps them identical.
  const block = PROSE_CSS

  it('reproduce Fabric’s line height, baseline and last line, heading sizes, fonts and default ink', () => {
    expect(LINE_PITCH).toBeCloseTo(1.4125, 10)
    expect(BASELINE_DEPTH).toBeCloseTo(0.87914, 10)
    expect(LAST_LINE_TRIM).toBeCloseTo(0.2825, 10)
    // A rule of its own (not one selector of a list): it starts the block or follows a closing brace.
    const rule = (selector: string) => block.match(new RegExp(`(?:^\\s*|\\}\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? ''
    expect(rule('.yuriful-prose')).toContain(`line-height: ${+LINE_PITCH.toFixed(4)};`)
    expect(rule('.yuriful-prose')).toContain(`color: ${DEFAULT_TEXT_COLOR};`)
    expect(rule('.yuriful-prose')).toContain(`font-family: ${FONT_STACKS.sans};`)
    expect(rule('.yuriful-prose > :last-child')).toContain(`margin-bottom: -${+LAST_LINE_TRIM.toFixed(4)}em;`)
    for (const level of [1, 2, 3] as const) expect(rule(`.yuriful-prose h${level}`)).toContain(`font-size: ${HEADING_SCALE[level]}em;`)
    // The lengths the measurer adds for blocks are the stylesheet's.
    expect(block).toContain(`.yuriful-prose ul,
.yuriful-prose ol {
  margin: 0;
  padding: 0 0 0 ${LIST_INDENT_EM}em;`)
    expect(block).toMatch(/\.yuriful-prose blockquote \{\n {2}display: flow-root;\n {2}margin: 0\.4em 0;\n {2}padding: 0 0 0 0\.875em;\n {2}border-left: 0\.125em solid /)
    expect(0.125 + 0.875).toBe(QUOTE_INDENT_EM)
    expect(block).toMatch(new RegExp(`\\.yuriful-prose pre \\{[^}]*\\n {2}padding: 0\\.5em ${CODE_PAD_X_EM}em;`))
    for (const [id, stack] of Object.entries(FONT_STACKS)) {
      expect(block).toContain(`.yuriful-prose[data-font="${id}"],
.yuriful-prose [data-font="${id}"] {
  font-family: ${stack};
}`)
    }
  })
})
