import type { Editor, EditorState } from '../editor/Editor.ts'
import { MAX_ZOOM, MIN_ZOOM } from '../model/doc.ts'
import { IconButton } from './IconButton.tsx'
import { FitIcon, MinusIcon, PlusIcon, RedoIcon, UndoIcon } from './icons.tsx'

export function HistoryControls({ editor, state }: { editor: Editor; state: EditorState }) {
  const locked = state.readOnly !== null // a read-only board cannot be changed, by undo either
  return (
    <div className="floating controls controls-left" role="group" aria-label="History">
      <IconButton label="Undo" shortcut="Ctrl+Z" keys="Control+Z Meta+Z" disabled={locked || !state.canUndo} onClick={() => editor.undo()}>
        <UndoIcon />
      </IconButton>
      <IconButton label="Redo" shortcut="Ctrl+Shift+Z" keys="Control+Shift+Z Meta+Shift+Z Control+Y" disabled={locked || !state.canRedo} onClick={() => editor.redo()}>
        <RedoIcon />
      </IconButton>
    </div>
  )
}

export function ZoomControls({ editor, state }: { editor: Editor; state: EditorState }) {
  const zoom = state.viewport.zoom
  const pct = `${Math.round(zoom * 100)}%`
  return (
    <div className="floating controls controls-right" role="group" aria-label="Zoom">
      <IconButton label="Zoom out" shortcut="-" keys="-" disabled={zoom <= MIN_ZOOM + 1e-6} onClick={() => editor.zoomBy(1 / 1.25)}>
        <MinusIcon />
      </IconButton>
      <button
        type="button"
        className="zoom-readout"
        aria-label={`Zoom ${pct}. Reset to 100%`}
        aria-keyshortcuts="0"
        data-tip="Reset to 100% (0)"
        data-tip-side="top"
        onClick={() => editor.resetZoom()}
      >
        {pct}
      </button>
      <IconButton label="Zoom in" shortcut="+" keys="+ =" disabled={zoom >= MAX_ZOOM - 1e-6} onClick={() => editor.zoomBy(1.25)}>
        <PlusIcon />
      </IconButton>
      <span className="divider" aria-hidden="true" />
      <IconButton label="Fit to content" shortcut="Shift+1" keys="Shift+1" onClick={() => editor.fit()}>
        <FitIcon />
      </IconButton>
    </div>
  )
}
