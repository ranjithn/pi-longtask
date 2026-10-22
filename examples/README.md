# Examples are not inferred repository configuration

`longtask.json` illustrates the requested WP00–WP08 stack with Elixir and a hypothetical `apps/web` frontend. Confirm the actual commands, frontend path, dependency installation behavior, browser installation and test database settings before copying any entry. In particular, `MIX_ENV=test` by itself does not prove database isolation.

The normal `/longtask init` command deliberately generates empty setup/check lists instead of these guessed commands. The bundled skill can inspect your repository and help fill them.

`RUNBOOK.md` and `decisions.md` can be copied/adapted before approval, but are not required controller filenames except for the configured decisions path. The deterministic implementation is authoritative for lifecycle and gates; prose cannot bypass it.
