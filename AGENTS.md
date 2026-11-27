# Yuriful repository guidance

## The project

Mars wanted a creative tool he'd keep using: a personal-first visual workspace for turning inspiration into creative work. Yuriful is a desktop-first freeform reference canvas. The person using it can arrange images and text on an infinite, pannable, zoomable board, cluster references into optional named spreads, and add notes about what stands out or why it inspires them. It is local-only: no account, server or cloud storage. The board lives in the browser's IndexedDB.

Future ideas, not shipped features or commitments: longer music writeups with the feel of a magazine, blog or zine; styling whole pages or individual frames as part of the work; and linking back to ratings on ReScened. Keep these distinct from current behaviour, approved plans and open design questions.

Explain changes through the experience of using the canvas. Use plain, direct language and concrete examples ("drag a frame over a loose image and it is left behind"). Avoid inflated claims and long inventories of changed files.

## Routine next steps within scope

- When the next step is clear, routine, and something the owner would reasonably want to complete the authorized task, take it without asking again. Make sensible low-risk choices and report meaningful outcomes.
- Ask only when a missing decision materially changes scope, product behavior, risk, cost, or authorization. Questions and read-only requests remain read-only; this rule does not authorize publishing, pushing, merging, deployment, paid providers, sensitive-data sharing, destructive changes, or work outside the request.
- Project skills are checked in under `.agents/skills/` (Codex/T3) and `.claude/skills/` (Claude). Read the relevant skill directly when absent from the catalog. Use `frontend-design` for UI design and `clean-copy` for user-facing strings. Council is opt-in and requires authorized provider/data scope; installation alone never invokes it.
- Read [project skill provenance and inheritance](docs/PROJECT_SKILLS.md). New branches must retain AGENTS.md, CLAUDE.md, and the project skill directories from an approved base containing this setup. Existing branches do not inherit files retroactively: integrate this docs-only commit only when authorized, preserving their newer app-specific guidance.

## Glossary

- **You** means the working agent in repository guidance.
- **The user** means Jova (Mars), the owner and requester, when discussing the work. In product descriptions it means the person using Yuriful, whether that's Mars or someone else. Use **Mars** or **the owner** when the distinction matters.
- **We** means Mars and the agent working together.
- **Canvas** is the freeform editing surface for a board; pan and zoom move the view, not its content. The **board** is the saved document, including objects, frames, title and viewport. This build stores one board per browser profile and origin. Use **canvases** for multiple surfaces in a concept, not to imply this build manages multiple boards.
- **Frame** is an optional named, unrotated rectangle behind canvas content. It clips nothing. A frame can own images and text; ownership is stored and is not the same as visual overlap. A **spread** is a composition arranged together, often in a frame; it is not a separate document type.
- **Transform** is a change to an item or selection's position, size, scale or angle, not to the viewport. A frame can't rotate; resizing a frame alone does not stretch or move its contents; a multi-selection can move and scale proportionally and can rotate only if it contains no frame.

## Researching new ideas

- Think ambitiously when researching features. Go past the safe first answer; question limits we may have assumed, and explore what a bolder solution could make possible. Name real constraints rather than treating every current implementation choice as a permanent wall.
- Ground concepts in Mars's creative workflow and what Yuriful actually does today. Start with the creative job, outline the experience at a high level, and compare it with simpler alternatives on what it helps the person do. Keep assumptions visible; don't invent users, demand, or evidence.
- A concept is not approval to build. Once we choose a direction, consult [README.md](README.md), this guide, the applicable references below, and relevant code before planning implementation. Keep unsolved product choices open until Mars decides.

## Questions before changes

- Questions such as "how could we do this?" or "is this possible?" are requests for discussion, not permission to edit. Explain the options, tradeoffs and proposed approach first, and wait for explicit permission to implement.
- Keep any investigation needed to answer the question read-only.

## Settled decisions and approved plans

