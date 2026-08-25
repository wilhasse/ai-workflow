# Supporting Methods

Use these methods when the selected playbook calls for them. Do not run every method by default.

## Trace How a System Works

1. Identify the user-visible entry point and the concrete symbols involved.
2. Follow control flow, data flow, state changes, and external boundaries end to end.
3. Inspect callers, tests, configuration, and runtime wiring.
4. Run the narrowest command that confirms uncertain behavior.
5. Return a short map with file pointers, invariants, and unresolved gaps.

## Investigate Why It Exists

Anchor the question in code, then inspect `git blame`, file history, commits, pull requests, issues, documentation, and available operational evidence. Separate direct rationale from inference. Surface contradictions and sources that were unavailable or searched without results.

## Architect Before Coding

Write the caller's desired usage first. Sketch the core types, signatures, ownership, module boundaries, and failure behavior with pseudocode or unimplemented bodies. Produce at least two distinct shapes for contested decisions. Choose against explicit criteria, then implement against the chosen contract. Redesign if repeated implementation friction disproves the sketch.

## Arena

Use parallel candidates for multiple valid designs or artifacts. Give every candidate the same contract and separate output location. Compare complete results against a task-specific rubric, select one base, graft only compatible strengths, and verify the synthesized artifact.

## Swarm

Partition a coverage problem into disjoint slices. Define the completeness matrix first. Give each worker one slice and a common return schema. Aggregate gaps and overlaps, then run a final coverage check in the coordinator.

## Adversarial Review

Review the actual diff from independent angles such as behavior, architecture, security, maintainability, and test quality. Verify findings against current code before acting. Classify each as fix, dismiss with evidence, or unresolved. Rerun checks after accepted fixes.

## Test-Driven Bug Fix

Choose the closest cheap executable test. Add the smallest regression test, confirm it fails for the intended reason, implement the root-cause fix, confirm the test passes, then run adjacent checks. If a useful test would require brittle mocks or broad harness work, state why and use a stronger executable reproduction.

## Blast-Radius Check

List direct callers, consumers, persisted formats, configuration, concurrency, permissions, and deployment surfaces touched by the change. For each plausible regression, name the invariant or check that makes it safe. Do not declare safety from file count alone.

## Writing and Comment Cleanup

Use short declarative sentences and concrete nouns. Remove puffery, duplicated summaries, fake quotations, vague claims, and unnecessary headings. Keep comments only for external constraints or non-obvious reasons the code cannot express. Preserve license headers and public API documentation.

## Decision Trail

For long or autonomous work, keep a TSV with timestamp, phase, decision, reason, evidence, and result. Use `scripts/decision-log.sh` when convenient. Keep the log local unless auditability makes it part of the requested deliverable.
