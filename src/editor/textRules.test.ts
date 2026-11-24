import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { headingsAfterEdit } from '../model/richText.ts'
import { fabricReference } from './testing/fabricReference.ts'
import { isBlankTextDoc } from '../model/textDoc.ts'
import type { EditSession } from './textSession.ts'
import { docFromText, posAtTextOffset, textSchema } from './textSchema.ts'
import { boxFormat, canonicalGuard, completesShortcut, lastBoxLine, matchShortcut, pendingKey, pendingMarks, setBoxLevel, shortcutTransaction, toggleBoxMark, typedMarks } from './textRules.ts'
import { insert, keyEvent, open, press, type } from './testing/textHarness.ts'

/** A selection at raw UTF-16 offsets, even inside a character (only ProseMirror itself could make one). */
const rawSelect = (s: EditSession, from: number, to: number) => s.dispatch(s.state.tr.setSelection(TextSelection.create(s.state.doc, posAtTextOffset(s.state.doc, from), posAtTextOffset(s.state.doc, to))))

/** What the controls show, without the font. */
const shown = (s: EditSession) => {
  const { font: _font, ...rest } = s.format()
  void _font
  return rest
}

// ---- the matcher -------------------------------------------------------------------------------

describe('the typing shortcut matcher (one line, no view)', () => {
  /** Types `typed` at the end of `before` (or where `|` is in it). */
  const typeAt = (before: string, typed: string) => {
    const at = before.includes('|') ? before.indexOf('|') : before.length
    const plain = before.replace('|', '')
    return matchShortcut(plain.slice(0, at) + typed + plain.slice(at), at + typed.length, typed)
  }
  const fires = (before: string, typed: string) => typeAt(before, typed)?.kind ?? null

  it('headings: #, ## or ### and a typed space at the very start of the line', () => {
    expect(typeAt('#', ' ')).toStrictEqual({ kind: 'heading', level: 1, remove: [{ start: 0, end: 2 }], content: { start: 2, end: 2 } })
    expect(typeAt('##|Title', ' ')).toStrictEqual({ kind: 'heading', level: 2, remove: [{ start: 0, end: 3 }], content: { start: 3, end: 8 } })
    expect(typeAt('###', ' ')?.level).toBe(3)
    expect(typeAt('#|\u{1F600}', ' ')?.content).toStrictEqual({ start: 2, end: 4 })
  })

  it('bold and italic: the closing marker completes a pair', () => {
    expect(typeAt('**bold*', '*')).toStrictEqual({ kind: 'bold', remove: [{ start: 0, end: 2 }, { start: 6, end: 8 }], content: { start: 2, end: 6 } })
    expect(typeAt('*it', '*')).toStrictEqual({ kind: 'italic', remove: [{ start: 0, end: 1 }, { start: 3, end: 4 }], content: { start: 1, end: 3 } })
    expect(typeAt('a **b*| c', '*')?.content).toStrictEqual({ start: 4, end: 5 })
    for (const [before, kind] of [['say **two words*', 'bold'], ['(*x', 'italic'], ['"**x*', 'bold'], ['“*x', 'italic'], ['\t*x', 'italic'], ['*x|)', 'italic'], ['**a** **b*', 'bold'], ['2 * 3 and *x', 'italic'], ['*\u{1F468}‍\u{1F469}‍\u{1F467}', 'italic']] as const) {
      expect(fires(before, '*'), before).toBe(kind)
    }
  })

  it('every pinned literal case stays literal', () => {
    const literal: Array<[string, string]> = [
      ['####', ' '], ['a #', ' '], [' #', ' '], ['#tag', ' '], ['x#', ' '], ['#', 'a'], ['# ', ' '], ['', ' '], ['#|́x', ' '],
      ['2 * 3 ', '*'], ['2 * 3 *| 4', '*'], ['a *', '*'], ['a ** b *', '*'], ['* item', '*'], ['*', '*'], ['', '*'], ['snake*case', '*'],
      ['***x**', '*'], ['***x*', '*'], ['***x', '*'], ['**', '*'], ['**bold', '*'], ['** x*', '*'], ['**x *', '*'], ['* x', '*'], ['*x ', '*'],
      ['**a*|*', '*'], ['*a|*', '*'], ['\u{1F600}*x', '*'], ['a*x', '*'], ['**x*|⃣', '*'], ['*́x', '*'],
    ]
    for (const [before, typed] of literal) expect(fires(before, typed), JSON.stringify(before + typed)).toBeNull()
    expect(matchShortcut('*x*', 3, 'x')).toBeNull()
    expect(matchShortcut('*x*', 2, '*')).toBeNull()
    expect(matchShortcut('# ', 1, ' ')).toBeNull()
  })

  it('is the same rule as the canvas matcher (`matchTypingShortcut`, a frozen reference) on every case, line by line', async () => {
    const cases = ['#', '##|Title', '###', '####', 'a #', '#tag', '**bold*', '*it', 'a **b*| c', '2 * 3 ', '* item', 'snake*case', '***x*', '** x*', '*x ', '**a*|*', '"**x*', '\u{1F600} *x', '\u{1F600}*x', '**x*|⃣', '*́x', '(*x', '#|́x']
    const inputs = cases.flatMap((before) =>
      [' ', '*'].map((typed) => {
        const at = before.includes('|') ? before.indexOf('|') : before.length
        const plain = before.replace('|', '')
        return { text: plain.slice(0, at) + typed + plain.slice(at), caret: at + typed.length, typed }
      }),
    )
    // What the Fabric renderer's matcher (`matchTypingShortcut` in `src/model/richText.ts` before it was deleted) gave for each.
    type Match = { kind: string; remove: unknown; content: unknown; level?: number } | null
    const matched = await fabricReference<Match[]>('matcher', inputs)
    expect(matched, 'one recorded answer for each case').toHaveLength(inputs.length)
    for (const [i, { text, caret, typed }] of inputs.entries()) {
      const canvas = matched[i]!
      const ours = matchShortcut(text, caret, typed)
      expect(ours === null ? null : ours.kind, JSON.stringify(text)).toBe(canvas === null ? null : canvas.kind)
      if (ours && canvas) expect({ remove: ours.remove, content: ours.content, level: ours.level }).toStrictEqual({ remove: canvas.remove, content: canvas.content, level: canvas.level })
    }
  })
})

