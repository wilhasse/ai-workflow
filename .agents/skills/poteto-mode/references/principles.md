# Engineering Principles

Read only the sections that apply to the current decision. A principle earns mention in the final response only when it changed the work.

## Core

### Laziness Protocol

When sizing a change or adding abstraction, prefer deletion and the smallest change that fully solves the problem. Check whether every new layer, option, and branch earns its maintenance cost.

### Foundational Thinking

Before logic, settle core types, data structures, ownership, and shared state. Build the scaffold first when a stable contract makes later work easier to verify.

### Redesign from First Principles

When a new requirement strains the current design, sketch the system as if that requirement had existed from day one. Avoid bolting exceptions onto an obsolete shape.

### Subtract Before You Add

Remove dead paths, duplicate validation, and obsolete APIs before adding their replacement. Recheck whether the addition is still necessary after subtraction.

### Minimize Reader Load

Reduce the number of layers, hidden state transitions, and files a maintainer must traverse to answer a question. Collapse pass-through wrappers and shrink mutable scope.

### Outcome-Oriented Execution

For planned migrations, converge on the target architecture. Do not add temporary compatibility machinery unless a real rollout boundary requires it.

### Experience First

Choose the user-visible behavior before optimizing implementation convenience. Prefer fewer polished capabilities over a larger rough surface.

### Exhaust the Design Space

For novel or expensive-to-reverse decisions, compare two or three structurally distinct prototypes. Alternatives must differ in shape, not only naming.

### Build the Lever

For repetitive or non-trivial work, build the script, codemod, fixture, probe, or check that performs or proves it. A reviewer should be able to rerun the lever.

## Architecture

### Model the Domain

Encode repeated shape assumptions in a state machine, typed model, table, registry, reducer, or appropriate collection. Avoid scattered conditionals that reconstruct the domain implicitly.

### Boundary Discipline

Parse and validate external input at system boundaries. Keep internal logic typed and direct instead of repeating defensive checks throughout the core.

### Type System Discipline

Make invalid states hard to represent. Use meaningful variants and semantic types, handle every case, and do not silence the compiler with unsafe casts.

### Make Operations Idempotent

Commands and lifecycle steps should converge to the same end state after partial execution or retry. Test the second run when retries are plausible.

### Migrate Callers, Then Delete Legacy APIs

Move callers and remove the old internal API in the same controlled wave. Do not preserve a compatibility layer without an actual external contract.

### Separate Before Serializing Shared State

When concurrent actors can write the same resource, first remove the sharing through worktrees, per-worker paths, or ownership partitioning. Add locking only when shared ownership is a real invariant.

## Verification

### Prove It Works

Verify the real artifact and requested path. Compilation, mocks, healthy containers, and green CI are supporting evidence, not substitutes for behavioral proof.

### Fix Root Causes

Reproduce the symptom, trace the causal chain, and repair the earliest incorrect assumption or state transition. Do not hide failures with broad guards.

### Sequence Verifiable Units

Break multi-step work into units that each end in observable evidence. Order commits and delivery so a reviewer can follow the proof.

## Delegation

### Guard the Context Window

Delegate bounded bulk exploration when authorized. Return summaries and file pointers to the coordinator instead of raw dumps.

### Never Block on the Human

Proceed on safe, reversible implementation choices when evidence can decide them. Ask only for genuine product choices, missing authority, or irreversible actions.

## Meta

### Encode Lessons in Structure

When a rule repeats, turn it into a test, type, lint, metadata field, generator, or runtime check. Documentation is appropriate when no executable representation exists.
