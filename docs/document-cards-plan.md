# Architecture Plan: Rich Writing on Yuriful Canvas (Unified DOM/ProseMirror Text)

**Status:** Architectural plan with all 11 owner decisions settled on 2026-11-23 (planning only; nothing implemented). **Base:** `feat/captions-frame-navigation-nov22` at `89686c4` (local and `origin` agree). App code under `src/`, `e2e/` and `package.json` at `89686c4` is identical to `6ad246c`, the commit this plan was checked against (`git diff --stat 6ad246c 89686c4 -- src e2e package.json` is empty). Also inspected: `feat/milestone-2-frames` `98ea0f4`, `t3/capture-export` `21d0940`.

**How to read the citations:** `AGENTS.md:NN`, `README.md:NN`, `docs/rich-text-plan.md:NN` and line numbers marked "HEAD" were taken on `feat/milestone-2-frames` at `98ea0f4`; line numbers marked "captions-base" were taken at `6ad246c`. On the base branch `AGENTS.md` is a 95-line working guide, and the rules those citations point at live in `docs/expected-behavior.md` (feature rules) and `docs/engineering-reference.md` (project map, lifecycle checklist, review traps). Whoever implements a slice re-locates each cited rule in those two files before changing it.

## Read this first
**What changes for the person using the canvas:**
- **One text box for notes and long reviews:** `T`, click/drag, double-click, corner-scale, and frames work as today; inside the box you gain headings (`H1`–`H3`), lists, clickable checklists, quotes, dividers, inline/block code, live Markdown shortcuts with Backspace revert, and real step-by-step undo while typing, from `Ctrl/Cmd+Z` and from the toolbar Undo button alike (the whole edit is still 1 board undo step once you leave the box).
- **Paste keeps structure:** text copied from a web page or another card keeps its headings, lists, quotes and code; pasted plain Markdown is converted, and `Ctrl/Cmd+Z` straight after gives back the literal text (`Ctrl/Cmd+Shift+V` always pastes literally).
- **Auto-grow by default, scrollable on resize:** drag the bottom handle (`mb`) to lock a fixed height. The wheel scrolls a fixed-height card you are hovering; a scroll that starts on empty canvas keeps panning the board. Double-click `mb` or **Auto height** returns to auto-grow.
- **Paper by default:** a new text box sits on a padded paper background, with a **Paper** toggle to turn it off; existing boxes and new image captions stay bare.
- **Full z-order interleaving kept:** images and text interleave freely with frame outlines/labels crisp on top.
**Slice sequence** (each slice is a safe, independently reviewed checkpoint):
- **Spike 0** (throwaway): prove 10 Chromium/ProseMirror/SVG-bitmap claims, the tenth being idle-card scrolling (`S1`–`S10`) before coding.
- **Slice 1** *(no UI change)*: pure `RichDoc` AST, validator, legacy conversion, DB/wire v3 fence.
- **Slice 2a** *(no UI change)*: headless ProseMirror schema, Milestone-2 rules, and `EditSession`.
- **Slice 2b** *(no UI change)*: DOM `.scene-layer` and interleaved `renderFrameBitmap.ts` (standalone Vitest + Chromium harness).
- **Slice 2c-i** *(no UI change; Fabric default untouched)*: `TextAdapter` seam + static DOM proxies, transforms, frames, ownership.
- **Slice 2c-ii** *(no UI change; Fabric default untouched)*: live ProseMirror editing, pointer routing, occlusion, `EditSession`.
- **Slice 2c-iii** *(no UI change; Fabric default untouched)*: captions, crop, locks, duplicate, layer list, lift, frame previews on DOM path.
- **Slice 2d ← first visible change**: flip default to DOM/ProseMirror, migrate e2e probes, delete Fabric text path (crisp DOM text, step-by-step undo while typing from keyboard and toolbar, full interleaving; dragging words from one box into another is retired).
- **Slice 3a ← rich writing blocks**: lists, checklists, quotes, dividers, code, live Markdown shortcuts, `Tab` to indent in lists; a card holding only a divider or a ticked box is kept.
- **Slice 3b ← paste**: HTML paste keeps structure; plain Markdown paste converts, with literal undo and `Ctrl/Cmd+Shift+V`.
- **Slice 4 ← fixed scrollable height**: `mb` handle, overlay scroll thumb, wheel scrolls a hovered card, top/bottom fades, Auto height reset.
- **Slice 5 ← paper**: new text boxes get paper and padding; Inspector **Paper** toggle; design pass on paper colour and edge.
**Owner decisions** *(all settled 2026-11-23; detail in Section 15)*: **#1** A, DB/wire v3 fence · **#2** A, base on `feat/captions-frame-navigation-nov22` · **#3** A, keep today's two wrapping behaviours · **#4** B, a divider or ticked box counts as content · **#5** C, structural HTML paste plus Markdown conversion · **#6** A, retire cross-box text drag · **#7** A, `- ` only · **#8** A, `Tab` indents in lists · **#9** B, wheel scrolls a hovered card, with the "belongs to where it started" rule · **#10** B, paper by default · **#11** B, toolbar Undo/Redo step through typing while editing.

---

## 1. Honest pricing: what z-order interleaving costs

Keeping **full image-over-text z-order interleaving** (instead of floating all text above all images) carries concrete costs:

**Exists ONLY because images may sit in front of text:**
- **DOM images & frame paper (`sceneLayer.ts`):** Fabric paints all objects onto one `lowerCanvasEl` (`node_modules/fabric/src/canvas/StaticCanvas.ts:553-557`), so frame paper, images, and text must share one DOM `.scene-layer` in `objects[]` order.
- **CSS crop, drag-lift & occlusion:** Image crop (`overflow: hidden` + inner `<img>` translate + uncropped reveal under `cropLayer.ts`), drag-lift shadows (`.is-lifted` for `feedbackLayer.ts`), and front-object edit occlusion/cursor checks live in DOM/CSS rather than Fabric.
- **Interleaved bitmap compositor & probe migration:** `renderFrameBitmap.ts` interleaves `ctx.drawImage` with per-card SVG `<foreignObject>` draws; image/frame e2e pixel probes migrate off `lower-canvas`.

**Ongoing costs after this milestone:**
- **Dual rendering & parallel DOM sync:** Future visual effects (filters, borders, shadows, rounded corners, tint, opacity, masks, surfaces) must be built twice (DOM/CSS + `renderFrameBitmap.ts`), and image crop/replace/lift + occlusion checks must stay aligned with Fabric proxies.
- **Legacy re-wrapping drift:** DOM shaping differs slightly from Canvas 2D `measureText`, so borderline lines on older boards may wrap a word earlier/later (Section 6). *(Unaffected: `src/model/`, `src/persistence/`, `src/ui/`.)*

---

## 2. Scope of this milestone and what is cut

### In scope (Writing Core)
1. **Pure rich-document model & storage safety (Slice 1):** AST (`RichDoc`), strict/lenient allowlisted bounded validator, canonical form, legacy UTF-16 `spans`/`headings` <-> `RichDoc` conversion, semantic blankness, and storage version fencing (wire v3 / DB v3, Owner Decision 1).
2. **Staged DOM scene + ProseMirror text switch with full Milestone 2 parity (Slices 2a–2d):** six independently reviewable commits — headless ProseMirror engine (`2a`), DOM scene + bitmap compositor (`2b`), test-only wired dual path split into `2c-i` (`TextAdapter` + static proxies/transforms/frames), `2c-ii` (editing/routing), and `2c-iii` (crop/captions/locks/duplicate/layer-list/previews), then the final renderer flip + e2e probe migration + deletion of the old Fabric path (`2d`).
3. **Long-form writing blocks & live Markdown (Slice 3a):** bullet lists, numbered lists, interactive checklists, blockquotes, horizontal dividers, inline code, fenced code blocks; live typing shortcuts with Backspace revert; `Tab`/`Shift+Tab` indent and outdent in lists; Inspector block controls.
4. **Paste (Slice 3b):** local-only clipboard HTML sanitization that keeps structural blocks, and conversion of pasted plain Markdown by a pure converter, with literal undo and a literal-paste shortcut (Owner Decision 5, Option C).
5. **Auto-grow / manual fixed scrollable height (Slice 4):** bottom handle (`mb`) sets fixed scrollable `height`, non-reflowing overlay scroll thumb, top/bottom fades, wheel scrolls a hovered fixed-height card under the wheel-ownership rule (Owner Decision 9, Option B), corner scale folds `height` once, double-click `mb` or Inspector button restores auto-grow.
6. **Paper surface (Slice 5):** new text boxes are created with `surface: 'card'` (paper background and padding); an Inspector **Paper** toggle turns it on or off per box; existing boxes and captions made with **Add caption** stay bare (Owner Decision 10, Option B).

### Explicitly cut (deferred; seams kept clean)
- **Docked Focus Mode:** Cut. Synchronizing two live views of one document, dual scroll/selection/IME state, and docked-vs-canvas undo is a separate milestone. `EditSession` mounts `EditorView` into any container element, keeping the seam open.
- **Floating selection formatting bar:** Cut. The Inspector already provides non-focus-stealing formatting buttons (`src/ui/Inspector.tsx:280-282`); floating positioning under rotation/zoom/scroll is polish, not core writing.
- **Markdown file export / import:** Cut. Markdown cannot represent per-range fonts, underline, colour, or alignment, and frame export requires a reading-order rule. (Converting pasted Markdown is in scope, Slice 3b; it reads Markdown in and never writes it out.)
- **Font selector expansion & custom colour pickers:** Deferred per owner instruction ("come later"). The existing 5 system font choices and 8-colour palette stay as-is. A paper colour picker is part of this deferral: paper has one colour, set in CSS.
- **Unifying the two wrapping behaviours** (Owner Decision 3, Option B): not in this milestone. It can follow as its own small change after the flip.
- **Links, tables, inline images inside cards, word count, mobile/touch.**

---

## 3. Base branch

### Verified branch topology (read-only inspection)
- `feat/milestone-2-frames` at `98ea0f4` (21 commits ahead of `origin/feat/milestone-2-frames` `698b628`). Contains `AGENTS.md` and `CLAUDE.md`.
- **Chosen base:** `feat/captions-frame-navigation-nov22` at `89686c4`, equal to `origin/feat/captions-frame-navigation-nov22` (checked 2026-11-23). `89686c4` sits directly on `6ad246c` and adds only project skills, the slimmer `AGENTS.md`, `docs/expected-behavior.md`, `docs/engineering-reference.md`, `docs/PROJECT_SKILLS.md` and this plan; no file under `src/` or `e2e/` differs. It contains `AGENTS.md`, `CLAUDE.md`, `.agents/skills/` and `.claude/skills/`, as `AGENTS.md` requires of a base. `6ad246c` already integrates `feat/milestone-2-frames` (rich text + dragged text boxes) **and** `feat/layers-image-tools` (locks, layer list, image crop/fit/fill/replace, duplicate, align, board appearance), plus attached captions (`captionOf`, `captionSide`, `captionPosition`, `captionBackground` on `TextRecord`) and `src/editor/framePreview.ts` (`renderFramePreview` via detached `StaticCanvas`). Contains both `AGENTS.md` and `CLAUDE.md`.
- `t3/capture-export` at `21d0940`: descends from `feat/editor-polish-nov19` and adds `src/editor/exportFrame.ts` (`renderFramePng` via detached `StaticCanvas`), image clipboard paste, double-click empty canvas to type, and Fit toggle.

### Decision (Owner Decision 2, settled 2026-11-23)
- **Base:** `feat/captions-frame-navigation-nov22` at `89686c4`. New work branches from it; `t3/capture-export` is not part of the base, so `exportFrame.ts` is handled when that branch is integrated (Section 10 keeps the compositor ready for it).
- **Why:** Basing on `feat/milestone-2-frames` (`98ea0f4`) would mean building the DOM scene layer blind to image crop (`cropLayer.ts`), object locks (`isLocked`), captions (`captionBackground`, `followsDrag`), and `framePreview.ts`, creating a major merge conflict later.
- **What must be preserved from the base (and later from `t3/capture-export`):**
  - **Image crop / Fit / Fill / Replace (`cropLayer.ts`, `Editor.ts:1975-2025`, `objects.ts:662-700`):** `.scene-image` uses an `overflow: hidden` box sized to `(crop?.width ?? naturalWidth) × (crop?.height ?? naturalHeight)` with inner `<img>` offset by `translate(-crop.x px, -crop.y px)`. During crop mode, `SceneRenderer` reveals the full uncropped `<img>` beneath `lowerCanvasEl`'s `drawCropOverlay` (`cropLayer.ts:69-105`). `isImage(obj)` checks `meta.get(obj)?.kind === 'image'` instead of `obj instanceof FabricImage` (`objects.ts:662`).
  - **Locks (`locked?: true`, `objects.ts:92`, `Editor.ts:2977`):** Locked proxies keep `evented: false, selectable: false, hasControls: false`; `startEditing`, `formatTarget`, and every formatting/block command check `isLocked(proxy)`.
  - **Captions & caption snap (`captionSnapLayer.ts`, `Editor.ts:631` `syncCaptions`, `objects.ts:42, 499`):** A caption is a `TextRecord` (`isText(proxy)`). `.scene-text` applies `background: rec.captionBackground` when present, follows its image via `syncCaptions`/`followsDrag`, and edits with ProseMirror. `captionSnapLayer.ts`'s `makeSnapCaption` measures a DOM/offscreen card probe instead of constructing a `Textbox`; `drawCaptionSnap` stays on `lowerCanvasEl`.
  - **Layer list (`layerList.ts:52-55`), drag feedback (`feedbackLayer.ts`), and duplicate (`Editor.ts:2777` `duplicateSelection`):** `layerList.ts` replaces `o instanceof Textbox` with `isText(o)` + `plainTextOf` / `textData`; `feedbackLayer.ts` keeps canvas drop/snap overlays while lifted-item drag shadows move to CSS `.is-lifted` on `.scene-item` (since proxies have no-op `_render()`); `duplicateSelection` clones `TextRecord` (`blocks`/`height`/`caption*`) and `ImageRecord` (`crop`/`locked`) through the proxy factory.
  - **Frame previews (`framePreview.ts`) & PNG export (`exportFrame.ts`):** Both delegate to the new `renderFrameBitmap.ts` compositor (Section 10) instead of detached `StaticCanvas` + `createObject`.

---

## 4. Paint and input stack

### Verified Fabric 7.4.0 constraints
- `StaticCanvas.renderCanvas` (`node_modules/fabric/src/canvas/StaticCanvas.ts:535-577`) clears `lowerCanvasEl`, fires `before:render`, renders objects (`_renderObjects`), draws selection borders/handles (`drawControls`, `SelectableCanvas.ts:1423-1429`), then fires `after:render` (`FrameCanvas.ts:27-40` draws frame outlines, labels, and `this.draft`).
- `CanvasDOMManager` (`node_modules/fabric/src/canvas/DOMManagers/CanvasDOMManager.ts:44-50`) wraps `lowerCanvasEl` and `upperCanvasEl` in `wrapperEl`.
- `Canvas` (`node_modules/fabric/src/canvas/Canvas.ts:168-196, 675-696`) listens for `mousedown`/`dblclick`/`wheel` on `upperCanvasEl`, then binds `mousemove`/`mouseup` on `document` for the duration of a drag.
- `SelectableCanvas._checkTarget` (`SelectableCanvas.ts:903-923`) requires `obj.visible && obj.evented`; `FrameCanvas.ts:33` requires `obj.visible` to draw frame outlines/labels.

### Surface & paint order (back to front)

```text
.workspace  (z: 0)  Board background colour + dot/grid pattern (src/App.tsx:35-38)
└── .editor-stage   (position: relative; inset: 0)  <-- capture-phase mousedown/wheel owner
    ├── .scene-layer  (z: 1, position: absolute; inset: 0; overflow: clip; pointer-events: none)
    │   └── .scene-world  (transform-origin: 0 0; transform: matrix(zoom, 0, 0, zoom, panX, panY))
    │       ├── .scene-frames  (z: 0)
    │       │   └── .scene-frame[data-id]   White paper (#ffffff), unrotated, exact frame rect
    │       └── .scene-objects (z: 1)       Exact `objects[]` z-order, back to front
    │           ├── .scene-item.scene-image[data-id]   <img> (with crop wrapper if cropped)
    │           ├── .scene-item.scene-text[data-id]    Static HTML (idle) OR mounted EditorView (editing)
    │           └── .scene-item.scene-image[data-id]   Image in front of text (stays visually in front!)
    │
    └── .canvas-host  (z: 2, position: absolute; inset: 0; Fabric wrapperEl)
        ├── canvas.lower-canvas  (transparent bg; ALL Fabric proxies have no-op `_render() {}` so
        │                         objects & frames paint ZERO pixels here; paints ONLY:
        │                         1. selection borders & corner/side/bottom handles (`drawControls`)
        │                         2. frame outlines, frame labels, dashed `draft` rect (`after:render`)
        │                         3. crop dim/handles & drag feedback if on captions base)
        └── canvas.upper-canvas  (transparent; paints marquee `_drawSelection`; receives pointer
                                  events whenever NOT editing a text card)

.overlays   (z: 3, sibling of .editor-stage; pointer-events: none; > * pointer-events: auto)
            Toolbar, Inspector (buttons prevent mousedown default), History/Zoom controls, Banner, Toasts
```

**Why this closes Findings 1 and 2:**
- Frame paper sits in `.scene-frames` (`z: 0` inside `.scene-world`), behind all content.
- Images and text cards interleave in exact `objects[]` order inside `.scene-objects` (`z: 1` inside `.scene-world`).
- `lowerCanvasEl` (`z: 2`) never paints frame fills (`FRAME_FILL` is moved to `.scene-frame` CSS), so it never covers content, while selection handles, frame outlines, frame labels, and the draft rectangle always render crisp at screen pixel ratio on top of every image and text card.
- `SceneRenderer.syncFrame()` runs inside Fabric's `before:render` callback (`ctx === canvas.getContext()`), so `.scene-world` and every moved/scaled DOM item update in the **same animation frame** as `lowerCanvasEl` chrome.

### Pointer and wheel routing table (closes Finding 3)

While **not editing**: `.canvas-host` has `pointer-events: auto`; `.scene-layer` has `pointer-events: none`.
While **editing card `T`**: `.canvas-host` has `pointer-events: none`; `.scene-layer` keeps `pointer-events: none`, EXCEPT `.scene-text[data-id="T"]` has `pointer-events: auto` (its handles are hidden while editing, matching Fabric 7.4 `node_modules/fabric/src/shapes/IText/ITextBehavior.ts:480`, noted at `src/editor/Editor.ts:718`; an accent CSS `outline` marks the edited box without shifting layout) AND every unlocked `.scene-item` with index `> indexOf(T)` in `.scene-objects` gets `pointer-events: auto; cursor: default` so hovering an image covering `T` shows the default pointer instead of `T`'s text I-beam (clicks on it are still intercepted first by `.editor-stage`'s capture handler).
A capture-phase `mousedown` and non-passive `wheel` listener on `.editor-stage` (replacing `wrapper` in `Editor.ts:1107-1197`) mediates every event:

