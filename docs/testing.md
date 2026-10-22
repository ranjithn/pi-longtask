# Testing

## Automated local results

**48 tests passed; 0 failed, skipped or cancelled**, including the optional installed-release test. Verified on macOS with Node 24.19.0, **Pi 1.4.0** and **pi-subagents 0.80.0**. All extension/source modules pass `node --check` through `npm run check`.

The default suite uses Node's built-in test runner without npm dependencies. Tests create temporary real Git repositories and bare remotes. No external model endpoint, GitLab account or production service is accessed. Temporary paths are canonicalized so macOS system symlinks do not interfere with the controller's symlink guards.

```bash
npm run check
npm test
```

Without the environment variables below, the installed-release test is explicitly skipped: 47 tests pass and one skips.

Coverage includes:

- Sequential stacked commits, branches, pushes, worktree removal and clean base checkout.
- One-WP checkpoint/resume in a newly constructed engine.
- Recovery after a real commit succeeds before the controller receives success.
- MR creation/recovery without duplicate creation (mocked API).
- Local-check failure and repair; full re-verification/review after CI repair.
- Blocking reviews, bounded no-progress repairs and UI gate enforcement.
- Changed approved inputs, unauthorized plan edits, newly introduced root instructions, sensitive-file staging guards and unowned branches.
- Verification commands that modify source are not counted as successful gates.
- Retained worktrees are rechecked for cleanliness before resumed completion.
- Uncertain child attempts block replacement workers; completed branch drift blocks resume.
- Correlated delegation events, listener cleanup, cancellation acknowledgement and uncertain cancellation.
- Runtime registration through a simulated installed owner and incompatible-owner failure.
- GitLab host/method/boolean fields, MR reuse, target validation, pagination, required jobs, failure traces and synthetic pipeline SHA rejection.
- State revisions, locks, atomic JSON, command timeout/abort, configuration/path/glob/schema validation.
- Generic initialization defaults and refusal to overwrite existing configuration.
- Pi extension commands and lifecycle registration with a simulated host.

## Installed-release compatibility smoke test

Point to the roots of separately installed Pi and pi-subagents packages:

```bash
LONGTASK_PI_PATH=/path/to/node_modules/@earendil-works/pi-coding-agent \
LONGTASK_SUBAGENTS_PATH=/path/to/node_modules/pi-subagents \
node --test tests/compat.test.mjs
```

Use the same variables with `npm test` to include this test in the full suite. No additional dependencies or credentials are needed.

This test uses Pi's actual resource loader, extension runtime and in-process child sessions. It loads `index.js` alongside the installed pi-subagents extension, exercises RPC ping and runtime registration, and runs all six roles through owned structured delegation. A deterministic local provider supplies the structured-output tool call; the real child runtime captures and validates it and reports terminal usage. The SDK test host explicitly supplies pi-subagents' host-package-root environment hint so its validator can resolve Pi's TypeBox peer without installing another copy.

## Not validated here

Live model-provider behavior or billing; authenticated GitLab projects and CI; arbitrary repository build scripts, services and browser setups; adversarial workers; every crash position; remote/shared filesystems; standalone Pi binaries.

The smoke test establishes compatibility of the tested public API pair, not a complete live campaign or support for every future release. Runtime capability checks still fail closed.

## Local pilot checklist

Use a disposable/non-production repository or a small first WP. Check `/longtask doctor`, then use preflight to exercise your actual registration/delegation configuration. Review commands, models, limits, test-data isolation and worktree-safe setup.

Commit/push the base, approve, and run `--one`. Inspect the diff, independent reviewer receipts, exact MR target and current-SHA pipeline, then test pause/stop/resume before a long campaign. Never use production data or merge intermediate stack branches during the pilot.
