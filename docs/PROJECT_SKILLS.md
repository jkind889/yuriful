# Project skills

Installed 2026-11-20 as repository-scoped files, with no user-level settings changed and no workflow invoked. These skills travel with commits and work on fresh checkouts without relying on a particular home directory.

## Sources and runtime variants

- Six previously selected tstack workflows: `full-stop`, `sol-loop`, `file-pr`, `full-send`, `babysit-pr`, `leaving-pr-comments`. Copied from the verified installed Codex and Claude adaptations on the development machine, originally based on https://github.com/t3dotgg/tstack at `7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd`. Each copy retains the MIT license. These are deliberately not replaced with unadapted upstream behavior.
- Codex/T3 uses `.agents/skills/`; Claude uses `.claude/skills/`. The six variants are intentionally different: Codex uses its bounded GPT Sol route; Claude preserves the pinned read-only Opus reviewer in `.claude/agents/sol-loop-reviewer.md`. Verify runtime availability and the owner's model choice; never silently substitute. Claude paths were localized to this checkout. Existing approval, draft-first, read-only watch, opt-in full-send, and never-merge full-stop safeguards remain.
- Claude helper scripts were copied, not executed. `review-bundle` needs Bash/Git; `pr-wait` needs Python with POSIX `fcntl` and authenticated `gh`. Native Windows without these prerequisites must use a supported harness monitor/manual review handoff, not assume the scripts work or alter machine settings.
- Council: https://github.com/t3dotgg/tstack/blob/11e37a74d0a6868c121cd0910ab2b3bd9873b92a/skills/council/SKILL.md (MIT). Added an explicit project authorization boundary and bounded review rounds; original workflow retained below it. Installing Council does not authorize external agent/provider calls or sharing code. Verify recipient/provider and data authorization before invocation. PR changes and fixes require their own scope authorization.
- Frontend design: https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/frontend-design/SKILL.md. Skill and its adjacent Apache-2.0 `LICENSE.txt` preserved verbatim.
- Clean copy: the owner's exact supplied Markdown, with only the outer TypeScript code fence removed. No third-party attribution or license invented.

The three shared content skills are duplicated byte-for-byte across the runtime directories for cross-platform discoverability; update both together. Do not load two runtime variants of the same workflow or combine their permissions. The root project instructions and platform policy win over any skill. Invoking or installing a workflow is not permission to bypass a separate confirmation requirement.

## Future branches

Use an owner-approved base that contains this documentation commit. Before work, verify AGENTS.md, CLAUDE.md, `.agents/skills/`, and `.claude/skills/` exist. Branches created before this commit will not acquire it automatically. An authorized cherry-pick of this docs-only commit can carry the setup onto an existing development branch; resolve AGENTS.md against that branch's newer product rules instead of overwriting them. No push, merge, deployment, experimental branch modification, or global Git configuration was performed for this installation.

## Updating

Check upstream changes against the pinned revisions and retained adaptations. Inspect changes before copying; do not run a downloaded installer. Preserve license notices and authorization boundaries. Keep runtime-specific reviewer routing separate, verify relative paths, and update the shared copies together. Tests and actual reviewer provenance must be reported separately.