// ---- typing shortcuts in a session ----------------------------------------------------------------

describe('typing shortcuts', () => {
  it('bold: nothing fires at the first closing star; the markers go, the word is bold, the caret is after it, and what is typed next is plain', () => {
    const s = open({ text: 'go' })
    type(s, ' **bold*')
    expect(s.content()).toStrictEqual({ text: 'go **bold*' })
    type(s, '*')
    expect(s.content()).toStrictEqual({ text: 'go bold', spans: [{ start: 3, end: 7, bold: true }] })
    expect(s.selection()).toMatchObject({ from: 7, to: 7 })
    expect(s.format().marks.bold).toBe('off')
    type(s, '!')
    expect(s.content()).toStrictEqual({ text: 'go bold!', spans: [{ start: 3, end: 7, bold: true }] })
  })

  it('italic, and a heading at the start of a line with text, on the empty last line, and changing a level', () => {
    const s = open({ text: 'one\nTitle\n', headings: [0, 3] }, { caret: 4 })
    type(s, '## ')
    expect(s.content()).toStrictEqual({ text: 'one\nTitle\n', headings: [0, 2] })
    expect(s.selection().head).toBe(4)
    s.select(10)
    type(s, '# ')
    expect(s.content()).toStrictEqual({ text: 'one\nTitle\n', headings: [0, 2, 1] })
    type(s, 'it is *so*')
    expect(s.content()).toStrictEqual({ text: 'one\nTitle\nit is so', spans: [{ start: 16, end: 18, italic: true }], headings: [0, 2, 1] })
  })

  it('in a heading line `**x**` still fires: the markers go, no bold is stored, and nothing is pending', () => {
    const s = open({ text: 'Big', headings: [1] })
    type(s, ' **x**')
    expect(s.content()).toStrictEqual({ text: 'Big x', headings: [1] })
    expect(s.format().marks.bold).toBe('on') // the heading's own
    expect(s.pending).toBeNull()
  })

  it('next to emoji, joined emoji and combining marks, the caret and the formatting land on the same characters (UTF-16 offsets)', () => {
    // Characters longer than one UTF-16 unit: a surrogate pair, a ZWJ family (8 units, one
    // character), a letter with a combining accent (2 units), a flag (two pairs) and a heart
    // with a variation selector.
    const wide = ['\u{1F600}', '\u{1F469}‍\u{1F469}‍\u{1F467}', 'é', '\u{1F1EB}\u{1F1F7}', '❤️']
    /** The raw ProseMirror caret too: a selection getter that rounds to a character would hide a caret inside one. */
    const caretAt = (s: EditSession, offset: number) => {
      expect(s.state.selection.empty).toBe(true)
      expect(s.state.selection.head).toBe(posAtTextOffset(s.state.doc, offset))
      expect(s.selection()).toMatchObject({ from: offset, to: offset })
    }
    for (const w of wide) {
      for (const [marker, mark] of [['**', 'bold'], ['*', 'italic']] as const) {
        // Before, inside and after the converted run, and all three at once.
        for (const [before, body, after] of [
          [`${w} `, 'xy', ' z'],
          ['', `a${w}b`, ''],
          ['', `x${w}`, ''],
          ['go ', 'x', ` ${w}`],
          ['go ', 'x', w],
          [`${w}${w} `, `${w}${w}`, ` ${w}`],
        ] as Array<[string, string, string]>) {
          const label = JSON.stringify({ before, marker, body, after })
          // Everything but the final star is there; the caret is where that star goes.
          const s = open({ text: `${before}${marker}${body}${marker.slice(1)}${after}` }, { caret: before.length + marker.length + body.length + marker.length - 1 })
          type(s, '*')
          expect(s.content(), label).toStrictEqual({ text: `${before}${body}${after}`, spans: [{ start: before.length, end: before.length + body.length, [mark]: true }] })
          caretAt(s, before.length + body.length)
          // What is typed next goes at that caret, plain.
          type(s, '!')
          expect(s.content(), label).toStrictEqual({ text: `${before}${body}!${after}`, spans: [{ start: before.length, end: before.length + body.length, [mark]: true }] })
        }
      }
      for (const level of [1, 2, 3]) {
        // A heading: wide characters on the line above, and in the rest of the line.
        const above = `${w}a${w}\n`
        const s = open({ text: `${above}${w} title${w}` }, { caret: above.length })
        type(s, `${'#'.repeat(level)} `)
        expect(s.content(), `${level} ${w}`).toStrictEqual({ text: `${above}${w} title${w}`, headings: [0, level] })
        caretAt(s, above.length)
        type(s, '!')
        expect(s.content().text).toBe(`${above}!${w} title${w}`)
      }
    }
    // The example the earlier canvas pinned: a surrogate pair before and inside.
    const s = open({ text: '\u{1F600} **\u{1F680}* z' }, { caret: 8 })
    type(s, '*')
    expect(s.content()).toStrictEqual({ text: '\u{1F600} \u{1F680} z', spans: [{ start: 3, end: 5, bold: true }] })
    caretAt(s, 5)
    // A star typed just before a combining mark joins it, so it is no marker: it stays literal.
    const literal = open({ text: '**x*⃣' }, { caret: 4 })
    type(literal, '*')
    expect(literal.content()).toStrictEqual({ text: '**x**⃣' })
  })

  it('looks only at the caret line: no character of any other line is read, so a long text costs no more than its line', () => {
    const long = 'word '.repeat(50_000)
    /** A state on `text` with the caret at its offset `caret`, in which reading a character of any line but the caret's is counted. */
    const watched = (text: string, caret: number) => {
      const { doc } = docFromText({ text })!
      const at = posAtTextOffset(doc, caret)
      const line = doc.resolve(at).parent
      let reads = 0
      let others = 0
      doc.descendants((node, _pos, parent) => {
        if (!node.isText || parent === line) return
        const kept = node.text!
        others += kept.length
        Object.defineProperty(node, 'text', {
          get: () => {
            reads++
            return kept
          },
        })
      })
      // The test is only as good as the lines it watches.
      expect(others).toBeGreaterThan(2 * long.length - 10)
      return { state: EditorState.create({ doc, selection: TextSelection.create(doc, at) }), at, reads: () => reads }
    }
    // A long line above the caret's line and one below it.
    const before = watched(`${long}\n*x\n${long}`, long.length + 3)
    const after = watched(`${long}\n*x*\n${long}`, long.length + 4)
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) {
      expect(completesShortcut(before.state, before.at, '*')).toBe(true)
      expect(shortcutTransaction(after.state, '*')).not.toBeNull()
    }
    expect(before.reads()).toBe(0)
    expect(after.reads()).toBe(0)
    // A backstop with a wide margin: 200 checks of each, which once took a few milliseconds.
    expect(performance.now() - t0).toBeLessThan(1000)
    // What the conversion leaves on that line: the markers gone and the letter italic.
    const tr = shortcutTransaction(after.state, '*')!
    const changed = tr.doc.resolve(tr.selection.head).parent
    expect(changed.textContent).toBe('x')
    expect(changed.firstChild!.marks.map((m) => m.type.name)).toContain('italic')
  })

  it('pinned-literal-cases-and-backspace-plus-ctrl-z-after-shortcut', () => {
    // Every pinned case, typed key by key on a new line, stays exactly as typed.
    for (const lit of ['2 * 3 * 4', 'a ** b', '* item', '**', 'snake*case*', '***x***', '#tag ', '#### ', 'a # ', '** x**', '*x *', '#x']) {
      const s = open({ text: 'x' })
      type(s, `\n${lit}`)
      expect(s.content(), lit).toStrictEqual({ text: `x\n${lit}` })
    }
    // A pasted `**x**` stays literal, and so does a pasted `*` that would close a marker.
    const pasted = open({ text: 'go ' })
    pasted.paste({ text: '**x**' })
    type(pasted, ' *i')
    pasted.paste({ text: '*' })
    expect(pasted.content()).toStrictEqual({ text: 'go **x** *i*' })

    // Backspace straight after: markers, formatting, caret and pending marks come back; nothing is deleted.
    const s = open({ text: 'go', spans: [{ start: 0, end: 2, underline: true }] })
    s.toggleMark('strike') // pending, before the shortcut
    type(s, ' *it*')
    expect(s.content()).toStrictEqual({ text: 'go it', spans: [{ start: 0, end: 2, underline: true }, { start: 2, end: 3, underline: true, strike: true }, { start: 3, end: 5, italic: true, underline: true, strike: true }] })
    expect(s.pending).toStrictEqual({ strike: true, italic: false })
    expect(press(s, 'Backspace')).toBe(true)
    expect(s.content()).toStrictEqual({ text: 'go *it*', spans: [{ start: 0, end: 2, underline: true }, { start: 2, end: 7, underline: true, strike: true }] })
    expect(s.selection()).toMatchObject({ from: 7, to: 7 })
    expect(s.pending).toStrictEqual({ strike: true })
    expect(s.canRevertShortcut).toBe(false)
    type(s, '*') // typing on does not fire it again
    expect(s.content().text).toBe('go *it**')
    press(s, 'Backspace')
    press(s, 'Backspace')
    expect(s.content().text).toBe('go *it')

    // In-edit Ctrl/Cmd+Z straight after undoes only the conversion, back to the literal
    // markers, and drops the Backspace offer; a second one undoes the typed text.
    const z = open({ text: 'go' })
    type(z, ' **b**')
    expect(z.content()).toStrictEqual({ text: 'go b', spans: [{ start: 3, end: 4, bold: true }] })
    expect(z.canRevertShortcut).toBe(true)
    expect(press(z, 'z', { ctrlKey: true })).toBe(true)
    expect(z.content()).toStrictEqual({ text: 'go **b**' })
    expect(z.canRevertShortcut).toBe(false)
    expect(press(z, 'Backspace')).toBe(true) // an ordinary Backspace now
    expect(z.content()).toStrictEqual({ text: 'go **b*' })
    z.undo()
    z.undo()
    expect(z.content()).toStrictEqual({ text: 'go' })
  })

  it('a heading: Backspace brings back the marker and the space, and the line its old level', () => {
    const s = open({ text: 'x\nTitle', headings: [0, 3] }, { caret: 2 })
    type(s, '# ')
    expect(s.content().headings).toEqual([0, 1])
    press(s, 'Backspace')
    expect(s.content()).toStrictEqual({ text: 'x\n# Title', headings: [0, 3] })
    expect(s.selection().head).toBe(4)
  })

  it('a new text typed only `# ` is still blank (the editor discards it); `# Title` is a heading', () => {
    const s = open()
    type(s, '# ')
    expect(s.content()).toStrictEqual({ text: '', headings: [1] })
    expect(isBlankTextDoc(s.content())).toBe(true)
    type(s, 'Title')
    expect(s.content()).toStrictEqual({ text: 'Title', headings: [1] })
    expect(isBlankTextDoc(s.content())).toBe(false)
  })

  it('pending marks come back as they were before it fired', () => {
    const s = open({ text: 'go' })
    s.toggleMark('underline')
    type(s, ' *a*')
    expect(s.content().spans).toEqual([{ start: 2, end: 3, underline: true }, { start: 3, end: 4, italic: true, underline: true }])
    expect(s.format().marks).toMatchObject({ italic: 'off', underline: 'on' })
    press(s, 'Backspace')
    expect(s.content().spans).toEqual([{ start: 2, end: 6, underline: true }])
    expect(s.format().marks).toMatchObject({ italic: 'off', underline: 'on' })
  })

  const ways: Array<[string, (s: EditSession) => void]> = [
    ['more typing', (s) => type(s, 'z')],
    ['a caret move', (s) => {
      s.select(1)
      s.select(s.content().text.length)
    }],
    ['a formatting command', (s) => s.toggleMark('strike')],
    ['a heading command that changes nothing', (s) => s.setHeading(0)],
    ['a font command at the caret', (s) => s.setFont('serif')],
    ['the font size field (the editor drops the offer)', (s) => s.clearShortcutRevert()],
    ['a box setting (alignment)', (s) => s.setBox({ align: 'center' })],
    ['a box setting that changes nothing', (s) => s.setBox({})],
    ['an in-edit undo and redo', (s) => {
      s.undo()
      s.redo()
    }],
  ]
  for (const [what, act] of ways) {
    it(`the Backspace offer is gone after ${what}: Backspace deletes normally`, () => {
      const s = open({ text: 'go' })
      type(s, ' **b**')
      act(s)
      const before = s.content().text
      expect(s.canRevertShortcut).toBe(false)
      press(s, 'Backspace')
      expect(s.content().text).toBe(before.slice(0, -1))
    })
  }

  it('a held Backspace straight after `# ` reverts once, then its repeats delete normally', () => {
    const s = open()
    type(s, '# ')
    press(s, 'Backspace')
    expect(s.content().text).toBe('# ')
    press(s, 'Backspace', { repeat: true })
    press(s, 'Backspace', { repeat: true })
    expect(s.content().text).toBe('')
  })

  it('Backspace with a modifier, or during a composition, is not the revert', () => {
    for (const init of [{ shiftKey: true }, { altKey: true }, { isComposing: true }]) {
      const s = open({ text: 'go' })
      type(s, ' *i*')
      s.handleKeyDown(keyEvent(s, 'Backspace', init))
      expect(s.content(), JSON.stringify(init)).toStrictEqual({ text: 'go i', spans: [{ start: 3, end: 4, italic: true }] })
    }
  })
})

