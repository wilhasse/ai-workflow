# Change Playbooks

## Bug Fix

1. Reproduce the reported symptom on the same surface. If blocked, state the missing capability and use translated evidence only when it tests the same behavior. Follow [Trace How a System Works](methods.md#trace-how-a-system-works).
2. Apply the confirmation gate. Proceed to source edits only when the reproduction or an equivalent executable contract failure confirms the defect. If it remains unconfirmed, stop with an inconclusive result and the next discriminating check.
3. Minimize the reproduction and trace the root cause.
4. Follow [Test-Driven Bug Fix](methods.md#test-driven-bug-fix) when the test path is cheap and reliable.
5. Implement the smallest root-cause fix and avoid unrelated cleanup.
6. Rerun the original reproduction, focused tests, and [Blast-Radius Check](methods.md#blast-radius-check).
7. Keep the failing-before and passing-after evidence visible in the work history or report.

## Feature

1. State the user-visible contract, including permissions, failure behavior, and out-of-scope cases.
2. Trace the existing path and name the core data shape.
3. Sketch ownership, types, and module boundaries before implementation when a function boundary changes.
4. Build the smallest vertical slice that reaches the real surface.
5. Add focused tests for the contract and failure path.
6. Exercise the feature end to end, inspect the diff, and check adjacent behavior.

## Refactoring

1. Pin current behavior with a characterization test, snapshot, or equivalence harness.
2. State the target structure and what will be deleted.
3. Move in small verifiable units while keeping the behavior pin green.
4. Migrate callers and delete obsolete APIs without leaving speculative compatibility layers.
5. Run the behavior pin plus broader affected tests and inspect for accidental public changes.

## Prototype

1. Name the factual decision and the competing hypotheses.
2. Define what observation would choose between them.
3. Build the lightest isolated sketch outside production paths.
4. Run or render every variant on the matching surface.
5. Record the observation, choose or reject an approach, and delete throwaway code unless the user requests it retained.

## Visual Parity

1. Capture the reference and candidate at identical viewport, state, data, fonts, and scaling.
2. Establish a repeatable screenshot or interaction sequence.
3. Compare geometry before decoration. Fix structure, spacing, typography, color, and interaction in that order.
4. Change one class of mismatch at a time and recapture.
5. Verify nearby responsive and interactive states, then save the final comparison evidence.

## Skill Authoring

1. Use the available `$skill-creator` workflow.
2. Define precise trigger and non-trigger examples.
3. Keep `SKILL.md` focused and move conditional detail into linked references.
4. Add scripts only for deterministic repeated work.
5. Run the skill validator and a realistic forward test in an isolated location.

## Evaluation

1. State the behavior under test and a small concrete rubric hidden from candidates.
2. Prepare equivalent prompts and isolated output locations.
3. Run the baseline and variant without revealing which one is being evaluated.
4. Judge outputs against the rubric and verify any factual claims.
5. Promote only a demonstrated improvement and record regressions or uncertainty.
