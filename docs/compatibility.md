# Compatibility and upstream references

Public API sources inspected on **October 3, 2026**. Upstream main branches are moving references. The package does not claim compatibility with every historical Pi or pi-subagents release.

## Required Pi surface

- JS ESM extension factory, `registerCommand`, `on`, `events`.
- `sendMessage`, `appendEntry`; interactive context UI `confirm`, `notify`, `setStatus`.
- Context `cwd`, `hasUI`, `isIdle`; optional project-trust guard.
- `session_start`, `session_shutdown`, `session_before_switch`, `session_before_fork`, `session_before_tree`.
- Optional `compact` callback API when explicitly configured.
- Package manifest `pi.extensions` and `pi.skills`, local directory installation.

References:

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts

## Required pi-subagents surface

The inspected repository package identified itself as 0.75.0. This is a source-reference observation, **not a tested minimum version or proof that a particular npm release contains the same source**. Capabilities are checked at runtime; actual child execution must be tried locally.

- RPC `subagents:rpc:v1:request` with `ping` and per-request reply event.
- Runtime registration `pi-subagents:runtime-agent-register:v1` with synchronous request result and disposable registrations.
- Owned foreground structured delegation via `prompt-template:subagent:request/started/update/response/cancel`.
- Fresh context, configured runtime agents, JSON-schema result mode, per-child timeout/tool budget, optional intercom bridge override and terminal usage.

The direct event contract is deliberate: independently installed Pi packages are not automatically Node-resolvable dependencies of each other. This package does not import a private module or vendor a second copy of pi-subagents.

References:

- https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md
- https://github.com/nicobailon/pi-subagents/blob/main/src/api/delegation.ts
- https://github.com/nicobailon/pi-subagents/blob/main/src/agents/runtime-agent-registry.ts
- https://github.com/nicobailon/pi-subagents/blob/main/package.json

A responding RPC is necessary but insufficient. Preflight verifies registration plus a real structured child. A first-WP pilot verifies worker tools, installed extensions, models, repo scripts and GitLab behavior. Unknown/missing APIs stop rather than selecting an undocumented fallback.

## GitLab and glab

Uses authenticated `glab api` with an explicit hostname, HTTP method and typed/raw fields. The push remote selects the project; the returned project namespace/ID must agree. Authentication is owned by your local glab setup, not stored by this package.

References:

- https://docs.gitlab.com/cli/api/
- https://docs.gitlab.com/api/merge_requests/
- https://docs.gitlab.com/api/pipelines/
- https://docs.gitlab.com/api/jobs/

No live authenticated GitLab request was made during local development/testing of this artifact. Synthetic merged-results SHA semantics are intentionally not guessed.