describe('only a character a key typed, inserted at the caret, fires', () => {
  it('a `*` inserted with no keydown typing it (paste, drop, emoji panel) stays literal', () => {
    const s = open({ text: 'go' })
    type(s, ' *i')
    insert(s, '*')
    expect(s.content().text).toBe('go *i*')
    type(s, ' **x*')
    s.handleKeyDown(keyEvent(s, 'v', { ctrlKey: true })) // Ctrl+V of "*"
    insert(s, '*')
    s.handleKeyUp()
    expect(s.content().text).toBe('go *i* **x**')
  })

  it('a key whose input never came (its keyup arrived first) does not make later text fire', () => {
    const s = open({ text: 'go' })
    type(s, ' *i')
    s.handleKeyDown(keyEvent(s, '*'))
    s.handleKeyUp()
    insert(s, '*')
    expect(s.content().text).toBe('go *i*')
  })

  it('nothing fires during an IME composition, nor for a key the IME takes', () => {
    const s = open({ text: 'go' })
    type(s, ' *i')
    s.handleKeyDown(keyEvent(s, '*'))
    insert(s, '*', true) // `handleTextInput` runs during a composition (Spike S4): the composing guard
    expect(s.content().text).toBe('go *i*')
    type(s, '*', { isComposing: true })
    expect(s.content().text).toBe('go *i**')
    const h = open()
    h.handleKeyDown(keyEvent(h, ' '))
    insert(h, '#')
    h.handleKeyDown(keyEvent(h, ' '))
    insert(h, ' ', true)
    expect(h.content()).toStrictEqual({ text: '# ' })
  })

  it('a typed `*` that replaces a selection does not fire, nor one inserted away from the caret', () => {
    const s = open({ text: '*i!' })
    s.select(2, 3)
    type(s, '*')
    expect(s.content().text).toBe('*i*')
    const t = open({ text: '*i' }, { caret: 0 })
    t.handleKeyDown(keyEvent(t, '*'))
    expect(t.handleTextInput(posAtTextOffset(t.state.doc, 2), posAtTextOffset(t.state.doc, 2), '*')).toBe(false)
  })

  it('AltGr (Ctrl+Alt) and numpad `*` fire; Ctrl+`*` alone does not type', () => {
    const s = open({ text: 'go *i' })
    type(s, '*', { ctrlKey: true, altKey: true })
    expect(s.content()).toStrictEqual({ text: 'go i', spans: [{ start: 3, end: 4, italic: true }] })
    const t = open({ text: 'go *i' })
    t.handleKeyDown(keyEvent(t, '*', { ctrlKey: true }))
    insert(t, '*')
    expect(t.content().text).toBe('go *i*')
  })

  it('nothing fires while the editor says no (a gesture unsettled) or the board is read-only', () => {
    let allow = false
    const s = open({ text: 'go *i' }, { hooks: { canFireShortcut: () => allow } })
    type(s, '*')
    expect(s.content().text).toBe('go *i*')
    allow = true
    s.select(5)
    press(s, 'Delete')
    type(s, '*')
    expect(s.content().text).toBe('go i')
  })
})

