## 1. Resolve open decisions

- [ ] 1.1 Fix cap values for `kinds`, `axes`, and notable `files` (starting points ~30 / ~8 / ~50); confirm the caps bind the write path only, since reads of legacy rows are uncapped
- [ ] 1.2 Decide where the scan script lives — baked into `sandbox-base` (manual per-environment image release) or written to the sandbox at exec time (ships on the normal harness path); design leans write-at-exec
- [ ] 1.3 Confirm coverage surfaces on `inspect_data_profile` and the ledger without driving `decideDataProfileAction`

## 2. Input scan

- [ ] 2.1 Define the manifest types: per-file entry (path, size, extension chain, magic-byte format, header readout), `kind`, `axis`, entity key sets, unmatched bucket, coverage counts
- [ ] 2.2 Implement the tree walk with bounded prefix reads and magic-byte format detection; assert no full-file decode
- [ ] 2.3 Implement header readout per recognised format (gzip member, VCF `##`/`#CHROM`, delimited-text first line + delimiter sniff, container root keys, document page count)
- [ ] 2.4 Implement filename tokenisation → varying positions → kinds and axes, emitting cardinality plus a bounded sample of distinct values per axis
- [ ] 2.5 Implement cross-kind entity key-set overlap reporting; never merge non-corresponding key sets
- [ ] 2.6 Implement the unmatched bucket (count + bounded path sample) and coverage counts
- [ ] 2.7 Unit-test the pure grouping logic: repeating set → one kind; nested positions → per-axis cardinalities; `tumor`/`normal` value shape distinguishable from ids; 3000 unpatterned files → one bucket, not 3000 kinds; overlap gaps named
- [ ] 2.8 Wire the scan as a sandbox exec and expose `scan_inputs` (accepts a path) on the data-profiler roster

## 3. Output schema and persisted record

- [ ] 3.1 Add `KindSchema` and `AxisSchema` to `schemas/data-profile-schemas.ts`; add `kinds`/`axes` to `ProfilerOutputSchema` with `.max()` caps and cap `files`
- [ ] 3.2 Remove `tiTvRatio`/`gcContent` from the `metrics` field description so the schema stops advertising per-file quality measures
- [ ] 3.3 Widen `DataProfileResult` in `state/data-profile.ts`: add optional `kinds`, `axes`, `inputSignature`, `coverage`; move `inputFileIds` required → optional; fix the compile errors that surfaces
- [ ] 3.4 Update `buildDataProfileResult` to project kinds/axes and emit `inputSignature`; stop emitting the full `inputFileIds`/`inputFiles` arrays
- [ ] 3.5 Implement the order-independent input signature (canonical ordering, digest over identity + size + mtime) with a unit test for order independence
- [ ] 3.6 Update `isDataProfileStale` to prefer `inputSignature`, falling back to `inputFileIds` for legacy rows, and treating a snapshot with neither as drift
- [ ] 3.7 Test legacy compatibility: a row carrying only `summary`/`files`/`inputFileIds`/`profiledAt` renders and compares correctly

## 4. Readers

- [ ] 4.1 Update `buildDataProfileOrientation` to render kinds first within the existing 1200-char clamp, falling back to `files` when `kinds` is absent
- [ ] 4.2 Add `scope: "kinds"` to `inspect_data_profile`; report the scope unavailable (not empty) for pre-kinds snapshots
- [ ] 4.3 Make `inspect_data_profile` report described-file count and dataset file count distinctly, directing the agent to the kinds scope and workspace listing when they differ
- [ ] 4.4 Update the tool description to match, without advertising distinctions the implementation cannot produce

## 5. Indexing

- [ ] 5.1 Replace the per-file indexing loop with kind-tier (`type: "input-kind"`) and entity-tier (`type: "input"`) entry construction, templated from the kind description and the entity's axis values
- [ ] 5.2 Batch embedding and upsert (~256 per request) using the existing array-shaped interfaces
- [ ] 5.3 Verify `type: "input"` retains its meaning so existing filtered searches keep matching
- [ ] 5.4 Test: 3513 files / 4 kinds / 1171 entities produces 4 + 1171 entries, no per-file entries, and batched requests rather than one per entry

## 6. Workflow body and agent

- [ ] 6.1 Run the scan before the agent loop in `tasks/data-profile.ts` and assemble the briefing from the manifest, removing the inlined per-path list
- [ ] 6.2 Emit the `Scanning input files` activity before the scan; keep exactly one terminal activity
- [ ] 6.3 Raise `DEFAULT_DEADLINE_MS` so provisioning plus the scan cannot exhaust the whole-profile budget before the agent starts
- [ ] 6.4 Lower `defaultMaxSteps` on the data-profiler agent (85 → ~30) and replace the per-file-pass comment justifying 85

## 7. Prompt

- [ ] 7.1 Add the purpose statement (orientation record; QC belongs to analysis steps)
- [ ] 7.2 Replace the orientation section: consume the injected manifest; `scan_inputs`/`list_files` for exploration beyond it
- [ ] 7.3 Keep Stage 1 identity work; add that detected axes and their cardinalities are design evidence
- [ ] 7.4 Add the stage for naming kinds and labelling axes, stating the manifest is a proposal the agent may split, merge, or relabel
- [ ] 7.5 Add the notable-singletons stage and the dataset-level concerns stage (including scan-derived completeness)
- [ ] 7.6 Add the explicit Do-NOT section (no per-file profiling, no member enumeration, no full-file decode, and the named excluded quality measures)
- [ ] 7.7 Delete the per-format QC checklists, folding surviving identity signals into the kinds stage
- [ ] 7.8 Add the one-example-per-kind sampling rule; keep the existing "do not `read_file` data files" rule

## 8. Verify

- [ ] 8.1 `openspec validate data-profile-orientation --strict`
- [ ] 8.2 Harness typecheck, lint, and unit tests
- [ ] 8.3 End-to-end profile against a synthetic large tree (thousands of files, ≥2 kinds, ≥1 axis): assert kind count, entity count, index entry counts, coverage, and that wall time is independent of file count
- [ ] 8.4 End-to-end profile against a small tree (2 files, no axis): assert it degenerates to kinds of count 1 with no special-casing

## 9. Follow-ups (not this change)

- [ ] 9.1 Confirm the reaper owner-workflow-id and provenance socket fixes land first (`fix/sandbox-owner-annotation-provenance-socket`) — prerequisites for a profile sandbox outliving 10 minutes
- [ ] 9.2 Cortex: replace the re-derived O(n²) staleness comparison in `managed/http/analyses.ts` with `isDataProfileStale`
- [ ] 9.3 Cortex: cap the `files` array the analyses route ships to Lumen and add the dataset total; check the Lumen render before landing
