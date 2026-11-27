# yuriful

A desktop-first freeform reference canvas: a local-only editor where you lay out images and text on an infinite, pannable, zoomable board, and group finished spreads into named **frames**. Nothing leaves your machine: there is no account, no server and no cloud storage.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
```

| Script              | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Vite dev server                       |
| `npm run build`     | Typecheck, then production build      |
| `npm run typecheck` | `tsc -b --noEmit`                     |
| `npm run lint`      | ESLint                                |
| `npm test`          | Vitest (unit tests)                   |
| `npm run test:e2e`  | Playwright real-browser regression tests |
| `npm run test:e2e:install` | One-time: download Playwright's Chromium |

## What it does

- Pan and zoom (hand tool, Space+drag, middle mouse, wheel pans, Ctrl/Cmd+wheel zooms, +/- and Fit buttons).
- Add images by file picker or by dropping files onto the board.
- Add text with the Text tool (`T`): click for a default box, or drag out a box to set its wrap width and minimum height. Double-click to edit. Side handles change the wrap width, and corner handles scale the text and box together.
- Formatted text: font, bold, italic, underline and strikethrough on ranges of characters, headings (2, 1.5 or 1.25 times the box's font size, always bold) on whole lines, and alignment and colour for the whole box. Use the panel or `Ctrl/Cmd+B`, `I`, `U` for the corresponding marks.
- Move, resize, rotate, multi-select, layer (forward/back/front/back), delete.
- **Frames**: named rectangles that structure a board without forcing everything into pages (see below).
- **Layers**: a list of everything on the board in stacking order, so that something completely covered can still be selected (see below).
- **Locking**: lock a background image, a finished frame or anything else, so that it cannot be grabbed, moved or changed by accident while everything around it stays reachable (see below).
- **Images: crop, fit and fill**: crop a reference image down to the part that matters without losing the original, change the crop later or undo it, and fit or fill an image to its box (see below).
- **Replace image**: swap the picture inside an image that is already placed (a better scan, a newer screenshot) without disturbing the layout (see below).
- Undo / redo for every canvas change. Esc, or switching away from the window, cancels a drag, resize, frame or text box that is still in progress.
- Autosave to this browser (IndexedDB), including the original image bytes. The header always says what the save state really is, including failures.
- Fail-closed loading: nothing is editable or saved until the stored board has loaded. If it cannot be fully restored (an image fails to decode, the document is unreadable, or storage is unavailable) the board opens **read-only** with a visible reason, pan/zoom still work, and the stored document and image bytes are never rewritten or deleted.

Out of scope for now: published projects, guest viewing, mobile and touch, auth, any backend, frames inside frames, clipping content to a frame, rotating a frame.

## Frames

A frame is a white sheet with an outline and a name label. It sits behind all content and clips nothing.

- **Draw one** with the Frame tool (`F`): drag out a rectangle, or just click for a default-sized frame. The tool is single-use.
- **Grab a frame by its label or its outline.** Its interior is click-through, so you can still select and marquee the things inside it.
- **Rename** it in the panel on the right (double-clicking the label, or the outline, puts the cursor there). A name you are typing is kept when you click elsewhere; Esc discards it.
- **Resizing a frame alone** changes its shape freely and leaves its contents where they are.

### What belongs to a frame

Belonging is decided by what *you moved*, and it is stored; it is never guessed from where things happen to sit.

- Something joins a frame when **it** is moved, resized, rotated or created so that its centre ends inside the frame. Where frames overlap, the one in front gets it. A text's centre is the centre of its box, whose width is the wrapping width rather than the width of what is typed.
- **Moving, resizing or drawing a frame never picks anything up.** A loose image that a frame was moved over, or drawn round, sits inside it but does not travel with it. Nudge the image (or marquee several and nudge them) and they join.
- Moving a frame carries everything it owns. Something owned stays owned until you move it out, or shrink the frame until it no longer contains it (it then becomes loose, even if another frame is underneath).
- Moving a frame *together with* loose objects leaves them loose; things it already owns stay its own.
- Deleting a frame keeps its contents on the board.

The panel shows how many items a frame owns. **Select with contents** selects a frame plus everything it owns that is not locked, so that you can move them, or scale them together from a corner handle.

### Transforming several things at once

A multi-selection can be moved, scaled proportionally from a corner, and (if it contains no frame) rotated. Those are exactly the transforms the saved board can represent, so nothing drifts on save, undo or reload. There is no free-aspect stretch or skew of a group, and holding Shift no longer unlocks one. When scaling would push a text below 6 px or above 400 px, or a frame below 24 units, the whole selection stops together at that point instead of some members scaling further than others.

## Text boxes

With the Text tool (`T`), click for a box ten font sizes wide, or drag a rectangle from any corner. A dragged box keeps the rectangle's width and minimum height. Text starts at the top, wraps at spaces when possible, and grows the box downward if it needs more room. As you delete text, the box shrinks toward the drawn minimum. The font size depends on zoom. A drag of less than a few pixels or less than two font sizes wide counts as a click and makes the default box where you pressed.

- You can drag out a box inside a frame because the interior is click-through. The centre of the text box determines which frame owns it. This is checked again when you first finish typing, after any growth. Pressing on an existing object or on a frame's label or outline selects that target.
- `Esc` or switching away from the window while dragging cancels it, and `Esc` also leaves the Text tool. The tool is single-use: after the release you are typing in the new box with the Select tool active.
- A box you leave without typing anything disappears, with nothing saved and no undo step.

## Formatting text

Select one text and the panel on the right shows its formatting: font, size, heading, bold / italic / underline / strikethrough, alignment and colour. The panel's buttons never take the keyboard away from a text you are typing in: click one and keep typing. (Several selected objects show no formatting controls.)

- **While you are editing a text** (double-click it), bold, italic, underline and strikethrough act on the selected characters: a mark is removed if every selected character already has it, otherwise added to all of them. With only a caret, your choice applies to what you type next; the buttons show what the next character will look like. That choice is dropped when you move the caret (arrow keys, a click) or leave the text; a bold choice is also dropped when the caret's line becomes a heading (with the panel, with `# `, or by joining the line into a heading), since a heading is bold already, while italic, underline and strikethrough choices stay. Headings act on every line the selection touches, or the caret's line.
- **With the text selected but not being edited**, everything acts on the whole box: a mark goes on unless every character already has it; a heading goes on every line. An empty last line (where the caret goes after a final line break) is left out: it does not make the panel show the heading as mixed, and a heading set on the box does not reach it. Body on the box does reach it, so an empty last line that is still a heading (left over after deleting the text of a heading line) goes back to a normal line.
- **Font** changes the highlighted characters while you edit. With only a caret, it sets the font for what you type until you move the caret or leave the edit. Selecting the box and choosing a font gives all its text that font. The panel shows **Mixed** for a selection with several fonts.
- **Alignment and colour** apply to the whole box. Alignment moves the words inside the box. Colours are a fixed set of eight, including white for text on images.
- **A heading line is always bold.** Bold has no effect on a selection that lies entirely in heading lines (the Bold button shows pressed and greyed out there), and on a selection that mixes heading and normal lines it changes the normal lines only. Setting a line back to Body leaves it plain.
- **Undo:** formatting changed while editing is saved straight away, like typing, and the whole edit becomes one undo step when you leave the text. Formatting a selected box is an undo step of its own (quick repeats of the same kind, such as trying several fonts, count as one).
- Formatting never changes which frame an existing text belongs to, even when a heading makes it taller. A new text's frame is decided once more when you first stop typing in it, from where its box then is, so formatting done while first typing it can count.
- Holding `Ctrl/Cmd+B`, `I` or `U` down toggles once, however long you hold it.

