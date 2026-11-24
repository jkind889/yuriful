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
- Add text with the Text tool (`T`): click for a default box, or drag out a box to set its wrap width and minimum height. Double-click to edit; the text you are editing has a thin outline in the accent colour. Side handles change the wrap width, and corner handles scale the text and box together.
- Formatted text: font, bold, italic, underline, strikethrough and inline code on ranges of characters, headings (2, 1.5 or 1.25 times the box's font size, always bold) on whole lines, and alignment and colour for the whole box. Use the panel or `Ctrl/Cmd+B`, `I`, `U` for the corresponding marks.
- Writing blocks: bullet lists, numbered lists, checklists you tick with a click, quotes, dividers and code blocks, typed with Markdown-style shortcuts or made with the panel (see Writing blocks).
- Move, resize, rotate, multi-select, layer (forward/back/front/back), delete.
- **Frames**: named rectangles that structure a board without forcing everything into pages (see below).
- **Layers**: a list of everything on the board in stacking order, so that something completely covered can still be selected (see below).
- **Locking**: lock a background image, a finished frame or anything else, so that it cannot be grabbed, moved or changed by accident while everything around it stays reachable (see below).
- **Images: crop, fit and fill**: crop a reference image down to the part that matters without losing the original, change the crop later or undo it, and fit or fill an image to its box (see below).
- **Replace image**: swap the picture inside an image that is already placed (a better scan, a newer screenshot) without disturbing the layout (see below).
- Undo / redo for every canvas change, and step by step through your typing while you are still in a text. Esc, or switching away from the window, cancels a drag, resize, frame or text box that is still in progress.
- Autosave to this browser (IndexedDB), including the original image bytes. The header always says what the save state really is, including failures.
- Fail-closed loading: nothing is editable or saved until the stored board has loaded. If it cannot be fully restored (an image fails to decode, the document is unreadable, or storage is unavailable) the board opens **read-only** with a visible reason, pan/zoom still work, and the stored document and image bytes are never rewritten or deleted.

Out of scope for now: published projects, guest viewing, mobile and touch, auth, any backend, frames inside frames, clipping content to a frame, rotating a frame.

## Image captions

Select an image and choose **Add caption** or press Enter. To attach existing text, select it with the image and choose **Make caption**. A new caption starts below the image.

Caption snapping is on by default. Drag upright text close to any of the four displayed image edges. The outline shows where it will land. Slide along that edge to choose the position, then release to attach. Hold Ctrl or Cmd on release to skip snapping. Choose **Detach caption** to keep the text in place as an independent item.

To turn snapping off or back on, open **Canvas options** and change **Snap captions to images**. The setting is saved for this browser profile and site address. Earlier builds made snapping opt-in and could save it as off when you changed **Interaction feedback**. A saved off setting stays off until you turn it on.

The caption follows the image, including when the image changes frame. After a snap, its center keeps the same relative position along the chosen edge when the image is resized. Select the image or caption and turn on **Caption background** to add a colored box. Attachment, position and background are saved with the board and can be undone.

**Interaction feedback** in **Canvas options** shows which frames may gain or lose items on release. When it is enabled, drag toward the canvas edge to pan while holding the item.

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

### Find and tour frames

Open **Jump to…** or press `J` to search by frame name. Use the arrow keys and Enter or choose a result. **Board map** shows where the frames sit and which part of the board you are viewing. Choose a frame there to jump to it. **Return to start** restores the view you had before the first jump in the sequence. A manual pan or zoom ends the sequence.

Open **Frame tour** for a detached view of the selected frames, or the frames on screen if you have no frame selected. Use **Previous frame**, **Next frame**, or the left and right arrows. Press Esc to return to the canvas. The tour leaves the board view and selection as they were.

### Transforming several things at once

A multi-selection can be moved, scaled proportionally from a corner, and (if it contains no frame) rotated. Those are exactly the transforms the saved board can represent, so nothing drifts on save, undo or reload. There is no free-aspect stretch or skew of a group, and holding Shift no longer unlocks one. When scaling would push a text below 6 px or above 400 px, or a frame below 24 units, the whole selection stops together at that point instead of some members scaling further than others.

## Text boxes

With the Text tool (`T`), click for a box ten font sizes wide, or drag a rectangle from any corner. A dragged box keeps the rectangle's width and minimum height. Text starts at the top, wraps at spaces when possible, and grows the box downward if it needs more room. As you delete text, the box shrinks toward the drawn minimum. The font size depends on zoom. A drag of less than a few pixels or less than two font sizes wide counts as a click and makes the default box where you pressed.

- You can drag out a box inside a frame because the interior is click-through. The centre of the text box determines which frame owns it. This is checked again when you first finish typing, after any growth. Pressing on an existing object or on a frame's label or outline selects that target.
- `Esc` or switching away from the window while dragging cancels it, and `Esc` also leaves the Text tool. The tool is single-use: after the release you are typing in the new box with the Select tool active.
- A box you leave without typing anything disappears, with nothing saved and no undo step. So does one that holds only an empty list item, an empty checklist item, an empty quote or an empty heading. A box that holds only a divider, or only a ticked checkbox, is kept.
- Select words and drag them to move them within the same box. To move words into another box, cut and paste them: dragging them from one box into another does not work.

## Formatting text

Select one text and the panel on the right shows its formatting: font, size, heading, bold / italic / underline / strikethrough, alignment and colour. The panel's buttons never take the keyboard away from a text you are typing in: click one and keep typing. (Several selected objects show no formatting controls.)

- **While you are editing a text** (double-click it), bold, italic, underline and strikethrough act on the selected characters: a mark is removed if every selected character already has it, otherwise added to all of them. With only a caret, your choice applies to what you type next; the buttons show what the next character will look like. That choice is dropped when you move the caret (arrow keys, a click) or leave the text; a bold choice is also dropped when the caret's line becomes a heading (with the panel, with `# `, or by joining the line into a heading), since a heading is bold already, while italic, underline and strikethrough choices stay. Headings act on every line the selection touches, or the caret's line.
- **With the text selected but not being edited**, everything acts on the whole box: a mark goes on unless every character already has it; a heading goes on every line. An empty last line (where the caret goes after a final line break) is left out: it does not make the panel show the heading as mixed, and a heading set on the box does not reach it. Body on the box does reach it, so an empty last line that is still a heading (left over after deleting the text of a heading line) goes back to a normal line.
- **Font** changes the highlighted characters while you edit. With only a caret, it sets the font for what you type until you move the caret or leave the edit. Selecting the box and choosing a font gives all its text that font. The panel shows **Mixed** for a selection with several fonts.
- **Alignment and colour** apply to the whole box. Alignment moves the words inside the box. Colours are a fixed set of eight, including white for text on images.
- **A heading line is always bold.** Bold has no effect on a selection that lies entirely in heading lines (the Bold button shows pressed and greyed out there), and on a selection that mixes heading and normal lines it changes the normal lines only. Setting a line back to Body leaves it plain.
- **Undo while you edit:** `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`) and the Undo and Redo buttons step back and forward through what you did in the text, one step at a time: typing, deleting, pasting, marks, headings, fonts and typing shortcuts. The text stays open. The size, alignment and colour of the whole box are not steps of this: they stay as they are until you leave the text and use Undo there.
- **Undo after you leave:** everything you did in a text, typing and formatting alike, is saved straight away and becomes one undo step when you leave the text. To take back a whole sitting, press Esc, then Undo. Changing the font size while you edit is the exception: it makes everything up to that point, at the new size, an undo step of its own. For example, replace the words of a text with `First`, change the size from 24 to 36, type ` second` and press Esc: the first Undo brings back `First` at 36, and a second Undo the text as it was at 24. In a caption attached to an image, or in a text that is empty when you change the size, this does not happen: the new size is part of the one undo step made when you leave. Formatting a selected box is an undo step of its own (quick repeats of the same kind, such as trying several fonts, count as one).
- Formatting never changes which frame an existing text belongs to, even when a heading makes it taller. A new text's frame is decided once more when you first stop typing in it, from where its box then is, so formatting done while first typing it can count.
- Holding `Ctrl/Cmd+B`, `I` or `U` down toggles once, however long you hold it.

