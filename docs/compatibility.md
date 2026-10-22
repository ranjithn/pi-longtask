# Compatibility and upstream references

Latest published releases checked on **October 22, 2026**: **Pi 1.4.0** (`@earendil-works/pi-coding-agent`) and **pi-subagents 0.80.0**. Versions were confirmed through npm metadata and web release/package pages; API contracts were checked against the installed release files. The optional [compatibility smoke test](testing.md) loads both real extensions and executes all six registered roles with a deterministic, local model provider. No paid provider or authenticated GitLab call is involved.

Upstream main branches are moving references. This is a tested release pair, not a guarantee for all historical or future versions. Current npm Pi requires Node **22.19.0+**.

## Installation source

Install the public repository directly with `pi install https://github.com/ranjithn/pi-longtask`. Pi manages it as a Git package; no manual checkout or npm publication is required. Install `pi-subagents` separately with `pi install npm:pi-subagents` if needed. See [installation and updates](../README.md#install) for project scope and package management.

## Required Pi surface

- JS ESM extension factory, `registerCommand`, `on`, `events`.
- `sendMessage`, `appendEntry`; interactive context UI `confirm`, `notify`, `setStatus`.
- Context `cwd`, `hasUI`, `isIdle`; optional project-trust guard.
- `session_start`, `session_shutdown`, `session_before_switch`, `session_before_fork`, `session_before_tree`.
- Optional `compact` callback API when explicitly configured.
- Package manifest `pi.extensions` and `pi.skills`, GitHub/Git package installation (local-path loading is optional for development).

References:

- https://pi.dev/changelog/releases/1.4.0
- https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.4.0
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts

## Required pi-subagents surface

Runtime registration and owned structured delegation were exercised with the published **0.80.0** package under **Pi 1.4.0**. The protocol remains compatible; no private imports, legacy delegation fallback, or second launcher are needed. Capabilities are still checked at runtime, and real provider/tool configuration must be piloted locally.

- RPC `subagents:rpc:v1:request` with `ping` and per-request reply event.
- Runtime registration `pi-subagents:runtime-agent-register:v1` with synchronous request result and disposable registrations.
- Owned foreground structured delegation via `prompt-template:subagent:request/started/update/response/cancel`.
- Fresh context, configured runtime agents, JSON-schema result mode, per-child timeout/tool budget, optional intercom bridge override and terminal usage.

The direct event contract is deliberate: independently installed Pi packages are not automatically Node-resolvable dependencies of each other. This package does not import a private module or vendor a second copy of pi-subagents.

References:

- https://pi.dev/packages/pi-subagents
- https://registry.npmjs.org/pi-subagents/0.80.0
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
