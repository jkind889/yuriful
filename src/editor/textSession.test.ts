import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextContent } from '../model/textDoc.ts'
import { createEditSession, sanitizePastedHTML } from './textSession.ts'
import type { EditSession } from './textSession.ts'
import { keyEvent, open, press, type } from './testing/textHarness.ts'

const hosts: HTMLElement[] = []
afterEach(() => {
  hosts.splice(0).forEach((h) => h.remove())
})

describe('creating a session', () => {
  it('reads the record as loading does, with the caret at the end by default or at a given offset', () => {
    const s = open({ text: 'Title\nbody', headings: [1], font: 'serif', spans: [{ start: 0, end: 5, bold: true }] })
    expect(s.content()).toStrictEqual({ text: 'Title\nbody', font: 'serif', headings: [1] })
    expect(s.selection()).toMatchObject({ from: 10, to: 10 })
    expect(open({ text: 'abc' }, { caret: 1 }).selection().head).toBe(1)
  })

  it('every session has its own id', () => {
    expect(open().id).not.toBe(open().id)
  })

  it('a text with rich blocks gets a session; a text that cannot be read gets none', () => {
    const s = createEditSession({ text: '', blocks: [{ type: 'divider' }] })!
    expect(s).not.toBeNull()
    // Only a divider: no line to put a caret in, and leaving changes nothing.
    expect(s.content()).toStrictEqual({ text: '', blocks: [{ type: 'divider' }] })
    expect(createEditSession({ text: 3 } as never)).toBeNull()
  })
})

describe('the one guarded way the text changes', () => {
  it('reports the canonical compact content after every change of the text, and the state after every change', () => {
    const changes: TextContent[] = []
    const selections = vi.fn()
    const s = open({ text: 'go', color: '#FFFFFF' }, { hooks: { onChange: (c) => changes.push(c), onSelectionChange: selections } })
    type(s, ' x')
    expect(changes.at(-1)).toStrictEqual({ text: 'go x', color: '#ffffff' })
    s.select(0, 2)
    expect(changes).toHaveLength(2) // the move changed no text
    s.toggleMark('bold')
    expect(changes.at(-1)).toStrictEqual({ text: 'go x', color: '#ffffff', spans: [{ start: 0, end: 2, bold: true }] })
    expect(changes.every((c) => !('blocks' in c))).toBe(true)
    expect(selections).toHaveBeenCalledTimes(4)
  })

  it('refuses every change once finished, or while the editor says the text may not change', () => {
    let editable = true
    const onChange = vi.fn()
    const s = open({ text: 'go' }, { hooks: { canEdit: () => editable, onChange } })
    editable = false
    type(s, 'x')
    expect(s.toggleMark('bold')).toBe(false)
    expect(s.setHeading(1)).toBe(false)
    expect(s.paste({ text: 'y' })).toBe(false)
    expect(s.undo()).toBe(false)
    expect(s.content().text).toBe('go')
    editable = true
    type(s, 'x')
    expect(s.content().text).toBe('gox')
    s.finish()
    s.finish() // idempotent
    type(s, 'z')
    s.dispatch(s.state.tr.insertText('!'))
    expect(s.content().text).toBe('gox')
    expect(s.finished).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('a session whose board went read-only after a shortcut does not revert on Backspace', () => {
    let editable = true
    const s = open({ text: 'go' }, { hooks: { canEdit: () => editable } })
    type(s, ' *i*')
    editable = false
    press(s, 'Backspace')
    expect(s.content()).toStrictEqual({ text: 'go i', spans: [{ start: 3, end: 4, italic: true }] })
  })
})

describe('in-edit undo and redo', () => {
  it('step through typing, marks, headings and a typing shortcut; canUndo and canRedo follow', () => {
    const s = open({ text: 'one' })
    expect([s.canUndo, s.canRedo]).toEqual([false, false])
    s.setHeading(2)
    s.select(0, 3)
    s.toggleMark('italic')
    s.select(3)
    type(s, ' *x*')
    // (typed next to italic text, the space and the markers are italic too)
    expect(s.content()).toStrictEqual({ text: 'one x', spans: [{ start: 0, end: 5, italic: true }], headings: [2] })
    expect(s.canUndo).toBe(true)
    s.undo()
    expect(s.content().text).toBe('one *x*')
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'one', spans: [{ start: 0, end: 3, italic: true }], headings: [2] })
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'one', headings: [2] })
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'one' })
    expect([s.canUndo, s.canRedo]).toEqual([false, true])
    expect(s.undo()).toBe(false)
    s.redo()
    expect(s.content()).toStrictEqual({ text: 'one', headings: [2] })
  })

  it('Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y are the in-edit undo and redo', () => {
    const s = open({ text: 'a' })
    type(s, 'b')
    press(s, 'z', { ctrlKey: true })
    expect(s.content().text).toBe('a')
    press(s, 'z', { ctrlKey: true, shiftKey: true })
    expect(s.content().text).toBe('ab')
    press(s, 'z', { metaKey: true })
    press(s, 'y', { ctrlKey: true })
    expect(s.content().text).toBe('ab')
  })

  it('drops pending choices', () => {
    const s = open({ text: 'a' })
    type(s, 'b')
    s.toggleMark('bold')
    s.undo()
    expect(s.pending).toBeNull()
  })

  it('whole-box settings changed during the edit are not steps of it', () => {
    const s = open({ text: 'a' })
    type(s, 'b')
    s.setBox({ align: 'center', color: '#2b8a3e' })
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'a', align: 'center', color: '#2b8a3e' })
    expect(s.canUndo).toBe(false)
  })

  it('a new box font drops overrides equal to it, as loading would', () => {
    const s = open({ text: 'abc', spans: [{ start: 0, end: 1, font: 'mono' }, { start: 1, end: 2, font: 'hand' }] })
    s.setBox({ font: 'mono' })
    expect(s.content()).toStrictEqual({ text: 'abc', font: 'mono', spans: [{ start: 1, end: 2, font: 'hand' }] })
  })
})

