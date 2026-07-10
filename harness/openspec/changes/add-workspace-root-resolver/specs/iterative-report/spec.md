# iterative-report Delta

## MODIFIED Requirements

### Requirement: Version directories are managed Cortex-side with shared assets and rollback

The runner SHALL serialize iterations per `previewId` (`withPreviewLock`),
resolve the new version as `max(latest, baseVersion) + 1`, create
`{workspaceRoot}/previews/{previewId}/v{N}` (where `{workspaceRoot}` is the
analysis's resolved workspace root — see workspace-root-resolution), copy the
base version's
`report.html.j2` forward when one exists, and symlink the version dir's `assets`
to the preview's shared `assets/`. On any failure (no outcome, agent error, or
phantom success) it SHALL remove the new version directory while leaving the
shared `assets/` untouched, and return a structured failure with `errorKind` in
`render | submit | build | timeout | internal`.

#### Scenario: A failed iteration is rolled back

- **WHEN** the builder errors or never submits for version N
- **THEN** the `v{N}` directory is removed, the shared `assets/` dir is left intact, and a failure result with an `errorKind` is returned

#### Scenario: Assets persist across versions

- **WHEN** a CSV staged into `assets/` during v1 is needed by a later version
- **THEN** it is reachable from v3 with no re-staging, because `assets/` is shared and each version dir symlinks to it
