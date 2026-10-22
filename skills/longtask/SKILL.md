---
name: longtask
description: Configure and operate the pi-longtask extension for long-running work-package plans, fresh pi-subagents workers/reviewers, stacked GitLab merge requests, CI gates, and crash-recoverable checkpoints. Use when preparing a plans directory for unattended execution or diagnosing a paused campaign.
---

# Longtask campaign assistant

The extension owns execution. This skill helps the parent Pi prepare configuration, resolve preflight questions and inspect evidence. It is not a replacement orchestration loop.

Read the relevant sections of `../../README.md` and `../../docs/configuration.md` from this skill's directory when you need exact configuration semantics. They are bundled within the same package.

## Prepare a campaign

1. Inspect the entire requested plan, root/nested `AGENTS.md`, build scripts, CI files, test configuration, package scripts and existing Playwright setup. Use the real repository commands and directories. Do not invent commands from a language guess.
2. Have the owner enter `/longtask init <plan-dir>` (or `/longtask use <plan-dir>` for an existing config). These are interactive Pi commands, not shell executables; do not launch a second Pi process to invoke them. When the config already exists, inspect it directly.
3. Edit only unapproved configuration/decisions and explicitly requested repository setup files. Never edit `.git/pi-longtask` state or manufacture verification receipts. An approved/running campaign's inputs are immutable; stop and explain a new campaign is needed for changed inputs.
4. Configure idempotent `setup` commands, meaningful `checks`, and `uiChecks` using argv arrays with explicit `cwd` and timeouts. Use test-only environments. Verify dependency/install steps, caches, browser binaries, test DB isolation, and frontend server behavior for a new worktree.
5. For this user's architecture-refactor workflow, defaults are `refactor/arch`, `dev/refactor-arch/nn`, worktrees under `../brahma00.wt`, sequential WP00–WP08, and stacked GitLab MRs. Preserve exact user-supplied alternatives. Existing Medplum/MedGemma/Postgres services must not be reset. Never use real patient data for tests.
6. Configure meaningful browser acceptance for client changes, not merely a build. `ui: true` on a WP forces the browser gate; `uiPaths` can extend file detection. Ensure Playwright runs code from the WP worktree rather than the base checkout. Do not assume a browser MCP tool is present.
7. Model strings and extension tool names must come from the actual Pi installation. Avoid hard-coded provider/model names that the owner has not authorized. Read-only reviewer tools must remain `read`, `grep`, `find`, `ls` or a subset. Workers can use explicitly configured LSP tools/extensions.
8. Recommend `/longtask dry-run` then `/longtask preflight`. Resolve important owner questions before execution and write answers in `decisions.md`. Do not implement during clarification. After the owner reviews the changes, ensure the base checkout is clean, committed and pushed before `/longtask approve`.
9. Recommend the first run as `/longtask run --one`. Once that WP is inspected, `/longtask resume` continues the remainder. Do not run a parallel `/goal` loop or manually orchestrate another worker for the same WP.

## During execution

The controller executes prepare → setup → scout → implement → verify → independent reviews → commit/push → MR → exact-commit CI → checkpoint → cleanup. It delegates model work through pi-subagents. Do not take over its Git lifecycle or change the worktree behind it. Do not ask clarification questions once execution is running; record a genuine blocker instead.

Keep the parent session available for `/longtask status`, `/longtask pause`, `/longtask stop`, `/longtask resume`. Pause finishes a phase; stop requests immediate cancellation. Parent context compaction is optional, and state remains authoritative regardless of context size.

## Diagnose a blocked run

Use `/longtask status` and read the reported state/receipt paths, command logs, review findings and exact Git/MR/pipeline identity. Inspect before recommending action.

- A failed acceptance test needs a real fix, not a weakened assertion or skipped check.
- Unknown/stale/synthetic pipeline SHA is not passing CI.
- Moved branches, changed approved inputs, missing worktrees, unowned branches, ambiguous MRs and unauthorized commits require investigation rather than automatic history rewrites.
- An unresolved child receipt requires verification that the prior worker and test processes stopped. `/longtask recover` records the owner's acknowledgement; it cannot prove termination. Do not delete locks or erase active attempts manually.
- `/longtask retry` grants a new bounded attempt allowance with owner confirmation; it does not waive gates or erase cumulative cost. Then the owner can resume.
- Do not merge or delete stack branches during the campaign. The package does not handle post-run merge/restack automation.

Explain limitations plainly: this is not an OS sandbox, a daemon, or a hard provider-spend cap. Never claim live integration validation just because mock-based tests pass.
