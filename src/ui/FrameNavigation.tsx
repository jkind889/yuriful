import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Editor, EditorState, FrameTourSession } from '../editor/Editor.ts'
import type { FrameDestination } from '../model/frameDestinations.ts'
import { CloseIcon, FrameIcon } from './icons.tsx'
import './frameNavigation.css'

const searchKey = (name: string) => name.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ')
const coordinate = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

function FrameSearch({ id, frames, onJump }: {
  id: string
  frames: readonly FrameDestination[]
  onJump: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [scrollRow, setScrollRow] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const index = useMemo(() => {
    const names = new Map<string, number>()
    const entries = frames.map((frame) => {
      const key = searchKey(frame.name)
      names.set(key, (names.get(key) ?? 0) + 1)
      return { frame, key }
    })
    return { entries, names }
  }, [frames])
  const key = searchKey(query)
  const matches = useMemo(() => {
    if (!key) return index.entries
    const terms = key.split(' ')
    const rank = (name: string) => name === key ? 0 : name.startsWith(key) ? 1 : 2
    return index.entries.filter((entry) => terms.every((term) => entry.key.includes(term)))
      .sort((a, b) => rank(a.key) - rank(b.key))
  }, [index, key])
  const current = Math.min(active, Math.max(0, matches.length - 1))
  const result = matches[current]
  const rowHeight = 48
  const first = Math.max(0, scrollRow - 3)
  const last = scrollRow + 10
  const rows = matches.slice(first, last).map((entry, index) => ({ ...entry, position: first + index }))
  if (result && current < first) rows.unshift({ ...result, position: current })
  if (result && current >= last) rows.push({ ...result, position: current })

  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const top = current * rowHeight
    const bottom = top + rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }, [current, matches])

  return (
    <div className="frame-nav-panel" id={id}>
      <input
        ref={input}
        role="combobox"
        className="frame-nav-input"
        aria-label="Search frames"
        aria-autocomplete="list"
        aria-expanded={!!result}
        aria-controls={result ? `${id}-results` : undefined}
        aria-activedescendant={result ? `${id}-${current}` : undefined}
        placeholder="Search frames…"
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value)
          setActive(0)
          setScrollRow(0)
          if (list.current) list.current.scrollTop = 0
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive(Math.max(0, Math.min(matches.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1))))
          } else if (e.key === 'Enter' && result) {
            e.preventDefault()
            onJump(result.frame.id)
          }
        }}
      />
      {result ? (
        <ul
          ref={list}
          id={`${id}-results`}
          className="frame-nav-results"
          role="listbox"
          aria-label="Frames"
          tabIndex={-1}
          onScroll={(e) => setScrollRow(Math.floor(e.currentTarget.scrollTop / rowHeight))}
        >
          <li role="presentation" aria-hidden="true" style={{ height: matches.length * rowHeight }} />
          {rows.map(({ frame, key, position }) => {
            const { left, top } = frame.bounds
            const location = (index.names.get(key) ?? 0) > 1 ? ` · X ${coordinate.format(left)}, Y ${coordinate.format(top)}` : ''
            return (
              <li
                key={frame.id}
                id={`${id}-${position}`}
                className="frame-nav-result"
                role="option"
                aria-label={frame.name}
                aria-describedby={`${id}-${position}-details`}
                aria-selected={current === position}
                aria-posinset={position + 1}
                aria-setsize={matches.length}
                style={{ top: position * rowHeight, height: rowHeight }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onJump(frame.id)}
              >
                <FrameIcon />
                <span>
                  <strong title={frame.name}>{frame.name}</strong>
                  <small id={`${id}-${position}-details`}>
                    {frame.itemCount} {frame.itemCount === 1 ? 'item' : 'items'}{frame.locked ? ' · Locked' : ''}{location}
                  </small>
                </span>
              </li>
            )
          })}
        </ul>
      ) : <p className="frame-nav-empty" role="status">{frames.length ? 'No matching frames.' : 'Draw a frame to add a destination.'}</p>}
    </div>
  )
}

