# Layers and image tools: integration contract

This note is for whoever later brings `feat/layers-image-tools` together with other work on the same files, in particular the rich-text branch. It records what this branch changed in the shared model, storage, editor API and UI, the conventions new code has to follow, and where the two branches will collide. It describes no integration: none has been done.

- Branch: `feat/layers-image-tools`, based on `698b628` (`origin/feat/milestone-2-frames`).
- Behaviour is described for the user in [README.md](../README.md) and as constraints in [AGENTS.md](../AGENTS.md) ("Layers", "Locking" and "Image tools", all marked settled). This file does not repeat them.

## Storage decisions

No version bump and no database upgrade. `parseDoc` still accepts stored versions 1 and 2 and nothing else, and a board without frames is still written as version 1. Two optional fields were added, on both versions:

| Field | On | Stored when | Read when |
| --- | --- | --- | --- |
| `locked: true` | every content record, every frame record | only when locked; never `false`, never `undefined` | exactly `true`; anything else is dropped, not fatal |
| `crop: { x, y, width, height }` | image records | only when it is not the whole image; a fresh copy each time | finite numbers, `x >= 0`, `y >= 0`, `width > 0`, `height > 0`; anything else is dropped (the image is shown whole), not fatal |

`crop` is in source pixels of the original image. With a crop, `left`/`top` are the top-left of the displayed box and the displayed size is `crop.width * scaleX` by `crop.height * scaleY`. Image bytes are never changed by cropping.

Consequences to keep in mind:

- An older build reads only the fields it knows. If it opens and saves this board, locks and crops are gone (a cropped image is then shown whole at the same top-left and scale). This is recorded in the README's known limits. Nothing fences older builds out, by decision: the settled storage rules were not reopened.
- A stored crop that reaches outside its decoded image is trimmed to the image when the board opens (`clampCrop` in `createObject`). Loading writes nothing, but the next save stores the trimmed crop.
- Replacing an image changes `assetId` on the record. The old bytes stay in storage until the next load prunes what the stored document does not reference; that is the existing pruning rule, unchanged.

## Shared rules both branches rely on

These match what the rich-text branch stated for its own fields. Keep them when merging either way.

- **Optional fields ride on both stored versions without a database upgrade.**
- **`serializeDoc` never stores a key whose value is `undefined`,** for every kind of record. Here that is `storable()` in `src/model/doc.ts`, which also drops `locked` unless it is `true` and copies `crop`. If the other branch has its own version of this helper, the merged one must do all of it.
- **`sceneEqual` compares nested values by content.** Here that is `valuesEqual` inside `recordsEqual` in `src/model/doc.ts`: plain objects and arrays structurally, NaN equal to NaN, an absent key equal to `undefined`. A flat `!==` on a nested value makes every snapshot look like a change, which means an undo step and a save on every commit. `sceneEqual` kept its name and signature. `objectsEqual` in the same file was not changed and is NOT structural in this sense: it compares `JSON.stringify` output, so key order matters and an absent key differs from an `undefined` one. Only `doc.test.ts` uses it; do not use it to compare scenes.
- **`toRecord` must return fresh nested objects** on every call (a `crop` object is never shared between two snapshots).
- **Nested fields need their own copy when stored.** `storable()` copies a record shallowly and copies `crop` explicitly. Any nested field the rich-text branch adds to `TextRecord` (style runs, for example) needs the same fresh-copy treatment in the merged helper and in `toRecord`.

## Conventions new editor code must follow

- **Every command leaves the current edit first.** `finishEditing()` in `src/editor/Editor.ts` now also applies an open crop (as its own undo step) before it leaves a text edit. A new command that changes the board must call it first, as the existing ones do; otherwise it can run against an image that is temporarily shown uncropped. Panning passes `{ keepCrop: true }`. Two existing commands do not call it, on purpose, and are not a pattern to copy blindly: `setFontSize` acts on the selected text even while it is being edited (it commits with a coalescing key, and skips the commit while the text is blank), and `renameFrame` acts on a selected frame, which excludes a text edit and a crop. A formatting command for text has to decide the same question explicitly: whether it acts inside an open text edit (and then how typing and formatting share or split history steps) or leaves the edit first.
- **A save and a commit must not see an open crop.** `getDoc` returns the crop session's base scene and `commit` returns early while `this.crop` is set, the same way both treat an unsettled gesture. New code that snapshots the canvas for saving or history has to respect both.
- **Nothing edits a locked item.** A locked object or frame can be the selection (alone, chosen from the layer list). Every editing command checks for that and does nothing: `deleteSelection`, `arrange`, `setFontSize`, `renameFrame`, `selectFrameContents`, crop, Fit, Fill and replace. **Text formatting commands from the rich-text branch must do the same**, including the `Ctrl/Cmd+B`, `I` and `U` shortcuts when a locked text is selected but not being edited (a locked text cannot enter editing: its Textbox is `editable: false` and it is never the target of a press). Use `isLocked(obj)` from `src/editor/objects.ts`; `SelectionInfo.locked` tells the UI to disable its controls.
- **A selection that contains a locked item contains nothing else.** `selectByIds` enforces it; form selections through it.
- **Keys while cropping and during a gesture.** During a gesture only Esc and the zoom keys respond. While cropping, Esc, Enter, the zoom keys and Space (hold to pan) respond. A shortcut that `resolveShortcut` recognises but that is ignored in those states is still kept from the browser (`preventDefault`). New shortcut actions get this for free, and are ignored in those states unless the branch in `handleKeyDown` is told otherwise.
- **Formatting keys.** While a text is being edited `resolveShortcut` returns nothing, so this branch neither handles nor blocks `Ctrl/Cmd+B`, `I` or `U` there: the rich-text handler has to claim them itself. If they are also added to `resolveShortcut` for a selected text that is not being edited, they are ignored (and kept from the browser) in crop mode and during a gesture, like every other action.
- **`text:changed` now refreshes derived state** (`syncState()`), so that the layer list follows typing. It only reads. Rich-text handlers on the same event must not rely on state staying untouched during typing.
- **Layer labels read `Textbox.text`** (plain text, whitespace collapsed, 40 characters). Formatted text needs no change as long as `text` stays the plain string.

