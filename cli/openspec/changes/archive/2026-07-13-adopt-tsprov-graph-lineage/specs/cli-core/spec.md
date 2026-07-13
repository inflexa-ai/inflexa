## MODIFIED Requirements

### Requirement: inflexa prov lineage traverses a file's provenance

The system SHALL register `inflexa prov lineage <analysis> <ref>` under the
existing `prov` command group, resolving the analysis by id-or-name and the
record reference per the prov-lineage capability — an analysis-relative file
path, a content hash, an unambiguous hash prefix, or a search string matched
against recorded paths, command lines, and tool names — with options
`--forward` (derive-from walk), `--depth <n>` (bound the walk; default
unbounded up to the prov-lineage safety ceiling), and `--format tree|json|dot`
(default `tree`). The action SHALL live in `src/modules/prov/lineage.ts` and be
lazy-imported from `src/cli/index.ts`. An analysis with no stored provenance SHALL
fail with an actionable message, not an empty walk. An unknown `--format` value
SHALL fail listing the accepted values.

#### Scenario: Lineage from the command line

- **WHEN** `inflexa prov lineage my-analysis runs/run-001/step-de/output/results.csv` is run for an analysis whose document records the file
- **THEN** stdout renders the backward lineage tree: the producing command (with exit code, step, and run) and its inputs indented beneath, recursively

#### Scenario: The subcommand is discoverable

- **WHEN** `inflexa prov --help` is run
- **THEN** `lineage` is listed alongside `export`, `verify`, and `verify-file`

#### Scenario: dot format is accepted

- **WHEN** `inflexa prov lineage my-analysis <file> --format dot` is run
- **THEN** stdout is the Graphviz digraph rendering per the prov-lineage capability, and `--format svg` fails listing `tree`, `json`, and `dot`

#### Scenario: A search string works from the command line

- **WHEN** `inflexa prov lineage my-analysis heatmap` is run and no exact path or hash matches but one recorded path contains `heatmap`
- **THEN** stdout renders that file's lineage exactly as if the full path had been given
