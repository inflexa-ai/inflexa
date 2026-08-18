## 1. Open items

- [ ] 1.1 Fix the threshold at which the O(files) walk reports truncation rather than completing

## 2. Input scan — host side

- [ ] 2.1 Define the manifest types using scan vocabulary only — per-file entry (path, size, extension chain, format, wrapper), `shape`, `variablePosition` (distinct-value count + bounded value sample), cross-shape value overlap, no-shared-structure aggregate. No field named `kinds` or `axes`.
- [ ] 2.2 Add a bounded raw-byte read to the `WorkspaceFilesystem` seam; `readFile` is line/text-oriented and magic-byte detection needs raw bytes
- [ ] 2.3 Implement the recursive walk over `WorkspaceFilesystem.list`/`stat`
- [ ] 2.4 Implement magic-byte format detection covering the spec's format floor, reporting compression wrappers alongside the inner format, and `unknown` with the extension chain preserved otherwise
- [ ] 2.5 Implement filename tokenisation → shapes and their variable positions, emitting distinct-value counts, bounded value samples, and co-occurrence across positions
- [ ] 2.6 Implement cross-shape value-set overlap reporting with its gaps; never present overlapping shapes as sharing an axis
- [ ] 2.7 Implement the no-shared-structure aggregate (count + bounded path sample)
- [ ] 2.8 Unit-test the pure observation logic with no container: repeating structure → one shape with its value sample; nested positions → per-position counts, not a flat total; `tumor`/`normal` reported as values, not just a count of 2; 3000 unstructured files → one aggregate, not 3000 shapes; overlap gaps named; unknown format still joins a shape
- [ ] 2.9 Assert the manifest type contains no field named `kinds` or `axes`, and that no manifest field is directly assignable to the profiler output

## 3. Input scan — sandbox enrichment

- [ ] 3.1 Implement per-shape header readout through the existing `runSandboxExec` path — no new binary, nothing added to `sandbox-base`
- [ ] 3.2 Cover the decodes the format floor implies (gzip/bgzip member, VCF `##`/`#CHROM` sample columns, delimited-text header + delimiter sniff, HDF5/h5ad root keys, document page count)
- [ ] 3.3 Bound enrichment to a fixed number of files per shape; assert decode count scales with shapes, not files
- [ ] 3.4 Expose `scan_inputs` (accepts a path) as a `defineTool` on the data-profiler roster, running the host walk directly and reaching into the sandbox only for enrichment

## 4. Output schema and persisted record

- [ ] 4.1 Add `KindSchema` (including the required "what one member represents" field, distinct from the description) and `AxisSchema` (required agent-supplied label) to `schemas/data-profile-schemas.ts`; add `kinds`/`axes` to `ProfilerOutputSchema` with `.max()` caps and cap `files`
- [ ] 4.2 Remove `tiTvRatio`/`gcContent` from the `metrics` field description so the schema stops advertising per-file quality measures
- [ ] 4.3 Widen `DataProfileResult` in `state/data-profile.ts`: add optional `kinds`, `axes`, `inputSignature`, `coverage`; move `inputFileIds` required → optional; fix the compile errors that surfaces
- [ ] 4.4 Update `buildDataProfileResult` to project kinds/axes and emit `inputSignature`; stop emitting the full `inputFileIds`/`inputFiles` arrays
- [ ] 4.5 Implement the order-independent input signature (canonical ordering, digest over identity + size + mtime) with a unit test for order independence
- [ ] 4.6 Update `isDataProfileStale` to prefer `inputSignature`, falling back to `inputFileIds` for legacy rows, and treating a snapshot with neither as drift
- [ ] 4.7 Test legacy compatibility: a row carrying only `summary`/`files`/`inputFileIds`/`profiledAt` renders and compares correctly
- [ ] 4.8 Compute coverage deterministically by matching submitted kind patterns against the scanned file set; assert it is not derived from the scan's own shapes

