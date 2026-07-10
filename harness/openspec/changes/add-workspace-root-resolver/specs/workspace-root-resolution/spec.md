# workspace-root-resolution Delta

## ADDED Requirements

### Requirement: The workspace root is resolved through an embedder-supplied seam

The harness SHALL derive every host-side workspace path through a single construction-time dependency, `resolveWorkspaceRoot(resourceId) → absolute path`, supplied by the embedder at the composition root and closed over once at workflow registration. The returned path IS the analysis workspace tree root: the harness joins its own interior layout (`data/`, `runs/{runId}/{stepId}/…`, `reports/`, `previews/`) directly onto it, with no `{resourceId}` path segment on the host. No harness module SHALL accept or derive a global session base (`sessionsBasePath` / `sessionPath` / `SESSION_PATH`).

#### Scenario: All consumers derive from the resolver

- **WHEN** any harness surface needs a host path for resource `A` (sandbox mount source, post-step summary write, synthesis persist, data-profile scratch, report preview dir, workspace filesystem read)
- **THEN** the path SHALL be `resolveWorkspaceRoot("A")` joined with a tree-relative subpath, and no other base SHALL be consulted

#### Scenario: Roots vary per resource within one process

- **GIVEN** one registered process whose embedder maps resource `A` to `/projects/x/.inflexa/analyses/a` and resource `B` to `/projects/y/.inflexa/analyses/b`
- **WHEN** workflows for both resources run
- **THEN** each resource's files land under its own root — the single registration does not force a shared base

### Requirement: Resolver realizations are injective, durable, and stable during a run

An embedder's `resolveWorkspaceRoot` realization SHALL be injective (two live resources never resolve to the same root — the harness treats the root as exclusively owned), SHALL resolve from durable host state (not process memory) so a recovered workflow on a fresh process resolves correctly, and SHALL return a stable result for a resource while that resource has an active run — the harness records derived paths in durable step outputs, so mid-run root changes are unsupported and the embedder is responsible for preventing them.

#### Scenario: Recovery re-resolves from durable state

- **GIVEN** a workflow for resource `A` interrupted by a host crash, and the resource's root relocated (by deliberate user action) before restart
- **WHEN** DBOS recovery re-dispatches the workflow on a new process
- **THEN** path derivation goes through the resolver again and lands in the current root — no stale absolute path is replayed from workflow input

#### Scenario: Unknown resource fails the step loudly

- **WHEN** resolution fails inside a DBOS workflow or step body (unknown resource id, unresolvable root)
- **THEN** the failure SHALL cross the DBOS boundary as a throw (via the sanctioned `unwrapOrThrow` bridge where the realization returns a Result), so the step is durably recorded as failed — never returned as an err value that DBOS would cache as success

### Requirement: Container-side paths are independent of the resolved root

Sandbox containers SHALL continue to mount the analysis tree at `/{resourceId}` (read-only) with the step's writable root nested at `/{resourceId}/runs/{runId}/{stepId}` (read-write), regardless of where the resolver placed the tree on the host. Host↔container path mapping SHALL be `containerPath = "/" + resourceId + "/" + relative(workspaceRoot, hostPath)` and its inverse — the shared formula in `workspace/paths.ts` (`toSandboxPath` and the resolve direction).

#### Scenario: Host location does not leak into the container

- **GIVEN** resource `A` whose root resolves to `/home/u/proj/.inflexa/analyses/slug-a`
- **WHEN** a sandbox for step `s1` of run `r1` is created
- **THEN** the container sees `/A` (RO) and `/A/runs/r1/s1` (RW), and a file written to `/A/runs/r1/s1/output/x.csv` lands at `/home/u/proj/.inflexa/analyses/slug-a/runs/r1/s1/output/x.csv` on the host