### Typing shortcuts

While you type in a text, three markers turn into formatting, as a quicker way to press the same buttons. The markers disappear; they are never stored.

- `# `, `## ` or `### ` at the very start of a line (the space typed last) makes that line Heading 1, 2 or 3. It works on an empty line, at the start of a line that already has text, and on a line that is already a heading (it changes the level).
- `**bold**`: typing the second `*` of the closing `**` makes the text since the opening `**` bold. `*italic*`: typing the closing `*` makes it italic. What you type straight afterwards is plain again. In a heading, `**...**` only removes the markers (a heading is bold already).
- They do not fire when what is between the markers is empty, starts or ends with a space, contains a `*` or a line break; when the opening marker is in the middle of a word or touches another `*`; or for `####` or a `#` that is not at the start of the line. So `2 * 3 * 4`, `a ** b`, `* item`, `snake*case*`, `***x***` and `#tag` stay as typed. Text that already contains markers (pasted, dropped, typed with an input method such as a Japanese IME, or loaded) is never converted.
- **Backspace straight after a shortcut fired puts the characters back exactly as you typed them**, with the markers, and deletes nothing. It does so only as the very next thing you do: once you type, move the caret, use the panel or leave the text, Backspace deletes as usual.
- `Ctrl/Cmd+Z` straight after a shortcut also brings the markers back; a second `Ctrl/Cmd+Z` takes back what you typed. Redo after either turns the markers into formatting again.
- Like typing, a shortcut is saved straight away and is part of the one undo step recorded when you leave the text.

