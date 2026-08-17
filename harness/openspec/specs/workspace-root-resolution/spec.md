# workspace-root-resolution Specification

## Purpose

Define the seam through which the harness locates every analysis's on-disk
workspace: `resolveWorkspaceRoot(resourceId)` maps a resource id to the
absolute host directory of that resource's tree. The embedder owns *where* a
workspace lives (the CLI: beside the user's data under its anchor folder; a
managed deployment: the session PVC); the harness owns the layout *inside*
the root (workspace-layout). Registered once per process — the DBOS
register-once constraint binds the closed-over *function*, whose *result*
varies per resource — which is what makes per-resource roots possible at all.
## Requirements
### Requirement: The workspace root is resolved through an embedder-supplied seam

The harness SHALL derive every host-side workspace path through a single construction-time dependency, `resolveWorkspaceRoot(resourceId) → absolute path`, supplied by the embedder at the composition root and closed over once at workflow registration. The returned path IS the analysis workspace tree root: the harness joins its own interior layout (`data/`, `runs/{runId}/{stepId}/…`, `reports/`, `report-sessions/`) directly onto it, with no `{resourceId}` path segment on the host. No harness module SHALL accept or derive a global session base (`sessionsBasePath` / `sessionPath` / `SESSION_PATH`).

#### Scenario: All consumers derive from the resolver

- **WHEN** any harness surface needs a host path for resource `A` (sandbox mount source, post-step summary write, synthesis persist, data-profile scratch, report-session page dir, workspace filesystem read)
- **THEN** the path SHALL be `resolveWorkspaceRoot("A")` joined with a tree-relative subpath, and no other base SHALL be consulted

#### Scenario: Roots vary per resource within one process

- **GIVEN** one registered process whose embedder maps resource `A` to `/projects/x/.inflexa/analyses/a` and resource `B` to `/projects/y/.inflexa/analyses/b`
- **WHEN** workflows for both resources run
- **THEN** each resource's files land under its own root — the single registration does not force a shared base

### Requirement: Resolver realizations are injective, durable, and stable during a run

An embedder's `resolveWorkspaceRoot` realization SHALL be injective (two live resources never resolve to the same root — the harness treats the root as exclusively owned), SHALL resolve from durable host state so a recovered workflow on a fresh process resolves correctly, and SHALL return a stable result for a resource while that resource has an active run — the harness records derived paths in durable step outputs, so mid-run root changes are unsupported and the embedder is responsible for preventing them.

Injectivity is a property of *live* resources only, and the embedder SHALL keep it true across a resource's deletion: if a root is derived from a reusable key (a name, a slug), the previous occupant's tree SHALL be moved out of the derived location before that key can be re-issued, so a new resource never resolves onto a deleted one's artifacts.

A realization MAY memoize its resolutions provided the memo is process-local and starts empty, so recovery on a fresh process still derives from durable state; a memo SHALL be invalidated by any in-process action that moves a root.

Resolution failures SHALL be signalled by throwing. That contract is scoped to callers whose failure protocol is an exception — above all DBOS workflow and step bodies, where only a throw records a step as durably failed. A caller that promises `Result` (the workspace read seam) SHALL convert the throw into its own error value at its boundary rather than let it escape into a caller that only incidentally catches it.

#### Scenario: Recovery re-resolves from durable state

- **GIVEN** a workflow for resource `A` interrupted by a host crash, and the resource's root relocated (by deliberate user action) before restart
- **WHEN** DBOS recovery re-dispatches the workflow on a new process
- **THEN** path derivation goes through the resolver again and lands in the current root — no stale absolute path is replayed from workflow input

#### Scenario: Unknown resource fails the step loudly

- **WHEN** resolution fails inside a DBOS workflow or step body (unknown resource id, unresolvable root)
- **THEN** the failure SHALL cross the DBOS boundary as a throw (via the sanctioned `unwrapOrThrow` bridge where the realization returns a Result), so the step is durably recorded as failed — never returned as an err value that DBOS would cache as success

#### Scenario: A deleted resource's tree does not become a new resource's tree

- **GIVEN** resource `A` whose root derives from a reusable key, and a tree of run artifacts beneath it
- **WHEN** `A` is deleted and a new resource `B` is created that derives the same key
- **THEN** `resolveWorkspaceRoot(B)` resolves onto an empty tree — `A`'s artifacts were moved out of the derived location as part of deleting it

#### Scenario: A memoized root is invalidated when the root moves

- **GIVEN** a realization that memoizes resolutions in process memory
- **WHEN** the embedder moves resource `A`'s root in that same process
- **THEN** the memo entry for `A` is dropped, and the next resolution returns the new root

### Requirement: Container-side paths are independent of the resolved root

Sandbox containers SHALL continue to mount the analysis tree at `/{resourceId}` (read-only) with the step's writable root nested at `/{resourceId}/runs/{runId}/{stepId}` (read-write), regardless of where the resolver placed the tree on the host. Host↔container path mapping SHALL be `containerPath = "/" + resourceId + "/" + relative(workspaceRoot, hostPath)` and its inverse — the shared formula in `workspace/paths.ts` (`toSandboxPath` and the resolve direction).

#### Scenario: Host location does not leak into the container

- **GIVEN** resource `A` whose root resolves to `/home/u/proj/.inflexa/analyses/slug-a`
- **WHEN** a sandbox for step `s1` of run `r1` is created
- **THEN** the container sees `/A` (RO) and `/A/runs/r1/s1` (RW), and a file written to `/A/runs/r1/s1/output/x.csv` lands at `/home/u/proj/.inflexa/analyses/slug-a/runs/r1/s1/output/x.csv` on the host

