# Proposal

## Why

The web client Flamme filters the runs and the artifacts of an analysis on the client, because the harness reads cannot filter them. Thus Flamme reads many pages to find one run or one file, and some of its counts are not exact. Three GitHub issues name the gaps:

- #692: no run read finds a run by a part of its plan title or of its run id. The run rows hold no title. The title is in the stored plan (`src/state/plans.ts:135-144`), thus a filter after the page breaks the page and the total.
- #694: the paged artifact read has no filter by the extension of a file, and it gives no count of each kind of file (`src/state/artifacts.ts:288-338`). Flamme takes the kind of a file from its extension. The `file_type` of a row comes from its folder (`src/schemas/artifact-manifest.ts:33-46`), thus it does not give that kind.
- #695: the paged artifact read finds a file only by a part of its path (`src/state/artifacts.ts:300`). It has no filter for an exact path.

The harness is the product core. Thus the reads come first in the harness, and the cli connects them in a companion change with the same name.

## What Changes

- `queryRunsByAnalysis`, `queryRunsByThread`, and `queryActiveRunsByAnalysis` take an optional text `q`. With `q`, a read gives only the runs whose run id or plan title holds the text, with no regard to case. The order and the window of each read do not change.
- A new read `countRunsByAnalysis` gives the count of the runs of an analysis that the same optional `q` selects. The package root exports it.
- `queryArtifactPage` takes the optional filter `path`, which selects the row whose path is equal to the value.
- `queryArtifactPage` takes the optional filter `extensions`, a list of extensions in lower case. It selects the rows whose path has one of these extensions.
- `queryArtifactPage` gives `extensionCounts`: the count of the selected rows for each extension, and for the rows with no extension. The read still sends at most two statements. The package root exports the type of an entry.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `artifact-manifest`: the paged ledger read gets the exact-path filter, the extension filter, and the count of each extension. The package root exports the type of the count.
- `run-state-persistence`: the run query helpers take an optional text filter, and a new helper counts the runs that the filter selects.

## Impact

- Harness code: `src/state/runs.ts`, `src/state/artifacts.ts`, `src/state/index.ts`, `src/index.ts`, and the tests `src/state/runs.test.ts` and `src/state/artifacts.page.test.ts`.
- Database: no migration. The exact-path filter uses the primary key `(analysis_id, path)`. The text filter of the runs reads the plan of each run of the analysis through the primary key of `cortex_plans`.
- Embedders: each new member is optional, except `extensionCounts` of `ArtifactPage`. A host that makes an `ArtifactPage` value, for example a test double, must give it. The cli does this in its companion change.