## Writing blocks

A text can hold more than lines: bullet lists, numbered lists, checklists, quotes, dividers and code. They are meant for longer writing, such as a review with a track list, a few quotes and a to-do list at the end.

Type a shortcut at the start of a line and it turns into the block as you type. The characters you typed disappear.

| Type at the start of a line | You get |
| --- | --- |
| `- ` | a bullet list |
| `1. ` (a whole number from 1 to 999,999,999) | a numbered list starting at that number |
| `- [ ] ` or `- [x] ` | a checklist item, unticked or ticked |
| `[] ` or `[ ] ` | an unticked checklist item |
| `> ` | a quote |
| `---` (the whole line) | a divider, with a new line after it |
| ```` ``` ```` | a code block holding the rest of the line |

Inside a line, `` `code` `` makes inline code: typing the closing backtick sets the text between the backticks in a monospace font on a light tint, and what you type next is plain.

- A checklist item comes in two steps: `- ` makes a bullet, then `[ ] ` or `[x] ` at the start of that item makes it a checklist item. In a list of several bullets, only that item changes.
- `* ` is not a bullet: `* item` stays as typed. So do `0. `, a marker after other text, and markers typed inside a list item, a code block or inline code.
- **Backspace straight after a shortcut puts the characters back** exactly as you typed them, as for the other typing shortcuts. `Ctrl/Cmd+Z` straight after does the same, and a second `Ctrl/Cmd+Z` takes back what you typed.
- Pasted text never turns into blocks: a list copied from one text and pasted into another arrives as plain lines (see Known limits).

**In a list or checklist:** Enter starts a new item (a new checklist item starts unticked). Enter on an empty item leaves the list, or moves a nested item out one level. Backspace at the start of an item does the same. `Tab` nests the item under the one above it and `Shift+Tab` moves it back out. `Tab` on the first item of a list does nothing, so the edit stays open. Anywhere else, `Tab` leaves the text as before.

**Checkboxes:** while you edit the text, click a box to tick or untick it. It is saved like typing and is one step of Undo while you edit.

**In a quote:** Enter adds a line to the quote; Enter on an empty line, or Backspace at the start of its first line, takes that line out of the quote.

**Over a selection that crosses blocks:** in a text with blocks, typing, pasting, Enter, Backspace, Delete and an input method replace the selection whatever it starts in, ends in or crosses, and leave the caret after what came in. The two ends become one line of the kind the selection started in, where it started: select from the start of a code block to the start of an italic line, type `XYZ`, and the code block holds `XYZ` followed by that line's words as plain code; from a code block into a quote, the quote's other lines stay quoted. When the selection starts in an ordinary line and ends inside a code block, the rest of the code's first line joins that line and its later lines stay a code block. A replacement whose result could not be saved (a numbered list after it would have to start past 999,999,999) does nothing at all: the text and the selection stay as they were. A text without blocks behaves exactly as before.

**In a code block:** Enter is a line break of the code. Press Enter twice at the end to leave it. Backspace at the very start turns the code back into ordinary lines. Code lines wrap anywhere, in every box, so a long line of code never widens the box.

**A divider:** Backspace at the start of the line after it, or Delete at the end of the line before it, removes it.

**The panel:** under Style there is an **Inline code** button. A row of block buttons holds **Bulleted list**, **Numbered list**, **Checklist**, **Quote**, **Code block** and **Divider**. They work like the heading buttons: while you edit, on the lines the selection touches (with only a divider selected, they do nothing); on a selected box, on every line, an empty last line included, as one undo step. A block button changes the lines concerned and no others. It is shown pressed when every one of them is already in that block, and pressing it then takes every one of them out of it, nested lists and quotes inside quotes too; otherwise pressing it puts every one of them in it (a list of another kind becomes this kind for those lines). Lines you did not select keep exactly the lists, quotes and code blocks they were in, and a numbered item you did not select keeps the number it shows. Selected lines next to each other that end up in the same kind of list at the same level share one list, lines nested under an item between them included: `Review`, then a numbered list of `Album` and `Track`, all selected, Numbered list gives one list numbered 1 to 3, and a bulleted `Album` with a nested `Track`, then `Cover`, becomes `Album` 1 and `Cover` 2 with `Track` nested as 1. A divider inside a list item or quote goes with it: one inside the selection, or inside an item (or quote) whose lines are all selected. A list next to them is taken in only if it is selected too. A press that would need a numbered list to start past 999,999,999 does nothing, like any change past a stored limit. Each press, and each click on a checkbox, is one step of Undo while you edit, and Undo straight after a press gives back the text exactly as it was stored. **Divider** goes in at the caret, so it works only while you edit.

Marks, fonts, headings, alignment, colour, font size and scaling work inside every block, except that a code block holds plain text in the Mono font: with only code lines selected, Bold, Italic, Underline, Strikethrough, Inline code and the font buttons are greyed out (their tip says why), their keys do nothing and no font is chosen for what you type there; over a selection that also covers other lines, they change those lines only. Font size, alignment and colour work on code as on any text. Undo after you leave takes back the whole edit, blocks and all.

A command that would nest lines deeper than a text can be stored (six levels: a list in a list in a list, and so on) does nothing, on a selected box as while typing. Pasting into a code block pastes plain text: the clipboard's own, or the words of its formatted text. A paste with no text in it at all changes nothing.

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
- A text's row follows what you type. While a text is empty it is not listed, because an empty text is never kept. A text that holds only a divider or a ticked checkbox is listed as `Text`.
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

- **Boards saved by the previous build (milestone 1) open as they are.** Opening writes nothing. A board without frames or rich text cards keeps being saved in the old format.
- **The first save of a board that contains a frame upgrades the database** in the same step that writes the board. From then on the previous build can no longer open it. This is deliberate: an old tab would otherwise silently drop the frames. There is no backup and no way back to the old build for that board.
- **Two tabs on one board:** a tab never overwrites a board that another tab has changed since it loaded or last saved. It becomes read-only with a Reload button, and whatever it had not yet saved is not saved.
- **Text formatting is stored inside each text**, in optional fields that are left out when they have their default, so a plain text is stored exactly as before and formatting needs no database change. A malformed formatting field is dropped when the board loads instead of making the board unreadable. The previous build shows formatted text plain and drops its formatting the next time it saves that board.
- **Lists, checklists, quotes, dividers, code blocks and inline code** are stored in a newer format. The first save of a text that uses one upgrades the database in the same step, as the first frame does. From then on, builds from before this one cannot open the board, even after those blocks are gone. A text that goes back to plain lines and headings is stored in the old form again.
- **A fixed height or paper from a later build** is stored in the same newer format, and this build cannot make either yet. It reads them only to keep them safe: a board that has one opens read-only and empty, with the same message as a board saved by a newer version, and nothing in it is changed or deleted.
- A card containing something this build does not recognise at all, such as a kind of block added after it, makes the board unreadable here: it opens read-only and stays exactly as stored.
- If another tab holds the database while a frame is first being saved, the save fails after a few seconds with a Retry; close the other tab and retry.

### Known limits

- One board per browser profile and origin.
- Until a board has its first frame or text with blocks, an open tab of the previous build can still overwrite it or prune its unused images, as it always could. This build reports the conflict instead of overwriting back, and re-stores any image bytes that are missing the next time it saves.
- Image bytes are stored as uploaded (no downscaling) and are also kept in memory for the session, so that undo can always bring an image back; very large images are limited by browser storage quota, and a failed write is reported in the header.
- Something sitting inside a frame without belonging to it looks the same as something that does. The item count and "Select with contents" tell you which is which.
- A new text belongs to a frame based on the centre of its box. A click creates a box ten font sizes wide, so a short note near the right edge can be loose even when its words are inside. Drawing a box lets you place its centre. Its frame is decided again when you first stop typing, so overflow can move the centre below the frame. You can move or resize the box afterwards. Whether a new text should keep the frame it started in is an open design question.
- Fonts are named choices (Sans, Serif, Mono, Handwritten, Display) drawn with fonts already on the machine, so the exact typeface, and where lines wrap, can differ between machines.
- A heading belongs to a line, and editing carries each line's level over rather than guessing it from the text. Enter at the end of a heading starts a normal line; Enter in the middle of a heading leaves two headings; Enter at the start of a heading leaves an empty heading line above it. A heading line whose characters are all deleted stays a heading, so what you type there next is a heading too. Joining two lines keeps the level of the line the join starts in: Backspace at the start of a normal line under a heading makes it part of the heading, and Backspace at the start of a heading under a line with text makes it normal text (not bold), except that a heading joined onto an empty line stays a heading. Typing next to a bold character is bold (unless you turned bold off at the caret first). Text copied in Yuriful, or from a web page, keeps its bold, italic, underline and strikethrough when you paste it, so text copied from a heading arrives bold at the normal size; it never brings its own size, colour, font or heading level, and takes the font of the place you paste it. Plain text (from a text editor, or pasted with formatting removed) takes the formatting of the place you paste it, as typing does. So an unformatted paragraph from a web page pasted next to bold text arrives plain, not bold. A mark chosen with only a caret also applies to text pasted or dropped at the caret before it moves. These choices are provisional.
- A selection that ends just after a line break (at the very start of the next line) does not count that next line for a heading.
- A dragged box breaks a word that would otherwise be too wide at a character boundary, keeping combined characters such as emoji together. A single character wider than the box can still widen it. Older and click-created boxes widen to fit the longest word. Changing back to a smaller font or removing a long word leaves that width in place. Undo or drag a side handle to narrow the box.
- Several selected objects show no formatting controls, even if they are all texts.
- Dragging selected words from one text box into another does not work: drag them within their box, or cut and paste them.
- While you edit a text, Undo does not step back a change to the whole box's size, alignment or colour: leave the text and use Undo there. That takes back the whole edit in one step. The exception is an ordinary text that had words in it when you changed its font size, and that you kept working in before leaving: the first Undo takes back what you did after the size change, the second the rest (see Undo after you leave).
- Pasting plain text keeps three oddities of the earlier canvas, on purpose until it is decided whether to change them: two lines pasted right after a bold letter that has plain text after it also make that plain text bold; two lines pasted just before a bold letter lose that letter's bold; and two or more characters pasted at the start of a line take no formatting, while a single character takes the formatting of the one after it.
- The caret follows the browser's rules. A click past the end of a wrapped line puts the caret after the space where the line wraps, and a click within about 5 px above the boundary between two lines lands on the lower line. For the same reason, a double-click, or a press on a side handle, at the middle height of a two-line text can pick the other line.
- With an input method (such as a Japanese or Korean IME), the text you are composing shows the formatting of the text beside it until you commit it, and then takes the formatting you chose; a formatting button pressed while a candidate is open does nothing; for Undo while you edit, compositions are grouped as typing is (one that starts within half a second of a change next to it joins that change's step); and Redo puts the caret back exactly only when the redone text is identical. Input methods have been tried only in Chromium on Windows, through the browser's testing interface, not with a physical IME or on a Mac.
- On a board saved by an earlier build, a line that only just fits can wrap a word earlier or later than it did, because text is now laid out by the browser rather than drawn by the canvas library; words in Arabic script are the most likely to move. The box's position, width and frame are never changed by this. Text is smoothed by the browser, so up close it looks slightly different from before. A very long text is drawn a few pixels shorter than before (about 3 px over 240 lines), and an underline is not drawn under a tab.
- Alt-dragging across covered text that you selected from the list and leaving the box through its top edge selects back to the start of the text; a Shift+click in the space just below a box can land one character off; a press exactly where a selected word's highlight ends starts a new selection instead of dragging the word; and a drag of a selected word with Shift, Ctrl or Alt held does what the browser does.
- A caret key pressed in the very first instant after opening a text can be ignored when the computer is heavily loaded. The text and what you see still agree.
- The frame tour draws a frame's text into a picture, which has been checked only in Chromium browsers (Chrome, Edge). If a text cannot be drawn into the picture, the tour shows the frame without it; the text stays on the board.
- Images that can animate (GIF, animated PNG or WebP) show their first frame.
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
- Pasting keeps today's rule for now: blocks never come with a paste. A list, quote or code copied from a text arrives as plain lines, and pasted Markdown markers such as `- ` stay as they are. Plain text pasted into a text that has blocks takes the formatting of the place it is pasted, without the three oddities listed above, which apply to texts without blocks only.
- On a keyboard where the backtick is a dead key (it waits for the next key), the backtick arrives as composed text, so `` `code` `` and ```` ``` ```` stay as typed. Use the panel's **Inline code** and **Code block** buttons instead.
- In a centred or right-aligned text, list markers and checkboxes stay at the left of their items while the words move.
- Numbers of three digits or more reach past the left edge of the text.
- Backspace at the start of a line just after a list moves that line into the list as its last item.
- The block buttons sit in one unlabelled row (their names show on hover). When the panel on the right does not fit above the layer list, it scrolls inside itself so that the list keeps its header and two rows; while it scrolls, a hover tip near its edge is cut off.
- Select all and Delete leaves a divider at the start of a text, or a ticked checkbox, behind, because they are not text. Press Backspace on the empty line that is left: it removes the divider before it, or takes the line out of its checklist.
- Enter on an empty item of a list nested directly inside a checklist item (or the other way round) adds an empty line to the outer item, rather than a new item of the outer list. Which it should do is an open question.
- Leaving a new text that you emptied again (a list marker typed, or a letter typed and deleted) saves the board once more, unchanged.
- When a list button takes a line out of a list item that an unselected line nested under it also belongs to, that item stays behind for the unselected line and shows a marker with the nested list beside it.
- An input-method composition that would take a text with blocks past 500,000 characters is taken back as soon as it ends (only that composition: what you typed before it stays, and Redo does not bring it back). While its candidate is still open, the board saves the text as it was just before it, and if the edit ends first (the board goes read-only, for example), the composition is taken back then.
- In a text without blocks, an input method composing over a selection can take two Undo steps to take back: one for the selection it replaced, one for what it composed (as before).
- Enter over a selection that empties a nested checklist or list item whose parent item has no line of its own takes the item out and leaves an empty line below the caret, instead of moving the caret onto a new line.
- When a numbered-list press joins selected lines with the start of a numbered list whose later items you did not select, those items keep their numbers in a list of their own, so a number can show twice (1, 2, then 2 again). Whether they should be renumbered instead is an open design question.
- A touch or pen press on a greyed-out panel button still takes the keyboard from the text you are editing (a mouse press does not).