### Typing shortcuts

While you type in a text, three markers turn into formatting, as a quicker way to press the same buttons. The markers disappear; they are never stored.

- `# `, `## ` or `### ` at the very start of a line (the space typed last) makes that line Heading 1, 2 or 3. It works on an empty line, at the start of a line that already has text, and on a line that is already a heading (it changes the level).
- `**bold**`: typing the second `*` of the closing `**` makes the text since the opening `**` bold. `*italic*`: typing the closing `*` makes it italic. What you type straight afterwards is plain again. In a heading, `**...**` only removes the markers (a heading is bold already).
- They do not fire when what is between the markers is empty, starts or ends with a space, contains a `*` or a line break; when the opening marker is in the middle of a word or touches another `*`; or for `####` or a `#` that is not at the start of the line. So `2 * 3 * 4`, `a ** b`, `* item`, `snake*case*`, `***x***` and `#tag` stay as typed. Text that already contains markers (pasted, dropped, typed with an input method such as a Japanese IME, or loaded) is never converted.
- **Backspace straight after a shortcut fired puts the characters back exactly as you typed them**, with the markers, and deletes nothing. It does so only as the very next thing you do: once you type, move the caret, use the panel or leave the text, Backspace deletes as usual.
- Like typing, a shortcut is saved straight away and is part of the one undo step recorded when you leave the text.

