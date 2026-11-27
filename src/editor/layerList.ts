import { Textbox } from 'fabric'
import type { FabricObject } from 'fabric'
import { frameNameOf, idOf, isFrame, isLocked, ownerOf, toRecord } from './objects.ts'

/** One row of the layer list. */
export interface LayerItem {
  id: string
  kind: 'image' | 'text' | 'frame'
  label: string
  selected: boolean
  /** Content only: the name of the frame that owns it (stored ownership, never position). Null for frames and loose content. */
  frameName: string | null
  /** Locked: the row's padlock unlocks it, and the row is the only way to select it. */
  locked: boolean
}

/** How much of a text the list shows. */
export const MAX_LAYER_LABEL = 40

export const EMPTY_LAYERS: readonly LayerItem[] = Object.freeze([])

function textLabel(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > MAX_LAYER_LABEL ? `${t.slice(0, MAX_LAYER_LABEL - 1).trimEnd()}…` : t
}

const sameItem = (a: LayerItem, b: LayerItem) =>
  a.id === b.id && a.kind === b.kind && a.label === b.label && a.selected === b.selected && a.frameName === b.frameName && a.locked === b.locked

/**
 * The board in stacking order, FRONT-MOST FIRST: all content from front to back, then all
 * frames from front to back (frames always sit behind content). Flat: content is not
 * grouped under its frame, because z-order is global and independent of ownership.
 *
 * A blank text is not part of the scene (see the editor's snapshot) and is not listed.
 * Returns `previous` itself when nothing in the list changed, so that React can skip work.
 */
export function computeLayers(
  objects: readonly FabricObject[],
  active: readonly FabricObject[],
  assetName: (assetId: string) => string | undefined,
  previous: readonly LayerItem[],
): readonly LayerItem[] {
  const selected = new Set(active)
  const frameNames = new Map<string, string>()
  for (const o of objects) if (isFrame(o)) frameNames.set(idOf(o) ?? '', frameNameOf(o) ?? '')

  const content: LayerItem[] = []
  const frames: LayerItem[] = []
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i] as FabricObject
    const id = idOf(o)
    if (id === undefined) continue
    if (isFrame(o)) {
      frames.push({ id, kind: 'frame', label: frameNameOf(o) || 'Frame', selected: selected.has(o), frameName: null, locked: isLocked(o) })
      continue
    }
    if (o instanceof Textbox && o.text.trim() === '') continue
    const owner = ownerOf(o)
    const frameName = owner !== undefined ? (frameNames.get(owner) ?? null) : null
    if (o instanceof Textbox) {
      content.push({ id, kind: 'text', label: textLabel(o.text), selected: selected.has(o), frameName, locked: isLocked(o) })
    } else {
      const rec = toRecord(o)
      const name = rec?.type === 'image' ? assetName(rec.assetId)?.trim() : undefined
      content.push({ id, kind: 'image', label: name || 'Image', selected: selected.has(o), frameName, locked: isLocked(o) })
    }
  }
  const next = content.concat(frames)
  if (next.length === previous.length && next.every((item, i) => sameItem(item, previous[i] as LayerItem))) return previous
  return next
}