## Testing

```sh
npm run lint && npm run typecheck && npm test && npm run build

npm run test:e2e:install   # once: downloads Playwright's bundled Chromium
npm run test:e2e           # starts its own dev server on :5199 and runs e2e/*.spec.ts
```

- **Unit tests** (`src/**/*.test.ts`, Vitest) cover the pure model (documents, rich text, ownership rules, scale limits, hit geometry), history, persistence (revision tokens, the database upgrade, asset presence, with `fake-indexeddb`), keyboard handling, crop, Fit, Fill and replace geometry, and the `Editor` state machines (hydration, gestures, frames, layers, locking, crop mode, Fit and Fill, replacing an image) on a small fake of Fabric, since jsdom has no canvas.
- **e2e tests** (`e2e/`, Playwright) run the real app and real IndexedDB in a real browser: `hydration.spec.ts` (nothing is editable or saved before the board has loaded; a board that cannot be restored is read-only and untouched), `gestures.spec.ts` (what a save sees during a drag, cancelling, mouse buttons, the single scale factor), `frames.spec.ts` (drawing, hit testing, ownership, carrying, resizing), `layers.spec.ts` (selecting covered objects from the layer list and Alt-dragging them, reordering, multi-selections built from the list, leaving a text edit, the panel's place on screen), `locking.spec.ts` (presses, marquees and Shift-click passing through locked things, a locked member travelling with its frame, the three ways to lock, undo, save and reload), `images.spec.ts` (cropping by handles and by moving the box, on rotated and scaled images, proving with canvas pixel samples that the kept pixels do not move; cancelling; what a save and a reload see mid-crop; Fit and Fill; frame belonging; a cropped image in a multi-selection), `replace.spec.ts` (replacing a picture through the file chooser keeps the box, owner and stacking, with pixel samples of the new picture; undo, reload and which picture files stay stored; a target deleted or locked while the dialog is open), `storage.spec.ts` (opening a milestone 1 board, the upgrades, two tabs, rich cards from a later build), `writing.spec.ts` (lists, checklists, quotes, dividers and code typed for real, Tab in lists, what is kept, the storage upgrade, that entering and leaving an edit moves nothing, what the page and a frame preview paint, transforms, captions and a board going read-only mid-edit), `text.spec.ts` (formatted text drawn, saved, scaled, undone and typed into), `formatting.spec.ts` (the panel's text controls and `Ctrl/Cmd+B`, `I`, `U` on a range, at a caret and on a whole box), `texttool.spec.ts` (dragging out a text box with the Text tool, and the click that still gives the default box) and `typing.spec.ts` (the typing shortcuts typed for real, what stays literal, Backspace and `Ctrl/Cmd+Z` to undo one, and that typing goes on normally afterwards). What the page shows is checked on composited screenshots. `interleaving.spec.ts`, `dom-editing.spec.ts` and `dom-preview.spec.ts` run real key presses and pointer actions on the app and compare what it saves, records and shows with what the earlier Fabric canvas did for the same actions, and `scene-layer.spec.ts` compares the drawn text with it line by line. That canvas is gone: what it did was recorded once by running it, before it was removed, and is kept as frozen references in `e2e/fabric-reference/` (and `src/editor/testing/fabric-reference/` for the unit tests). They were recorded in Chromium on Windows, so on another platform the comparisons that measure text can fail on the fonts alone. `text-engine-parity.spec.ts` compares the text engine edit by edit with a frozen copy of that canvas's text code (`src/editor/testing/fabricTextOracle.ts`). Fixtures are generated in code, including boards written by a frozen copy of the previous build's storage code; each test gets an isolated browser context, so it never touches your own profile or data.
- Use a browser already on your machine instead of the bundled one with `PW_CHANNEL=msedge` or `PW_CHANNEL=chrome`; change the port with `E2E_PORT`.
- Failure traces and screenshots go to `test-results/` (git-ignored).

