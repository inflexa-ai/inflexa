## 1. Record the projection

- [x] 1.1 Wrap the turn engine's event sink in the harness display recorder, using the session's own callPath so sub-agent events are excluded.
- [x] 1.2 Change `chat` to `(emit) => AgentChat` and `ask` to `(request, emit) => Promise<AskApproval>`, and construct both over the recorded sink at every call site (TUI and REPL).
- [x] 1.3 Take the projection before the append on all three phases, with `fallbackText` on completion and `interrupted` on abort.
- [x] 1.4 Persist it in the turn value alongside the model messages and the rollup, keeping absence of the rollup a missing key rather than an `undefined` value.

## 2. Replay it

- [x] 2.1 Collapse the `toCortex` seam to a synchronous read of stored projections; drop the pool, analysis id, tool roster, card resolver and detail resolver.
- [x] 2.2 Remove the `ResultAsync` bridge and the unreachable error branch in `loadMessages`, keeping the generation check immediately before the store write.
- [x] 2.3 Retype `CortexMsg` off the replay function and drop the removed harness imports.
- [x] 2.4 Render a call with no recorded outcome as running.

## 3. Records

- [x] 3.1 Append a run-outcome record through the harness's record constructor so it carries its own projection.

## 4. Verify

- [x] 4.1 Test that an interrupted call replays as running with its recorded detail, beside a denied call that reports its own outcome.
- [x] 4.2 Update the turn-engine fakes to the turn value, keeping the assertion that a turn reporting nothing carries no rollup key.
- [x] 4.3 Make the reload seam fakes synchronous; confirm the load-interleaving tests still gate on the page read.
- [x] 4.4 Run `bun run format:file` on the changed files, then `bun run typecheck`, `bun run lint`, and `bun run test`.
