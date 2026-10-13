## MODIFIED Requirements

### Requirement: The step manifest is a disk walk of the writable step directory

The per-step artifact manifest SHALL be produced by `walkStepArtifacts`, which
recursively walks the step's writable directory (`writePrefix`,
`runs/{runId}/{stepId}/...`), and for each regular file emits an
`ArtifactManifestEntry` of `{ stepId, runId, path, size, type, hash }` where
`path` is relative to `writePrefix`, `hash` is the SHA-256 computed from disk via
`computeSha256File`, and `type` is inferred from the path subdirectory by
`inferArtifactType` (`output` | `figure` | `script` | `log` | `notebook`). The
walk SHALL skip directories in `IGNORED_DIRS`. The manifest SHALL NOT be built
from `ProvenanceCollector.getRecords()` — the collector holds lineage edges, not
the manifest.

`inferArtifactType` SHALL read a folder segment `figures`, `scripts`, `logs`, or
`notebooks` at the start of the path or after a `/`. Thus a relative path and a
rooted path give the same type. A path with none of these folder segments gives
`output`. A segment that only starts with a folder name, for example
`figures_raw`, is not that folder.

#### Scenario: Step produces agent-written and command-produced files

- **GIVEN** a step wrote `scripts/analysis.py` via `write_file` and then ran it, producing `output/results.csv`, `figures/volcano.png`, and `logs/run.log`
- **WHEN** `walkStepArtifacts` walks the step's writable directory
- **THEN** all four files appear in the manifest, each with a SHA-256 hash computed from disk and the type inferred from its subdirectory
- **AND** no provenance-collector record is consulted to build the manifest

#### Scenario: A top-level folder of the step gives its type

- **WHEN** `inferArtifactType` reads `figures/volcano.png`, `scripts/a.py`, `logs/run.log`, and `notebooks/n.ipynb`
- **THEN** the types are `figure`, `script`, `log`, and `notebook`

#### Scenario: A nested folder gives its type

- **WHEN** `inferArtifactType` reads `output/figures/volcano.png` and `/a1/runs/r1/s1/figures/volcano.png`
- **THEN** each type is `figure`

#### Scenario: A file outside the typed folders is output

- **WHEN** `inferArtifactType` reads `output/results.csv`, `summary.md`, and `figures_raw/x.png`
- **THEN** each type is `output`

#### Scenario: Ignored directories are not walked

- **WHEN** the step directory contains a path under an `IGNORED_DIRS` directory
- **THEN** files under that directory do NOT appear in the manifest
