# Native reviewer routing

Recheck the current tool schema and model list every invocation. A file on disk does not make an agent role, tool alias, or model available.

At setup on 2026-10-26, this session exposes collaboration.spawn_agent with model gpt-6.1-sol and fork_turns "none"; a model override is allowed only with no inherited turns. A truthful native call, when this exact schema and model remain available, is:

```json
{
  "task_name": "sol_review_round_1",
  "fork_turns": "none",
  "model": "gpt-6.1-sol",
  "message": "SELF-CONTAINED READ-ONLY REVIEW BRIEF WITH ACTUAL PATHS, DIFF AND EVIDENCE"
}
```

Use that exposed collaboration tool, not a shell command. The user selected GPT 6.1 Sol for this skill. If an effort is set, choose only a supported value and report it accurately. Reuse the returned native agent ID for bounded follow-up rounds when supported, or start a fresh reviewer after confirming the previous one stopped. Do not run concurrent reviewers for this loop. Use actual completion/wait tools; do not assume ending a turn creates a durable wake-up.

The setup probe successfully dispatched and completed a read-only review with model=gpt-6.1-sol requested. The returned task identifier confirmed dispatch, but the child reported only the generic GPT-6 identity, not an exact active-model identifier. Report this distinction: requested model and accepted route are known; independent runtime attestation of the exact backend model is unavailable. Do not turn a requested model string into claimed runtime telemetry.

The read-only scope is an instruction to this reviewer, not an OS sandbox guarantee: the currently exposed spawn schema has no per-child read-only sandbox field. If the runtime supports enforceable read-only permissions, use them. Otherwise explicitly prohibit every write and validation execution, constrain paths, and compare state fingerprints before/after; report any unexpected mutation and invalidate the round. Do not claim technical isolation that was not provided.

No codex executable was on PATH at setup. No CLI wrapper, Sol alias, custom agent role, API integration, or model-default change is installed by these skills. gh is optional and was found locally; recheck its presence and authorized connection before use.

If this route is missing or rejects the requested model, inspect other exposed native delegation schemas for an explicitly available GPT 6.1 Sol model. Do not invoke hypothetical T3 tools, substitute another model silently, install a CLI, change config, or call a paid API to make it work.

If no authorized route can run GPT 6.1 Sol, stop the Sol loop and report "GPT 6.1 Sol review unavailable" with the missing capability and review status INCOMPLETE. The coordinator may perform and label a self-review and validation, but must not call it a Sol review or independent approval. Leave dependent readiness/merge gates unresolved; ask for an explicit alternative if the task requires one.
