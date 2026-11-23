# Architecture Plan: Rich Writing on Yuriful Canvas (Unified DOM/ProseMirror Text)

**Status:** Revised architectural plan (planning only; nothing implemented). **Repo:** `yuriful repository` (inspected at `feat/milestone-2-frames` `98ea0f4`, `origin/feat/captions-frame-navigation-nov22` `6ad246c`, `t3/capture-export` `21d0940`).

## Read this first
**What changes for the person using the canvas:**
- **One text box for notes and long reviews:** `T`, click/drag, double-click, corner-scale, and frames work as today; inside the box you gain headings (`H1`–`H3`), lists, clickable checklists, quotes, dividers, inline/block code, live Markdown shortcuts with Backspace revert, and real step-by-step in-edit `Ctrl/Cmd+Z` (still 1 board undo step on exit).
- **Auto-grow by default, scrollable on resize:** drag the bottom handle (`mb`) to lock a scrollable fixed height (zero-reflow overlay scrollbar while editing, bottom fade + reset to top on exit; double-click `mb` or **Auto height** resets).
- **Full z-order interleaving kept:** images and text interleave freely with frame outlines/labels crisp on top.
**Slice sequence** (each slice is a safe, independently reviewed checkpoint):
- **Spike 0** (throwaway): prove 9 Chromium/ProseMirror/SVG-bitmap claims (`S1`–`S9`) before coding.
- **Slice 1** *(no UI change)*: pure `RichDoc` AST, validator, legacy conversion, optional DB/wire v3 fence.
- **Slice 2a** *(no UI change)*: headless ProseMirror schema, Milestone-2 rules, and `EditSession`.
- **Slice 2b** *(no UI change)*: DOM `.scene-layer` and interleaved `renderFrameBitmap.ts` (standalone Vitest + Chromium harness).
- **Slice 2c-i** *(no UI change; Fabric default untouched)*: `TextAdapter` seam + static DOM proxies, transforms, frames, ownership.
- **Slice 2c-ii** *(no UI change; Fabric default untouched)*: live ProseMirror editing, pointer routing, occlusion, `EditSession`.
- **Slice 2c-iii** *(no UI change; Fabric default untouched)*: captions, crop, locks, duplicate, layer list, lift, frame previews on DOM path.
- **Slice 2d ← first visible change**: flip default to DOM/ProseMirror, migrate e2e probes, delete Fabric text path (crisp DOM text, real in-edit `Ctrl/Cmd+Z`, full interleaving).
- **Slice 3 ← rich writing blocks**: lists, checklists, quotes, dividers, code, live Markdown shortcuts, safe HTML paste.
- **Slice 4 ← fixed scrollable height**: `mb` handle, overlay scrollbar, idle bottom fade, Auto height reset.
**Owner decisions** *(detail in Section 15; `#N: rec / default`)*:
- **Before work starts:** **#1** DB/wire v3 fence (`rec: A v3 fence` / `def: block bump`); **#2** base branch (`rec: A origin/feat/captions-frame-navigation-nov22` / `def: wait`).
- **Before the flip (2d):** **#3** legacy wrap & min width (`rec/def: A keep today`); **#6** retire cross-card text drag (`rec: A retire` / `def: confirm pre-2d`); **#11** Toolbar Undo in edit (`rec/def: A exit+board undo`).
- **Before Slice 3:** **#4** divider/checked-task blankness (`rec: B keep` / `def: A text-only`); **#5** HTML paste blocks (`rec: B structural` / `def: A marks-only`); **#7** `* ` bullet (`rec/def: A off`); **#8** `Tab` in lists (`rec: A indent` / `def: B exit`).
- **Before Slice 4:** **#9** idle fixed-card wheel (`rec/def: A edit-only + reset top`); **#10** default card surface (`rec/def: A bare transparent`).

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
1. **Pure rich-document model & storage safety (Slice 1):** AST (`RichDoc`), strict/lenient allowlisted bounded validator, canonical form, legacy UTF-16 `spans`/`headings` <-> `RichDoc` conversion, semantic blankness, and storage version fencing (pending Owner Decision 1).
2. **Staged DOM scene + ProseMirror text switch with full Milestone 2 parity (Slices 2a–2d):** six independently reviewable commits — headless ProseMirror engine (`2a`), DOM scene + bitmap compositor (`2b`), test-only wired dual path split into `2c-i` (`TextAdapter` + static proxies/transforms/frames), `2c-ii` (editing/routing), and `2c-iii` (crop/captions/locks/duplicate/layer-list/previews), then the final renderer flip + e2e probe migration + deletion of the old Fabric path (`2d`).
3. **Long-form writing blocks & live Markdown (Slice 3):** bullet lists, numbered lists, interactive checklists, blockquotes, horizontal dividers, inline code, fenced code blocks; live typing shortcuts with Backspace revert; Inspector block controls; local-only clipboard HTML sanitization.
4. **Auto-grow / manual fixed scrollable height (Slice 4):** bottom handle (`mb`) sets fixed scrollable `height`, non-reflowing overlay scrollbar + idle bottom fade, wheel scrolls inside edited scrollable cards, corner scale folds `height` once, double-click `mb` or Inspector button restores auto-grow.