## Board appearance

Open **Appearance** in the header to choose a background color and dots, grid, or no pattern. Try a built-in preset or name your combination and click **Save preset** to use it again. Custom presets stay with this local board after reload. **Reset appearance** brings back the default dots and keeps your saved presets. Background changes save automatically and sit outside object undo and redo.

## Align and distribute

Select two or more items and use **Align** in the Inspector to line up their edges or centers. Alignment uses the displayed boxes, including cropped and rotated images. **Distribute** spaces the gaps between three or more items on one axis, keeping the outer items where they are. The axis is available when the items fit between those endpoints.

Aligning a frame moves its unselected contents along with it. Selected contents move according to their own alignment. Undo and redo each take one step for the whole layout change.

## Duplicate an item or spread

Select an unlocked item and click **Duplicate** in the Inspector, or press `Ctrl/Cmd+D`. Copies retain text formatting and image crops, start slightly down and right, and share the source image file. A duplicated frame brings its owned items along, including ones you did not select. The copies start unlocked. Undo removes the entire duplication together.

## Layers

The **Layers** panel at the bottom right lists everything on the board, front-most first: all images and texts from front to back, then all frames from front to back (frames always sit behind content). Its header collapses and expands it.

- **Click a row to select that object**, even one hidden completely under a bigger image. Ctrl/Cmd-click or Shift-click adds a row to the selection or takes it out, so you can build a multi-selection from the list and then move or scale it on the board.
- **Alt-drag moves a covered object you selected from the list.** Its handles work as usual, but a plain press on its body goes to whatever lies on top of it, as everywhere on the board (inside the box of a multi-selection a press goes to the selection, Alt or not). Hold Alt while pressing and the press goes to the selected object instead, if it is under the pointer. It is an ordinary drag: one undo step, cancelled by Esc (even with Alt still held), and dragged out of its frame it stops belonging to it. A frame's label or outline still wins over it.
- **Drag a row to reorder it.** Aim at the upper or lower half of another row to place it above or below that row. The line marks where it will go. Images and text can move among other images and text, and frames can move among other frames. A locked row can anchor a drop. Unlock it to drag it. A drop moves one row, keeps the current selection and frame ownership, and is one undo step. Press Esc or release where there is no line to cancel.
- `[` / `]` and the Layer buttons in the panel on the right reorder the selection; the list shows the new order straight away.
- A text's row follows what you type. While a text is empty it is not listed, because an empty text is never kept.
- The list is flat. Something that belongs to a frame is not shown inside it, because stacking order is shared by the whole board and has nothing to do with belonging; its row shows the frame's name instead.
- Selecting from the list changes nothing on the board, so it is never an undo step and never saves. If you were typing a text, leaving it works as when you click anywhere else: typed text is kept as its own undo step, and a text left empty is discarded. A field you were typing in (font size, frame name, board title) keeps what you typed and lets go, so your next keys act on the board.
- Each row has a padlock at its right edge (it shows on hover, and always on a locked row). See Locking.
- On a read-only board the list still shows what is there, but its rows and padlocks do nothing.

