import type { Editor, EditorState } from '../editor/Editor.ts'
import { IconButton } from './IconButton.tsx'
import { FrameIcon, HandIcon, ImageIcon, SelectIcon, TextIcon } from './icons.tsx'

export function Toolbar({ editor, state, onAddImage }: { editor: Editor; state: EditorState; onAddImage: () => void }) {
  const hand = state.tool === 'hand'
  const locked = state.readOnly !== null // read-only boards can only be panned and zoomed
  return (
    <div className="floating toolbar" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      <IconButton
        label="Select"
        shortcut="V"
        keys="V"
        tipSide="right"
        pressed={state.tool === 'select' && !state.handActive}
        disabled={locked}
        onClick={() => editor.setTool('select')}
      >
        <SelectIcon />
      </IconButton>
      <IconButton label="Hand (pan)" shortcut="H" keys="H" tipSide="right" pressed={hand} onClick={() => editor.setTool('hand')}>
        <HandIcon />
      </IconButton>
      <IconButton label="Add image" shortcut="I" keys="I" tipSide="right" disabled={locked} onClick={onAddImage}>
        <ImageIcon />
      </IconButton>
      <IconButton label="Text" shortcut="T" keys="T" tipSide="right" pressed={state.tool === 'text'} disabled={locked} onClick={() => editor.setTool('text')}>
        <TextIcon />
      </IconButton>
      <IconButton
        label="Frame"
        shortcut="F"
        keys="F"
        tipSide="right"
        pressed={state.tool === 'frame'}
        disabled={locked}
        onClick={() => editor.setTool(state.tool === 'frame' ? 'select' : 'frame')}
      >
        <FrameIcon />
      </IconButton>
    </div>
  )
}