| State | Primary `mousedown` | `dblclick` | Drag / release outside window | Non-primary buttons (`1` middle / `2` right) | Wheel (plain / `Ctrl\|Cmd`) |
|---|---|---|---|---|---|
| **Loading (`!live`)** | Capture `preventDefault` + `stopPropagation`. Inert. | Blocked. | Blocked. | Blocked. | `preventDefault`; ignored. |
| **Read-only** | `handActive` is always true (`Editor.ts:383`): capture starts `beginPan(e)`. No selection or editing. | Blocked (pan). | Window `mousemove` pans; `window` capture `mouseup` / `blur` / `buttons` bit check ends pan (`Editor.ts:1264-1285`). | Middle: pans. Right: blocked. | Plain: wheel-ownership rule below (a fixed-height card may scroll; scrolling stores nothing). `Ctrl/Cmd`: zooms. |
| **Idle / Selected (Select tool)** | Reaches `upperCanvasEl` -> Fabric selects, starts drag/scale/rotate/marquee. `primaryDown = true`. | Reaches `upperCanvasEl` -> `mouse:dblclick`: if `isText(target)` and `!isLocked(target)` -> `startEditing(target, e)`. If `isFrame(target)` -> `frameRenamer()`. | Fabric tracks on `document` `mousemove`/`mouseup` (`Canvas.ts:688-694`). Release outside window still reaches `document`. Window `blur` cancels gesture & restores `base`. Lost release healed by `healPrimaryDown` (`Editor.ts:1256`). | Blocked from Fabric (`stopPropagation` + `preventDefault`). Middle starts pan unless `primaryDown`. Non-primary release during primary drag stopped in window capture (`Editor.ts:1165`). | Plain: wheel-ownership rule below (pans, or scrolls the fixed-height card the wheel gesture started on). `Ctrl/Cmd`: zooms. |
| **Hand / Space held** | Capture `preventDefault` + `stopPropagation`, `finishEditing()`, `beginPan(e)`. | Blocked. | Window pan; ends on release or `blur`. | Middle: pans (if not already panning). Right: blocked. | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Draft (Frame or Text tool)** | On empty canvas or frame interior: `upperCanvasEl` -> `mouse:down` starts `Gesture.draft`. On object or frame outline/label (Text tool): Fabric selects/drags target. | N/A. | `document` `mousemove` updates `canvas.draft`; `mouse:up` settles in microtask (works even released over toolbar, `e2e/texttool.spec.ts:150`). `Esc`/`blur`/read-only cancels. | Blocked from Fabric (never ends/cancels draft, `e2e/texttool.spec.ts:300`). | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Transforming (`busy`)** | Ignored / single active transform. | Ignored. | Fabric tracks to `document` `mouseup`; settles in 1 microtask. `Esc`/`blur`/read-only restores `g.base`. | Blocked from Fabric (`e2e/gestures.spec.ts:225`). | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Editing card `T`** | Capture on `.editor-stage` checks in order:<br>1. **Frame outline/label hit** (`canvas.frameOverlayAt`): wins over `T` -> **Outside path**.<br>2. **Front object occlusion** (any unlocked object with index `> indexOf(T)` whose proxy `_checkTarget` hits scene point): wins over `T` -> **Outside path**.<br>3. **Target is inside `T`'s DOM node** (text, checkbox, overlay scroll thumb): **pass through untouched** to browser + ProseMirror!<br>4. **Anything else** (empty canvas, frame interior, object behind `T`): **Outside path**. | Inside unobstructed `T`: native browser word-select (and triple-click paragraph-select). Outside `T`: first `mousedown` already exited edit and restored `upperCanvasEl`, so 2nd click + `dblclick` land on `upperCanvasEl` (e.g. double-clicking card `B` directly opens `B`!). | Inside `T`: native DOM drag-selection or overlay scroll thumb drag (tracked natively even if released outside window; Fabric never sees press, `primaryDown` stays `false`). Outside `T`: see Outside path below. | Middle: `finishEditing()`, `beginPan(e)`, `preventDefault`. Right: inside unobstructed `T`, allow native context menu (do not pass to Fabric); outside `T`, block (`preventDefault` + `stopPropagation`). | `Ctrl/Cmd+wheel`: always zooms canvas (`preventDefault`). Plain wheel: the same wheel-ownership rule below, for `T` and for any other fixed-height card; the listener always calls `preventDefault` and scrolls by setting `scrollTop`, never natively. |

### Wheel ownership (Owner Decision 9, Option B: "a scroll belongs to whatever it started on")
Today one non-passive `wheel` listener calls `preventDefault` on every event, normalises `deltaMode` to pixels, zooms on `Ctrl/Cmd`, and otherwise pans, with `Shift` turning a vertical wheel into a horizontal pan (captions-base `Editor.ts:1638-1657`). It moves to `.editor-stage` and gains one decision:
- **Wheel gesture:** consecutive plain wheel events less than `WHEEL_LATCH_MS = 180` apart are one gesture (a trackpad's inertial tail stays in the gesture). The **first** event picks the owner; every later event of the gesture goes to that owner, whatever is under the pointer by then. A `Ctrl/Cmd` wheel event zooms and ends the gesture.
- **Picking the owner (first event only):** the owner is card `C` when all of these hold, otherwise the canvas:
  1. The board is loaded, the hand tool and Space are not in effect, and no gesture or draft is unsettled (wheel during a drag keeps panning, as `docs/expected-behavior.md:20` requires).
  2. `Shift` is not held and the event is mostly vertical (`|deltaY| >= |deltaX|`).
  3. No frame label or outline is under the pointer (`canvas.frameOverlayAt`), and `C` is the front-most object whose box contains the pointer's scene point, walking `objects[]` front to back. Locked objects count in this walk: scrolling stores nothing, so a locked card can be read, and a locked image in front still blocks.
  4. `C` is a text card with a fixed `height`, `scrollHeight > clientHeight`, and room left to scroll in the event's direction.
- **Owner is a card:** `body.scrollTop = clamp(body.scrollTop + deltaY * unit / zoom, 0, scrollHeight - clientHeight)`, so the text moves the same distance on screen as the board would have; `deltaX` is dropped. At either end the card simply stops: the board never starts moving in the middle of a gesture. Because of condition 4, the **next** gesture in that direction belongs to the canvas, so a second flick moves the board on.
- **Owner is the canvas:** today's pan, unchanged. Cards passing under the pointer never take over.
- **Read-only board:** the rule applies as written (a long card can be read; nothing is written). **Loading:** wheel ignored, as today.
- **What it never does:** change history, mark the board dirty, change selection, or end a text edit.
- **Held in reserve, not built:** require `C` to be selected or being edited (one extra condition in step 4). Adopt it only if panning across scrollable cards still feels sticky in use; that is the owner's call after trying Slice 4.
- **UNVERIFIED: Spike 0 S10** (setting `scrollTop` on a rotated, zoomed, `pointer-events: none` card; whether `180 ms` holds a precision trackpad's inertia together).

### Exact "Outside path" mechanism (one click ends edit AND acts on what was pressed)
When a primary `mousedown` hits outside unobstructed `T` (including a frame outline/label over `T`, or image `I` covering part of `T`):
1. `e.preventDefault(); e.stopPropagation();` stops the `.scene-layer` event from doing anything further.
2. Call `this.finishEditing()` synchronously:
   - Unmounts `EditorView`, keeps `T`'s `scrollTop` where it is (Owner Decision 9, Section 6), restores static HTML in `T`, restores `.canvas-host { pointer-events: auto }` and clears covering-item `pointer-events`, commits the edit (or, if `T` is blank, hides/disables `T`'s proxy, discards it from active selection so a Shift-click cannot form `{T, other}`, and queues `canvas.remove(proxy)`).
3. Synchronously re-dispatch a cloned `MouseEvent('mousedown', ...)` (preserving `clientX/Y`, `button`, `buttons`, `shiftKey`, `ctrlKey`, `altKey`, `metaKey`, `detail`) onto `this.canvas.upperCanvasEl`:
   - Runs through `Editor`'s capture listener (sets `primaryDown = true`),
   - Runs Fabric's `_onMouseDown` (`Canvas.ts:675`), which selects the clicked object (or toggles Shift-click selection, or starts dragging it, or starts a marquee, or starts a Text-tool draft when Text tool is active — satisfying `e2e/gestures.spec.ts:183,195` and `e2e/texttool.spec.ts:477`), and binds `document` `mousemove`/`mouseup` so dragging continues seamlessly without releasing the mouse!
   - **UNVERIFIED: prove in the spike** (Spike 0 verifies synthetic `mousedown` forwarding starts real Fabric drags, marquees, Shift-clicks, and Text-tool drafts cleanly in Chromium).

### What is shown and hit when `T` is partly covered by image `I` in front of it
- **Visually:** `T` stays at its true `objects[]` slot in `.scene-objects`, so `I` remains visually in front of the overlapped region of `T` (no z-popping surprise).
- **Cursor & hit testing:** Because unlocked items above `T` take `pointer-events: auto; cursor: default` during editing, hovering `I` shows the default pointer rather than `T`'s text caret; clicking the overlapped pixels of `I` triggers `.editor-stage`'s capture occlusion check -> Outside path -> ends edit on `T` and selects/drags `I`. Clicking the uncovered pixels of `T` places the caret natively in `T`.

---

## 5. Records, validation, versions, migration

### Exact record shape (`src/model/types.ts` + `src/model/textDoc.ts`)
`src/model/` stays **100% pure** (no ProseMirror, Fabric, or DOM imports).

```ts
export type TextMark = 'bold' | 'italic' | 'underline' | 'strike' | 'code'

export interface InlineRun {
  /** Non-empty text; never contains '\n'. */
  text: string
  bold?: true
  italic?: true
  underline?: true
  strike?: true
  code?: true
  /** Present only when different from the box's base font. */
  font?: FontId
}

export interface ListItemNode {
  blocks: BlockNode[] // non-empty
}

export interface TaskItemNode {
  checked: boolean
  blocks: BlockNode[] // non-empty
}

export type BlockNode =
  | { type: 'paragraph'; content?: InlineRun[] } // content omitted when empty
  | { type: 'heading'; level: 1 | 2 | 3; content?: InlineRun[] }
  | { type: 'bulletList'; items: ListItemNode[] }
  | { type: 'orderedList'; start?: number; items: ListItemNode[] } // start omitted when 1
  | { type: 'taskList'; items: TaskItemNode[] }
  | { type: 'blockquote'; blocks: BlockNode[] }
  | { type: 'codeBlock'; text: string }
  | { type: 'divider' }

export interface TextRecord extends RecordBase {
  type: 'text'
  /** Always a string. When `blocks` is present, this is the canonical plain-text projection of `blocks`. */
  text: string
  fontSize: number
  width: number
  /** Auto-grow floor in scene units (Text-tool drag). Absent on click-created/older boxes. */
  minHeight?: number
  /** Manual fixed scrollable height in scene units (Slice 4). Absent = auto-grow. */
  height?: number
  font?: FontId                 // absent: 'sans'
  align?: 'center' | 'right'    // absent: 'left'
  color?: string                // `#rrggbb` lower-case; absent: '#1d2230'
  /** Present ONLY when `blocks` is absent (compact Milestone 2 form). */
  spans?: TextSpan[]
  headings?: number[]
  /** Present ONLY when the document uses rich blocks or inline `code`. */
  blocks?: BlockNode[]
  /**
   * Paper background and padding (Slice 5). Absent = bare text, which is every box stored before
   * Slice 5 and every caption made with Add caption. New text boxes are created with 'card'.
   * Only this flag is stored: paper colour, padding, radius and edge are CSS constants.
   */
  surface?: 'card'
  // On captions base, existing optional fields remain untouched:
  // captionOf?: string; captionSide?: CaptionSide; captionPosition?: number; captionBackground?: string
}
```

### Example wire JSON

**1. Legacy / compact note (no rich blocks, no fixed height -> wire v1 when frameless, v2 when framed):**
```json
{ "id": "note-1", "type": "text", "left": 100, "top": 120, "angle": 0, "text": "Title\nSome bold words", "fontSize": 24, "width": 320, "headings": [1], "spans": [{ "start": 11, "end": 15, "bold": true }] }
```

**2. Rich review card (has `blocks` and fixed `height` -> triggers wire v3 / DB v3 fence):**
```json
{
  "id": "rev-1", "type": "text", "left": 140, "top": 90, "angle": 0,
  "text": "Blue Lines\nWarm bassline\nCheck 2012 remaster\nSide B", "fontSize": 18, "width": 480, "height": 360,
  "blocks": [
    { "type": "heading", "level": 1, "content": [{ "text": "Blue Lines" }] },
    { "type": "blockquote", "blocks": [{ "type": "paragraph", "content": [{ "text": "Warm bassline", "italic": true }] }] },
    { "type": "taskList", "items": [{ "checked": false, "blocks": [{ "type": "paragraph", "content": [{ "text": "Check 2012 remaster" }] }] }] },
    { "type": "divider" },
    { "type": "paragraph", "content": [{ "text": "Side B", "code": true }] }
  ]
}
```

**3. Invalid documents (strictly rejected -> `parseDoc` returns `null` -> fail-closed read-only):**
- `{ "version": 4, ... }` (unknown version), `{ "type": "text", ..., "blocks": [{ "type": "table", "rows": [] }] }` (unknown block type: **never** silently dropped), `"blocks": "oops"` (non-array), `fontSize <= 0`, `width <= 0`, or depth/node/length bounds exceeded.

### Pure validator, canonical form, strict vs lenient, and emptiness (`src/model/textDoc.ts`)
- **Bounds:** `MAX_BLOCK_DEPTH = 6`, `MAX_NODES = 10_000`, `MAX_TEXT_LENGTH = 500_000` UTF-16 code units. Exceeding any bound is a strict validation failure (`null`).
  - **Nothing over a bound is ever written (added after the Slice 1 review).** A text stored as `blocks` has these bounds while a compact text has none, so a card could otherwise be typed or pasted past them, saved, and then refuse to load. Two guards: (1) the store canonicalizes every rich text on the way out and refuses to write a document `parseDoc` would not read back, leaving the row and the database version untouched (Slice 1); (2) from Slice 3a, `EditSession` rejects, through a ProseMirror `filterTransaction`, any transaction whose result would be stored as `blocks` and exceed a bound, so the person sees the keystroke or paste not happen rather than a failed save. Pinned in Slice 3a by `a-card-cannot-grow-past-the-stored-bounds`.
- **Strict (returns `null` -> read-only):** unknown doc `version`, duplicate IDs, bad base geometry (`id`, `left`, `top`, `angle`, `fontSize <= 0`, `width <= 0`), non-string `text`, malformed `blocks` container (non-array, empty array, unknown block `type`, invalid `items`/`blocks` child array, invalid `heading.level` outside `1|2|3`, non-string `codeBlock.text`, exceeded depth/node/length bounds).
- **Lenient (cleaned to valid canonical form, matching `AGENTS.md:120`):** invalid `font`, `align`, `color`, `spans`, `headings`, `minHeight` (`< 0` or non-finite -> omitted), `height` (`<= 0` or non-finite -> omitted), `surface` (not `'card'` -> omitted), dangling `frameId`, non-integer `orderedList.start < 1` (-> `1`, omitted), non-boolean `taskItem.checked` (-> `false`), unknown extra properties on valid `InlineRun`/`BlockNode` (dropped by allowlist).
- **Canonical form & `blocks` vs `text` authority (guarantees exact `sceneEqual` so a no-op commit records nothing):**
  1. Keys in fixed order (`InlineRun`: `text`, `bold`, `italic`, `underline`, `strike`, `code`, `font`). Only `true` marks; never `false`/`undefined`.
  2. `bold` is stripped from all `InlineRun`s inside `heading` nodes.
  3. `font` override is stripped when equal to the box's base `font`.
  4. Zero-length `InlineRun`s dropped; adjacent runs with identical marks+font merged; empty `content: []` omitted.
  5. **Single canonical form & authority on disagreement:** if `blocks` has only top-level `paragraph`/`heading(1..3)` and no `code` mark, collapse to `{ text, spans?, headings? }` with `blocks` omitted. Otherwise **`blocks` is authoritative**: `parseDoc` checks `typeof raw.text === 'string'`, overwrites `rec.text = plainTextOf(blocks)` if they disagree, and omits `spans`/`headings`. `text` stays on wire in v3 solely for a uniform `{ type: 'text', text }` shape in raw-IDB debugging, layer labels (`layerList.ts:24`), and test probes (`e2e/helpers.ts` `storedDoc`).
  6. Never stored or compared: caret/selection, `scrollTop`, `storedMarks`, ProseMirror history, `shortcutRevert`.
- **Semantic emptiness (`isBlankTextDoc` — Owner Decision 4, Option B):**
  - A text is blank exactly when `plainTextOf(blocks).trim() === ''` **and** the tree holds no `divider` and no checked `taskItem`. Before Slice 3a neither node exists, so this is today's rule (`AGENTS.md:88`) until then. Typing only `# `, `- `, `> `, or `- [ ] ` and pressing Esc still discards the new card with no history/save (`e2e/typing.spec.ts:349`); typing `---` or `- [x] ` makes the card content at once, so it is saved as typing is and kept on exit.
  - A kept card with no visible characters stores a whitespace-only `text` beside its `blocks` (`''` for one divider; one line break for two empty ticked checkboxes, since `plainTextOf` puts each paragraph on its own line); `parseDoc` already requires only that `text` is a string (captions-base `doc.ts:73`). Its layer-list row would be empty (`textLabel` in captions-base `layerList.ts:22-25`), so the row falls back to `'Text'`, the way an unnamed image falls back to `'Image'` (`layerList.ts:66`).
  - **Existing card emptied to an empty list** (bullet/numbered/unchecked task): blank -> excluded from `snapshot()` while open (no intermediate save or premature removal on font-size/formatting, `Editor.ts:1655, 1684`); discarded on `finishEditing()` and committed as 1 board undo step (`Editor.ts:771-792`), so Undo restores the card.
- **Legacy conversion (`legacyToBlocks` / `blocksToLegacy`):**
  - Uses `paragraphsOf(text)` (`src/model/richText.ts:90`) so `\r\n` is one line break, surrogate pairs and ZWJ emoji are never split (`splitGraphemes`), and UTF-16 `TextSpan` offsets map cleanly per paragraph into `InlineRun[]`.
  - Empty heading lines (`headings[i] > 0` with empty text) become `{ type: 'heading', level }` (no placeholder character needed).
  - ProseMirror node-boundary offsets (`+1` per block open/close) exist ONLY inside `src/editor/textSchema.ts` during live editing and never leak into `src/model/`.

### Storage versions & fencing against older and sibling builds (Finding 8 — Owner Decision 1)
Today `FENCED_DB_VERSION = 2` (`src/persistence/boardStore.ts:90`) and `parseDoc` accepts versions `1` and `2` (`src/model/doc.ts:58`) on every existing branch (`feat/milestone-2-frames` `98ea0f4`, `origin/feat/captions-frame-navigation-nov22` `6ad246c`, and `t3/capture-export` `21d0940`). Because this owner runs multiple worktrees on the same origin, writing `blocks` or `height` into DB v2 would let an older or sibling tab open the board, silently drop `blocks`/`height` via `parseObject`'s allowlist (`doc.ts:23-41`), and overwrite the board with a valid revision token.

