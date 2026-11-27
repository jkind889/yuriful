import { useEffect } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Editor } from '../editor/Editor.ts'
import type { SaveState } from '../model/types.ts'
import { AppearanceMenu } from './AppearanceMenu.tsx'
import { useEditorState } from './useEditorState.ts'

interface StatusView {
  label: string
  tone: 'ok' | 'pending' | 'bad' | 'idle'
  detail?: string
}

export function describeSave(s: SaveState): StatusView {
  switch (s.kind) {
    case 'loading':
      return { label: 'Loading…', tone: 'idle' }
    case 'new':
      return { label: 'Not saved yet', tone: 'idle', detail: 'Nothing on this board yet. Changes save automatically on this device.' }
    case 'dirty':
      return { label: 'Unsaved changes', tone: 'pending' }
    case 'saving':
      return { label: 'Saving…', tone: 'pending' }
    case 'saved':
      return { label: 'Saved on this device', tone: 'ok' }
    case 'error':
      return { label: 'Couldn’t save', tone: 'bad', detail: s.message }
    case 'unavailable':
      return { label: 'Not saving', tone: 'bad', detail: s.message }
  }
}

export function Header({ editor }: { editor: Editor | null }) {
  const state = useEditorState(editor)
  const title = state?.title ?? ''

  useEffect(() => {
    document.title = title ? `${title} · yuriful` : 'yuriful'
  }, [title])

  const commitTitle = (input: HTMLInputElement) => {
    if (!editor) return
    input.value = editor.setTitle(input.value)
  }
  const onTitleKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      e.currentTarget.value = title
      e.currentTarget.blur()
    }
  }

  const status = state ? describeSave(state.save) : describeSave({ kind: 'loading' })

  return (
    <header className="header">
      <div className="wordmark">yuriful</div>
      <input
        key={title}
        className="title-input"
        aria-label="Board title"
        defaultValue={title}
        placeholder="Untitled board"
        maxLength={120}
        spellCheck={false}
        disabled={!state?.ready || state.readOnly !== null}
        onBlur={(e) => commitTitle(e.currentTarget)}
        onKeyDown={onTitleKey}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="save-area">
        {editor && state?.ready && <AppearanceMenu editor={editor} appearance={state.appearance} disabled={state.readOnly !== null} />}
        <div className={`save-status tone-${status.tone}`} role="status" aria-live="polite" title={status.detail}>
          <span className="save-dot" aria-hidden="true" />
          <span>{status.label}</span>
        </div>
        {state?.save.kind === 'error' && (
          <button type="button" className="text-btn" onClick={() => editor?.retrySave()}>
            Retry
          </button>
        )}
      </div>
    </header>
  )
}
