## Context

`pinReportSnapshot` (`report-model/pin-snapshot.ts`) reads the artifact ledger and fills `ReportSnapshot.artifacts`. It fills no citation, and its comment claims that nothing consumes a pinned citation list. That claim is stale: the production resolver and the fixture resolver both refuse a citation whose `idKind:id` key is absent from `snapshot.citations`. The `keyReferences` of a run live in `runs/{runId}/synthesis.json`, on disk under the workspace root. `cortex_runs` carries only a synthesis status, thus the disk is the one source.

## Goals / Non-Goals

- Goal: a citation block over a synthesis PMID resolves, and the References section returns.
- Goal: the pin stays one idempotent operation, and a degraded collection never fails it.
- Non-goal: a literature-search tool. The snapshot is the reproducibility boundary.
- Non-goal: a resolver change. The membership check exists and stays.

## Decisions

- **The collection lives beside the pin.** A function in `pin-snapshot.ts` takes the pool, the workspace root, and the analysis id. It lists the runs with `queryRunsByAnalysis`, and it reads `runs/{runId}/synthesis.json` for each run. The alternative was a collection at the spawn, and it was rejected: the gateway load pins too, and the two paths must pin one shape.
- **The extraction is lenient.** The read parses the JSON and takes `keyReferences[].pmid` where it is a non-empty string. A whole-schema parse was rejected, because a legacy synthesis would then empty the citation list of the whole analysis.
- **The key shape is the resolver shape.** Each PMID becomes `pmid:<id>`, trimmed. The keys dedupe, and they sort in code-unit order, thus the pin is deterministic over one disk state.
- **Absence is a normal condition.** An absent synthesis file, an unreadable file, and malformed JSON each give no keys and no error. An absent workspace-root seam pins no citations, logs one warning, and the pin lands. A failed run listing fails the pin, the same as a failed ledger read, because a store fault is not absence.
- **The runtime carries the seam.** `ReportSessionRuntimeDeps` gains an optional `resolveWorkspaceRoot`. The composition root that already resolves roots for the session tools passes the same seam here.
- **The read is bounded.** A synthesis file is small by construction, but the read still caps at 1 MiB. A file over the cap gives no keys, because a truncated JSON parse cannot be trusted.

## Risks / Trade-offs

- [A PMID in the synthesis is malformed] → the lenient extraction keeps any non-empty string, and the resolver echo simply never matches a real citation. The loss is one unresolvable citation, not a failed pin.
- [Two runs cite one paper] → the dedupe keeps one key, and the citation resolves the same way.

## Open Questions

None.