## Keyboard shortcuts

Shortcuts never fire while you are typing in a field or editing text, except `Ctrl/Cmd+B`, `I`, `U` in a text you are editing, and `Backspace` straight after a typing shortcut (see above). In a text you are editing, Undo and Redo step through that text (see Formatting text). While a drag, resize, frame or text box is in progress only `Esc` and the zoom keys respond. While cropping only `Enter`, `Esc`, the zoom keys and `Space` respond.

| Key                         | Action                         |
| --------------------------- | ------------------------------ |
| `V` / `H` / `T` / `F` / `I` | Select / Hand / Text / Frame / Add image |
| `Space` (hold)              | Temporary hand                 |
| `Ctrl/Cmd+Z`                | Undo (in a text you are editing, one step of that text) |
| `Ctrl/Cmd+Shift+Z`, `Ctrl+Y`| Redo (likewise)                |
| `Delete` / `Backspace`      | Delete selection               |
| `Ctrl/Cmd+A`                | Select all                     |
| `Ctrl/Cmd+D`                | Duplicate the selection        |
| `[` / `]`                   | Send backward / bring forward (frames stay behind content) |
| `Ctrl/Cmd+[` / `]`          | Send to back / bring to front  |
| `Ctrl/Cmd+Shift+L`          | Lock the selection; unlock a locked one |
| `Tab` / `Shift+Tab` (in a list item) | Nest the item / move it back out (elsewhere in a text, `Tab` leaves it) |
| `Ctrl/Cmd+B` / `I` / `U`    | Bold / italic / underline: the selected characters (or what you type next) while editing a text; the whole box when one text is selected |
| `+` / `-` / `0` / `Shift+1` | Zoom in / out / 100% / fit     |
| `Esc`                       | Cancel what is in progress (also a crop); otherwise leave the tool, or deselect |
| `Enter` (while cropping)    | Apply the crop                 |
| Double-click an image       | Crop it                        |