// ---- headings never store bold ---------------------------------------------------------------------

describe('a heading line is always bold, so bold is never stored or pending on one', () => {
  it('heading-never-stores-bold-and-drops-pending-bold', () => {
    // A bold line made a heading loses its bold marks; other marks stay; back to body it is plain.
    const s = open({ text: 'ab cd', spans: [{ start: 0, end: 5, bold: true }, { start: 3, end: 5, italic: true }] })
    s.setHeading(1)
    expect(s.content()).toStrictEqual({ text: 'ab cd', spans: [{ start: 3, end: 5, italic: true }], headings: [1] })
    let bold = false
    s.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'bold')) bold = true
    })
    expect(bold).toBe(false) // not just in the record: in the document shown
    s.setHeading(0)
    expect(s.content()).toStrictEqual({ text: 'ab cd', spans: [{ start: 3, end: 5, italic: true }] })

    // What a typed character would get never carries bold on a heading line; italic it does.
    const p = open({ text: 'x' })
    p.toggleMark('italic')
    p.toggleMark('bold')
    expect(p.pending).toStrictEqual({ italic: true, bold: true })
    expect(typedMarks(p.state, 'sans')?.map((m) => m.type.name).sort()).toEqual(['bold', 'italic'])
    p.setHeading(2)
    expect(p.pending).toStrictEqual({ italic: true })
    expect(typedMarks(p.state, 'sans')?.map((m) => m.type.name)).toEqual(['italic'])
    type(p, 'y')
    expect(p.content()).toStrictEqual({ text: 'xy', spans: [{ start: 1, end: 2, italic: true }], headings: [2] })

    // The guards themselves, on any transaction: bold put into a heading by hand is stripped,
    // and a pending bold set by hand on a heading line is dropped.
    const read = docFromText({ text: 'Title\nbody', headings: [1] })!
    let state = EditorState.create({ doc: read.doc, plugins: [canonicalGuard({ baseFont: () => 'sans' }), pendingMarks({ baseFont: () => 'sans' })] })
    state = state.apply(state.tr.addMark(1, 6, textSchema.marks.bold!.create()))
    expect(state.doc.child(0).firstChild!.marks).toEqual([])
    state = state.apply(state.tr.addMark(8, 12, textSchema.marks.bold!.create()))
    expect(state.doc.child(1).firstChild!.marks.map((m) => m.type.name)).toEqual(['bold']) // a normal line keeps it
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)))
    state = state.apply(state.tr.setMeta(pendingKey, { bold: true, italic: true }))
    expect(typedMarks(state, 'sans')?.map((m) => m.type.name)).toEqual(['italic'])
    expect(pendingKey.getState(state)).toStrictEqual({ italic: true })
  })

  it("the panel's heading drops a pending bold, so the normal line after Enter is plain", () => {
    const s = open()
    s.toggleMark('bold')
    s.setHeading(1)
    expect(s.pending).toBeNull()
    expect(shown(s)).toMatchObject({ heading: 1, boldFromHeading: true })
    type(s, 'Title\nBody')
    expect(s.format().marks.bold).toBe('off')
    expect(s.content()).toStrictEqual({ text: 'Title\nBody', headings: [1] })
  })

  for (const [marker, level] of [['# ', 1], ['## ', 2]] as const) {
    it(`the \`${marker.trim()}\` shortcut drops a pending bold, and the normal line after Enter is plain`, () => {
      const s = open()
      s.toggleMark('bold')
      type(s, marker)
      expect(s.pending).toBeNull()
      type(s, 'Title\nBody')
      expect(s.content()).toStrictEqual({ text: 'Title\nBody', headings: [level] })
    })
  }

  it('a line joined into the heading above it (Backspace at its start) drops a pending bold', () => {
    const s = open()
    s.setHeading(1)
    type(s, 'Title\n')
    s.toggleMark('bold')
    expect(s.pending).toStrictEqual({ bold: true })
    press(s, 'Backspace')
    expect(s.pending).toBeNull()
    type(s, 'A\nBody')
    expect(s.content()).toStrictEqual({ text: 'TitleA\nBody', headings: [1] })
  })

  for (const how of ['panel', 'shortcut'] as const) {
    it(`italic pending before the heading (${how}) still applies, to the heading and the line after it; only bold is dropped`, () => {
      const s = open()
      s.toggleMark('italic')
      s.toggleMark('bold')
      if (how === 'panel') s.setHeading(1)
      else type(s, '# ')
      expect(s.pending).toStrictEqual({ italic: true })
      type(s, 'Title\nBody')
      expect(s.content()).toStrictEqual({ text: 'Title\nBody', spans: [{ start: 0, end: 10, italic: true }], headings: [1] })
    })
  }

  it('a pending "bold off" next to bold text, then a heading: only the bold is dropped', () => {
    const s = open({ text: 'ab', spans: [{ start: 0, end: 2, bold: true }] })
    s.toggleMark('bold')
    s.toggleMark('underline')
    expect(s.pending).toStrictEqual({ bold: false, underline: true })
    s.setHeading(2)
    expect(s.pending).toStrictEqual({ underline: true })
  })

  it('Backspace straight after `# ` restores the literal text and the pending bold: what is typed next is bold on that normal line', () => {
    const s = open()
    s.toggleMark('bold')
    type(s, '# ')
    expect(s.pending).toBeNull()
    press(s, 'Backspace')
    expect(s.content()).toStrictEqual({ text: '# ', spans: [{ start: 0, end: 2, bold: true }] })
    expect(s.pending).toStrictEqual({ bold: true })
    expect(s.format().marks.bold).toBe('on')
    type(s, 'x')
    expect(s.content()).toStrictEqual({ text: '# x', spans: [{ start: 0, end: 3, bold: true }] })
  })

  it('bold on a heading line cannot be pending: shown pressed, and the command does nothing', () => {
    const changes: unknown[] = []
    const s = open({ text: 'Title', headings: [1] }, { hooks: { onChange: (c) => changes.push(c) } })
    expect(shown(s)).toMatchObject({ boldFromHeading: true, marks: { bold: 'on' } })
    expect(s.toggleMark('bold')).toBe(false)
    expect(s.format().marks.bold).toBe('on')
    expect(changes).toEqual([])
  })

  it('text pasted into a heading and a bold line joined into one store no bold', () => {
    const s = open({ text: 'Title\nbold', headings: [1], spans: [{ start: 6, end: 10, bold: true }] }, { caret: 5 })
    s.paste({ html: '<p><strong>X</strong></p>' })
    expect(s.content()).toStrictEqual({ text: 'TitleX\nbold', spans: [{ start: 7, end: 11, bold: true }], headings: [1] })
    press(s, 'Delete')
    expect(s.content()).toStrictEqual({ text: 'TitleXbold', headings: [1] })
  })
})