## Locking

A locked image, text or frame stays exactly where it is until you unlock it. It is meant for a background image you keep pressing on by accident, or a finished frame you do not want to nudge.

- **Lock** with the padlock on its row in the layer list, the **Lock** button in the panel on the right, or `Ctrl/Cmd+Shift+L`. Locking several selected things locks them all.
- **It cannot be grabbed on the board.** A press on it goes to whatever lies beneath, as if it were not there: drag a small image out from under a locked background, or drag across the background to marquee what is on it. A marquee, Select all and Shift-click leave it out, a double-click does not edit a locked text, and a locked frame cannot be grabbed by its label or outline. With the Text tool, a click on a locked image places a new text there.
- **Unlock** with the padlock on its row (it stays visible on a locked row), or select the row and press **Unlock** (or `Ctrl/Cmd+Shift+L`). Clicking a padlock never selects the row.
- **The layer list is the only way to select it**, and then only on its own: a selection that contains a locked item contains nothing else. Ctrl/Cmd- or Shift-clicking a locked row selects just it, and Ctrl/Cmd- or Shift-clicking another row then selects just that one. While it is selected it shows its outline but no handles, and nothing changes it: it cannot be moved, resized or deleted, it keeps its place in the stacking order, and its font size or frame name cannot be changed.
- **It still belongs to its frame.** Moving the frame carries a locked image with it. "Select with contents" leaves locked things out, so they follow a move but are not scaled with the frame; like anything else, a locked item is no longer the frame's once the frame is resized so that it no longer contains it. Deleting a frame leaves its locked things on the board. Things can still be moved into or out of a locked frame, and its unlocked contents can be edited as usual.
- Locking and unlocking are undo steps and are saved, like any other change. They never move anything or change what belongs to which frame.

## Images: crop, fit and fill

Select one image and the panel on the right shows **Crop**, **Fit** and **Fill**.

### Crop

- **Start** with **Crop**, or double-click the image (with the Select tool). The whole original appears in place, the part outside the crop is dimmed, and a box with eight handles shows what will be kept. Nothing on the board moves: the part you keep stays exactly where it was.
- **Drag a handle** to move that edge or corner (any shape you like), or **drag inside the box** to move it over the image. The box always stays on the image. Dragging a handle inwards stops 8 units short of the opposite side (as the box is shown on the board, and never less than one pixel of the original); a side that is already shorter than that, for example after Fill, can grow but is not made longer for you.
- **Apply** with Enter, **Done**, or by clicking anywhere outside the box (that click does nothing else). **Cancel** with Esc or **Cancel**: the image is exactly as it was and nothing is recorded.
- Pan and zoom work as usual while cropping (wheel, Space-drag, middle button, the zoom keys and buttons). Every other key is ignored until the crop is applied or cancelled (it is not remembered for later). Clicking a tool, a layer row, Undo or another button applies the crop first and then does what you clicked. Undo is available as soon as you have changed the crop, even on a board you have only just opened: it applies the crop and takes it back. That is the Undo button; the Ctrl/Cmd+Z key is ignored while cropping, like every other shortcut.
- **Cropping never throws anything away.** The original image is kept whole; crop it again later and the whole original comes back, so you can widen the crop or drag it back out to the full image (the crop is then gone). A crop is one undo step.
- A crop counts as resizing the image: if what is left has its centre outside the frame it belonged to, it no longer belongs to it (and joins a frame in front that does contain its centre, as when you resize it).

### Fit and Fill

Both keep the image where it is and work on its current box: what you see of it now.

