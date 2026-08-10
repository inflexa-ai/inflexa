## 1. The shared assert rules

- [x] 1.1 Extract the assert functions of `src/report-model/fixture-resolver.ts` into a shared module: the tolerance compare, the percent-fraction rule, and the citation assert. The fixture calls the shared functions, and its tests stay green.

## 2. The seam extension

- [x] 2.1 Add the optional `prepare(references, snapshot)` method to `ReferenceResolver`, and the one call in `validate.ts` before the per-reference loop.
- [x] 2.2 Add `extraction-unavailable` to `UnresolvedReason` in `src/contracts/report-reference.ts`.
- [x] 2.3 Write the tests: `prepare` runs one time before the loop, and a realization without `prepare` keeps its behavior.

## 3. The production resolver

- [x] 3.1 Make the identity layer in a new `src/report-model/production-resolver.ts`: membership through `snapshotEntry`, and a streamed hash compare with `computeSha256File`. A mismatch fails with `hash-mismatch` before any parse.
- [x] 3.2 Make the host fast path: strict parsers for CSV, TSV, and JSON, and the parquet read through `hyparquet`. The cap is a construction value with a 16 MiB default. Add the `hyparquet` dependency.
- [x] 3.3 Make the prepare batching: group the references by artifact, read each file one time, and fill the cache. A resolve with no prior prepare still answers.
- [x] 3.4 Make the fall-through classification: an over-cap file, an unknown format, or a parse fault goes to the extraction arm. Declare the arm as a small seam interface, thus a test stubs it. While no realization is wired, the arm fails with `extraction-unavailable` and a detail.
- [x] 3.5 Write the tests: each layer, the cap tuning, the doubt fall-through, the absent lease beside nine under-cap successes, and the assert agreement between the two realizations.
- [ ] 3.6 Make the extraction workflow on the profile rails: the authorization at the async edge, the ephemeral container, and the fixed extraction script as a shipped asset. One submission covers each document pass, and no agent loop runs in the container. Read `src/tasks/data-profile.ts` for the pattern.

## 4. The record tool and the look-before-record rule

- [x] 4.1 Add the two hash columns to the session-state row: the rendered document hash, and the seen document hash. Caution: keep each DDL comment free of a semicolon, because the schema splits on it.
- [x] 4.2 The preview stamps the rendered hash when the page lands.
- [x] 4.3 Make the eyes tool in `src/tools/report-session/`: a `file://` navigation with `withPage`, the screenshot, the console errors, and the failed requests. A missed page is a typed outcome. A capture copies the rendered hash onto the seen hash.
- [x] 4.4 Make the record tool: the full gate first, through the production resolver. Each failure names its block. The seen hash must equal the current document hash. Only a pass reaches `store.record`, and the outcome carries the version id.
- [x] 4.5 Write the tests: a failed assert records nothing, the failure names the block, the never-seen refusal, the stale-look refusal, and the pass that records one version.

## 5. The toolset and the prompt

- [ ] 5.1 Register the eyes tool and the record tool in the report-session toolset, beside `preview_report`.
- [ ] 5.2 Extend the report-session prompt: the loop order (preview, look, repair, record), and the visual-spiral entry in the "Do NOT" list.
- [ ] 5.3 Write the tests of the toolset registration.

## 6. The gates

- [ ] 6.1 Run `bun run format:file` on each changed source file.
- [ ] 6.2 Run `tsc -p tsconfig.json`, and repair each finding.
- [ ] 6.3 Run the lint on the changed files, and repair each finding.
- [ ] 6.4 Run the tests of the changed areas only. Do not run the full suite.
