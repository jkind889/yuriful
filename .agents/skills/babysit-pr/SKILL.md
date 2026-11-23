---
name: babysit-pr
description: Monitor a specific PR through checks and review; watch-only requests remain read-only, while authorized fix workflows may address verified findings.
metadata:
  upstream: "https://github.com/t3dotgg/tstack"
  upstream-revision: "7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd"
  adaptation: "Local Codex shared workflows, 2026-10-26"
---

# Babysit PR

Read [shared boundaries](../full-send/references/boundaries.md). Identify the exact PR, head/base, existing holds, current checks, reviews/threads, and requested mode. A request to watch or monitor is read-only. Fix mode requires explicit fix/update authorization or an active full-stop/full-send task for this PR; it still does not expand permissions.

Read all relevant pages, including existing findings and reviews that predate the latest push but remain unresolved. Verify each finding against current source and relevant tests. Distinguish actual code regressions from infrastructure failures. Do not infer that an older finding is fixed merely because a newer commit exists. Do not special-case a bot as optional when repository rules make its check required.

In fix mode, make the smallest authorized in-scope correction, validate it, and re-review changed behavior with [sol-loop](../sol-loop/SKILL.md) where the parent workflow requires it. Push only authorized task changes. Review comments, thread resolution, CI reruns, rebases, and force pushes need their applicable authorization; see [leaving-pr-comments](../leaving-pr-comments/SKILL.md). In watch-only mode, report proposed fixes without executing them.

## Monitoring capability

Only the coordinating owner monitors; review children do not. Use one monitor per PR and inspect existing automation before adding another. Prefer an actually exposed native PR/event watcher with its documented wake-up/stop lifecycle. Native events are wake-ups to re-read state, never merge decisions.

For later/repeated notification requests, use the available automation tool according to its requirements, including a successful harmless connector read and supported cadence/triggers. Preserve the exact PR scope and mode in the automation prompt. This skill does not install a watcher or create one by itself. If durable monitoring is unavailable, report the current snapshot and the limitation; never claim you will keep watching after the turn ends.

For checks within the active turn, an available authenticated gh may use its documented bounded checks-watch mode (verify local help/options first). It observes CI only, not complete review/merge readiness. Use a time/attempt bound (normally at most 10 minutes per active wait), yield tool control in short intervals, and stop/report pending status at the bound unless an authorized durable continuation exists. Respect rate limits and backoff; no busy polling, duplicate watcher, or unbounded sleep. Do not launch the upstream pr-wait script: it is not installed.

## Handoff

Re-read current head/base/checks/reviews and mergeability after each meaningful event. Missing/incomplete data is unknown, not green. Base movement may invalidate tests/review; suggest or perform an update only within authorization. Never close an obsolete PR without authorization.

This support skill never merges or enables auto-merge. A parent full-send workflow must independently establish its own authorization and gate. Full-stop retains its absolute no-merge boundary. Report ready-for-review, pending, or blocked with URLs and exact evidence; do not say ready-to-merge for a draft, missing approval, or hold. Stop only the monitor owned by this task on handoff. Report whether durable monitoring was actually created and how it can be stopped.