### Explicitly cut (deferred; seams kept clean)
- **Docked Focus Mode:** Cut. Synchronizing two live views of one document, dual scroll/selection/IME state, and docked-vs-canvas undo is a separate milestone. `EditSession` mounts `EditorView` into any container element, keeping the seam open.
- **Floating selection formatting bar:** Cut. The Inspector already provides non-focus-stealing formatting buttons (`src/ui/Inspector.tsx:280-282`); floating positioning under rotation/zoom/scroll is polish, not core writing.
- **Markdown file export / import and Markdown-on-paste conversion:** Cut. Markdown cannot represent per-range fonts, underline, colour, or alignment, and frame export requires a reading-order rule. (Paste rules are listed under Owner Decision 5 with default preserving today's behavior.)
- **Font selector expansion & custom colour pickers:** Deferred per owner instruction ("come later"). The existing 5 system font choices and 8-colour palette stay as-is.
- **Card surface toggle (paper background vs bare text):** Cut as a toggle; `surface?: 'card'` is reserved in `TextRecord` (default appearance listed under Owner Decision 10; default until decided: bare transparent as today).
- **Links, tables, inline images inside cards, word count, mobile/touch.**

---

## 3. Base branch

### Verified branch topology (read-only inspection)
- Current checkout: `feat/milestone-2-frames` at `98ea0f4` (21 commits ahead of `origin/feat/milestone-2-frames` `698b628`). Contains `AGENTS.md` and `CLAUDE.md`.
- `origin/feat/captions-frame-navigation-nov22` at `6ad246c` (local `feat/captions-frame-navigation-nov22` at `13a375b`): already integrates `feat/milestone-2-frames` (rich text + dragged text boxes) **and** `feat/layers-image-tools` (locks, layer list, image crop/fit/fill/replace, duplicate, align, board appearance), plus attached captions (`captionOf`, `captionSide`, `captionPosition`, `captionBackground` on `TextRecord`) and `src/editor/framePreview.ts` (`renderFramePreview` via detached `StaticCanvas`). Contains both `AGENTS.md` and `CLAUDE.md`.
- `t3/capture-export` at `21d0940`: descends from `feat/editor-polish-nov19` and adds `src/editor/exportFrame.ts` (`renderFramePng` via detached `StaticCanvas`), image clipboard paste, double-click empty canvas to type, and Fit toggle.

### Recommendation (requires owner approval per `AGENTS.md:56`)
- **Recommended base:** `origin/feat/captions-frame-navigation-nov22` (`6ad246c`) — or a fresh owner-approved integration commit combining `captions-frame-navigation-nov22` and `t3/capture-export`.
- **Why:** Basing on `feat/milestone-2-frames` (`98ea0f4`) would mean building the DOM scene layer blind to image crop (`cropLayer.ts`), object locks (`isLocked`), captions (`captionBackground`, `followsDrag`), and `framePreview.ts`, creating a major merge conflict later.
- **What must be preserved on `origin/feat/captions-frame-navigation-nov22` (and `t3/capture-export`):**
  - **Image crop / Fit / Fill / Replace (`cropLayer.ts`, `Editor.ts:1975-2025`, `objects.ts:662-700`):** `.scene-image` uses an `overflow: hidden` box sized to `(crop?.width ?? naturalWidth) × (crop?.height ?? naturalHeight)` with inner `<img>` offset by `translate(-crop.x px, -crop.y px)`. During crop mode, `SceneRenderer` reveals the full uncropped `<img>` beneath `lowerCanvasEl`'s `drawCropOverlay` (`cropLayer.ts:69-105`). `isImage(obj)` checks `meta.get(obj)?.kind === 'image'` instead of `obj instanceof FabricImage` (`objects.ts:662`).
  - **Locks (`locked?: true`, `objects.ts:92`, `Editor.ts:2977`):** Locked proxies keep `evented: false, selectable: false, hasControls: false`; `startEditing`, `formatTarget`, and every formatting/block command check `isLocked(proxy)`.
  - **Captions & caption snap (`captionSnapLayer.ts`, `Editor.ts:631` `syncCaptions`, `objects.ts:42, 499`):** A caption is a `TextRecord` (`isText(proxy)`). `.scene-text` applies `background: rec.captionBackground` when present, follows its image via `syncCaptions`/`followsDrag`, and edits with ProseMirror. `captionSnapLayer.ts`'s `makeSnapCaption` measures a DOM/offscreen card probe instead of constructing a `Textbox`; `drawCaptionSnap` stays on `lowerCanvasEl`.
  - **Layer list (`layerList.ts:52-55`), drag feedback (`feedbackLayer.ts`), and duplicate (`Editor.ts:2777` `duplicateSelection`):** `layerList.ts` replaces `o instanceof Textbox` with `isText(o)` + `plainTextOf` / `textData`; `feedbackLayer.ts` keeps canvas drop/snap overlays while lifted-item drag shadows move to CSS `.is-lifted` on `.scene-item` (since proxies have no-op `_render()`); `duplicateSelection` clones `TextRecord` (`blocks`/`height`/`caption*`) and `ImageRecord` (`crop`/`locked`) through the proxy factory.
  - **Frame previews (`framePreview.ts`) & PNG export (`exportFrame.ts`):** Both delegate to the new `renderFrameBitmap.ts` compositor (Section 10) instead of detached `StaticCanvas` + `createObject`.
  - If the owner prefers `feat/milestone-2-frames` (`98ea0f4`) instead, the plan executes identically with those captions-base hooks omitted until integration.

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
    ├── .scene-layer  (z: 1, position: absolute; inset: 0; overflow: hidden; pointer-events: none)
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
| **Read-only** | `handActive` is always true (`Editor.ts:383`): capture starts `beginPan(e)`. No selection or editing. | Blocked (pan). | Window `mousemove` pans; `window` capture `mouseup` / `blur` / `buttons` bit check ends pan (`Editor.ts:1264-1285`). | Middle: pans. Right: blocked. | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Idle / Selected (Select tool)** | Reaches `upperCanvasEl` -> Fabric selects, starts drag/scale/rotate/marquee. `primaryDown = true`. | Reaches `upperCanvasEl` -> `mouse:dblclick`: if `isText(target)` and `!isLocked(target)` -> `startEditing(target, e)`. If `isFrame(target)` -> `frameRenamer()`. | Fabric tracks on `document` `mousemove`/`mouseup` (`Canvas.ts:688-694`). Release outside window still reaches `document`. Window `blur` cancels gesture & restores `base`. Lost release healed by `healPrimaryDown` (`Editor.ts:1256`). | Blocked from Fabric (`stopPropagation` + `preventDefault`). Middle starts pan unless `primaryDown`. Non-primary release during primary drag stopped in window capture (`Editor.ts:1165`). | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Hand / Space held** | Capture `preventDefault` + `stopPropagation`, `finishEditing()`, `beginPan(e)`. | Blocked. | Window pan; ends on release or `blur`. | Middle: pans (if not already panning). Right: blocked. | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Draft (Frame or Text tool)** | On empty canvas or frame interior: `upperCanvasEl` -> `mouse:down` starts `Gesture.draft`. On object or frame outline/label (Text tool): Fabric selects/drags target. | N/A. | `document` `mousemove` updates `canvas.draft`; `mouse:up` settles in microtask (works even released over toolbar, `e2e/texttool.spec.ts:150`). `Esc`/`blur`/read-only cancels. | Blocked from Fabric (never ends/cancels draft, `e2e/texttool.spec.ts:300`). | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Transforming (`busy`)** | Ignored / single active transform. | Ignored. | Fabric tracks to `document` `mouseup`; settles in 1 microtask. `Esc`/`blur`/read-only restores `g.base`. | Blocked from Fabric (`e2e/gestures.spec.ts:225`). | Plain: pans. `Ctrl/Cmd`: zooms. |
| **Editing card `T`** | Capture on `.editor-stage` checks in order:<br>1. **Frame outline/label hit** (`canvas.frameOverlayAt`): wins over `T` -> **Outside path**.<br>2. **Front object occlusion** (any unlocked object with index `> indexOf(T)` whose proxy `_checkTarget` hits scene point): wins over `T` -> **Outside path**.<br>3. **Target is inside `T`'s DOM node** (text, checkbox, overlay scroll thumb): **pass through untouched** to browser + ProseMirror!<br>4. **Anything else** (empty canvas, frame interior, object behind `T`): **Outside path**. | Inside unobstructed `T`: native browser word-select (and triple-click paragraph-select). Outside `T`: first `mousedown` already exited edit and restored `upperCanvasEl`, so 2nd click + `dblclick` land on `upperCanvasEl` (e.g. double-clicking card `B` directly opens `B`!). | Inside `T`: native DOM drag-selection or overlay scroll thumb drag (tracked natively even if released outside window; Fabric never sees press, `primaryDown` stays `false`). Outside `T`: see Outside path below. | Middle: `finishEditing()`, `beginPan(e)`, `preventDefault`. Right: inside unobstructed `T`, allow native context menu (do not pass to Fabric); outside `T`, block (`preventDefault` + `stopPropagation`). | `Ctrl/Cmd+wheel`: always zooms canvas (`preventDefault`). Plain wheel: if pointer is inside unobstructed `T`, `T` has fixed `height` AND `scrollHeight > clientHeight` AND can scroll further in wheel direction -> let `T` scroll natively; otherwise `preventDefault` and pan canvas. (Hovering an idle scrollable card: Owner Decision 9; default pans canvas, so reading past the fold requires double-clicking into the card.) |

### Exact "Outside path" mechanism (one click ends edit AND acts on what was pressed)
When a primary `mousedown` hits outside unobstructed `T` (including a frame outline/label over `T`, or image `I` covering part of `T`):
1. `e.preventDefault(); e.stopPropagation();` stops the `.scene-layer` event from doing anything further.
2. Call `this.finishEditing()` synchronously:
   - Unmounts `EditorView`, resets `scrollTop = 0` (under Owner Decision 9 default), restores static HTML in `T`, restores `.canvas-host { pointer-events: auto }` and clears covering-item `pointer-events`, commits the edit (or, if `T` is blank, hides/disables `T`'s proxy, discards it from active selection so a Shift-click cannot form `{T, other}`, and queues `canvas.remove(proxy)`).
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
  /** Reserved for future card chrome toggle; absent = transparent. */
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
- **Strict (returns `null` -> read-only):** unknown doc `version`, duplicate IDs, bad base geometry (`id`, `left`, `top`, `angle`, `fontSize <= 0`, `width <= 0`), non-string `text`, malformed `blocks` container (non-array, empty array, unknown block `type`, invalid `items`/`blocks` child array, invalid `heading.level` outside `1|2|3`, non-string `codeBlock.text`, exceeded depth/node/length bounds).
- **Lenient (cleaned to valid canonical form, matching `AGENTS.md:120`):** invalid `font`, `align`, `color`, `spans`, `headings`, `minHeight` (`< 0` or non-finite -> omitted), `height` (`<= 0` or non-finite -> omitted), `surface` (not `'card'` -> omitted), dangling `frameId`, non-integer `orderedList.start < 1` (-> `1`, omitted), non-boolean `taskItem.checked` (-> `false`), unknown extra properties on valid `InlineRun`/`BlockNode` (dropped by allowlist).
- **Canonical form & `blocks` vs `text` authority (guarantees exact `sceneEqual` so a no-op commit records nothing):**
  1. Keys in fixed order (`InlineRun`: `text`, `bold`, `italic`, `underline`, `strike`, `code`, `font`). Only `true` marks; never `false`/`undefined`.
  2. `bold` is stripped from all `InlineRun`s inside `heading` nodes.
  3. `font` override is stripped when equal to the box's base `font`.
  4. Zero-length `InlineRun`s dropped; adjacent runs with identical marks+font merged; empty `content: []` omitted.
  5. **Single canonical form & authority on disagreement:** if `blocks` has only top-level `paragraph`/`heading(1..3)` and no `code` mark, collapse to `{ text, spans?, headings? }` with `blocks` omitted. Otherwise **`blocks` is authoritative**: `parseDoc` checks `typeof raw.text === 'string'`, overwrites `rec.text = plainTextOf(blocks)` if they disagree, and omits `spans`/`headings`. `text` stays on wire in v3 solely for a uniform `{ type: 'text', text }` shape in raw-IDB debugging, layer labels (`layerList.ts:24`), and test probes (`e2e/helpers.ts` `storedDoc`).
  6. Never stored or compared: caret/selection, `scrollTop`, `storedMarks`, ProseMirror history, `shortcutRevert`.
- **Semantic emptiness (`isBlankTextDoc` — Owner Decision 4):**
  - **Default (`AGENTS.md:88`):** `plainTextOf(blocks).trim() === ''`. **Recommended for Slice 3 (Option B):** also non-blank if the tree has a `divider` or checked `taskItem`. Under both, typing only `# `, `- `, `> `, or `- [ ] ` and pressing Esc discards the new card with no history/save (`e2e/typing.spec.ts:349`).
  - **Existing card emptied to an empty list** (bullet/numbered/unchecked task): blank under both options -> excluded from `snapshot()` while open (no intermediate save or premature removal on font-size/formatting, `Editor.ts:1655, 1684`); discarded on `finishEditing()` and committed as 1 board undo step (`Editor.ts:771-792`), so Undo restores the card.
- **Legacy conversion (`legacyToBlocks` / `blocksToLegacy`):**
  - Uses `paragraphsOf(text)` (`src/model/richText.ts:90`) so `\r\n` is one line break, surrogate pairs and ZWJ emoji are never split (`splitGraphemes`), and UTF-16 `TextSpan` offsets map cleanly per paragraph into `InlineRun[]`.
  - Empty heading lines (`headings[i] > 0` with empty text) become `{ type: 'heading', level }` (no placeholder character needed).
  - ProseMirror node-boundary offsets (`+1` per block open/close) exist ONLY inside `src/editor/textSchema.ts` during live editing and never leak into `src/model/`.

### Storage versions & fencing against older and sibling builds (Finding 8 — Owner Decision 1)
Today `FENCED_DB_VERSION = 2` (`src/persistence/boardStore.ts:90`) and `parseDoc` accepts versions `1` and `2` (`src/model/doc.ts:58`) on every existing branch (`feat/milestone-2-frames` `98ea0f4`, `origin/feat/captions-frame-navigation-nov22` `6ad246c`, and `t3/capture-export` `21d0940`). Because this owner runs multiple worktrees on the same origin, writing `blocks` or `height` into DB v2 would let an older or sibling tab open the board, silently drop `blocks`/`height` via `parseObject`'s allowlist (`doc.ts:23-41`), and overwrite the board with a valid revision token.

**Recommended design (mirrors Milestone 2's exact atomic fence at `boardStore.ts:366-443`):**
- `DOC_VERSION = 3`, `FENCED_DB_VERSION = 3`. `parseDoc` accepts wire versions `1 | 2 | 3`.
- `needsRichFence(doc)` is true iff any `TextRecord` has `blocks !== undefined`, `height !== undefined`, or `surface !== undefined`.
- `serializeDoc(doc)` emits:
  - `version: 3` (`frames` always present, even `[]`) when `needsRichFence(doc)`;
  - `version: 2` when `!needsRichFence(doc) && doc.frames.length > 0`;
  - `version: 1` otherwise.
- `IndexedDbBoardStore.save` promotes the DB to `version = 3` in the **same `versionchange` transaction** as the first `version: 3` write (extending `boardStore.ts:310-316`).

| Scenario | Wire written | DB version after | Behaviour (verified against `boardStore.ts` & `autosave.ts`) |
|---|---|---|---|
| Old v1/v2 board opened, not edited | None (no write) | Unchanged (1 or 2) | Loading never rewrites the row (`AGENTS.md:122`). |
| Old v1 board opened, edited without frames/rich cards | `v1` | `1` | Keeps Milestone 1 wire shape. |
| Old v1 board, frameless, user adds checklist / manual height | `v3` | `1 -> 3` (atomic) | Upgrades DB in write tx; older v1/v2 tabs blocked from overwriting. |
| Old v1 board, user adds first frame (plain text only) | `v2` | `1 -> 2` (atomic) | Existing Milestone 2 behavior preserved. |
| v3 board, user deletes last frame (rich card remains) | `v3` (`frames: []`) | `3` | Stays v3; DB never demotes. |
| v3 board, user deletes all rich cards & frames | `v1` | `3` (not demoted) | Matches `e2e/frames.spec.ts:596`; old tabs still cannot reopen DB v3. |
| Already-open current-build tab (`FENCED_DB_VERSION = 2`) when new tab saves first v3 board | `v3` | `3` | Old tab's `onversionchange` (`boardStore.ts:243`) closes its connection (`:239-242`), unblocking upgrade. Next save/load hits `db.version > 2` -> `NewerBoardError` (`:277-280`) -> `Autosaver.run()` (`autosave.ts:144-149`) calls `enterReadOnly(NEWER_BUILD_MESSAGE, true)`. |
| Another tab blocks the v3 upgrade (e.g., Milestone 1 `LegacyStoreV1` or in-flight tx) | None until retry | Unchanged (1 or 2) | `fence()` times out after `DEFAULT_DEADLINE_MS = 5000` ms (`boardStore.ts:95, 384-387`) -> `StorageBusyError` (`:68-73`). `Autosaver.run()` (`autosave.ts:151-155`) sets retryable `{ kind: 'error' }` (NOT read-only) and `Header.tsx:75-79` shows **Retry** (`README.md:100`). Late `onupgradeneeded` after expiry aborts (`boardStore.ts:395-398`). Closing the blocker and clicking Retry completes the upgrade. |
| Sibling branch (`milestone-2-frames`, `t3/capture-export`, `captions-frame-navigation-nov22`) opens a **v3** board | None | `3` | All three have `FENCED_DB_VERSION = 2` (`boardStore.ts:90`): `connect()` rejects with `NewerBoardError` (`:279`) -> read-only, no writes/prunes. |
| Sibling branch opens a **v1/v2** board with optional fields its allowlist lacks (`caption*` on `t3/capture-export`; `crop`/`locked`/`appearance` on `milestone-2-frames`) | `v1`/`v2` on save | Unchanged | Lenient allowlists (`doc.ts`) drop unknown fields on load and overwrite without them on next save (why Owner Decision 1 fences rich cards at DB v3 and Owner Decision 2 bases on `captions-frame-navigation-nov22`). |
| Newer build (DB v4+ or wire v4+ or unknown block type in v3) | None | Unchanged | Opens read-only (`NewerBoardError` / `UnreadableBoardError`), writes & prunes nothing. |

*(Because `AGENTS.md:123` currently specifies versions 1 and 2 only, bumping to DB/wire v3 is presented as **Owner Decision 1**.)*

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

### Legacy wrapping, minimum width, and re-wrapping fidelity (Finding 5 — Owner Decision 3)
- **Unchanged on load:** `left`, `top`, `angle`, `width`, `fontSize`, `minHeight`, `frameId` (never recomputed), and formatting; loading writes nothing.
- **Wrapping & minimum width (Owner Decision 3 — default keeps `AGENTS.md:86`, `README.md:112`, `DrawnTextbox.ts:40`, `Textbox.ts:16, 139-140`):**
  - **Drawn boxes (`minHeight !== undefined`):** `overflow-wrap: anywhere` breaks overlong tokens at grapheme boundaries; `dynamicMinWidth` is widest grapheme via a reused offscreen measurer (`width: 0; overflow-wrap: anywhere` -> `scrollWidth`; **UNVERIFIED: prove ZWJ grapheme handling in Spike 0 S3**).
  - **Click/legacy boxes (`minHeight === undefined`):** `overflow-wrap: normal; word-break: normal` keeps word-only wrapping; `dynamicMinWidth` is longest word via offscreen `width: min-content` -> `scrollWidth`.
  - **When measured & widening:** `CardMeasurer.measureMinWidth(el, rec)` runs in `syncCardSize` on text/formatting/size changes and at `object:resizing` start. If `dynamicMinWidth > rec.width`, `rec.width` widens to `roundPositive(dynamicMinWidth)` keeping the alignment edge in place (`getPositionByOrigin`/`setPositionByOrigin`, matching `objects.ts:385-388`) and never narrows automatically (`README.md:112`). Side handles (`ml`/`mr`) clamp to `Math.max(20, dynamicMinWidth)`. *(Option B alternative: `overflow-wrap: anywhere` everywhere, floor `Math.max(fontSize * 2, 24)`, no auto-widening.)*
- **Typography & drift:** `.yuriful-prose` sets `line-height: 1.25`, `h1/h2/h3` at `2em / 1.5em / 1.25em` (`font-weight: 700`), `FONT_STACKS`, `padding: 0`. Borderline lines may wrap a word earlier/later between Canvas 2D and DOM shaping. Slice 2c/2d Playwright tests assert byte-equal stored geometry/`frameId`, DOM width within `1px`, and exact heading ratios on legacy fixtures.

### Fixed-height scrolling, Windows scrollbars, and idle overflow (Slice 4)
- **Zero-reflow scrollbar (Windows-safe):** Native Windows `overflow-y: auto` scrollbars consume ~15–17px of layout width, which would re-wrap lines on overflow and narrow fixed-height cards relative to `record.width`. Instead, `.scene-text-body` keeps `box-sizing: border-box; width: ${rec.width}px` with `scrollbar-width: none` + `::-webkit-scrollbar { display: none }`, and renders a **6px absolute-positioned overlay scroll thumb** along the right edge when `scrollHeight > clientHeight` (driven by `scroll` events, draggable while editing, hidden when idle). Wrap width never changes on overflow, existing boards keep exact width, and `ml`/`mr` handles set the exact text wrap width.
- **Idle state, cue, and wheel (Owner Decision 9):** Leaving edit resets `scrollTop = 0` (matches reload and frame previews). Idle overflowing cards toggle `.has-overflow` during `syncCardSize`, adding a CSS `mask-image: linear-gradient(to bottom, #000 calc(100% - 20px), transparent 100%)` bottom fade (zero layout shift, works on any background). Under default **Option A** (wheel scrolls only while editing), hovering an idle card pans the canvas, so **double-clicking into the card (or resizing `mb`/Auto height) is the only way to read past the fold**; Option B lets wheel scroll a hovered idle card until its boundary.

---

## 7. The edit session, undo, and autosave

### Single mounted editor vs static HTML (Finding 10)
- **Idle cards:** rendered as pure static DOM via `DOMSerializer.fromSchema(textSchema).serializeFragment(pmDoc.content)` inside `.scene-text-body.yuriful-prose`. No `contenteditable`, no `EditorView`, no `MutationObserver`.
- **Active edited card (at most 1 at a time):** mounts one ProseMirror `EditorView` directly into `.scene-text-body` (sharing `.yuriful-prose` CSS).
- **Pixel-identical guarantee:**
  1. Same schema (`textSchema`) generates both the static DOM (`DOMSerializer`) and the live `EditorView` DOM (`toDOM`).
  2. Empty blocks emit `<br>` in static HTML to match ProseMirror's trailing `<br class="ProseMirror-trailingBreak">`.
  3. Editing indicator uses CSS `outline` (never `border` or `padding` change), so entering/leaving edit produces `0px` box shift. (**UNVERIFIED: prove `0px` delta in Spike 0.**)
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

Leave edit (Esc / click outside / Shift-click / Tool switch / Undo button / Arrange / Delete / Read-only)
  │
  ▼
Editor.finishEditing()  [strictly idempotent via session.finished]
  ├── If !activeSession || activeSession.finished: return
  ├── session.finished = true; activeSession = null
  ├── view.destroy(); reset scrollTop = 0 (Owner Decision 9); renderStaticCard(cardEl, meta.textData)
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
  - **Toolbar Undo** (`src/ui/Controls.tsx:10`): calls `editor.undo()` -> `finishEditing()`, then undoes the whole edit as one board step (`Editor.ts:1819-1824`, Owner Decision 11).
- **Invalidation on restore / cancel / read-only / dispose:**
  - `applyRecords` (undo/redo/cancelGesture) destroys any active session with `applying = true` (no commit, no save).
  - `enterReadOnly` sets `readOnly` **before** calling `finishEditing()` (`Editor.ts:383-385`), so the card stays visibly intact as static HTML, commits nothing, and writes nothing.
  - Every microtask captures `session.id` and no-ops if invalidated or disposed.

---

## 8. Shipped text rules table (`AGENTS.md` audit)

Every settled text rule in `AGENTS.md:85-94, 147` and `README.md:61-90` accounted for:

| Settled rule | Disposition | Concrete ProseMirror mechanism / owner decision |
|---|---|---|
| Blank text never saved, never in history, discarded on exit (`AGENTS.md:88`, `Editor.ts:428, 771`) | **Keep** / **Owner Decision 4** | Default: `plainTextOf(blocks).trim() === ''` is blank (existing card reduced to an empty list is discarded on exit as 1 undo step). Owner Decision 4 covers keeping a `divider` or checked `taskItem` in Slice 3. |
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
| New Slice 3 live-Markdown triggers (`- `, `1. `, `- [ ] `, `- [x] `, `> `, `---`, `` `code` ``, ```` ``` ````) & `- [ ] ` precedence | **New (Slice 3)** | Two-stage transition avoids `- ` trapping `- [ ] `: `- ` creates `bulletList`; typing `[ ] ` or `[x] ` at start of a `bulletList > listItem > paragraph` upgrades it to `taskList > taskItem` (`[] ` on plain paragraph also creates `taskList`). `* ` bullet trigger is **Owner Decision 7** (default: off). |
| Backspace straight after shortcut restores exact text, formatting, caret & pending marks; in-edit `Ctrl/Cmd+Z` straight after shortcut (`AGENTS.md:93`, `e2e/typing.spec.ts:467`) | **Re-express** | Two `prosemirror-history` steps separated by `closeHistory(tr)`: plain `Backspace` (`!repeat && !composing && !modifiers`) restores `EditSession.shortcutRevert` (exact text, marks, caret, `storedMarks`); `Ctrl/Cmd+Z` undoes only the conversion step back to literal markers and clears `shortcutRevert`. |
| `Ctrl/Cmd+B/I/U` in-edit AND on a single selected box not being edited; auto-repeat claimed & ignored (`AGENTS.md:94`, `shortcuts.ts:79-83, 146-159`) | **Keep** | In-edit: `resolveEditingShortcut` checks `ctx.editedRoot?.contains(e.target as Node)`, never with Alt/Shift/composing, auto-repeat returns `'ignore'`. Box selected (not editing): `resolveShortcut` checks `ctx.textSelected && !e.shiftKey`, auto-repeat returns `'ignore'`, toggles whole box. |
| Formatting controls never take focus; focusing Title/Font-size `<input>` or window `blur` keeps edit open (`AGENTS.md:94`, `Inspector.tsx:171, 280-282`, `ITextKeyBehavior.ts:106`, `Editor.ts:1217-1225`) | **Keep** | `Overlays.tsx:75-77` and `Inspector.tsx:280-282` keep `preventDefault` on non-field `mousedown`. ProseMirror `blur` never calls `finishEditing()`, matching Fabric's `blur()`. |
| Pasted text formatting (`bold`/`italic`/`underline`/`strike` only; headings arrive bold normal size; never brings size, colour or font; plain markers stay literal) (`README.md:110`, `AGENTS.md:93`, `objects.ts:307-308`) | **Keep** / **Owner Decision 5** | Default keeps today's rule (marks-only HTML paste, headings flattened to bold normal size, no `data-font`, plain markers literal). Expanding HTML paste to preserve structural blocks + internal `data-font` in Slice 3 is **Owner Decision 5**. |
| Dragging selected text from one text card into another (`AGENTS.md:79`, `README.md:114`) | **Retire** (**Owner Decision 6**) | With one mounted `EditorView`, idle cards are static HTML so cross-card text drag cannot exist (within-card drag and cross-card copy/paste work; also retires `README.md:114`). |
| Legacy/click-created wrapping, longest-word `dynamicMinWidth`, widest-grapheme on drawn boxes, widened box never auto-narrows, alignment edge stays put (`AGENTS.md:86, 90`, `README.md:112`, `DrawnTextbox.ts:40`, `objects.ts:385-389, 469-478`) | **Keep** / **Owner Decision 3** | Default keeps today's exact wrapping and `dynamicMinWidth` widening (preserving alignment anchor `left`/`center`/`right` via `getPositionByOrigin`/`setPositionByOrigin`, never auto-narrowing). Unifying onto `overflow-wrap: anywhere` + `max(fontSize * 2, 24)` is **Owner Decision 3**. |
| `Esc` exits text edit (`IText/constants.ts:27`) | **Keep** | Handled in `EditorView` `handleKeyDown` when `!view.composing` -> `editor.finishEditing()`. |
| `Tab` exits text edit (`IText/constants.ts:26`) vs indenting lists | **Owner Decision 8** | Default until decided: `Tab` exits editing. Recommended: `Tab`/`Shift+Tab` indents/outdents inside lists & checklists, exits editing elsewhere. |
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
- **`ml`, `mr`:** `changeWidth` (`actionName: 'resizing'`). Changes `proxy.width`, clamped to `>= Math.max(20, dynamicMinWidth)` (matching Fabric `Textbox.ts:16, 139` under Owner Decision 3 default; or `>= Math.max(fontSize * 2, 24)` if Owner Decision 3 Option B is chosen). During `object:resizing`, updates card CSS `width` and flushes `syncCardSize` (if auto-grow) so selection borders follow live re-wrap.
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
     1. Generate static HTML via `DOMSerializer.fromSchema(textSchema)` (identical to `.scene-layer`).
     2. Wrap in self-contained XHTML inside `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><style>${INLINE_PROSE_CSS}</style><div class="yuriful-prose" style="...">${html}</div></div></foreignObject></svg>` (zero external URLs, system fonts only, `background: captionBackground` when set).
     3. **Fixed-height cards in previews/exports:** always rendered from the **top (`scrollTop = 0`)**, clipped strictly to `rec.width × rec.height` (`overflow: hidden`), with no scrollbar chrome (deterministic and identical to a freshly loaded idle card).
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
- **Justification:** Yuriful needs strict control over every typing rule (pinned literal cases + exact Backspace revert with `storedMarks`), heading-never-stores-bold invariants, local-only clipboard sanitization, and headless DOM mounting owned by `Editor.ts` (no React coupling). TipTap v3 adds ~60 kB gzip of wrapper abstractions whose default input rules, paste rules, and keymaps we would immediately disable. Bare ProseMirror is half the bundle size, MIT-licensed, and directly exposes `EditorView`, `EditorState`, `DOMSerializer`, and `handleTextInput`.
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

- **Bundle cost:** **UNVERIFIED: measure exact Vite 8 gzipped build delta in Spike 0 (S8)** (no Fabric version change; `fabric` stays pinned at `7.4.0`).

### Module boundaries (preserving `AGENTS.md:64-66`)
- `src/model/` (**pure — zero Fabric, ProseMirror, or DOM**): `types.ts`, `doc.ts`, `textDoc.ts` (new), `richText.ts`, `frames.ts`, `history.ts`, `layers.ts`, `viewport.ts`, `id.ts`.
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

### Local-only clipboard sanitization (Finding 15 — Owner Decision 5)
- **Format precedence on paste inside `EditorView`:**
  1. `text/html` present -> parse using **`new DOMParser().parseFromString(html, 'text/html')`** (inert document: does **not** fetch images, scripts, or external CSS; **UNVERIFIED: prove zero network requests in Spike 0 S7**). Walk with strict allowlist:
     - **Dropped subtrees (always removed with children):** `script`, `style`, `iframe`, `object`, `embed`, `link`, `meta`, `img`, `picture`, `source`, `video`, `audio`, `svg`, `canvas`, `form`. All `src`, `srcset`, `href`, `style`, `background`, `on*` stripped (inline bold/italic/underline/strike from `style` may be mapped to semantic tags during the inert walk before dropping `style`).
     - **Default allowlist (Slice 2 & Owner Decision 5 Option A — matches `README.md:110`):** `p`, `div`, `br`, `strong`, `b`, `em`, `i`, `u`, `s`, `del`, `strike`, `span`, `a` (unwrapped to text), and `h1`–`h6` flattened to bold normal-size paragraphs. Preserves `bold`, `italic`, `underline`, `strike` only; never brings size, colour, font, or heading level.
     - **Expanded structural allowlist (Slice 3 if Owner Decision 5 Option B is approved):** adds `h1`–`h3` (`h4`–`h6` -> `h3`), `ul`, `ol` (`start`), `li`, `blockquote`, `pre`, `code`, `hr`, `input[type=checkbox]` (`data-type`/`data-checked`/`checked` inside task `li`), and internal `data-font` (member of `FONT_IDS` only).
  2. `text/plain` fallback -> split on `\r?\n` into `paragraph` nodes; markers stay literal (Owner Decision 5).
  3. **Pending marks/font at caret:** active `state.storedMarks` apply to pasted text at the caret (`README.md:110`).
  4. Clipboard image files while editing text -> ignored (not embedded in text cards).

---

## 12. Slices and safe checkpoints

Per `AGENTS.md:45-48, 53`, every slice is a safe checkpoint, runs `npm run lint && npm run typecheck && npm test && npm run build` (plus `npm run test:e2e` for Slices 2–4), and passes an **independent subagent review** on the committed artifact in an isolated archive copy before the next slice begins.

### Pre-slice: Spike 0 (throwaway branch/prototype, not committed to main work)
Proves every `UNVERIFIED` claim in real Chromium before Slice 1 starts (exact exit criteria in Section 16).

### Slice 1: Pure rich-document model, validation, legacy conversion, and storage fencing
- **What the user sees:** Identical app (Fabric renderer unchanged). Stored boards gain support for validating, round-tripping, and fencing rich text documents.
- **Files touched:** `src/model/types.ts`, `src/model/textDoc.ts` (new), `src/model/doc.ts`, `src/persistence/boardStore.ts` (if Owner Decision 1 approves v3 fence), `src/model/textDoc.test.ts`, `src/model/doc.test.ts`, `src/persistence/boardStore.test.ts`, `e2e/storage.spec.ts`.
- **Safe checkpoint:** Existing Fabric renderer and all existing unit/e2e tests pass unchanged; storage format is valid and strictly fail-closed on unknown future block types or DB versions.
- **Acceptance tests that can fail:**
  1. `failed-restore-blocks-writes-on-unknown-block-type`: v3 board containing `{ type: 'table' }` causes `parseDoc` to return `null`, board opens read-only, writes and prunes are blocked. (Fails if validator silently drops unknown blocks.)
  2. `v3-fence-blocks-stale-v2-tab`: saving first card with `blocks` promotes DB to v3 in one transaction; a v2 store cannot open or overwrite it. (Fails if DB stays v2.)
  3. `legacy-utf16-emoji-crlf-empty-heading-roundtrip`: UTF-16 spans after ZWJ emoji and `\r\n` plus empty H2 line convert to `RichDoc` and back identically. (Fails on offset/grapheme drift.)
  4. `canonical-richdoc-equality-noop`: shuffled mark keys, split identical runs, and bold inside a heading canonicalize identically so `sceneEqual` returns `true`.
- **Review gate:** Independent review of Slice 1 commit against Section 5 & `AGENTS.md` storage rules.

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
- **Storage safety property:** Even if a real dev board is opened and saved on `'dom'` before the Slice 2d flip, the stored board is **guaranteed** to be in the exact wire v1/v2 shape that the default Fabric path reads and renders identically — and never trips the v3 fence before Slice 3:
  - `2c-i` writes only existing `FrameRecord`, `ImageRecord`, and `TextRecord` fields (`id, type, left, top, angle, text, fontSize, width, minHeight?, font?, align?, color?, spans?, headings?, frameId?`).
  - `2c-ii` mounts Slice 2's Milestone-2-only `textSchema` (`paragraph`, `heading(1..3)`, `bold`/`italic`/`underline`/`strike`/`font` — no rich blocks or inline `code`). By Section 5 canonicalization rule 5, every such `RichDoc` collapses to `{ text, spans?, headings? }` with `blocks` omitted; `height` and `surface` are never written before Slice 4.
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
- **Files:** `src/editor/textAdapter.ts` (live `DomTextAdapter` + `EditSession`), `src/editor/Editor.ts` (`.editor-stage` capture/wheel/outside-path, Text-tool drag on DOM path), `src/input/shortcuts.ts` (`editedRoot`), `e2e/interleaving.spec.ts` (editing/routing/occlusion cases).
- **Failing-capable tests (Playwright with `addInitScript` -> `renderer: 'dom'`):**
  1. `covering-image-shows-default-cursor-and-click-ends-edit-to-select-image`: image `I` covering edited card `A` shows `default` cursor; clicking `I` ends edit and selects `I`.
  2. `outside-click-ends-edit-and-blur-keeps-edit-open`: one-press click to select/drag another object, Shift-click out of blank card, Text-tool drag while editing; focusing Font size / Title or window `blur` keeps edit open.
  3. `enter-exit-edit-zero-jump-and-typing-shortcut-roundtrip`: enter/exit height delta `<= 0.5px`; `# ` / `**bold**` + Backspace revert + in-edit `Ctrl/Cmd+Z` + board-level Undo.
- **Review gate:** Independent review of `2c-ii` in isolated copy on separate `E2E_PORT` (existing Fabric suite + `2c-i`/`2c-ii` DOM tests green).

#### Slice 2c-iii: Base-branch features on the DOM path (`crop`, `captions`, `locks`, `duplicate`, `layerList`, `feedbackLayer`, `framePreview`)
*(Omitted if owner chooses `feat/milestone-2-frames` in Decision 2.)*
- **User sees:** Nothing new (default stays `'fabric'`).
- **Files:** `src/editor/Editor.ts` (`startCrop`/`syncCaptions`/`setLocked`/`duplicateSelection` on DOM path), `src/editor/cropLayer.ts` (overlay above `.scene-image`), `src/editor/captionSnapLayer.ts` (DOM `makeSnapCaption`), `src/editor/layerList.ts` (`isText`), `src/editor/feedbackLayer.ts` (`.is-lifted`), `src/editor/framePreview.ts` (`renderFrameBitmap` on `'dom'`), `e2e/interleaving.spec.ts` (captions-base cases).
- **Failing-capable tests (Playwright with `addInitScript` -> `renderer: 'dom'`):**
  1. `cropped-image-renders-edits-and-reloads-in-dom-scene`: CSS crop clips, crop mode reveals original under `cropLayer.ts`, commit keeps pixels stationary and persists.
  2. `attached-caption-snaps-follows-image-and-edits-in-prosemirror`: snaps via `captionSnapLayer.ts`, shows `captionBackground`, follows image, edits in ProseMirror, reloads intact.
  3. `locked-card-lifted-drag-duplicate-and-frame-preview-on-dom-path`: locked card is click-through/uneditable (padlock in `layerList.ts` unlocks); drag toggles `.is-lifted`; `Ctrl/Cmd+D` duplicates frame + cropped image + formatted card once sharing bytes; `framePreview.ts` renders rich spread.
- **Review gate:** Independent review of `2c-iii` in isolated copy on separate `E2E_PORT` (all 19 existing Fabric e2e specs + full `e2e/interleaving.spec.ts` green).

#### Slice 2d: Flip default to DOM renderer, migrate e2e probes, and delete old Fabric path
- **User sees:** All Milestone 2 (and captions-base) features now run on `.scene-layer` + ProseMirror with crisp DOM text, real in-edit `Ctrl/Cmd+Z`, full z-order interleaving, and working frame previews/exports.
- **Files:** Flip default & delete `FabricTextAdapter`, `renderer` option, and old Fabric path in `Editor.ts`, `textAdapter.ts`, `objects.ts`, `App.tsx`, `richText.ts`, `fakeFabric.ts`; delete `DrawnTextbox.ts`; rewrite unit tests (`richText.test.ts`, `objects.test.ts`, `Editor.{text,formatting,typing,texttool}.test.ts`); migrate probes per Section 14; update `README.md` & `AGENTS.md`.
- **Failing-capable tests:** (1) Full migrated 19-spec Playwright suite + `interleaving.spec.ts` pass on the single DOM path with zero dual-path flags; (2) `legacy-fixture-geometry-and-wrapping-preserved` (seeded Milestone 1/2 boards keep byte-equal geometry/`frameId`, DOM width within `1px`, exact `2×/1.5×/1.25×` heading sizes); (3) `no-fabric-textbox-or-dual-flag-remains` (typecheck, build, unit tests pass with `DrawnTextbox.ts`, `FabricTextAdapter`, `Textbox` fake, and `renderer` flag deleted).
- **Review gate:** Independent review of Slice 2d in isolated copy on separate `E2E_PORT` (full gate + e2e).

### Slice 3: Long-form writing blocks, live Markdown shortcuts, and clipboard sanitization
- **What the user sees:** Bullet lists (`- `), numbered lists (`1. `), clickable checklists (`- [ ] ` / `- [x] `), blockquotes (`> `), dividers (`---`), inline code (`` `code` ``), fenced code blocks (```` ``` ````), Backspace revert for every shortcut, Inspector block buttons, and safe HTML pasting.
- **Files touched:** `src/editor/textSchema.ts`, `src/editor/textRules.ts`, `src/editor/textSession.ts`, `src/editor/Editor.ts`, `src/ui/Inspector.tsx`, `src/ui/icons.tsx`, `src/styles.css`, unit tests (`textRules.test.ts`, `Editor.writing.test.ts`), `e2e/writing.spec.ts`, `README.md`, `AGENTS.md`.
- **Safe checkpoint:** All rich blocks validate, canonicalize, save (under v3 fence), undo/redo, reload, and render in frame previews/exports.
- **Acceptance tests that can fail:**
  1. `checklist-typed-char-by-char-upgrades-bullet-without-trapping` (Playwright): Typing `- [ ] Buy vinyl` produces an unchecked `taskItem`; clicking checkbox toggles `checked` and persists across reload; Backspace straight after `[ ] ` restores literal text. (Fails if `- ` traps `[ ] ` inside a bullet.)
  2. `pasted-html-never-fetches-remote-resources` (Playwright): `page.route('**/*', ...)` asserts zero external requests when pasting HTML with `<img src="https://...">`, `<link>`, and `<style>@import</style>`, while allowed tags paste cleanly and pending caret marks apply to pasted text.
  3. `pinned-literal-cases-empty-list-discard-and-backspace-revert` (Playwright): `2 * 3 * 4`, `snake*case*`, `* item` (unless Owner Decision 7 changes it), `#tag`, `#### four`, pasted `- item`, and IME-composed `- ` stay literal; deleting the last text from an existing card leaving an empty list discards it on exit as 1 undo step; Backspace straight after `> `, `---`, `` `code` `` restores exact literal characters.
- **Review gate:** Independent review of Slice 3 commit.

### Slice 4: Auto-grow / manual fixed scrollable height
- **What the user sees:** Dragging a text card's bottom handle (`mb`) fixes its height with a subtle bottom fade while idle and a non-reflowing overlay scrollbar while editing; corner scaling scales fixed height proportionally; double-clicking `mb` or clicking **Auto height** in Inspector returns it to auto-grow.
- **Files touched:** `src/editor/objects.ts`, `src/editor/sceneLayer.ts`, `src/editor/Editor.ts`, `src/ui/Inspector.tsx`, `src/styles.css`, `e2e/card-height.spec.ts`, `README.md`, `AGENTS.md`.
- **Safe checkpoint:** Fixed-height and auto-grow cards both save, scale, undo/redo, reload, never re-wrap when overflow begins on Windows, and clip from `scrollTop = 0` in frame bitmaps.
- **Acceptance tests that can fail:**
  1. `bottom-handle-drag-fixes-height-no-rewrap-and-scrolls-without-panning` (Playwright): Drag `mb` shorter than content -> stores `height` with identical inner text width (0px wrap-width shrink on Windows); while editing, wheel scrolls card (`scrollTop > 0`, `viewport.panY` unchanged); leaving edit resets `scrollTop = 0` and shows `.has-overflow` fade; double-click `mb` clears `height` back to auto-grow.
  2. `corner-scale-scales-fixed-height-once-and-undo-restores` (Playwright): Fixed-height card scaled by `k` scales `fontSize`, `width`, `height` by `k` once; undo/redo exact.
  3. `rotated-zoomed-card-never-uses-bounding-client-rect` (Playwright): 45°-rotated auto-grow card at zoom `0.5` and `2` typed into -> proxy height stays untransformed local height, frame ownership centre accurate.
- **Review gate:** Independent review of Slice 4 commit + docs audit.

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
| **Every way of leaving a text edit** (Esc, empty canvas click, other object click, Shift-click, frame outline click, toolbar button, Inspector non-format button, Undo button) | `Esc`: `handleKeyDown`. Canvas/object/Shift/frame clicks: `.editor-stage` capture -> `finishEditing()` -> re-dispatch to `upperCanvasEl`. Toolbar/Undo/Arrange/Delete: method calls `finishEditing()`. Formatting buttons: `preventDefault` on `mousedown` -> edit stays open! | Exactly 1 board history step (if net change), typing already saved, clicked target selected/dragged in same press, formatting buttons keep caret/range. | `e2e/typing.spec.ts:294`, `e2e/formatting.spec.ts`, `e2e/writing.spec.ts` |
| **Focus moving to Title or Font-size `<input>`, or window `blur`, mid-edit** | ProseMirror `blur` never calls `finishEditing()` (matching Fabric `ITextKeyBehavior.ts:106` and `Editor.ts:1217-1225`). `isEditableTarget` (`shortcuts.ts:39-50`) blocks canvas shortcuts; `editedRoot.contains` scopes `Ctrl/Cmd+B/I/U` & Backspace revert to the edited card. | Edit stays open (including `shortcutRevert` across window blur/refocus, `docs/rich-text-plan.md:364`); Font size & Title inputs work without closing the edit. | `e2e/interleaving.spec.ts`, `e2e/formatting.spec.ts` |
| **Undo / redo straight after edit exit** | `applyRecords` destroys any session, rebuilds proxies & DOM, flushes `syncCardSize`. | Restores exact pre-edit/post-edit `TextRecord` + frame ownership + height; 0 drift. | `e2e/text.spec.ts`, `e2e/writing.spec.ts` |
| **Input before board finishes loading (`!live`)** | `.editor-stage` capture blocks mousedown/wheel; `handleKeyDown` returns early when `!this.live`. | Zero edits, zero history, zero writes before hydration completes. | `e2e/hydration.spec.ts` (kept) |
| **IME composition (`compositionstart`..`compositionend`)** | `textRules` ignores `view.composing`; `shortcuts.ts` ignores `e.isComposing`; `Esc` ignored while composing; `storedMarks` preserved through composition. | No shortcut fires on composed `*`/` `/`#`/`-`; pending marks apply to committed text. | `e2e/typing.spec.ts:233`, `e2e/formatting.spec.ts:263` |
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
| `typing.spec.ts` | **Probes rewritten** | `textarea()` (`textarea[data-fabric="textarea"]`, `L59-62`) -> `.ProseMirror` text + DOM selection offset probe; update `L336` for real in-edit `Ctrl+Z` (two-step `closeHistory`). |
| *(New)* `scene-layer.spec.ts` | **Add (Slice 2b)** | Standalone `/__blank` harness importing `sceneLayer.ts` & `renderFrameBitmap.ts` for CSS crop, rotated/zoomed `DomCardMeasurer`, and interleaved non-tainted `toBlob()`. |
| *(New)* `interleaving.spec.ts` | **Add (2c-i..iii -> 2d)** | `text-image-text` + frame stack, occlusion & covering-image cursor, group scale once, read-only block, `0px` jump, crop/caption/lock/duplicate/preview on DOM path. |
| *(New)* `writing.spec.ts` | **Add (Slice 3)** | Lists, `- [ ] ` two-stage checklist + toggle, quotes, dividers, code, empty-list discard + undo, Backspace & `Ctrl/Cmd+Z` after shortcut, zero-network HTML paste, read-only mid-edit. |
| *(New)* `card-height.spec.ts` | **Add (Slice 4)** | `mb` fixed height + zero Windows scrollbar re-wrap, wheel scroll vs pan, idle fade & `scrollTop = 0`, Auto height, corner scale of fixed height, 45°-rotated + zoomed measurement. |

---

## 15. Owner decisions

None of the items below will be changed silently; each has a clear recommendation and a safe default that preserves today's settled `AGENTS.md` / `README.md` rules until the owner approves:

### Owner answers recorded 2026-11-23

The rest of this plan has **not** been revised to match these answers yet; it will be revised once, after the open items are settled.

| # | Owner's answer | Status | What the rest of the plan must change |
|---|---|---|---|
| **1** | **A** — wire v3 + atomic DB v3 fence | Decided | Nothing (already the recommended design in Section 5). |
| **2** | **A** — base on `feat/captions-frame-navigation-nov22` | Decided, one thing to confirm | The plan was checked against the remote tip `6ad246c`. The local worktree branch has diverged from it (`13a375b`: 3 local commits the remote lacks, 1 remote commit the local lacks, plus uncommitted work). Which of the two is the base must be settled, and the base must be committed, before Slice 1. |
| **3** | Asked for more detail | Open | — |
| **4** | Asked for more detail | Open | — |
| **5** | **C** — HTML paste keeps structure, and pasted plain Markdown is converted | Decided, rule to confirm | Un-cuts "Markdown-on-paste conversion" in Section 2; Section 11 clipboard rules and Slice 3 gain a pure plain-text Markdown converter, a literal-paste escape, and tests. Changes the settled rule that typing shortcuts never fire on paste. |
| **6** | Asked for more detail | Open | — |
| **7** | **A** — `- ` only | Decided | Nothing. |
| **8** | **A** — `Tab` / `Shift+Tab` indent and outdent in lists, exit edit elsewhere | Decided | Slice 3 implements it; README and Expected behaviour record it. |
| **9** | Leaning **B**; asked for more detail | Open | — |
| **10** | **B** — paper background and padding by default | Decided, consequences to confirm | Un-cuts the card surface in Section 2: `surface: 'card'` is written on every new text box (so the first new text box on a board triggers the v3 upgrade), old boxes and captions stay bare, and a way to turn paper off is needed. Affects Sections 5, 6, 10 and Slice 4. |
| **11** | Asked for more detail | Open | — |

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

Before writing Slice 1 code, run a bounded, throwaway **Spike 0** in real Chromium (not committed to the feature branch) that MUST pass all 9 exit criteria below. Every `UNVERIFIED` library claim in this plan is explicitly gated here:

| # | Unverified claim / risk | Spike 0 test & pass criterion | Fallback if spike fails |
|---|---|---|---|
| **S1** | `EditorView.posAtCoords()` and native browser caret/drag-selection accuracy inside CSS `matrix(zoom,0,0,zoom,panX,panY)` + `rotate(angle)` | Click and drag-select text inside a card at zooms `0.25, 0.5, 1, 2, 4` and angles `0°, 30°, 45°`. Caret lands within 1 char of clicked glyph; drag-selection selects expected substring. | If Chromium's `caretPositionFromPoint` mis-maps under rotation, temporarily counter-rotate or map pointer via inverse CSS matrix to compute nearest char offset on mousedown. |
| **S2** | `DOMSerializer` static HTML vs live `EditorView` height/visual parity (`0px` jump) | Measure `getComputedStyle(el).height` and compare pixels before, during, and after edit on a card with H1, empty H2, bullet list, checklist, blockquote, divider, and code block. Height delta `=== 0px`. | Adjust `.yuriful-prose` empty-block `<br>` / margin CSS until delta is `0px`. |
| **S3** | `parseFloat(getComputedStyle(el).height)` ignores CSS zoom & rotation; offscreen `dynamicMinWidth` matches longest word & ZWJ grapheme | Compare measured height of a 45°-rotated card at zoom `0.5` and `2.0` vs unrotated at zoom `1.0` (must match within `0.5px`). Verify offscreen `width: min-content` gives longest-word width for legacy boxes and `width: 0; overflow-wrap: anywhere` never splits a ZWJ emoji on drawn boxes. | Height: read `el.scrollHeight` with `height: auto`. Widest grapheme: measure max `splitGraphemes` span width on offscreen probe. |
| **S4** | `handleTextInput` + `view.composing` under AltGr (`Ctrl+Alt`), numpad `*`, and CDP IME composition | Type `*` via AltGr & numpad (must trigger shortcut); run CDP `Input.imeSetComposition` + `Input.insertText` for `*` and ` ` (must NOT trigger). | Track `compositionstart`/`compositionend` + `isComposing` flag on `EditSession` directly alongside `view.composing`. |
| **S5** | SVG `<foreignObject>` data URL -> 2D canvas `toBlob()` without taint in Desktop Chromium | Render a rich card (H1, checklist, quote, code, fixed-height `scrollTop = 0` overflow clip) + overlapping cropped PNG onto offscreen canvas at `scale = 2`; call `toBlob('image/png')`; assert non-empty PNG and expected ink pixels at both card and overlapping image coordinates. | Do NOT build a Canvas 2D block layout engine. Use scaled read-only DOM `.scene-world` thumbnails for `framePreview.ts`; for `exportFrame.ts` (or Safari `SecurityError`), catch cleanly and surface an explicit browser notice. |
| **S6** | Synthetic `MouseEvent('mousedown')` re-dispatch onto `upperCanvasEl` after `finishEditing()` | While editing card A, perform in real Chromium: (a) click card B, (b) drag card B 80px, (c) Shift-click card B, (d) empty-canvas marquee, (e) Text-tool drag on empty canvas. Every gesture must complete in one press-move-release with zero console errors. | Expose a typed `FrameCanvas.handleForwardedMouseDown(e)` calling Fabric's `_onMouseDown(e)` directly instead of synthetic `dispatchEvent`. |
| **S7** | Inert `DOMParser().parseFromString` HTML paste makes zero network requests | Playwright `page.route('**/*', ...)` intercepts all requests while pasting `<img src="https://example.invalid/x.png"><style>@import url(https://example.invalid/a.css);</style><p><strong>ok</strong></p>`. Assert 0 requests and `ok` bold. | Strip URL patterns with regex before `DOMParser` as defense-in-depth (still never assign `innerHTML` on live DOM). |
| **S8** | Exact Vite 8 bundle delta & jsdom 31 headless `prosemirror-state` compatibility | Measure `npm run build` gzipped delta for the 8 `prosemirror-*` packages and run a Vitest test exercising `EditorState`, `DOMSerializer`, and `prosemirror-history` in jsdom 31. | Confirm exact numbers and document in Slice 2a PR. |
| **S9** | Raster/paint frame intervals & post-zoom text sharpness on 100-card reference board | Seed 100 text cards (10 × 1,500-word reviews + 90 notes) + 50 images + 10 frames in Chromium; record 60 consecutive `requestAnimationFrame` deltas during continuous wheel zoom (`0.5x -> 2x -> 4x`), pan drag, and 20-item multi-drag. Pass: p95 frame interval `<= 20 ms`, no post-zoom raster stall `> 100 ms`, and crisp settled text at `2x`/`4x` (no blurry stale GPU texture). | Tighten `content-visibility: hidden` viewport culling margin; apply temporary `will-change: transform` on `.scene-world` only during active wheel bursts and clear 150 ms after wheel ends so glyphs re-rasterize crisp; if needed at extreme zoom-out (`zoom < 0.35`), render distant cards as simplified block placeholders. |

---

## 17. Changes needed to `AGENTS.md` and `README.md`, and when

Per `AGENTS.md:143`, update `README.md` and `AGENTS.md` **in the same commit** whenever a user-facing rule, shortcut, storage behavior, or known limit changes:
- **Slice 1:** `AGENTS.md` adds `src/model/textDoc.ts` and `RichDoc`/`blocks` strict-vs-lenient + `isBlankTextDoc` rules; both `AGENTS.md` and `README.md` document wire/DB v3 fencing if Owner Decision 1 approves it.
- **Slice 2d *(2a–2c change no user-facing behavior)*:** `AGENTS.md` replaces Fabric `Textbox`/`DrawnTextbox`/`hiddenTextarea` invariants with `.scene-layer` + proxy + `EditSession` invariants, adds ProseMirror under `src/editor/`, and adds review rules (matrix projection, no `getBoundingClientRect()` on rotated cards, no per-card `ResizeObserver`, inert HTML parsing). `README.md` updates Architecture/Testing, drops Fabric browser-undo & cross-card-drop limits (`README.md:114-115`), and adds legacy re-wrap & Chromium-only export notes.
- **Slice 3:** both docs record lists, checklists, quotes, dividers, code, live Markdown shortcuts + `- [ ] ` progression + Backspace/`Ctrl/Cmd+Z` revert, empty-list discard, local-only HTML paste, and approved Owner Decisions 4/5/7/8.
- **Slice 4:** both docs record auto-grow default, `mb` fixed scrollable height, non-reflowing overlay scrollbar, idle fade & `scrollTop = 0`, wheel behavior (Owner Decision 9), and Auto height reset.