- **Fill** keeps the box as it is (to the precision the board is saved in: crops to a hundredth of a pixel of the original, so on an image shown greatly enlarged a side can move by a fraction of a unit) and fills it with as much of the image as fits, centred. For example, a 600 x 400 photo cropped to its top-left corner as a square: Fill keeps the square and shows the middle 400 x 400 of the photo in it instead.
- **Fit** shows the whole image again, as large as fits inside the box (to the precision the board is saved in, so it can stick out by a hair, a few hundredths of a unit at most), centred on it. The square from the example becomes a 3:2 picture as wide as the square, centred where the square was. Since an image has no empty area, the box shrinks to the image's shape.
- Each is one undo step. A button that would change nothing is greyed out, so straight after Fill the Fill button is greyed out (a second Fill would change nothing), and the same for Fit. Fit counts as resizing for frame belonging, like a crop; Fill never changes what belongs to which frame.

### Replace image

Select one image and press **Replace image**, then choose a picture file. The new picture goes into the image you had selected when you pressed the button, even if you click elsewhere while the file dialog is open.

- **What stays:** where it is, its size on the board, its angle, its place in the stacking order, and the frame it belongs to.
- **What changes:** the picture. It fills the old box exactly like **Fill**: as much of the new picture as fits, centred, cropped at the sides or at the top and bottom when its shape differs from the box's. A picture of the same shape at another resolution (an 800 x 600 version of a 400 x 300 picture) simply replaces the old one, with nothing cropped. The old crop is dropped, because it described the old picture.
- To see the whole new picture instead, press **Fit** afterwards: it shrinks the box to the new picture's shape, inside the old box.
- It is one undo step. Undo brings back the old picture exactly as it was: it is kept for the rest of the session even after it has been replaced.
- If the image was deleted or locked while you were choosing the file, or the board became read-only, nothing is replaced and a message says why. If you were dragging something when the picture finished loading, it is replaced as soon as the drag ends. If you were cropping, the crop is applied first.
- If you replace the same image again before the first picture has finished loading, the picture you picked last is the one that stays: an earlier pick that finishes loading later is quietly ignored.
- The old picture's file stays stored on this device until the board is next opened, which removes the pictures it no longer uses.

A locked image cannot be cropped, fitted, filled or replaced until it is unlocked.

## Storage, tabs and older builds

Everything is stored in this browser's IndexedDB, for this origin (`http://localhost:5173` and `http://127.0.0.1:5173` are different origins and have separate boards).

- **Boards saved by the previous build (milestone 1) open as they are.** Opening writes nothing. A board without frames keeps being saved in the old format.
- **The first save of a board that contains a frame upgrades the database** in the same step that writes the board. From then on the previous build can no longer open it. This is deliberate: an old tab would otherwise silently drop the frames. There is no backup and no way back to the old build for that board.
- **Two tabs on one board:** a tab never overwrites a board that another tab has changed since it loaded or last saved. It becomes read-only with a Reload button, and whatever it had not yet saved is not saved.
- **Text formatting is stored inside each text**, in optional fields that are left out when they have their default, so a plain text is stored exactly as before and formatting needs no database change. A malformed formatting field is dropped when the board loads instead of making the board unreadable. The previous build shows formatted text plain and drops its formatting the next time it saves that board.
- If another tab holds the database while a frame is first being saved, the save fails after a few seconds with a Retry; close the other tab and retry.

### Known limits

