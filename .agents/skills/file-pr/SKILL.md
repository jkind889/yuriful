---
name: file-pr
description: File or update a concise, problem-first pull request when the user asks to open, create, or update a PR; default new PRs to draft.
metadata:
  upstream: "https://github.com/t3dotgg/tstack"
  upstream-revision: "7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd"
  adaptation: "Local Codex shared workflows, 2026-10-26"
---

# File PR

Read [shared boundaries](../full-send/references/boundaries.md). Confirm repository, task branch, base, scope, instructions, and clean ownership of included changes. Inspect the complete current diff and validation evidence before creating or updating a PR.

Check for an existing PR by repository and head branch (including relevant closed/merged results) before creating one. Reuse the matching open PR within the user's authorized scope. Do not edit an unrelated PR or reopen/duplicate a closed PR automatically. After a creation timeout or uncertain response, look up the outcome before retrying.

Use repository title conventions and a problem-first title that explains the benefit without invented measurements. Open the description with the concrete user problem and resulting behavior, then relevant implementation rationale, validation actually executed, skipped/failed checks and limitations, and any required rollout steps. Scale the length to the change; follow repository templates. Do not invent screenshots, tests, review approval, authorship, model identity, or provenance. Name model/harness contributors only when verified and relevant.

New PRs are drafts unless the user explicitly requests otherwise. An explicit full-send request for this task authorizes marking its draft PR ready after current-head validation checks and the required review loop pass, subject to shared boundaries and any narrower user hold. Full-stop does not grant that promotion. A bot that skips drafts is a reported limitation, not permission to bypass these conditions. Preserve an existing PR's draft/ready state unless a change is authorized.

Prefer available connected tools; use gh only if present and authenticated. Keep body text in a structured argument, or a temporary UTF-8 file with --body-file for gh; do not interpolate multiline prose into shell code. On REST fallback preserve draft=true explicitly. Read-only rate-limit diagnosis is fine; do not broaden credentials or bypass permissions.

Before publishing inspect title/body/quotes/attachments for secrets or private details. Verify the resulting PR URL, repository, head/base and draft state. Attach created PRs to the current Codex task when the app tool is exposed; also attach an existing PR being worked on as required by that tool. Report creation/update outcome and limitations accurately.

Use [babysit-pr](../babysit-pr/SKILL.md) only when monitoring is requested or an authorized parent workflow calls for it. Posting comments is a separate action: avoid filler and use [leaving-pr-comments](../leaving-pr-comments/SKILL.md) only when authorized.
