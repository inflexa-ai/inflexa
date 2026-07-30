## 1. Bound connection acquisition

- [x] 1.1 Add a connection-acquisition timeout to the app pool's options in `src/lib/storage.ts`, with the constant homed beside the other pool constants in `src/runtime/pools.ts`. Start at 30s: long enough that a healthy pool under burst never trips it, short enough that a genuinely wedged caller surfaces well inside a human's patience
- [x] 1.2 Comment the constant with the invariant it protects (an unbounded wait gives a caller no failure mode and can stall its in-flight guard permanently), not the value
- [x] 1.3 Add a test that a saturated pool rejects a further acquisition instead of waiting indefinitely

## 2. The single-stream reader

- [x] 2.1 Create the run-event stream module under `src/` (sibling to the run-observation seam), exporting the subscription type and its implementation
- [x] 2.2 Implement reading one workflow's `"events"` stream to completion, converting raw stream values into typed chat data parts and rejecting values that do not match the contract
- [x] 2.3 Contain per-part handler failures: log through the injected `Logger` and continue (never rethrow into the read loop)
- [x] 2.4 Unit-test the single-stream path against a real Postgres via `withSchema`: parts arrive in write order, and a throwing handler does not end the read

## 3. Reconciling fold

- [x] 3.1 Implement the latest-wins-by-id fold, reading each part type's `reconciling` flag from `PART_REGISTRY` rather than a local list
- [x] 3.2 Ensure non-reconciling parts pass through in write order, exactly once
- [x] 3.3 Unit-test the fold in isolation (pure input → output): superseded reconciling ids collapse to their current value; non-reconciling parts keep their full history

## 4. Parent + child fan-in

- [x] 4.1 Implement child discovery by reading the run's step-execution rows for recorded child workflow ids
- [x] 4.2 Subscribe the parent immediately and each discovered child as it appears, tracking subscribed workflow ids so none is opened twice
- [x] 4.3 Re-check for new children while the run remains active, and stop re-checking once it is terminal
- [x] 4.4 Isolate child-stream failures: one failing child logs and does not stop the parent or the remaining children
- [x] 4.5 Settle the returned promise only when the run is terminal and every opened stream has drained

## 5. Lifecycle and cancellation

- [x] 5.1 Honour the caller's `AbortSignal`: stop delivering parts and settle promptly, tearing down every open stream read
- [x] 5.2 Verify a subscription started against an already-terminal run settles without hanging
- [x] 5.3 Test mid-run attach end to end against a real Postgres: a subscription started after a run is underway receives the earlier parts and converges on current state

## 6. Public surface

- [x] 6.1 Export the subscription and its types from `src/index.ts`, beside the existing observation seam exports
- [x] 6.2 Verify no durability-engine type appears in the exported signature
- [x] 6.3 Run `bun run typecheck`, and lint the changed files with `bunx eslint <paths>`. The repo-wide `bun run lint` currently aborts on `scripts/smoke.mjs` — the typed-lint rules have no `parserOptions` for that file — which reproduces identically on `origin/main` and is not this change's to fix. Do not let it mask a real finding in the changed files

## 7. Verify

- [x] 7.1 Run the full harness suite against a Postgres started with podman, and confirm no regressions
- [x] 7.2 Run `bun run format:file` on every changed file under `src/`
- [x] 7.3 Validate the change with `openspec validate --change run-event-stream-read-seam`
