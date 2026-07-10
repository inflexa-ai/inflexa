# Design — harden-workspace-root-seam

## Context

`add-workspace-root-resolver` turned the workspace base from a process-global string into a per-resource function. Reviewing that change surfaced three places where the seam was declared but not actually depended on, plus documentation that still described the pre-change layout. This change closes those gaps. It adds no capability; it makes the one just added load-bearing everywhere it claims to be.

## Goals / Non-Goals

**Goals:**
- The directory the harness pre-creates and the directory a sandbox mounts are the same directory on both backends, provably, not by convention.
- A seam whose contract is "throws" does not leak exceptions into a caller whose contract is "returns `Result`".
- No module specifies, or is specified by, a mount model nothing imports.

**Non-Goals:**
- Changing the `res` claim formula, the preview URL shape, or the Go mirror's shared test vector. All unchanged.
- Deciding how a managed deployment serves previews now that their disk location moved inside the workspace tree. That is a deployment question, raised separately.
- Introducing a K8s embedder. There is none in this repo; the K8s path is exercised by the stubbed `k8s-client.test.ts` shape tests only.

## Decisions

### D1 — `sessionPvcRoot` rather than "assume `{pvcRoot}/{resourceId}`"

A pod addresses a PVC by `subPath`, which is relative to the volume root, while the harness writes through its own filesystem view of that same volume. Those two coordinate systems can only be reconciled if the harness knows where the volume is mounted on *its* side. That is exactly what the old `sessionsBasePath` was, and deleting it left the K8s backend inferring the answer from `analysisId`.

Reintroducing it as `sessionPvcRoot` — scoped to the K8s backend, required only alongside `sessionPvc` — restores the structural guarantee without restoring a global base: the root still comes from the resolver, and `sessionPvcRoot` only says which volume it lives on.

*Rejected:* passing the `subPath` in from the embedder. It would let the two sides disagree, which is the bug.

*Rejected:* keeping `subPath = analysisId` and documenting the constraint. A comment is not a constraint; the failure mode is a pod silently mounting a different directory, which surfaces as an empty workspace far from its cause.

### D2 — A root outside `sessionPvcRoot` throws

`relative()` will happily return `../../elsewhere/an-1`, which K8s rejects or, worse, resolves unexpectedly. There is no correct mount for such a root, so there is no value to return. `createSandbox` runs inside a DBOS workflow body, so a throw is the durable failure signal — the same protocol `resolveWorkspaceRoot` itself uses.

### D3 — `MountPlan` loses `sessionSubPathRO`/`sessionSubPathRW`

A `subPath` is how *one* backend addresses a volume. Container paths are the contract both backends implement. Keeping the two in one struct is what let the K8s subPath drift from the resolver while the container paths tracked it: they looked like the same fact. `buildSessionSubPaths(coords, workspaceSubPath)` takes the derived path as an argument, so it cannot be computed without the resolver's answer in hand.

### D4 — The read seam converts the throw at its own boundary

`WorkspaceFilesystem` is not a DBOS body. Its methods promise `ResultAsync<_, FsError>` and back `read_file` / `grep`, which run during chat turns. Today an unresolvable root escapes as an exception and is contained only because `dispatchTool` wraps `tool.execute` in a `catch`.

That containment is real but accidental — it lives two layers away, in a module the seam does not know about, and it would evaporate the moment a non-tool caller reads the workspace. The seam converts the throw itself. `FsError`'s `read_failed` variant already carries `op`, `path`, and `cause`, so no new error shape is needed.

*Rejected:* changing `ResolveWorkspaceRoot` to return `Result`. The DBOS bodies are the majority caller, and a returned `err` crossing `DBOS.runStep` is durably cached as *success* — the exact hazard `lib/result.ts` house-rule 3 exists to prevent. The throw contract is right for them; the `Result` caller converts.

### D5 — Delete `mount-strategy.ts` rather than wire it up

Nothing imports it. Its `buildDockerMounts`/`buildPodMounts` duplicate what `docker-client.ts` and `k8s-client.ts` already build from `buildMountPlan`. Wiring it in would mean choosing which of two mount models is canonical, and the one already running in production is `mount-plan.ts`. The `workspace-profiles` requirement naming it is removed with it.

## Risks / Trade-offs

- **A K8s embedder must now supply `sessionPvcRoot`.** There is none in this repo, so nothing breaks here; a downstream deployment gets a loud throw at first sandbox creation rather than a silent mis-mount, which is the intended trade.
- **`stepWritePrefix` leaves the public barrel.** An out-of-repo importer would break. It was exported by `add-workspace-root-resolver` and never imported, including by the CLI.
- **The preview `res` claim and the on-disk preview path now differ by design.** `workspace-layout` and `contracts/content-url.ts` both say so explicitly; a host that serves previews owns the mapping. This is a real burden shifted onto a managed deployment, accepted because previews must live inside the tree the user is told holds their analysis.