// ---- line levels through an edit --------------------------------------------------------------------

describe('a heading is a property of a line, carried through every edit as today', () => {
  /** Runs `act`, then checks the levels against today's `headingsAfterEdit` for the same text change and caret. */
  function likeToday(s: EditSession, act: () => void) {
    const before = s.content()
    act()
    const after = s.content()
    expect(after.headings, `${JSON.stringify(before.text)} -> ${JSON.stringify(after.text)}`).toStrictEqual(headingsAfterEdit(before.text, before.headings, after.text, s.selection().head))
    return after
  }

  it('Enter at the end of a heading starts a normal line; what is typed there is plain', () => {
    const s = open({ text: 'Title\nbody', headings: [1] }, { caret: 5 })
    expect(likeToday(s, () => press(s, 'Enter')).headings).toEqual([1])
    type(s, 'x')
    expect(s.content()).toStrictEqual({ text: 'Title\nx\nbody', headings: [1] })
  })

  it('Enter in the middle of a heading leaves both halves headings', () => {
    const s = open({ text: 'Title', headings: [1] }, { caret: 2 })
    expect(likeToday(s, () => press(s, 'Enter'))).toStrictEqual({ text: 'Ti\ntle', headings: [1, 1] })
  })

  it('Enter at the start of a heading leaves an empty heading line above it', () => {
    const s = open({ text: 'body\nTitle', headings: [0, 1] }, { caret: 5 })
    expect(likeToday(s, () => press(s, 'Enter')).headings).toEqual([0, 1, 1])
    const t = open({ text: 'Title', headings: [2] }, { caret: 0 })
    expect(likeToday(t, () => press(t, 'Enter')).headings).toEqual([2, 2])
  })

  it('Enter at the end of a normal line above a heading starts a normal line; the heading stays on its line', () => {
    const s = open({ text: 'body\nTitle', headings: [0, 1] }, { caret: 4 })
    expect(likeToday(s, () => press(s, 'Enter')).headings).toEqual([0, 0, 1])
  })

  it('Enter on an empty heading line keeps it and starts a normal line; Enter at the end of a line above an empty heading keeps the heading below', () => {
    const s = open({ text: 'a\n\nb', headings: [0, 2] }, { caret: 2 })
    expect(likeToday(s, () => press(s, 'Enter')).headings).toEqual([0, 2])
    const t = open({ text: 'Title\n', headings: [1, 2] }, { caret: 5 })
    expect(likeToday(t, () => press(t, 'Enter')).headings).toEqual([1, 0, 2])
  })

  it('a heading line emptied by Backspace stays a heading, and what is typed there is a heading', () => {
    const s = open({ text: 'Hi\nbody', headings: [1] }, { caret: 2 })
    likeToday(s, () => press(s, 'Backspace'))
    expect(likeToday(s, () => press(s, 'Backspace'))).toStrictEqual({ text: '\nbody', headings: [1] })
    type(s, 'N')
    expect(s.content()).toStrictEqual({ text: 'N\nbody', headings: [1] })
  })

  it('Backspace at the start of a normal line under a heading makes it part of the heading', () => {
    const s = open({ text: 'Title\nbody', headings: [1] }, { caret: 6 })
    expect(likeToday(s, () => press(s, 'Backspace'))).toStrictEqual({ text: 'Titlebody', headings: [1] })
  })

  it('Backspace at the start of a heading under a line with text joins it into that normal line, drawn plain', () => {
    const s = open({ text: 'body\nTitle', headings: [0, 1] }, { caret: 5 })
    expect(likeToday(s, () => press(s, 'Backspace'))).toStrictEqual({ text: 'bodyTitle' })
  })

  it('Backspace at the start of a heading under an EMPTY line keeps the heading (also as the first line)', () => {
    const s = open({ text: 'a\n\nTitle', headings: [0, 0, 1] }, { caret: 3 })
    expect(likeToday(s, () => press(s, 'Backspace'))).toStrictEqual({ text: 'a\nTitle', headings: [0, 1] })
    const t = open({ text: '\nTitle', headings: [0, 1] }, { caret: 1 })
    expect(likeToday(t, () => press(t, 'Backspace'))).toStrictEqual({ text: 'Title', headings: [1] })
  })

  it('Delete at the end of a line joins the next one into it, with the first line’s level', () => {
    const s = open({ text: 'ab\nTitle', headings: [0, 1] }, { caret: 2 })
    expect(likeToday(s, () => press(s, 'Delete'))).toStrictEqual({ text: 'abTitle' })
    const t = open({ text: 'Title\n\nbody', headings: [1] }, { caret: 5 })
    expect(likeToday(t, () => press(t, 'Delete')).headings).toEqual([1])
    const u = open({ text: '\nbody', headings: [1] }, { caret: 0 })
    expect(likeToday(u, () => press(u, 'Delete'))).toStrictEqual({ text: 'body' })
  })

  it('a selection across lines typed over, deleted, or everything typed over', () => {
    const s = open({ text: 'Title\nbody', headings: [0, 1] })
    s.select(2, 8)
    expect(likeToday(s, () => type(s, 'x'))).toStrictEqual({ text: 'Tixdy' })
    const t = open({ text: 'ab\nTitle', headings: [0, 1] })
    t.select(0, 5)
    expect(likeToday(t, () => press(t, 'Backspace'))).toStrictEqual({ text: 'tle', headings: [1] })
    const u = open({ text: 'Title\nbody', headings: [1] })
    press(u, 'a', { ctrlKey: true })
    expect(likeToday(u, () => type(u, 'x'))).toStrictEqual({ text: 'x', headings: [1] })
  })

  it('a multi-line paste into the middle of a heading: the first line joins it, the last carries the rest of the heading', () => {
    const s = open({ text: 'Title\nbody', headings: [1] }, { caret: 2 })
    expect(likeToday(s, () => s.paste({ text: 'A\nB\nC' }))).toStrictEqual({ text: 'TiA\nB\nCtle\nbody', headings: [1, 0, 1] })
  })

  it('two lines pasted at the end of a heading: the new line is normal and not bold', () => {
    const s = open({ text: 'Title', headings: [1] })
    expect(likeToday(s, () => s.paste({ text: 'A\nB' }))).toStrictEqual({ text: 'TitleA\nB', headings: [1] })
  })

  it('a normal line pasted at the start of the heading keeps one heading; a plain word pasted over a word in a heading keeps it', () => {
    const s = open({ text: 'Title\nbody', headings: [1] }, { caret: 0 })
    expect(likeToday(s, () => s.paste({ text: 'body' }))).toStrictEqual({ text: 'bodyTitle\nbody', headings: [1] })
    const t = open({ text: 'Big word', headings: [2] })
    t.select(4, 8)
    expect(likeToday(t, () => t.paste({ text: 'deal' }))).toStrictEqual({ text: 'Big deal', headings: [2] })
  })

  it('typing in a body line keeps the heading; the first character typed on an empty heading line is a heading', () => {
    const s = open({ text: 'Title\nbody', headings: [1] })
    expect(likeToday(s, () => type(s, 'x')).headings).toEqual([1])
    const t = open({ text: 'a\n', headings: [0, 2] })
    expect(likeToday(t, () => type(t, 'H'))).toStrictEqual({ text: 'a\nH', headings: [0, 2] })
  })

  it('undo and redo restore the exact levels (they are left alone by the carry rule)', () => {
    const s = open({ text: 'Title\nbody', headings: [1] }, { caret: 6 })
    press(s, 'Backspace')
    expect(s.content()).toStrictEqual({ text: 'Titlebody', headings: [1] })
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'Title\nbody', headings: [1] })
    s.redo()
    expect(s.content()).toStrictEqual({ text: 'Titlebody', headings: [1] })
  })
})

