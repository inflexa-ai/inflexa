# cli-core Delta Specification

## ADDED Requirements

### Requirement: inflexa prov lineage traverses a file's provenance

The system SHALL register `inflexa prov lineage <analysis> <file>` under the
existing `prov` command group, resolving the analysis by id-or-name and the file
reference per the prov-lineage capability, with options `--forward` (derive-from
walk), `--depth <n>` (bound the walk; default unbounded up to the prov-lineage
safety ceiling), and `--format tree|json`
(default `tree`). The action SHALL live in `src/modules/prov/lineage.ts` and be
lazy-imported from `src/cli/index.ts`. An analysis with no stored provenance SHALL
fail with an actionable message, not an empty walk.

#### Scenario: Lineage from the command line

- **WHEN** `inflexa prov lineage my-analysis runs/run-001/step-de/output/results.csv` is run for an analysis whose document records the file
- **THEN** stdout renders the backward lineage tree: the producing command (with exit code, step, and run) and its inputs indented beneath, recursively

#### Scenario: The subcommand is discoverable

- **WHEN** `inflexa prov --help` is run
- **THEN** `lineage` is listed alongside `export`, `verify`, and `verify-file`

