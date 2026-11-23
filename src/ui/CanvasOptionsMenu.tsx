import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from '../editor/Editor.ts'
import { canvasPrefs } from '../persistence/prefsStore.ts'

export function CanvasOptionsMenu({ editor }: { editor: Editor | null }) {
  const [open, setOpen] = useState(false)
  const prefs = useSyncExternalStore(canvasPrefs.subscribe, canvasPrefs.get)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapper.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  return (
    <div
      className="appearance-menu"
      ref={wrapper}
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (editor?.canChangeCaptionSnap() === false) return
        e.stopPropagation() // let the focused control handle Space without starting the canvas hand tool
        if (!open || e.key !== 'Escape') return
        e.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="text-btn"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          if (open || editor?.canChangeCaptionSnap() !== false) setOpen(!open)
        }}
      >
        Canvas options
      </button>
      {open && (
        <div className="appearance-panel canvas-options-panel" id={panelId} role="region" aria-label="Canvas options">
          <label><input type="checkbox" checked={prefs.feedback} onChange={(e) => canvasPrefs.set('feedback', e.currentTarget.checked)} /> Interaction feedback</label>
          <label><input type="checkbox" checked={prefs.captionSnap} onChange={(e) => {
            if (editor?.canChangeCaptionSnap() !== false) canvasPrefs.set('captionSnap', e.currentTarget.checked)
          }} /> Snap captions to images</label>
        </div>
      )}
    </div>
  )
}
