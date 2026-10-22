# Configuration reference

`<plan-dir>/longtask.json` is JSON, not YAML. Unknown top-level and agent/CI/limit keys are rejected. The controller uses deterministic argv commands, not model-generated shell strings.

## Core fields

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `id` | Unique repository-local campaign ID, 1–80 safe characters. Reusing an ID for another config path is rejected. |
| `baseBranch` | Existing local and remote base; `init` defaults to `main`. |
| `branchPrefix` | WP branches become `<prefix>/<numeric WP suffix>`. |
| `remote` | Push remote, default `origin`. The push URL determines GitLab host/project. |
| `worktreeRoot` | External directory relative to repository root, or an absolute path. Cannot be inside the repository or its ancestor. Symlink paths are rejected. |
| `workPackages` | Ordered `{id,file,title?,checks?,ui?}` entries. IDs are numeric `WP00`, `WP01`, etc. File paths are relative to the plan directory. Explicit lists can omit IDs, but remain ordered and unique. |
| `decisions` | Relative plan file, default `decisions.md`. |
| `infrastructure` | Plain-text constraints included in child prompts. Not an OS access policy. |
| `cleanup` | Default `true`; remove owned clean worktrees after gates. Use `false` to retain ignored local data too. |
| `compactBetweenWps` | Default `false`. Parent compaction only after durable completion. |

## Commands

`setup`, `checks`, `uiChecks` and per-WP `checks` contain objects like:

```json
{
  "name": "Backend tests",
  "command": ["mix", "test"],
  "cwd": ".",
  "timeoutSeconds": 1800,
  "env": { "MIX_ENV": "test" }
}
```

`cwd` is relative to the worktree and defaults to its root. The command runs with the Pi process environment plus the explicit `env`. Do not put secrets into tracked JSON: use preconfigured environment variables or a safe credentials mechanism. Environment values are literal; `$HOME` and `~` are not expanded in argv/cwd. Executables are resolved using the inherited `PATH`.

Strings such as `"npm test && npm run lint"` are rejected as command arrays. Multiple commands should be separate entries. An explicit `['bash','-lc', '...']` array is technically possible for a reviewed local requirement, but avoid it when direct executable arguments work. Commands are trusted code and may have arbitrary side effects.

Setup runs once per new worktree, checkpointing each successful command. It must be idempotent because a crash may occur after a command's side effects and before its receipt. Install/build artifacts should be ignored appropriately. Shared dependency caches are fine only when your package manager handles concurrent/cache integrity correctly; this controller does not manage cache locking.

Verification commands must not modify tracked/untracked source. Formatting should use check-only mode. If a test command mutates the candidate tree, the gate blocks. Output is capped at 8 MiB per command; excessive output blocks rather than silently discarding diagnostics. Timeout defaults to 900 seconds; explicit values are 1–86400 seconds.

Global `checks` plus WP-specific `checks` always run. Each WP needs at least one configured check before approval. The controller validates exit status, not whether the test command itself is meaningful—inspect commands and the first run.

## UI detection

Default `uiPaths` match `**/*.tsx`, `**/*.jsx`, `**/*.css`, `**/*.html`, `**/*.vue`, `**/*.svelte`, `**/frontend/**`, `**/client/**`.

The glob language supports `*`, `**`, `?`, not brace expansion or extglobs. Detection is heuristic; set `"ui": true` on a WP or add patterns for your repository. `ui: false` does not override file-based detection. Detected UI changes with no `uiChecks` block.

For example, **only when this is your actual frontend directory/configuration**:

```json
{
  "name": "Playwright acceptance",
  "command": ["npx", "--no-install", "playwright", "test"],
  "cwd": "apps/web",
  "timeoutSeconds": 1800
}
```

Install browsers/dependencies beforehand or in approved setup. Prefer repository Playwright `webServer` configuration pointing to this worktree. Configure safe ports/test users, stable fixtures and isolated test storage. A bare `curl` health check is not a substitute for browser acceptance.

## Agents and optional LSP

Defaults:

```json
{
  "workerTools": ["read", "grep", "find", "ls", "write", "edit", "bash"],
  "reviewerTools": ["read", "grep", "find", "ls"],
  "workerExtensions": [],
  "models": {},
  "thinking": "high"
}
```

`models` supports role keys `preflight`, `scout`, `worker`, `correctness`, `architecture`, `tests`. Omission follows the installed subagent model resolution. Configured provider/model IDs must actually be available. `thinking` supports the validated Pi levels shown in `src/config.mjs`; unsupported model/thinking combinations are rejected by the installed owner.

Append real installed LSP tool names to `workerTools` and the supported extension binding strings to `workerExtensions`. Child extension resolution is pi-subagents-owned; consult that installation's extension API/configuration. A parent tool being listed in `/longtask doctor` does not establish child compatibility. There is no automatic wildcard inheritance or browser MCP binding.

Read-only roles deliberately lack shell/write tools; additional writable reviewer tools are rejected. The package registers names prefixed `longtask-`, so it does not overwrite your `worker.md`/`reviewer.md` profiles. A name collision is an error, not silent replacement. Child protocol tools needed for structured output are managed by pi-subagents.

## Limits

| Key | Default | Effect |
| --- | --- | --- |
| `maxAgentCallsPerWp` | 24 | Total calls in one allowance, including scout, workers and each reviewer. |
| `maxRepairsPerWp` | 4 | Combined local/review/CI repair attempts before blocking. |
| `maxNoProgressRepairs` | 2 | Consecutive repairs leaving the source tree unchanged. |
| `agentTimeoutMinutes` | 30 | Per-child execution limit passed to pi-subagents. |
| `maxToolCallsPerAgent` | 120 | Per-child hard tool-call budget passed to pi-subagents. |
| `maxCostUsdPerWp` | `null` | Optional accumulated known-cost gate at child boundaries. |

Three parallel reviewers count as three calls. The dollar gate can be exceeded by an in-flight call or review batch; it is not prepaid authorization or a provider-side hard cap. Missing usage becomes unknown, not zero. Manual retry resets call/repair/no-progress and CI-wait allowances but never cumulative cost or call history.

The preflight auditor has the configured per-child timeout/tool limit but no WP aggregate cost/call ledger. Its receipt contains whatever usage the installed subagent owner reports.

## CI

```json
{
  "timeoutMinutes": 30,
  "pollSeconds": 20,
  "requiredJobs": ["unit", "playwright"]
}
```

`requiredJobs` names must match actual GitLab job names exactly; leave empty to rely only on the pipeline success state. Optional/allowed-failure jobs are not automatically made mandatory. Matrix jobs often have expanded names: inspect the actual pipeline.

The current MR source and target must match the recorded stack. The MR SHA must match the source commit. The controller selects MR `head_pipeline` first, otherwise the latest exact-SHA branch pipeline, and accepts only `status: success` with that source SHA. A synthetic merged-results pipeline is not accepted. Missing CI waits to a deadline and blocks; `/longtask retry` explicitly renews the wait allowance.

## Sensitive paths

`denyPaths` blocks common `.env`, key and certificate paths before staging. `allowSensitivePaths` can exempt deliberate files such as an audited `.env.example`. These are filename guards, not content-based secret detection. Do not broadly exempt secrets. Ignored files are not staged by this controller, but are inside the cleanup directory; preserve them elsewhere or disable cleanup.
