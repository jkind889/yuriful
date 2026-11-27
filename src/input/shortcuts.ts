export type ShortcutAction =
  | 'undo'
  | 'redo'
  | 'delete'
  | 'select-all'
  | 'duplicate'
  | 'tool-select'
  | 'tool-hand'
  | 'tool-text'
  | 'tool-frame'
  | 'add-image'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-fit'
  | 'zoom-reset'
  | 'layer-forward'
  | 'layer-backward'
  | 'layer-front'
  | 'layer-back'
  | 'toggle-lock'
  | 'escape'
  | 'format-bold'
  | 'format-italic'
  | 'format-underline'
  /** Claimed so that the browser's own action does not happen, and does nothing (a held formatting key repeating). */
  | 'ignore'

export interface ShortcutContext {
  /** A Fabric text object is in edit mode. */
  editingText: boolean
  /** Exactly one text is selected (and not being edited): Ctrl/Cmd+B, I and U format it as a whole. */
  textSelected?: boolean
  hasSelection?: boolean
}

export type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'target' | 'isComposing'
> & { repeat?: boolean }

/** Inputs, textareas (incl. Fabric's hidden one), selects and contenteditable. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    // Buttons/checkboxes are inputs but do not take typed text.
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(type)
  }
  return el.isContentEditable === true
}

/** Elements that use Space/Enter for themselves. */
export function isActivatableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return ['BUTTON', 'A', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role') === 'button'
}

/**
 * Maps a key event to an editor action, or null if the page should keep it.
 * Never claims keys while the user is typing into a field or editing text.
 */
export function resolveShortcut(e: KeyEventLike, ctx: ShortcutContext): ShortcutAction | null {
  if (e.isComposing || ctx.editingText || isEditableTarget(e.target)) return null

  const mod = e.ctrlKey || e.metaKey
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key

  if (mod) {
    if (e.altKey) return null
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (key === 'y' && !e.shiftKey) return 'redo'
    if (key === 'a' && !e.shiftKey) return 'select-all'
    if (key === 'd' && !e.shiftKey && ctx.hasSelection) return 'duplicate'
    if (key === 'l' && e.shiftKey) return 'toggle-lock'
    if (key === ']') return 'layer-front'
    if (key === '[') return 'layer-back'
    // Only for a selected text; with anything else the key stays the browser's. A held key's
    // auto-repeat is claimed but toggles nothing, so the result does not depend on how long the
    // key was held, and the browser's own action (Ctrl+U: view source) never leaks through.
    if (ctx.textSelected && !e.shiftKey) {
      if (key === 'b') return e.repeat ? 'ignore' : 'format-bold'
      if (key === 'i') return e.repeat ? 'ignore' : 'format-italic'
      if (key === 'u') return e.repeat ? 'ignore' : 'format-underline'
    }
    return null
  }
  // Esc also counts with Alt held: Alt-drag moves a covered selected object, and Esc must cancel it.
  if (key === 'Escape') return 'escape'
  if (e.altKey) return null

  switch (key) {
    case 'Delete':
    case 'Backspace':
      return 'delete'
    case ']':
      return 'layer-forward'
    case '[':
      return 'layer-backward'
    case '+':
    case '=':
      return 'zoom-in'
    case '-':
    case '_':
      return 'zoom-out'
    case '0':
      return 'zoom-reset'
  }
  if (e.shiftKey && e.code === 'Digit1') return 'zoom-fit'
  if (e.shiftKey) return null
  switch (key) {
    case 'v':
      return 'tool-select'
    case 'h':
      return 'tool-hand'
    case 't':
      return 'tool-text'
    case 'f':
      return 'tool-frame'
    case 'i':
      return 'add-image'
  }
  return null
}

/**
 * What a key pressed while a text is being edited does: toggle a mark, put back the literal
 * characters of the typing shortcut that just fired, or nothing at all (`ignore`: a held
 * formatting key repeating, claimed only to keep the browser's own action from happening).
 */
export type EditingShortcut = 'bold' | 'italic' | 'underline' | 'revert-shortcut' | 'ignore'

export interface EditingContext {
  /** The hidden textarea of the text being edited (where its keys arrive), or null when no text is being edited. */
  editedTextarea: EventTarget | null
  /** A typing shortcut has just fired in the text being edited, and nothing has happened since: Backspace puts its characters back. */
  canRevertShortcut?: boolean
}

/**
 * Keys pressed while a text is being edited. Claims only Ctrl/Cmd+B, I and U, and Backspace
 * straight after a typing shortcut fired, and only when they come from the text being edited:
 * never with Alt held (nor Shift, nor any modifier for Backspace), never during IME
 * composition. Everything else (typing, Backspace at any other time, selection and clipboard
 * keys, Ctrl/Cmd+A, Esc and Tab to leave the edit) stays Fabric's and the browser's.
 * `resolveShortcut` keeps returning null while a text is edited, so no canvas shortcut fires.
 */
export function resolveEditingShortcut(e: KeyEventLike, ctx: EditingContext): EditingShortcut | null {
  if (ctx.editedTextarea === null || e.target !== ctx.editedTextarea || e.isComposing) return null
  if (e.key === 'Backspace') {
    if (!ctx.canRevertShortcut || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null
    return 'revert-shortcut'
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  // A held key repeating is claimed but toggles nothing (see `resolveShortcut`).
  if (key === 'b') return e.repeat ? 'ignore' : 'bold'
  if (key === 'i') return e.repeat ? 'ignore' : 'italic'
  if (key === 'u') return e.repeat ? 'ignore' : 'underline'
  return null
}

/**
 * The character a key is about to type into the text being edited, when it is one that can
 * complete a typing shortcut (a space or a `*`); otherwise null. Only observed, never claimed:
 * the editor fires a shortcut only for a character that a key typed, so that pasted, dropped
 * and composed text stays as it is. Not during IME composition, and not with Ctrl/Cmd held
 * unless Alt is held too (AltGr, which some layouts need for these characters, is reported as
 * Ctrl+Alt on Windows).
 */
export function typedCharacter(e: KeyEventLike, ctx: EditingContext): string | null {
  if (ctx.editedTextarea === null || e.target !== ctx.editedTextarea || e.isComposing) return null
  if ((e.ctrlKey || e.metaKey) && !e.altKey) return null
  return e.key === ' ' || e.key === '*' ? e.key : null
}

/** Space held (outside fields/buttons) temporarily switches to the hand tool. */
export function isPanHoldKey(e: KeyEventLike, ctx: ShortcutContext): boolean {
  return (
    e.code === 'Space' &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.isComposing &&
    !ctx.editingText &&
    !isEditableTarget(e.target) &&
    !isActivatableTarget(e.target)
  )
}

/**
 * Plain Enter (outside fields and buttons, which use Enter themselves): applies an open crop.
 * Enter in the title field, or on a focused Cancel button, is not this key.
 */
export function isConfirmKey(e: KeyEventLike, ctx: ShortcutContext): boolean {
  return (
    e.key === 'Enter' &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    !e.isComposing &&
    !ctx.editingText &&
    !isEditableTarget(e.target) &&
    !isActivatableTarget(e.target)
  )
}