## Editor surface added

`EditorState`: `layers: readonly LayerItem[]`, `cropping: boolean`.

`SelectionInfo`: `locked: boolean`, `image: { cropped, canFit, canFill } | null`.

Commands on `Editor`: `selectLayer(id, { toggle? })`, `setSelectionLocked(locked)`, `toggleLayerLock(id)`, `startCrop()`, `applyCrop()`, `cancelCrop()`, `fitImage()`, `fillImage()`, `replaceTarget()`, `replaceImageFile(targetId, file)`.

Shortcuts (`src/input/shortcuts.ts`): the action `toggle-lock` on `Ctrl/Cmd+Shift+L`; `Escape` now resolves with Alt held; `isConfirmKey` (plain Enter outside fields and buttons).

Canvas options: `altSelectionKey: 'altKey'` (a press with Alt goes to the selected object when it is under the pointer). `FrameCanvas` gained a `findTarget` override (a frame's label or outline still wins with Alt) and a guard in `handleMultiSelection` (Shift-click never adds to a locked selection).

Records and Fabric objects (`src/editor/objects.ts`): `isLocked`, `setLocked`, `isImage`, `imageSizeOf`, `imageCropOf`, `setImageCrop`, `setImageElement`. `createObject` and `createFrame` apply the lock flags and the crop; `toRecord` and `toFrameRecord` emit them.

New files: `src/model/crop.ts`, `src/editor/cropLayer.ts`, `src/editor/layerList.ts`, `src/ui/LayerPanel.tsx`, and the tests and specs named in the README's Testing section.

## Where the branches will conflict

| File | What changed here | What to watch |
| --- | --- | --- |
| `src/model/types.ts` | `locked?` on `RecordBase` and `FrameRecord`; `CropRect`; `crop?` on `ImageRecord` | Additive. `TextRecord` itself was not touched. |
| `src/model/doc.ts` | `lockOf`/`cropOf` spread into `parseObject` and `parseFrame` returns; `storable()`; `serializeDoc` rewritten around it; `recordsEqual` made structural | The text branch edits the same `parseObject` text return and has its own omit-undefined and structural-compare code. Merge to one helper of each. |
| `src/editor/objects.ts` | `Meta.locked`; lock flags after each `meta.set`; crop in the image branch of `createObject` and `toRecord`; new exports | The Textbox branch of `createObject`/`toRecord` gained only the lock spread. A rich-text Textbox must keep `editable: false` when locked. |
| `src/editor/Editor.ts` | New state fields and their initial values; guards at the top of existing commands; `selectByIds`, `computeSelection`, `syncState`, `onSelection`; `text:changed`; `mouse:dblclick`; the capture `mousedown` listener and a capture `mousemove` listener; `onBlur`; `handleKeyDown`; `run()`; `applyToolState`; `finishEditing(opts)`; `getDoc`; `commit`; `enterReadOnly`; `dispose`; `idle`; the new command sections | The largest overlap. Most hunks are additive, but `handleKeyDown`, `run()`, `computeSelection`, `finishEditing` and the text event handlers are touched by both branches. |
| `src/ui/Inspector.tsx` | Heading helper split (`kindHeading` plus `heading`); Lock/Unlock button; `disabled` on font size, frame name and "Select with contents"; image tools and crop panel; `cropping` and `onReplace` props | Formatting controls for text must be disabled when `selection.locked` is true, and hidden or disabled while `cropping`. |
| `src/ui/Overlays.tsx` | Inspector and layer panel share a `.side-stack` column; one file input serves Add image and Replace image (mode in `data-replace-for`) | Conflicts if the Inspector is mounted differently. |
| `src/input/shortcuts.ts` | New action and Enter helper; Esc with Alt | `Ctrl/Cmd+B/I/U` are free here. `Ctrl/Cmd+Shift+L` is taken. |
| `src/editor/testing/fakeFabric.ts`, `fakes.ts` | Textbox honours `editable`; the fake image has crop fields, `getOriginalSize`, `setElement`; `FakeAssets` sizes and held decodes | Both branches extend the fakes. |
| `src/styles.css`, `src/ui/icons.tsx`, `README.md`, `AGENTS.md` | Additions | Textual only. |

## Open questions and known limits

These are recorded in the README's known limits and are the owner's to decide: Alt+double-click editing a covered text; a new text's owner (unchanged from before); no on-canvas marker for a locked item; "Select with contents" stays enabled for a frame that owns only locked things; the padlock button's accessibility inside a list option; no arrow-key navigation in the layer list; the crop overlay is drawn over objects lying on top of the image.

One limit is about verification rather than behaviour: Alt-drag was checked in Chromium under Playwright, which feeds input straight to the page. How Windows and each browser route a bare Alt press (menu focus) or Alt+Esc has not been checked by hand.