- One board per browser profile and origin.
- Until a board has its first frame, an open tab of the previous build can still overwrite it or prune its unused images, as it always could. This build reports the conflict instead of overwriting back, and re-stores any image bytes that are missing the next time it saves.
- Image bytes are stored as uploaded (no downscaling) and are also kept in memory for the session, so that undo can always bring an image back; very large images are limited by browser storage quota, and a failed write is reported in the header.
- Something sitting inside a frame without belonging to it looks the same as something that does. The item count and "Select with contents" tell you which is which.
- A new text belongs to a frame based on the centre of its box. A click creates a box ten font sizes wide, so a short note near the right edge can be loose even when its words are inside. Drawing a box lets you place its centre. Its frame is decided again when you first stop typing, so overflow can move the centre below the frame. You can move or resize the box afterwards. Whether a new text should keep the frame it started in is an open design question.
- Fonts are named choices (Sans, Serif, Mono, Handwritten, Display) drawn with fonts already on the machine, so the exact typeface, and where lines wrap, can differ between machines.
- A heading belongs to a line, and editing carries each line's level over rather than guessing it from the text. Enter at the end of a heading starts a normal line; Enter in the middle of a heading leaves two headings; Enter at the start of a heading leaves an empty heading line above it. A heading line whose characters are all deleted stays a heading, so what you type there next is a heading too. Joining two lines keeps the level of the line the join starts in: Backspace at the start of a normal line under a heading makes it part of the heading, and Backspace at the start of a heading under a line with text makes it normal text (not bold), except that a heading joined onto an empty line stays a heading. Typing next to a bold character is bold (unless you turned bold off at the caret first). Pasted or dropped text keeps its bold, italic, underline and strikethrough, so text copied from a heading arrives bold at the normal size, but it never brings its own size, colour or font. A mark chosen with only a caret also applies to text pasted or dropped at the caret before it moves. These choices are provisional.
- A selection that ends just after a line break (at the very start of the next line) does not count that next line for a heading.
- A dragged box breaks a word that would otherwise be too wide at a character boundary, keeping combined characters such as emoji together. A single character wider than the box can still widen it. Older and click-created boxes widen to fit the longest word. Changing back to a smaller font or removing a long word leaves that width in place. Undo or drag a side handle to narrow the box.
- Several selected objects show no formatting controls, even if they are all texts.
- Dropping dragged text into a centred or right-aligned text can shift its box: when the dropped words make the box wider, it widens from its left edge, which is how the canvas library inserts dropped text. Typing keeps the box's alignment edge in place.
- `Ctrl/Cmd+Z` while you are typing in a text is the browser's own undo of the typing. It brings back the characters but not a heading level the undone edit changed: after Backspace joins a normal line into a heading, undoing it this way leaves both lines headings. Leave the text and use the board's undo instead to restore the text and its formatting exactly. The browser's undo also cannot take back a typing shortcut or its Backspace revert: straight after one it does nothing, and later it undoes only what was typed since.
- Touch input is not supported.
- The layer list cannot be stepped through with the arrow keys (Tab and Enter work), and it is not laid out for windows shorter than about 600 px.
- Locks and crops are stored as extra fields that any older build does not know (milestone 1, and the frames build from before locking): such a build reads only the fields it knows. Where it can still open the board (milestone 1 cannot open one that has frames), it ignores locks, and it shows a cropped image whole, at the same scale, with the original's top-left corner where the crop's top-left corner was (so the image is larger and its content shifts). When that build saves the board, the locks and crops are gone.
- The padlock on a layer row is a button inside a list option. Some screen readers may not announce it, and each row has two Tab stops (the row and its padlock).
- While cropping, the dimmed part of the image and the crop box are drawn over everything, including anything that lies on top of the image; the image itself keeps its place in the stacking order.
- Starting a crop with the Hand tool selected switches to the Select tool (as from the Text and Frame tools), so the crop box can be dragged straight away.
- A crop handle is grabbed within 8 screen pixels. On a very small crop box the handles cover the whole box, so it can be resized but not moved; zoom in to move it.
- Replace image leaves whatever you were doing first, like every other command: a crop that is open, or a text being typed, is finished as its own undo step when the new picture arrives, even if the image then turns out to be gone or locked and is not replaced.
- The file dialog cannot be dismissed by the app: if the image you pressed Replace image for is deleted while the dialog is open, choosing a file afterwards only shows a message.
- Choosing the very same file again replaces the picture with an identical copy: it is stored as a new picture and is an undo step of its own, as when the same file is added twice.
- Zoom to fit (`Shift+1` or the button) while cropping fits the whole original as it is shown during the crop; only the view changes.
- An image stored with a negative scale (mirrored) is not kept mirrored: the next save stores it un-mirrored and turned instead. This app never creates one (objects cannot be flipped), so it can only come from data written elsewhere; whether mirrored images should be supported is an open question.
- A saved crop that reaches outside its image (only possible if the stored board was edited by hand or damaged, or was saved by a pre-release build of this feature, which could store a crop a hundredth of a pixel past the edge) is trimmed to the image when the board opens. Opening writes nothing, but the next save stores the trimmed crop. A crop that such a build saved within a hundredth of a pixel of the whole image used to be shown whole and is now shown as that hair-thin crop; the difference cannot be seen.
- Pressing on the board while cropping does not take the keyboard focus away from a field you were typing in, such as the board title (as with the Hand tool). Enter and Esc then go to that field, not to the crop; use Done or Cancel instead.
- On the board itself nothing shows that something is locked, apart from the plain cursor over it and the fact that it does not respond; the padlock in the layer list does show it.
- A locked item selected from the list is let go as soon as you press on it on the board, because the press goes to whatever lies beneath it (or starts a marquee).
- "Select with contents" stays available for a frame that owns only locked things; it then selects the frame alone.
- Alt+double-click on a covered text that you selected from the list starts editing it while it is still hidden under whatever covers it, so typing changes text you cannot see. Whether that double-click should be ignored, or bring the text into view, is an open design question.

