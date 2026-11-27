import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import type { Editor, SelectionInfo, TextFormatInfo } from '../editor/Editor.ts'
import { FONT_STACKS } from '../editor/fonts.ts'
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from '../model/doc.ts'
import type { Align } from '../model/layout.ts'
import { FONT_IDS, FONT_LABELS, TEXT_PALETTE } from '../model/richText.ts'
import type { Mark, MarkState, TextAlign } from '../model/richText.ts'
import { IconButton } from './IconButton.tsx'
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BackwardIcon,
  BoldIcon,
  ForwardIcon,
  ItalicIcon,
  LockIcon,
  SelectContentsIcon,
  StrikeIcon,
  ToBackIcon,
  ToFrontIcon,
  TrashIcon,
  UnderlineIcon,
  UnlockIcon,
} from './icons.tsx'

const kindHeading = (s: SelectionInfo) =>
  s.kind === 'multiple' ? `${s.count} objects` : s.kind === 'text' ? 'Text' : s.kind === 'frame' ? 'Frame' : 'Image'
const heading = (s: SelectionInfo) => (s.locked ? `${kindHeading(s)} · Locked` : kindHeading(s))

const itemCount = (n: number) => (n === 0 ? 'Nothing yet' : n === 1 ? '1 item' : `${n} items`)

/** Name, contents and "Select with contents" for a single selected frame. */
function FramePanel({ editor, selection }: { editor: Editor; selection: SelectionInfo }) {
  const nameId = useId()
  const nameInput = useRef<HTMLInputElement>(null)
  const name = selection.frameName ?? ''
  const members = selection.memberCount ?? 0

  // Double-clicking a frame's label on the canvas puts the cursor in this field.
  useEffect(() => {
    editor.setFrameRenamer(() => {
      nameInput.current?.focus()
      nameInput.current?.select()
    })
    return () => editor.setFrameRenamer(null)
  }, [editor])

  // A name being typed is committed when the pointer goes down anywhere else. Waiting for the
  // browser's own blur is too late: by then the canvas has already handled the press (the
  // selection has changed, or a drag has begun) and the editor would refuse the rename. The
  // capture phase on the document runs before any of that. It also covers the panel's own
  // buttons, which deliberately do not take focus.
  useEffect(() => {
    const commitPending = (e: PointerEvent) => {
      const input = nameInput.current
      // Also for Undo: the typed name is committed first and is then the step that Undo takes
      // back, so Redo returns it. (Leaving it pending instead would lose it whenever the undo
      // changes the frame's name and this field is rebuilt.)
      if (input && document.activeElement === input && e.target !== input) input.blur()
    }
    document.addEventListener('pointerdown', commitPending, true)
    return () => document.removeEventListener('pointerdown', commitPending, true)
  }, [])

  const commit = (input: HTMLInputElement) => {
    // The editor normalizes the name (and refuses while it is busy or read-only): show what it really is.
    input.value = editor.renameFrame(input.value) ?? name
  }
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      e.currentTarget.value = name
      e.currentTarget.blur()
    }
  }

  return (
    <>
      <div className="inspector-row">
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          key={name}
          ref={nameInput}
          className="text-input"
          defaultValue={name}
          disabled={selection.locked}
          maxLength={80}
          spellCheck={false}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={onKey}
        />
      </div>
      <div className="inspector-row">
        <span>Contents</span>
        <span className="inspector-value" data-testid="frame-item-count">
          {itemCount(members)}
        </span>
      </div>
      <button
        type="button"
        className="secondary-btn inspector-btn"
        disabled={members === 0 || selection.locked}
        title="Select this frame together with everything it owns, to move or scale them as one"
        onClick={() => editor.selectFrameContents()}
      >
        <SelectContentsIcon />
        <span>Select with contents</span>
      </button>
      <p className="inspector-note">
        Something belongs to a frame once you move it into the frame. Moving or resizing the frame itself never picks things up.
      </p>
    </>
  )
}

/** Crop, Fit and Fill for a single image. Disabled while it is locked, and Fit/Fill when they would change nothing. */
function ImageTools({ editor, selection }: { editor: Editor; selection: SelectionInfo }) {
  const image = selection.image
  return (
    <div className="image-tools" role="group" aria-label="Image tools">
      <button
        type="button"
        className="secondary-btn inspector-btn"
        aria-label="Crop image"
        title="Crop: choose the part of the image to show (double-click the image)"
        disabled={selection.locked}
        onClick={() => editor.startCrop()}
      >
        Crop
      </button>
      <button
        type="button"
        className="secondary-btn inspector-btn"
        aria-label="Fit image"
        title="Fit: show the whole image inside its current box"
        disabled={!image?.canFit}
        onClick={() => editor.fitImage()}
      >
        Fit
      </button>
      <button
        type="button"
        className="secondary-btn inspector-btn"
        aria-label="Fill image"
        title="Fill: cover the current box with the image, cropping what does not fit"
        disabled={!image?.canFill}
        onClick={() => editor.fillImage()}
      >
        Fill
      </button>
    </div>
  )
}

