import type { KeyEventLike } from '../../input/shortcuts.ts'
import { editKeys } from '../textRules.ts'
import { createEditSession } from '../textSession.ts'
import type { EditSession, EditSessionHooks } from '../textSession.ts'
import type { TextSource } from '../textSchema.ts'

/**
 * Drives an `EditSession` without a view the way a mounted `EditorView` does: a keydown goes
 * to the session first, and when it does not claim it, to the editing keys; a typed
 * character goes through `handleTextInput` and, when that does not handle it, is inserted as
 * ProseMirror's default does (`state.tr.insertText`, which uses the stored marks).
 */

export function open(source: Partial<TextSource> = {}, opts: { caret?: number; hooks?: EditSessionHooks } = {}): EditSession {
  const s = createEditSession({ text: '', ...source }, opts.hooks, { caret: opts.caret })
  if (!s) throw new Error('not editable in the Milestone-2 schema')
  return s
}

export function keyEvent(s: EditSession, key: string, init: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, repeat: false, target: s.root, ...init }
}

/** The keymap name of a key event (as `prosemirror-keymap` would match it). */
function bindingOf(e: KeyEventLike): string {
  const mods = `${e.shiftKey ? 'Shift-' : ''}${e.ctrlKey || e.metaKey ? 'Mod-' : ''}`
  return `${mods}${e.key.length === 1 ? e.key.toLowerCase() : e.key}`
}

/** A key pressed and released. Returns true when the session or an editing key claimed it. */
export function press(s: EditSession, key: string, init: Partial<KeyEventLike> = {}): boolean {
  const e = keyEvent(s, key, init)
  let claimed = s.handleKeyDown(e)
  if (!claimed) {
    const cmd = editKeys[bindingOf(e)]
    claimed = cmd ? s.run(cmd) : false
  }
  s.handleKeyUp()
  return claimed
}

/** Types characters one by one, as keys: "\n" is Enter. */
export function type(s: EditSession, text: string, init: Partial<KeyEventLike> = {}) {
  for (const ch of Array.from(text)) {
    if (ch === '\n') {
      press(s, 'Enter', init)
      continue
    }
    const e = keyEvent(s, ch, init)
    if (!s.handleKeyDown(e)) insert(s, ch, init.isComposing === true)
    s.handleKeyUp()
  }
}

/** Text arriving without a key typing it (an emoji panel, a composition's commit...). */
export function insert(s: EditSession, text: string, composing = false) {
  const { from, to } = s.state.selection
  if (!s.handleTextInput(from, to, text, composing)) s.dispatch(s.state.tr.insertText(text, from, to))
}
