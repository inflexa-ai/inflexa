# Design: package-store-rebuild

## Context

Main today bakes the packages into three layered images, and the harness
gates the mount on a store-root `current` symlink
(`harness/src/sandbox/docker-client.ts:126-135`). One pointer selects one
package set for every analysis. The spike (PR #291) proved the two-container
store, and the decision record at `docs/feat_localPackages/decisions.md`
settles sixteen decisions. This design maps those decisions onto the harness.
The record and the harvest reports carry the full rationale, and this
document does not restate them.

## Goals / Non-Goals

**Goals:**

- One farm per analysis, resolved through a required `farmSource` config.
- A config-gated resolver environment, thus a managed deployment on the old
  images keeps its behavior.
- One `inflexa.lock` per farm as the whole metadata contract.
- The `link_packages` seam, and the planner packages per step.
- The two-image build, the OCI bundle, the committed per-arch locks, and the
  per-package warm scripts.

**Non-Goals:**

- The managed store delivery, and the K8s ReadWriteOnce node pin. Both stay
  recorded open decisions.
- The CLI embedding. It lands in its own change, in `cli/openspec`.

## Decisions

Each decision cites its number in the record.

1. **`farmSource` is required, with two kinds** (D1). The optional shape gave
   `undefined` two meanings, and the compatibility kind read a pointer that
   nothing writes. A missing value must fail at compile time.
2. **The embedder declares facts, the harness never infers its host** (D1).
   One declared toolchain field gates `PATH`, `NODE_PATH`, and the
   orient-core prompt text. The absent field keeps the old environment, which
   also keeps the prompt prefix cache-stable for old embedders.
3. **One `inflexa.lock` replaces the four farm markers** (D5). The mount gate
   and the inventory then share one reader, and the pak lock embeds as a
   field. Alternative — keep `packages.txt` plus `meta.json` — rejected,
   because two readers and four files invite drift.
4. **The graph emission stays bespoke** (D10). It already uses `packaging`
   for markers, and it drops `LinkingTo`. The Syft alternative stays a note.
5. **Batch acquisition is host state, not a daemon** (D16). The provisioner
   accepts a spec set per one-shot run. A long-lived container buys only the
   start time and costs a lifecycle. See `grill_round5.md`.
6. **The provisioner entrypoint becomes subcommands** (D11). One mode each,
   one named caller each. The lease dies whole, because nothing writes it and
   its guard never fires.
7. **The image owns the interpreters, conda, and Node** (D12). A conda prefix
   does not relocate, thus it cannot join a content-addressed store.
8. **Warming is per-package scripts at catalog preparation** (D6). An
   acquisition warms nothing, because a numba entry keys on a call signature.
   The per-analysis writable cache covers everything else.
9. **R ships together with Python** (D4). The build path copies the spike
   mechanisms: the pak lock, the nested R store layout, the namespace load
   check in the sandbox image. Single-package R acquisition is new design
   with no spike reference, and the provisioner spec must define it.
10. **The workflow commits the per-arch locks back** (D3). Resolution obeys
    the manifest first and the lock second, the `npm install` model.

## Risks / Trade-offs

- [Single-package R acquisition is unexplored ground] → The provisioner spec
  defines the incremental pak resolve against the pool. The batch flight
  drops a failing spec and retries the rest, thus one hard package never
  blocks a batch.
- [A misdeclared toolchain field breaks a managed sandbox] → The absent field
  keeps the old environment. The acceptance suite runs one store-mounted
  shape and one legacy shape.
- [The K8s client drifted on main] → The rebuild starts from main code.
  Spike code copies in fragments only, thus `writableTail`, `podLabels`, the
  owner annotation, and `isAliveById` survive.
- [The lock commit-back runs in CI] → The workflow commit signs off, because
  the DCO gate blocks an unsigned commit. The spec names the workflow step.
- [The rename touches many files] → The rename table in `grill_round3.md` is
  the single source, and the specs use RENAMED deltas.

## Migration Plan

1. The harness change lands whole, with the renames. The managed embedder
   passes one `farmSource` value at its composition root and changes nothing
   else.
2. The CLI change follows in `cli/openspec`, and it binds the seams.
3. Rollback is a revert of the change. The published images and bundles are
   immutable artifacts, thus a revert leaves no broken remote state.

## Open Questions

None that block the specs. Four names stay open on purpose: the toolchain
config field, the lock subcommand, the `inflexa.lock` schema fields, and the
prompt text. Each one resolves inside the spec deltas of this change.