/** Swaps the picture inside the selected image, keeping its place, size, frame and stacking. */
function ReplaceButton({ selection, onReplace }: { selection: SelectionInfo; onReplace: () => void }) {
  return (
    <button
      type="button"
      className="secondary-btn inspector-btn"
      title="Replace the picture, keeping its place and size on the board"
      disabled={selection.locked}
      onClick={onReplace}
    >
      Replace image
    </button>
  )
}

/** While cropping, the inspector shows only how to finish the crop. */
function CropPanel({ editor }: { editor: Editor }) {
  return (
    <aside className="floating inspector" aria-label="Selection">
      <div className="inspector-title">Crop image</div>
      <p className="inspector-note crop-help" data-testid="crop-help">
        Drag the handles or the box. Enter applies, Esc cancels.
      </p>
      <div className="crop-actions">
        <button type="button" className="secondary-btn inspector-btn" onClick={() => editor.cancelCrop()}>
          Cancel
        </button>
        <button type="button" className="primary-btn inspector-btn" onClick={() => editor.applyCrop()}>
          Done
        </button>
      </div>
    </aside>
  )
}

const MARKS: ReadonlyArray<{ mark: Mark; label: string; shortcut?: string; keys?: string; icon: () => ReactElement }> = [
  { mark: 'bold', label: 'Bold', shortcut: 'Ctrl+B', keys: 'Control+B Meta+B', icon: BoldIcon },
  { mark: 'italic', label: 'Italic', shortcut: 'Ctrl+I', keys: 'Control+I Meta+I', icon: ItalicIcon },
  { mark: 'underline', label: 'Underline', shortcut: 'Ctrl+U', keys: 'Control+U Meta+U', icon: UnderlineIcon },
  { mark: 'strike', label: 'Strikethrough', icon: StrikeIcon },
]
const ALIGNS: ReadonlyArray<{ align: TextAlign; label: string; icon: () => ReactElement }> = [
  { align: 'left', label: 'Align left', icon: AlignLeftIcon },
  { align: 'center', label: 'Align centre', icon: AlignCenterIcon },
  { align: 'right', label: 'Align right', icon: AlignRightIcon },
]
/** `name`: the accessible name, which starts with the visible text. */
const HEADINGS: ReadonlyArray<{ level: 0 | 1 | 2 | 3; text: string; label: string; name: string }> = [
  { level: 0, text: 'Body', label: 'Body', name: 'Body' },
  { level: 1, text: 'H1', label: 'Heading 1', name: 'H1 (Heading 1)' },
  { level: 2, text: 'H2', label: 'Heading 2', name: 'H2 (Heading 2)' },
  { level: 3, text: 'H3', label: 'Heading 3', name: 'H3 (Heading 3)' },
]
const pressedOf = (s: MarkState): boolean | 'mixed' => (s === 'mixed' ? 'mixed' : s === 'on')

/**
 * Formatting for the one selected text. Every control is a button, and the panel's buttons
 * never take focus (see Overlays), so clicking one while the text is being edited keeps the
 * edit, its caret and its selected range, and typing carries on in the text. Only the size
 * field takes focus, as before.
 */
