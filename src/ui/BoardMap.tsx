import { memo, useId, useMemo, useRef, useState } from 'react'
import type { Editor, EditorState } from '../editor/Editor.ts'
import { BOARD_MAP_SIZE, fitBoardMap, mapViewportRect, projectMapRect } from '../model/boardMap.ts'
import type { Rect } from '../model/viewport.ts'
import './frameNavigation.css'

const rectStyle = ({ left, top, right, bottom }: Rect) => ({ left, top, width: right - left, height: bottom - top })
type Frames = EditorState['frameDestinations']

const MapFrames = memo(function MapFrames({ editor, frames, projection, blocked }: {
  editor: Editor
  frames: Frames
  projection: NonNullable<ReturnType<typeof fitBoardMap>>
  blocked: boolean
}) {
  const [active, setActive] = useState<string | null>(null)
  const ordered = useMemo(() => frames.slice().reverse(), [frames])
  const current = Math.max(0, ordered.findIndex(({ id }) => id === active))
  return (
    <div className="board-map-frames" role="group" aria-label="Frame destinations" onKeyDown={(e) => {
      if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const count = ordered.length
      let next: number
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp': next = (current + count - 1) % count; break
        case 'ArrowRight':
        case 'ArrowDown': next = (current + 1) % count; break
        case 'Home': next = 0; break
        case 'End': next = count - 1; break
        default: return
      }
      e.preventDefault()
      const button = e.currentTarget.children.item(next)
      if (button instanceof HTMLButtonElement) button.focus({ preventScroll: true })
    }}>
      {ordered.map((frame, index) => {
        const { left, top, width, height } = rectStyle(projectMapRect(frame.bounds, projection))
        return (
          <button type="button" key={frame.id} title={frame.name} aria-label={`Jump to ${frame.name}`}
            disabled={blocked} tabIndex={index === current ? 0 : -1}
            style={{ left: left + width / 2, top: top + height / 2, width: Math.max(width, 12), height: Math.max(height, 12) }}
            onFocus={() => setActive(frame.id)}
            onClick={() => { if (editor.jumpToFrame(frame.id)) setActive(frame.id) }}
          >
            <span aria-hidden="true" style={{ width: Math.max(width, 1), height: Math.max(height, 1) }} />
          </button>
        )
      })}
    </div>
  )
})

export function BoardMap({ editor, state }: { editor: Editor; state: EditorState }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const frames = state.frameDestinations
  const projection = useMemo(() => open ? fitBoardMap(frames) : null, [open, frames])
  const view = projection && mapViewportRect(state.viewport, state.canvasSize, projection)
  const blocked = state.editingText || state.cropping
  return (
    <div className="board-map" onKeyDown={(e) => {
      if (!open || !editor.canNavigateFrames()) return
      e.stopPropagation()
      if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }} onPaste={(e) => { if (open) e.stopPropagation() }}>
      <button type="button" className="text-btn" ref={trigger} disabled={blocked && !open}
        aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => { if (open || editor.canNavigateFrames()) setOpen(!open) }}>
        Board map
      </button>
      {open && (
        <section id={id} className="board-map-panel" aria-label="Board map">
          {projection ? (
            <>
              <div className="board-map-surface" style={BOARD_MAP_SIZE}>
                <MapFrames editor={editor} frames={frames} projection={projection} blocked={blocked} />
                {view && <div className="board-map-viewport" data-testid="board-map-viewport" aria-hidden="true" style={rectStyle(view)} />}
              </div>
              <p>{view ? 'Current view' : 'Current view is outside the map.'}</p>
            </>
          ) : <p>No frames yet.</p>}
        </section>
      )}
    </div>
  )
}
