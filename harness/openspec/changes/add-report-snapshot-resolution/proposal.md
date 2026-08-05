## Why

The grounding model has one realization, and it reads an in-memory fixture map. No
code resolves a reference against a real analysis artifact. Thus the guarantee against
fabrication is a demonstration, and not a product behavior.

A second problem is membership. An analysis continues after a report session starts,
and a later run writes new artifacts under the same analysis. The artifact ledger
holds one row for each path, and it keeps no history. Thus nothing can answer which
artifacts existed at a point in time, and a report version cannot stay frozen.

## What Changes

- Add the mint of a `ReportSnapshot` for one analysis at a point in time. The mint
  reads `cortex_artifacts`, and it gives the set of artifacts that exist at that
  moment.
- Key the snapshot by the analysis-relative path. Give one entry the content hash and
  the file type.
- Add the structural validation. It reads the snapshot only, and it opens no file. It
  answers whether the path is in the snapshot, whether the hash matches, and whether
  the file type refuses the kind of the reference.
- Split resolution into two tiers. The structural tier runs on each authoring
  operation. The value tier reads the artifact one time for each version.
- Add `unreadable-artifact` to the set of failure reasons. It covers an artifact that
  a resolver cannot read as a table.
- Keep the value tier as a seam. This change gives no realization that reads a data
  file. #310 owns that realization, and it runs in the sandbox.

## Capabilities

### New Capabilities
- `report-snapshot`: the mint of a pinned artifact set for one analysis at a point in
  time. It also covers the shape of one entry and the structural validation.

### Modified Capabilities
- `report-grounding`: the set of failure reasons gains `unreadable-artifact`. The
  resolution requirement names the two tiers, and it states which tier reads a file.

## Impact

- New code under `harness/src/report-model/`. The mint reads `cortex_artifacts`
  through the state layer.
- The `UnresolvedReason` union gains one member. No code outside the harness consumes
  it, because `src/index.ts` exports no part of the report model. Thus the change is
  additive.
- The fixture resolver keeps its place in the tests.
- No new dependency, and no parser of a data file enters the harness.
- No change reaches the old report path.
