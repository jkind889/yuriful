---
name: leaving-pr-comments
description: Format and check any GitHub comment an agent posts on the user's behalf (PR comments, inline review comments, replies to bots or reviewers). Use whenever leaving comments on GitHub.
metadata:
  upstream: https://github.com/t3dotgg/tstack/blob/7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd/skills/leaving-pr-comments/SKILL.md
  adapted: "2026-10-26: posting needs the user's authorization; see docs/PROJECT_SKILLS.md"
---

# Leaving PR Comments

This skill formats comments. It does not authorize posting them. Post only when
the user's request covers it, for example fix mode in `babysit-pr`, or a
comment the user asked for. Watch-only monitoring never posts.

Prefix every agent-authored comment left on the user's behalf with this GitHub
note callout:

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <user>**

Actual comment starts here.
```

Use the verified public name of the model that wrote the comment, and the
user's name or GitHub login.

If the harness does not expose a model name, use the harness name. Do not guess.

Before posting, check the entire comment, including quoted text and
attachments, for secrets and private details.

Keep the attribution inside the note and the actual reply outside it. The
context line must start with the robot emoji. Do not add a horizontal rule,
Setext underline, heading, signature footer, or a second attribution.

Apply this format to top-level PR comments, inline review comments, replies to
bots or reviewers, and written explanations used before resolving or
dismissing feedback. Do not add it to PR descriptions, commit messages, or text
the user explicitly asked to post verbatim without attribution.

Write the comment itself in a direct style:

- Lead with the conclusion.
- Cite the relevant code, behavior, check, or reproduction.
- Keep it concise, and avoid filler, canned thanks, or status narration.
- Keep verified facts apart from judgment. Label model review as review, not
  as a test result.

Preview the final Markdown before posting, so quoting and blank lines render as
shown. After posting, verify that GitHub returned the comment or review URL.
Resolve a review thread only after its response was posted.