// ---- formatting commands and readouts --------------------------------------------------------------------

describe('formatting a range or a caret while editing', () => {
  it('a mark on a range: added where not every character has it, removed where all do', () => {
    const s = open({ text: 'plain words', spans: [{ start: 6, end: 8, bold: true }] })
    s.select(6, 11)
    expect(s.format().marks.bold).toBe('mixed')
    s.toggleMark('bold')
    expect(s.content().spans).toEqual([{ start: 6, end: 11, bold: true }])
    s.toggleMark('bold')
    expect(s.content().spans).toBeUndefined()
  })

  it('bold on a range all in heading lines changes nothing; on a mixed range only the normal lines', () => {
    const s = open({ text: 'Title\nbody', headings: [1] })
    s.select(0, 5)
    expect(s.toggleMark('bold')).toBe(false)
    s.select(2, 10)
    s.toggleMark('bold')
    expect(s.content()).toStrictEqual({ text: 'Title\nbody', spans: [{ start: 6, end: 10, bold: true }], headings: [1] })
    expect(s.format()).toMatchObject({ marks: { bold: 'on' }, boldFromHeading: false })
  })

  it('a range with only a line break has no characters: nothing changes', () => {
    const s = open({ text: 'a\nb' })
    s.select(1, 2)
    expect(s.toggleMark('italic')).toBe(false)
    expect(s.format().marks.italic).toBe('off')
  })

  it('a character (surrogate pair, ZWJ sequence) is marked whole, whichever part the range touches', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const s = open({ text: `a${family}b` })
    rawSelect(s, 2, 3) // inside the cluster (a ProseMirror selection; `select` never splits a character)
    s.toggleMark('underline')
    expect(s.content().spans).toEqual([{ start: 1, end: 1 + family.length, underline: true }])
    rawSelect(s, 3, 4)
    s.toggleMark('underline') // every touched character has it: removed, whole
    expect(s.content().spans).toBeUndefined()
  })

  it('headings: the caret line, the lines a range touches, and back to body text', () => {
    const s = open({ text: 'one\ntwo\nthree' }, { caret: 5 })
    s.setHeading(1)
    expect(s.content().headings).toEqual([0, 1])
    s.select(2, 9)
    s.setHeading(2)
    expect(s.content().headings).toEqual([2, 2, 2])
    s.select(4, 7)
    s.setHeading(0)
    expect(s.content().headings).toEqual([2, 0, 2])
  })

  it('empty-last-line-and-selection-at-line-start', () => {
    // A range ending at the very start of a line (just after a line break) does not count that line:
    // not in what the panel shows, not for a heading command.
    const s = open({ text: 'one\ntwo\nthree', headings: [0, 0, 3] })
    s.select(0, 8)
    expect(s.format().heading).toBe(0)
    s.setHeading(1)
    expect(s.content().headings).toEqual([1, 1, 3])
    s.select(4, 8)
    expect(s.format().heading).toBe(1)
    s.select(4, 9) // one character of "three": now it counts
    expect(s.format().heading).toBe('mixed')
    s.select(8, 8) // a caret at the start of a line is on that line
    expect(s.format().heading).toBe(3)

    // A whole box (selected, not edited): an empty last line is left out of the panel and of a
    // heading set on the box; Body also clears it.
    const read = docFromText({ text: 'Title\nbody\n', headings: [1, 1, 2] })!
    const state = EditorState.create({ doc: read.doc })
    expect(lastBoxLine(state.doc)).toBe(1)
    expect(boxFormat(state.doc, 'sans').heading).toBe(1)
    let tr = state.tr
    expect(setBoxLevel(tr, 3)).toBe(true)
    expect(tr.doc.child(2).attrs.level).toBe(2) // the empty last line is left alone
    expect([tr.doc.child(0).attrs.level, tr.doc.child(1).attrs.level]).toEqual([3, 3])
    tr = state.tr
    setBoxLevel(tr, 0)
    expect([0, 1, 2].map((i) => tr.doc.child(i).type.name)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    // A text with no character at all keeps all its lines.
    const empty = docFromText({ text: '\n', headings: [1, 1] })!
    expect(lastBoxLine(empty.doc)).toBe(1)
    expect(boxFormat(empty.doc, 'sans').heading).toBe(1)
  })

  it('a whole-box mark is on unless every character already has it; bold never changes in heading lines', () => {
    const read = docFromText({ text: 'Title\nbody', headings: [1], spans: [{ start: 6, end: 8, italic: true }] })!
    const state = EditorState.create({ doc: read.doc })
    expect(boxFormat(state.doc, 'hand')).toStrictEqual({ marks: { bold: 'mixed', italic: 'mixed', underline: 'off', strike: 'off' }, heading: 'mixed', boldFromHeading: false, font: 'hand' })
    const tr = state.tr
    toggleBoxMark(tr, 'bold')
    expect(tr.doc.child(0).firstChild!.marks).toEqual([])
    expect(boxFormat(tr.doc, 'sans').marks.bold).toBe('on')
  })

  it('font: on a range (no override where it is the box font), or pending at the caret until the caret moves', () => {
    const s = open({ text: 'plain words', font: 'serif' })
    s.select(2, 4)
    s.setFont('mono')
    expect(s.content()).toStrictEqual({ text: 'plain words', font: 'serif', spans: [{ start: 2, end: 4, font: 'mono' }] })
    expect(s.format().font).toBe('mono')
    s.select(0, 4)
    expect(s.format().font).toBe('mixed')
    s.setFont('serif')
    expect(s.content().spans).toBeUndefined()
    s.select(11)
    s.setFont('hand')
    expect(s.format().font).toBe('hand')
    type(s, 'XY')
    expect(s.content().spans).toEqual([{ start: 11, end: 13, font: 'hand' }])
    s.select(0)
    expect(s.format().font).toBe('serif')
  })

  it('a caret font affects typing and Markdown conversion until the caret moves', () => {
    const s = open({ text: 'a ' })
    s.setFont('mono')
    type(s, '**b**x')
    expect(s.content()).toStrictEqual({ text: 'a bx', spans: [{ start: 2, end: 3, bold: true, font: 'mono' }, { start: 3, end: 4, font: 'mono' }] })
  })
})

