# data-model-types Delta

## MODIFIED Requirements

### Requirement: Analysis entity type

The system SHALL export an `Analysis` type — the primary entity — with fields ordered identity → core → foreign keys: `id: AnalysisId`, `createdAt: number`, `updatedAt: number`, `name: Str256`, `slug: string`, `anchorId: AnchorId`, and `projectId: ProjectId | null`. There SHALL be no `outputDirectory` field (the workspace root is derived from anchor + slug, never stored) and no `goals`, `syncedAnalysisId`, or `archivedAt` fields.

#### Scenario: Analysis shape

- **WHEN** code constructs an `Analysis` value
- **THEN** all seven fields above MUST be present with the stated types
- **AND** `name` MUST be a non-null `Str256` (an analysis always has a validated name)
- **AND** `anchorId` MUST be non-nullable (an analysis always has a home anchor)
- **AND** the foreign keys `anchorId` and `projectId` come last, after the core data
