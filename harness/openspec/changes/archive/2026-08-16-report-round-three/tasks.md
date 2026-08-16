## 1. The store replaces the one version

- [x] 1.1 Give the version store a replace path under the named unique constraint, whole-triple only, with a created-or-replaced outcome.
- [x] 1.2 Retire the `thread_already_holds_version` refusal and its callers.
- [x] 1.3 DB tests: the replace, the unchanged id, the outcome flags, and the purge coverage as before.

## 2. The record tool loops

- [x] 2.1 Run the full gate and the look rule on every record, and hand the replace outcome through as `version updated`.
- [x] 2.2 Re-run the derivation prune on every record, confined to `derived/` as before.
- [x] 2.3 Tests: the re-record pass, the failed re-record keeps the stored version, the stale-look refusal, and the prune on a dropped binding.

## 3. One reference ladder and one appendix

- [x] 3.1 Merge the two ladders in `references.ts`: one bracket counter over both kinds, with the existing identity keys.
- [x] 3.2 Render one "References" appendix, flat in number order, with kind tags and the existing entry forms.
- [x] 3.3 Retire the superscript markers and the "Data provenance" and "Literature" headings.
- [x] 3.4 Tests: shared numbers, one entry per identity, the mixed-kind order, and the notation sweep of the page.

## 4. The volcano preset pass

- [x] 4.1 Add the optional thresholds member to the chart grammar, volcano-scoped, with the refusal on a type that reads none.
- [x] 4.2 Classify per row in the preset expansion, emit the three series, and mute the null series by construction.
- [x] 4.3 Feed the guides and the classification from one threshold pair, declared or default.
- [x] 4.4 Route the top-N label flags into the series that holds each flagged row.
- [x] 4.5 Add the crowd tier to the symbol ladder, with the two design-source constants.
- [x] 4.6 Widen the muted null-token fallback to the case-insensitive set.
- [x] 4.7 Tests: the three series and their colors, the threshold agreement, the label count after a split, and the two ladder tiers.

## 5. The chart reads the shared payload

- [x] 5.1 Carry the pre-bound row total on the payload, and print `N of M rows` in the grid footer.
- [x] 5.2 Register a chart past the inline bound onto the payload of its artifact, shared with the table over the same artifact.
- [x] 5.3 Build the series in the page script from the payload columns, with the label as a column index.
- [x] 5.4 Keep a chart under the bound byte-identical, and pin that with a test.
- [x] 5.5 Tests: no per-row data in a dense option, one payload for one artifact, the deterministic payload, and the footer total.

## 6. The script assets and the deps layout

- [x] 6.1 Stage the script of each referenced derivation as a content-addressed asset, from the record text.
- [x] 6.2 Link the script and the derived output from the appendix chain entry.
- [x] 6.3 Move the manifest statics under `assets/deps/` through the manifest entries, and adjust the skeleton references.
- [x] 6.4 Keep the sweep authoritative: `deps/` is the static set, and the rest is the page closure.
- [x] 6.5 Tests: the staged script, the chain links, the deps layout, and the sweep over a removed derivation.

## 7. The hash leaves the authoring input

- [x] 7.1 Drop the hash field from the authoring input schemas, and drop a supplied hash before the stamp.
- [x] 7.2 Elide the stamped hashes in the block read.
- [x] 7.3 Tests: the echoed-hash land, the path-only land, the unknown-path refusal, and the hash-free read.

## 8. The prompt and the advisories

- [x] 8.1 Extend the prompt: the derive-and-chart obligations with the artifact test, the References-section ban, the three-card rule, the two bound sizes, and the unbounded record loop.
- [x] 8.2 Extend the look checklist with the raster-figure, baked-statistic, and caption-promise faults.
- [x] 8.3 Add the exponent-form advisory to the finish, beside the free-numeral warnings.
- [x] 8.4 Trim the prompt lines that a mechanism now enforces, and keep the no-environment-detail assertions green.
- [x] 8.5 Tests: the substring pins of the new obligations, and the advisory on a drifted exponent form.

## 9. The durable turn duration

- [x] 9.1 Accept the duration on the turn append, store it beside the rollup on the last assistant row, and return it on the read.
- [x] 9.2 Tests: the round-trip, the absent default, the old-row read, and the retract.

## 10. Verification

- [x] 10.1 Run `bun run format:file` on each changed source file, then `bun run typecheck` in `harness`.
- [x] 10.2 Run the targeted test files of the changed surfaces alone, never the full suite.
- [x] 10.3 Validate the change and the spec tree with the openspec CLI.