- Milestone work follows a plan the owner approved. The plan's stated rules are the authority for user-facing behaviour.
- Do not redefine an agreed rule because a review found an awkward edge case. Keep the rule, pin it with a test, record the edge case under "Known limits" in the README as an open design question, and report it.
- Within the authorized implementation scope, fixing a crash, data loss, or behaviour that contradicts the plan needs no extra approval; report it. This does not turn a question, a request to review or a read-only investigation into permission to edit.
- A change to what a rule *is* needs the owner first. When unsure whether a change redefines a rule or only makes it work as stated, treat it as a redefinition: keep the plan's behaviour and report the alternative.
- The frame, transform and storage rules in [Expected behaviour](docs/expected-behavior.md) are settled. Do not reopen them, and ask only about consequential unknowns.
- A plan says, before work starts, when a slice is done: a review reports no fault a person would meet in ordinary use, and nothing that loses work, crashes or leaves a board unsavable. What remains is recorded under "Known limits" in the README.
- At the end of each slice, before the next one starts, send the owner a short note headed "Decisions I made for you": one line per decision, saying what it changes for the person using the canvas. Small decisions are reported and work goes on. A medium or large decision needs the owner's answer: one that changes what a person sees or does in ordinary use, is hard to undo once boards store it, adds or removes scope, or departs from the plan. While waiting, carry on with work that does not depend on the answer and start nothing that builds on it.
- Where a behaviour guesses what the person meant and could follow a coarse rule or an exact one, ask the owner before the brief goes out. Rules that are judgements about what a person expects go to the owner first, as worked before-and-after examples.

## References to read when needed

- [README.md](README.md): current user-facing behaviour, shortcuts and known limits. Start here to see what a person can do today.
- [Expected behaviour](docs/expected-behavior.md): read affected sections before changing or reviewing gestures, text, frames, transforms, selection, duplication, layers, locks, images, appearance or storage. It also lists current scope exclusions.
- [Engineering reference](docs/engineering-reference.md): project map, lifecycle test checklist and specific review traps. Read before implementing or reviewing interactive or persistence changes; exercise the lifecycle cases that apply before independent review.
- [Planning checklist](docs/planning-checklist.md): what to settle before a plan is approved, what every brief carries, and when to stop reviewing. Read before writing a milestone plan, briefing an implementer or triaging a review.

## Skills

- Check `.agents/skills/` and `.claude/skills/` before planning relevant work and apply only the skills that fit. See [project skill provenance](docs/PROJECT_SKILLS.md) for runtime-specific variants and authorization boundaries.

## Delegation and independent review

