import { useEffect, useId, useRef, useState } from 'react'
import type { Editor } from '../editor/Editor.ts'
import { BUILTIN_APPEARANCES, DEFAULT_BOARD_STYLE, normalizePresetName, sameBoardStyle } from '../model/appearance.ts'
import type { BoardAppearance, BoardPattern } from '../model/appearance.ts'
import { CloseIcon } from './icons.tsx'

const PATTERNS: ReadonlyArray<{ value: BoardPattern; label: string }> = [
  { value: 'dots', label: 'Dots' },
  { value: 'grid', label: 'Grid' },
  { value: 'none', label: 'None' },
]

export function AppearanceMenu({ editor, appearance, disabled }: { editor: Editor; appearance: BoardAppearance; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const style = appearance.style ?? DEFAULT_BOARD_STYLE
  const presets = appearance.presets ?? []
  const key = normalizePresetName(name).toLowerCase()
  const canSave = Boolean(key) && !presets.some((p) => p.name.toLowerCase() === key)

  useEffect(() => {
    if (!open || disabled) return
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapper.current?.contains(e.target)) setOpen(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open, disabled])

  return (
    <div className="appearance-menu" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="text-btn"
        aria-expanded={open && !disabled}
        aria-controls={open && !disabled ? panelId : undefined}
        disabled={disabled}
        onClick={() => {
          if (open || editor.prepareAppearance()) setOpen(!open)
        }}
      >
        Appearance
      </button>
      {open && !disabled && (
        <div className="appearance-panel" id={panelId} role="region" aria-label="Board appearance">
          <div className="appearance-presets" role="group" aria-label="Built-in presets">
            {BUILTIN_APPEARANCES.map((preset) => (
              <button key={preset.name} type="button" className="text-btn" aria-pressed={sameBoardStyle(preset.style, style)} onClick={() => editor.setBoardStyle(preset.style)}>
                {preset.name}
              </button>
            ))}
          </div>
          <label className="appearance-field">
            Background
            <input type="color" value={style.background} onChange={(e) => editor.setBoardStyle({ ...style, background: e.currentTarget.value })} />
          </label>
          <label className="appearance-field">
            Pattern
            <select value={style.pattern} onChange={(e) => editor.setBoardStyle({ ...style, pattern: e.currentTarget.value as BoardPattern })}>
              {PATTERNS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="appearance-field">
            Pattern color
            <input type="color" value={style.patternColor} onChange={(e) => editor.setBoardStyle({ ...style, patternColor: e.currentTarget.value })} />
          </label>
          {presets.length > 0 && (
            <ul className="appearance-saved" aria-label="Saved presets">
              {presets.map((preset) => (
                <li key={preset.name}>
                  <button type="button" className="text-btn" aria-pressed={sameBoardStyle(preset.style, style)} onClick={() => editor.setBoardStyle(preset.style)}>
                    {preset.name}
                  </button>
                  <button type="button" className="text-btn appearance-remove" aria-label={'Remove preset ' + preset.name} onClick={() => editor.removeAppearancePreset(preset.name)}>
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="appearance-save" onSubmit={(e) => {
            e.preventDefault()
            if (editor.addAppearancePreset(name)) setName('')
          }}>
            <input className="text-input" aria-label="Preset name" placeholder="Preset name" value={name} maxLength={40} onChange={(e) => setName(e.currentTarget.value)} />
            <button type="submit" className="text-btn" disabled={!canSave}>Save preset</button>
          </form>
          <button type="button" className="text-btn" disabled={!appearance.style} onClick={() => editor.setBoardStyle(DEFAULT_BOARD_STYLE)}>Reset appearance</button>
        </div>
      )}
    </div>
  )
}
