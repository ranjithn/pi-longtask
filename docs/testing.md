# Validation performed for v0.1.0

## Automated local results

**44 tests passed; 0 failed, skipped or cancelled.** Node 22.16.0 on Linux. All extension/source modules also pass `node --check` through `npm run check`.

The suite uses Node's built-in test runner, with no npm dependencies. Tests create temporary real Git repositories and bare remotes; no GitHub/GitLab account, model endpoint or production service is accessed.

Coverage includes:

- Real sequential stacked commits, branches, pushes, worktree removal and clean base checkout.
- One-WP checkpoint/resume in a newly constructed engine.
- Recovery after a real commit succeeds before the controller receives success.
- MR creation/recovery without duplicate creation (mocked API).
- Local-check failure and repair; full re-verification/review after CI repair.
- Blocking reviews, bounded no-progress repairs and UI gate enforcement.
- Changed approved inputs, unauthorized plan edits, sensitive-file staging guards and unowned branches.
- Verification commands that modify source are not counted as successful gates.
- Uncertain child attempts block replacement workers.
- Completed branch drift on resume is rejected.
- Correlated delegation events, listener cleanup, cancellation acknowledgement and uncertain cancellation.
- Runtime registration through a simulated installed owner and incompatible-owner failure.
- GitLab exact host/method/boolean fields, existing MR reuse, wrong-target rejection, pagination, required jobs, failure traces and synthetic pipeline SHA rejection.
- State revision concurrency, exclusive locks, atomic JSON, process timeout/abort, configuration/path/glob/schema validation.
- Pi extension factory/command/lifecycle registration and read-only use/status/dry-run with a simulated host.

## Not validated here

A real installed Pi process running real model children through pi-subagents; real provider token/cost accounting; authenticated live GitLab projects and CI; the user's private repository and its Medplum/MedGemma/Postgres/Playwright setup; macOS execution; adversarial/malicious workers; every crash position; remote/shared filesystems.

Passing mock-based contract tests cannot establish upstream runtime compatibility. The extension intentionally checks public capabilities and stops when it cannot verify them.

## Local pilot checklist

Use a disposable/non-production repository or a small first WP. Verify the installed version with `/longtask doctor`, then use preflight to exercise real registration/delegation. Review generated config, decide appropriate models and bounded limits, confirm test DB isolation and worktree-safe setup.

Commit/push the base, approve, and run `--one`. Inspect the resulting diff, separate reviewer receipts, exact MR target and current-SHA pipeline, then test pause/stop/resume before a long campaign. Do not use a production database or merge intermediate stack branches during this pilot.

Run the bundled tests locally with `npm test`; inspect module syntax with `npm run check`.