## 5. Readers

- [ ] 5.1 Update `buildDataProfileOrientation` to render kinds first within the existing 1200-char clamp, falling back to `files` when `kinds` is absent
- [ ] 5.2 Add `scope: "kinds"` to `inspect_data_profile`; report the scope unavailable (not empty) for pre-kinds snapshots
- [ ] 5.3 Make `inspect_data_profile` report described-file count and dataset file count distinctly, directing the agent to the kinds scope and workspace listing when they differ
- [ ] 5.4 Update the tool description to match, without advertising distinctions the implementation cannot produce

## 6. Indexing

- [ ] 6.1 Replace the per-file indexing loop with kind-tier (`type: "input-kind"`) and entity-tier (`type: "input"`) entry construction, templated from the kind description and the entity's axis values
- [ ] 6.2 Batch embedding and upsert (~256 per request) using the existing array-shaped interfaces
- [ ] 6.3 Verify `type: "input"` retains its meaning so existing filtered searches keep matching
- [ ] 6.4 Test: 3513 files / 4 kinds / 1171 entities produces 4 + 1171 entries, no per-file entries, and batched requests rather than one per entry

## 7. Workflow body and agent

- [ ] 7.1 Run the scan before the agent loop in `tasks/data-profile.ts` and assemble the briefing from the manifest, removing the inlined per-path list
- [ ] 7.2 Emit the `Scanning input files` activity before the scan; keep exactly one terminal activity
- [ ] 7.3 Set `DEFAULT_DEADLINE_MS` to 20 minutes
- [ ] 7.4 Keep `defaultMaxSteps` at 85; remove the stale comment justifying it as "one programmatic pass per input file", since output size is now bounded by the schema caps rather than the step budget

## 8. Prompt

- [ ] 8.1 Add the purpose statement (orientation record; QC belongs to analysis steps)
- [ ] 8.2 Replace the orientation section: consume the injected manifest; `scan_inputs`/`list_files` for exploration beyond it
- [ ] 8.3 Keep Stage 1 identity work; add that detected axes and their cardinalities are design evidence
- [ ] 8.4 Add the grouping stage: the manifest reports observations and the agent decides the kinds. State that kinds need not match observed shapes, require naming what one member represents, and require labelling each axis
- [ ] 8.5 Add the notable-singletons stage and the dataset-level concerns stage (including scan-derived completeness)
- [ ] 8.6 Add the explicit Do-NOT section (no per-file profiling, no member enumeration, no full-file decode, and the named excluded quality measures)
- [ ] 8.7 Delete the per-format QC checklists, folding surviving identity signals into the kinds stage
- [ ] 8.8 Add the one-example-per-kind sampling rule; keep the existing "do not `read_file` data files" rule

## 9. Verify

- [ ] 9.1 `openspec validate data-profile-orientation --strict`
- [ ] 9.2 Harness typecheck, lint, and unit tests
- [ ] 9.3 End-to-end profile against a synthetic large tree (thousands of files, ≥2 shapes, ≥1 variable position): assert kind count, entity count, index entry counts, coverage, and that wall time is independent of file count
- [ ] 9.4 End-to-end profile against a small tree (2 files, no axis): assert it degenerates to kinds of count 1 with no special-casing
- [ ] 9.5 Adversarial grouping case: a tree whose observed shape merges two analytically distinct sets (e.g. a `tumor`/`normal` variable position) — assert the agent splits it rather than ratifying the shape

## 10. Follow-ups (not this change)

- [ ] 10.1 Cortex: replace the re-derived O(n²) staleness comparison in `managed/http/analyses.ts` with `isDataProfileStale`
- [ ] 10.2 Cortex: cap the `files` array the analyses route ships to Lumen and add the dataset total; check the Lumen render before landing
- [ ] 10.3 Revisit the entity attribute join (metadata column whose values match the entity key set) — deferred, and cheap to add later because the index is a re-runnable projection