export function FrameNavigator({ editor, state }: { editor: Editor; state: EditorState }) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const blocked = state.editingText || state.cropping
  const expanded = open && !blocked

  useEffect(() => {
    editor.setFrameNavigator(() => setOpen(true))
    return () => editor.setFrameNavigator(null)
  }, [editor])

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapper.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])

  const close = () => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  return (
    <div
      className="frame-nav"
      ref={wrapper}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}
      onKeyDown={(e) => {
        if (!expanded) return
        e.stopPropagation()
        if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
        e.preventDefault()
        close()
      }}
      onPaste={(e) => { if (expanded) e.stopPropagation() }}
    >
      <button
        type="button"
        className="text-btn"
        ref={trigger}
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        aria-keyshortcuts="J"
        disabled={blocked}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (expanded) close()
          else if (editor.canNavigateFrames()) setOpen(true)
        }}
      >
        Jump to… <kbd aria-hidden="true">J</kbd>
      </button>
      {state.jumpReturns && (
        <button type="button" className="text-btn" disabled={blocked} onMouseDown={(e) => e.preventDefault()} onClick={() => {
          if (editor.returnFromJump()) close()
        }}>
          Return to start
        </button>
      )}
      {expanded && <FrameSearch id={id} frames={state.frameDestinations} onJump={(frame) => {
        if (editor.jumpToFrame(frame)) close()
      }} />}
    </div>
  )
}

function FramePreview({ session, frame }: { session: FrameTourSession; frame: FrameDestination }) {
  const [preview, setPreview] = useState<string | false | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void session.renderFrame(frame.id, controller.signal).then(
      (url) => { if (!controller.signal.aborted) setPreview(url) },
      () => { if (!controller.signal.aborted) setPreview(false) },
    )
    return () => controller.abort()
  }, [session, frame.id])
  return preview
    ? <img src={preview} alt={frame.name} draggable={false} onError={() => setPreview(false)} />
    : <p role="status">{preview === null ? 'Loading frame preview…' : 'Could not load this frame preview.'}</p>
}

function TourDialog({ session, onClose }: { session: FrameTourSession; onClose: () => void }) {
  const [position, setPosition] = useState(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const nextButton = useRef<HTMLButtonElement>(null)
  const frame = session.frames[position]
  const last = Math.max(0, session.frames.length - 1)
  const step = (offset: number) => setPosition((current) => Math.max(0, Math.min(last, current + offset)))
  const close = () => {
    dialog.current?.close()
    onClose()
  }

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    closeButton.current?.focus({ preventScroll: true })
    return () => { if (element.open) element.close() }
  }, [])

  return createPortal(
    <dialog
      ref={dialog}
      className="frame-tour-dialog"
      aria-label="Frame tour"
      onCancel={(e) => { e.preventDefault(); close() }}
      onPaste={(e) => { e.preventDefault(); e.stopPropagation() }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'none' }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation() }}
      onKeyUp={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
        if (e.key === 'Tab') {
          const first = closeButton.current
          const end = nextButton.current ?? first
          if (e.target === (e.shiftKey ? first : end)) {
            e.preventDefault()
            const destination = e.shiftKey ? end : first
            destination?.focus({ preventScroll: true })
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          close()
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          step(e.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
    >
      <header>
        <h2 title={frame?.name}>{frame?.name ?? 'Frame tour'}</h2>
        <button ref={closeButton} className="icon-btn" type="button" aria-label="Close tour" onClick={close}><CloseIcon /></button>
      </header>
      <div className="frame-tour-stage">
        {frame ? <FramePreview key={frame.id} session={session} frame={frame} /> : <p>No frames are in view.</p>}
      </div>
      {frame && (
        <footer>
          <button type="button" className="text-btn" aria-disabled={position === 0} onClick={() => step(-1)}>Previous frame</button>
          <p role="status" aria-atomic="true">{position + 1} of {session.frames.length}</p>
          <button ref={nextButton} type="button" className="text-btn" aria-disabled={position === last} onClick={() => step(1)}>Next frame</button>
        </footer>
      )}
    </dialog>,
    document.body,
  )
}

export function FrameTour({ editor, state }: { editor: Editor; state: EditorState }) {
  const [session, setSession] = useState<FrameTourSession | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const start = () => {
    const tour = editor.startFrameTour()
    if (!tour) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setSession(tour)
  }

  const close = () => {
    setSession(null)
    queueMicrotask(() => {
      const previous = previousFocus.current
      if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true })
      else trigger.current?.focus({ preventScroll: true })
    })
  }

  return (
    <>
      <button ref={trigger} type="button" className="text-btn" aria-haspopup="dialog"
        disabled={state.editingText || state.cropping} onMouseDown={(e) => e.preventDefault()} onClick={start}>
        Frame tour
      </button>
      {session && <TourDialog session={session} onClose={close} />}
    </>
  )
}