describe('keys the session claims', () => {
  it('Esc and Tab ask to finish (the session stays open), but not during a composition', () => {
    const wants: string[] = []
    const s = open({ text: 'a' }, { hooks: { onWantsFinish: (r) => wants.push(r) } })
    expect(s.handleKeyDown(keyEvent(s, 'Escape'))).toBe(true)
    expect(s.handleKeyDown(keyEvent(s, 'Tab', { shiftKey: true }))).toBe(true)
    expect(s.handleKeyDown(keyEvent(s, 'Escape', { isComposing: true }))).toBe(false)
    expect(wants).toEqual(['escape', 'tab'])
    expect(s.finished).toBe(false)
  })

  it('Ctrl/Cmd+B, I, U toggle marks; a held key repeats are claimed and toggle nothing; Alt or Shift leave them alone', () => {
    const s = open({ text: 'abc' })
    s.select(0, 3)
    expect(s.handleKeyDown(keyEvent(s, 'b', { ctrlKey: true }))).toBe(true)
    expect(s.handleKeyDown(keyEvent(s, 'b', { ctrlKey: true, repeat: true }))).toBe(true)
    expect(s.handleKeyDown(keyEvent(s, 'i', { metaKey: true }))).toBe(true)
    expect(s.handleKeyDown(keyEvent(s, 'u', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(s.handleKeyDown(keyEvent(s, 'u', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(s.content().spans).toEqual([{ start: 0, end: 3, bold: true, italic: true }])
  })

  it('the editor can take Ctrl/Cmd+B, I, U itself', () => {
    const marks: string[] = []
    const s = open({ text: 'abc' }, { hooks: { onFormatKey: (m) => marks.push(m) } })
    s.select(0, 3)
    s.handleKeyDown(keyEvent(s, 'u', { ctrlKey: true }))
    expect(marks).toEqual(['underline'])
    expect(s.content().spans).toBeUndefined()
  })

  it('keys from anywhere else than the edited text are not claimed and type nothing', () => {
    const s = open({ text: 'go *i' })
    const other = document.createElement('input')
    expect(s.handleKeyDown(keyEvent(s, 'b', { ctrlKey: true, target: other }))).toBe(false)
    expect(s.handleKeyDown(keyEvent(s, 'Escape', { target: other }))).toBe(false)
    s.handleKeyDown(keyEvent(s, '*', { target: other }))
    const { from } = s.state.selection
    expect(s.handleTextInput(from, from, '*')).toBe(false)
  })
})

describe('paste', () => {
  it('literal pasted plain text (Ctrl/Cmd+Shift+V) is one line per line, "\\r\\n" one break; markers and blank lines stay', () => {
    const s = open({ text: 'x' })
    s.paste({ text: '# a\r\n\r\n**b** *c*', plain: true })
    expect(s.content()).toStrictEqual({ text: 'x# a\n\n**b** *c*' })
  })

  it('pasted plain Markdown converts; the first undo gives back the literal lines, the second removes the paste', () => {
    const s = open({ text: 'x' })
    s.paste({ text: '# a\r\n\r\n**b** *c*' })
    expect(s.content()).toStrictEqual({ text: 'x\na\n\nb c', spans: [{ start: 5, end: 6, bold: true }, { start: 7, end: 8, italic: true }], headings: [0, 1] })
    expect(s.selection()).toMatchObject({ anchor: 8, head: 8 })
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'x# a\n\n**b** *c*' })
    s.undo()
    expect(s.content()).toStrictEqual({ text: 'x' })
  })

  it('takes the marks of the text at the paste point, then the pending choices', () => {
    const s = open({ text: 'ab', spans: [{ start: 0, end: 2, bold: true }] })
    s.paste({ text: 'X' })
    expect(s.content().spans).toEqual([{ start: 0, end: 3, bold: true }])
    s.toggleMark('bold')
    s.toggleMark('underline')
    s.paste({ text: 'Y' })
    expect(s.content().spans).toEqual([{ start: 0, end: 3, bold: true }, { start: 3, end: 4, underline: true }])
  })

  it('pasted HTML keeps bold, italic, underline and strikethrough and its headings; never a size or colour, and a font only from `data-font` in what Yuriful copies (its marker)', () => {
    const html = (marker: string) => `<h1 style="font-size:40px"${marker}>Head</h1><p style="color:red"><b>B</b> <i>I</i> <u>U</u> <del>S</del> <span data-font="mono" style="font-family:serif">F</span> <span style="font-family:serif">G</span></p>`
    const spans = [{ start: 5, end: 6, bold: true }, { start: 7, end: 8, italic: true }, { start: 9, end: 10, underline: true }, { start: 11, end: 12, strike: true }]
    const own = open()
    own.paste({ html: html(' data-yuriful=""') })
    expect(own.content()).toStrictEqual({ text: 'Head\nB I U S F G', spans: [...spans, { start: 13, end: 14, font: 'mono' }], headings: [1] })
    const outside = open()
    outside.paste({ html: html('') })
    expect(outside.content()).toStrictEqual({ text: 'Head\nB I U S F G', spans, headings: [1] })
  })

  it('pasted HTML never fires a typing shortcut and takes the pending choices', () => {
    const s = open({ text: 'go *i' })
    s.toggleMark('italic')
    s.paste({ html: '<p>* and **x**</p>' })
    expect(s.content()).toStrictEqual({ text: 'go *i* and **x**', spans: [{ start: 5, end: 16, italic: true }] })
  })

  it('a paste that asked for plain text ignores the HTML', () => {
    const s = open()
    s.paste({ html: '<b>bold</b>', text: 'plain', plain: true })
    expect(s.content()).toStrictEqual({ text: 'plain' })
  })
})

describe('sanitizing pasted HTML (read in an inert document)', () => {
  it('drops scripts, styles, frames, media and forms with what is inside them, and every attribute', () => {
    // In the body (a leading <style> or <script> would be parsed into <head>, which is never read).
    const html = '<p>a</p><style>@import url(https://example.invalid/a.css); p{}</style><script>window.__pasted = 1</script><img src="https://example.invalid/x.png" onerror="window.__pasted = 2"><p onclick="x()" class="c" style="background:url(https://example.invalid/b.png)"><strong>ok</strong> <a href="https://example.invalid">link</a></p><iframe src="https://example.invalid"></iframe><svg><text>s</text></svg><form><input value="v">f</form><video><source src="v.mp4"></video><canvas>c</canvas><object>o</object><noscript>n</noscript>'
    expect(sanitizePastedHTML(html)).toBe('<p>a</p><p><strong>ok</strong> link</p>')
    expect(sanitizePastedHTML('<style>p{}</style><script>1</script><p>b</p>')).toBe('<p>b</p>')
    expect((window as unknown as { __pasted?: number }).__pasted).toBeUndefined()
  })

  it('block elements and <br> are line breaks; whitespace between blocks is not a line', () => {
    expect(sanitizePastedHTML('<div>a<br>b</div>\n  <p>c</p><p><br></p><ul><li>d</li><li>e</li></ul>')).toBe('<p>a</p><p>b</p><p>c</p><p></p><p>d</p><p>e</p>')
  })

  it('reads bold, italic, underline and strikethrough from inline styles, and a non-bold <b> wrapper as not bold', () => {
    expect(sanitizePastedHTML('<b style="font-weight:normal"><span style="font-weight:700">B</span><span style="font-style:italic">I</span><span style="text-decoration:underline line-through">US</span>n</b>')).toBe('<p><strong>B</strong><em>I</em><u><s>US</s></u>n</p>')
  })

  it('escapes text, so markup in pasted text stays text', () => {
    expect(sanitizePastedHTML('<p>&lt;b&gt;x&lt;/b&gt; &amp;</p>')).toBe('<p>&lt;b&gt;x&lt;/b&gt; &amp;</p>')
  })
})

describe('with an EditorView mounted (jsdom)', () => {
  /** jsdom has no ClipboardEvent; ProseMirror only passes the event on to `handlePaste`. */
  const pasteEvent = () => new Event('paste') as ClipboardEvent

  function mounted(source: Parameters<typeof open>[0], hooks: Parameters<typeof open>[1] = {}): { s: EditSession; el: HTMLElement } {
    const el = document.createElement('div')
    el.className = 'scene-text-body yuriful-prose'
    el.setAttribute('data-id', 't1')
    document.body.appendChild(el)
    hosts.push(el)
    const s = open(source, hooks)
    s.mount(el)
    return { s, el }
  }

  it('the element is the editable root and shows the live document; the same schema renders it', () => {
    const { s, el } = mounted({ text: 'Title\n', headings: [1] })
    expect(s.view?.dom).toBe(el)
    expect(el.getAttribute('contenteditable')).toBe('true')
    expect(el.querySelector('h1')?.textContent).toBe('Title')
    expect(el.querySelectorAll('p br').length).toBe(1)
    type(s, 'x')
    expect(el.querySelector('p')?.textContent).toBe('x')
  })

  it('real keydown events reach the session: Esc asks to finish, Ctrl+B toggles, both default-prevented', () => {
    const wants = vi.fn()
    const { s, el } = mounted({ text: 'abc' }, { hooks: { onWantsFinish: wants } })
    s.select(0, 3)
    const ctrlB = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
    el.dispatchEvent(ctrlB)
    expect(ctrlB.defaultPrevented).toBe(true)
    expect(s.content().spans).toEqual([{ start: 0, end: 3, bold: true }])
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    el.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    expect(wants).toHaveBeenCalledWith('escape', s)
  })

  it("ProseMirror's own paste path goes through the session's paste: structure kept, scripts never run, its plain-text paste literal with the pending choices", () => {
    const { s } = mounted({ text: 'go *i' })
    s.view!.pasteHTML('<h2>Head</h2><script>window.__pm = 1</script><p><i>x</i>*</p>', pasteEvent())
    // A heading pasted at the end of a line: the line stays as it was, the heading follows, then the last paragraph.
    expect(s.content()).toStrictEqual({ text: 'go *i\nHead\nx*', spans: [{ start: 11, end: 12, italic: true }], headings: [0, 2] })
    expect((window as unknown as { __pm?: number }).__pm).toBeUndefined()
    s.toggleMark('underline')
    // ProseMirror's `pasteText` is a literal paste (it passes `plain`, as Ctrl/Cmd+Shift+V does): no conversion.
    s.view!.pasteText('# a\n\nb', pasteEvent())
    expect(s.content().text).toBe('go *i\nHead\nx*# a\n\nb')
    expect(s.content().spans).toContainEqual({ start: 13, end: 19, underline: true })
  })

  it('focus leaving the text (a panel field, the window) never ends the edit or asks to', () => {
    const wants = vi.fn()
    const { s, el } = mounted({ text: 'a' }, { hooks: { onWantsFinish: wants } })
    el.dispatchEvent(new FocusEvent('blur'))
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    window.dispatchEvent(new FocusEvent('blur'))
    expect(wants).not.toHaveBeenCalled()
    expect(s.finished).toBe(false)
    type(s, 'b')
    expect(s.content().text).toBe('ab')
  })

  it('finishing destroys the view, gives the element back its own attributes and leaves the static HTML of the final text', () => {
    const { s, el } = mounted({ text: 'one' })
    type(s, '\n')
    s.setHeading(2)
    el.classList.add('ProseMirror-focused')
    s.finish()
    expect(s.view).toBeNull()
    expect(el.getAttribute('class')).toBe('scene-text-body yuriful-prose')
    expect(el.getAttribute('data-id')).toBe('t1')
    expect(el.hasAttribute('contenteditable')).toBe(false)
    expect(el.innerHTML).toBe('<p>one</p><h2><br></h2>')
    expect(() => s.mount(el)).toThrow()
  })
})
