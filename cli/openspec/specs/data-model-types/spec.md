# data-model-types Specification

## Purpose
The cross-cutting TypeScript domain model for the local data model — the entity shapes (`Anchor`, `Project`, `Analysis`, `AnalysisInput`), the on-disk `AnchorMarker`, and the `ID`/`Str256`/`IdOrName` aliases over the single uuidv7 scheme — that every data-model slice imports as its contract.
## Requirements
### Requirement: Id aliases over the single uuidv7 scheme

The system SHALL export the id aliases `AnchorId`, `AnalysisId`, and `ProjectId`, each defined as the shared `ID` alias in `src/lib/types.ts`. `ID` SHALL be a plain `string` documenting the single id scheme — a time-sortable `randomUUIDv7()` minted inline at the call site (DB row ids, the on-disk anchor marker, event ids). The aliases SHALL NOT be branded or nominal.

#### Scenario: Id aliases are plain uuidv7 strings

- **WHEN** another module imports `AnchorId`, `AnalysisId`, or `ProjectId`
- **THEN** each resolves to `ID` (a `string`), assignable to and from `string` with no cast
- **AND** none is a branded/nominal type

#### Scenario: No id-minting wrapper

- **WHEN** a new id is needed
- **THEN** it is minted inline with `randomUUIDv7()`, not via a `makeID()`/`newFooId()` helper

### Requirement: Validated name type and id-or-name reference

The system SHALL export a branded `Str256` type (a trimmed, non-empty string of at most 256 Unicode code points) constructed only via `str256` (validating) or `asStr256` (trusted source), and an `IdOrName` alias naming a value resolved by id **or** human name/slug. Entity name fields SHALL be typed `Str256`, never a bare `string`.

#### Scenario: A name is provably bounded

- **WHEN** a value is typed `Str256`
- **THEN** it is known to have passed the 1–256 code-point bound (measured in code points, so an emoji counts once), having been produced by `str256`/`asStr256`

#### Scenario: References carry intent

- **WHEN** a command parameter accepts an entity reference by id or name
- **THEN** it is typed `IdOrName` so the call site reads as "resolve by id OR name", not a bare `string`

### Requirement: Domain types grouped by domain

The shared domain model SHALL live under `src/types/`, grouped by domain (`anchor.ts`, `project.ts`, `analysis.ts`, `session.ts`, `events.ts`), rather than in a single monolithic file. Every exported type, its properties, and exported functions SHALL carry JSDoc.

#### Scenario: Entity shapes are shared, not module-local

- **WHEN** the `db/` layer or `lib/bus.ts` references an entity or event shape
- **THEN** it imports it from `src/types/`, keeping the infra→feature dependency direction intact

### Requirement: Anchor entity type

The system SHALL export an `Anchor` type — the invisible folder-identity record — with fields ordered identity-first: `id: AnchorId`, `createdAt: number`, `updatedAt: number`, then `cachedPath: string`, `markerWritten: boolean`, and `lastSeen: number`. There SHALL be no `driveId` field (cloud-sync mapping is deferred).

#### Scenario: Anchor shape

- **WHEN** code constructs an `Anchor` value
- **THEN** all six fields above MUST be present with the stated types
- **AND** `updatedAt` (data-edit stamp) is distinct from `lastSeen` (sighting heartbeat)

### Requirement: Project entity type

The system SHALL export a `Project` type with fields `id: ProjectId`, `createdAt: number`, `updatedAt: number`, `name: Str256`, `description: string | null`, and `tags: string[]`. There SHALL be no `archivedAt` field.

#### Scenario: Project shape

- **WHEN** code constructs a `Project` value
- **THEN** all six fields above MUST be present with the stated types
- **AND** `description` MUST be expressible as `null`

### Requirement: Analysis entity type

The system SHALL export an `Analysis` type — the primary entity — with fields ordered identity → core → foreign keys: `id: AnalysisId`, `createdAt: number`, `updatedAt: number`, `name: Str256`, `slug: string`, `outputDirectory: string | null`, `anchorId: AnchorId`, and `projectId: ProjectId | null`. There SHALL be no `goals`, `syncedAnalysisId`, or `archivedAt` fields.

#### Scenario: Analysis shape

- **WHEN** code constructs an `Analysis` value
- **THEN** all eight fields above MUST be present with the stated types
- **AND** `name` MUST be a non-null `Str256` (an analysis always has a validated name)
- **AND** `anchorId` MUST be non-nullable (an analysis always has a home anchor)
- **AND** the foreign keys `anchorId` and `projectId` come last, after the core data

### Requirement: AnalysisInput reference type

The system SHALL export an `AnalysisInput` type representing one referenced path, with fields ordered core → foreign keys and no identity triple: `path: string`, `isDir: boolean`, `analysisId: AnalysisId`, and `anchorId: AnchorId | null`. It SHALL NOT model the row with a nested `data` JSON blob.

#### Scenario: AnalysisInput shape

- **WHEN** code constructs an `AnalysisInput` value
- **THEN** the four fields above MUST be present with the stated types
- **AND** `anchorId` being `null` MUST be permitted to indicate that `path` is absolute (not relative to a tracked anchor)
- **AND** the reference carries no `id`/`createdAt`/`updatedAt` (it is not an entity)

### Requirement: AnchorMarker on-disk type

The system SHALL export an `AnchorMarker` type describing the write-once on-disk marker, with fields `schemaVersion: 1` (a literal `1`) and `anchorId: AnchorId`.

#### Scenario: AnchorMarker shape

- **WHEN** code constructs an `AnchorMarker` value
- **THEN** `schemaVersion` MUST be the literal `1`
- **AND** `anchorId` MUST be present as an `AnchorId`

### Requirement: Existing chat types preserved

The change SHALL add the new types alongside, and leave unchanged, the existing `Session`, `Message`, `TextPart`, `Part`, and `StoredMessage` types (`src/types/session.ts`) and the `BusEvent`/`StampedEvent` event contract (`src/types/events.ts`).

#### Scenario: Typecheck stays clean

- **WHEN** `bun run typecheck` runs after the change
- **THEN** it completes with no errors
- **AND** the existing chat/event types remain exported and unmodified

### Requirement: Optionality modeled as null

All optional or absent fields on the new entity types SHALL be modeled as `T | null`, never with an optional `?` modifier, mirroring the columnar row storage where every column is present and serialized explicitly.

#### Scenario: No optional modifiers

- **WHEN** the new entity types are inspected
- **THEN** no field uses the `?:` optional modifier
- **AND** every absent-capable field uses an explicit `| null` union

