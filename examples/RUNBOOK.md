# Campaign runbook

Execute only the selected, ordered work packages. The plan and resolved decisions are authoritative. Do not broaden scope or opportunistically refactor unrelated code.

Before execution, resolve ambiguous requirements, architecture decisions, acceptance criteria and safe test environments. Once running, report a concrete blocker rather than asking the owner or inventing a decision.

The pi-longtask controller owns branches, worktrees, commits, pushes, MR targets, CI gating, retries and cleanup. Workers edit only their assigned worktree; independent reviewers report concrete evidence without editing it.

Each WP must satisfy its acceptance criteria, pass configured local checks and required browser acceptance, clear independent correctness/architecture/test review, and have an open correctly targeted MR with passing CI for the current commit.

Do not restart or reconfigure shared services. Tests must not reset, migrate or destroy shared or production data. Use explicitly configured test-only storage and synthetic fixtures.

Do not merge, squash, rebase or delete any branch in the stack while the campaign is running. The controller does not perform post-campaign merging or restacking.
