# Investigation Playbooks

## Investigation

1. Restate the exact question and define what evidence would answer it.
2. Trace the relevant system using [methods.md](methods.md#trace-how-a-system-works).
3. If intent matters, use [methods.md](methods.md#investigate-why-it-exists).
4. Test uncertain facts with read-only probes when practical.
5. Separate confirmed facts, supported inferences, unavailable evidence, and recommended action.

Stay read-only unless the user separately authorizes a change.

## Performance Issue

1. Capture a representative baseline with a stable metric and workload.
2. Trace the measured wait, allocation, CPU use, I/O, or contention. Do not optimize from code appearance.
3. Form one causal hypothesis and change one relevant variable.
4. Measure again with the same harness and enough samples to clear noise.
5. Keep only a demonstrated win, run regression checks, and report before and after values.

## Hillclimb

1. Define one target metric, realistic workloads, and regression gates.
2. Build and freeze a measurement harness after proving it distinguishes contrasting cases.
3. Record the baseline and open a decision log.
4. For each iteration, state one hypothesis, make one change, measure, and keep or revert it.
5. Stop at the target, the iteration budget, or exhausted credible hypotheses. Report every retained change and the final metric.

## Runtime Forensics

1. Reproduce the live symptom without changing production state unless authorized.
2. Add or use instrumentation that can distinguish competing explanations.
3. Capture timestamps, resource state, relevant logs, and a control case.
4. Correlate the evidence into a causal account. Label unknowns instead of patching.
5. Deliver the diagnosis and the narrowest proposed fix separately.

## Trace Forensics

1. Identify the artifact format, capture conditions, target revision, and workload.
2. Preserve the original artifact and analyze a working copy.
3. Find dominant stacks, waits, allocations, or state transitions and compare with source.
4. Test alternate interpretations against the trace rather than choosing the first plausible story.
5. Report supported cause, confidence, missing capture data, and the next discriminating measurement.
