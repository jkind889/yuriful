import type { Editor } from '../Editor.ts'
import type { DomTextAdapter } from '../textAdapter.ts'
import type { EditSession } from '../textSession.ts'
import { insert, press, type } from './textHarness.ts'

/**
 * Driving a text edit in the editor unit tests: the editor's text adapter and the edit session of
 * the text being edited (its real ProseMirror state and view; jsdom lays nothing out, so text
 * arrives through the session rather than through the browser's own input). Call
 * `stubTextLayout` (`fakes.ts`) in the test's `beforeEach` first.
 */

/** The editor's text adapter. */
export const textAdapterOf = (editor: Editor): DomTextAdapter => (editor as unknown as { text: DomTextAdapter }).text

/** The text being edited, or null. */
export const editedObject = (editor: Editor): unknown => textAdapterOf(editor).editedTarget()

/** Starts editing a text object (with the caret at its end when asked), as a double-click or Enter does. */
export function startEditing(editor: Editor, obj: unknown, at?: 'end') {
  textAdapterOf(editor).startEditing(obj as never, at)
}

/** The edit session of the text being edited. */
export function editSession(editor: Editor): EditSession {
  const s = textAdapterOf(editor).editSession()
  if (!s) throw new Error('no text is being edited')
  return s
}

/**
 * Text that arrives at the selection without keys, as the view's input hands it to the session
 * (marks chosen at the caret apply; no typing shortcut fires); "\n" is Enter.
 */
export function insertText(editor: Editor, text: string) {
  const s = editSession(editor)
  text.split('\n').forEach((part, i) => {
    if (i > 0) press(s, 'Enter')
    if (part) insert(s, part)
  })
}

/** Characters typed one by one as keys at the selection ("\n" is Enter): typing shortcuts fire as they do for a person typing. */
export function typeKeys(editor: Editor, text: string) {
  type(editSession(editor), text)
}

/** A key pressed in the edited text (Backspace, Enter, ...). True when the session or an editing key claimed it. */
export function pressKey(editor: Editor, key: string) {
  return press(editSession(editor), key)
}

/** Replaces the whole edited text with \`text\` (selected, then the new text arriving over it). */
export function replaceText(editor: Editor, text: string) {
  const s = editSession(editor)
  s.select(0, s.content().text.length)
  if (!text) s.dispatch(s.state.tr.deleteSelection())
  else insertText(editor, text)
}

/** Puts the selection (UTF-16 offsets of the text) in the edited text. */
export function selectText(editor: Editor, anchor: number, head = anchor) {
  editSession(editor).select(anchor, head)
}

/** Whether board history has a step to undo (while a text is edited, the Undo button steps the edit's own history instead). */
export const boardCanUndo = (editor: Editor): boolean => (editor as unknown as { history: { canUndo: boolean } }).history.canUndo
