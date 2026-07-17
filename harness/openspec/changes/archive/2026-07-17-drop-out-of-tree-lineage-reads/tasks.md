# Tasks

## 1. Drop out-of-tree reads instead of failing the step

- [x] 1.1 `fillInputHashesFromDisk` — replace both bound throws with `collector.dropInput(ref)` + `continue`, logged at warn with the ref, resolved `hostPath`, and a `boundSite` discriminator (`container-prefix` / `workspace-root`).
- [x] 1.2 Keep the ENOENT and `stat`-failure throws untouched — genuine drift still fails fast.
- [x] 1.3 Update the `fillInputHashesFromDisk` doc comment and `ProvenanceCollector.dropInput`'s, which named the directory read as its only caller.
- [x] 1.4 Regression test driving the customer's `/{RID}/..` through the real `feedExecFrame` path: the step survives, its output still reconciles, the ref leaves both the tracked inputs and every record, exactly one warn names the ref + `boundSite`, and nothing is logged at error. Verified it fails against the old throw.
- [x] 1.5 Cover the other bound too (`container-prefix`) — the spec drops at both, so both are tested.

## 2. Sandbox-side: stop emitting the path at all

- [x] 2.1 `recordOp` — canonicalize with `filepath.Clean` and re-check the watch dirs at the one point all four capture layers converge, so each hook's prefix filter is a hint and the server is the boundary.
- [x] 2.2 Go tests: the customer's literal path, a traversal out of tree, the mount root itself, an in-tree read surviving, and two layers folding onto one canonical path. Verified all four guard tests fail without the fix.
- [ ] 2.3 Dispatch `lib-store.yml` to rebuild + push the sandbox images — the fix only reaches a host that re-pulls (`workflow_dispatch`-only, `:latest`).

## 3. Spec

- [x] 3.1 Delta on `artifact-manifest`: `fillInputHashesFromDisk` drops out-of-tree reads; fail-fast retained for ENOENT/stat drift.
- [x] 3.2 Delta on `sandbox-provenance-tracking`: the server canonicalizes and re-checks the watch dirs where the layers converge, so a layer's prefix filter is an optimization and the server is the boundary.
- [x] 3.3 Hand-rewrite both **Purpose** sections, which deltas do not carry: `artifact-manifest` claimed an input "resolving outside the analysis tree" was terminal (only *missing* is), and `sandbox-provenance-tracking` described the fold without naming the server as the boundary.
- [x] 3.4 Archived (`openspec archive`); both main specs updated and all 57 validate strict.

## 4. Review follow-ups

- [x] 4.1 Close the ingestion gap: an out-of-mount frame path rides verbatim onto its `InputRef` (never mount-root-prefixed, which forged an in-tree name and turned the read into phantom ENOENT drift), and separators doubled at the mount boundary collapse to the canonical relative form. The container-prefix bound is now reachable end-to-end; its regression test drives `feedExecFrame` with a literal `/etc/passwd` read.
- [x] 4.2 Count every reconcile input drop on `cortex.artifact.reconcile.input_dropped` (tagged `agent_id`, `step_id`, `reason` ∈ `directory` / `container-prefix` / `workspace-root`).
- [x] 4.3 sandbox-server: debug-log each report `recordOp` drops — a dropped report never reaches the host, so this is the only trace of a hook-filter leak on a current image.
- [x] 4.4 Spec sync: delta + main update on `exec-provenance-lineage` (verbatim out-of-mount refs, boundary canonicalization); `artifact-manifest` warn-record wording scoped to the bound that actually resolves a host path, plus the input-drop counter.
