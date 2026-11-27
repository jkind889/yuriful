# Text formatting milestone: handoff for hands-on QA and final review

For the independent hands-on QA and final review (Astra, coordinated by Dot). The milestone
is **not finished** until that pass is done. Nothing has been pushed, merged or published.

The plan, the defaults and why they were chosen, the integration contract with
`feat/layers-image-tools`, the review log and the open questions are in
[rich-text-plan.md](rich-text-plan.md). The README describes the behaviour to the person
using the app; `AGENTS.md` states the same rules as constraints.

## What to review

- Branch `feat/milestone-2-frames` in the root checkout, local only, ahead of
  `origin/feat/milestone-2-frames` (`698b628`).
- Last code commit: `188a6a8`. Every commit after it changes documentation only.
- Code commits, in order: `b307275` (slice 1), `2210acc` and `42739a3` (its review fixes),
  `f43bb1b` (slice 2), `4dd927b` (slice 3), `0bbbb5c` (slice 4), `a4b921c` (its review
  fixes), `188a6a8` (the repair from the first QA pass, below). `git log 698b628..HEAD
  --oneline` shows them between the plan commits.

## Focused recheck after the first QA pass

The first hands-on QA pass ran at `939f16e` and held sign-off for one finding: bold chosen
with only a caret, then a heading (H1 from the panel, or `# `), "Title", Enter, "Body" left
the body line stored and drawn bold. Repaired in `188a6a8` and cleared by the centralized
reviewer. What to recheck:

- The reproduction in its three modes (control, panel H1, `# `): stored `headings:[1]` and no
  spans; "Body" drawn plain; the panel's Bold pressed and greyed out on the heading line and
  not pressed on the new line.
- The same with `## ` and `### `, and with H1 followed by Enter straight away.
- Other pending marks survive: italic (or underline, strikethrough) chosen together with
  bold before the heading still applies to the heading and to the next line.
- Normal lines are unchanged: bold chosen and typed on a normal line, Enter, more typing is
  still bold.
- Backspace straight after `# ` brings back the typed characters and the pending bold, so
  what is typed next on that normal line is bold.
- A join: bold chosen on a normal second line, Backspace at its start joins it into the
  heading above, type, Enter, type: the last line is plain.
- Accepted consequence, not a defect: going back to Body on the line does not bring the
  dropped bold back; press Ctrl+B again.

The repair touches `pendingMarksAt` in `src/model/richText.ts` and
`dropPendingBoldOnHeading` in `src/editor/Editor.ts` (called from the heading command and at
the end of the `text:changed` handler), plus tests and one phrase each in the README and
`AGENTS.md`. Nothing else changed since `939f16e`.

## Running it without touching the owner's board

- The owner's dev server is usually on port 5173 and serves the working tree to a tab on
  their real board. Do not stop or restart it, and do not use its origin for QA: IndexedDB is
  per origin, so `http://localhost:5173` and `http://127.0.0.1:5173` are the owner's boards.
- For hands-on work start your own server on another port, for example
  `npm run dev -- --host 127.0.0.1 --port 5310 --strictPort`, and use a fresh browser profile
  or a private window. That origin has its own empty board.
- For automated checks use a copy, as `AGENTS.md` prescribes: `git archive <commit> | tar -x
  -C <scratch dir>`, a junction from the copy's `node_modules` to the repository's, the
  copy's `tsconfig.app.json`, `tsconfig.node.json` and `vite.config.ts` edited so the build
  info and Vite cache live inside the copy, and your own `E2E_PORT`.
- The static review build on the Mac is not live source and does not update by itself.

## What was delivered

1. **Formatting on text.** Bold, italic, underline, strikethrough on a selected range while
   editing, on what is typed next with only a caret, or on the whole box when it is selected
   without being edited. Heading 1 to 3 on whole lines (2, 1.5 and 1.25 times the box's font
   size, always bold). Font (Sans, Serif, Mono, Handwritten, Display), alignment and eight
   colours on the whole box. One selected text at a time.
2. **Keys.** Ctrl/Cmd+B, I, U while editing or with one text selected.
3. **Typing shortcuts.** `# `, `## `, `### ` at the start of a line; a typed closing `**`
   or `*`. Backspace straight afterwards puts the typed characters back.
4. **Text tool drag.** Press and drag on empty canvas to set a new box's wrapping width; a
   click, or a drag narrower than two font sizes, gives the default box.
5. **Storage.** Formatting lives in optional fields of each text, absent when default; no
   database or document version change; a plain text is stored exactly as before.

## Hands-on checklist

Usability and looks are the part automated tests cannot judge. For each item, say what you
did and what you saw.

- **Panel.** Select one text: is every control legible at the panel's width, including the
  white swatch and the five font buttons? Do pressed, half-filled ("mixed") and greyed-out
  states read correctly? Hover tips, including the one on Bold in a heading.
- **Typing keeps going.** While editing, click each kind of control (a mark, a heading, a
  font, an alignment, a colour) and keep typing without clicking back into the text. The
  selected range should stay highlighted and selected.
- **Range, caret, box.** Bold a selected word; with only a caret press Ctrl+B and type; press
  Esc, select the box and press Ctrl+I. Hold Ctrl+B down: it should toggle once.
- **Headings.** Set a heading from the panel on one line and on several; press Enter at the
  end of a heading (next line is normal) and in the middle (two headings); delete a heading's
  text (it stays a heading); join lines with Backspace both ways.