## Testing

```sh
npm run lint && npm run typecheck && npm test && npm run build

npm run test:e2e:install   # once: downloads Playwright's bundled Chromium
npm run test:e2e           # starts its own dev server on :5199 and runs e2e/*.spec.ts
```

- **Unit tests** (`src/**/*.test.ts`, Vitest) cover the pure model (documents, rich text, ownership rules, scale limits, hit geometry), history, persistence (revision tokens, the database upgrade, asset presence, with `fake-indexeddb`), keyboard handling, crop, Fit, Fill and replace geometry, and the `Editor` state machines (hydration, gestures, frames, layers, locking, crop mode, Fit and Fill, replacing an image) on a small fake of Fabric, since jsdom has no canvas.
- **e2e tests** (`e2e/`, Playwright) run the real app with real Fabric and real IndexedDB in a real browser: `hydration.spec.ts` (nothing is editable or saved before the board has loaded; a board that cannot be restored is read-only and untouched), `gestures.spec.ts` (what a save sees during a drag, cancelling, mouse buttons, the single scale factor), `frames.spec.ts` (drawing, hit testing, ownership, carrying, resizing), `layers.spec.ts` (selecting covered objects from the layer list and Alt-dragging them, reordering, multi-selections built from the list, leaving a text edit, the panel's place on screen), `locking.spec.ts` (presses, marquees and Shift-click passing through locked things, a locked member travelling with its frame, the three ways to lock, undo, save and reload), `images.spec.ts` (cropping by handles and by moving the box, on rotated and scaled images, proving with canvas pixel samples that the kept pixels do not move; cancelling; what a save and a reload see mid-crop; Fit and Fill; frame belonging; a cropped image in a multi-selection), `replace.spec.ts` (replacing a picture through the file chooser keeps the box, owner and stacking, with pixel samples of the new picture; undo, reload and which picture files stay stored; a target deleted or locked while the dialog is open), `storage.spec.ts` (opening a milestone 1 board, the upgrade, two tabs), `text.spec.ts` (formatted text drawn, saved, scaled, undone and typed into), `formatting.spec.ts` (the panel's text controls and `Ctrl/Cmd+B`, `I`, `U` on a range, at a caret and on a whole box), `texttool.spec.ts` (dragging out a text box with the Text tool, and the click that still gives the default box) and `typing.spec.ts` (the typing shortcuts typed for real, what stays literal, Backspace to undo one, and that typing goes on normally afterwards). Fixtures are generated in code, including boards written by a frozen copy of the previous build's storage code; each test gets an isolated browser context, so it never touches your own profile or data.
- Use a browser already on your machine instead of the bundled one with `PW_CHANNEL=msedge` or `PW_CHANNEL=chrome`; change the port with `E2E_PORT`.
- Failure traces and screenshots go to `test-results/` (git-ignored).

