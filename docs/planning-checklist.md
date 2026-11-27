# Planning and running a milestone

A checklist for the agent that writes a milestone plan, briefs implementers and triages reviews. Read it before doing any of those.

It comes from a slice-by-slice retrospective with the owner on the writing milestone (23 to 25 November 2026), which took 36 hours where about a day was realistic. Each point says what it prevents. [AGENTS.md](../AGENTS.md) holds the rules that always apply; this file is how to plan so that following them is cheap.

## Before the plan is approved

1. **Record the old behaviour first.** For work that replaces something that already ships, save what the old code produces across a grid of every gesture against every kind of object, before building the replacement. Hand that recording to every implementer as the target. Building the existing tests into the grid is not enough: a recording only knows the scripts it was given. *Prevents:* unwritten behaviour of the old code being found one review round at a time.
2. **Measure every number.** A spike measures each number the plan copies from a setting, as well as its yes-or-no claims. *Prevents:* a guessed line spacing that would have shifted every text on the board.
3. **Write the grid.** For each new behaviour, write one table: every input (type, paste, Enter, Backspace, Delete, compose, each button) against every shape of selection (inside one line, across lines of one kind, across kinds). Each cell gets a numbered rule. *Prevents:* a plan that describes only the happy path, so that every review finds another corner.
4. **List every new surface.** A margin, a scroll bar or a handle gets a line for each input that can reach it: click, drag, double-click, Shift+click, wheel. *Prevents:* a behaviour nobody specified being patched round after round.
5. **Show the owner the judgement rules as examples.** A rule about what a person expects (how pasted track numbers renumber, where a tick goes) goes to the owner as about ten before-and-after examples on realistic content, before any brief goes out. Mechanical rules (no character is lost; one undo restores the record) do not need this. *Prevents:* the coordinator inventing product rules alone and getting them wrong.
6. **Ask the owner: coarse or exact?** Where a feature guesses what the person meant, there is usually a coarse rule and an exact one. Put the choice to the owner with three answers: if the rule guesses wrong, does the person see it; can they fix it in a keystroke or an undo; does the exact version mean parsing someone else's grammar or a large grid of cases? Coarse suits a visible, cheap mistake; exact suits a silent or permanent one, or one met on every use. *Prevents:* review rounds spent on the edges of a rule that did not need to be exact.
7. **Write the stopping rule.** A slice is done when a review reports no fault a person would meet in ordinary use, and nothing that loses work, crashes or leaves a board unsavable. What remains is recorded under "Known limits" in the README. *Prevents:* looping until a reviewer runs out of findings.
8. **Ask whether to start narrow.** Before a format is stored, ask the owner whether the feature should allow only the shapes a person would actually make, and widen later. Allowing more never breaks a stored board; allowing less always might. This is the owner's decision each time.
9. **Price each option, then let the owner choose.** When the owner picks between a smaller and a bolder option, say in a line what each adds to review: new cells in the grid, a new surface, someone else's grammar to parse. This sizes the work; it is not an argument for the smaller option. The owner often chooses the bolder one on purpose, and the plan then gives it its grid, its rules and its coarse-or-exact choice. *Prevents:* a bold choice being built on a plan sized for the small one.

## In every brief

10. **Reuse before writing.** Find the code that decides a rule today. Call it if it is a plain function; move it out unchanged if it is tangled in code being removed; write new logic only for behaviour that does not exist. When the browser decides something (where a line breaks, where a row ends), ask it with a measurement of the thing itself. Have the implementer report which rules were reused, moved and new. *Prevents:* a second copy of a rule that then disagrees with the first.
11. **Tests of the rules come first.** The paired comparison or the randomised test of the numbered rules is built before the feature. The implementer sweeps it over 200 seeds before any reviewer starts. *Prevents:* the reviewer being the first to see what a test would have shown.
12. **One mechanism per family of inputs.** Ask for one piece of code under all the inputs that share a rule, instead of a fix in each handler. *Prevents:* a fix in one handler breaking the next.
13. **Nothing remembered that the event in hand can decide.** If a rule needs remembered state, list everything that clears it; better, restate the rule so it reads the current event. *Prevents:* state that goes stale in ways a reviewer finds one at a time.
14. **Keep a build under about 1,500 lines.** Split the slice if it would be larger. *Prevents:* reviews too large to finish in one round.
15. **Prove migrated tests can still fail.** An implementer who moves a test onto new ground breaks the app on purpose to see the test notice.

## Running the work

16. **One checkout per editing agent.** The coordinator merges and runs the full gate on the merged commit.
17. **Do not stack on an unsettled slice.** A slice does not start on top of one whose review findings are still open. A slice in an unrelated area (no shared files, no shared behaviour) may run alongside it.
18. **Machine-wide tests run alone.** The clipboard is shared by the whole machine: a test that pastes cannot run beside anything else that pastes.
19. **Second identical failure: switch or ask.** When a provider or tool fails the same way twice, switch to another route or ask the owner. Do not retry a third time.
20. **Send a "Decisions I made for you" note at every slice boundary.** One line per decision, saying what it changes for the person using the canvas. Small decisions are reported and work goes on. A medium or large decision waits for the owner's answer: one that changes what a person sees or does in ordinary use, is hard to undo once boards store it, adds or removes scope, or departs from the plan. While waiting, carry on with work that does not depend on the answer and start nothing that builds on it. *Prevents:* a dozen decisions waiting at the end, and hours spent on a goal the owner would have relaxed in a sentence.

## Reviewing and stopping

21. **Writer first, attacker second.** Brief the first reviewer to do the real job (write an album review on the board). Brief the adversarial reviewer after that.
22. **Label every finding A or B from the first round.** A: ordinary use, or lost work, a crash or an unsavable board. B: an unusual sequence, size or device, or a text at a storage limit. Fix A. Dismiss B with a one-line reason unless the fix is nearly free or the finding risks lost work.
23. **Price a fix by the round it triggers.** A three-line fix still costs a review round of thirty to sixty minutes.
24. **One round on a commit that changes only tests or documentation,** unless the reviewer shows an app fault the tests would miss.
25. **Read every failing seed** before calling it test noise.
