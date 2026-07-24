## ADDED Requirements

### Requirement: An inflexa command downloads a GEO Series and enrolls it as analysis inputs

The CLI SHALL provide a command that accepts a GEO Series accession (`GSE…`),
fetches the Series' processed data host-side, and enrolls the fetched files as
inputs of a target analysis through the existing add-inputs path
(`applyInputsDiff`/`addInputs`). The command SHALL resolve its target analysis
through the shared context resolution (`resolveContext`) — an explicit `--analysis`
ref, else the ambient analysis (which `run_inflexa` injects for an agent-driven
run), else the working-directory marker — so a chat request that names only the
accession targets the chat's analysis with no ref. The command SHALL NOT introduce a
separate staging, seed, or re-profile path — enrolled files stage, seed, and
re-profile exactly as any other added input.

#### Scenario: A GSE accession is enrolled as analysis inputs

- **GIVEN** a valid GEO Series accession and an existing analysis
- **WHEN** the command runs and the user approves
- **THEN** the Series' processed files are added as inputs of that analysis and reported to the user

#### Scenario: An agent-driven run targets the chat's analysis with no ref

- **GIVEN** the conversation agent running the command through `run_inflexa` in an analysis-scoped session, with only the accession in the argv
- **WHEN** the command resolves its target analysis
- **THEN** it resolves to the session's analysis via the injected ambient ref, and enrolls the Series there

#### Scenario: Enrolled files stage like any other input

- **GIVEN** a completed download
- **WHEN** the added files are staged
- **THEN** they materialize under the analysis `data/inputs` tree and join its `StagedInput` manifest identically to inputs added from local paths

### Requirement: The command resolves the processed and supplementary artifact set

For a Series accession the command SHALL resolve, from the accession, the SOFT
family file, the series matrix — including per-platform matrix parts when the Series
spans multiple platforms — and author-deposited supplementary files. The command
SHALL NOT fetch raw SRA sequencing reads.

#### Scenario: A multi-platform Series resolves each matrix part

- **GIVEN** a Series that spans more than one platform
- **WHEN** the command resolves its artifact set
- **THEN** each platform's series-matrix part is included

#### Scenario: Raw SRA reads are excluded

- **GIVEN** a Series whose samples have raw sequencing reads in SRA
- **WHEN** the command resolves its artifact set
- **THEN** the raw SRA reads are not included

### Requirement: The fetch is host-side, HTTPS-only, and size-bounded

The command SHALL fetch every artifact from the CLI host process over HTTPS,
re-verifying the scheme on the post-redirect URL, and SHALL obtain a size estimate
before transferring and honor a size cap. It SHALL fetch all artifacts to a
temporary location and enroll them only on full success, so a failed or interrupted
download enrolls no partial input set.

#### Scenario: A redirect to a non-HTTPS URL is refused

- **GIVEN** a source URL that redirects to an `http://` location
- **WHEN** the command follows the redirect
- **THEN** it refuses the transfer and enrolls nothing

#### Scenario: A failed download enrolls nothing

- **GIVEN** a download that fails partway through the artifact set
- **WHEN** the command aborts
- **THEN** no input is enrolled on the analysis

### Requirement: An invalid, unknown, or empty Series is a reported failure, not a crash

The command SHALL surface a malformed accession, one GEO does not resolve, or one
that exposes no downloadable processed files as a `Result` error it reports to the
user, enrolling nothing, and SHALL NOT throw for these expected conditions.

#### Scenario: A malformed accession is reported without enrolling

- **GIVEN** an accession that is not a well-formed GEO Series id
- **WHEN** the command runs
- **THEN** it returns an explanatory error and enrolls nothing

#### Scenario: A Series with no processed files reports the absence

- **GIVEN** a resolvable Series that exposes no downloadable processed files
- **WHEN** the command runs
- **THEN** it reports the absence and enrolls nothing

### Requirement: The command is approval-classified and agent-reachable

The command SHALL be registered with the `approval` agent policy — it writes, so it
is never `auto` and never `blocked`. It SHALL therefore be reachable by the
conversation agent through the `run_inflexa` tool, which classifies it by the
commander parse and gates it behind the in-chat approval prompt. Every argument and
option SHALL carry a description so the CLI reference generation and the agent's
`--help` discovery both succeed.

#### Scenario: The agent runs the command behind an approval prompt

- **GIVEN** the conversation agent invoking the command through `run_inflexa`
- **WHEN** the tool classifies it
- **THEN** it resolves to `approval` and runs only after the user approves the prompt

#### Scenario: The command is never auto-run

- **WHEN** the agent policy for the command is resolved
- **THEN** it is `approval`, so the command never runs without an approval decision
