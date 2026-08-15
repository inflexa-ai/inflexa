## Why

Every citation block of the first real session failed with "not in the pinned evidence", although each PMID sits in the synthesis `keyReferences`. The agent removed the References section and inlined each citation into prose. The pin fills the artifact map, and it fills no citation list.

## What Changes

- The pin collects the `keyReferences` of each run synthesis into the snapshot citation list, as `pmid:` keys.
- The collection reads `runs/{runId}/synthesis.json` under the workspace root. An absent or unparsable synthesis gives no keys and no error.
- The session runtime gains the workspace-root seam for that read. A composition without the seam pins no citations, and the pin still lands.
- The report-session prompt states that the literature references compose as citation blocks against the pinned evidence.

## The decided boundary

The report agent gets no literature-search tool. A report version must be reproducible from its snapshot. A search at compose time cites papers that the snapshot never held. The synthesis references are the curated set that the analysis engaged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-snapshot`: a new requirement gives the citation evidence of the pin: the source, the key shape, and the absence rules.
- `report-session-agent`: the pin requirement names the citation collection, and the prompt obligations gain the References teaching.

## Impact

- `harness/src/report-model/pin-snapshot.ts` — the collection, and the correction of the stale comment.
- `harness/src/app/report-session-runtime.ts` — the workspace-root dep, threaded into the pin.
- The composition root that builds the runtime — the seam wiring.
- `harness/src/prompts/report-session.ts` — the References teaching.
- No resolver change: the citation membership check exists and stays.
