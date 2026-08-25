# Delivery Playbooks

## Design a Playbook

When no existing playbook fits, define phases that each end in evidence. For every phase, state inputs, authorized actions, output artifact, verification, and stopping condition. Prefer a short executable procedure over an elaborate plan.

## Autonomous Run

1. State one checkable exit condition and the permitted mutation boundary.
2. Create a plan with checkpoints and a decision log.
3. Iterate through the matched engineering playbook without waiting on reversible factual choices.
4. Reassess after failed hypotheses instead of repeating the same action.
5. Stop for missing authority, an irreversible fork, or exhausted useful alternatives. Otherwise continue until the exit condition is proven.

## Session Pickup

1. Inspect repository instructions, branch, status, recent commits, and untracked files.
2. Read the provided transcript or handoff for intent, but verify every state claim locally.
3. Separate completed, in-progress, stale, and unknown work.
4. Reconstruct the next checkable step and continue without redoing verified work.

## Pause Safely

Record the goal, current phase, branch and worktree, changed files, commands and outcomes, unresolved decisions, external state, and exact next action. Preserve recoverable work without committing or publishing unless authorized.

## Multi-Phase Work

1. Define phase boundaries and the terminal evidence for each.
2. Map dependencies, ownership, files, and deployment or activation boundaries.
3. Order units so each remains reviewable and verifiable.
4. Keep a ledger for long runs and revalidate evidence when a revision changes.
5. Distinguish deferred acceptance scenarios from passed checks.

## Babysit

1. Resolve the exact PR and current head SHA.
2. Read CI, reviews, conversations, mergeability, and branch status.
3. Classify each item as actionable, stale, external wait, or noise.
4. Fix authorized repository issues narrowly and rerun the affected checks.
5. Do not merge unless the user separately authorized landing. Report the current head and remaining gates.

## Shipping

1. Resolve each PR's current head and verify it independently of author or worker reports.
2. Require behavior-level evidence for behavior changes. Treat green CI as an input, not the verdict.
3. Reverify after any new head, restack, or conflict resolution.
4. Land only the contiguous verified sequence and only with explicit merge authorization.
5. Confirm remote merge state and report anything intentionally left unmerged.

## Autopilot Full

Use one isolated owner per independent PR. Each owner builds, tests, and addresses feedback within a defined scope. The coordinator independently verifies every merge-ready head and enforces the user's merge authority. Shared files require serialization or repartitioning.

## Autopilot Stack

Build one linear stack in dependency order. Each change should be reviewable and green on its parent. Rebase or restack carefully, invalidate stale verification when SHAs change, and deliver the complete verified stack for the operator unless merging was explicitly authorized.

## Orchestrate

Use only for a genuinely multi-day program that benefits from many workers. Quantify the units and done predicate, partition non-overlapping tracks, pilot one representative unit, maintain a revision-keyed verification ledger, and reserve time to integrate verified work. If one agent can complete the work within the available session, use Autonomous Run instead.

## Worktree Cleanup

1. Audit disk usage and enumerate worktrees from `git worktree list`.
2. For each candidate, inspect dirty state, branch, remote, PR state, recent activity, and unique commits.
3. Classify as active, preserve, review, or safe to remove.
4. Present material deletions for approval with paths and recoverability.
5. Remove only exact approved targets, prune metadata, and report reclaimed space.

Never delete a worktree based only on age or merge ancestry. Squash merges and unpushed work need separate checks.

## Open a Pull Request

1. Inspect the complete diff, staged state, and commit sequence. Preserve unrelated work.
2. Run focused verification and the justified broader checks.
3. Use `type(scope): imperative subject` without a trailing period.
4. Write Why, Scope, Tradeoffs when real, Blast Radius, and Verification sections.
5. Link the issue and attach screenshots or recordings only when they prove a claim.
6. Push or open the PR only when the user authorized publication. Verify the remote SHA and returned PR state.
