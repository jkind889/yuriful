import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Editor } from './editor/Editor.ts'
import { DEFAULT_BOARD_STYLE } from './model/appearance.ts'
import { IndexedDbBoardStore } from './persistence/boardStore.ts'
import { Header } from './ui/Header.tsx'
import { Overlays } from './ui/Overlays.tsx'
import { useEditorState } from './ui/useEditorState.ts'

export default function App() {
  const host = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const state = useEditorState(editor)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const ed = new Editor(el, new IndexedDbBoardStore())
    setEditor(ed)
    void ed.init()
    return () => {
      ed.dispose()
      setEditor(null)
    }
  }, [])

  const style = state?.appearance.style ?? DEFAULT_BOARD_STYLE
  // Patterns move and scale with the canvas so the workspace feels like one surface.
  const vp = state?.viewport ?? { zoom: 1, panX: 0, panY: 0 }
  let gap = 24 * vp.zoom
  while (gap < 14) gap *= 2
  const origin = vp.panX % gap
  const originY = vp.panY % gap

  return (
    <div className="app">
      <Header editor={editor} />
      <main
        className={`workspace${state?.handActive ? ' is-hand' : ''}`}
        data-board-pattern={style.pattern}
        style={{
          backgroundColor: style.background,
          backgroundSize: `${gap}px ${gap}px`,
          backgroundPosition: `${origin}px ${originY}px`,
          '--board-pattern-color': style.patternColor,
        } as CSSProperties}
      >
        <div ref={host} className="canvas-host" />
        {editor && <Overlays editor={editor} />}
      </main>
    </div>
  )
}
