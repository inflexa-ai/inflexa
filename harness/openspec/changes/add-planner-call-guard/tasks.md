## 1. The guard

- [x] 1.1 `guardRepeatedCalls` over a list of tools, with the identical-input limit and the per-tool budget, and a stable key over the input.
- [x] 1.2 Tests: the third identical call is refused without a call to the tool, the budget refuses past the limit, each tool counts on its own, and a new list starts at zero.

## 2. The planner

- [x] 2.1 Wrap the search tools of the planner on every plan generation, with a log line per refusal.
- [x] 2.2 Rewrite the unavailable answer of the reference listing so it does not invite a retry.

## 3. The early cap

- [x] 3.1 `stopWhen` on the run options of the agent loop, taken at the top of an iteration, with the wrap-up path.
- [x] 3.2 The terminal salvage strips the early cap from the salvage turn.
- [x] 3.3 The planner ends its search at `PLANNER_REFUSAL_LIMIT` refusals of the guard.
