# Architecture and recovery invariants

## Components

- `index.js`: command/UI/lifecycle integration, selection, interactive approval/recovery and optional checkpoint compaction.
- `src/config.mjs`: strict configuration, WP discovery, approved input snapshot and UI detection.
- `src/store.mjs`: serialized atomic state persistence, monotonic revisions, immutable input copies and local evidence artifacts.
- `src/delegation.mjs`: event-based runtime-agent registration and exact-tuple owned leaf delegation through the installed pi-subagents owner.
- `src/prompts.mjs`: original worker/auditor/reviewer instructions, output schemas and defensive schema validation.
- `src/engine.mjs`: deterministic per-WP state machine and budgets.
- `src/git.mjs`: owned Git worktrees, pinned branch topology, candidate tree snapshots, commit-intent recovery and normal pushes/cleanup.
- `src/gitlab.mjs`: glab API adapter, project identity, idempotent MR recovery and exact-source-commit CI checks.
- `src/util.mjs`: confined configuration paths, process execution/cancellation, atomic writes and single-controller lock.

No model controls state transitions directly. There is no `mark_complete` tool and no parent-agent continuation prompt. Model output is structured evidence consumed by fixed code.

## Verified WP transaction

Before commit, local checks and all three reviewers bind to the same Git tree. A code mutation invalidates those gates. The controller writes a commit intent `{parent,tree}` before `git commit`. If execution crashes after commit, only a commit with that exact parent/tree can be adopted automatically.

Pushes specify the exact committed SHA. An unexpected remote source/target head blocks. The controller queries MRs by source branch and reuses an unambiguous open MR with the correct same-project source/target. It never blindly creates a second MR after a network interruption.

CI success must refer to the current pushed source SHA. Checkpoint requires the committed tree to match local/review receipts and successful CI, rechecks MR/CI, and verifies the remote source. Cleanup is a separate recoverable phase after the checkpoint. Completed prefix branches are revalidated on resume and before starting later WPs.

This is a recoverable workflow, not a distributed exactly-once transaction. GitLab side effects and filesystem writes cannot be made one atomic operation. Network races, external actors and malicious workers are not eliminated. Explicit intent records and reconciliation reduce duplicate/unsafe normal recovery.

## Children and cancellation

Each request has random `requestId`, campaign `ownerRunId`, and unique `nodeId`. Started/progress/terminal/cancel messages are matched to the full identity tuple. Malformed-request rejection can correlate by unique request ID. Listeners are installed before request emission and disposed after settlement.

The adapter waits for terminal acknowledgement after cancellation. Unacknowledged cancellation is recorded as uncertain, never treated as “stopped.” The next worker cannot start until explicit recovery acknowledges that previous execution has ceased. Foreground child revival is not automatically attempted; a recovered interrupted phase starts a new leaf after ownership is established.

Host commands use `spawn` with argv and no implicit shell, bounded output and timeouts, with POSIX process-group termination for ordinary descendants. Detached grandchildren or hard-killed host sessions can escape that normal cleanup; recovery requires operator inspection.

## Concurrent control

A repository-wide exclusive lock prevents cooperating Pi controllers from running simultaneously across linked worktrees. State revisions reject stale loaded controllers even if the lock was released before they acquired it. File writes are atomic replace operations with file fsync and best-effort directory fsync.

This is intended for local filesystems, not a distributed lock service. Do not store the controller metadata on shared storage and treat it as multi-host coordination. The operator, trusted extensions, shell workers and local administrator can still modify files directly.

## Context

Parent conversation history is not the progress ledger. Approved inputs, child results, Git and GitLab metadata provide the resume facts. Every leaf uses fresh context. The reviewer prompt intentionally omits worker reasoning; local command receipts and the diff remain available. Source code could still contain misleading comments, so independent review is not a formal proof of correctness.
