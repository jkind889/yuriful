import { afterEach, describe, expect, it } from 'vitest'
import { isEditableTarget, isPanHoldKey, resolveEditingShortcut, resolveShortcut, typedCharacter } from './shortcuts.ts'
import type { KeyEventLike } from './shortcuts.ts'

const idle = { editingText: false }

function key(k: string, init: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: k,
    code: init.code ?? (k.length === 1 ? `Key${k.toUpperCase()}` : k),
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    target: document.body,
    ...init,
  }
}

const made: HTMLElement[] = []
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  document.body.appendChild(e)
  made.push(e)
  return e
}
afterEach(() => made.splice(0).forEach((e) => e.remove()))

describe('resolveShortcut: actions', () => {
  it('maps tool and add keys', () => {
    expect(resolveShortcut(key('v'), idle)).toBe('tool-select')
    expect(resolveShortcut(key('h'), idle)).toBe('tool-hand')
    expect(resolveShortcut(key('t'), idle)).toBe('tool-text')
    expect(resolveShortcut(key('i'), idle)).toBe('add-image')
    expect(resolveShortcut(key('f'), idle)).toBe('tool-frame')
    expect(resolveShortcut(key('F'), idle)).toBe('tool-frame') // Caps Lock
    expect(resolveShortcut(key('F', { shiftKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('f', { ctrlKey: true }), idle)).toBeNull() // the browser's Find stays the browser's
    expect(resolveShortcut(key('f', { altKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('f'), { editingText: true })).toBeNull()
    expect(resolveShortcut(key('V', { shiftKey: true }), idle)).toBeNull() // Shift+V is not select
  })

  it('maps undo/redo for both Ctrl and Cmd, and both redo spellings', () => {
    expect(resolveShortcut(key('z', { ctrlKey: true }), idle)).toBe('undo')
    expect(resolveShortcut(key('z', { metaKey: true }), idle)).toBe('undo')
    expect(resolveShortcut(key('Z', { ctrlKey: true, shiftKey: true }), idle)).toBe('redo')
    expect(resolveShortcut(key('z', { metaKey: true, shiftKey: true }), idle)).toBe('redo')
    expect(resolveShortcut(key('y', { ctrlKey: true }), idle)).toBe('redo')
  })

  it('maps delete, escape and select all', () => {
    expect(resolveShortcut(key('Delete'), idle)).toBe('delete')
    expect(resolveShortcut(key('Backspace'), idle)).toBe('delete')
    expect(resolveShortcut(key('Escape'), idle)).toBe('escape')
    expect(resolveShortcut(key('Escape', { altKey: true }), idle)).toBe('escape') // cancels an Alt-drag
    expect(resolveShortcut(key('Escape', { ctrlKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('a', { ctrlKey: true }), idle)).toBe('select-all')
  })

  it('maps zoom and layer keys', () => {
    expect(resolveShortcut(key('='), idle)).toBe('zoom-in')
    expect(resolveShortcut(key('+', { shiftKey: true }), idle)).toBe('zoom-in')
    expect(resolveShortcut(key('-'), idle)).toBe('zoom-out')
    expect(resolveShortcut(key('0'), idle)).toBe('zoom-reset')
    expect(resolveShortcut(key('!', { shiftKey: true, code: 'Digit1' }), idle)).toBe('zoom-fit')
    expect(resolveShortcut(key(']'), idle)).toBe('layer-forward')
    expect(resolveShortcut(key('['), idle)).toBe('layer-backward')
    expect(resolveShortcut(key(']', { ctrlKey: true }), idle)).toBe('layer-front')
    expect(resolveShortcut(key('[', { metaKey: true }), idle)).toBe('layer-back')
  })

  it('leaves browser and OS combinations alone', () => {
    expect(resolveShortcut(key('t', { ctrlKey: true }), idle)).toBeNull() // new tab
    expect(resolveShortcut(key('r', { ctrlKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('z', { ctrlKey: true, altKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('h', { altKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('F5'), idle)).toBeNull()
    expect(resolveShortcut(key('Tab'), idle)).toBeNull()
    expect(resolveShortcut(key('Enter'), idle)).toBeNull()
  })
})

describe('resolveShortcut: never interferes with typing', () => {
  it.each([
    ['text input', () => el('input', { type: 'text' })],
    ['search input', () => el('input', { type: 'search' })],
    ['number input', () => el('input', { type: 'number' })],
    ['input with no type', () => el('input')],
    ['textarea (Fabric hidden textarea)', () => el('textarea')],
    ['select', () => el('select')],
  ])('ignores everything while focus is in a %s', (_name, make) => {
    const target = make()
    for (const k of ['v', 'h', 't', 'i', 'Delete', 'Backspace', '0', '-', '=', '[', ']', 'Escape']) {
      expect(resolveShortcut(key(k, { target }), idle), k).toBeNull()
    }
    expect(resolveShortcut(key('z', { target, ctrlKey: true }), idle)).toBeNull() // native undo in the field
    expect(resolveShortcut(key('a', { target, ctrlKey: true }), idle)).toBeNull() // native select-all in the field
  })

  it('ignores contenteditable targets', () => {
    const target = el('div')
    Object.defineProperty(target, 'isContentEditable', { value: true })
    expect(resolveShortcut(key('v', { target }), idle)).toBeNull()
  })

  it('ignores everything while a canvas text object is being edited', () => {
    const ctx = { editingText: true }
    expect(resolveShortcut(key('v'), ctx)).toBeNull()
    expect(resolveShortcut(key('Backspace'), ctx)).toBeNull()
    expect(resolveShortcut(key('z', { ctrlKey: true }), ctx)).toBeNull()
  })

  it('ignores keys during IME composition', () => {
    expect(resolveShortcut(key('v', { isComposing: true }), idle)).toBeNull()
  })

  it('still handles shortcuts when a button or the canvas has focus', () => {
    expect(resolveShortcut(key('v', { target: el('button') }), idle)).toBe('tool-select')
    expect(resolveShortcut(key('Delete', { target: el('canvas') }), idle)).toBe('delete')
    expect(resolveShortcut(key('v', { target: el('input', { type: 'checkbox' }) }), idle)).toBe('tool-select')
  })

  it('handles a null or non-element target without throwing', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(window as unknown as EventTarget)).toBe(false)
    expect(resolveShortcut(key('v', { target: null }), idle)).toBe('tool-select')
  })
})

describe('formatting keys', () => {
  const text = { editingText: false, textSelected: true }
  const all = ['b', 'i', 'u'] as const

  it('Ctrl/Cmd+B, I, U format a selected text (not being edited) as a whole', () => {
    expect(resolveShortcut(key('b', { ctrlKey: true }), text)).toBe('format-bold')
    expect(resolveShortcut(key('i', { metaKey: true }), text)).toBe('format-italic')
    expect(resolveShortcut(key('U', { ctrlKey: true }), text)).toBe('format-underline') // Caps Lock
    expect(resolveShortcut(key('b', { ctrlKey: true, target: el('button') }), text)).toBe('format-bold') // a panel button has keyboard focus
  })

  it('are left to the browser without exactly one selected text, with Alt or Shift, while typing in a field or editing, and during composition', () => {
    for (const k of all) {
      expect(resolveShortcut(key(k, { ctrlKey: true }), idle)).toBeNull() // nothing, an image, a frame or several objects
      expect(resolveShortcut(key(k, { ctrlKey: true }), { editingText: false, textSelected: false })).toBeNull()
      expect(resolveShortcut(key(k, { ctrlKey: true, altKey: true }), text)).toBeNull()
      expect(resolveShortcut(key(k, { ctrlKey: true, shiftKey: true }), text)).toBeNull()
      expect(resolveShortcut(key(k, { ctrlKey: true, target: el('input', { type: 'text' }) }), text)).toBeNull()
      expect(resolveShortcut(key(k, { ctrlKey: true }), { editingText: true, textSelected: false })).toBeNull()
      expect(resolveShortcut(key(k, { ctrlKey: true, isComposing: true }), text)).toBeNull()
    }
    expect(resolveShortcut(key('b'), text)).toBeNull() // a plain letter is not a shortcut
  })

  it('a held key repeating is claimed but does nothing (so holding it does not toggle again, and the browser does not act on it)', () => {
    for (const k of all) {
      expect(resolveShortcut(key(k, { ctrlKey: true, repeat: true }), text)).toBe('ignore')
      expect(resolveShortcut(key(k, { ctrlKey: true, repeat: false }), text)).toBe(`format-${k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline'}`)
      // claimed only where the first press is
      expect(resolveShortcut(key(k, { ctrlKey: true, repeat: true }), idle)).toBeNull()
      expect(resolveShortcut(key(k, { ctrlKey: true, shiftKey: true, repeat: true }), text)).toBeNull()
    }
    expect(resolveShortcut(key('z', { ctrlKey: true, repeat: true }), text)).toBe('undo') // other keys repeat as before
  })

  it('leave every other shortcut as it was when a text is selected', () => {
    expect(resolveShortcut(key('i'), text)).toBe('add-image')
    expect(resolveShortcut(key('z', { ctrlKey: true }), text)).toBe('undo')
    expect(resolveShortcut(key('a', { ctrlKey: true }), text)).toBe('select-all')
    expect(resolveShortcut(key(']', { ctrlKey: true }), text)).toBe('layer-front')
    expect(resolveShortcut(key('Escape'), text)).toBe('escape')
    expect(resolveShortcut(key('Escape', { altKey: true }), text)).toBe('escape') // unchanged here; Alt+Esc is the other branch's
    expect(resolveShortcut(key('Delete'), text)).toBe('delete')
  })
})

describe('resolveEditingShortcut: keys pressed while a text is being edited', () => {
  const area = () => el('textarea')

  it('claims Ctrl/Cmd+B, I, U only when they come from the edited text', () => {
    const ta = area()
    const ctx = { editedTextarea: ta }
    expect(resolveEditingShortcut(key('b', { ctrlKey: true, target: ta }), ctx)).toBe('bold')
    expect(resolveEditingShortcut(key('I', { metaKey: true, target: ta }), ctx)).toBe('italic')
    expect(resolveEditingShortcut(key('u', { ctrlKey: true, target: ta }), ctx)).toBe('underline')
    expect(resolveEditingShortcut(key('b', { ctrlKey: true, target: area() }), ctx)).toBeNull() // another textarea
    expect(resolveEditingShortcut(key('b', { ctrlKey: true, target: document.body }), ctx)).toBeNull()
    expect(resolveEditingShortcut(key('b', { ctrlKey: true, target: ta }), { editedTextarea: null })).toBeNull() // no text is edited
  })

  it('never with Alt or Shift, never during composition, and never any other key', () => {
    const ta = area()
    const ctx = { editedTextarea: ta }
    for (const k of ['b', 'i', 'u']) {
      expect(resolveEditingShortcut(key(k, { ctrlKey: true, altKey: true, target: ta }), ctx)).toBeNull()
      expect(resolveEditingShortcut(key(k, { ctrlKey: true, shiftKey: true, target: ta }), ctx)).toBeNull()
      expect(resolveEditingShortcut(key(k, { ctrlKey: true, isComposing: true, target: ta }), ctx)).toBeNull()
      expect(resolveEditingShortcut(key(k, { target: ta }), ctx)).toBeNull() // typing the letter
    }
    for (const k of ['a', 'c', 'v', 'x', 'z', 'y', 'Escape', 'Tab', 'ArrowLeft', 'Backspace', 'Enter']) {
      expect(resolveEditingShortcut(key(k, { ctrlKey: true, target: ta }), ctx)).toBeNull()
      expect(resolveEditingShortcut(key(k, { target: ta }), ctx)).toBeNull()
    }
    expect(resolveEditingShortcut(key('Escape', { altKey: true, target: ta }), ctx)).toBeNull()
    expect(resolveEditingShortcut(key('Escape', { target: ta }), { editedTextarea: ta, canRevertShortcut: true })).toBeNull()
    // And no canvas shortcut fires while a text is edited.
    expect(resolveShortcut(key('b', { ctrlKey: true, target: ta }), { editingText: true, textSelected: false })).toBeNull()
  })
})

describe('isPanHoldKey', () => {
  const space = (init: Partial<KeyEventLike> = {}) => key(' ', { code: 'Space', ...init })

  it('accepts Space on the page', () => {
    expect(isPanHoldKey(space(), idle)).toBe(true)
  })

  it('does not take Space from fields, buttons, or text editing', () => {
    expect(isPanHoldKey(space({ target: el('input', { type: 'text' }) }), idle)).toBe(false)
    expect(isPanHoldKey(space({ target: el('textarea') }), idle)).toBe(false)
    expect(isPanHoldKey(space({ target: el('button') }), idle)).toBe(false)
    expect(isPanHoldKey(space(), { editingText: true })).toBe(false)
  })

  it('ignores modified Space and other keys', () => {
    expect(isPanHoldKey(space({ ctrlKey: true }), idle)).toBe(false)
    expect(isPanHoldKey(key('a'), idle)).toBe(false)
  })
})

describe('resolveShortcut: lock', () => {
  it('Ctrl/Cmd+Shift+L toggles the lock; L alone, Ctrl+L and Ctrl+Alt+Shift+L do not', () => {
    expect(resolveShortcut(key('L', { ctrlKey: true, shiftKey: true }), idle)).toBe('toggle-lock')
    expect(resolveShortcut(key('L', { metaKey: true, shiftKey: true }), idle)).toBe('toggle-lock')
    expect(resolveShortcut(key('l', { ctrlKey: true, shiftKey: true }), idle)).toBe('toggle-lock') // Caps Lock
    expect(resolveShortcut(key('l', { ctrlKey: true }), idle)).toBeNull() // the browser's address bar stays the browser's
    expect(resolveShortcut(key('L', { shiftKey: true }), idle)).toBeNull()
    expect(resolveShortcut(key('l'), idle)).toBeNull()
    expect(resolveShortcut(key('L', { ctrlKey: true, shiftKey: true, altKey: true }), idle)).toBeNull()
  })

  it('never fires while typing in a field or editing text', () => {
    expect(resolveShortcut(key('L', { ctrlKey: true, shiftKey: true }), { editingText: true })).toBeNull()
    expect(resolveShortcut(key('L', { ctrlKey: true, shiftKey: true, target: el('input') }), idle)).toBeNull()
  })
})


describe('resolveEditingShortcut: a held key, and Backspace after a typing shortcut', () => {
  const area = () => el('textarea')

  it('a held Ctrl/Cmd+B, I, U repeating is claimed but toggles nothing', () => {
    const ta = area()
    const ctx = { editedTextarea: ta }
    for (const k of ['b', 'i', 'u']) {
      expect(resolveEditingShortcut(key(k, { ctrlKey: true, repeat: true, target: ta }), ctx)).toBe('ignore')
      expect(resolveEditingShortcut(key(k, { ctrlKey: true, altKey: true, repeat: true, target: ta }), ctx)).toBeNull()
      expect(resolveEditingShortcut(key(k, { ctrlKey: true, repeat: true, target: document.body }), ctx)).toBeNull()
    }
  })

  it('Backspace is claimed only straight after a shortcut fired, only from the edited text, with no modifier and not during composition', () => {
    const ta = area()
    const can = { editedTextarea: ta, canRevertShortcut: true }
    expect(resolveEditingShortcut(key('Backspace', { target: ta }), can)).toBe('revert-shortcut')
    expect(resolveEditingShortcut(key('Backspace', { target: ta }), { editedTextarea: ta })).toBeNull()
    expect(resolveEditingShortcut(key('Backspace', { target: ta }), { editedTextarea: ta, canRevertShortcut: false })).toBeNull()
    expect(resolveEditingShortcut(key('Backspace', { target: area() }), can)).toBeNull()
    expect(resolveEditingShortcut(key('Backspace', { target: document.body }), can)).toBeNull()
    expect(resolveEditingShortcut(key('Backspace', { target: ta }), { editedTextarea: null, canRevertShortcut: true })).toBeNull()
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) expect(resolveEditingShortcut(key('Backspace', { [mod]: true, target: ta }), can)).toBeNull()
    expect(resolveEditingShortcut(key('Backspace', { isComposing: true, target: ta }), can)).toBeNull()
    for (const k of ['Delete', 'ArrowLeft', 'a', '*', ' ', 'Escape', 'Tab', 'Enter']) expect(resolveEditingShortcut(key(k, { target: ta }), can)).toBeNull()
    // and the canvas never sees it as "delete" while a text is edited
    expect(resolveShortcut(key('Backspace', { target: ta }), { editingText: true })).toBeNull()
  })
})

describe('typedCharacter: what a key types that can complete a typing shortcut', () => {
  it('a space or a star typed into the edited text, AltGr included; nothing else', () => {
    const ta = el('textarea')
    const ctx = { editedTextarea: ta }
    expect(typedCharacter(key(' ', { code: 'Space', target: ta }), ctx)).toBe(' ')
    expect(typedCharacter(key('*', { code: 'Digit8', shiftKey: true, target: ta }), ctx)).toBe('*')
    expect(typedCharacter(key('*', { code: 'NumpadMultiply', target: ta }), ctx)).toBe('*')
    expect(typedCharacter(key('*', { ctrlKey: true, altKey: true, target: ta }), ctx)).toBe('*') // AltGr
    expect(typedCharacter(key('*', { ctrlKey: true, target: ta }), ctx)).toBeNull()
    expect(typedCharacter(key(' ', { metaKey: true, target: ta }), ctx)).toBeNull()
    expect(typedCharacter(key('*', { isComposing: true, target: ta }), ctx)).toBeNull()
    expect(typedCharacter(key('Process', { target: ta }), ctx)).toBeNull() // a key the IME takes
    expect(typedCharacter(key('#', { target: ta }), ctx)).toBeNull() // only the last character of a marker counts
    expect(typedCharacter(key('a', { target: ta }), ctx)).toBeNull()
    expect(typedCharacter(key('*', { target: el('textarea') }), ctx)).toBeNull()
    expect(typedCharacter(key('*', { target: ta }), { editedTextarea: null })).toBeNull()
  })
})