Only the primary mouse button edits. The middle button pans. Holding Alt while pressing acts on the selected object even when something lies on top of it (see Layers); without Alt a press goes to the front-most object (inside the box of a multi-selection, to the selection), and a frame's label or outline wins either way. A locked object is never what a press goes to.

## Architecture

- **What you see is page content.** Frame paper, images and text are elements of a scene layer (`src/editor/sceneLayer.ts`), stacked exactly in the board's order, so an image can sit between two texts. Text is laid out by the browser and edited with **ProseMirror** (MIT): one text at a time is live (`src/editor/textSession.ts`, with the text rules in `textRules.ts` and the document schema in `textSchema.ts`), and every other text is static.
- **Fabric.js 7** (MIT) runs a transparent canvas over that layer: each object there is an invisible stand-in that takes selection, handles, hit testing, dragging, scaling and rotating, and the canvas draws frame outlines and labels, selection handles and the box being drawn on top of everything. `src/editor/domScene.ts` keeps the layer in step with the canvas in the same frame. React renders only the chrome (header, toolbar, inspector, layer list) and never touches Fabric objects.
- `src/editor/Editor.ts` is the single bridge: it owns the canvas, the scene layer, history, assets and autosave, and exposes an immutable `EditorState` snapshot through `subscribe`/`getState` (`useSyncExternalStore`). Fabric's event callbacks only record facts; a finished gesture is settled in a microtask after Fabric's own mouse-up handling, and a save during a gesture stores the board from before it. Frame previews are drawn from the same cards as the layer (`src/editor/renderFrameBitmap.ts`).
- `src/editor/FrameCanvas.ts` extends Fabric's canvas for frames (what counts as a hit, Shift-click and marquee rules) and `src/editor/frameLayer.ts` holds the one geometry used both to draw a frame's outline and label and to hit them.
- `src/model/` is pure and unit-tested: document types and validation, the frame ownership rules and scale limits (`frames.ts`), canonical text formatting (`richText.ts`), the rich form of a text and its validation (`textDoc.ts`), crop, Fit and Fill geometry (`crop.ts`), snapshot `History` (with coalescing), layer reordering, viewport math. `src/editor/cropLayer.ts` draws crop mode's box and handles from the same geometry that is hit.
- `src/persistence/` has the IndexedDB store (document and image bytes written in one transaction, guarded by a revision token) and the `Autosaver` status machine.
- `src/input/shortcuts.ts` maps key events to actions and decides when to stay out of the way.

The saved document references images by id; the bytes live in a separate IndexedDB store. Frames have stable ids, names and unrotated rectangles, and each object records the frame that owns it. A text's formatting is stored as character ranges (UTF-16 offsets into its text) and per-line heading levels, and turned into the text engine's document to be drawn and edited (`src/editor/textSchema.ts`); a text without blocks is stored exactly as the earlier canvas stored it. A text with lists, checklists, quotes, dividers or code is stored as a tree of blocks (`blocks`, `src/model/textDoc.ts`), with its plain text beside it. Undo/redo restores objects from serialized snapshots, using already-decoded images, so it is synchronous.
