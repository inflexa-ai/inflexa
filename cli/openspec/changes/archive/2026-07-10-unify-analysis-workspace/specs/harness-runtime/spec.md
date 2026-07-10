# harness-runtime Delta

## REMOVED Requirements

### Requirement: Single global session-tree base

**Reason**: Superseded by the harness's `resolveWorkspaceRoot` seam (harness change `add-workspace-root-resolver`). The prohibition on per-analysis bases guarded a DBOS constraint on closed-over *values*; the seam closes over a *function*, which is registered once yet resolves per resource. The session-tree concept (and `env.sessionsDir`) is deleted with it.
**Migration**: Consumers derive paths through the CLI's resolver realization (below). Stale `~/.local/share/inflexa/sessions/` trees are abandoned (unshipped app, no migration).

## ADDED Requirements

### Requirement: The CLI realizes the workspace-root resolver

The system SHALL wire the harness's `resolveWorkspaceRoot` seam with a realization that maps an analysis id to `join(anchorPath, ".inflexa", "analyses", slug)` by reading the analysis row (slug, anchorId) and resolving the anchor's live path from the database — durable state, so a DBOS-recovered workflow on a fresh process resolves correctly. The realization is injective by the `UNIQUE (anchor_id, slug)` constraint. Every dep bundle that previously carried `sessionsBasePath` (sandbox client, workspace filesystem, composition, data-profile, and conversation deps in `src/modules/harness/runtime.ts`) SHALL receive this realization; no global base path remains in the wiring. Resolution failure for a live workflow SHALL surface per the harness seam contract (a throw across DBOS step boundaries → the step fails durably).

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
