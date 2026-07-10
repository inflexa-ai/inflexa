# workspace-root-resolution Delta

## MODIFIED Requirements

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
