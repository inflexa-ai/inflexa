## MODIFIED Requirements

### Requirement: inflexa prov lineage traverses a file's provenance

The system SHALL register `inflexa prov lineage <analysis> <ref>` under the
existing `prov` command group, resolving the analysis by id-or-name and the
record reference per the prov-lineage capability — an analysis-relative file
path, a content hash, an unambiguous hash prefix, a search string matched
against recorded paths, command lines, and tool names, or a record's QName
identifier — with options `--forward` (derive-from walk), `--depth <n>`
(bound the walk; default unbounded up to the prov-lineage safety ceiling), and
`--format tree|json|dot|mermaid` (default `tree`). The action SHALL live in
`src/modules/prov/lineage.ts` and be lazy-imported from `src/cli/index.ts`. An
analysis with no stored provenance SHALL fail with an actionable message, not an
empty walk. An unknown `--format` value SHALL fail listing the accepted values.

#### Scenario: Lineage from the command line

- **WHEN** `inflexa prov lineage my-analysis runs/run-001/step-de/output/results.csv` is run for an analysis whose document records the file
- **THEN** stdout renders the backward lineage tree: the producing command (with exit code, step, and run) and its inputs indented beneath, recursively

#### Scenario: The subcommand is discoverable

- **WHEN** `inflexa prov --help` is run
- **THEN** `lineage` is listed alongside `export`, `verify`, and `verify-file`

#### Scenario: dot format is accepted

- **WHEN** `inflexa prov lineage my-analysis <file> --format dot` is run
- **THEN** stdout is the Graphviz digraph rendering per the prov-lineage capability, and `--format svg` fails listing `tree`, `json`, `dot`, and `mermaid`

#### Scenario: mermaid format is accepted

- **WHEN** `inflexa prov lineage my-analysis <file> --format mermaid` is run
- **THEN** stdout is the Mermaid flowchart source rendering per the prov-lineage capability

## ADDED Requirements

### Requirement: prov commands fail on an ambiguous analysis reference

The prov command group's analysis resolution SHALL treat a name/slug reference
that matches several analyses as ambiguous: it SHALL fail listing each matching
analysis's id, name, human-readable local creation time (the same formatting
the analyses listing uses), and the anchor folder's last-known path, so the
user recognizes and re-runs against an exact id, rather than silently
selecting the newest. A candidate whose anchor row is missing (a normal
local-state desync) SHALL render a placeholder for the path, never fail. An
exact-id reference SHALL resolve unambiguously (an id is unique by
construction), and a reference matching exactly one analysis SHALL resolve to
it. This governs the analysis-ref prov actions (`prov lineage`, `prov export`,
`prov verify`); `prov verify-file` takes a file path, not an analysis
reference, and is unaffected.

#### Scenario: An ambiguous analysis name lists the candidates

- **WHEN** `inflexa prov lineage a1 <ref>` is run and three analyses share the name/slug "a1"
- **THEN** the command fails listing each analysis's id, name, local creation time, and anchor folder path, and resolves none of them

#### Scenario: A candidate with a deleted anchor still lists

- **WHEN** one ambiguous candidate's anchor row no longer exists in the database
- **THEN** that candidate's line renders with a path placeholder and the listing still shows every candidate

#### Scenario: An exact id resolves unambiguously

- **WHEN** `inflexa prov lineage <exact-analysis-id> <ref>` is run and that id exists
- **THEN** it resolves to that analysis even when other analyses share its name

#### Scenario: A unique name still resolves

- **WHEN** `inflexa prov export my-unique-analysis` is run and exactly one analysis has that name
- **THEN** it resolves to that analysis with no ambiguity failure