describe('marks with only a caret (pending)', () => {
  it('apply to what is typed next, without changing the text by themselves', () => {
    const changes: unknown[] = []
    const s = open({ text: 'plain words' }, { caret: 5, hooks: { onChange: (c) => changes.push(c) } })
    s.toggleMark('bold')
    s.toggleMark('italic')
    expect(s.format().marks).toMatchObject({ bold: 'on', italic: 'on' })
    expect(changes).toEqual([])
    type(s, 'XY')
    expect(s.content().spans).toEqual([{ start: 5, end: 7, bold: true, italic: true }])
  })

  it('a pending "off" next to a bold character types plain text', () => {
    const s = open({ text: 'ab', spans: [{ start: 0, end: 2, bold: true }] })
    expect(s.format().marks.bold).toBe('on') // typing here would be bold
    s.toggleMark('bold')
    expect(s.format().marks.bold).toBe('off')
    type(s, 'c')
    expect(s.content().spans).toEqual([{ start: 0, end: 2, bold: true }])
  })

  it('last through typing, Enter, Backspace and an IME composition; dropped when the caret moves', () => {
    const s = open({ text: 'ab' })
    s.toggleMark('underline')
    s.compositionStart()
    insert(s, 'k', true) // composition steps change the text without moving the caret otherwise
    s.dispatch(s.state.tr.delete(s.state.selection.from - 1, s.state.selection.from))
    insert(s, 'カ', true)
    s.compositionEnd()
    expect(s.content().spans).toEqual([{ start: 2, end: 3, underline: true }])
    press(s, 'Enter')
    type(s, 'z')
    // (the line break carries the underline both sides share, so it is one span)
    expect(s.content()).toStrictEqual({ text: 'abカ\nz', spans: [{ start: 2, end: 5, underline: true }] })
    s.select(0)
    expect(s.pending).toBeNull()
    expect(s.format().marks.underline).toBe('off')
  })

  it('a choice that matches what typing would give anyway is dropped', () => {
    const s = open({ text: 'ab', spans: [{ start: 0, end: 2, italic: true }] })
    s.toggleMark('italic')
    expect(s.pending).toStrictEqual({ italic: false })
    s.toggleMark('italic')
    expect(s.pending).toBeNull()
  })

  it('with italic pending, typing `**b**x` gives "b" bold and italic and "x" italic only', () => {
    const s = open()
    s.toggleMark('italic')
    type(s, '**b**x')
    expect(s.content()).toStrictEqual({ text: 'bx', spans: [{ start: 0, end: 1, bold: true, italic: true }, { start: 1, end: 2, italic: true }] })
  })

  it('a caret readout follows the character before it on its line, else the one after it', () => {
    const s = open({ text: 'ab\ncd', spans: [{ start: 1, end: 2, bold: true }, { start: 3, end: 4, italic: true }] })
    s.select(2)
    expect(s.format().marks).toMatchObject({ bold: 'on', italic: 'off' })
    s.select(3)
    expect(s.format().marks).toMatchObject({ bold: 'off', italic: 'on' })
    s.select(0)
    expect(s.format().marks.bold).toBe('off')
  })
})