function TextPanel({ editor, selection, text, locked }: { editor: Editor; selection: SelectionInfo; text: TextFormatInfo; locked: boolean }) {
  const id = useId()
  const colourName = TEXT_PALETTE.find((p) => p.color === text.color)?.name ?? text.color
  return (
    <>
      <div className="inspector-row">
        <span id={`${id}-font`}>Font</span>
        <span className="inspector-value">{text.font === 'mixed' ? 'Mixed' : FONT_LABELS[text.font]}</span>
      </div>
      <div className="choice-row" role="group" aria-labelledby={`${id}-font`}>
        {FONT_IDS.map((f) => (
          <button
            key={f}
            type="button"
            className="choice-btn font-btn"
            style={{ fontFamily: FONT_STACKS[f] }}
            aria-label={FONT_LABELS[f]}
            aria-pressed={text.font === f}
            data-tip={FONT_LABELS[f]}
            data-tip-side="bottom"
            disabled={locked}
            onClick={() => editor.setTextFont(f)}
          >
            Aa
          </button>
        ))}
      </div>

      {selection.fontSize !== null && (
        <div className="inspector-row">
          <label htmlFor={`${id}-size`}>Font size</label>
          <input
            id={`${id}-size`}
            className="number-input"
            type="number"
            inputMode="numeric"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            step={1}
            disabled={selection.locked}
            value={Math.round(selection.fontSize)}
            onChange={(e) => {
              const n = e.currentTarget.valueAsNumber
              if (Number.isFinite(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) editor.setFontSize(n)
            }}
          />
        </div>
      )}

      <div className="inspector-row">
        <span id={`${id}-heading`}>Heading</span>
        <div className="btn-group" role="group" aria-labelledby={`${id}-heading`}>
          {HEADINGS.map((h) => (
            <button
              key={h.level}
              type="button"
              className="choice-btn heading-btn"
              aria-label={h.name}
              aria-pressed={text.heading === h.level}
              data-tip={text.editing ? `${h.label}: the selected lines` : `${h.label}: every line`}
              data-tip-side="bottom"
              disabled={locked}
              onClick={() => editor.setHeading(h.level)}
            >
              {h.text}
            </button>
          ))}
        </div>
      </div>

      <div className="inspector-row">
        <span id={`${id}-style`}>Style</span>
        <div className="btn-group" role="group" aria-labelledby={`${id}-style`}>
          {MARKS.map(({ mark, label, shortcut, keys, icon: Icon }) => {
            // In heading lines bold is the heading's own: shown as on, and not changeable there.
            const fixed = mark === 'bold' && text.boldFromHeading
            return (
              <IconButton
                key={mark}
                label={label}
                shortcut={shortcut}
                keys={keys}
                pressed={fixed ? true : pressedOf(text.marks[mark])}
                disabled={locked || fixed}
                // One tip that explains why it is greyed out (shown although the button is disabled).
                tip={fixed ? 'Bold: headings are always bold' : undefined}
                className={fixed ? 'tip-always' : undefined}
                aria-description={fixed ? 'Headings are always bold' : undefined}
                onClick={() => editor.toggleMark(mark)}
              >
                <Icon />
              </IconButton>
            )
          })}
        </div>
      </div>

      <div className="inspector-row">
        <span id={`${id}-align`}>Align</span>
        <div className="btn-group" role="group" aria-labelledby={`${id}-align`}>
          {ALIGNS.map(({ align, label, icon: Icon }) => (
            <IconButton key={align} label={label} pressed={text.align === align} disabled={locked} onClick={() => editor.setTextAlign(align)}>
              <Icon />
            </IconButton>
          ))}
        </div>
      </div>

      <div className="inspector-row">
        <span id={`${id}-colour`}>Colour</span>
        <span className="inspector-value">{colourName}</span>
      </div>
      <div className="swatch-row" role="group" aria-labelledby={`${id}-colour`}>
        {TEXT_PALETTE.map((p) => (
          <button
            key={p.color}
            type="button"
            className="swatch"
            style={{ background: p.color }}
            aria-label={p.name}
            aria-pressed={text.color === p.color}
            data-tip={p.name}
            data-tip-side="bottom"
            disabled={locked}
            onClick={() => editor.setTextColor(p.color)}
          />
        ))}
      </div>
    </>
  )
}

const POSITION_ALIGNS: ReadonlyArray<{ op: Align; label: string; short: string }> = [
  { op: 'left', label: 'Align left edges', short: 'Left' },
  { op: 'center-x', label: 'Align horizontal centers', short: 'Center X' },
  { op: 'right', label: 'Align right edges', short: 'Right' },
  { op: 'top', label: 'Align top edges', short: 'Top' },
  { op: 'center-y', label: 'Align vertical centers', short: 'Center Y' },
  { op: 'bottom', label: 'Align bottom edges', short: 'Bottom' },
]

function LayoutPanel({ editor, layout }: { editor: Editor; layout: NonNullable<SelectionInfo['layout']> }) {
  const label = useId()
  return (
    <>
      <div className="layout-group" role="group" aria-labelledby={label}>
        <span id={label}>Align</span>
        <div className="layout-buttons">
          {POSITION_ALIGNS.map(({ op, label, short }) => (
            <button type="button" key={op} className="secondary-btn" aria-label={label} title={label} onClick={() => editor.layoutSelection(op)}>
              {short}
            </button>
          ))}
        </div>
      </div>
      <div className="layout-group" role="group" aria-labelledby={label + '-distribute'}>
        <span id={label + '-distribute'}>Distribute</span>
        <div className="layout-buttons layout-distribute">
          <button type="button" className="secondary-btn" aria-label="Distribute horizontally" title="Equal gaps between three or more items" disabled={!layout.spaceX} onClick={() => editor.layoutSelection('space-x')}>
            Horizontal
          </button>
          <button type="button" className="secondary-btn" aria-label="Distribute vertically" title="Equal gaps between three or more items" disabled={!layout.spaceY} onClick={() => editor.layoutSelection('space-y')}>
            Vertical
          </button>
        </div>
      </div>
    </>
  )
}

export function Inspector({ editor, selection, cropping, onReplace }: {
  editor: Editor
  selection: SelectionInfo
  cropping: boolean
  /** The parent owns the file input, which stays mounted while the file dialog is open. */
  onReplace: () => void
}) {
  const sizeId = useId()
  const isFrame = selection.kind === 'frame'
  if (cropping) return <CropPanel editor={editor} />
  return (
    <aside
      className="floating inspector"
      aria-label="Selection"
      // A press on the panel itself (not on a field) must not take focus from a text being
      // edited either: the edit would go on, but typing would no longer reach it.
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('input, label, select, textarea')) e.preventDefault()
      }}
    >
      <div className="inspector-title">{heading(selection)}</div>

      {isFrame && <FramePanel editor={editor} selection={selection} />}

      {selection.kind === 'image' && <ImageTools editor={editor} selection={selection} />}
      {selection.kind === 'image' && <ReplaceButton selection={selection} onReplace={onReplace} />}

      {selection.kind === 'text' && selection.text && <TextPanel editor={editor} selection={selection} text={selection.text} locked={selection.locked} />}

      {selection.layout && <LayoutPanel editor={editor} layout={selection.layout} />}

      <div className="inspector-row">
        <span id={`${sizeId}-layer`}>Layer</span>
        <div className="btn-group" role="group" aria-labelledby={`${sizeId}-layer`}>
          <IconButton label="Bring to front" shortcut="Ctrl+]" keys="Control+] Meta+]" disabled={!selection.layer.front} onClick={() => editor.arrange('front')}>
            <ToFrontIcon />
          </IconButton>
          <IconButton label="Bring forward" shortcut="]" keys="]" disabled={!selection.layer.forward} onClick={() => editor.arrange('forward')}>
            <ForwardIcon />
          </IconButton>
          <IconButton label="Send backward" shortcut="[" keys="[" disabled={!selection.layer.backward} onClick={() => editor.arrange('backward')}>
            <BackwardIcon />
          </IconButton>
          <IconButton label="Send to back" shortcut="Ctrl+[" keys="Control+[ Meta+[" disabled={!selection.layer.back} onClick={() => editor.arrange('back')}>
            <ToBackIcon />
          </IconButton>
        </div>
      </div>

      <button
        type="button"
        className="secondary-btn inspector-btn"
        aria-keyshortcuts="Control+D Meta+D"
        title="Duplicate the selection (Ctrl+D)"
        disabled={selection.locked}
        onClick={() => editor.duplicateSelection()}
      >
        Duplicate
      </button>

      <button
        type="button"
        className="secondary-btn inspector-btn"
        aria-keyshortcuts="Control+Shift+L Meta+Shift+L"
        title={selection.locked ? 'Unlock, so that it can be moved and changed again (Ctrl+Shift+L)' : 'Lock against moving and changing by accident (Ctrl+Shift+L)'}
        onClick={() => editor.setSelectionLocked(!selection.locked)}
      >
        {selection.locked ? <UnlockIcon /> : <LockIcon />}
        <span>{selection.locked ? 'Unlock' : 'Lock'}</span>
      </button>
      {selection.locked && (
        <p className="inspector-note" data-testid="locked-note">
          Locked: it cannot be moved or changed. Unlock it here or with its padlock in the layer list.
        </p>
      )}

      <button
        type="button"
        className="danger-btn"
        aria-keyshortcuts="Delete Backspace"
        disabled={selection.locked}
        onClick={() => editor.deleteSelection()}
      >
        <TrashIcon />
        <span>{isFrame ? 'Delete frame' : 'Delete'}</span>
      </button>
      {isFrame && !selection.locked && <p className="inspector-note">Deleting a frame keeps its contents on the board.</p>}
    </aside>
  )
}
