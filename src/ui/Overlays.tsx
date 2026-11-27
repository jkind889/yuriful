import { useCallback, useEffect, useRef, useState } from 'react'
import { Editor } from '../editor/Editor.ts'
import { HistoryControls, ZoomControls } from './Controls.tsx'
import { CloseIcon } from './icons.tsx'
import { Inspector } from './Inspector.tsx'
import { LayerPanel } from './LayerPanel.tsx'
import { Toolbar } from './Toolbar.tsx'
import { useEditorState } from './useEditorState.ts'

/**
 * One file input serves Add image (several files) and Replace image (one file, for the image
 * that was selected when the button was pressed). The input itself remembers which.
 */
function setPickerMode(input: HTMLInputElement | null, replaceFor: string | null) {
  if (!input) return
  input.multiple = replaceFor === null
  if (replaceFor === null) delete input.dataset.replaceFor
  else input.dataset.replaceFor = replaceFor
}

/** Everything floating over the canvas, plus the file input and drop target. */
export function Overlays({ editor }: { editor: Editor }) {
  const state = useEditorState(editor)
  const fileInput = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // Whether the layer list is expanded. Kept here, for this session only, so that it survives
  // the list becoming empty (which unmounts the panel) and filling again.
  const [layersOpen, setLayersOpen] = useState(true)
  const toggleLayers = useCallback(() => setLayersOpen((v) => !v), [])

  useEffect(() => {
    editor.setImagePicker(() => {
      setPickerMode(fileInput.current, null) // the `i` shortcut always adds
      fileInput.current?.click()
    })
    return () => editor.setImagePicker(null)
  }, [editor])

  // The overlay layer is click-through, so drag/drop listens on the workspace itself.
  useEffect(() => {
    const target = root.current?.parentElement
    if (!target) return
    let depth = 0
    const onEnter = (e: DragEvent) => {
      if (!Editor.hasFiles(e.dataTransfer)) return
      e.preventDefault()
      depth++
      // A read-only board accepts no drops; the drop itself explains why.
      if (editor.getState().readOnly === null) setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (!Editor.hasFiles(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!Editor.hasFiles(e.dataTransfer)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!Editor.hasFiles(e.dataTransfer)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      void editor.addImageFiles(files, { clientX: e.clientX, clientY: e.clientY })
    }
    target.addEventListener('dragenter', onEnter)
    target.addEventListener('dragover', onOver)
    target.addEventListener('dragleave', onLeave)
    target.addEventListener('drop', onDrop)
    return () => {
      target.removeEventListener('dragenter', onEnter)
      target.removeEventListener('dragover', onOver)
      target.removeEventListener('dragleave', onLeave)
      target.removeEventListener('drop', onDrop)
    }
  }, [editor])

  useEffect(() => {
    const input = fileInput.current
    if (!input) return
    // The dialog was closed without a file: nothing happens, and the next pick adds again.
    const onCancel = () => setPickerMode(input, null)
    input.addEventListener('cancel', onCancel)
    return () => input.removeEventListener('cancel', onCancel)
  }, [])
  const openPicker = () => {
    editor.applyCrop() // like every command: an open crop is applied first
    setPickerMode(fileInput.current, null)
    fileInput.current?.click()
  }
  const openReplace = () => {
    const target = editor.replaceTarget() // leaves the current edit and fixes the target now
    if (!target) return
    setPickerMode(fileInput.current, target)
    fileInput.current?.click()
  }
  const readOnly = state?.readOnly ?? null
  const showEmpty = !!state && state.ready && readOnly === null && state.objectCount === 0 && !state.editingText && state.tool !== 'frame'
  const notice = state?.notice ?? null

  return (
    <div
      className="overlays"
      ref={root}
      // Mouse clicks on buttons must not steal focus, otherwise Space (hold to pan)
      // and the letter shortcuts would act on the last-clicked button. Keyboard
      // users still reach every button with Tab.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) e.preventDefault()
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="image-input"
        aria-label="Choose images to add"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = ''
          const target = e.currentTarget.dataset.replaceFor
          setPickerMode(e.currentTarget, null)
          if (target !== undefined) {
            if (files[0]) void editor.replaceImageFile(target, files[0])
          } else if (files.length > 0) void editor.addImageFiles(files)
        }}
      />

      {readOnly !== null && (
        <div className="readonly-banner" role="status" data-testid="readonly-banner">
          <strong>Read-only</strong>
          <span>{readOnly}</span>
          {state?.reloadSuggested && (
            <button type="button" className="text-btn banner-btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </div>
      )}

      {state?.ready && <Toolbar editor={editor} state={state} onAddImage={openPicker} />}
      {state?.ready && <HistoryControls editor={editor} state={state} />}
      {state?.ready && <ZoomControls editor={editor} state={state} />}
      {state?.ready && (
        // The inspector on top and the layer list anchored at the bottom share one column, so they never overlap.
        <div className="side-stack">
          {state.selection && <Inspector editor={editor} selection={state.selection} cropping={state.cropping} onReplace={openReplace} />}
          {state.layers.length > 0 && (
            <LayerPanel editor={editor} layers={state.layers} readOnly={readOnly !== null} open={layersOpen} onToggleOpen={toggleLayers} />
          )}
        </div>
      )}

      {showEmpty && (
        <div className="empty-state">
          <h1>A place for your references.</h1>
          <p>Drop an image or add a thought.</p>
          <div className="empty-actions">
            <button type="button" className="primary-btn" onClick={openPicker}>
              Add image
            </button>
            <button type="button" className="secondary-btn" onClick={() => editor.addText()}>
              Add text
            </button>
          </div>
        </div>
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop images to add them</span>
        </div>
      )}

      {notice && (
        <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <span>{notice.message}</span>
          <button type="button" className="toast-close" aria-label="Dismiss message" onClick={() => editor.dismissNotice()}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  )
}
