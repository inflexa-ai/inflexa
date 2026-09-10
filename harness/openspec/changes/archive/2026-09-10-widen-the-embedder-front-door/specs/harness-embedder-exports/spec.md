## ADDED Requirements

### Requirement: The root barrel carries each name that an embedder cannot otherwise write

`src/index.ts` is the curated front door of `@inflexa-ai/harness`. A name MUST
be on the front door when an embedder cannot write its own composition root
without that name. Two conditions make a name necessary:

- The name types a field of a dependency object that the barrel exports already.
  An embedder that cannot name the field cannot build the object.
- The name types a value that an exported function gives back. An embedder that
  cannot name the value cannot hold it or pass it on.

Each deep subpath MUST stay importable. The barrel is additive, and it is not a
wall. But an embedder MUST reach every name above through the package root, and
it MUST take no deep import to do so.

#### Scenario: A field type of an exported dependency object is on the front door

- **GIVEN** a dependency interface that the root barrel exports
- **WHEN** an embedder writes a literal of that interface
- **THEN** it names the type of every field through the package root

#### Scenario: A return type of an exported function is on the front door

- **GIVEN** a function that the root barrel exports
- **WHEN** an embedder holds the value that the function gives back
- **THEN** it names that value's type through the package root

#### Scenario: A deep subpath stays importable

- **WHEN** a consumer imports `@inflexa-ai/harness/<subpath>.js`
- **THEN** the import resolves, and the front door removes no deep subpath

### Requirement: The bio-tool key slice is importable from the root

The harness MUST export the `BioToolKeys` type from `src/index.ts`.

`BioToolKeys` is the slice of API keys for the external bio and chem data
sources. `ConversationAgentDeps.bioKeys` has this type, and the barrel exports
`ConversationAgentDeps` already. Thus an embedder that assembles the
conversation agent cannot write that dependency without the name.

#### Scenario: An embedder types bioKeys from the root

- **GIVEN** an embedder that builds a `ConversationAgentDeps` value
- **WHEN** it names the type of the `bioKeys` field
- **THEN** it imports `BioToolKeys` from `@inflexa-ai/harness`

### Requirement: The target-assessment row surface is importable from the root

The harness MUST export these row helpers of `cortex_target_assessments` from
`src/index.ts`:

- `insertAssessment` — the intake write of one assessment row.
- `getAssessment` — the read of one row, scoped by organization.
- `updateProgress` — the write of the progress text and the status.
- `listAssessmentsByOrg` — the page of rows of one organization.

The harness MUST also export each type that these four names accept or give
back: `InsertAssessmentInput`, `ListAssessmentsOptions`, `TargetAssessmentRow`,
`TargetAssessmentListRow`, `TargetAssessmentStatus`, and
`TargetAssessmentError`. Without a row type, a caller cannot name the value of a
read.

The terminal writers of the workflow stay off the front door. The workflow owns
`setDossier`, `markFailed`, `markAssessmentSuspended`, `markAssessmentRunning`,
and `softDeleteAssessment`. An embedder that calls one of them writes a terminal
state that the workflow is about to write again.

#### Scenario: An embedder reads an assessment row from the root

- **GIVEN** an embedder that serves the detail of one assessment
- **WHEN** it calls `getAssessment` and holds the row
- **THEN** it imports the function and `TargetAssessmentRow` from `@inflexa-ai/harness`

#### Scenario: An embedder lists the assessments of an organization from the root

- **GIVEN** an embedder that serves a list page
- **WHEN** it calls `listAssessmentsByOrg` with a limit and an offset
- **THEN** it imports the function, `ListAssessmentsOptions`, and `TargetAssessmentListRow` from `@inflexa-ai/harness`

#### Scenario: The terminal writers stay off the front door

- **WHEN** an embedder imports from `@inflexa-ai/harness`
- **THEN** `setDossier`, `markFailed`, `markAssessmentSuspended`, `markAssessmentRunning`, and `softDeleteAssessment` are absent
