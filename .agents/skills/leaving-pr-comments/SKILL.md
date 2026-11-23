---
name: leaving-pr-comments
description: Format and verify authorized agent-authored GitHub PR comments and replies; this skill does not itself authorize posting or resolving threads.
metadata:
  upstream: "https://github.com/t3dotgg/tstack"
  upstream-revision: "7de017b3fc9d50c03cf3ecb98fb71e0ca65a78bd"
  adaptation: "Local Codex shared workflows, 2026-10-26"
---

# Leaving PR Comments

Read [shared boundaries](../full-send/references/boundaries.md). Post only when the user or explicitly invoked workflow authorizes the particular communication. A read-only watch, review finding, or installation is not authorization to comment. This formatting skill alone grants no posting or thread-resolution authority.

Lead with the conclusion, cite code/checks/reproduction, and distinguish observed facts from judgment. Use stable finding IDs where helpful; avoid filler and repeated status comments.

Prefix agent-authored PR comments with:

```markdown
> [!NOTE]
> 🤖 **<verified model or harness> responding on behalf of <verified user/login>**

Actual comment.
```

Use only verified identities. If the model is unknown, use the verified harness; if the user's identity is unavailable, say "the user" without guessing a login. Do not claim reviewer provenance for implementation work it did not do. Do not add this callout to descriptions, commits, or text the user explicitly asks to post verbatim.

Preview the complete Markdown and remove secrets/private material before posting. Use structured arguments or a UTF-8 body file, never unsafe shell interpolation. Verify the returned comment/review URL. An uncertain result requires checking for an existing comment before retrying. Resolve a thread only when separately authorized and after its response was posted successfully and the issue is actually addressed or an evidenced dismissal is appropriate; never dismiss a required human review to force readiness.
