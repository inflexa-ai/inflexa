# Add the call guard of the planner

## Why

The planner loop has an iteration cap of 200 and a wall clock of 600 seconds, and nothing between them. A model that treats a tool answer as a state to poll calls the same tool with the same input again, or drifts through one query after another, until the cap and the clock end the plan at the same moment. In the Phase 0 campaign a small model did this in five of 32 runs: 164 identical calls of the package listing in one run, and 202 distinct queries of the reference listing in another. A frontier model read the same answer once and continued.

The answer of the reference listing invited the retry. It said that a store "will show up on a later call". A small model obeys tool text literally.

## What Changes

- A call guard in `src/loop/call-guard.ts` that wraps the tools of one run. The third call with an input the run already sent, or the call past the budget of one tool, answers a tool error that tells the model to continue with what it has. The service behind the tool never sees the refused call.
- The planner wraps its search tools with the guard on every plan generation. The terminal tools stay outside it.
- The unavailable answer of the reference listing states that a later call in the run gives the same answer.

No prompt changes. No seam changes. No change to the terminal tools.

## Capabilities

### New Capabilities

- `planner-call-guard`: the guard, its policy, and the attach point in the planner.

## Impact

- `src/loop/call-guard.ts`, `src/tools/research/generate-plan.ts`, `src/tools/sandbox/list-available-refs.ts`.
- An embedder changes nothing. A run that never repeats a call sees no difference.