## Keyboard shortcuts

Shortcuts never fire while you are typing in a field or editing text, except `Ctrl/Cmd+B`, `I`, `U` in a text you are editing, and `Backspace` straight after a typing shortcut (see above). While a drag, resize, frame or text box is in progress only `Esc` and the zoom keys respond. While cropping only `Enter`, `Esc`, the zoom keys and `Space` respond.

| Key                         | Action                         |
| --------------------------- | ------------------------------ |
| `V` / `H` / `T` / `F` / `I` | Select / Hand / Text / Frame / Add image |
| `Space` (hold)              | Temporary hand                 |
| `Ctrl/Cmd+Z`                | Undo                           |
| `Ctrl/Cmd+Shift+Z`, `Ctrl+Y`| Redo                           |
| `Delete` / `Backspace`      | Delete selection               |
| `Ctrl/Cmd+A`                | Select all                     |
| `Ctrl/Cmd+D`                | Duplicate the selection        |
| `[` / `]`                   | Send backward / bring forward (frames stay behind content) |
| `Ctrl/Cmd+[` / `]`          | Send to back / bring to front  |
| `Ctrl/Cmd+Shift+L`          | Lock the selection; unlock a locked one |
| `Ctrl/Cmd+B` / `I` / `U`    | Bold / italic / underline: the selected characters (or what you type next) while editing a text; the whole box when one text is selected |
| `+` / `-` / `0` / `Shift+1` | Zoom in / out / 100% / fit     |
| `Esc`                       | Cancel what is in progress (also a crop); otherwise leave the tool, or deselect |
| `Enter` (while cropping)    | Apply the crop                 |
| Double-click an image       | Crop it                        |

Only the primary mouse button edits. The middle button pans. Holding Alt while pressing acts on the selected object even when something lies on top of it (see Layers); without Alt a press goes to the front-most object (inside the box of a multi-selection, to the selection), and a frame's label or outline wins either way. A locked object is never what a press goes to.

## Architecture

- **Fabric.js 7** (MIT) renders and edits the canvas. React renders only the chrome (header, toolbar, inspector, layer list) and never touches Fabric objects.
- `src/editor/Editor.ts` is the single bridge: it owns the Fabric canvas, history, assets and autosave, and exposes an immutable `EditorState` snapshot through `subscribe`/`getState` (`useSyncExternalStore`). Fabric's event callbacks only record facts; a finished gesture is settled in a microtask after Fabric's own mouse-up handling, and a save during a gesture stores the board from before it.
- `src/editor/FrameCanvas.ts` extends Fabric's canvas for frames (what counts as a hit, Shift-click and marquee rules) and `src/editor/frameLayer.ts` holds the one geometry used both to draw a frame's outline and label and to hit them.
- `src/model/` is pure and unit-tested: document types and validation, the frame ownership rules and scale limits (`frames.ts`), canonical text formatting (`richText.ts`), crop, Fit and Fill geometry (`crop.ts`), snapshot `History` (with coalescing), layer reordering, viewport math. `src/editor/cropLayer.ts` draws crop mode's box and handles from the same geometry that is hit.
- `src/persistence/` has the IndexedDB store (document and image bytes written in one transaction, guarded by a revision token) and the `Autosaver` status machine.
- `src/input/shortcuts.ts` maps key events to actions and decides when to stay out of the way.

The saved document references images by id; the bytes live in a separate IndexedDB store. Frames have stable ids, names and unrotated rectangles, and each object records the frame that owns it. A text's formatting is stored as character ranges (UTF-16 offsets into its text) and per-line heading levels, and drawn as Fabric per-character styles (`src/editor/objects.ts`). Undo/redo restores objects from serialized snapshots, using already-decoded images, so it is synchronous.
