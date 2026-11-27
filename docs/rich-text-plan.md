# Text formatting milestone: plan, decisions, progress

Status: implemented and independently reviewed on `feat/milestone-2-frames` (local commits,
not pushed); awaiting a further hands-on QA and final review before it counts as finished.
The owner asked for this milestone ("flesh out
the text before publishing frames") and for work to start without a second approval round, so
the defaults below are the coordinator's and are **provisional until the owner has reviewed
them**. Anything marked "open question" is deliberately left for the owner.

Nothing here changes a settled frame, transform or storage rule in `AGENTS.md`.

## What the person using the canvas gets

1. **Formatting on text.** Bold, italic, underline and strikethrough on a selected range of
   characters, or on the whole box when the box is selected without being edited. Heading 1, 2
   and 3 on whole lines. Font, alignment and colour on the whole box.
2. **Markdown-like typing shortcuts.** While typing: `# `, `## `, `### ` at the start of a line
   turn the line into a heading; `**word**` becomes bold; `*word*` becomes italic. The markers
   disappear when the shortcut fires.
3. **Fonts.** A short list of font choices that work without downloading anything.
4. **Sizing a text box before typing.** With the Text tool, drag out a box; its width becomes
   the wrapping width. A plain click still gives the default box.

Not in this milestone: lists, links, quotes, code blocks, tables, per-range fonts, sizes or
colours, a fixed box height, importing or exporting Markdown source, pasting rich text from
other applications, duplicating or copying whole objects (the app has no such command today),
publishing.

## Defaults, and why

- **Live shortcuts, not stored Markdown.** The stored text never contains the markers; a
  shortcut is only a faster way to press the same button. Text typed or pasted with markers
  already in it (a paste, or a marker completed by anything other than typing its last
  character) is left exactly as it is. This keeps the canvas, the saved board and undo free of
  a second "source" representation.
- **Literal typing stays possible.** A shortcut fires only when the closing marker is typed,
  the marked text is not empty and has no space just inside either marker, and the opening
  marker starts a word; so `2 * 3 * 4`, `a ** b` and a lone `#` stay as typed. `# ` only fires
  at the very start of a line. Pressing **Backspace straight after a shortcut fired** puts the
  literal characters back. Nothing fires during IME composition.
- **Ranges and boxes.** Bold, italic, underline, strikethrough: the selected characters while
  editing; with only a caret, the choice applies to what is typed next; with the box selected
  and not being edited, the whole box. A whole-box toggle turns the mark on unless everything
  already has it. Headings are a property of a line (a paragraph between line breaks): the
  lines the selection touches while editing, every line when the box is selected.
- **Headings.** Heading 1, 2, 3 are 2, 1.5 and 1.25 times the box's font size, and always
  bold. They scale with the box. Pressing Enter at the end of a heading starts a normal line.
- **Font, alignment, colour are per box**, not per range. That is the bounded version; per
  range can come later without changing the stored shape of what exists.
- **Fonts are named choices backed by fonts already on the machine** (Sans, Serif, Mono,
  Handwritten, Display), each a CSS fallback chain. No font files are bundled and nothing is
  fetched, which keeps the app local-only and avoids a font-loading step during board load.
  The board stores the choice's id, not a font name, so a later build can back the same ids
  with bundled font files without migrating boards. Consequence: the exact typeface, and so
  where lines wrap, can differ between machines (already true of today's system font).
- **A dragged text box sets the wrapping width only.** A text box is still as tall as its
  text; the dragged height is a guide and is not stored. A drag shorter than the click
  threshold, or narrower than two font sizes, is a click and gives the default box (ten
  times the font size wide) at the press point. (The first version of slice 4 gave such a
  narrow drag a box two font sizes wide, in which every word wrapped onto its own line; the
  review showed a slightly wobbling click produced it, so the default was changed.)
  Esc, a window blur or the board going read-only cancels the drag like any other gesture.
  Belonging is unchanged: the centre of the box decides, at creation and once more when the
  first edit ends, so a tall text started near a frame's bottom edge can still end up loose.
- **Keyboard.** Ctrl/Cmd+B, I, U while editing a text act on the range or caret; with a text
  box selected they act on the whole box. They are claimed only in those two situations.
  Every existing canvas shortcut still stays out of the way while a text is being edited, and
  native editing keys (typing, selection, clipboard, Esc and Tab to leave the edit) are not
  touched.
- **History.** As with typing today: formatting changed during an edit is saved as it happens
  and becomes one undo step when the edit ends. Formatting applied to a selected, non-edited
  box is its own undo step at once.

## Stored shape

`TextRecord` gains optional fields. A field is absent when it has its default, so a plain
text is stored byte for byte as before, and equality ("a commit that changes nothing records
nothing") stays exact.

| Field      | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `font`     | Font choice id. Absent: Sans.                                            |
| `align`    | `center` or `right`. Absent: left.                                       |
| `color`    | `#rrggbb`, lower case. Absent: the default ink.                          |
| `spans`    | Marks on character ranges: `{ start, end, bold?, italic?, underline?, strike? }`, offsets in UTF-16 units of `text`, sorted, non-overlapping, merged, each with at least one mark. Absent: none. |
| `headings` | Heading level (0 to 3) per line of `text`, trailing zeros trimmed. Absent: none. |

- No database or document version change. Both stored versions (1 and 2) carry the optional
  fields. An older build that opens such a board ignores the fields and would drop them on its
  next save; old-build compatibility is not a requirement (owner's instruction).
- Loading is lenient about formatting only: a malformed formatting field is dropped or trimmed
  to something valid, like a dangling frame owner, instead of making the board unreadable.
  Everything else about a text record stays strict.
- The scale limits keep applying to the box's font size (6 to 400 px), computed once per
  gesture from pre-gesture values. A heading is drawn larger than that size.

## How it is built

- `src/model/richText.ts` (pure): canonical form of spans and headings, mark toggling and
  range queries, the heading scale, the font choice ids, and the typing-shortcut matcher.
- `src/editor/objects.ts`: one function writes a text record's formatting onto a Fabric
  textbox (per-character styles; a heading line carries a font-size style on every character,
  and on a placeholder entry when the line is empty), and `toRecord` reads it back. Fabric
  stays the live source of truth while a text is edited; after every text change the editor
  re-derives the canonical formatting and rewrites the styles if they differ.
- `src/editor/Editor.ts`: formatting commands, the in-edit key handling, the typing
  shortcuts, and the Text tool's drag as a draft gesture like the Frame tool's.
- `src/ui/Inspector.tsx`: the controls. Buttons do not take focus, so an edit keeps its
  selection.

## Slices

Each slice is implemented by an Opus 5.5 worker, checked and committed by the coordinator,
then reviewed by a different Opus 5.5 reviewer before the next one starts.

| # | Slice | State |
| - | ----- | ----- |
| 1 | Formatted text in the document: record fields, validation, equality, writing to and reading from the canvas, scaling, load/save/undo round trips. No controls yet. | done: `b307275`, review fixes `2210acc` and `42739a3`, cleared by recheck |
| 2 | Formatting commands, panel controls, Ctrl/Cmd+B/I/U, range/caret/whole-box behaviour. | done: `f43bb1b`, cleared by review; its nits are fixed in slice 3 |
| 3 | Typing shortcuts (`#`, `**`, `*`), Backspace to revert. (Enter after a heading was settled in slice 1's review fixes.) | done: `4dd927b`, cleared by review; its nits are handled in slice 4 |
| 4 | Text tool: drag out a box. | done: `0bbbb5c`, review fixes `a4b921c`, cleared by recheck |

All four slices are implemented and independently reviewed. The hands-on QA and final review
(Astra, coordinated separately) ran at `939f16e` and held sign-off for one finding, repaired
in `188a6a8`, which is now the last code commit and awaits that QA's focused recheck. See
[rich-text-qa-handoff.md](rich-text-qa-handoff.md) for what to exercise, the known limits
and the test evidence. The milestone is not finished before that recheck signs off.

## Integration contract with `feat/layers-image-tools`

A separate branch, based on `698b628`, adds a layer list, z-order, locks and image
crop/fit/fill/replace. Neither branch merges the other while in progress. This section lists
what this branch touches in shared files and what it relies on, so the eventual integration
can be done deliberately. It is updated as slices land.

Shared files this branch has changed so far (slice 1):

- `src/model/types.ts`: `TextRecord` gains optional `font`, `align`, `color`, `spans`,
  `headings`, plus the `FontId` and `TextSpan` types. `ImageRecord`, `RecordBase`,
  `FrameRecord`, `BoardDoc` and the stored-document types are untouched.
- `src/model/doc.ts`: the text branch of `parseObject` appends the canonical formatting
  fields; `serializeDoc` now copies every object through `withoutUndefined` (any key whose
  value is `undefined` is left out, for images too); `recordsEqual` is replaced by a
  by-value comparison (`valuesEqual`) that descends into arrays and plain objects.
- `src/editor/objects.ts`: the text branch of `createObject` and of `toRecord`,
  `normalizeTextScale`, and new exports for writing and reading a text's formatting. The
  image and frame paths, `Meta` and `SELECTION_STYLE` are untouched.
- `src/editor/Editor.ts`: the `text:changed` handler and `setFontSize` only.
- `src/editor/testing/fakeFabric.ts`: fields and two methods on the fake `Textbox`.
- `e2e/helpers.ts`: optional formatting fields on `StoredObject`.
- `README.md`, `AGENTS.md`: text formatting in the storage, invariant, project-shape and
  known-limit sections.

Contracts the other branch can rely on, and that this branch needs kept:

- An optional record field is absent when it has its default; `serializeDoc` never writes an
  `undefined` key. A plain text keeps exactly its previous keys.
- Scene equality is by value at any depth, so a nested value in a record (a crop rectangle,
  say) does not look like a change on every commit. Canonical form is still each feature's
  own job: two records that mean the same must be built the same.
- No document or database version change comes from this branch. If the other branch changes
  a version, text formatting fields must be carried by every version that can hold a text.
- `objects.ts` remembers each text's last canonical state (text, heading levels, wrap width,
  base size). `toRecord` reads a text's formatting from the Fabric object while its text is
  unchanged since that state, and carries heading levels from it after a text change; a
  heading level is never read from character sizes after a change. Anything that changes a
  text's formatting, base font size or text must go through `writeTextFormatting`,
  `setTextFontSize` or `reconcileTextFormatting`, so that the remembered state stays right
  and headings keep their ratio. A new code path that scales, resizes or rewrites text has to
  do the same.
- This branch does not touch z-order, layer reordering or image records.

Added by slice 2 (formatting commands and controls, `f43bb1b`):

- `src/model/richText.ts`: pure functions for toggling marks, setting headings and reading
  the state of a range, the colour palette, and the `MarkState`, `PendingMarks` and
  `TextAlign` types, all appended after the slice 1 code.
- `src/editor/objects.ts`: `applyTextFormatting` (the one path every formatting command
  writes through) and `selectedRange`; `readTextFormatting` and `reconcileTextFormatting`
  take an optional pending-marks argument.
- `src/editor/Editor.ts`: `SelectionInfo.text` (a `TextFormatInfo`), the commands
  `toggleMark`, `setHeading`, `setTextFont`, `setTextAlign`, `setTextColor`, a private
  `formatTarget()` that all of them go through, a handler for `text:selection:changed`, and
  three `format-*` cases in `run`.
- `src/input/shortcuts.ts`: `format-bold`, `format-italic`, `format-underline` actions,
  `ShortcutContext.textSelected`, and a separate `resolveEditingShortcut` for keys pressed
  while a text is edited. No capture-phase listener was needed: the existing window keydown
  listener handles both.
- `src/ui/Inspector.tsx`: a text section, a `locked` prop (true when the board is read-only;
  the name will meet the other branch's object lock and needs reconciling), and a mousedown
  handler that keeps the panel background from taking focus. `src/ui/Overlays.tsx` passes
  `locked`; `src/ui/IconButton.tsx` accepts `pressed="mixed"`; `src/ui/icons.tsx` and
  `src/styles.css` gain icons and classes only.

Where the lock goes at integration: `Editor.formatTarget()` is the single guard of every
formatting command, and the Inspector's text section is switched off by its `locked` prop.
A lock that keeps an object from being selected also keeps it from being formatted; a lock
that still allows selection has to be checked in `formatTarget()`.

Expected overlap from the remaining slices: the typing shortcuts hook into the
`text:changed` handler, and the Text tool's drag adds a text variant of the draft gesture
used by the Frame tool.

What the other branch has told this one (as of 2026-11-18; their branch does not contain
this branch's changes):

- Their optional `locked` and crop fields are accepted in stored versions 1 and 2, with no
  document or database version change. Together with this branch that makes two sets of
  optional fields in the same versions; neither needs a bump.
- A locked object is skipped by canvas clicks, the marquee and select-all, but can still be
  selected on its own from the layer list, without handles. Every mutation of it is blocked
  until it is unlocked; the one exception is that moving the frame that owns it still
  carries it.

Acceptance case for the integration and for the final QA pass: **a locked text selected
from the layer list must not be formattable.** The `editable && !busy` guards are not
enough, because that object is the active object. At integration every text formatting
command (marks, heading, font, alignment, colour, font size), Ctrl/Cmd+B/I/U, entering a
text edit by double-click, and the typing shortcuts must reject a locked text: nothing on
the canvas changes, no history step, no save. The panel should show its formatting controls
disabled or not at all. This cannot be implemented or tested on this branch alone, since the
lock does not exist here; it is an integration task, to be done only when the owner
authorizes merging the two.

Further points reported by the other branch (2026-11-18), to be preserved when the two meet.
None of them is built or tested here, and none changes this branch's scope:

- **Alt-drag of a covered selected object.** Their `FrameCanvas.findTarget` lets Alt-drag
  move a selected object that something else covers, while a frame's label and outline keep
  their priority. This branch does not touch `FrameCanvas.ts`; the Text tool's drag (slice 4)
  starts only on empty canvas and must not change what `findTarget` returns.
- **Esc with Alt held still cancels.** Their shortcut resolver returns `escape` when Alt is
  down. This branch adds Ctrl/Cmd+B/I/U to `src/input/shortcuts.ts` and a separate handler
  for keys pressed while a text is edited; at integration, check that Esc (with or without
  Alt) still cancels a gesture, and that the in-edit key handler never claims Esc or any key
  with Alt held.
- **Layer-panel focus.** Their layer panel blurs stale chrome focus when it is used, but
  must not blur Fabric's hidden editing textarea while a text is being edited. This branch's
  formatting controls rely on the same thing from the other side: buttons that do not take
  focus, so an edit keeps its caret and selection. At integration, check both directions:
  clicking a layer-panel row while a text is edited ends or keeps the edit deliberately (their
  rule), and clicking a formatting button while a text is edited never ends it or loses the
  selected range.

Concrete names on the other branch for the lock (their commit `9061a0c`, under independent
review there at the time of writing, so names may still change):

- model: `locked?: true` on a record, left out otherwise;
- `src/editor/objects.ts`: `isLocked(obj)`, `setLocked(obj, …)`;
- `SelectionInfo.locked`;
- `Editor.setSelectionLocked` and `Editor.toggleLayerLock`;
- shortcut Ctrl/Cmd+Shift+L.

At integration, the guards of this branch's text mutations (the formatting commands, the
in-edit key handling, the font size command, entering an edit, the typing shortcuts, the
`text:changed` tidy-up path if a locked text could ever receive one) should call `isLocked`
on the text, and the text section of the panel should follow `SelectionInfo.locked`.
Ctrl/Cmd+Shift+L does not collide with anything here: this branch claims Ctrl/Cmd+B/I/U
without Shift only.

### Scenario for the integrated hands-on QA

Once both branches are integrated (with the owner's authorization), the final QA pass should
walk one realistic design-journal board end to end, adapting to what was actually delivered.
This is a test scenario, not implementation scope:

1. Drop in several inspiration images and overlap them.
2. Add a note: drag out a text box, type a heading with `# `, a line with `**bold**` and
   `*italic*`, change the font, alignment and colour from the panel.
3. Draw a frame; move the note and one image into it; leave other images loose; move the
   frame and check that only what belongs to it travels, and that formatting the note never
   changes what it belongs to.
4. Reorder layers from the layer list, lock an image and the note, and check that the locked
   note cannot be formatted, edited or re-sized; unlock it and format it again.
5. Replace, crop or fit an image and check the note and frame are untouched.
6. Undo and redo through the whole sequence; reload; confirm the board looks the same and
   take a screenshot for the record.

## Open questions for the owner

- Whether to bundle font files so that a board looks the same on every machine (matters once
  frames are published).
- Whether a new text should belong to the frame that was clicked in (already listed in the
  README's known limits; unchanged here).
- Whether the Undo button should be usable while a text is being edited. Today it is
  disabled until the edit ends, because an edit is recorded as one step when it ends; inside
  an edit Ctrl/Cmd+Z is the browser's own undo of the typing, which does not know about
  formatting.
- Whether on macOS only Cmd (not Ctrl) should trigger Bold, Italic and Underline, so that
  Ctrl+B keeps its native "move back one character" in a text. Undo already accepts both.
- Whether formatting controls should work on several selected texts at once (today: one).

## Review log

Every worker and reviewer below ran as `claude-opus-5-5`, and no reviewer wrote code.
Reviewers ran their checks in their own copy of the commit on their own port. Slices 1 and 2
used a separate delegate for each implementation pass and each review pass. From slice 3 on,
at the owner's direction, one implementer thread and one reviewer thread (the slice 2
reviewer) are reused for every remaining pass, and the coordinator decides the disposition
of each finding instead of forwarding all of them.

### Slice 1 (`b307275`)

First review, verdict "not clear yet":

| # | Finding | Severity | Disposition |
| - | ------- | -------- | ----------- |
| 1 | A paste or a dropped selection adds or removes a heading (the level was read from the pasted characters' size) | should-fix | Fixed in `2210acc`: a line's level is carried across each edit |
| 2 | A heading's implied bold becomes a stored mark when its characters land on a normal line | nit | Fixed in `2210acc` |
| 3 | A stored text with a lone carriage return loses its marks on the first keystroke | nit | Not fixed: the app cannot write one. Known limit in code comments; `\r\n` pinned by tests |
| 4 | A hostile sparse `spans` list can stall loading | nit | Fixed in `2210acc`: a list longer than its text is dropped |
| 5 | A box keeps width it only needed while a half-tidied line was laid out | nit | Fixed in `2210acc` |
| 6 | README wording about typing behaviour out of date | nit | Fixed in `2210acc` |

Re-review of `2210acc`, verdict "clear after one should-fix":

| # | Finding | Severity | Disposition |
| - | ------- | -------- | ----------- |
| 1 | A paste that leaves the text unchanged still read sizes, adding or removing a heading | should-fix | Fixed in the follow-up commit, with tests for both directions |
| 2 | A drop into a centred or right-aligned text shifts the box (Fabric widens from the left on a drop; predates this work) | nit | Known limit in the README |
| 3 | Ctrl/Cmd+Z while typing restores characters but not a heading level the undone edit changed (predates this work) | nit | Known limit in the README; taking over that key while typing is an owner decision |
| 4 | Select-all then pasting the same number of lines keeps levels by position | not a bug | No change; follows the documented rules |
| - | Test gap: the caret rule was pinned only on the fake canvas | gap | Real-browser test added in the follow-up commit |

Recheck of `42739a3`, verdict "clear to build slice 2 on":

| # | Finding | Severity | Disposition |
| - | ------- | -------- | ----------- |
| 1 | Replacing the line break after a heading with Enter stores bold on the next line's first character | nit / should-fix | Fixed as step 0 of slice 2 (`f43bb1b`), with unit and real-browser tests |

### Slice 2 (`f43bb1b`)

Review, verdict "clear to build slice 3 on", no blockers and nothing at should-fix level:

| # | Finding | Severity | Disposition |
| - | ------- | -------- | ----------- |
| 1 | "Formatting never changes which frame a text belongs to" overstates it for a new text, whose owner is still decided when its first edit ends | nit, docs | Wording corrected to "an existing text" as step 0 of slice 3; the rule is unchanged |
| 2 | The Undo button stays disabled during an edit until the edit ends (already true of typing; more visible with formatting) | nit, existing behaviour | Not changed; open question for the owner below |
| 3 | Holding Ctrl/Cmd+B toggles on every key repeat | nit | Fixed as step 0 of slice 3: auto-repeat is ignored |
| 4 | On macOS Ctrl+B (move caret back) is taken over while editing, because Ctrl and Cmd are both accepted, as for Undo | nit | Not changed; open question for the owner below |
| 5 | A box whose text ends with an empty line shows its heading as mixed, and a whole-box heading also makes the empty last line a heading | nit | Fixed as step 0 of slice 3: a trailing empty line is left out |
| 6 | Heading buttons' accessible names do not contain their visible "H1" label; the disabled Bold button shows two tooltips | nit, accessibility | Fixed as step 0 of slice 3 |
| 7 | Bold stays enabled on a range that is only a line break, where it does nothing | nit | Not changed: harmless |

The reviewer agreed with the worker's judgement calls: a range ending exactly at the start
of a line does not count that line; a choice made with only a caret also applies to text
pasted at that caret; a wider font or heading widens the box and changing back does not
narrow it (known limit; undo restores the width); two quick Ctrl+B presses on a box coalesce
into no undo step; the panel background does not take focus.

### Slice 3 (`4dd927b`)

The slice 3 implementer was cut off by a usage limit part-way and resumed in the same thread
with its uncommitted work intact. Review by the centralized reviewer, verdict "clear to
build slice 4 on", no blockers and nothing at should-fix level:

| # | Finding | Severity | Disposition |
| - | ------- | -------- | ----------- |
| 1 | Bolding a long word by typing `**word**` leaves the box wider than Ctrl+B does, because the box widened while the markers were typed and never narrows by itself | nit | Widths not changed: this is the existing "a widened box does not narrow" behaviour. README known limit extended to name the case (step 0 of slice 4) |
| 2 | One check in the shortcut matcher is redundant | nit | Removed in step 0 of slice 4; no behaviour change |
| 3 | Body on a box does not clear an empty last line that is already a heading | nit | Fixed in step 0 of slice 4: Body on a box also clears it |
| - | Test gaps: pending marks combined with a shortcut, and holding Backspace after a shortcut, were not pinned in a real browser | gap | Both added to `e2e/typing.spec.ts` in step 0 of slice 4 |
| - | Test gap: the board going read-only mid-edit after a shortcut is covered only on the fake canvas | gap | Not added: the reviewer verified it by hand in a real browser (the edit ended, nothing was written, no page errors) |
| - | Observation: the Backspace revert is still offered after a window blur and refocus or a click on the panel background | not a finding | Kept: nothing changed the text or the caret, so it is still "straight after" |

Real-browser evidence the reviewer gathered beyond the committed tests: the canvas text and
the hidden textarea agree after a shortcut and after a revert through Enter, Delete,
Shift+End, cut, arrow keys and paste; an input-method composition straight after a shortcut
or a revert gives the right text; `*` typed with AltGr (reported as Ctrl+Alt), on the numpad
and by key repeat converts, and a key reported as "Unidentified" stays literal.

### Slice 4 (`0bbbb5c`)

Review by the centralized reviewer, verdict "slice 4 is clear", no code bugs:

| # | Finding | Severity | Disposition |
| - | ------- | -------- | ----------- |
| 1 | README and AGENTS.md said a box dragged out inside a frame belongs to it; a tall text started near the frame's bottom edge ends up loose, because the owner is decided again from the box's centre when the first edit ends | should-fix, docs | Wording corrected in the slice 4 fix commit and the behaviour pinned by a real-browser test; the rule itself is unchanged and stays an open question for the owner |
| 2 | A click that wobbles 4 or 5 pixels, or a mostly vertical drag, gave a box two font sizes wide | nit | Default changed in the fix commit: a drag narrower than two font sizes is a click and gives the default box |
| 3 | The old click fallback never runs in a real browser and no test could show its guards work | nit | Removed in the fix commit; the unit tests that fired only a release now fire the press first |
| - | Test gap: an image import finishing during a Text-tool drag was covered only on the fake canvas | gap | Real-browser test added in the fix commit |
| - | Test gap: the board going read-only during the drag is covered only on the fake canvas | gap | Not added: verified by hand by the reviewer in a real browser (draft cancelled, no box, nothing written) |

The reviewer's closing pass over slices 1 to 4 used together (a box dragged out inside a
frame, a heading and italic by typing shortcut, a paste from another text, "Select with
contents" and a corner scale, undo, redo, reload) found nothing wrong.

Recheck of `a4b921c` by the same reviewer, verdict "the milestone's code is clear at
a4b921c", no findings. It confirmed in a real browser at zoom 0.25, 1 and 4 that a drag
narrower than two font sizes gives the default box at the press point and a wide, flat drag
gives the dragged width; that a plain click stores exactly what it did before; and that each
named deliberate break fails both unit and real-browser tests. One observation, recorded as
a known limit in the handoff: the font size never goes below 12, so at zoom 4 a drag must be
about 96 screen pixels wide to count as a dragged width, against 48 at zoom 1.

### Final hands-on QA (Astra) at `939f16e`

An independent hands-on QA and code pass by a different reviewer on a different model. It
confirmed the design-journal sitting, a frame scaled with its contents through undo, redo
and reload, Unicode and joined-emoji underline, cancellation, and the agreement between the
canvas text and the hidden textarea, and ran the full gate clean (559 unit, 167 Chromium).
It held sign-off for one finding:

| # | Finding | Severity | Disposition |
| - | ------- | -------- | ----------- |
| 1 | Bold chosen with only a caret, then a heading (H1 from the panel or `# `), "Title", Enter, "Body": the body line was stored and drawn bold, because the pending bold survived the line becoming a heading | should-fix | Accepted by the coordinator after reproducing it from the QA's evidence. Fixed in `188a6a8`: a pending bold is dropped whenever the caret's line is or becomes a heading (panel, `# `/`## `/`### `, or a join into a heading above); other pending marks are kept; Backspace straight after `# ` still restores the pending bold |

Recheck of `188a6a8` by the centralized reviewer, verdict "the code is clear at 188a6a8",
no findings. It ran the QA's own three reproduction tests unchanged (all pass), added probes
for a pending bold-off with italic, underline and strikethrough kept through a heading, an
input-method composition on a heading line, and the Backspace revert, and confirmed that
each named deliberate break fails unit and real-browser tests. The repair goes back to the
same QA thread for a focused recheck.

One usage limit was hit during the milestone: the slice 3 implementer's first run failed
with the provider's rate-limit error after about twelve minutes and was resumed in the same
thread later, with its uncommitted work intact.

Known limit recorded here rather than in the README (the app cannot produce it): a stored
text containing a lone carriage return is drawn with it as a character, and the first
keystroke turns it into a line break, moving the marks after it down a line.
