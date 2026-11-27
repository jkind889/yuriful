import { useSyncExternalStore } from 'react'
import type { Editor, EditorState } from '../editor/Editor.ts'

const noopSubscribe = () => () => {}
const nullState = () => null

/** Subscribes a component to the editor's state snapshots (null until mounted). */
export function useEditorState(editor: Editor | null): EditorState | null {
  return useSyncExternalStore<EditorState | null>(editor ? editor.subscribe : noopSubscribe, editor ? editor.getState : nullState)
}
