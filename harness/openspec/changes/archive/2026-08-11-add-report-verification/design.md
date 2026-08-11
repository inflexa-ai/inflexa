## Context

The session loop composes and previews, and the resolver seam has no production realization (`agents/report-session-agent.ts:68` takes it as optional). The fixture resolver carries the assert semantics (`report-model/fixture-resolver.ts`), and the pin fills no `rows`. The version store refuses shape faults only, and it is append-only with no delete (`state/report-versions.ts:81-151`). The visual prior art drives headless Chrome through a publisher URL (`tools/report/preview-snapshot.ts`), and the session page has no URL space.

## Goals / Non-Goals

**Goals:**

- The production resolver: real reads, the hash compare, and the assert match.
- The record tool with a gate-first flow over the append-only store.
- The look-before-record rule, mechanical and model-free.
- The eyes tool for the session page, and the prompt guidance for the loop.

**Non-Goals:**

- A standing warm machine. The one-shot run won, because a machine that outlives its work has no clear payer on a managed deployment.
- A semantic judgment of prose. That needs a model, and it stays advisory and out.
- The old report path, which stays untouched.

## Decisions

### D1. One realization, three layers, and the host arm is a fast path only

The resolver keeps the one seam, thus the preview and the gate cannot disagree. Layer one is identity: membership through `snapshotEntry`, and a hash compare with `computeSha256File` at any size. Layer two is the host fast path: an in-process parse of CSV, TSV, JSON, or parquet, for a file at or under the cap. Layer three is the sandbox fall-through: an over-cap file, an unknown format, or a parse fault. On any doubt the realization falls through, thus correctness never depends on the host parser.

### D2. The cap is a composition-root value

The default cap is 16 MiB for each file. The embedder sets it at the composition root, thus a host tunes it without a harness change. The cap splits only the cell extraction. The identity compare runs host-side at every size.

### D3. The parquet read uses hyparquet

`hyparquet` is pure JavaScript, thus no native library enters the published package. It serves the under-cap arm only. An over-cap parquet file takes the fall-through, the same as each other format.

### D4. The fall-through is a one-shot workflow on the profile rails, and the script is harness-authored

The sandbox arm speaks a small seam: submit the extraction input, and get a typed result. Its realization is a one-shot DBOS workflow with the shape of the data profile. The authorization mints at the async edge, rides in the workflow input, and the body revokes it on every terminal path (`src/tasks/data-profile.ts:8-11`). The container is ephemeral, and it goes away with the work. Thus no standing machine exists, and the run bills the same way as a profile run.

The occupant differs from the profiler: the workflow runs one fixed extraction script that the harness ships as an asset, and no agent loop runs in the container. The script is Python, because pandas and pyarrow read every tabular format that the analyses write. The input is a JSON list of path and locator pairs, and the output is one JSON value map. One submission covers every fall-through file of one document pass. While no sandbox realization is wired, a fall-through reference fails with the reason `extraction-unavailable`, and the detail names the absent arm.

### D5. The assert rules extract into shared functions

The fixture resolver holds the assert match today: the tolerance compare, the percent-fraction rule, and the citation assert. Those functions move to a shared module, and both realizations call them. Thus one semantics exists, and the fixture stays the executable specification of the value tier.

### D6. The seam gains one optional `prepare` method

`prepare(references, snapshot)` is an optional method on `ReferenceResolver`. The validator calls it one time before its per-reference loop (`validate.ts:106`). The production realization batches there: it groups the references by artifact, reads each file one time, runs the one sandbox pass, and fills a cache. `resolve` then answers from the cache. The fixture ignores the method. A realization without `prepare` keeps the old behavior, thus the extension breaks no caller.

### D7. The record gate runs before the store, and nothing needs removal

The record tool runs the full validation first: the finish, the whole-document resolution through the production resolver, the chart-encoding match, and the assert match. Only a pass reaches `store.record`. The store is append-only with no delete, thus gate-first is the only order that satisfies "a failed version never exists". The one-per-thread rule stays the store's own refusal.

### D8. Look-before-record rides two durable markers

The session-state row gains two content hashes, because the row is the one durable anchor of a session. Chat runs one replica for each turn, thus an in-memory mark dies between turns. One shared function computes each hash: a JSON serialization with sorted keys, over the draft value. Each stamp and each compare calls it, thus two serializations of one document cannot split.

`rendered_document_hash` lands when the preview writes the page, thus the runtime knows which document the page shows. `seen_document_hash` lands when the eyes capture that page, and the eyes copy the rendered hash, never the current one. The record tool refuses unless the seen hash equals the hash of the current document. Thus a never-seen page cannot record, a stale look cannot count, and no model judgment joins the rule. The visual judgment itself stays advisory: the agent looks, decides, and repairs.

### D9. The eyes navigate to the file, and no publisher joins

The eyes tool opens the page with `withPage` (`lib/chrome.ts`) through a `file://` navigation, because the session tree has no URL space. It gives back the screenshot, the console errors, and the failed requests, the same shape as the prior art. A missed page — no preview ran yet — is a typed outcome, not a throw.

## Risks / Trade-offs

- [The host parse and the sandbox parse disagree on a dialect] → the host arm parses strict dialects only. Any doubt falls through, thus the sandbox answer is the reference semantics.
- [A cold container start on each over-cap pass] → the cost matches one profile run. It lands only on a pass with a fall-through file. The under-cap majority never pays it.
- [A huge page from an under-cap read] → the renderer already bounds its output, and the cap bounds the input bytes. Measure before any further bound.
- [The seen-hash rule annoys a fast agent] → the cost is one eyes call after the last preview, and the prompt teaches the order.

## Migration Plan

Additive and dormant behind the `report` thread type. The two new tools join the report-session toolset only. `src/index.ts` exports none of it. A revert is one commit.

## Open Questions

- None.
