# pi-longtask

**An installable Pi extension and companion skill for checkpointed, long-running engineering campaigns.**

Version **0.1.0**. MIT licensed, with no npm runtime dependencies. Node **22.19 or newer** for current Pi releases. Intended for macOS/Linux. Compatibility checked against **Pi 1.4.0** and **pi-subagents 0.80.0**; see [validation details](docs/testing.md).

The controller owns sequencing, Git worktrees, stacked GitLab merge requests, verification gates, cancellation and durable state. Your installed **pi-subagents** owns child execution. There is no second subagent launcher, no private upstream import, and no dependency on pi-goal.

> Release status: locally tested implementation, not a live-end-to-end-certified integration. The tests use real local Git repositories and bare remotes, plus mocked Pi/subagent events and GitLab responses. Start with one WP in a non-production repository. Read the limitations below before unattended use.

## Install

Install directly from the public [GitHub repository](https://github.com/ranjithn/pi-longtask):

```bash
pi install https://github.com/ranjithn/pi-longtask

# Required companion extension, if not already installed:
pi install npm:pi-subagents
```

Pi clones and manages the GitHub package, including its extension and companion skill. No manual clone, ZIP download, build step, or global module linking is needed. This package is not published to npm. Restart Pi or run `/reload` after installation.

The command above installs for your user. To install only for the current project, use `pi install --local https://github.com/ranjithn/pi-longtask`; project packages load after project trust is granted.

To update or remove the GitHub installation:

```bash
pi update https://github.com/ranjithn/pi-longtask
pi remove https://github.com/ranjithn/pi-longtask
```

Stop any active campaign before updating, then restart Pi or run `/reload`. For a project-local installation, add `--local` when removing it.

Your installed `pi-subagents` must expose the public runtime-agent-registration v1 and owned structured-delegation APIs. Older versions may not. Check:

```text
/longtask doctor
/subagents-doctor
```

`doctor` performs an RPC ping and reports Git/glab/tool availability. It does **not** spend model tokens or validate a complete child launch. `/longtask preflight` exercises runtime registration and actual structured delegation. Unsupported APIs stop with an error; there is no silent fallback to invented tools.

Already-installed pi-subagents can remain installed alongside this package; it is a separate required extension, not bundled here. Pause any existing `/goal` execution before starting this controller; both should not own the same campaign.

## Quick start

Create a plan directory with ordered work-package specifications, such as `WP00.md` and `WP01.md`. Start Pi in your base-branch checkout, then initialize the campaign:

```text
/longtask init plans/my-campaign --base main
```

Use `--base` for a different base branch and optional `--from WP00 --to WP01` to select a range.

| Setting | Default |
| --- | --- |
| Base branch | `main` |
| WP branches | `longtask/<campaign-id>/<WP suffix>`, e.g. `longtask/my-campaign/00` |
| Worktree root | `../.pi-longtask-worktrees`, resolved relative to the repository root |
| Worktree directory | `<campaign-id>-wp00`, then `-wp01`, etc. |
| First MR target | The configured base branch |
| Later MR targets | The previous WP branch |
| Remote | `origin` |
| Worktree cleanup | After local checks, reviews, MR, exact-commit CI and checkpoint |

Override branch and worktree naming with `--branch-prefix` and `--worktree-root`. Existing configurations keep their explicit settings.

`init` discovers files such as `WP00.md`, `WP00-foundations.md`, or `WP00/README.md`. Ambiguous IDs and missing requested WPs are rejected. Plans with another layout can use explicit `workPackages` entries in a hand-written `longtask.json`, then `/longtask use <plan-dir>`.

### 1. Configure actual repository commands

`init` writes `plans/my-campaign/longtask.json` and creates `decisions.md` only when it is absent. It never overwrites an existing config.

**Generated test command lists are intentionally empty.** This package has not inspected your repository and does not guess its test commands, frontend directory or database settings. Approval refuses a WP with no configured verification check.

Use the bundled skill to help prepare this configuration:

```text
/skill:longtask Inspect this repository and configure plans/my-campaign/longtask.json. Use the actual project verification commands and browser tests where needed. Preserve shared services and use isolated test data. Do not start execution.
```

The skill assists the parent Pi with configuration and interpretation. The extension, not the skill or parent model, runs the campaign. Slash commands below are entered in Pi, not a shell.

Configure `setup`, `checks`, `uiChecks`, any WP-specific checks, and model/tool selections. See [configuration](docs/configuration.md) and [the illustrative example](examples/longtask.json). Then:

```text
/longtask dry-run
/longtask preflight
```

Preflight is a read-only agent audit of every listed plan input. It returns questions and risks. Resolve the questions in `decisions.md`; run preflight again after substantive design changes. Approval records your confirmation that the questions are resolved; it does not pretend to algorithmically prove that every answer is sufficient.

### 2. Commit and push the approved inputs

The original checkout must be clean, on the configured base branch, and its local/remote heads must agree. Commit the plan, config, decisions and any other intended initial changes, then push the base branch. Review the actual diff rather than blindly staging unrelated files.

For example, after reviewing the files:

```bash
git add plans/my-campaign
git commit -m "Define approved work-package campaign"
git push origin main
```

Approval fingerprints the configuration, plan Markdown/text/JSON files and root `AGENTS.md`, and keeps a local snapshot. Do not modify these inputs once approved. Use a new campaign ID and branch prefix for a revised plan rather than editing state to bypass this rule.

### 3. Approve, pilot, continue

```text
/longtask approve
/longtask run --one
```

The approval dialog authorizes the listed local commands, code edits in owned worktrees, commits, pushes, MR creation and configured cleanup. It does not authorize merges, branch deletion, force pushes or automatic rebasing.

`--one` executes the next whole WP and pauses at its checkpoint. Inspect the first MR and evidence, then:

```text
/longtask resume
```

The rest runs sequentially. Do not merge, squash, rebase or delete intermediate branches while the campaign runs. The controller checks pinned target heads and completed stack branches. It does **not** automate merging or restacking after the campaign.

## What a WP does

```text
prepare owned branch/worktree
  -> setup commands
  -> read-only scout
  -> implementation worker
  -> deterministic local checks (+ browser checks for UI changes)
  -> fresh correctness + architecture + test reviewers
  -> commit and non-force push
  -> create/reuse MR with exact target
  -> wait for exact-source-commit CI
  -> write checkpoint
  -> remove clean owned worktree, or retain when configured
  -> next WP
```

Local check failures, justified blocking reviews and failed CI lead to bounded worker repair. A repair invalidates the local/review/CI gates and reruns them. Infrastructure failures and unresolved product decisions should be reported as blockers, not invented away.

Reviewers receive the approved specification, actual diff and test receipts. They do not receive the worker's explanation as review context. They use fresh children with read-only tool allowlists. Workers also use fresh children; they do not inherit the entire parent conversation.

Completion is bound to the verified Git tree and pushed commit, not a worker saying “done.” CI polling runs in code, without repeatedly calling an LLM.

## Commands

| Command | Behavior |
| --- | --- |
| `/longtask init <plan-dir>` | Discover WPs and generate editable configuration. |
| `/longtask use <plan-dir>` | Select an existing configuration. |
| `/longtask doctor` | Read-only compatibility/command diagnostics. |
| `/longtask dry-run` | Print branch stack and commands; execute none. |
| `/longtask preflight` | Read-only model audit before approval. |
| `/longtask approve` | Interactive authorization and frozen input snapshot. |
| `/longtask run [--one]` | Execute the remaining campaign, or one WP. |
| `/longtask status` | Show phase, checkpoint paths, limits and unresolved attempts. |
| `/longtask pause` | Finish the current phase, then pause. |
| `/longtask stop` | Request immediate child/command cancellation; await acknowledgement. |
| `/longtask resume [--one]` | Reconcile and continue without resetting allowances. |
| `/longtask retry` | Explicitly renew bounded call/repair/CI-wait allowances; then use resume. |
| `/longtask recover` | Owner acknowledges prior execution has stopped; reconcile stale bookkeeping. |
| `/longtask abort` | Stop and preserve branches, MRs and worktrees for inspection. |

`retry` does not reset cumulative usage or waive gates. There is intentionally no `skip` or “mark complete” shortcut.

## State, restart and cancellation

State is stored outside the tracked working tree:

```text
<git-common-dir>/pi-longtask/
  selected.json
  controller.lock
  <campaign-id>/
    state.json
    events.jsonl
    inputs.json
    inputs/...
    artifacts/...
```

Find the root with `git rev-parse --git-common-dir`. Linked Git worktrees share it. Files include prompt results, local command logs, reviews, CI failure traces and completion receipts. Do not upload them without checking for secrets or sensitive content.

Atomic writes, a repository-scoped controller lock and revision checks protect normal crash/restart and cooperating-controller races. Git remains the durable implementation history. Recovery after a crash reconciles existing worktrees, exact commit intents, pushed SHAs and MRs rather than recreating them blindly.

If a child has no terminal acknowledgement, resume stops. Inspect the previous Pi session/child and any test subprocesses, stop them, then use `/longtask recover`. Recovery is an **owner assertion**, not an automatic proof that a process exited. A live PID lock is not stolen. Killing Pi abruptly can leave subprocesses; normal shutdown attempts cancellation, but cannot guarantee cleanup after SIGKILL or a machine failure.

Keep the Pi process running during execution. This package is not a daemon or a scheduler that survives host shutdown. It keeps the UI available for its status/pause/stop commands. Avoid unrelated parent-agent edits while a run is active. Session switching/fork/tree navigation is blocked while the controller is active; stop it first.

## Important boundaries

- **Not an OS sandbox.** Worker `bash`, test commands and trusted extensions have the normal user's permissions and inherited credentials. Scope prompts, allowlists and Git checks are guardrails, not protection against malicious code. Use an isolated development environment and synthetic/test data.
- **Shared services are not test fixtures.** No automatic restart, reset or migration of shared services or production databases. Configure a separate test database/schema before authorizing checks. Read-only runtime prompts alone cannot enforce this against arbitrary shell access.
- **Cleanup removes the owned worktree directory**, including ignored build/dependency artifacts. Do not put unique data, database storage, hand-created credentials or important untracked/ignored files there. Set `cleanup: false` when preservation matters. The controller never force-removes a dirty/locked worktree or deletes its Git branch.
- **GitLab same-project MRs only.** No forks, submodules, auto-merge, auto-rebase, automatic target retargeting, branch deletion or force push. Nested/self-hosted GitLab namespaces are supported for conventional HTTPS/SSH remotes, but custom subpath installations and unusual host formats are not verified.
- **CI is conservative.** v0.1 accepts successful pipelines whose SHA equals the pushed source SHA. Missing, stale, skipped and manual-only gates are not success. Synthetic merged-results-only pipelines are unsupported and will wait then block. Required named jobs can be configured; this is not a replacement for GitLab's protected-branch/approval policies.
- **Budgets are bounded allowances, not provider billing guarantees.** Per-call timeout/tool limits and per-WP call/repair limits apply. An optional USD gate is checked at child boundaries; a running call or parallel review batch can overshoot it. Unknown cost blocks a configured dollar gate. No hard aggregate token budget is implemented.
- **Input freeze is intentional.** Root `AGENTS.md` and approved plan inputs cannot be changed as part of a WP. Global Pi configuration, dependency artifacts, nested instructions and shared service state are not cryptographically frozen.
- **No-op WPs block.** v0.1 requires an actual source-tree difference; it does not silently certify “already complete.”

## Optional integrations

`pi-goal` can stay installed but should not run a competing loop. The safety patterns are implemented here, not copied or invoked from pi-goal.

Workers default to built-in read/search/edit/write/bash tools. LSP tools must be configured explicitly using their actual installed names and an appropriate extension binding in `agents.workerExtensions`. Parent extension installation is not a guarantee that a child has those tools. `doctor` lists parent tool names for inspection; test child availability with the pilot WP. Reviewers intentionally have no shell or write tools.

Browser acceptance is normally a **configured Playwright CLI command**, not a promise that a browser MCP server is automatically available. Existing repository Playwright configuration can start its own isolated frontend web server. Do not point browser checks at stale code from the base checkout.

Compaction is disabled by default because children have fresh contexts and progress is persisted. `compactBetweenWps: true` requests parent compaction only after a safe WP checkpoint. It does not replace durable state.

## Test and inspect the package

For development, clone [the repository](https://github.com/ranjithn/pi-longtask) and optionally register that checkout with `pi install /absolute/path/to/pi-longtask`. Local-path installs load in place, so retain the checkout. Normal installation uses the managed GitHub package above.

```bash
cd /path/to/pi-longtask
npm run check
npm test
```

No dependency installation is needed for the default suite. See [testing](docs/testing.md) for the optional installed-release smoke test, [architecture](docs/architecture.md), [compatibility and sources](docs/compatibility.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Ranjith Narayanan and pi-longtask contributors. Contributions are welcome under the same license. External tools retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
