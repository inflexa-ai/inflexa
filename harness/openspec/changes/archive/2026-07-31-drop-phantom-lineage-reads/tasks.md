# Tasks

## 1. Drop an input that is not present instead of failing the step

- [x] 1.1 `fillInputHashesFromDisk` — replace the `ENOENT` throw with `collector.dropInput(ref)` + `continue`, logged at warn with the ref, its resolved `hostPath`, and `dropSite: "input-enoent"`, counted with `reason: "missing"`.
- [x] 1.2 Keep the throw for a `stat` that fails any other way — a file that is there and unreadable says something is wrong with the tree.
- [x] 1.3 Rewrite the `fillInputHashesFromDisk` doc comment around the invariant (never register a hashless edge) rather than around fail-fast, naming why an absent path is not evidence of drift; extend `ProvenanceCollector.dropInput`'s and the `input_dropped` counter description with the third reason.
- [x] 1.4 Regression test driving the customer's shape through the real `feedExecFrame` path — a `.pxi` probe under a declared dependency's `scripts/` dir — plus the drop, its warn record, and the guard test on the undeclared-sibling refusal. Verified all four fail against the old throw.

## 2. Sandbox-side: never report a read that did not happen

- [x] 2.1 `recordOp` — drop a `read` report whose path is not present, at the same convergence point that canonicalizes and bounds. Only absence drops it; any other `stat` error keeps the report. Writes and deletes exempt.
- [x] 2.2 Debug-log the drop, mirroring the out-of-tree drop — a dropped report never reaches the host, so this is its only trace.
- [x] 2.3 Go tests: the phantom `.pxi` read dropped, a present file's read kept, a write to a not-yet-existing path kept. The existing watch-dir tests inject a presence probe so they keep testing the bound rather than passing on absence. Verified the new drop test fails without the fix.
- [ ] 2.4 Dispatch the image build to rebuild + push the sandbox images — the sandbox-side fix only reaches a host that re-pulls (`workflow_dispatch`-only, `:latest`).

## 3. Spec

- [x] 3.1 Delta on `artifact-manifest`: an input absent at reconcile is dropped and counted (`reason: "missing"`); fail-fast retained only for a non-`ENOENT` `stat` failure.
- [x] 3.2 Delta on `sandbox-provenance-tracking`: the server drops read reports for absent paths where the layers converge, with the reason those reports exist (the hooks report attempted operations).
- [x] 3.3 Delta on `exec-provenance-lineage`: the verbatim out-of-mount rationale no longer rests on a missing file failing the step — both are dropped, and the verbatim name is what makes the drop diagnosable.
- [x] 3.4 Hand-rewrite the **Purpose** sections deltas do not carry: `artifact-manifest` and `exec-provenance-lineage` both claimed an unhashable input is terminal.
- [x] 3.5 Archived (`openspec archive`); main specs updated and all items validate `--strict`.
