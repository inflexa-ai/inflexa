## MODIFIED Requirements

### Requirement: Create a project

The system SHALL register `inflexa project new <name> [--description <d>] [--tags <t,t,...>]` as a client of the local server. The command SHALL split the comma-separated `--tags` value into a list and send the name, the description, and the tags to `POST /api/v1/projects`. The server SHALL validate `name` as a `Str256`, and it SHALL refuse a tag that holds a comma. It SHALL trim each tag, drop a blank one, and call `createProject`, which mints `id = randomUUIDv7()` and timestamps inline. A duplicate name SHALL be rejected through the `projects.name` `UNIQUE` constraint, which the server answers as 409 `conflict`. The command SHALL print the message of a refusal and exit non-zero.

#### Scenario: Create a project with tags

- **WHEN** `inflexa project new trial-42 --tags genomics,qc` runs
- **THEN** a project named `trial-42` is created with tags `["genomics", "qc"]`

#### Scenario: Duplicate name is rejected

- **WHEN** `inflexa project new trial-42` runs and a project with that name exists
- **THEN** it prints "A project named "trial-42" already exists." and exits non-zero without creating a second project

#### Scenario: Blank name is rejected

- **WHEN** `inflexa project new "   "` runs
- **THEN** the server refuses the name with `validation_error`, and the command exits non-zero without creating a project

### Requirement: List projects

The system SHALL register `inflexa project ls` as a client of `GET /api/v1/projects`, which lists projects newest first, each with its analysis count, in pages. The server SHALL read each page with one statement that counts the analyses of each project, never one count query for each project. The command SHALL read the pages until the last one, and SHALL print "No projects." when the list is empty.

#### Scenario: List shows projects with counts

- **WHEN** `inflexa project ls` runs with one project that has one analysis
- **THEN** the project is listed with an analysis count of 1

#### Scenario: Empty message

- **WHEN** `inflexa project ls` runs with no projects
- **THEN** it prints "No projects."

### Requirement: Attach, move, or clear an analysis's project

The system SHALL register `inflexa analysis set-project <analysis> [project]` as a client of the local server. It SHALL resolve the analysis through the resolve route of the server. Then it SHALL send one `PATCH {A}` with the project reference, or with `null` when the project is omitted. The server SHALL resolve the project with `findProjectByRef` BEFORE it writes, then set the analysis's `project_id` in one targeted `updateAnalysisProject` write. An omitted project clears the grouping to null. A project reference that does not resolve SHALL be refused with 404 `not_found` before any write, so a failed lookup never orphans the analysis.

#### Scenario: Attach an analysis to a project

- **WHEN** `inflexa analysis set-project x trial-42` runs
- **THEN** analysis `x` has `projectId` set to that project's id

#### Scenario: Clear an analysis's project

- **WHEN** `inflexa analysis set-project x` runs with no project argument
- **THEN** analysis `x` has `projectId` set to null

#### Scenario: Unknown project does not orphan

- **WHEN** the named project does not resolve
- **THEN** the command exits with an error and the analysis's existing `projectId` is unchanged
