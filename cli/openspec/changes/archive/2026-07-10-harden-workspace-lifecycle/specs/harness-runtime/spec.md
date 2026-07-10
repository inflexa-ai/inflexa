# harness-runtime Delta

## MODIFIED Requirements

### Requirement: The CLI realizes the workspace-root resolver

The system SHALL wire the harness's `resolveWorkspaceRoot` seam with a realization that maps an analysis id to `join(anchorPath, ".inflexa", "analyses", slug)` by reading the analysis row (slug, anchorId) and resolving the anchor's live path from the database — durable state, so a DBOS-recovered workflow on a fresh process resolves correctly. Every dep bundle that previously carried `sessionsBasePath` (sandbox client, workspace filesystem, composition, data-profile, and conversation deps in `src/modules/harness/runtime.ts`) SHALL receive this realization; no global base path remains in the wiring. Resolution failure for a live workflow SHALL surface per the harness seam contract (a throw across DBOS step boundaries → the step fails durably).

The realization is injective among live rows by the `UNIQUE (anchor_id, slug)` constraint. That constraint alone does NOT make it injective across a deletion, because deleting a row frees its slug: injectivity across deletion is upheld by the delete flow retiring the workspace tree out of `analyses/` before the slug can be re-issued (see analysis-service).

The realization SHALL be memoized through `workspaceRootForAnalysisId` (see path-resolution), whose memo is process-local and starts empty. This preserves the seam's recovery contract while keeping an agent's file reads off the database.

#### Scenario: One tree across all consumers

- **WHEN** an analysis is staged, profiled, and run
- **THEN** the staged files, the sandbox bind-mount source, the post-step artifact writes, and workspace filesystem reads all resolve under `<anchorPath>/.inflexa/analyses/<slug>/…`

#### Scenario: Recovery resolves from the database

- **GIVEN** a run interrupted by a crash, and the anchor folder moved (marker intact, path reconciled) before restart
- **WHEN** DBOS recovery resumes the workflow in a fresh CLI process
- **THEN** the resolver derives the workspace root from the current anchor path and the run continues against the moved tree

#### Scenario: Deleted analysis fails resolution loudly

- **WHEN** the resolver is invoked for an analysis id whose row no longer exists
- **THEN** it fails with an error that crosses the DBOS boundary as a throw, and the requesting step is recorded as failed

#### Scenario: A recreated analysis does not inherit a predecessor's root contents

- **GIVEN** an analysis was deleted and a new one created with the same name under the same anchor
- **WHEN** the resolver resolves the new analysis's root
- **THEN** the root is the same path, and it holds none of the deleted analysis's artifacts
