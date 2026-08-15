## Context

The authoring tools route each block payload into the pure draft operations (`report-model/draft-operations.ts`). `addBlock` and `changeBlock` parse the payload with the draft grammar, and then the structural tier resolves each new reference against the pinned snapshot. The three artifact reference kinds demand a `hash` field (`contracts/report-reference.ts`). The snapshot maps each path onto its hash (`report-model/reference-resolver.ts`, `ReportSnapshot.artifacts`).

## Goals / Non-Goals

- Goal: a payload reference with a path and no hash lands, and the land stamps the hash from the snapshot.
- Goal: one listing tool gives the agent the pinned set with columns, thus orientation costs one call.
- Non-goal: a change to the contract schemas. A finished document still carries a hash on every artifact reference.
- Non-goal: a change to the resolvers or to the structural tier.

## Decisions

- **The stamp is a pre-parse structural walk.** A new module in `report-model/` walks the unknown payload. The walk finds each object with an artifact reference `kind`, a string `path`, and no `hash`. Each such object takes the hash of the snapshot entry at its path. The walk runs in `addBlock` and in `changeBlock`, before the grammar parse. The alternative was a hash-optional draft grammar, and it was rejected: a parallel grammar drifts from the contract atoms.
- **An unknown path refuses at the stamp.** The walk collects each path-only reference whose path is not in the snapshot, and the operation refuses `unresolved-reference` with the paths in the detail. Without this arm, the grammar parse would refuse a missing `hash`, and that message points the agent at the wrong repair.
- **The walk fills an absent hash only.** An explicit hash never restamps, thus a stale explicit hash flows to the structural tier and refuses `hash-mismatch`. That arm serves a draft that predates a re-pin.
- **The membership read is `snapshotEntry`.** The path is agent text, thus the lookup must admit an own key only. The walk reads the one shared lookup, and the tiers cannot disagree.
- **The listing tool reads the snapshot through `openReportThread`.** It lists the entries in the code-unit order of the path: the path, the hash, and the file type. The listing is bounded by a named cap, because a staged input manifest can pin tens of thousands of files. A truncated listing carries the total count and a truncation marker. The order is deterministic, thus two calls over one snapshot give one listing.
- **Columns come from a bounded header read, for a `.csv` or a `.tsv` extension alone.** The tool takes `resolveWorkspaceRoot`, contains each path with `resolveWorkspacePath`, and reads the first line under a 16 KiB cap. `.tsv` splits on the tab, and `.csv` splits on the comma. A header with a double quote gives no columns, because a naive split misreads it. A partial trailing name from a capped line drops. An unreadable header gives no columns and no error, because absence is a normal condition.
- **The tool descriptions teach the omission.** The published payload schema keeps the full grammar, and the union already admits an omitted hash at the input boundary. The `add_block` and `change_block` descriptions state that a reference names the path and that the session stamps the hash.

## Risks / Trade-offs

- [A huge header line overflows the cap] → the read truncates at the cap and drops the last partial column name. The listing is orientation, not evidence.
- [The stamp walks a payload that is not a block] → the walk touches the artifact-reference shape alone. Every other value passes through untouched.

## Open Questions

None.