- The main agent is the coordinator: it owns requirements, decisions, task boundaries, integration, final verification and the result reported to the owner. Delegate bounded, independent work when it improves progress or review quality; keep small or tightly dependent steps local.
- Use the delegation tools, roles and models actually available in the current session, and preserve the owner's model choices. Subagents report to the coordinator, do not delegate further, and do not mutate Git state. Use at most three at once.
- Before spawning, give each subagent its files, acceptance criteria and checks. Each editing subagent works in its own worktree or checkout, never in a tree another agent is editing; the coordinator merges the results and runs the checks on the merged commit. Run slices in parallel only when their files do not overlap. Do not start a slice that builds on one whose review findings are still open; a slice in an unrelated area may run alongside it. Reviewers do not edit the repository.
- After each committed slice, have an independent subagent review that commit against the plan and the neighbouring code before starting the next slice. Do not simulate a review or substitute a self-review. If no subagent capability is available, say so rather than claiming a review.
- Give the reviewer the actual commit, not a summary of it, and ask for bugs, regressions and test gaps with a concrete failure scenario for each. Ask for correctness, the plan's acceptance behaviour and real-browser evidence first. If you ask a reviewer to break the code on purpose to see whether a test notices, name the few breaks that matter rather than requesting a sweep.
- A reviewer that runs checks does so in its own copy, so that it depends on neither the working tree nor the owner's dev server: `git archive <commit> | tar -x -C <scratch dir>`, a junction or symlink from that copy's `node_modules` to the repository's, and a different `E2E_PORT`. TypeScript's build info (`tsBuildInfoFile`, set in this repository's tsconfig files) and Vite's cache (`cacheDir`, by default) live under `node_modules` and would be shared through that link. Neither has a command-line switch: edit the copy's `tsconfig.app.json`, `tsconfig.node.json` and `vite.config.ts` to point both inside the copy.
- Ask the reviewer to label each finding A (ordinary use, or lost work, a crash or an unsavable board) or B (an unusual sequence, size or device, or a text at a storage limit). Fix A findings in a follow-up commit, rerun the affected checks, and have the fix re-reviewed. Dismiss a B finding with a one-line reason unless the fix is nearly free or the finding risks lost work, and record it under "Known limits" when it is worth a sentence. A fix costs the review round it triggers, not its line count.
- A fix commit made after a re-review needs its own re-review, except one that changes only tests or documentation: that gets one round unless the reviewer shows an app fault the tests would miss. A slice is done by the plan's stopping rule, not when a reviewer runs out of findings. A review cut short (for example by a usage limit) has not cleared anything: resume or replace it. If a provider or tool fails the same way twice, switch to another route or ask the owner instead of retrying.
- Report reviewer identities, a finding-by-finding disposition (fixed in which commit, or dismissed and why), and the checks actually run. Delegation does not expand authorization.

## Commits and publishing

- Commit in logical slices. Every commit must be a safe checkpoint: the app works and whatever it stores is valid. Run the checks for the changed surface, inspect the full diff, then commit.
- Write commit messages around what changes for the person using the canvas, then why. Report the checks actually run; never invent impact, counts or verification.
- Do not push, merge, reset, switch branches, rewrite history or clean up destructively unless asked. Preserve uncommitted changes you did not make.
- Choose the base of new work deliberately. Until `main` contains the current app together with `AGENTS.md` and `CLAUDE.md`, do not base on it: new work must descend from `origin/feat/milestone-2-frames`, or from a newer owner-approved branch that descends from it. Once `main` does contain them, use the up-to-date base the owner approves instead; this is not a standing rule to branch from the feature branch.
- Before starting, confirm that both instruction files exist on the chosen base and on the new branch. If they are missing, the base is wrong: pick a base that has them rather than copying the files onto an older app they do not describe.
- For a pull request: a short specific title; open with what was wrong or missing and what changes for the user; then the checks run and any gaps. Writing a description does not authorize pushing, filing or merging.

## Dev server and ports

- `npm run dev` serves the working tree, by default on port 5173. The owner often has one running: every saved file hot-reloads into their open tab, on their real board.
- Do not start, stop, restart or kill a dev server or preview you do not own. Identify the process that owns a port before touching it; never use a broad kill.
- `npm run test:e2e` starts its own dev server on `127.0.0.1:5199` (override with `E2E_PORT`) and reuses one already listening there. It needs a dev server rather than a build, because the tests load `legacyStoreV1.ts` from it. Tests run in isolated browser contexts and must never use the owner's board. Concurrent runs need different ports.
- IndexedDB is per origin: `http://localhost:5173` and `http://127.0.0.1:5173` hold different boards.

## Verification

- Run checks proportional to the changed surface, and report skipped or unavailable checks explicitly. Report the counts you actually observed; do not quote an old count.
- Documentation-only changes: confirm every path and command you mention exists. App checks are not required.
- Any code change: `npm run lint`, `npm run typecheck`, `npm test`.
- Changes to gestures, frames, hit testing, transforms, text editing, storage or UI: also `npm run test:e2e`. The fake Fabric models state machines, not geometry or Fabric's real event order; those are accepted only on real-browser evidence.
- Full gate: `npm run lint && npm run typecheck && npm test && npm run build`, then `npm run test:e2e`.
- Focused runs: `npx vitest run <test file>` and `npx playwright test <spec file> -g "<title>"`. Check for flakiness with `npx playwright test --repeat-each=2`. Run `npm run test:e2e:install` once to download Chromium, or set `PW_CHANNEL=msedge` or `PW_CHANNEL=chrome` to use an installed browser.
- A new test must be able to fail: confirm it fails without the change it covers.

## Documentation

- The README describes behaviour to the person using the app; [Expected behaviour](docs/expected-behavior.md) states the same rules as constraints on changes. When a rule, shortcut, storage behaviour or known limit changes, update both in the same commit. Update the relevant guidance or engineering reference alone when only the way of working changes.