**Design, approved as Owner Decision 1 Option A (mirrors Milestone 2's exact atomic fence at `boardStore.ts:366-443`):**
- `DOC_VERSION = 3`, `FENCED_DB_VERSION = 3`. `parseDoc` accepts wire versions `1 | 2 | 3`.
- `needsRichFence(doc)` is true iff any `TextRecord` has `blocks !== undefined`, `height !== undefined`, or `surface !== undefined`.
- `serializeDoc(doc)` emits:
  - `version: 3` (`frames` always present, even `[]`) when `needsRichFence(doc)`;
  - `version: 2` when `!needsRichFence(doc) && doc.frames.length > 0`;
  - `version: 1` otherwise.
- `IndexedDbBoardStore.save` promotes the DB to `version = 3` in the **same `versionchange` transaction** as the first `version: 3` write (extending `boardStore.ts:310-316`).
- **A build never edits a rich field it cannot round-trip (added 2026-11-23, when implementation began).** From Slice 1 every build parses v3, but the editor cannot draw or re-save `blocks` until Slice 3a, `height` until Slice 4 or `surface` until Slice 5. The owner keeps several checkouts on one origin, so a board saved by a later slice can be opened by an earlier one, which would show the plain text and drop the rich field on its next save, behind a valid revision token. So `src/model/textDoc.ts` exports `EDITABLE_RICH_FIELDS: ReadonlySet<'blocks' | 'height' | 'surface'>` (empty in Slice 1; Slice 3a adds `'blocks'`, Slice 4 `'height'`, Slice 5 `'surface'`) and `uneditableRichFields(doc)`. Loading a board that uses a field outside the set ends read-only with the newer-build message, exactly like a newer database: no selection, no edits, no writes, no pruning. Pinned in Slice 1 by `rich-board-opens-read-only-until-its-slice`.

| Scenario | Wire written | DB version after | Behaviour (verified against `boardStore.ts` & `autosave.ts`) |
|---|---|---|---|
| Old v1/v2 board opened, not edited | None (no write) | Unchanged (1 or 2) | Loading never rewrites the row (`AGENTS.md:122`). |
| Old v1 board opened, edited without frames/rich cards | `v1` | `1` | Keeps Milestone 1 wire shape. |
| Old v1 board, frameless, user adds checklist / manual height | `v3` | `1 -> 3` (atomic) | Upgrades DB in write tx; older v1/v2 tabs blocked from overwriting. |
| From Slice 5: any board, user creates a new text box (paper by default, `surface: 'card'`) and types in it | `v3` | `-> 3` (atomic) | Consequence of Owner Decision 10: the first new text box on a board is what triggers the one-way upgrade. A blank new box is never saved, so opening the Text tool and pressing Esc upgrades nothing. |
| Old v1 board, user adds first frame (plain text only) | `v2` | `1 -> 2` (atomic) | Existing Milestone 2 behavior preserved. |
| v3 board, user deletes last frame (rich card remains) | `v3` (`frames: []`) | `3` | Stays v3; DB never demotes. |
| v3 board, user deletes all rich cards & frames | `v1` | `3` (not demoted) | Matches `e2e/frames.spec.ts:596`; old tabs still cannot reopen DB v3. |
| Already-open current-build tab (`FENCED_DB_VERSION = 2`) when new tab saves first v3 board | `v3` | `3` | Old tab's `onversionchange` (`boardStore.ts:243`) closes its connection (`:239-242`), unblocking upgrade. Next save/load hits `db.version > 2` -> `NewerBoardError` (`:277-280`) -> `Autosaver.run()` (`autosave.ts:144-149`) calls `enterReadOnly(NEWER_BUILD_MESSAGE, true)`. |
| Another tab blocks the v3 upgrade (e.g., Milestone 1 `LegacyStoreV1` or in-flight tx) | None until retry | Unchanged (1 or 2) | `fence()` times out after `DEFAULT_DEADLINE_MS = 5000` ms (`boardStore.ts:95, 384-387`) -> `StorageBusyError` (`:68-73`). `Autosaver.run()` (`autosave.ts:151-155`) sets retryable `{ kind: 'error' }` (NOT read-only) and `Header.tsx:75-79` shows **Retry** (`README.md:100`). Late `onupgradeneeded` after expiry aborts (`boardStore.ts:395-398`). Closing the blocker and clicking Retry completes the upgrade. |
| Sibling branch (`milestone-2-frames`, `t3/capture-export`, `captions-frame-navigation-nov22`) opens a **v3** board | None | `3` | All three have `FENCED_DB_VERSION = 2` (`boardStore.ts:90`): `connect()` rejects with `NewerBoardError` (`:279`) -> read-only, no writes/prunes. |
| Sibling branch opens a **v1/v2** board with optional fields its allowlist lacks (`caption*` on `t3/capture-export`; `crop`/`locked`/`appearance` on `milestone-2-frames`) | `v1`/`v2` on save | Unchanged | Lenient allowlists (`doc.ts`) drop unknown fields on load and overwrite without them on next save (why Owner Decision 1 fences rich cards at DB v3 and Owner Decision 2 bases on `captions-frame-navigation-nov22`). |
| Newer build (DB v4+ or wire v4+ or unknown block type in v3) | None | Unchanged | Opens read-only (`NewerBoardError` / `UnreadableBoardError`), writes & prunes nothing. |

*(The base's rule that `parseDoc` accepts versions 1 and 2 and that a database newer than version 2 opens read-only, `docs/expected-behavior.md:117`, changes to versions 1 to 3 and "newer than version 3" in the Slice 1 commit, as approved by Owner Decision 1. The owner's standing acceptance of one-way forward migration, `docs/expected-behavior.md:119`, covers this upgrade: no backup, rollback or downgrade machinery is added.)*

---

## 6. Sizes, layout, and legacy re-wrapping

### Single size authority
- **Width:** `proxy.width` (`record.width`) in scene units (= local CSS `px` inside `.scene-world`).
- **Height:** Fixed-height (`record.height !== undefined`) uses CSS `height: ${rec.height}px; overflow-y: auto` directly. Auto-grow (`record.height === undefined`) uses `height: auto; min-height: ${rec.minHeight ?? 0}px; overflow: visible`, measured via `interface CardMeasurer { measureHeight(el: HTMLElement, rec: TextRecord): number }`:
  - **Production (`DomCardMeasurer`):** returns `rec.height` if defined; else `Math.max(rec.minHeight ?? 0, parseFloat(getComputedStyle(el).height) || el.offsetHeight)`. **Never uses `getBoundingClientRect()`** (post-zoom/rotation AABB would mis-size rotated/zoomed cards; **UNVERIFIED: prove fractional value under CSS zoom + rotation in Spike 0**).
  - **Unit tests (`FakeCardMeasurer` in `src/editor/testing/fakes.ts`):** injected into `Editor` (like `AssetSource` at `Editor.ts:257`) since jsdom has no layout (`offsetHeight === 0`); computes deterministic height from `rec` (paragraphs/items × `fontSize * 1.25`, heading scales `2 / 1.5 / 1.25`, floored by `minHeight ?? 0`, or `rec.height` when fixed).

### Exact layout flush points (`syncCardSize(id)`)
`syncCardSize(id)` reads `measurer.measureHeight(el, rec)`, sets `proxy.set({ height })`, and calls `proxy.setCoords()` **synchronously** at six points: (1) after `applyRecords` mounts DOM cards (before `selectByIds`/`fit`); (2) after `addTextAt` mounts a new card (before `ownerForNew`); (3) on every `EditSession` `tr.docChanged` or font/size/align/heading/block change (before `autosaver.markDirty`); (4) in `finishEditing()` (before new-card final `ownerAfterManipulation` and `commit`); (5) during `object:resizing` (`ml`/`mr` width drag on auto-grow) and at `settleScale` (before `applyOwnership`/`commit`); (6) at the start of `fit()`.

### No per-card `ResizeObserver`, and safe late font loads
- **No `ResizeObserver` on cards.** A late async resize notification can never mutate a settled gesture, alter ownership, or trigger an unexpected save.
- **Late font load (`document.fonts.addEventListener('loadingdone', ...)`):** if `this.gesture === null`, re-runs `syncCardSize` on all auto-grow cards to keep hitboxes and selection borders aligned; if `this.gesture !== null`, defers to `idle()`. Never recomputes ownership, never pushes history, never calls `autosaver.markDirty()`.

### Legacy wrapping, minimum width, and re-wrapping fidelity (Finding 5 — Owner Decision 3, Option A)
- **Unchanged on load:** `left`, `top`, `angle`, `width`, `fontSize`, `minHeight`, `frameId` (never recomputed), and formatting; loading writes nothing.
- **Wrapping & minimum width (today's two behaviours are kept exactly: `AGENTS.md:86`, `README.md:112`, `docs/expected-behavior.md:26`, `DrawnTextbox.ts:40`, `Textbox.ts:16, 139-140`):**
  - **Drawn boxes (`minHeight !== undefined`):** `overflow-wrap: anywhere` breaks overlong tokens at grapheme boundaries; `dynamicMinWidth` is the widest grapheme, measured on a reused offscreen probe as the largest fractional width (`getBoundingClientRect().width` of an untransformed probe, rounded up) among the text's `splitGraphemes` clusters. Spike 0 S3 showed no emoji or cluster is split, and that `scrollWidth` must not be used here because it rounds `30.078` down to `30`.
  - **Click/legacy boxes (`minHeight === undefined`):** `overflow-wrap: normal; word-break: normal` keeps word-only wrapping; `dynamicMinWidth` is the longest word, measured as the largest `white-space: pre` width among the text's space-separated tokens on the offscreen probe. Spike 0 S3 showed `width: min-content` is wrong for this: it gave `88.9` instead of `164.5` for `state-of-the-art` and `24` instead of `240` for a CJK run, because CSS allows a line break after a hyphen or dash and between CJK characters, where Fabric breaks only at spaces.
    - **Keeping "wraps only between words" true in CSS (Owner Decision 3, A):** on click/legacy boxes, every space-separated token that CSS could break inside (it contains a character other than a letter, digit or apostrophe, or a letter of a script that breaks between characters, such as Han, Hiragana, Katakana, Hangul or Thai) is wrapped in an inline `white-space: nowrap` span: in the static HTML by the serializer, and in the live editor by a ProseMirror inline decoration over the same token ranges, so both lay out identically. Ordinary words need no span. Pinned in Slice 2b by a measurer test on `state-of-the-art`, `2012—2014`, `and/or`, a URL and a CJK run, each compared with the longest-token width, and in Slice 2d by the legacy fixture test. If this proves costly on very long cards, the fallback is the owner's to choose: accept re-wrapping at hyphens and dashes on older boxes as a known limit.
  - **When measured & widening:** `CardMeasurer.measureMinWidth(el, rec)` runs in `syncCardSize` on text/formatting/size changes and at `object:resizing` start. If `dynamicMinWidth > rec.width`, `rec.width` widens to `roundPositive(dynamicMinWidth)` keeping the alignment edge in place (`getPositionByOrigin`/`setPositionByOrigin`, matching `objects.ts:385-388`) and never narrows automatically (`README.md:112`). Side handles (`ml`/`mr`) clamp to `Math.max(20, dynamicMinWidth)`. *(Unifying every box on `overflow-wrap: anywhere` with no auto-widening was Option B. It is not built in this milestone; if the owner wants it later it is a small change that deletes the longest-word measurer.)*
- **Typography & drift:** `.yuriful-prose` sets `line-height: 1.25`, `h1/h2/h3` at `2em / 1.5em / 1.25em` (`font-weight: 700`), `FONT_STACKS`, `padding: 0`. Borderline lines may wrap a word earlier/later between Canvas 2D and DOM shaping. Slice 2c/2d Playwright tests assert byte-equal stored geometry/`frameId`, DOM width within `1px`, and exact heading ratios on legacy fixtures.

### Fixed-height scrolling, Windows scrollbars, and idle overflow (Slice 4)
- **Zero-reflow scrollbar (Windows-safe):** Native Windows `overflow-y: auto` scrollbars consume ~15–17px of layout width, which would re-wrap lines on overflow and narrow fixed-height cards relative to `record.width`. Instead, `.scene-text-body` keeps `box-sizing: border-box; width: ${rec.width}px` with `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`, and renders a **6px absolute-positioned overlay scroll thumb** along the right edge when `scrollHeight > clientHeight` (driven by `scroll` events; draggable while editing, shown but not draggable while an idle card is being wheel-scrolled, and faded out `800 ms` after its last scroll). Wrap width never changes on overflow, existing boards keep exact width, and `ml`/`mr` handles set the exact text wrap width.
- **Scroll position is view state (Owner Decision 9, Option B):** the wheel scrolls a hovered fixed-height card under the wheel-ownership rule in Section 4, editing or not.
  - **Kept while the board is open:** `SceneRenderer` holds `scrollTops: Map<id, number>`, updated from each card's `scroll` event. Entering an edit keeps the position (so the caret lands on the word that was double-clicked) and leaving one keeps it too. `applyRecords` (undo, redo, cancel) rebuilds cards and re-applies the stored position, clamped to the new content.
  - **Never stored, never compared, never in history** (canonical rule 6 in Section 5). A reload starts every card at the top. Changing the card's `height`, or returning it to auto-grow, drops its entry.
  - **Bitmaps always start at the top:** frame previews and PNG export render every card from `scrollTop = 0` (Section 10), so a card scrolled on screen can differ from its preview. This is recorded as a known limit in the README.
  - **Cue:** `syncCardSize` and each `scroll` event toggle `.fade-top` (when `scrollTop > 0`) and `.fade-bottom` (when more text lies below) on `.scene-text-body`, the text inside the padding, so paper itself never fades. Each is a CSS `mask-image` gradient over `20px` (zero layout shift, works on any background).
  - **Offscreen culling:** a culled card (`content-visibility: hidden`, Section 7) must come back at its stored position; `syncFrame()` re-applies `scrollTops` when it un-culls a card (**UNVERIFIED: Spike 0 S10**).

### Paper surface (Slice 5 — Owner Decision 10, Option B)
- **What is stored:** only `surface: 'card'`. Paper colour, padding, corner radius and edge are CSS on `.scene-text.has-paper`, so they can be tuned without touching stored boards, with one exception: **padding is frozen once Slice 5 ships**, because changing it re-wraps every paper card.
- **Who gets paper:**
  - A text box created with the Text tool (click or drag) is created with `surface: 'card'`.
  - Every box stored before Slice 5 has no `surface` and stays bare; loading never rewrites a board (`docs/expected-behavior.md:116`).
  - A caption made with **Add caption** (`README.md:42` on the base) is created bare.
  - Attaching an existing box as a caption (**Make caption**, or a snap) and detaching it never change `surface`: attachment does not restyle text, and changing the box's size in the middle of a snap would move its landing.
  - Duplicate copies `surface` with the rest of the record.
- **Paper and `captionBackground` together:** a text with a `captionBackground` fills its box with that colour; a text with `surface: 'card'` and no `captionBackground` fills with the paper colour. `surface` alone decides whether the box has padding.
- **Geometry (the box is the paper):** `width`, `minHeight` and `height` are the paper's outer size, so selection handles, hit testing, ownership centres and caption snapping keep using the one box. CSS is `box-sizing: border-box; padding: PAPER_PAD_Y PAPER_PAD_X` with both in `em` of the card's base `fontSize` (provisional `0.75em` and `1em`, fixed by the design pass below), so a corner scale folds into `fontSize` and the padding follows with no extra field. `CardMeasurer` already reads the border-box height.
  - **Minimum width:** the side-handle floor becomes `Math.max(20, dynamicMinWidth) + 2 * padX`, and auto-widening compares `dynamicMinWidth + 2 * padX` with `rec.width`.
  - **Click-created box:** the text, not the paper, starts at the press point: the box is placed at `press - (padX, padY)` and is `10 * fontSize + 2 * padX` wide, so the wrap width is still ten font sizes (`docs/expected-behavior.md:25`).
  - **Drawn box:** the drawn rectangle is the paper. The "at least two font sizes wide" test (`MIN_TEXT_DRAG_EMS`) is unchanged; the minimum-width floor above then widens a too-narrow paper box as it would any box.
- **The Paper toggle (`setTextSurface(on)`):** an Inspector button with a pressed state, for one unlocked text, editing or not, behind the same guards as the other formatting commands. Turning paper on keeps the box's centre and grows `width` by `2 * padX` (and `minHeight` / `height`, when present, by `2 * padY`); turning it off shrinks by the same amounts. The words therefore do not move or re-wrap. One undo step outside an edit, coalesced as `surface:${id}`; inside an edit it is part of the edit's one step, like alignment and colour. It never changes ownership (`docs/expected-behavior.md:46`).
- **Design pass before the Slice 5 commit (`frontend-design` skill for the look, `clean-copy` for the button label):** choose the paper colour, radius, edge and padding within these constraints: visible on white frame paper (`FRAME_FILL = '#ffffff'`) and on every board backdrop preset; all 8 text colours stay legible on it; the lifted-drag look (`.is-lifted`) still reads as lifted; and whatever edge is chosen can be drawn by `renderFrameBitmap.ts` (an outer shadow needs a bleed margin around the card's SVG, Section 10). The owner approves the look before the slice is committed.

---

## 7. The edit session, undo, and autosave

### Single mounted editor vs static HTML (Finding 10)
- **Idle cards:** rendered as pure static DOM via `DOMSerializer.fromSchema(textSchema).serializeFragment(pmDoc.content)` inside `.scene-text-body.yuriful-prose`. No `contenteditable`, no `EditorView`, no `MutationObserver`.
- **Active edited card (at most 1 at a time):** mounts one ProseMirror `EditorView` directly into `.scene-text-body` (sharing `.yuriful-prose` CSS).
- **Pixel-identical guarantee:**
  1. Same schema (`textSchema`) generates both the static DOM (`DOMSerializer`) and the live `EditorView` DOM (`toDOM`).
  2. Empty blocks emit `<br>` in static HTML to match ProseMirror's trailing `<br class="ProseMirror-trailingBreak">`.
  3. Editing indicator uses CSS `outline` (never `border` or `padding` change), so entering/leaving edit produces `0px` box shift.
  4. **Required by Spike 0 S2** (raw `DOMSerializer` output jumped `74.2px` on entering an edit; with the two rules below the jump is `0px`): the static `.yuriful-prose` carries the same base CSS ProseMirror puts on its editable root, `white-space: pre-wrap` (not `break-spaces`, which adds a trailing space to measured widths) and `font-variant-ligatures: none`; and `finishEditing()` removes the `ProseMirror-focused` class, which `view.destroy()` leaves behind on an in-place mount.
  5. **No scrollable ancestor (Spike 0 S1):** the browser scrolls any `overflow: hidden` ancestor to bring the caret into view, which shifted the whole scene by up to `46px` against the Fabric canvas. `.scene-layer` is therefore `overflow: clip`, and no ancestor of a card other than its own `.scene-text-body` may be scrollable. Consequence, same as today: the board does not pan to follow a caret typed off-screen.
- **Performance budget, offscreen culling, and zoom sharpness (measured in frame intervals):**
  - Reference load: **100 text cards (10 × 1,500-word reviews + 90 notes) + 50 images + 10 frames**.
  - **Measurement:** Zooming a transformed DOM layer costs raster/paint, not script. Measure **60 consecutive `requestAnimationFrame` deltas** (p50/p95) and a Chromium trace across continuous wheel zoom (`0.5x -> 2x -> 4x`), pan drag, and 20-item multi-drag. Target: **p95 `<= 20 ms`**, no post-zoom raster stall `> 100 ms`, enter/exit edit on a 1,500-word card `<= 16 ms` (**UNVERIFIED: Spike 0 S9**).
  - **Offscreen culling:** In `syncFrame()`, idle `.scene-item`s outside the viewport (+256 px margin) get `content-visibility: hidden` (skips layout/paint/raster while keeping DOM/decoded `<img>`). Active edited and transformed items stay visible; explicit `syncCardSize(id)` on a culled card temporarily clears `content-visibility` before measuring. Visible idle items keep `contain: layout style paint`.
  - **`will-change: transform` & text sharpness:** Never keep `will-change: transform` on `.scene-world` or idle `.scene-text` cards (pinned GPU textures blur glyphs after zoom-in); apply it only to actively dragged/scaled items during a gesture and remove on settle (**UNVERIFIED: Spike 0 S9**).

### `EditSession` lifecycle (`src/editor/textSession.ts`)

```text
User double-clicks card T (or Text tool settles)
  │
  ▼
Editor.startEditing(proxy, clickEvent?)
  ├── Guard: editable && !busy && !isLocked(proxy)
  ├── Finish any previous session first
  ├── Create EditSession { id: ++seq, cardId, proxy, sceneBefore: snapshot(), isNew, dirty: false, shortcutRevert: null, finished: false }
  ├── Build ProseMirror EditorState (schema + prosemirror-history + textRules + headingBoldGuard)
  ├── Mount EditorView into card's .scene-text-body; place caret via posAtCoords (or end)
  ├── Toggle pointer routing (.canvas-host pointer-events: none; card T pointer-events: auto; items > indexOf(T) pointer-events: auto, cursor: default)
  └── syncState() -> editingText = true

Keystroke / paste / checkbox click / Inspector formatting button
  │
  ▼
EditorView.dispatchTransaction(tr)
  ├── Guard: !session.finished && this.activeSession?.id === session.id && this.editable
  ├── state = state.apply(tr); view.updateState(state)
  │   (headingBoldGuard appendTransaction strips bold inside heading nodes & drops bold from storedMarks on headings)
  ├── If tr.docChanged:
  │     ├── meta.textData = pmDocToCanonicalData(state.doc, meta.textData)
  │     ├── syncCardSize(cardId)  [synchronous height + dynamicMinWidth update on proxy + setCoords]
  │     ├── session.dirty = true
  │     └── If !isBlankTextDoc(meta.textData): autosaver.markDirty()  [saved as it happens!]
  ├── If (tr.docChanged || tr.selectionSet) && !tr.getMeta('shortcutApplied'):
  │     └── session.shortcutRevert = null  [any move, edit, or in-edit undo drops Backspace revert offer]
  └── queueSelectionSync()  [debounced in microtask; updates Inspector pressed/mixed states]

Leave edit (Esc / click outside / Shift-click / Tool switch / Arrange / Delete / Read-only; NOT the Undo or Redo button)
  │
  ▼
Editor.finishEditing()  [strictly idempotent via session.finished]
  ├── If !activeSession || activeSession.finished: return
  ├── session.finished = true; activeSession = null
  ├── view.destroy(); renderStaticCard(cardEl, meta.textData); re-apply the card's scrollTop (Owner Decision 9)
  ├── Restore pointer routing (.canvas-host pointer-events: auto; card T & covering items pointer-events: none)
  ├── syncCardSize(cardId)  [synchronous final height + idle overflow fade class]
  ├── If !this.applying && this.editable:
  │     ├── If isBlankTextDoc(meta.textData):
  │     │     ├── Hide/disable proxy synchronously; discard if active
  │     │     ├── Defer canvas.remove(proxy) + DOM remove to microtask (guarded by !disposed)
  │     │     └── commit()  [records removal if existing card; no-op if brand new]
  │     └── Else:
  │           ├── If session.isNew: setOwner(proxy, ownerAfterManipulation(ownerOf(proxy), centerOf(proxy), frameRecords(), NO_FRAMES))
  │           └── commit()  [pushes ONE board history step ONLY if !sceneEqual(snapshot(), history.current)]
  └── syncState() -> editingText = false
```

- **Focus moving to Title/Font-size `<input>` or window `blur` keeps edit open:** Fabric's `ITextKeyBehavior.blur()` (`node_modules/fabric/src/shapes/IText/ITextKeyBehavior.ts:106-108`) only calls `abortCursorAnimation()` and keeps `isEditing = true`; `Inspector.tsx:171, 280-282` lets fields take focus, `Header.tsx:57-69` has the Board title input, and `Editor.ts:1217-1225` keeps text edits open across window `blur` (`docs/rich-text-plan.md:364`). Matching that: **ProseMirror `blur` never calls `finishEditing()`**. `isEditableTarget` (`shortcuts.ts:39-50`) blocks canvas shortcuts in those fields, `editedRoot.contains` scopes `Ctrl/Cmd+B/I/U` and Backspace revert to the edited card, `setFontSize` updates live (skipping `commit` while blank, `Editor.ts:1655`), and `setTitle` updates the title without closing the edit.
- **In-edit `Ctrl/Cmd+Z` after a typing shortcut vs Backspace revert vs Toolbar Undo:**
  - On shortcut conversion, `textRules.ts` dispatches two transactions separated by `closeHistory(tr)` (`prosemirror-history`): (1) insert literal trigger char (`**word**` / `# `), then (2) strip markers, apply formatting/block + post-shortcut `storedMarks`, and save post-(1) `{ doc, selection, storedMarks }` in `session.shortcutRevert`.
  - **Plain `Backspace` straight after** (`!repeat && !composing && !modifiers`): restores `shortcutRevert` (exact markers, formatting, caret, pre-shortcut `storedMarks`) and clears `shortcutRevert`.
  - **In-edit `Ctrl/Cmd+Z` straight after**: undoes transaction (2) only (restoring literal markers) and clears `shortcutRevert`; a second `Ctrl/Cmd+Z` undoes the typed text.
  - **Toolbar Undo and Redo while editing (Owner Decision 11, Option B):** the buttons do what the keys do. Today `Editor.undo()` and `redo()` call `finishEditing()` and then step board history (captions-base `Editor.ts:2988-3000`). With an active session they instead call `session.undo()` / `session.redo()` (`undo` / `redo` from `prosemirror-history`) and return, leaving the edit open and board history untouched.
    - **Button state:** while editing, `EditorState.canUndo` / `canRedo` are `undoDepth(state) > 0` / `redoDepth(state) > 0`, refreshed in `dispatchTransaction`'s state sync. A button with nothing to step is disabled, exactly as `Ctrl/Cmd+Z` then does nothing. There is precedent for `canUndo` following an open session rather than board history: an open crop (captions-base `Editor.ts:881`).
    - **Focus:** `.overlays` already prevents the mousedown default on every button (captions-base `Overlays.tsx:136-138`), so pressing Undo keeps the caret and the edit.
    - **Taking back a whole sitting:** leave the box (Esc), then Undo. The edit is still one board step, as today.
    - **Outside an edit:** unchanged.
  - **What in-edit undo covers:** typing, deleting, pasting, marks, headings, blocks, range fonts and typing shortcuts, which are all ProseMirror transactions. Whole-box settings changed during an edit (font size, alignment, colour, base font, Paper, fixed height) are record fields outside the ProseMirror document, so in-edit undo skips over them; they are undone with the rest of the edit by board Undo after leaving. Pinned by a test and listed in the README's known limits.
- **Invalidation on restore / cancel / read-only / dispose:**
  - `applyRecords` (undo/redo/cancelGesture) destroys any active session with `applying = true` (no commit, no save).
  - `enterReadOnly` sets `readOnly` **before** calling `finishEditing()` (`Editor.ts:383-385`), so the card stays visibly intact as static HTML, commits nothing, and writes nothing.
  - Every microtask captures `session.id` and no-ops if invalidated or disposed.

---

## 8. Shipped text rules table (`AGENTS.md` audit)

Every settled text rule in `AGENTS.md:85-94, 147` and `README.md:61-90` accounted for:

| Settled rule | Disposition | Concrete ProseMirror mechanism / owner decision |
|---|---|---|
| Blank text never saved, never in history, discarded on exit (`AGENTS.md:88`, `Editor.ts:428, 771`) | **Keep**, widened by **Owner Decision 4 (B)** | Blank means no non-whitespace text and no `divider` and no checked `taskItem` (Section 5). An existing card reduced to an empty list is discarded on exit as 1 undo step. Takes effect in Slice 3a, when those nodes first exist. |
| Canvas always matches canonical stored record (`AGENTS.md:89`) | **Keep** | `appendTransaction` enforces heading-no-bold; `pmDocToCanonicalData` canonicalizes on every `tr.docChanged`. |
| Headings are a line/block property, always bold, bold never stored in heading (`AGENTS.md:90`) | **Re-express** | `heading` block node (`level: 1\|2\|3`); CSS `font-weight: 700`; `appendTransaction` strips `bold` mark inside `heading` and from `storedMarks` when caret is in a heading. |
| Bold on a mixed range changes only normal lines; Bold button pressed & disabled inside headings (`AGENTS.md:92`, `README.md:77`, `richText.ts:518-527`, `Inspector.tsx:214-227`) | **Keep** | `boldFromHeading` is true iff every selected character (or caret) is inside a `heading`; `toggleMark('bold')` mutates only non-heading text nodes. |
| Enter at end of heading starts normal paragraph; Enter in middle splits heading; Backspace joins onto preceding block (`README.md:110`) | **Re-express** | ProseMirror `splitBlock` defaults to splitting heading at middle and inserting `paragraph` at end; custom Enter/Backspace commands preserve empty-heading Enter -> `paragraph` and Backspace from heading onto empty paragraph keeping heading (`e2e/text.spec.ts:366-450`). |
| Selection ending at the very start of a line does not count that line (`AGENTS.md:91`, `README.md:111`, `richText.ts:533-539`) | **Re-express** | When `!selection.empty` and `$to.parentOffset === 0` after the start block, `blocksOfSelection` excludes `$to`'s block for both heading readout and `setHeading`. |
| Formatting commands: range/caret while editing, whole box outside editing; align & colour whole box; whole-box font clears span font overrides (`AGENTS.md:91`, `richText.ts:493-500`) | **Keep** | In-edit: ProseMirror commands on `state.selection`. Outside edit: pure `RichDoc` transforms in `src/model/textDoc.ts` coalesced by `format-${kind}:${id}`; whole-box `setBoxFont` sets `rec.font` and strips every `InlineRun.font`. |
| `lastBoxLine`: whole-box heading skips trailing empty line; Body clears it (`AGENTS.md:91`, `richText.ts:556-572`) | **Keep** | Whole-box `formatOfDoc` and `setBoxHeading(1..3)` ignore a trailing empty `paragraph` when at least one non-empty block exists; `setBoxHeading(0)` clears headings on all blocks including an empty last heading. |
| Font-size command (`setFontSize`: clamp 6–400, coalesced `font-size:${id}`, skips commit while blank) (`Editor.ts:1645-1657`, `Inspector.tsx:171-184`) | **Keep** | Updates `rec.fontSize` and CSS `font-size` (headings scale via `2em/1.5em/1.25em`), flushes `syncCardSize`, clears `shortcutRevert`, skips `commit` if blank, else commits with `font-size:${id}`. |
| Typing next to a bold/styled character inherits its style unless turned off at caret (`README.md:110`, `richText.ts:614-634`) | **Re-express** | ProseMirror marks default to `inclusive: true`; toggling off at caret updates `state.storedMarks`; after `**bold**`/`*italic*`/`` `code` `` converts, the transaction explicitly strips that mark from `storedMarks` so following typing is plain. |
| Pending marks & font at caret; dropped on caret move or edit exit; bold dropped on heading; pending mark/font applies to text pasted at caret (`AGENTS.md:92`, `README.md:110`, `objects.ts:320-323`) | **Re-express** | ProseMirror `state.storedMarks` holds pending marks/font and clears them on selection move; `appendTransaction` drops `bold` on headings; `EditSession` paste handler applies active `storedMarks` to pasted text at the caret. |
| Typing shortcuts `# `, `## `, `### `, `**bold**`, `*italic*` with ALL pinned literal cases (`2 * 3 * 4`, `a ** b`, `* item`, `**`, `snake*case*`, `***x***`, `#tag`, `#### four`, `a # b`, `** x**`, `*x *`, `#x`), never firing on paste/drop/IME/load (`AGENTS.md:93`) | **Re-express** | **Disable all built-in ProseMirror inputRules & pasteRules.** Custom plugin uses `handleTextInput` gated on `!view.composing && from === to && text.length === 1 && lastKeydownTyped` (via `typedCharacter` in `shortcuts.ts:169-173`). |
| New Slice 3a live-Markdown triggers (`- `, `1. `, `- [ ] `, `- [x] `, `> `, `---`, `` `code` ``, ```` ``` ````) & `- [ ] ` precedence | **New (Slice 3a)** | Two-stage transition avoids `- ` trapping `- [ ] `: `- ` creates `bulletList`; typing `[ ] ` or `[x] ` at start of a `bulletList > listItem > paragraph` upgrades it to `taskList > taskItem` (`[] ` on plain paragraph also creates `taskList`). `* ` is not a bullet trigger: `* item` stays literal (**Owner Decision 7, A**). |
| Backspace straight after shortcut restores exact text, formatting, caret & pending marks; in-edit `Ctrl/Cmd+Z` straight after shortcut (`AGENTS.md:93`, `e2e/typing.spec.ts:467`) | **Re-express** | Two `prosemirror-history` steps separated by `closeHistory(tr)`: plain `Backspace` (`!repeat && !composing && !modifiers`) restores `EditSession.shortcutRevert` (exact text, marks, caret, `storedMarks`); `Ctrl/Cmd+Z` undoes only the conversion step back to literal markers and clears `shortcutRevert`. |
| `Ctrl/Cmd+B/I/U` in-edit AND on a single selected box not being edited; auto-repeat claimed & ignored (`AGENTS.md:94`, `shortcuts.ts:79-83, 146-159`) | **Keep** | In-edit: `resolveEditingShortcut` checks `ctx.editedRoot?.contains(e.target as Node)`, never with Alt/Shift/composing, auto-repeat returns `'ignore'`. Box selected (not editing): `resolveShortcut` checks `ctx.textSelected && !e.shiftKey`, auto-repeat returns `'ignore'`, toggles whole box. |
| Formatting controls never take focus; focusing Title/Font-size `<input>` or window `blur` keeps edit open (`AGENTS.md:94`, `Inspector.tsx:171, 280-282`, `ITextKeyBehavior.ts:106`, `Editor.ts:1217-1225`) | **Keep** | `Overlays.tsx:75-77` and `Inspector.tsx:280-282` keep `preventDefault` on non-field `mousedown`. ProseMirror `blur` never calls `finishEditing()`, matching Fabric's `blur()`. |
| Pasted text formatting (`bold`/`italic`/`underline`/`strike` only; headings arrive bold normal size; never brings size, colour or font; plain markers stay literal) (`README.md:110`, `AGENTS.md:93`, `objects.ts:307-308`) | **Keep through Slice 3a, then changed by Owner Decision 5 (C) in Slice 3b** | Slices 2a to 3a keep today's rule (marks-only HTML paste, headings flattened to bold normal size, no `data-font`, plain markers literal), so the flip is provable against today's tests. Slice 3b replaces it: HTML keeps structural blocks and internal `data-font`, and pasted plain Markdown is converted (Section 11). Pasted text still never brings its own size or colour. The typing-shortcut machinery itself still never fires on paste, drop, composition or load; paste conversion is a separate pure pass. |
| Dragging selected text from one text card into another (`AGENTS.md:79`, `README.md:114`) | **Retire** (**Owner Decision 6, A**), at Slice 2d | With one mounted `EditorView`, idle cards are static HTML so cross-card text drag cannot exist. Dragging words within a card still works; between cards the path is cut, click into the other card, paste. Also retires the known limit about dropped text shifting a centred or right-aligned box (`README.md:114`; `README.md:210` on the base). Bringing the drag back later as a special case, without making every card live, stays possible and is not planned. |
| Legacy/click-created wrapping, longest-word `dynamicMinWidth`, widest-grapheme on drawn boxes, widened box never auto-narrows, alignment edge stays put (`AGENTS.md:86, 90`, `README.md:112`, `DrawnTextbox.ts:40`, `objects.ts:385-389, 469-478`) | **Keep** (**Owner Decision 3, A**) | Today's exact wrapping and `dynamicMinWidth` widening are kept (preserving alignment anchor `left`/`center`/`right` via `getPositionByOrigin`/`setPositionByOrigin`, never auto-narrowing). Unifying the two behaviours is not in this milestone. |
| `Esc` exits text edit (`IText/constants.ts:27`) | **Keep** | Handled in `EditorView` `handleKeyDown` when `!view.composing` -> `editor.finishEditing()`. |
| `Tab` exits text edit (`IText/constants.ts:26`) vs indenting lists | **Changed by Owner Decision 8 (A)**, in Slice 3a | Through Slice 2d `Tab` exits editing, as today. From Slice 3a, `Tab` / `Shift+Tab` inside a list or checklist item indent / outdent it (`sinkListItem` / `liftListItem`), and exit editing everywhere else. `Tab` on the first item of a list, which cannot indent, does nothing rather than exit, so a mistimed press never ends the edit mid-list. |
| Toolbar Undo while editing finishes the edit and undoes it whole (`Controls.tsx:10`, `docs/rich-text-plan.md:285`) | **Changed by Owner Decision 11 (B)**, at Slice 2d | Undo and Redo buttons step ProseMirror history while editing and never leave the edit (Section 7). The edit is still one board step once left. |
| `Ctrl/Cmd+Z` while typing is the browser's own undo and misses heading levels and shortcuts (`README.md:211` on the base) | **Retire** the limit, at Slice 2d | `prosemirror-history` undoes text, marks, headings, blocks and shortcut conversions exactly. |
| Text-tool drag: click slop 4px, min width `2 * fontSize`, `minHeight`, single-use (`AGENTS.md:85-86`) | **Keep** | Unchanged draft gesture in `Editor.ts:690-703, 887-894`; creates `ProxyRect` + DOM card with `minHeight`. |
| Ownership rules for new vs existing text (`AGENTS.md:100-106`) | **Keep** | Unchanged: new card's owner decided at creation and once more at first `finishEditing()`; formatting/typing in existing card never changes ownership. |

---

## 9. Proxies, transforms, and frames

### Explicit proxy identity (`src/editor/objects.ts`)
- `ProxyRect extends Rect`: overrides `_render() {}` so Fabric paints nothing onto `lowerCanvasEl`, while keeping `visible: true`, `evented: true`, `fill: 'transparent'`, `strokeWidth: 0`, `objectCaching: false`.
- `meta = new WeakMap<FabricObject, ObjectMeta>()` with discriminated `kind: 'frame' | 'image' | 'text'`.
- Helper predicates `isFrame(obj)`, `isImage(obj)`, `isText(obj)` replace every `instanceof Textbox` across `objects.ts` (`objects.ts:545`) and `Editor.ts` (`Editor.ts:428, 526, 528, 537, 614, 667, 720, 744, 771, 793, 1000, 1010, 1016, 1021, 1290, 1435, 1477, 1649, 1674`).
- `toRecord(obj)` dispatches strictly on `m.kind`: a text proxy always serializes as `TextRecord`, an image proxy always serializes as `ImageRecord`, and `settleScale` always collects every text proxy's pre-gesture `fontSize` for `allowedScaleFactor` (6–400 px).

### Matrix projection from Fabric to DOM (`src/editor/sceneLayer.ts`)
- Every Fabric object (standalone OR inside an `ActiveSelection`, where `obj.left/top` are group-relative!) exposes its full scene-space center-origin affine matrix via `M = obj.calcTransformMatrix()` (`[a, b, c, d, e, f]`, verified at `InteractiveObject.ts:453` and `objects.ts:538`).
- Converting to top-left origin (`transform-origin: 0 0`, `left: 0; top: 0`) for a DOM element of untransformed CSS size `(w, h)` (`w = obj.width`, `h = obj.height`):
  ```ts
  const tx = e - (a * w) / 2 - (c * h) / 2
  const ty = f - (b * w) / 2 - (d * h) / 2
  el.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`
  ```
- Runs inside Fabric's `before:render` callback (`ctx === canvas.getContext()`).
- **Frame followers (`collectFollowers` / `placeFollowers`, `Editor.ts:925-947`):** unchanged! Selected members move through `ActiveSelection`'s matrix only; unselected members are moved by `placeFollowers` via `left`/`top` during `object:moving`, never twice. `before:render` projects both in the same frame.

### Handle mapping on text proxies
Fabric 7.4 already provides both `changeWidth` and `changeHeight` (`node_modules/fabric/src/controls/changeWidth.ts:77-88`):
- **`ml`, `mr`:** `changeWidth` (`actionName: 'resizing'`). Changes `proxy.width`, clamped to `>= Math.max(20, dynamicMinWidth)` (matching Fabric `Textbox.ts:16, 139`, Owner Decision 3 Option A; plus `2 * padX` on a paper card from Slice 5, Section 6). During `object:resizing`, updates card CSS `width` and flushes `syncCardSize` (if auto-grow) so selection borders follow live re-wrap.
- **`mb` (Slice 4):** `changeHeight` (`actionName: 'resizeHeight'`). Anchors `originY: 'top'`. Sets `meta.textData.height = roundPositive(Math.max(MIN_CARD_HEIGHT, proxy.height))` (`MIN_CARD_HEIGHT = Math.round(fontSize * 1.5)`), switching the card to fixed scrollable height (`overflow-y: auto`). Double-clicking `mb` (or clicking **Auto height** in Inspector) sets `height = undefined` and flushes `syncCardSize` as one undo step.
- **`mt`:** hidden (`mt: false`).
- **`tl`, `tr`, `bl`, `br`:** Fabric's `scalingEqually` (`action: 'scale'`). Scales smoothly via CSS `matrix()` during drag (zero reflow per frame). At `settleScale`:
  1. `allowedScaleFactor` computes **one** factor from pre-gesture `baseFrames` and `baseTexts`.
  2. `limitScale` applies it once to `transform.target`.
  3. `normalizeTextScale(proxy)` folds `s = (|scaleX| + |scaleY|) / 2` **exactly once** into `fontSize`, `width`, `minHeight` (if present), and `height` (if present), resets `scaleX = 1, scaleY = 1`, updates DOM styles, flushes `syncCardSize`, and calls `setCoords()`.
  4. In a multi-selection (`ActiveSelection`), dissolves selection, folds each text and bakes each frame once, and re-forms selection (`Editor.ts:1007-1020`).
- **`mtr`:** standard rotation (disabled in multi-selection containing a frame, `Editor.ts:628`).

---

## 10. Rendering to a bitmap (frame previews & PNG export)

Both `origin/feat/captions-frame-navigation-nov22`'s `src/editor/framePreview.ts` and `t3/capture-export`'s `src/editor/exportFrame.ts` currently build a detached Fabric `StaticCanvas` via `createObject`, which would lose all DOM text cards.

### Unified compositor (`src/editor/renderFrameBitmap.ts`)
Both callers delegate to `renderFrameToCanvas(scene, frameId, targetSize, getImage, measureHeight)`:
1. Create offscreen `<canvas width={W} height={H}>`, fill with `FRAME_FILL`, apply viewport transform `(scaleX, 0, 0, scaleY, -frame.left * scaleX, -frame.top * scaleY)`.
2. Walk `scene.objects` **in exact z-order**:
   - **`ImageRecord`:** draw directly onto `ctx` with `ctx.save()`, translate/rotate/scale, and `ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, dw, dh)` (handles crop, zero Base64 bloat).
   - **`TextRecord` (non-blank):**
     1. Generate static DOM via `DOMSerializer.fromSchema(textSchema)` (identical to `.scene-layer`) and turn it into XHTML with `XMLSerializer` (Spike 0 S5: an `innerHTML` string fails to decode with `EncodingError`, because `<br>` and friends are not well-formed XML).
     2. Wrap in self-contained XHTML inside `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${INLINE_PROSE_CSS}</style><div class="yuriful-prose" style="...">${html}</div></div></foreignObject></svg>` (zero external URLs, system fonts only, `background: captionBackground` when set; from Slice 5 a `surface: 'card'` text gets the same inlined `.has-paper` padding, fill and edge as on screen, and if the approved edge is an outer shadow the SVG and its draw rectangle grow by a `PAPER_BLEED` margin on every side so the shadow is not clipped).
     3. **Fixed-height cards in previews/exports:** always rendered from the **top (`scrollTop = 0`)**, clipped strictly to `rec.width × rec.height` (`overflow: hidden`), with no scroll thumb and no fades (deterministic and identical to a freshly loaded idle card, whatever position the card is scrolled to on screen).
     4. Load into `new Image()` via `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` (same-origin data URL), await `img.decode()`, and `ctx.drawImage(img, 0, 0, w, h)` under the card's scene transform (`translate(left, top)` + `rotate(angle)`).
3. Return `canvas.toDataURL('image/png')` (preview) or `canvas.toBlob(..., 'image/png')` (export).

### Browser support scope & honest bitmap fallback
- **Supported target:** `playwright.config.ts:29-34` runs **Desktop Chromium** (`Desktop Chrome`, or `PW_CHANNEL=msedge|chrome`). Desktop Chromium (Chrome, Edge, Brave, Arc) is the supported and CI-verified browser for this milestone. **Firefox and Safari are out of scope for CI verification:** live DOM/ProseMirror editing uses standard web APIs and works there untested, while Safari's WebKit is known to taint 2D canvases after drawing SVG `<foreignObject>` in several versions (and Firefox system-font metrics may differ slightly).
- **UNVERIFIED: prove in the spike (S5)** that Chromium renders SVG `<foreignObject>` data URLs with headings, checklists, quotes, code blocks, and fixed-height clipping onto 2D canvas without tainting `toBlob()`/`toDataURL()` at `scale = 2`.
- **Honest fallback (NOT a Canvas 2D layout engine):** Building a Canvas 2D rich-block renderer would mean maintaining a second full text layout engine (headings, mixed-font spans, nested lists, checklists, quotes, code blocks, clipping) — far too expensive and drift-prone to be a fallback. Instead:
  - For **`framePreview.ts`** (frame navigation thumbnails): if `<foreignObject>` rasterization fails or taints (e.g., on Safari `SecurityError` or a Chromium regression), render the thumbnail directly as a **scaled read-only DOM `.scene-world` preview** (zero canvas rasterization needed).
  - For **`exportFrame.ts`** (PNG export on `t3/capture-export`): catch `SecurityError` cleanly and show an explicit error toast ("Exporting frames with rich text requires a Chromium browser") rather than crashing or outputting blank cards.

---

## 11. Dependencies, module layout, and clipboard security

### Dependency choice: Bare ProseMirror (over TipTap v3)
- **Justification:** Yuriful needs strict control over every typing rule (pinned literal cases + exact Backspace revert with `storedMarks`), heading-never-stores-bold invariants, local-only clipboard sanitization, and headless DOM mounting owned by `Editor.ts` (no React coupling). TipTap v3 is a wrapper around these same packages, adding abstractions whose default input rules, paste rules, and keymaps we would immediately disable. Bare ProseMirror is the smaller of the two (TipTap ships these packages plus its own layer), MIT-licensed, and directly exposes `EditorView`, `EditorState`, `DOMSerializer`, and `handleTextInput`.
- **Exact packages to add (MIT-licensed; exact versions pinned by `package-lock.json` at install time; versions checked on npm 2026-11-23):**

| Package | Version | Licence | Role |
|---|---|---|---|
| `prosemirror-model` | `^1.25.13` | MIT | `Schema`, `Node`, `DOMSerializer`, `DOMParser` |
| `prosemirror-state` | `^1.4.4` | MIT | `EditorState`, `Transaction`, `Plugin`, `Selection` |
| `prosemirror-view` | `^1.43.0` | MIT | Single mounted `EditorView` for active card |
| `prosemirror-transform` | `^1.12.7` | MIT | Document steps and mapping |
| `prosemirror-commands` | `^1.7.2` | MIT | Base keymap, `toggleMark`, `setBlockType`, `wrapIn`, `lift` |
| `prosemirror-keymap` | `^1.2.3` | MIT | In-edit keybindings |
| `prosemirror-history` | `^1.5.2` | MIT | In-edit `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| `prosemirror-schema-list` | `^1.6.1` | MIT | `splitListItem`, `sinkListItem`, `liftListItem` |

- **Bundle cost (measured in Spike 0 S8):** `+66.49 kB` gzip JavaScript (`+213.9 kB` raw) and `+0.21 kB` gzip CSS for the eight packages; `prosemirror-view` resolved to `1.43.1`. The bundle then crosses Vite's `700 kB` chunk warning, so Slice 2a raises `build.chunkSizeWarningLimit` in `vite.config.ts` with a comment saying why (no code splitting: there is one page and the editor is needed at once). No Fabric version change; `fabric` stays pinned at `7.4.0`.

### Module boundaries (preserving `AGENTS.md:64-66`)
- `src/model/` (**pure — zero Fabric, ProseMirror, or DOM**): `types.ts`, `doc.ts`, `textDoc.ts` (new), `markdownPaste.ts` (new in Slice 3b), `richText.ts`, `frames.ts`, `history.ts`, `layers.ts`, `viewport.ts`, `id.ts`.
- `src/editor/` (**ONLY directory importing Fabric or ProseMirror; `Editor.ts` remains the sole UI bridge**): existing `Editor.ts`, `FrameCanvas.ts`, `frameLayer.ts`, `objects.ts`, `assets.ts`, `fonts.ts` (`DrawnTextbox.ts` retired in 2d; captions base also has `cropLayer.ts`, `framePreview.ts`, `captionSnapLayer.ts`, `layerList.ts`, `feedbackLayer.ts`), plus new `textSchema.ts`, `textRules.ts`, `textSession.ts` (2a), `sceneLayer.ts`, `renderFrameBitmap.ts` (2b), and `textAdapter.ts` (2c-i; single DOM impl after 2d).
- `src/input/shortcuts.ts` (`EditingContext.editedRoot` replaces `editedTextarea`), `src/persistence/` (`boardStore.ts`, `autosave.ts`, `hydrate.ts`), `src/ui/` (React chrome only; zero Fabric/ProseMirror imports).

### Blast radius: existing files and exports kept, rewritten, or deleted
Line counts verified via `wc -l` on `feat/milestone-2-frames` (`98ea0f4`) and `git show origin/feat/captions-frame-navigation-nov22:<path> | wc -l` (`6ad246c`):

| File | Lines | Disposition & exports | Sub-slice |
|---|---|---|---|
| `src/model/richText.ts` | 821 | **Keep** constants/types & legacy canonicalizers (`FONT_IDS`, `TEXT_PALETTE`, `HEADING_SCALE`, `splitGraphemes`, `paragraphsOf`, `canonicalHeadings`, `canonicalSpans`, `spansFromCharStyles`, `canonicalTextFormatting`, `lastBoxLine`). **Delete** Fabric UTF-16 diff/style-carry/formatting/shortcut helpers (`diffText`, `textAfterEdit`, `headingsAfterEdit`, `setRangeFont`, `fontOfRange`, `toggleMark`, `linesOfRange`, `setHeading`, `setHeadingEverywhere`, `formatOfRange`, `formatOfText`, `fontAtCaret`, `marksAtCaret`, `formatAtCaret`, `togglePendingMark`, `pendingMarksAt`, `withPendingMarks`, `matchTypingShortcut`, `applyTypingShortcut`). | 2d |
| `src/model/richText.test.ts` | 756 | **Trim** deleted-export suites (rules moved to `textDoc.test.ts` in 1 & `textRules.test.ts` in 2a). | 2d |
| `src/editor/Editor.ts` | 1,927 (3,211 captions) | **Extract** text seam behind `TextAdapter` (`2c-i`), wire DOM editing/routing (`2c-ii`) & captions-base hooks (`2c-iii`), delete Fabric path & flag (`2d`). | 2c-i..2d |
| `src/editor/objects.ts` | 604 (739 captions) | **Rewrite** for `ProxyRect` (keep `idOf`, `isFrame`, `isImage`, `isText`, `ownerOf`, `createFrame`, `createObject`, `centerOf`, `toRecord`, `toFrameRecord`, `hasResidualScale`, `normalizeTextScale`, plus crop/lock/caption metadata). **Delete** Fabric per-character style machinery & `lastCanonical`/`remember` (`selectedRange`, `readTextFormatting`, `writeTextFormatting`, `applyTextFormatting`, `replaceEditedText`, `setTextFontSize`, `reconcileTextFormatting`, `editTextAtEnd`). | 2c-i (dual), 2d (delete) |
| `src/editor/DrawnTextbox.ts` | 65 | **Delete** (replaced by CSS wrapping + `minHeight` + `CardMeasurer` in `sceneLayer.ts`). | 2d |
| `src/editor/testing/fakeFabric.ts` | 368 | **Keep** `FakeObject`, `Rect`, `ActiveSelection`, `Canvas`, `util` (add `before:render` in 2c-i). **Delete** `Textbox` (`:100-162`) and `FabricImage` (`:164-170`). | 2c-i, 2d |
| `src/editor/objects.test.ts` | 491 | **Rewrite** Fabric style/reconcile suites -> proxy suites (formatting/shortcuts covered by `textSchema`/`textRules` tests). | 2c-i, 2d |
| `src/editor/Editor.{text,formatting,typing,texttool}.test.ts` | 215 / 604 / 562 / 362 | **Rewrite** onto `FakeCardMeasurer` + `FakeTextSession` (backed by real `prosemirror-state`) and `ProxyRect`. | 2d |
| Captions-base files (`cropLayer.ts` 104, `framePreview.ts` 42, `layerList.ts` 72, `captionSnapLayer.ts` 89, `feedbackLayer.ts` 201) | 508 | `cropLayer.ts` kept on `lowerCanvasEl`; `framePreview.ts` -> `renderFrameBitmap.ts`; `layerList.ts` & `captionSnapLayer.ts` -> `isText`/DOM measurer; `feedbackLayer.ts` lifts via CSS `.is-lifted`. | 2b, 2c-iii, 2d |

### Local-only clipboard sanitization and Markdown paste (Finding 15 — Owner Decision 5, Option C)
Slices 2a to 3a ship the "default allowlist" and literal plain text below, which is today's rule. Slice 3b switches to the expanded allowlist and adds Markdown conversion.
- **Format precedence on paste inside `EditorView`:**
  1. `text/html` present -> parse using **`new DOMParser().parseFromString(html, 'text/html')`** (inert document: does **not** fetch images, scripts, or external CSS; **UNVERIFIED: prove zero network requests in Spike 0 S7**). Walk with strict allowlist:
     - **Dropped subtrees (always removed with children):** `script`, `style`, `iframe`, `object`, `embed`, `link`, `meta`, `img`, `picture`, `source`, `video`, `audio`, `svg`, `canvas`, `form`. All `src`, `srcset`, `href`, `style`, `background`, `on*` stripped (inline bold/italic/underline/strike from `style` may be mapped to semantic tags during the inert walk before dropping `style`).
     - **Default allowlist (Slices 2a to 3a — matches `README.md:110`):** `p`, `div`, `br`, `strong`, `b`, `em`, `i`, `u`, `s`, `del`, `strike`, `span`, `a` (unwrapped to text), and `h1`–`h6` flattened to bold normal-size paragraphs. Preserves `bold`, `italic`, `underline`, `strike` only; never brings size, colour, font, or heading level.
     - **Expanded structural allowlist (from Slice 3b):** adds `h1`–`h3` (`h4`–`h6` -> `h3`), `ul`, `ol` (`start`), `li`, `blockquote`, `pre`, `code`, `hr`, `input[type=checkbox]` (`data-type`/`data-checked`/`checked` inside task `li`), and internal `data-font` (member of `FONT_IDS` only).
     - **HTML that carries nothing we keep (from Slice 3b):** if the sanitized result is only plain paragraphs with no marks (what a code editor puts on the clipboard for a Markdown file, wrapped in colour spans), it is treated as plain text and continues at step 2 with the clipboard's `text/plain`.
  2. `text/plain` -> split on `\r?\n` into `paragraph` nodes. Through Slice 3a markers stay literal. From Slice 3b the text first goes through the Markdown converter below.
  3. **Pending marks/font at caret:** active `state.storedMarks` apply to pasted text at the caret (`README.md:110`), converted or not.
  4. Clipboard image files while editing text -> ignored (not embedded in text cards).
- **Markdown conversion of pasted plain text (Slice 3b; pure, in `src/model/markdownPaste.ts`, no new dependency):** `markdownToBlocks(text: string): BlockNode[] | null` returns `null` when it finds no marker, and the paste is then exactly the literal paste.
  - **Markers converted, the same set the typing shortcuts convert:**
    - At the start of a line: `# `, `## `, `### ` (heading); `- ` (bullet); `1. ` or any `N. ` (numbered, starting at the first item's number); `- [ ] ` and `- [x] ` (checklist); `> ` (quote); a line that is exactly `---` (divider); a line starting with ```` ``` ```` opens a code block that runs to the next such line or the end of the paste (a language name after the fence is dropped).
    - Inside a line: `**bold**`, `*italic*`, `` `code` ``.
  - **Literal cases are shared with typing:** the pinned cases (`2 * 3 * 4`, `a ** b`, `* item`, `**`, `snake*case*`, `***x***`, `#tag`, `#### four`, `a # b`, `** x**`, `*x *`, `#x`) live in one fixture table, `src/model/testing/literalCases.ts`, imported by both `textRules.test.ts` and `markdownPaste.test.ts`, so the typed and pasted rules cannot drift apart.
  - **Stays plain text, characters untouched:** links `[text](url)`, images, tables, raw HTML, `_underscore_` emphasis, `~~strike~~`, `* ` and `+ ` bullets, backslash escapes, headings underlined with `===`.
  - **Lines and nesting:** every line of the paste becomes one block; a blank line becomes an empty paragraph, except that one blank line between two items of the same list is dropped so the list stays one list. A list line indented by two or more spaces, or a tab, under an item nests one level deeper, up to `MAX_BLOCK_DEPTH`; deeper lines stay at the deepest level.
  - **Never converted:** a paste with the caret inside a code block or with inline code pending; a drop; anything typed, composed or loaded (those rules are unchanged); a conversion whose result would exceed `MAX_NODES` or `MAX_TEXT_LENGTH`, which falls back to the literal paste.
  - **Undo:** a converted paste is two ProseMirror transactions separated by `closeHistory(tr)`: (1) insert the literal lines exactly as a plain paste would, (2) replace that range with the converted blocks. `Ctrl/Cmd+Z` (or the toolbar Undo) straight after returns the literal text; a second undo removes the paste. Backspace after a paste deletes a character as usual: `shortcutRevert` is not set by a paste.
  - **Literal paste:** `Ctrl/Cmd+Shift+V` inserts the clipboard's `text/plain` with no HTML handling and no conversion. Spike 0 S7 showed how this arrives: a real `Ctrl+Shift+V` in Windows Chromium puts no `text/html` on the paste and ProseMirror passes `plain = true` to `transformPastedText` and `clipboardTextParser`, but **`handlePaste` gets no such flag**. So the paste path is built on those hooks: HTML is sanitized in `transformPastedHTML` (which is not called for a plain paste), and Markdown conversion lives in `clipboardTextParser`, which converts only when `plain` is false. Not verified: macOS `Cmd+Shift+V`. When parsing sanitized HTML, pass `preserveWhitespace` so ProseMirror's `DOMParser` does not collapse runs of spaces.
- **Settled rule this changes:** "Pasted, dropped, composed and loaded markers stay literal" (`docs/expected-behavior.md:33`) becomes "dropped, composed and loaded markers stay literal; pasted plain text is converted by `markdownToBlocks`, and `Ctrl/Cmd+Shift+V` pastes it literally". The review trap "a typing shortcut that fires on pasted, dropped or composed text" (`docs/engineering-reference.md:29`) stays: paste conversion never goes through `handleTextInput`. Both files and the README change in the Slice 3b commit.

---

## 12. Slices and safe checkpoints

Per `AGENTS.md:45-48, 53`, every slice is a safe checkpoint, runs `npm run lint && npm run typecheck && npm test && npm run build` (plus `npm run test:e2e` for Slices 2–5), and passes an **independent subagent review** on the committed artifact in an isolated archive copy before the next slice begins.

### Pre-slice: Spike 0 (throwaway branch/prototype, not committed to main work)
Proves every `UNVERIFIED` claim in real Chromium before Slice 1 starts (exact exit criteria in Section 16).

### Slice 1: Pure rich-document model, validation, legacy conversion, and storage fencing
- **What the user sees:** Identical app (Fabric renderer unchanged). Stored boards gain support for validating, round-tripping, and fencing rich text documents.
- **Files touched:** `src/model/types.ts`, `src/model/textDoc.ts` (new), `src/model/doc.ts`, `src/persistence/boardStore.ts` (v3 fence, Owner Decision 1), `src/model/textDoc.test.ts`, `src/model/doc.test.ts`, `src/persistence/boardStore.test.ts`, `e2e/storage.spec.ts`, `README.md` and `docs/expected-behavior.md` (storage versions 1 to 3).
- **Safe checkpoint:** Existing Fabric renderer and all existing unit/e2e tests pass unchanged; storage format is valid and strictly fail-closed on unknown future block types or DB versions.
- **Acceptance tests that can fail:**
  1. `failed-restore-blocks-writes-on-unknown-block-type`: v3 board containing `{ type: 'table' }` causes `parseDoc` to return `null`, board opens read-only, writes and prunes are blocked. (Fails if validator silently drops unknown blocks.)
  2. `v3-fence-blocks-stale-v2-tab`: saving first card with `blocks` promotes DB to v3 in one transaction; a v2 store cannot open or overwrite it. (Fails if DB stays v2.)
  3. `legacy-utf16-emoji-crlf-empty-heading-roundtrip`: UTF-16 spans after ZWJ emoji and `\r\n` plus empty H2 line convert to `RichDoc` and back identically. (Fails on offset/grapheme drift.)
  4. `canonical-richdoc-equality-noop`: shuffled mark keys, split identical runs, and bold inside a heading canonicalize identically so `sceneEqual` returns `true`.
- **Review gate:** Independent review of Slice 1 commit against Section 5 and the storage rules in `docs/expected-behavior.md`.

### Slice 2 (6 reviewable checkpoints; Fabric stays live until Slice 2d)
Because images, frames, and text must flip together for z-order interleaving, Slice 2 splits into six bounded commits (`2a`, `2b`, `2c-i`, `2c-ii`, `2c-iii`, `2d`):

**Dual-path seam (`TextAdapter`) & real cost (instead of ad-hoc `if` branches):**
- Measured in `src/editor/Editor.ts` (`grep -c` via `git show <ref>:src/editor/Editor.ts`): on `feat/milestone-2-frames` (`98ea0f4`, 1,927 lines), `Textbox` appears on **30** lines, `isEditing` on **18**, `hiddenTextarea` on **1**, `this.pending` on **7**, `this.typed` on **4**, `this.shortcutRevert` on **10**, plus **4** `c.on('text:...')` handlers (`L727, 728, 758, 763`). On `origin/feat/captions-frame-navigation-nov22` (`6ad246c`, 3,211 lines), `Textbox` appears on **56** lines, `isEditing` on **20**, `FabricImage` on **6**, `hiddenTextarea` on **1**, `this.pending` on **7**, `this.typed` on **4**, `this.shortcutRevert` on **10**, plus **4** `c.on('text:...')` handlers (`L1076, 1077, 1111, 1116`).
- Rather than scattering branches across those call sites, `Editor.ts` talks to both "a text object on the board" and "the text being edited" through **one interface: `TextAdapter` (`src/editor/textAdapter.ts`)** — two implementations during `2c-i`–`2c-iii` (`FabricTextAdapter`, `DomTextAdapter`), collapsed to one in `2d`:
  - **Board-text operations:** `isText(obj)`, `isBlank(obj)`, `fontSizeOf(obj)`, `setFontSize(obj, px)`, `formatInfo(obj)`, `normalizeScale(obj)`, `hasDetachedBackground(obj)`.
  - **Active-edit & formatting operations:** `isEditing(obj?)`, `editedTarget()`, `editedRoot()`, `startEditing(obj, e?)`, `finishEditing()`, `toggleMark(obj, mark)`, `setHeading(obj, level)`, `setFont(obj, font)`, `setAlign(obj, align)`, `setColor(obj, color)`, `revertShortcut()`, `onKeyDown(e)`, `onKeyUp()`, `resetTransient()`, `bindCanvasEvents(canvas)`.
  - **Existing `Editor.ts` members moving behind `TextAdapter`** (HEAD / captions-base lines): fields `pending` (`L237`/`L372`), `typed` (`L243`/`L378`), `shortcutRevert` (`L250`/`L385`), `selectionSyncQueued` (`L252`/`L387`); handlers `text:editing:entered` (`L727`/`L1076`), `text:changed` (`L728`/`L1077`), `text:selection:changed` (`L758`/`L1111`), `text:editing:exited` (`L763`/`L1116`); methods `textFormatInfo` (`L541`/`L807`), `pendingFor` (`L559`/`L825`), `setPending` (`L563`/`L829`), `dropPendingBoldOnHeading` (`L574`/`L840`), `syncSelection` (`L588`/`L854`), `queueSelectionSync` (`L598`/`L864`), `finishEditing` (`L1433`/`L1962`), `formatTarget` (`L1670`/`L2644`), `formatText` (`L1678`/`L2652`), `typingShortcut` (`L1763`/`L2738`), `revertShortcut` (`L1789`/`L2764`), plus the Fabric bodies of `setFontSize`, `toggleMark`, `setHeading`, `setTextFont`, `setTextAlign`, `setTextColor` (`L1645–1744`/`L2613–2720`) and `handleKeyDown`'s editing/revert branch (`L1290–1325`/`L1769–1810`). Remaining `Editor.ts` `instanceof Textbox` checks (`snapshot`, `selectionInfo`, `settleScale`, `addTextAt`, and captions-base caption/layer helpers) call `this.text.isText(obj)` (and `isImage(obj)` for the 6 `FabricImage` checks).
- **What a reviewer of `2c-i`–`2c-iii` MUST verify to prove the default Fabric path is untouched:** (1) `FabricTextAdapter` is a mechanical extraction of existing `Editor.ts` logic with zero behavioral changes to `reconcileTextFormatting`, `replaceEditedText`, `applyTextFormatting`, `DrawnTextbox`, or `objects.ts`'s Fabric `createObject`; (2) when `renderer === 'fabric'` (default), `SceneRenderer` is never constructed (`.scene-layer` not mounted), `createObject` never builds `ProxyRect`, `FrameCanvas` still paints `FRAME_FILL`, and `.editor-stage` capture routing is not bound; (3) every existing Vitest suite and all 19 existing Playwright specs pass unchanged without `window.__YURIFUL_RENDERER__`.

**Test-only switch in `npm run dev` & storage safety proof before Slice 2d:**
- **Exact reachability:** `new Editor(host, store, assets, { renderer?: 'fabric' | 'dom', measurer? })` defaults to `'fabric'`. `src/App.tsx` (`L16` HEAD / `L18` captions-base) passes `'dom'` **only** when `import.meta.env.DEV && (window as { __YURIFUL_RENDERER__?: string }).__YURIFUL_RENDERER__ === 'dom'` at mount. Because the owner runs `npm run dev` daily (`DEV === true`), there is deliberately no UI toggle, URL query param, shortcut, or `localStorage` flag — reaching `'dom'` in dev requires JS executing *before* React mounts (Playwright `page.addInitScript`). `npm run build` compiles `import.meta.env.DEV` to `false` and tree-shakes the branch out.
- **Storage safety property:** Even if a real dev board is opened and saved on `'dom'` before the Slice 2d flip, the stored board is **guaranteed** to be in the exact wire v1/v2 shape that the default Fabric path reads and renders identically — and never trips the v3 fence before Slice 3a:
  - `2c-i` writes only existing `FrameRecord`, `ImageRecord`, and `TextRecord` fields (`id, type, left, top, angle, text, fontSize, width, minHeight?, font?, align?, color?, spans?, headings?, frameId?`).
  - `2c-ii` mounts Slice 2's Milestone-2-only `textSchema` (`paragraph`, `heading(1..3)`, `bold`/`italic`/`underline`/`strike`/`font` — no rich blocks or inline `code`). By Section 5 canonicalization rule 5, every such `RichDoc` collapses to `{ text, spans?, headings? }` with `blocks` omitted; `height` is never written before Slice 4 and `surface` never before Slice 5 (new boxes stay bare until then).
  - `2c-iii` writes only existing captions-base optional fields (`crop`, `locked`, `captionOf`, `captionSide`, `captionPosition`, `captionBackground`), all parsed by `origin/feat/captions-frame-navigation-nov22:src/model/doc.ts:24-78`.
  - Therefore `needsRichFence(doc)` (`blocks !== undefined || height !== undefined || surface !== undefined`) is identically `false` throughout Slice 2: `serializeDoc` writes only wire `v1` or `v2`, DB stays v1/v2, and reopening on Fabric reads and renders every field identically.

#### Slice 2a: Headless ProseMirror schema, Milestone-2 rules, and `EditSession`
- **User sees:** Nothing new (Fabric untouched).
- **Files:** `package.json`/`package-lock.json` (8 `prosemirror-*` deps), `src/editor/textSchema.ts` (Milestone 2 subset + `DOMSerializer`), `src/editor/textRules.ts` (`#`/`##`/`###`, `**bold**`, `*italic*`, pinned literals, heading-bold guard, `closeHistory` + `shortcutRevert`), `src/editor/textSession.ts`, `src/editor/{textSchema,textRules,textSession}.test.ts`.
- **Failing-capable tests (Vitest, real `prosemirror-state`/`model`/`history`):** (1) `heading-never-stores-bold-and-drops-pending-bold` (`appendTransaction` strips `bold` in headings and drops `bold` from `storedMarks` while keeping other pending marks); (2) `pinned-literal-cases-and-backspace-plus-ctrl-z-after-shortcut` (`2 * 3 * 4`, `* item`, `snake*case*`, `***x***`, `#tag`, `#### four`, pasted `**x**` stay literal; Backspace restores markers + pre-shortcut `storedMarks`; `Ctrl/Cmd+Z` undoes only the conversion back to markers and clears `shortcutRevert`); (3) `empty-last-line-and-selection-at-line-start` (whole-box heading skips trailing empty paragraph while Body clears it; selection ending at `$to.parentOffset === 0` excludes that block).
- **Review gate:** Independent review of Slice 2a (`lint`, `typecheck`, `test`, `build`).

#### Slice 2b: DOM scene layer (`sceneLayer.ts`) and interleaved bitmap compositor (`renderFrameBitmap.ts`)
- **User sees:** Nothing new (Fabric untouched; no page imports `sceneLayer.ts` or `renderFrameBitmap.ts` yet).
- **Files:** `src/editor/sceneLayer.ts`, `src/editor/renderFrameBitmap.ts`, `src/styles.css`, `src/editor/sceneLayer.test.ts` (Vitest), `e2e/scene-layer.spec.ts` (Chromium harness).
- **How browser tests run before 2c:** Playwright's `webServer` already runs Vite (`playwright.config.ts:36-41`), and existing e2e tests import TS modules directly from it on `/__blank` (`e2e/helpers.ts:218-220`, `e2e/storage.spec.ts:121-122` importing `/src/persistence/testing/legacyStoreV1.ts`). `e2e/scene-layer.spec.ts` uses the same pattern: opens `/__blank` with `<link rel="stylesheet" href="/src/styles.css">`, dynamically `await import(/* @vite-ignore */ '/src/editor/sceneLayer.ts')` and `/src/editor/renderFrameBitmap.ts` inside `page.evaluate()`, and mounts `.scene-layer` into `document.body` without touching `App.tsx` or `Editor.ts`.
- **Failing-capable tests (split by runtime):**
  - **Vitest (`src/editor/sceneLayer.test.ts`, pure math/serialization):** (1) `matrix-projection-matches-rotated-scaled-group-member` (`projectMatrix(M, w, h)` matches scene top-left within `0.1px` at `0°`/`45°`, standalone & `ActiveSelection`); (2) `viewport-culling-and-foreignobject-xhtml-escaping` (offscreen culling margin + XHTML escaping of `<>&"` in SVG payload).
  - **Chromium (`e2e/scene-layer.spec.ts`, real layout + CSS + 2D canvas):** (1) `cropped-image-wrapper-clips-and-crop-mode-reveals-original` (CSS `overflow: hidden` + `translate(-crop.x, -crop.y)` idle clip and full reveal in crop mode); (2) `dom-card-measurer-ignores-zoom-and-rotation` (`DomCardMeasurer` height at `45°` + zoom `0.5`/`2` and `dynamicMinWidth`); (3) `bitmap-compositor-preserves-text-image-text-z-order-and-crop` (`renderFrameBitmap` draws Text A, cropped Image I, Text B in `objects[]` order onto a non-tainted canvas verified via `toBlob()` + pixels).
- **Review gate:** Independent review of Slice 2b in isolated copy on separate `E2E_PORT` (`lint`, `typecheck`, `test`, `build`, `e2e/scene-layer.spec.ts`).

#### Slice 2c-i: `TextAdapter` extraction + static DOM scene (proxies, transforms, frames, ownership behind `renderer: 'dom'`)
- **User sees:** Nothing new (default stays `'fabric'`; all existing unit/e2e tests pass untouched).
- **Files:** `src/editor/textAdapter.ts` (new: `FabricTextAdapter` + static/whole-box `DomTextAdapter`), `src/editor/objects.ts` (`ProxyRect` factory alongside Fabric), `src/editor/Editor.ts` (`renderer` option, `TextAdapter` delegation, `SceneRenderer` + `before:render`), `src/editor/FrameCanvas.ts`, `src/App.tsx` (dev-only `__YURIFUL_RENDERER__`), `src/editor/testing/{fakeFabric,fakes}.ts`, `e2e/interleaving.spec.ts` (static/transform/frame cases).
- **Failing-capable tests (Playwright with `addInitScript` -> `renderer: 'dom'`):**
  1. `z-order-text-image-text-with-frame-outline-and-paper-stack`: static Text A, Image I, Text B composited pixel order with frame paper behind and frame outline/label above.
  2. `group-scale-once-and-frame-ownership-on-dom-proxies`: Frame + Text + Image scaled by `k` scales once (not `k²`); move/resize ownership rules preserved.
  3. `readonly-dom-scene-blocks-selection-and-writes`: failed-restore read-only board renders static DOM scene and blocks selection/edits/writes.
- **Review gate:** Independent review of `2c-i` in isolated copy on separate `E2E_PORT` (verifies default Fabric path untouched per checklist above; existing Fabric suite + `2c-i` DOM tests green).

#### Slice 2c-ii: Live ProseMirror editing, pointer routing, and `EditSession` wired into `Editor`
- **User sees:** Nothing new (default stays `'fabric'`).
- **Files:** `src/editor/textAdapter.ts` (live `DomTextAdapter` + `EditSession`), `src/editor/Editor.ts` (`.editor-stage` capture/wheel/outside-path, Text-tool drag on DOM path, `undo()`/`redo()` and `canUndo`/`canRedo` delegating to the session on the DOM path), `src/input/shortcuts.ts` (`editedRoot`), `e2e/interleaving.spec.ts` (editing/routing/occlusion cases).
- **Failing-capable tests (Playwright with `addInitScript` -> `renderer: 'dom'`):**
  1. `covering-image-shows-default-cursor-and-click-ends-edit-to-select-image`: image `I` covering edited card `A` shows `default` cursor; clicking `I` ends edit and selects `I`.
  2. `outside-click-ends-edit-and-blur-keeps-edit-open`: one-press click to select/drag another object, Shift-click out of blank card, Text-tool drag while editing; focusing Font size / Title or window `blur` keeps edit open.
  3. `enter-exit-edit-zero-jump-and-typing-shortcut-roundtrip`: enter/exit height delta `<= 0.5px`; `# ` / `**bold**` + Backspace revert + in-edit `Ctrl/Cmd+Z` + board-level Undo.
  4. `toolbar-undo-steps-typing-and-keeps-the-edit-open`: type two words, press the toolbar Undo button once -> one step is undone, the caret is still in the card and `editingText` is true; Redo restores it; with nothing left to undo the button is disabled; after Esc the same button undoes the whole edit as one board step. (Fails if the button still calls `finishEditing()`.)
  5. `in-edit-undo-skips-whole-box-settings`: change the font size mid-edit, type a word, undo twice -> the word is gone and the size change remains; after Esc, board Undo restores the original size and text together.
  6. `pasted-html-is-inert-and-keeps-marks-only`: with `page.route('**/*', ...)` recording requests, pasting `<img src="https://example.invalid/x.png"><style>@import url(https://example.invalid/a.css);</style><h2>Head</h2><p><strong>ok</strong></p>` makes zero requests, and `Head` and `ok` arrive bold at normal size (today's rule, which holds until Slice 3b). (Fails if the new paste path assigns clipboard HTML to live DOM.)
- **Review gate:** Independent review of `2c-ii` in isolated copy on separate `E2E_PORT` (existing Fabric suite + `2c-i`/`2c-ii` DOM tests green).

#### Slice 2c-iii: Base-branch features on the DOM path (`crop`, `captions`, `locks`, `duplicate`, `layerList`, `feedbackLayer`, `framePreview`)
- **User sees:** Nothing new (default stays `'fabric'`).
- **Files:** `src/editor/Editor.ts` (`startCrop`/`syncCaptions`/`setLocked`/`duplicateSelection` on DOM path), `src/editor/cropLayer.ts` (overlay above `.scene-image`), `src/editor/captionSnapLayer.ts` (DOM `makeSnapCaption`), `src/editor/layerList.ts` (`isText`), `src/editor/feedbackLayer.ts` (`.is-lifted`), `src/editor/framePreview.ts` (`renderFrameBitmap` on `'dom'`), `e2e/interleaving.spec.ts` (captions-base cases).
- **Failing-capable tests (Playwright with `addInitScript` -> `renderer: 'dom'`):**
  1. `cropped-image-renders-edits-and-reloads-in-dom-scene`: CSS crop clips, crop mode reveals original under `cropLayer.ts`, commit keeps pixels stationary and persists.
  2. `attached-caption-snaps-follows-image-and-edits-in-prosemirror`: snaps via `captionSnapLayer.ts`, shows `captionBackground`, follows image, edits in ProseMirror, reloads intact.
  3. `locked-card-lifted-drag-duplicate-and-frame-preview-on-dom-path`: locked card is click-through/uneditable (padlock in `layerList.ts` unlocks); drag toggles `.is-lifted`; `Ctrl/Cmd+D` duplicates frame + cropped image + formatted card once sharing bytes; `framePreview.ts` renders rich spread.
- **Review gate:** Independent review of `2c-iii` in isolated copy on separate `E2E_PORT` (all 19 existing Fabric e2e specs + full `e2e/interleaving.spec.ts` green).

#### Slice 2d: Flip default to DOM renderer, migrate e2e probes, and delete old Fabric path
- **User sees:** All Milestone 2 (and captions-base) features now run on `.scene-layer` + ProseMirror with crisp DOM text, step-by-step undo while typing from `Ctrl/Cmd+Z` and from the toolbar buttons, full z-order interleaving, and working frame previews. Dragging selected words from one text box into another no longer works (cut and paste instead). New text boxes are still bare.
- **Files:** Flip default & delete `FabricTextAdapter`, `renderer` option, and old Fabric path in `Editor.ts`, `textAdapter.ts`, `objects.ts`, `App.tsx`, `richText.ts`, `fakeFabric.ts`; delete `DrawnTextbox.ts`; rewrite unit tests (`richText.test.ts`, `objects.test.ts`, `Editor.{text,formatting,typing,texttool}.test.ts`); migrate probes per Section 14; update `README.md`, `docs/expected-behavior.md` and `docs/engineering-reference.md` (Section 17).
- **Failing-capable tests:** (1) Full migrated 19-spec Playwright suite + `interleaving.spec.ts` pass on the single DOM path with zero dual-path flags; (2) `legacy-fixture-geometry-and-wrapping-preserved` (seeded Milestone 1/2 boards keep byte-equal geometry/`frameId`, DOM width within `1px`, exact `2×/1.5×/1.25×` heading sizes); (3) `no-fabric-textbox-or-dual-flag-remains` (typecheck, build, unit tests pass with `DrawnTextbox.ts`, `FabricTextAdapter`, `Textbox` fake, and `renderer` flag deleted).
- **Review gate:** Independent review of Slice 2d in isolated copy on separate `E2E_PORT` (full gate + e2e).

### Slice 3a: Long-form writing blocks and live Markdown shortcuts
- **What the user sees:** Bullet lists (`- `), numbered lists (`1. `), clickable checklists (`- [ ] ` / `- [x] `), blockquotes (`> `), dividers (`---`), inline code (`` `code` ``), fenced code blocks (```` ``` ````), Backspace revert for every shortcut, `Tab` / `Shift+Tab` to indent and outdent a list item, and Inspector block buttons. A card holding only a divider or a ticked checkbox is kept when you click away. Paste still follows today's rule (marks only; markers literal).
- **Files touched:** `src/editor/textSchema.ts`, `src/editor/textRules.ts`, `src/editor/textSession.ts`, `src/editor/Editor.ts`, `src/model/textDoc.ts` (`isBlankTextDoc` with dividers and checked tasks), `src/editor/layerList.ts` (`'Text'` fallback label), `src/ui/Inspector.tsx`, `src/ui/icons.tsx`, `src/styles.css`, unit tests (`textRules.test.ts`, `textDoc.test.ts`, `Editor.writing.test.ts`), `e2e/writing.spec.ts`, `README.md`, `docs/expected-behavior.md`. Inspector labels go through the `clean-copy` skill.
- **Safe checkpoint:** All rich blocks validate, canonicalize, save (under v3 fence), undo/redo, reload, and render in frame previews.
- **Acceptance tests that can fail:**
  1. `checklist-typed-char-by-char-upgrades-bullet-without-trapping` (Playwright): Typing `- [ ] Buy vinyl` produces an unchecked `taskItem`; clicking checkbox toggles `checked` and persists across reload; Backspace straight after `[ ] ` restores literal text. (Fails if `- ` traps `[ ] ` inside a bullet.)
  2. `divider-only-and-ticked-box-cards-are-kept` (Playwright): a new card holding only `---`, or only a ticked empty checkbox, survives Esc, is saved, reloads, and is listed as `Text` in the layer panel; a new card holding only an empty bullet or an unticked empty checkbox is discarded with no history and no save. (Fails if blankness is still text-only.)
  3. `pinned-literal-cases-empty-list-discard-and-backspace-revert` (Playwright): `2 * 3 * 4`, `snake*case*`, `* item`, `#tag`, `#### four`, pasted `- item`, and IME-composed `- ` stay literal; deleting the last text from an existing card leaving an empty list discards it on exit as 1 undo step; Backspace straight after `> `, `---`, `` `code` `` restores exact literal characters.
  4. `tab-indents-in-lists-and-exits-elsewhere` (Playwright): `Tab` on a second list item nests it and `Shift+Tab` lifts it back, the edit staying open; `Tab` in a paragraph ends the edit; `Tab` on a first list item changes nothing and keeps the edit open.
- **Review gate:** Independent review of Slice 3a commit.

### Slice 3b: Paste that keeps structure, and Markdown paste
- **What the user sees:** Text copied from a web page or another card arrives with its headings, lists, checklists, quotes, code and dividers. Pasted plain Markdown is converted the way typing it would have been; `Ctrl/Cmd+Z` straight after gives back the literal text, and `Ctrl/Cmd+Shift+V` always pastes literally.
- **Files touched:** `src/model/markdownPaste.ts` (new), `src/model/markdownPaste.test.ts`, `src/model/testing/literalCases.ts` (new shared fixture), `src/editor/textSession.ts` (paste handling, expanded allowlist, two-step history), `src/editor/textRules.test.ts` (imports the shared fixture), `e2e/writing.spec.ts`, `README.md`, `docs/expected-behavior.md`, `docs/engineering-reference.md`.
- **Safe checkpoint:** Every pasted document passes the same validator bounds as a typed one; a paste that would exceed them is pasted literally.
- **Acceptance tests that can fail:**
  1. `pasted-html-never-fetches-remote-resources` (Playwright): `page.route('**/*', ...)` asserts zero external requests when pasting HTML with `<img src="https://...">`, `<link>`, and `<style>@import</style>`, while allowed tags paste cleanly, lists and headings keep their structure, and pending caret marks apply to pasted text.
  2. `pasted-markdown-converts-and-undo-returns-literal` (Playwright): pasting `# Title`, a blank line, `- one`, `- [x] two`, `> quote`, `**bold** and 2 * 3 * 4` yields a heading, an empty paragraph, a bullet, a ticked task, a quote and a paragraph whose only bold run is `bold`; one `Ctrl/Cmd+Z` restores the six literal lines; a second removes the paste. (Fails if markers stay literal, or if undo removes the paste in one step.)
  3. `literal-paste-shortcut-and-contexts-that-never-convert` (Playwright): `Ctrl/Cmd+Shift+V` of the same clipboard inserts literal lines; a paste inside a code block stays literal; text dragged within the card stays literal; clipboard HTML that is only colour spans (as copied from a code editor) is converted from its plain text.
  4. `markdown-paste-shares-the-typed-literal-cases` (Vitest): every row of `literalCases.ts` stays literal through `markdownToBlocks` and through `textRules`. (Fails if either rule set drifts.)
- **Review gate:** Independent review of Slice 3b commit.

### Slice 4: Auto-grow / manual fixed scrollable height
- **What the user sees:** Dragging a text card's bottom handle (`mb`) fixes its height. The wheel scrolls a fixed-height card you are hovering, whether or not you are editing it; a scroll that started on empty canvas keeps panning the board as cards pass under the pointer, and a card that reaches its end stops rather than moving the board. Fades at the top and bottom show there is more text, and a thin scroll thumb appears while scrolling. Corner scaling scales fixed height proportionally; double-clicking `mb` or clicking **Auto height** in Inspector returns it to auto-grow.
- **Files touched:** `src/editor/objects.ts`, `src/editor/sceneLayer.ts` (`scrollTops`, fades, thumb), `src/editor/Editor.ts` (wheel ownership), `src/ui/Inspector.tsx`, `src/styles.css`, `e2e/card-height.spec.ts`, `README.md`, `docs/expected-behavior.md`.
- **Safe checkpoint:** Fixed-height and auto-grow cards both save, scale, undo/redo, reload, never re-wrap when overflow begins on Windows, and clip from `scrollTop = 0` in frame bitmaps. Scrolling writes nothing.
- **Acceptance tests that can fail:**
  1. `bottom-handle-drag-fixes-height-no-rewrap-and-scrolls-without-panning` (Playwright): Drag `mb` shorter than content -> stores `height` with identical inner text width (0px wrap-width shrink on Windows); while editing, wheel scrolls card (`scrollTop > 0`, `viewport.panY` unchanged); leaving the edit keeps `scrollTop` and shows `.fade-top` and `.fade-bottom`; double-click `mb` clears `height` back to auto-grow.
  2. `corner-scale-scales-fixed-height-once-and-undo-restores` (Playwright): Fixed-height card scaled by `k` scales `fontSize`, `width`, `height` by `k` once; undo/redo exact.
  3. `rotated-zoomed-card-never-uses-bounding-client-rect` (Playwright): 45°-rotated auto-grow card at zoom `0.5` and `2` typed into -> proxy height stays untransformed local height, frame ownership centre accurate.
  4. `wheel-belongs-to-where-it-started` (Playwright, wheel events dispatched with controlled timing): (a) a wheel burst that starts on empty canvas and continues with the pointer over an idle fixed-height card pans the board the whole way and leaves the card's `scrollTop` at 0; (b) a burst that starts over the card scrolls it and leaves `viewport.panY` unchanged, including after the card reaches its end; (c) a new burst, more than `WHEEL_LATCH_MS` later, in the same direction over the card at its end pans the board; (d) an image in front of the card, or a frame label over it, makes the burst pan; (e) `Ctrl/Cmd`+wheel over the card zooms; (f) on a read-only board (a) to (c) hold and nothing is written. (Fails if ownership follows the pointer instead of the start, or if an idle card cannot scroll.)
  5. `scrolling-is-view-state-only` (Playwright): scrolling an idle card records no history step, schedules no save and changes no selection; undo then redo of an unrelated move keeps the card's scroll position; a reload returns it to the top; the frame preview shows the card from the top while it is scrolled on screen.
- **Review gate:** Independent review of Slice 4 commit + docs audit.

### Slice 5: Paper surface for new text boxes
- **What the user sees:** A text box made with the Text tool now sits on a padded paper background. The Inspector has a **Paper** button to turn it off or on for any text box; turning it on or off leaves the words exactly where they were. Boxes from before this slice, and captions made with **Add caption**, look as they did. The first new text box saved on a board performs the one-way storage upgrade.
- **Before coding:** the design pass in Section 6 (`frontend-design` for the look, `clean-copy` for the label), and the owner's approval of the look. Padding is frozen after this slice.
- **Files touched:** `src/model/doc.ts` and `src/model/textDoc.ts` (`surface` already validated since Slice 1; `setTextSurface` pure transform), `src/editor/objects.ts`, `src/editor/sceneLayer.ts` (`.has-paper`, measurer floors), `src/editor/renderFrameBitmap.ts` (inlined paper CSS, bleed if needed), `src/editor/Editor.ts` (`addTextAt` default, `setTextSurface`, caption creation stays bare), `src/ui/Inspector.tsx`, `src/ui/icons.tsx`, `src/styles.css`, unit tests, `e2e/paper.spec.ts`, `README.md`, `docs/expected-behavior.md`.
- **Safe checkpoint:** Paper and bare boxes both save, scale, undo/redo, reload and render in frame previews; a board with no new text box is still written in its old wire version.
- **Acceptance tests that can fail:**
  1. `new-box-has-paper-old-box-and-new-caption-stay-bare` (Playwright): a seeded pre-Slice-5 board renders its texts with no background and is not rewritten by loading; a click-created and a drag-created box store `surface: 'card'`; **Add caption** stores no `surface`; a blank new paper box discarded with Esc writes nothing and leaves the database version alone; typing in one upgrades the database to v3 in the same transaction as the save.
  2. `paper-toggle-keeps-words-in-place-and-is-one-undo-step` (Playwright): toggling Paper on a rotated, centred card moves no glyph by more than `0.5px`, keeps the line breaks, changes `width` by exactly `2 * padX`, records one history step, and never changes `frameId`; undo restores the record exactly.
  3. `paper-box-geometry-floors-and-click-origin` (Playwright): the first character of a click-created paper box starts at the press point; a side handle cannot narrow a paper box below `dynamicMinWidth + 2 * padX`; a corner scale by `k` scales padding with `fontSize` and stores no extra field.
  4. `paper-renders-in-frame-preview-and-with-caption-background` (Playwright): the frame preview bitmap shows the paper fill and edge unclipped at the card's position; a paper card attached as a caption keeps `surface`, and with a `captionBackground` its fill is that colour.
- **Review gate:** Independent review of Slice 5 commit + docs audit.

---

## 13. Lifecycle matrix (closes Finding 12)

Every failure case from `AGENTS.md:30-37` mapped to the new architecture:

| Lifecycle case | Mechanism in new design | Expected outcome | Pinning test |
|---|---|---|---|
| **Gesture interrupted by `Esc`** | `cancelGesture()` ends Fabric transform, calls `applyRecords(g.base)`, syncs DOM layer. | Restores exact pre-gesture scene, 0 history steps, 0 saves. | `e2e/gestures.spec.ts` (kept) |
| **Gesture interrupted by window `blur`** | `onBlur` calls `pan?.end()` and `cancelGesture()` (`Editor.ts:1217-1225`). | Unfinished drag/scale/draft undone; 0 history/saves. Active text edit stays open (matching `docs/rich-text-plan.md:364`). | `e2e/gestures.spec.ts`, `e2e/texttool.spec.ts` |
| **Reload mid-gesture or mid-edit** | Mid-gesture: `getDoc()` returns `gesture.base`. Mid-edit: typing already debounced/flushed on `pagehide`/`visibilitychange`. | Mid-gesture: pre-gesture board preserved. Mid-edit: latest typed text + owner preserved (blank cards never saved). | `e2e/gestures.spec.ts`, `e2e/frames.spec.ts:656` |
| **Board goes read-only mid-gesture** | `enterReadOnly` calls `autosaver.disable`, `cancelGesture`, sets `readOnly`, drops staged imports. | Gesture restored to `g.base`, read-only banner shown, 0 writes. | `Editor.hydration.test.ts`, `e2e/storage.spec.ts` |
| **Board goes read-only mid-edit** | `enterReadOnly` sets `readOnly` BEFORE `finishEditing()`. | `EditorView` unmounts cleanly, visible static text stays on screen, 0 commits, 0 writes, `pointer-events` restored to pan-only. | `Editor.writing.test.ts`, `e2e/writing.spec.ts` |
| **Second mouse button mid-drag / lost release** | `.editor-stage` capture blocks non-primary from Fabric; window capture stops non-primary `mouseup` while `primaryDown`; `healPrimaryDown` checks `e.buttons & 1`. | Drag continues uninterrupted; lost release heals on next mouse event. | `e2e/gestures.spec.ts:225`, `e2e/frames.spec.ts:604` |
| **Autosave debounce fires / save in flight during gesture or edit** | During gesture: `getDoc()` reads `gesture.base`. During edit: `getDoc()` reads live canonical `meta.textData` (excluding blank cards); `Autosaver.changedWhileSaving` re-queues after in-flight save finishes (`autosave.ts:90,158`). | Save never sees half-finished transform; mid-edit saves stay durable and never lose keystrokes typed while saving. | `e2e/gestures.spec.ts:50`, `Editor.writing.test.ts` |
| **Image import finishes decoding during text draft or edit** | During draft: queued in `stagedImports`, applied by `idle()` BEFORE `addTextAt` (`Editor.ts:892-893`). During edit: `applyImport` calls `finishEditing()` first (`Editor.ts:1554`). | Draft: image added as step 1, new text stays open for typing. Edit: text committed as step 1, image added as step 2. | `e2e/texttool.spec.ts:415`, `Editor.writing.test.ts` |
| **Another tab writes board or prunes image bytes** | Token check inside IDB write tx (`boardStore.ts:178`); `AssetCache` retains session bytes (`assets.ts:23`). | Stale tab gets `BoardConflictError` -> `enterReadOnly(..., true)` (ends edit, no overwrite). Undoing deleted image re-stores pruned bytes. | `e2e/storage.spec.ts:159,211` |
| **Every way of leaving a text edit** (Esc, empty canvas click, other object click, Shift-click, frame outline click, toolbar tool button, Inspector non-format button) | `Esc`: `handleKeyDown`. Canvas/object/Shift/frame clicks: `.editor-stage` capture -> `finishEditing()` -> re-dispatch to `upperCanvasEl`. Tool switch/Arrange/Delete: method calls `finishEditing()`. Formatting buttons, and the Undo and Redo buttons (Owner Decision 11): `preventDefault` on `mousedown` -> edit stays open! | Exactly 1 board history step (if net change), typing already saved, clicked target selected/dragged in same press, formatting and Undo/Redo buttons keep the caret and the edit. | `e2e/typing.spec.ts:294`, `e2e/formatting.spec.ts`, `e2e/writing.spec.ts` |
| **Focus moving to Title or Font-size `<input>`, or window `blur`, mid-edit** | ProseMirror `blur` never calls `finishEditing()` (matching Fabric `ITextKeyBehavior.ts:106` and `Editor.ts:1217-1225`). `isEditableTarget` (`shortcuts.ts:39-50`) blocks canvas shortcuts; `editedRoot.contains` scopes `Ctrl/Cmd+B/I/U` & Backspace revert to the edited card. | Edit stays open (including `shortcutRevert` across window blur/refocus, `docs/rich-text-plan.md:364`); Font size & Title inputs work without closing the edit. | `e2e/interleaving.spec.ts`, `e2e/formatting.spec.ts` |
| **Undo / redo straight after edit exit** | `applyRecords` destroys any session, rebuilds proxies & DOM, flushes `syncCardSize`. | Restores exact pre-edit/post-edit `TextRecord` + frame ownership + height; 0 drift. | `e2e/text.spec.ts`, `e2e/writing.spec.ts` |
| **Input before board finishes loading (`!live`)** | `.editor-stage` capture blocks mousedown/wheel; `handleKeyDown` returns early when `!this.live`. | Zero edits, zero history, zero writes before hydration completes. | `e2e/hydration.spec.ts` (kept) |
| **IME composition (`compositionstart`..`compositionend`)** | `textRules` ignores `view.composing`; `shortcuts.ts` ignores `e.isComposing`; `Esc` ignored while composing; `storedMarks` preserved through composition. | No shortcut fires on composed `*`/` `/`#`/`-`; pending marks apply to committed text. | `e2e/typing.spec.ts:233`, `e2e/formatting.spec.ts:263` |
| **Toolbar Undo or Redo pressed mid-edit, then the board goes read-only or the edit ends** | The buttons call `session.undo()` / `redo()`; `dispatchTransaction`'s guards (`!session.finished`, same session id, `editable`) drop a step that arrives after the session ended or the board went read-only. | An in-edit step is saved as typing is and adds no board history step; a press after read-only does nothing; ProseMirror history is discarded with the session, so no in-edit step can be replayed onto a later edit. | `e2e/interleaving.spec.ts`, `Editor.writing.test.ts` |
| **Wheel gesture that crosses a scrollable card, or is in flight when something else happens** | Owner is fixed at the gesture's first event (Section 4). Scrolling only sets `scrollTop`. A drag, draft or read-only switch that begins mid-gesture does not consult the wheel owner; the next gesture re-picks. `applyRecords` re-applies `scrollTops`; a removed card's entry is dropped. | No history, no save, no selection change, no ended edit; undo/redo keep each surviving card's position. | `e2e/card-height.spec.ts` |
| **Markdown paste interrupted or oversized** | Both paste transactions are dispatched synchronously in one `handlePaste` call, so no save, blur or read-only switch can fall between them; a result over the validator bounds is never built and the literal paste is used. | A save sees either the board before the paste or the converted paste, never the half-way literal state; the board cannot become unreadable through a paste. | `e2e/writing.spec.ts`, `markdownPaste.test.ts` |
| **Paper toggled mid-edit, or on a card whose owner frame it now overhangs** | `setTextSurface` keeps the centre and changes only `width` / `minHeight` / `height`; inside an edit it is part of the edit's one step and flushes `syncCardSize`. | Ownership never changes (formatting an existing text never does); one board step; undo exact. | `e2e/paper.spec.ts` |
| **Blank card discarded** | `finishEditing()` checks `isBlankTextDoc`; synchronously hides/disables proxy & removes from active selection; defers `canvas.remove(proxy)` + DOM removal to microtask. | Never throws inside callback, never leaks into Shift-click multi-selection, never saved. | `e2e/gestures.spec.ts:164-220`, `e2e/frames.spec.ts:637` |

---

## 14. Test plan (closes Finding 13)

### Unit tests (Vitest + jsdom)
- **Pure model (`src/model/*.test.ts`):** `textDoc.test.ts` (validator allowlist, depth/node bounds, unknown block strict rejection, lenient field cleaning, canonicalization, UTF-16/emoji/CRLF legacy conversion, `isBlankTextDoc`, whole-box formatting transforms).
- **Headless ProseMirror (`src/editor/textSchema.test.ts`, `src/editor/textRules.test.ts`):** Run real `prosemirror-state` + `prosemirror-model` + `prosemirror-history` + `textRules` directly in Vitest without `EditorView` layout (zero DOM geometry needed).
- **Editor state machines (`src/editor/Editor.*.test.ts`):** Inject `FakeCardMeasurer` and a `FakeTextSession` backed by real `prosemirror-state` so `Editor` tests exercise real schema/canonicalization/autosave/history/gesture/read-only state machines without jsdom `contenteditable` bugs (`getClientRects`/`DOMObserver` are absent in jsdom).

### E2E spec disposition (all 19 specs + 2 helpers on `origin/feat/captions-frame-navigation-nov22`, Playwright Chromium)
Helpers: `e2e/helpers.ts` adds a composited screenshot PNG sampler for pixel probes; `e2e/feel-helpers.ts` updates `shadows()` (`:55`, Fabric `obj.shadow`) to check `.scene-item.is-lifted` (proxies keep `bounds`/`controls`/`scene`/`history` intact).

| Spec | Disposition | Probe changes (verified on `origin/feat/captions-frame-navigation-nov22`) |
|---|---|---|
| `appearance.spec.ts` | **Probes rewritten** | Replace `textarea[data-fabric]` focus/absence (`L89, L92`) -> `.ProseMirror` focus/absence. |
| `caption-snap.spec.ts` | **Probes rewritten** | Replace `textarea:focus` (`L10, L124, L129, L260`) -> `.ProseMirror`; replace `captionBackgroundPixel` `lower-canvas` `getImageData` (`L377-384`) -> composited screenshot / `.scene-text` CSS `backgroundColor`. |
| `captions.spec.ts` | **Probes rewritten** | Replace `textarea:focus` (`L9, L122, L337, L365, L384, L395, L554, L578`) -> `.ProseMirror`; replace `lower-canvas` `getImageData` (`L68-71`) -> composited screenshot / `.scene-text` style. |
| `duplicate.spec.ts` | **Keep as-is** | None (UI + IDB probes only). |
| `feel.spec.ts` | **Probes rewritten** | `window.__feel.shadows()` (`L154, L166, L176, L183, L191, L281`) via `feel-helpers.ts` -> `.scene-item.is-lifted`; `textarea:focus` selection & `upper-canvas` `mousemove` (`L532-543`) -> `.ProseMirror` DOM selection & `.editor-stage`. |
| `formatting.spec.ts` | **Probes rewritten** | `editHasFocus` (`data-fabric='textarea'`, `L75`) -> `.ProseMirror`; `range()` (`textarea`, `L434`) -> `window.getSelection()`; `inkIn()` (`lower-canvas`, `L86-93`) -> composited screenshot / computed CSS. |
| `frame-navigation.spec.ts` | **Keep as-is** | None (UI, `img` preview visibility, and `__feel.viewport()` only). |
| `frames.spec.ts` | **Probes rewritten (L28-105)** | `pixel()`/`inkIn()` on `lower-canvas` (`L28-48`) for white paper -> composited screenshot + `.scene-frame` rect (outline/label stay on `lower-canvas`; `L108-1298` kept as-is). |
| `gestures.spec.ts` | **Keep as-is** | None (pointer + IDB probes only). |
| `hydration.spec.ts` | **Keep as-is** | None (UI + IDB probes only). |
| `images.spec.ts` | **Probes rewritten** | `lower-canvas` `getImageData` (`L106-109`) -> composited screenshot / `.scene-image` crop rect checks. |
| `layers.spec.ts` | **Probes rewritten** | `document.activeElement?.tagName === 'TEXTAREA'` (`L400`) -> `.ProseMirror` focus check (other `activeElement === document.body` checks unchanged). |
| `layout.spec.ts` | **Keep as-is** | None (UI + IDB probes only). |
| `locking.spec.ts` | **Probes rewritten** | `document.activeElement?.tagName !== 'TEXTAREA'` (`L282`) -> `!activeElement?.closest('.ProseMirror')` (`.upper-canvas` cursor probe at `L92` stays valid while idle). |
| `replace.spec.ts` | **Probes rewritten** | `lower-canvas` `getImageData` (`L90-93`) -> composited screenshot / `.scene-image img` checks. |
| `storage.spec.ts` | **Keep + extend** | None changed; add v3 rich-card fencing & old-tab rejection tests in Slice 1. |
| `text.spec.ts` | **Probes rewritten** | `inkIn()` (`lower-canvas`, `L95-102`) -> composited screenshot + computed CSS; keep `upper-canvas` resize-cursor check (`L721`); cross-card drag (`L648`) retired per Owner Decision 6. |
| `texttool.spec.ts` | **Probes rewritten** | `editing()` (`data-fabric='textarea'`, `L32`) -> `.ProseMirror`; `inkIn()` (`lower-canvas`, `L36-43`) -> `.scene-text` rect + composited pixels; `accentIn()` (`L62-68`) stays on `lower-canvas` for draft rect, replaced by `.scene-text.is-editing` outline at `L86`. |
| `typing.spec.ts` | **Probes rewritten** | `textarea()` (`textarea[data-fabric="textarea"]`, `L59-62`) -> `.ProseMirror` text + DOM selection offset probe; update `L336` for real in-edit `Ctrl+Z` (two-step `closeHistory`). In Slice 3b the cases asserting that pasted markers stay literal are rewritten to assert conversion, and their literal expectations move to the `Ctrl/Cmd+Shift+V` and drop cases. |
| *(New)* `scene-layer.spec.ts` | **Add (Slice 2b)** | Standalone `/__blank` harness importing `sceneLayer.ts` & `renderFrameBitmap.ts` for CSS crop, rotated/zoomed `DomCardMeasurer`, and interleaved non-tainted `toBlob()`. |
| *(New)* `interleaving.spec.ts` | **Add (2c-i..iii -> 2d)** | `text-image-text` + frame stack, occlusion & covering-image cursor, group scale once, read-only block, `0px` jump, crop/caption/lock/duplicate/preview on DOM path. |
| *(New)* `writing.spec.ts` | **Add (Slice 3a), extend (Slice 3b)** | 3a: lists, `- [ ] ` two-stage checklist + toggle, quotes, dividers, code, `Tab` indent/outdent, divider-only and ticked-box cards kept, empty-list discard + undo, Backspace & `Ctrl/Cmd+Z` after shortcut, read-only mid-edit. 3b: structural HTML paste with zero network requests, Markdown paste + two-step undo, `Ctrl/Cmd+Shift+V`, contexts that never convert. |
| *(New)* `card-height.spec.ts` | **Add (Slice 4)** | `mb` fixed height + zero Windows scrollbar re-wrap, wheel ownership (starts on canvas vs on card, end of card, covering image, frame label, read-only), scrolling is view state only, top/bottom fades, bitmap from the top, Auto height, corner scale of fixed height, 45°-rotated + zoomed measurement. |
| *(New)* `paper.spec.ts` | **Add (Slice 5)** | New boxes paper, old boxes and new captions bare, v3 upgrade on first saved paper box, Paper toggle keeps words in place, geometry floors and click origin, paper in frame preview, paper with `captionBackground`. |

---

## 15. Owner decisions

All eleven were settled by the owner on 2026-11-23, and the rest of this plan is written to match. Where an answer changes a settled rule, the rule changes in the slice named here and the README and `docs/expected-behavior.md` change in the same commit (Section 17).

### Settled answers

| # | Decision | Answer | Where it lands |
|---|---|---|---|
| **1** | Storage upgrade for rich cards | **A:** wire v3, and the database moves to v3 in the same transaction as the first v3 save. One-way. | Slice 1 (Section 5) |
| **2** | Base branch | **A:** `feat/captions-frame-navigation-nov22` at `89686c4`. | Before Slice 1 (Section 3) |
| **3** | Wrapping and minimum width | **A:** keep today's two behaviours. Click-created and older boxes wrap between words and widen to the longest word; drawn boxes keep their width and break long words. Unifying them is a possible later change, not part of this plan. | Slice 2d (Section 6) |
| **4** | When a text box counts as empty | **B:** a divider or a ticked checkbox counts as content. Empty bullets and unticked empty checkboxes do not. | Slice 3a (Section 5) |
| **5** | Paste | **C:** HTML paste keeps structural blocks; pasted plain Markdown converts the same markers the typing shortcuts do, with the same literal cases; links, tables and images stay plain text; `Ctrl/Cmd+Z` straight after returns the literal text; `Ctrl/Cmd+Shift+V` pastes literally. | Slice 3b (Section 11) |
| **6** | Dragging words between text boxes | **A:** retired. Dragging within a box, and cut and paste between boxes, work. | Slice 2d (Section 8) |
| **7** | `* ` as a bullet shortcut | **A:** no. `- ` only; `* item` stays literal, typed or pasted. | Slice 3a (Section 8) |
| **8** | `Tab` while editing | **A:** indents and outdents inside lists and checklists; leaves the edit elsewhere. | Slice 3a (Section 8) |
| **9** | Wheel over a fixed-height card | **B:** the wheel scrolls the card you are hovering, with the rule that a scroll belongs to whatever it started on. Scroll position lasts while the board is open and is never saved; previews and export start at the top. Requiring the card to be selected first is held in reserve. | Slice 4 (Sections 4 and 6) |
| **10** | Default look of a new text box | **B:** paper background and padding. Older boxes stay bare, **Add caption** makes bare captions, an Inspector **Paper** toggle turns it on or off, and the colour and edge get a design pass the owner approves. The first new text box saved on a board triggers the v3 upgrade. | Slice 5 (Section 6) |
| **11** | Toolbar Undo while typing | **B:** Undo and Redo buttons step through typing while a box is being edited, like `Ctrl/Cmd+Z`. Leaving the box and pressing Undo takes back the whole edit. | Slice 2d, built in 2c-ii (Section 7) |

**Details this plan fixed while writing the answers in, for the owner to overrule if any is wrong:**
- **Paper and captions:** attaching an existing paper box as a caption keeps its paper; only **Add caption** starts bare. A caption background colour replaces the paper colour (Section 6).
- **Locked cards scroll:** the wheel scrolls a locked fixed-height card too, since scrolling changes nothing stored (Section 4).
- **`Tab` on the first item of a list** does nothing instead of leaving the edit (Section 8).
- **Whole-box settings and in-edit undo:** font size, alignment, colour, base font, Paper and fixed height changed during an edit are not steps of in-edit undo; they come back with the rest of the edit through board Undo (Section 7).
- **Blank lines in pasted Markdown** stay as empty lines, except between two items of one list (Section 11).
- **A divider-only card** is listed as `Text` in the layer panel (Section 5).

### The options as they were put to the owner (kept for the record)

| # | Decision | Options | Recommendation | Default |
|---|---|---|---|---|
| **1** | **Storage v3 fence** (`AGENTS.md:121-124`) | **A:** Wire v3 + atomic DB v3 on first `blocks`/`height`/`surface` save.<br>**B:** Keep DB v2 (old/sibling tabs silently strip new fields). | **Option A** (prevents cross-worktree data loss). | Block Slice 1 DB bump until approved. |
| **2** | **Base branch** (`AGENTS.md:56`) | **A:** `origin/feat/captions-frame-navigation-nov22` (`6ad246c`; or merged with `t3/capture-export`).<br>**B:** `feat/milestone-2-frames` (`98ea0f4`). | **Option A** (avoids rebuilding around crop/locks/captions/previews). | Wait for owner approval. |
| **3** | **Legacy/click box wrap & min width** (`AGENTS.md:86`, `README.md:112`, `DrawnTextbox.ts:40`) | **A:** Keep today's rule: word wrap + longest-word `dynamicMinWidth` on click/legacy boxes, grapheme wrap + widest-grapheme on drawn boxes, never auto-narrow, side floor `max(20, dynamicMinWidth)`.<br>**B:** Unify on `overflow-wrap: anywhere`, floor `max(fontSize * 2, 24)`, no auto-widening. | **Option A** for parity (Option B if owner wants to retire longest-word widening). | **Option A** (today's rule). |
| **4** | **Blankness for dividers & checked tasks** (`AGENTS.md:88`) | **A:** `plainTextOf(blocks).trim() === ''` is blank (today's rule).<br>**B:** Keep cards with a `divider` or checked `taskItem`; empty lists/unchecked tasks stay blank. | **Option B** for Slice 3. | **Option A** (today's rule). |
| **5** | **HTML & Markdown paste** (`AGENTS.md:93`, `README.md:110`) | **A:** HTML keeps `bold`/`italic`/`underline`/`strike` only (headings -> bold normal size, no `data-font`); plain markers literal.<br>**B:** HTML also keeps structural blocks (`h1`–`h3`, lists, tasks, quotes, code, dividers) + internal `data-font`; plain markers literal.<br>**C:** Also convert pasted plain Markdown. | **Option B** for Slice 3. | **Option A** (today's rule). |
| **6** | **Cross-card text drag** (`AGENTS.md:79`, `README.md:114`) | **A:** Retire cross-card drag (within-card drag + copy/paste work; retires `README.md:114`).<br>**B:** Mount `EditorView` on every card simultaneously. | **Option A** (single editor is core to perf). | Confirm before Slice 2d flips. |
| **7** | **`* ` bullet shortcut** (`e2e/typing.spec.ts:190`) | **A:** `- ` only (`* item` stays literal).<br>**B:** Both `- ` and `* `. | **Option A**. | **Option A**. |
| **8** | **`Tab` / `Shift+Tab` while editing** (`IText/constants.ts:26`) | **A:** Indent/outdent in lists/tasks; exit edit elsewhere.<br>**B:** Always exit edit (today). | **Option A**. | **Option B** (today's rule). |
| **9** | **Idle fixed-card wheel & scroll reset** | **A:** Scroll only while editing (consequence: double-click into card to read past the fold); reset `scrollTop = 0` on exit with bottom fade.<br>**B:** Wheel scrolls hovered idle card until boundary, then pans canvas. | **Option A** (no scroll-trapping; matches reload & previews). | **Option A**. |
| **10** | **Default card surface** | **A:** Transparent/bare as today.<br>**B:** Paper background + padding by default. | **Option A** (add opt-in `surface: 'card'` later). | **Option A**. |
| **11** | **Toolbar Undo button while editing** (`Controls.tsx:10`, `docs/rich-text-plan.md:285`) | **A:** Finishes edit then undoes whole edit (`Ctrl/Cmd+Z` uses ProseMirror undo).<br>**B:** Wire button to ProseMirror undo while editing. | **Option A**. | **Option A**. |

---

## 16. Risks and Spike 0 exit criteria

Before writing Slice 1 code, run a bounded, throwaway **Spike 0** in real Chromium (not committed to the feature branch) that MUST pass all 10 exit criteria below. Every `UNVERIFIED` library claim in this plan is explicitly gated here:

| # | Unverified claim / risk | Spike 0 test & pass criterion | Fallback if spike fails |
|---|---|---|---|
| **S1** | `EditorView.posAtCoords()` and native browser caret/drag-selection accuracy inside CSS `matrix(zoom,0,0,zoom,panX,panY)` + `rotate(angle)` | Click and drag-select text inside a card at zooms `0.25, 0.5, 1, 2, 4` and angles `0°, 30°, 45°`. Caret lands within 1 char of clicked glyph; drag-selection selects expected substring. | If Chromium's `caretPositionFromPoint` mis-maps under rotation, temporarily counter-rotate or map pointer via inverse CSS matrix to compute nearest char offset on mousedown. |
| **S2** | `DOMSerializer` static HTML vs live `EditorView` height/visual parity (`0px` jump) | Measure `getComputedStyle(el).height` and compare pixels before, during, and after edit on a card with H1, empty H2, bullet list, checklist, blockquote, divider, and code block. Height delta `=== 0px`. | Adjust `.yuriful-prose` empty-block `<br>` / margin CSS until delta is `0px`. |
| **S3** | `parseFloat(getComputedStyle(el).height)` ignores CSS zoom & rotation; offscreen `dynamicMinWidth` matches longest word & ZWJ grapheme | Compare measured height of a 45°-rotated card at zoom `0.5` and `2.0` vs unrotated at zoom `1.0` (must match within `0.5px`). Verify offscreen `width: min-content` gives longest-word width for legacy boxes and `width: 0; overflow-wrap: anywhere` never splits a ZWJ emoji on drawn boxes. | Height: read `el.scrollHeight` with `height: auto`. Widest grapheme: measure max `splitGraphemes` span width on offscreen probe. |
| **S4** | `handleTextInput` + `view.composing` under AltGr (`Ctrl+Alt`), numpad `*`, and CDP IME composition | Type `*` via AltGr & numpad (must trigger shortcut); run CDP `Input.imeSetComposition` + `Input.insertText` for `*` and ` ` (must NOT trigger). | Track `compositionstart`/`compositionend` + `isComposing` flag on `EditSession` directly alongside `view.composing`. |
| **S5** | SVG `<foreignObject>` data URL -> 2D canvas `toBlob()` without taint in Desktop Chromium | Render a rich card (H1, checklist, quote, code, fixed-height `scrollTop = 0` overflow clip) + overlapping cropped PNG onto offscreen canvas at `scale = 2`; call `toBlob('image/png')`; assert non-empty PNG and expected ink pixels at both card and overlapping image coordinates. Repeat with a padded card that has a background fill, a border and an outer `box-shadow` inside a bleed margin, and assert the fill, the border and shadow pixels outside the card box are all present (what the paper design pass may choose from). | Do NOT build a Canvas 2D block layout engine. Use scaled read-only DOM `.scene-world` thumbnails for `framePreview.ts`; for `exportFrame.ts` (or Safari `SecurityError`), catch cleanly and surface an explicit browser notice. |
| **S6** | Synthetic `MouseEvent('mousedown')` re-dispatch onto `upperCanvasEl` after `finishEditing()` | While editing card A, perform in real Chromium: (a) click card B, (b) drag card B 80px, (c) Shift-click card B, (d) empty-canvas marquee, (e) Text-tool drag on empty canvas. Every gesture must complete in one press-move-release with zero console errors. | Expose a typed `FrameCanvas.handleForwardedMouseDown(e)` calling Fabric's `_onMouseDown(e)` directly instead of synthetic `dispatchEvent`. |
| **S7** | Inert `DOMParser().parseFromString` HTML paste makes zero network requests | Playwright `page.route('**/*', ...)` intercepts all requests while pasting `<img src="https://example.invalid/x.png"><style>@import url(https://example.invalid/a.css);</style><p><strong>ok</strong></p>`. Assert 0 requests and `ok` bold. Also: press `Ctrl+Shift+V` with HTML and plain text on the clipboard and confirm ProseMirror's paste hooks are told the paste is plain (the flag Slice 3b's literal paste relies on). | For the plain flag: track `Shift` from the edited root's own `keydown`/`keyup` and read it in `handlePaste`. Strip URL patterns with regex before `DOMParser` as defense-in-depth (still never assign `innerHTML` on live DOM). |
| **S8** | Exact Vite 8 bundle delta & jsdom 31 headless `prosemirror-state` compatibility | Measure `npm run build` gzipped delta for the 8 `prosemirror-*` packages and run a Vitest test exercising `EditorState`, `DOMSerializer`, and `prosemirror-history` in jsdom 31. | Confirm exact numbers and document in Slice 2a PR. |
| **S9** | Raster/paint frame intervals & post-zoom text sharpness on 100-card reference board | Seed 100 text cards (10 × 1,500-word reviews + 90 notes) + 50 images + 10 frames in Chromium; record 60 consecutive `requestAnimationFrame` deltas during continuous wheel zoom (`0.5x -> 2x -> 4x`), pan drag, and 20-item multi-drag. Pass: p95 frame interval `<= 20 ms`, no post-zoom raster stall `> 100 ms`, and crisp settled text at `2x`/`4x` (no blurry stale GPU texture). | Tighten `content-visibility: hidden` viewport culling margin; apply temporary `will-change: transform` on `.scene-world` only during active wheel bursts and clear 150 ms after wheel ends so glyphs re-rasterize crisp; if needed at extreme zoom-out (`zoom < 0.35`), render distant cards as simplified block placeholders. |
| **S10** | Wheel-scrolling an idle card: `scrollTop` can be set on a `pointer-events: none`, rotated, zoomed `overflow-y: auto` element; the position survives a static re-render and a `content-visibility: hidden` round trip; `WHEEL_LATCH_MS = 180` keeps one trackpad flick (with its inertial tail) in one gesture | In Chromium, on a fixed-height card at zoom `0.5` and `2`, upright and at `30°`: set `scrollTop` from a `wheel` listener on an ancestor and read it back; replace the card's children and confirm the position is kept or can be re-applied in the same frame with no visible jump; toggle `content-visibility: hidden` and back and read the position. Record the gaps between `wheel` events of a real trackpad flick and a real mouse-wheel spin on the owner's machine and confirm the largest gap inside one flick is under `180 ms`. | If the position is lost on re-render or culling, re-apply from `scrollTops` (already planned) inside `before:render`. If inertial gaps exceed `180 ms`, raise the constant to the measured gap plus a margin. If trackpad flicks still split, adopt the reserve rule (scroll only a selected or edited card). |

### Spike 0 results (run 2026-11-23, Chromium on the owner's Windows desktop)

The spike ran in a throwaway copy of commit `41506db`, outside the repository; none of its code is on the branch. Where a result disagrees with an "UNVERIFIED" note earlier in this plan, the result wins, and the sections named below were corrected to match.

| # | Result | What was measured | What it changed in this plan |
|---|---|---|---|
| **S1** | Pass | 1,135 of 1,135 real clicks put the caret on the clicked glyph across zoom `0.25`–`4` and `0°/30°/45°`; 56 of 60 drag-selections exact, the 4 misses all at zoom `0.25`. | New rule: `.scene-layer` is `overflow: clip`, because the browser scrolled an `overflow: hidden` layer by up to `46px` to follow the caret (Sections 4 and 7). |
| **S2** | Pass with changes | Raw static HTML jumped `74.2px` on entering an edit; `0px` with `<br>` in empty blocks plus ProseMirror's white-space and ligature CSS on the static HTML. | Section 7, pixel-identical guarantee, rule 4. |
| **S3** | Height and graphemes pass; longest-word probe fails, fallback passes | Height `148.312px` at six zoom/angle combinations, no deviation. No emoji or cluster split in 9 cases. `min-content` under-measures hyphenated and CJK tokens. | Section 6: token-based longest-word probe, fractional widest-grapheme probe, and no-wrap spans to keep "wraps only between words" true. The `scrollHeight` height fallback is dropped (it is an integer). |
| **S4** | Pass | Numpad and emulated AltGr `*` fire the shortcut; IME `*` and space do not. `handleTextInput` does run during composition, so the `view.composing` guard is mandatory, not a precaution. | Text inserted without a composition (the emoji panel, some dictation tools) can fire a shortcut, as a typed character does; listed as a known limit at Slice 2d. |
| **S5** | Pass | No taint; `103,698`-byte PNG at scale 2 with text, an image in front, a fixed-height clip with 0 stray pixels, and paper fill, border and shadow inside a bleed margin. | Section 10: build the XHTML with `XMLSerializer`. |
| **S6** | Pass | In the real app: click, 80px drag, Shift-click, marquee, Text-tool draft, double-click and a click inside the card, 0 console errors; without the re-dispatch 5 of 6 gestures fail. | None. Not covered: zoom other than 1, rotated targets, frame outlines and labels, locked objects, and a real `EditorView`; Slice 2c-ii's tests must cover those. |
| **S7** | Pass, with one correction | 0 network requests on both paste paths (a live-DOM control made 12). `Ctrl+Shift+V` arrives with no `text/html` and `plain = true` in two hooks, but not in `handlePaste`. | Section 11: paste is built on `transformPastedHTML` and `clipboardTextParser`. macOS not verified. |
| **S8** | Pass | `+66.49 kB` gzip JavaScript; headless state, serializer, history and even `EditorView` work in jsdom 31. | Section 11: measured numbers, and the chunk-size warning limit. |
| **S9** | Pass on this machine | Headed, about 95 Hz: p95 frame interval `11.0`–`11.5 ms` in every phase, worst frame `32 ms`, edit entry `≤ 3 ms` on 1,500 words, settled text at `2×`/`4×` within 3% of native sharpness. | The `will-change` blur did not reproduce; the rule in Section 7 stays as a precaution, not a verified fact. Frame-pacing tests must run headed (headless ticks are a fixed `16.7 ms`). Not measured: a laptop or integrated GPU, or a display at twice the pixel density. |
| **S10** | Programmatic parts pass; trackpad timing not testable by an agent | `scrollTop` reads back exactly `deltaY / zoom`; position kept across a same-frame re-render and a `content-visibility` round trip. | `WHEEL_LATCH_MS = 180` is unproven against a real trackpad flick. It is one constant; the owner tries Slice 4 on their own trackpad before it is called done. |

---

## 17. Changes needed to the README and the reference docs, and when

On the base branch the README describes behaviour to the person using the app and `docs/expected-behavior.md` states the same rules as constraints on changes; `AGENTS.md` requires both to change **in the same commit** as the rule, shortcut, storage behaviour or known limit they describe. `docs/engineering-reference.md` changes when the project map, the lifecycle checklist or the review traps change. `AGENTS.md` itself needs no change for this work.
- **Slice 1:** `docs/expected-behavior.md` "Storage and migration": `parseDoc` accepts versions 1 to 3, a database newer than version 3 opens read-only, and the first save of a board with a rich card (`blocks`, `height` or `surface`) upgrades the database to version 3 in the same transaction, one-way; `blocks` is strict (an unknown block type makes the board read-only) while formatting fields stay lenient. `README.md` storage section says the same in plain words. `docs/engineering-reference.md` project map adds `src/model/textDoc.ts`.
- **Slice 2d *(2a to 2c change no user-facing behaviour)*:**
  - `docs/expected-behavior.md`: the "Editor and gesture invariants" lines about `text:changed`, `text:editing:exited`, Fabric's hidden textarea, `writeTextFormatting` and `replaceEditedText` are rewritten for `.scene-layer`, proxies and `EditSession`; the undo line gains "while a text is edited, Undo and Redo, by key or button, step through that edit" (Owner Decision 11); dragging text between boxes is removed (Owner Decision 6).
  - `docs/engineering-reference.md`: project map adds ProseMirror under `src/editor/` (`textSchema.ts`, `textRules.ts`, `textSession.ts`, `sceneLayer.ts`, `renderFrameBitmap.ts`); review traps add matrix projection, no `getBoundingClientRect()` on rotated cards, no per-card `ResizeObserver`, inert HTML parsing, and replace the traps that name Fabric text internals.
  - `README.md`: Architecture and Testing updated; known limits drop the browser-undo limit and the dropped-text limit (`README.md:210-211` on the base) and gain: borderline lines on older boards may wrap a word earlier or later, whole-box settings are not steps of in-edit undo, and frame previews need a Chromium browser.
- **Slice 3a:** README and `docs/expected-behavior.md` record lists, checklists, quotes, dividers, code, the live shortcuts with the `- [ ] ` progression and Backspace / `Ctrl/Cmd+Z` revert, `* item` staying literal (Owner Decision 7), `Tab` / `Shift+Tab` in lists (Owner Decision 8, with the shortcut table), and the widened blank rule: a divider or a ticked checkbox is content (Owner Decision 4; the "blank text is never part of the scene" and layer-list lines both change).
- **Slice 3b:** README and `docs/expected-behavior.md` replace "pasted markers stay literal" with the paste rules of Section 11 (Owner Decision 5), add `Ctrl/Cmd+Shift+V` to the shortcut table, and list what is not converted as a known limit. `docs/engineering-reference.md` keeps the trap about typing shortcuts firing on pasted text and adds: paste conversion that goes through the typing path, and a Markdown paste that is one undo step.
- **Slice 4:** README and `docs/expected-behavior.md` record auto-grow by default, the `mb` fixed height, the non-reflowing scroll thumb, the wheel-ownership rule and that scrolling stores nothing (Owner Decision 9), Auto height, and the known limit that previews and export show a scrolled card from the top. `docs/expected-behavior.md:20` ("Wheel panning and zooming keep working") is extended with the card-scroll case.
- **Slice 5:** README and `docs/expected-behavior.md` record paper by default for new text boxes, bare older boxes and bare **Add caption** captions, the Paper toggle and what it does to the box, paper with a caption background, and that the first new text box saved on a board performs the version 3 upgrade (Owner Decision 10). The text-tool lines about the default box position and width (`docs/expected-behavior.md:25`) gain the paper offsets.