- **Typing shortcuts.** Type `# Title`, `**bold**`, `*italic*` character by character. Then
  the literal cases: `2 * 3 * 4`, `a ** b`, `* item`, `#tag`, `snake*case*`. Paste `**x**`
  (stays literal). Backspace straight after a shortcut, then keep typing.
- **Paste and drag between texts.** Copy a word from a large-font text into a small one and
  from a heading into a normal line: no heading should appear or disappear, bold and italic
  should come along, size, colour and font should not.
- **Text tool.** Drag out a wide box and type a long sentence (wraps at the dragged width);
  click for the default box; drag a few pixels (default box); Esc mid-drag (nothing, tool
  becomes Select); drag a box and leave it empty (nothing left behind).
- **Frames.** Drag a box out inside a frame and type: it belongs to the frame. Move the frame:
  the text travels. Make an owned text much taller with headings: it still belongs. Move a
  frame over a loose text: it must not pick it up. "Select with contents" and scale from a
  corner: the frame, the text's size and its headings scale together.
- **Undo, redo, reload.** After each of the above: one undo step per edit, exact redo, and
  the same board after a reload. Watch the header's save state.
- **Other shortcuts stay out of the way.** While typing, `V`, `T`, `F`, `[`, `Delete` and
  the rest type characters or edit text; Esc and Tab leave the edit.

### One realistic sitting

Adapt to what is delivered; the lock and layer steps apply only once the two branches are
integrated with the owner's authorization.

1. Drop in several inspiration images and overlap them.
2. Add a note: drag out a text box, type a heading with `# `, a line with `**bold**` and
   `*italic*`, then change the font, alignment and colour from the panel.
3. Draw a frame; move the note and one image into it; leave other images loose; move the
   frame and check that only what belongs to it travels, and that formatting the note never
   changes what it belongs to.
4. (After integration) reorder from the layer list, lock an image and the note, and check the
   locked note cannot be formatted, edited or resized; unlock it and format it again.
5. (After integration) replace, crop or fit an image; the note and frame are untouched.
6. Undo and redo through the whole sequence; reload; confirm the board looks the same and
   take a screenshot for the record.

## Known limits worth checking rather than rediscovering

All of these are in the README's "Known limits"; they are behaviour kept on purpose or left
for the owner, not bugs to file.

- A new text's frame is decided by the centre of its box, at creation and once more when its
  first edit ends, so a tall text started near a frame's bottom edge can end up loose.
- A box that widened for a long word, a wider font or a heading does not narrow by itself
  (undo and the side handles do). A long word typed with its markers can leave it a little
  wider than bolding from the panel would.
- Ctrl/Cmd+Z while typing is the browser's own undo: it does not restore a heading level and
  cannot take back a typing shortcut. The Undo button is disabled until the edit ends.
- Dropping dragged text into a centred or right-aligned text can shift its box.
- Fonts come from the machine, so typefaces and wrapping can differ between Windows and Mac.
- Formatting controls appear for one selected text only.
- At zoom 4 the font size stops at 12, so a drag must be about 96 screen pixels wide before
  it counts as a dragged width (it is 48 at zoom 1).

Open questions for the owner are listed in the plan: bundling fonts, whether a new text should
keep the frame it was started in, Undo during an edit, Ctrl versus Cmd on macOS, formatting
several texts at once.

## Test evidence

Run by the coordinator on `188a6a8` in the root checkout (Windows 11, Playwright's bundled
Chromium, e2e server on `127.0.0.1:5199`):

| Check | Result |
| ----- | ------ |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | 19 files, 569 tests passed |
| `npm run build` | succeeded |
| `npm run test:e2e`, first run | 175 passed |
| `npm run test:e2e`, second run | 175 passed |

Baseline before the milestone (`698b628`): 347 unit tests and 70 Chromium tests. The new
real-browser specs are `e2e/text.spec.ts`, `e2e/formatting.spec.ts`, `e2e/typing.spec.ts`
and `e2e/texttool.spec.ts`; the unit tests are beside the code they cover.

The independent reviewer ran the same gate on `188a6a8` in its own copy on port 5245 with the
same counts, ran the first QA pass's three reproduction tests unchanged (all pass), added its
own probes, and confirmed that named deliberate breaks fail tests. Before the repair, on
`a4b921c` and `939f16e`, the counts were 559 unit and 167 Chromium tests.
Per-slice findings and how each was handled are in the plan's review log.

Not run, by anyone: Firefox or WebKit; the Edge and Chrome channels; macOS; a real input
method (only Chromium's simulated composition); real non-US keyboard layouts (AltGr was
simulated); touch. Verified by hand by the reviewer but not pinned by a committed browser
test: the board going read-only in the middle of a text edit after a typing shortcut, and
during a Text-tool drag.

## Screenshots available

Kept outside the repository. Astra captures the final visual evidence separately.

- Panel box: one text selected as a box, with the
  formatting panel.
- Panel edit: a text being edited with a range
  selected, with the panel.

Both were taken during slice 2, before the "mixed" button state was restyled as a half-filled
button, and before slices 3 and 4. They show the panel's layout, not the final details.

From the first QA pass at `939f16e` (evidence available separately): `journal.png`, `inspector.png`, `pending-bold.png`
(the defect before the repair), and its probe specs `astra-heading-matrix.spec.ts`,
`astra-heading.spec.ts`, `astra-probe.spec.ts`, `astra-range.spec.ts`.

## Who did what

Coordinator: Claude Fable 5.2 (planning, briefs, deciding each review finding, checks,
commits). Implementation and independent review: Claude Opus 5.5 delegates only. Every
delegate run's task record shows `executedModel: claude-opus-5-5`; no other model wrote or
reviewed code. No reviewer wrote code.
