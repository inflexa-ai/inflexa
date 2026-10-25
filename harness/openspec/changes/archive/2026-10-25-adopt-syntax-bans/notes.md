# Worklist notes — adopt-syntax-bans

The live run is the authority. Each record below is a fresh forced-on run
of `bun --bun oxlint --format=json` at the stated task, saved outside the
tree (`tmp/pi/708-oxlint-flip.json`).

## Task 1.1 — the flip, measured

Config: `oxlint.config.ts` — the `syntax` line and its `#708` comment
deleted from the preset call; the `.tsx` override entry restated as
`...Object.values(restrictedSyntax())` beside the JSX `className` entry
(design D5). Run totals: 768 reports over 249 files — regex 635,
`JSON.parse` 80, timers 53. `forEach` reports none.

- regex: 635 — 308 non-test `src`, 327 test, 0 `scripts/`; 1 `.tsx`
  (`src/report-render/views/prose.tsx:34`)
- `JSON.parse`: 80 — 26 non-test `src`, 52 test, 2 in
  `scripts/refresh-fixtures.ts`
- timers: 53 — 19 non-test `src`, 34 test, 0 `scripts/`

Per-directory, per-ban (`(non-test)` / `(test)` / `(script)` mark the
zone):

- `scripts/` (script): jsonParse 2
- `src/*` root files (non-test): regex 9
- `src/__tests__` (test): regex 5, timers 4
- `src/agents` (test): regex 7
- `src/app` (non-test): regex 2; (test): regex 3, jsonParse 1
- `src/citations` (non-test): regex 18
- `src/config` (test): regex 2
- `src/contracts` (non-test): regex 8, jsonParse 1; (test): jsonParse 1
- `src/data` (non-test): regex 6
- `src/execution` (non-test): regex 1, jsonParse 1, timers 1; (test):
  regex 6, jsonParse 1, timers 6
- `src/input-scan` (non-test): regex 61, jsonParse 2
- `src/lib` (non-test): regex 16, jsonParse 1, timers 5; (test): regex 3,
  jsonParse 3, timers 3
- `src/literature` (non-test): regex 25, timers 2
- `src/loop` (non-test): regex 1, jsonParse 1; (test): regex 7,
  jsonParse 6, timers 5
- `src/memory` (non-test): regex 1; (test): regex 12, jsonParse 8
- `src/prompts` (test): regex 17
- `src/provenance` (non-test): regex 6
- `src/providers` (non-test): regex 3, timers 1; (test): regex 9,
  jsonParse 2, timers 8
- `src/reference-data` (non-test): regex 5; (test): regex 1
- `src/report-model` (non-test): regex 2, jsonParse 2; (test): regex 2,
  jsonParse 1
- `src/report-render` (non-test): regex 24; (test): regex 101,
  jsonParse 10
- `src/runtime` (non-test): jsonParse 1; (test): regex 3
- `src/sandbox` (non-test): regex 13, jsonParse 3, timers 6; (test):
  regex 31, jsonParse 1
- `src/schemas` (non-test): regex 2
- `src/state` (non-test): regex 3, jsonParse 1; (test): regex 5, timers 1
- `src/tasks` (non-test): regex 5, jsonParse 1; (test): regex 7,
  jsonParse 2, timers 2
- `src/tools` (non-test): regex 90, jsonParse 12, timers 4; (test):
  regex 61, jsonParse 16, timers 3
- `src/workflows` (test): regex 26, timers 2
- `src/workspace` (non-test): regex 7; (test): regex 19

## Task 2.1 — the in-scope non-test regex reports (104 over 16 files)

Per file, with the reporting lines of the flip run:

- `src/input-scan/tokens.ts` 28 (lines 65-69, 73x4, 78, 89x2, 119-120,
  133, 136, 138x2, 154, 156, 230, 234, 239, 283-285x2)
- `src/literature/sources/arxiv.ts` 21
- `src/input-scan/quarantine.ts` 15 (lines 18-30, 34-35)
- `src/citations/normalize.ts` 13
- `src/input-scan/readout.ts` 6
- `src/literature/sources/pubmed.ts` 4
- `src/input-scan/markers.ts` 4
- `src/input-scan/shapes.ts` 3
- `src/citations/plan.ts` 2
- `src/input-scan/clustering.ts` 2
- `src/citations/clients/common.ts` 1,
  `src/citations/clients/doi-registry.ts` 1,
  `src/citations/clients/crossref.ts` 1
- `src/input-scan/enrich.ts` 1, `src/input-scan/templates.ts` 1,
  `src/input-scan/formats.ts` 1

## Task 2.1 — outcome

All 104 non-test regex reports of `src/input-scan`, `src/citations`, and
`src/literature` are closed. 73 shapes were deleted (string methods, or a
shared helper in `src/lib/text.ts`: `collapseWhitespace`, `splitLines`,
`firstSegmentOf`, `trimTrailingOf`, `isAllDigits`, `isAllHex`). 31
patterns survive as named homes with one directive each, reason stating
intent: `tokens.ts` 8 (UUID, the two date captures, the embedded-date
finder, the three run splitters, the maskable-affix run),
`quarantine.ts` 2 (the `.tmp-` hex and UUID suffixes), `normalize.ts` 9
(DOI, PMID, arXiv, punctuation-and-symbols, name-suffix words, arXiv
version suffix, the three unsupported-work phrases), `plan.ts` 2
(arXiv hints), `clients/common.ts` 1 (publication year), `arxiv.ts` 4
(CDATA unwrap, the two per-tag Atom builders, the feed probe),
`pubmed.ts` 1 (the PubmedArticleSet probe), `readout.ts` 3 (SAM sort
order, YAML top-level key, ATX heading), `shapes.ts` 1 (the stem
atomizer). `markers.ts`, `formats.ts`, `enrich.ts`, `clustering.ts`,
`templates.ts`, and the two page-range splits of the citation clients
keep no pattern. Verification: `bun --bun oxlint src/input-scan
  src/citations src/literature` reports 0 regex sites there (the 4
remaining diagnostics in those directories are the jsonParse sites of
`readout.ts`/`enrich.ts` for task 4.1 and the timer sites of
`literature/sources/http.ts` for task 5.1); module tests: 209 pass,
0 fail; `bun run typecheck` passes.

## Task 2.2 — outcome and residual

All 204 non-test regex reports outside `src/input-scan`, `src/citations`, and
`src/lib/text.ts`-owned shapes are closed. 0 regex reports remain in non-test
`src` files (the 327 test-file reports belong to task 3.1). About 115 shapes
were deleted for the string methods, the `src/lib/text.ts` helpers
(`collapseWhitespace`, `splitLines`, `trimTrailingOf`, `isAllDigits`,
`isAllHex`, and the new `hasWhitespace`), `replaceAll`, `startsWith`/`endsWith`/
`includes`/`indexOf`, and scan loops that express the same run-collapse shape
without a pattern. `PLAN_ID_RE` moved to one home in
`contracts/schemas/chat-parts.ts` and the three other plan-id sites import it.
89 directives remain, each a named pattern home with its intent in the reason.
Verification: `bun --bun oxlint src` reports 0 regex sites in non-test files
and 0 diagnostics of any other kind beyond the jsonParse and timers reports of
groups 4.x and 5.x; `bun x tsc --noEmit -p tsconfig.json` passes; the module
tests of the 103 changed `src` files (63 test files) run 1363 pass, 0 fail.

### Group 2.2 residual directives (file — patterns, one directive each)

- `src/input-sanitization.ts` 9 — `CONTROL_CHARS` and `NUL` carry the
  pre-existing `no-control-regex` directive widened with the rule name (the two
  rules cannot stack on one literal); the 7 `SECRET_PATTERNS` entries each
  carry one directive over their literal.
- `src/tools/lib/pubchem-ops.ts` 8 — the registry-id table (ChEMBL, ChEBI,
  DrugBank, KEGG, HMDB, CAS, PDB, UNII).
- `src/tools/lib/protein-family-normalize.ts` 7 — the family name-variant
  matchers of `FAMILIES`.
- `src/data/safety-panel-schema.ts` 6 — CHEMBL, UniProt, HGNC-symbol,
  Ensembl-gene, reference alternation, panel semver.
- `src/reference-data/catalog.ts` 5 — SAFE_ID, SAFE_VERSION, SHA256, format
  token, organism name.
- `src/tools/lib/identifier-resolver.ts` 4 — ENSG, UniProt with isoform
  suffix, ChEMBL, HGNC.
- `src/tools/lib/pathway-client.ts` 4 — the HTML tag-strip fixpoint, the
  Reactome and KEGG id grammars, the KEGG flat-file field reader (caller-literal
  field name, dynamic form).
- `src/contracts/report-reference.ts` 2 — HASH_PATTERN, BASE64URL_PATTERN.
- `src/contracts/schemas/chat-parts.ts` 1 — PLAN_ID_RE (the shared home).
- `src/contracts/structure-source.ts` 1 — the AlphaFold file-path grammar.
- `src/lib/regulatory-corpus.ts` 1 — the level-2 heading split.
- `src/lib/zod-issues.ts` 3 — the trailing call-tag strip, the markdown fence
  opener, the fence closer.
- `src/providers/errors.ts` 1 — the transport-failure phrase matcher.
- `src/report-model/block-walk.ts` 2 — the free-numeral and exponent scans.
- `src/report-render/chart-export.ts` 3 — INSTANCE_TOKEN, TOKEN_PLACES, the
  token-family read.
- `src/report-render/figures/locuszoom.ts` 1 — POSITION_UNIT.
- `src/report-render/hybrid-svg.ts` 2 — ROOT_TAG, BACKGROUND_RECT (both also
  interpolated into the page script).
- `src/report-render/number-format.ts` 1 — SCIENTIFIC_IN_TEXT.
- `src/sandbox/labels.ts` 1 — the K8s label-value grammar.
- `src/sandbox/package-identity.ts` 2 — SPECIFIER, VERSION_INTRUDER.
- `src/tools/bio/lookup-annotation.ts` 1 — the GO term id shape.
- `src/tools/bio/search-gene.ts` 1 — the NON_SYMBOL_PATTERNS table.
- `src/tools/bio/search-patents.ts` 1, `src/tools/bio/search-regulatory-approvals.ts` 1
  — the Entrez date-filter shape.
- `src/tools/knowledge/check.ts` 1 — the M- method id shape.
- `src/tools/knowledge/local-slots.ts` 3 — FORMULA_PATTERN, the contract-data
  pattern read, the {{name}} slot binding.
- `src/tools/knowledge/template.ts` 2 — TEMPLATE_REF, SCRIPT_NAME_RE.
- `src/tools/lib/__fixtures__/manifest.ts` 1 — CAPTURED_AT_PATTERN.
- `src/tools/lib/iuphar-client.ts` 2 — the UniProt accession shape, the
  tag-strip fixpoint.
- `src/tools/lib/pubchem-client.ts` 1 — the SMILES amide-bond motif.
- `src/tools/lib/uniprot-client.ts` 1 — the full UniProt accession grammar.
- `src/tools/read-tool-output.ts` 1, `src/tools/workspace/edit-file.ts` 1,
  `src/tools/workspace/grep.ts` 1 — the caller-supplied pattern of each tool.
- `src/tools/report-session/page-faults.ts` 2 — DATA_URI, BASE64_RUN.
- `src/tools/research/generate-plan.ts` 1 — the parent-plan error-message
  classification.
- `src/tools/research/web-fetch.ts` 1 — the dynamic close-tag search of the
  raw-text tags.
- `src/tools/sandbox/list-available-packages.ts` 2 — the cli and node heading
  matchers.
- `src/tools/terminal-text.ts` 1 — PLACEHOLDER_TEXT.

## Task 3.1 — residual

All 327 test-file regex reports are closed. `bun --bun oxlint src` reports 0 regex
sites anywhere (non-test included); the jsonParse and timers reports of groups
4.x and 5.x stand. Most shapes were deleted for the string methods, for
`collapseWhitespace`, `splitLines`, `trimTrailingOf`, and `isAllDigits` of
`src/lib/text.ts`, and for the digest, tool-output-ref, hex-color, and
surrogate-pair predicates of the new shared test helper
`src/lib/test/text-shapes.ts` (design D2.4 tier 4); the plan-id tests import the
production `PLAN_ID_RE` home (tier 2). The named local matchers that keep one
directive each, with the intent their reasons state:

- `src/workflows/test/sql-writes.ts` 12 — the family helper of the SQL write
  shapes the workflow tests match (suspend write, run status writes, synthesis
  status, seed insert and its conflict arms, step status writes, skipped sweep,
  parts write), each tolerant of the wrapped SQL templates.
- `src/report-render/test/render.test.ts` 16 — the page gate readers
  (`REFERENCE_ATTRIBUTE`, the css url/import/image-set readers, `CSS_COMMENT`,
  the dynamic `CSS_RULE` builder and its selector escaper, `LINEAGE_CLASS_NAME`,
  `REMOTE_SCHEME`, `URL_SCHEME`, the content-measure rule and variable,
  `FONT_SIZE_PX`, the two lineage-observer margins,
  `OVERFLOW_WRAP_ANYWHERE`, the four print and menu hiding rules,
  `LONG_PATH_D`).
- `src/report-render/test/chart-export.test.ts` 15 — the SVG shape readers of
  the chart files (`XML_TAG`, `WELL_FORMED_TAG`, `INSTANCE_TOKEN`, `SVG_ID`,
  `PAGE_COUNT_TEXT`, `LINE_PATH`, `AXIS_PATH`, `TITLE_MATRIX`, `TEXT_EXTENTS`,
  `TEXT_CONTENT`, `PAINT_ORDER_LABEL`, the bar path grammar, the legend label
  line, and the term escaper).
- `src/report-render/gallery/test/gallery.test.ts` 6 — the `LICENSE_FORMS`
  table, one directive per license name.
- `src/report-render/test/chart.test.ts` 5 — the chart-container mark, the card
  and container rule readers, the height declarations, the nonzero length
  value.
- `src/report-render/test/hybrid-svg.test.ts` 3 — the background-rect line, the
  labeled axis text element, the placed image geometry.
- `src/report-render/test/chart-renderers.test.ts` 2 — the stem path and the
  magenta polygon readers.
- `src/report-render/figures/test/*` 6 — forest `SVG_TEXT_CONTENT` and
  `EXPORT_TITLE_LINE`, manhattan `CHROMOSOME_TWO` and `POSITION`, sankey
  `SVG_ELEMENT` and `BOX_PATH_WIDTH`.
- `src/state/test/plans.test.ts` 2 — the two index-definition DDL shapes.
- `src/prompts/test/briefing.test.ts` 1, `src/prompts/sandbox/test/
  data-profiler.test.ts` 1, `src/providers/test/ai-sdk.test.ts` 1,
  `src/providers/integration/test/pubchem.integration.test.ts` 1 (InChIKey),
  `src/reference-data/test/catalog.test.ts` 1 (format token),
  `src/sandbox/test/identity.test.ts` 1 and `src/sandbox/test/k8s-client.test.ts`
  1 (DNS-1123 forms), `src/app/test/approve-plan.test.ts` 1 (date/clock text),
  `src/memory/test/message-backfill.test.ts` 1, `src/tools/bio/test/
  search-regulatory-approvals.test.ts` 1, `src/tools/test/define-tool.test.ts` 1
  and `src/tools/test/analysis-invocation.test.ts` 1 (UUIDv5),
  `src/report-render/test/validity.test.ts` 1 (inline JSON script block),
  `src/workflows/test/sandbox-step.test.ts` 1 (ISO instant), and
  `src/__tests__/setup/postgres.ts` 1 (the testcontainers readiness log line).

Verification: `bun --bun oxlint src` reports 0 regex sites and 0 unused
directives; `bun run typecheck` passes; the module tests of the changed files
run 2252 pass, 0 fail across 92 test files.

## Task 4.1 / 4.2 — outcome and residual

All 80 `JSON.parse` reports are closed: 26 non-test `src` across 21 files, 2 in
`scripts/refresh-fixtures.ts` (task 4.1), and 52 test (task 4.2). The helper
family is `src/lib/parse-json.ts`: `parseJsonAs(text, schema)` and
`safeParseJsonAs(text, schema)`, each over one private `parseJsonText` that
holds the single `JSON.parse` of the tree behind one directive. Error
semantics stay split as before: malformed text throws the parse's
`SyntaxError` out of both forms, a schema failure throws the `ZodError` in
the parse form and comes back as the zod result in the safeParse form, so
each boundary's existing catch keeps catching.

The domain-schema boundaries pass their schema (`PollResponseSchema`,
`ReadoutLineSchema`, `FarmLockSchema`, `ImagePackagesSchema`,
`AmassErrorEnvelopeSchema`, `SnapshotMismatchSchema`,
`ValidationFailureSchema`, `JsonSchema`, `ExtractValuesResultSchema`,
`RunSynthesisSchema`, `ReferenceSchema`, `FixtureManifestSchema`,
`UnknownRecordSchema` of the decision record, the input schemas of the
fixture tables and of the tests that assert one shape). The unknown walks
pass `z.unknown()` or the `UnknownRecordSchema` container of
`lib/unknown-containers.ts` (the error bodies of `knowledge/client.ts` and
`ctx-ops.ts`, the probe of `input-scan/readout.ts`, the receipts and legacy
registry of `list-available-refs.ts`, the double-encoded block payload of
`authoring-tools.ts`, the raw fixture read of `fixture-runner.ts`, and the
test-side page-text, env, and stubbed-body reads). Two root-cause catches
from the module tests: `lib/zod-issues.ts` `parseAs` keeps its catch (it
tolerates malformed text by design, so the container parse sits inside the
original try), and `report-model/production-resolver.ts` `parseJsonTable`
now expresses its "array of flat objects" shape as
`z.array(z.record(z.string(), z.unknown()))` with the original catch.

Verification: `bun --bun oxlint src scripts` reports 0 `JSON.parse` sites
anywhere (timers 53 remain for group 5.x), `bun run typecheck` passes, and
the module tests of the changed files run 5483 pass, 0 fail across 321
files. `bun run format:file` ran over every changed `src` file.

### Group 4.x residual directives (file — parse, one directive each)

- `src/lib/parse-json.ts:4` — the one `JSON.parse` of the tree: every
caller states the schema its boundary assumes.
- `src/loop/run-agent.ts:1415` — the NUL-stripping reviver walks a value
the code serialized one line above, not text of unknown shape; a schema
proves nothing there (design D3).
- Storage round trips of a value in hand (the parse simulates the write
and read; a schema proves nothing there):
`src/memory/test/conversation-display-parity.test.ts:107`,
`src/memory/test/conversation-display-storage.test.ts:139`, `:162`, `:210`,
`src/memory/test/ai-sdk-message-storage.test.ts:77`, `:105`, `:203`,
`src/tools/research/test/inspect-data-profile.test.ts:37`,
`src/report-render/test/chart-export.test.ts:801`.
- Round trips where the parse is the assertion:
`src/report-render/test/chart-toolbox.test.ts:180` (the toolbox must
survive a JSON cycle verbatim), `src/lib/test/console-logger.test.ts:132`
and `:134` (what `JSON.stringify` keeps of the error fields),
`src/loop/test/run-agent.test.ts:269` (the fake step cache mirrors the
durable step cache, which re-parses each serialized tool result).
- A replacer the helper cannot take: `src/app/test/chat-turn.test.ts:1140`
(the replacer masks the fields that vary between runs).
- Text that an object literal cannot express:
`src/report-render/test/table-data.test.ts:162` and
`src/report-render/test/render.test.ts:589` and
`src/report-model/test/reference-stamp.test.ts:220` (the text gives
`__proto__`, or `__proto__` and `constructor`, as own keys, which a literal
would bind to the prototype instead).

## Task 5.1 residual directives and measured facts

All 19 non-test timer reports are closed. 13 sites moved to the aliased
`node:timers/promises` wait (`import { setTimeout as sleep } from
"node:timers/promises"`), the poll loop of `sandbox/exec.ts` takes the internal
`clock` option (`{ now(), wait(ms, signal?) }`, the `InspectRunClock` shape,
`systemClock` default, not an exported type — `now` and `sleep` of `ExecDeps`
collapsed into it), and 6 sites keep one directive each, with the intent its
reason states:

- `src/sandbox/exec.ts:140` and `:170` — the submit and poll deadline guards:
a guard, not a wait — it aborts the controller of the in-flight request, and
the finally clears it. `AbortSignal.timeout` would change the abort reason the
request rejects with (AbortError vs TimeoutError), which design D4 protects.
- `src/providers/ai-sdk.ts:1151` — the request-timeout guard of the design's
named case: it aborts the fetch controller at the deadline, unrefs so an armed
guard never holds a short-lived process, and the finally clears it.
- `src/tools/ad-hoc-router.ts:250` — the routing deadline guard: it aborts the
routing controller while the provider call runs, and the finally clears it.
- `src/tools/approval/gateway.ts:226` — `sleepUntil` of the design's named
case: it resolves on abort by contract (the poll loop emits the aborted event
after the resolve), and the node wait rejects instead.
- `src/lib/page-capture.ts:145` — `waitForThemeReady` runs inside the browser
as page source, so the node timers module does not exist there; the timer
bounds a page that never signals.

Two signal-aware rewrites replaced a raw timer with the same behavior expressed
through the wait's signal: `execution/run-event-parts.ts` (`pipeFoldedRunEvents`
holds one armed flush wait behind an `AbortController` gate; the teardown aborts
it, the rejection arm swallows it) and `tools/report-session/examine-page.ts`
(`withDeadline` races the operation against an abortable wait and aborts the
gate after the race, which is the clear-on-settle the old comment demanded).

Measured fact that shapes the two shared waits: under the Bun test runtime,
`node:timers/promises` `setTimeout` rejects an in-flight abort with a fresh
`AbortError` instead of `signal.reason` (probed on this branch). The rejection
reason is part of the exported contract of `sleepWithSignal` (asserted by
`src/lib/test/rate-limit.test.ts:123`), so `sleepWithSignal` and the delay of
`literature/sources/http.ts` keep the gates that answer a non-positive duration
and an already-aborted signal, and their catch re-raises the contract's own
reason. Under Node the primitive's reason is correct and the remap is a no-op.

Verification: `bun --bun oxlint src` reports 0 timer sites in non-test files
(34 test reports stand for task 5.2), `bun x tsc --noEmit -p tsconfig.json`
passes, and the module tests of the changed files run 305 pass, 0 fail
(rate-limit, literature http, sandbox exec + docker + k8s, run-event-parts,
page-capture, approval gateway, examine-page, ad-hoc-router, web-fetch,
ai-sdk request-timeout). `bun run format:file` ran over each changed file.

## Task 5.2 residual directives and measured facts

All 34 test-file and test-setup timer reports are closed, and `bun --bun
oxlint src` reports 0 diagnostics of any kind — `bun run lint` is green for
the first time since the flip of task 1.1.

Most sites moved to the aliased `node:timers/promises` wait with identical
semantics: the readiness and status poll loops (`postgres.ts`, `dbos.test.ts`,
`run-event-stream.test.ts` `waitUntil`, `report-session-state.test.ts`,
`data-profile.trigger.test.ts`, `gateway.test.ts`, `result-checkpoint.test.ts`,
`workflow-replay.test.ts`), the tool-body delays of `run-agent.test.ts`, the
slow-handler and settle delays of `run-event-stream.test.ts` and
`run-event-parts.test.ts`, the `tick()` of `chrome.test.ts`, and the small
overlap delays of `rate-limit.test.ts`. Two race guards rebuilt on the abortable
wait — `settlesWithin` of `run-event-stream.test.ts` and the second-launch race
of `execute-analysis.test.ts` — arm `sleep(timeoutMs, undefined, { signal })`
behind an `AbortController`, and the abort after the settled race retires the
loser's wait (the race absorbed its rejection when it attached to each arm).
Three caller-abort simulators stopped arming a timer: where the proof only
needed the abort to land after the call began (`ai-sdk.request-timeout.test.ts`
with `fetchThatNeverStarts`, both the guarded and the no-wrapper case), the
test starts the call and aborts the signal with no elapsed time; where the
abort must land mid-stream or mid-backoff, the test awaits `sleep(...)` before
`controller.abort()` (`ai-sdk.request-timeout.test.ts` at 120 ms,
`ai-sdk.test.ts` at 50 ms), which keeps what each test proves.

Four sites keep one directive each, all in the two self-re-arming chunk pumps
of `src/providers/test/ai-sdk.request-timeout.test.ts`: the stream pump of
`fetchWithSteadyBody` (lines 86 and 89) and the SSE emitter of `emitEvery`
(lines 408 and 414). A pump re-arms its own next push or write, and `emitEvery`
unrefs so the fake endpoint never holds the process; a wait cannot re-arm
itself, so the raw timer is the shape.

## Residual directives (design D6)

### The sweep's findings and their fixes

The sweep walked each of the 235 directives the five groups left under `src` and
`scripts`. 7 sites were findings — a directive a string-method fix covers, a
reason without its intent, or one shape living in two homes — and the fixes
landed before the final count. 1 new named home replaced two of the copies:

- `src/tools/bio/search-patents.ts:30` and
  `src/tools/bio/search-regulatory-approvals.ts:41` — both files held the same
  `ISO_DATE` pattern (`/^\d{4}-\d{2}-\d{2}$/`) behind its own directive.
  `isIsoDate` of `src/lib/text.ts` (built on `isAllDigits`) now carries the
  exact acceptance set — the digit runs stay unchecked against the calendar, as
  the pattern did. `z.iso.date()` was not a drop-in: it is stricter (it rejects
  month 13), and the change preserves each boundary's behavior. The input
  schemas use `z.string().refine(isIsoDate)`; the two tool tests pin the
  accepted and rejected shapes.
- `src/providers/errors.ts:250` — `CONNECTION_ERROR_PATTERN` was a phrase
  alternation matched verbatim. The phrases sit in the
  `CONNECTION_ERROR_PHRASES` list now, matched with `includes` over the
  lowercased link message. No pattern exists.
- `src/tools/research/generate-plan.ts:433` — the anchored case-insensitive
  phrase match over the parent-plan write failure became `startsWith`/
  `endsWith` over the lowered message; the grammar it classifies is the one
  `state/plans.ts` throws, whose two messages are single-line. The persistPlan
  classifier is reachable only when the parent plan vanishes between the
  loadPlan preflight and the insert. The new generate-plan test pins the
  preflight refusal (the `invalid_parent_plan` ending, before the planner
  runs), which no test asserted before.
- `src/tools/research/web-fetch.ts:495` — the dynamic `</name(?=[\s/>])` close
  search of the raw-text tags became an `indexOf("</")` scan with a slice
  compare and a boundary predicate (`isRawTextClose`). The whole-text
  lowercased search the old reason argued against is gone, and the index-shift
  concern is gone with it. The web-fetch test pins the uppercase close and the
  close with a trailing space.
- `src/tools/lib/iuphar-client.ts:66` and
  `src/tools/lib/pathway-client.ts:32` — the same tag-strip shape lived in two
  copies with the same fixpoint loop and the same reason. One home owns it now:
  `stripHtmlTags` in `src/tools/lib/html-text.ts`. The sweep proved by brute
  force over every `<`/`>`/text string to length 9 that one global pass already
  reaches the fixpoint (a span's interior holds no `>`, so a removal cannot
  form a new pair) — the repeat loop both copies carried never did work, and
  the home states that fact instead of carrying the loop.

Correction to the task 5.1 record: it says 6 non-test timer sites keep a
directive; the count is 7. The hop guard of `web-fetch.ts:302` kept its
directive but was not named in that list. The consolidated list below is the
authority.

### The consolidated count and list

Correction at the review round: the recorded count was one grep artifact and
one method short. The literal NUL and SOH bytes inside the string literals of
`src/input-scan/shapes.ts` make grep report that file as binary, so a plain
`grep -rn` silently drops its one directive (line 50); a recount needs
`grep -a`. And the 2 combined `no-control-regex,
eslint-js/no-restricted-syntax` directives of `src/input-sanitization.ts:14,37`
do not match the narrow next-line pattern, so they sat outside the total. The
`JSON.parse` tally was correct: the reviewer's "one high" was the missing
`shapes.ts` regex site, which the category split already carried. The same
correction run converted the 2 steady-body chunk pump directives of
`src/providers/test/ai-sdk.request-timeout.test.ts` (lines 85 and 88 at the
old numbering) — the pump is a loop over the signal-aware `sleep` of
`node:timers/promises` now, so the "a wait cannot re-arm itself" reason no
longer applies there. The 2 `emitEvery` directives keep theirs: the emitter
needs the `unref`'d timer so the fake endpoint never holds the process.

After the correction run, `grep -rna "oxlint-disable-next-line
eslint-js/no-restricted-syntax" src scripts` finds 227 directives, and the 2
combined directives bring the `no-restricted-syntax` total to 229:

- regex 201 — 199 single-rule directives (113 production named homes, 86
  test named matchers) and the 2 combined `no-control-regex,
  eslint-js/no-restricted-syntax` directives of `src/input-sanitization.ts`
- `JSON.parse` 19 — the one tree-wide parse of `src/lib/parse-json.ts`, the
  run-agent reviver, and the test round-trip and assertion sites of the task
  4.x record
- timers 9 — the 7 non-test guards and contract waits of tasks 5.1 (as
  corrected above) and the 2 `emitEvery` directives of the fake stream
  endpoint of task 5.2

Each survivor is a named home whose name and reason state what it matches, a
parse escape of design D3, or a guard or contract wait of design D4. The list,
`file:line — intent`, from the live grep at the end of task 6.1:

```
src/tools/research/web-fetch.ts:303:        -- a guard, not a wait: it destroys the in-flight hop at the wall clock, unrefs so it never holds the process, and the settle disposes it.
src/tools/research/test/inspect-data-profile.test.ts:37:    -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/tools/bio/test/search-regulatory-approvals.test.ts:1:-- the refusal that names the code and then the credit state, in that order
src/tools/bio/lookup-annotation.ts:144:            -- the GO term id shape: the GO: prefix plus seven digits.
src/tools/bio/search-gene.ts:31:-- each entry is the fixed issued shape of one identifier space (Ensembl, HGNC, ChEMBL, UniProt); the alternation of the four is what keys the resolver.
src/tools/test/define-tool.test.ts:1:-- the refusal that names the tool, then its type, then the expected object type, in that order
src/tools/test/analysis-invocation.test.ts:1:-- the canonical UUIDv5 text form, whose version and variant nibbles pin the minted run id
src/tools/report-session/page-faults.ts:36:-- the data-URI grammar of an inlined fault (media type, parameters, payload) with the quote and bracket characters that end it.
src/tools/report-session/page-faults.ts:40:-- the base64 charset run with its padding; the length floor keeps a 64-character hex hash outside the match.
src/tools/workspace/grep.ts:81:                -- the caller-supplied grep pattern is the tool's input; the dynamic form is the feature, and an invalid pattern is the handled error below.
src/tools/workspace/edit-file.ts:164:        -- the caller-supplied match pattern is the tool's input; the dynamic form is the feature, and an invalid pattern is the handled error below.
src/tools/terminal-text.ts:10:-- the anchored placeholder words and their n/a spellings, at the start of the text; the alternation is the guard's own word list.
src/tools/knowledge/local-slots.ts:53:-- a formula starts with ~ and holds only formula name characters; the shape is the slot contract.
src/tools/knowledge/local-slots.ts:67:            -- the pattern arrives as contract data from the template author, not from this module.
src/tools/knowledge/local-slots.ts:196:        -- the {{name}} placeholders are the template grammar of the contract; the capture names the slot to bind.
src/tools/knowledge/template.ts:132:-- the template reference grammar: the tpl- prefix, an id, and an optional @version tail.
src/tools/knowledge/template.ts:135:-- a script file name is one segment of the safe file-name charset; the shape is the path-safety rule.
src/tools/knowledge/check.ts:57:        -- the recommend-answer method id shape: M- plus four digits.
src/tools/sandbox/list-available-packages.ts:264:    -- the section heading names the executables section or the standalone word CLI, matched in display text.
src/tools/sandbox/list-available-packages.ts:266:    -- the heading opens with the word node, the display form of the section name.
src/tools/read-tool-output.ts:85:        -- the caller-supplied search pattern is the tool's input; the dynamic form is the feature, and an invalid pattern is the handled error below.
src/tools/lib/html-text.ts:7:    -- an HTML tag run to the first closing bracket; a quoted `>` inside an attribute is deliberately not seen.
src/tools/lib/pubchem-client.ts:120:-- the amide-bond motif C(=O)N read out of a SMILES string; the literal atoms are the chemistry.
src/tools/lib/iuphar-client.ts:56:-- the issued UniProt accession shape is the identifier rule of the target records.
src/tools/lib/__fixtures__/manifest.ts:16:-- the capture-date shape the fixture manifest records; the fixed calendar form is the manifest rule.
src/tools/lib/identifier-resolver.ts:35:-- Ensembl gene ids are ENSG plus 11 digits; the fixed shape is the identifier rule.
src/tools/lib/identifier-resolver.ts:37:-- the UniProt accession shape with its optional isoform suffix (-<n>).
src/tools/lib/identifier-resolver.ts:39:-- ChEMBL ids carry the fixed CHEMBL<n> shape.
src/tools/lib/identifier-resolver.ts:41:-- HGNC ids are the HGNC: prefix plus digits.
src/tools/lib/pathway-client.ts:252:-- the Reactome stable-id grammar: R-, three letters, digits, and an optional dotted subnumber.
src/tools/lib/pathway-client.ts:256:-- the KEGG pathway-id grammar: three or four lowercase organism letters plus five digits.
src/tools/lib/pathway-client.ts:261:    -- the field name is a caller literal ("NAME", "DESCRIPTION"); the anchored multiline form reads the KEGG flat-file grammar.
src/tools/lib/protein-family-normalize.ts:20:            -- the hyphen-variant spellings of the GPCR name, matched as whole words.
src/tools/lib/protein-family-normalize.ts:22:            -- the GPCR abbreviation as a whole word.
src/tools/lib/protein-family-normalize.ts:24:            -- the seven-transmembrane spelling of the family name.
src/tools/lib/protein-family-normalize.ts:26:            -- the rhodopsin-like subfamily spelling.
src/tools/lib/protein-family-normalize.ts:28:            -- the secretin-like subfamily spelling.
src/tools/lib/protein-family-normalize.ts:34:        -- the hyphen-variant spellings of the serine/threonine kinase name.
src/tools/lib/protein-family-normalize.ts:39:        -- the hyphen-variant spellings of the tyrosine kinase name.
src/tools/lib/uniprot-client.ts:261:-- the full UniProt accession grammar, both entry-class arms with the optional isoform suffix; the shape overlap with gene symbols is why the match decides safety only.
src/tools/lib/pubchem-ops.ts:117:    -- the ChEMBL id format: the CHEMBL prefix plus digits.
src/tools/lib/pubchem-ops.ts:119:    -- the ChEBI id format: the CHEBI: prefix plus digits.
src/tools/lib/pubchem-ops.ts:121:    -- the DrugBank id format: the DB prefix plus five digits.
src/tools/lib/pubchem-ops.ts:123:    -- the KEGG id format: one C or D compound letter plus five digits.
src/tools/lib/pubchem-ops.ts:125:    -- the HMDB id format: the HMDB prefix plus digits.
src/tools/lib/pubchem-ops.ts:127:    -- the CAS registry format: two to seven digits, a dash pair, and one check digit.
src/tools/lib/pubchem-ops.ts:131:    -- the PDB id format: a digit, then three alphanumerics, with the lookahead that demands a letter among them.
src/tools/lib/pubchem-ops.ts:136:    -- the UNII format: ten uppercase alphanumerics, with the lookahead that demands a letter among them.
src/tools/ad-hoc-router.ts:250:    -- a guard, not a wait: it aborts the routing controller at the deadline while the provider call runs, and the finally clears it.
src/tools/approval/gateway.ts:226:        -- this wait resolves on abort by contract — the poll loop emits the aborted event after the resolve — and the node wait rejects instead.
src/app/test/approve-plan.test.ts:1:-- the assertion is about formatted date and clock text, whose shape is a pattern
src/app/test/chat-turn.test.ts:1140:        -- the replacer masks the fields that vary between runs, and the schema-parse helper takes no replacer.
src/literature/sources/arxiv.ts:29:-- an Atom feed wraps text in CDATA sections; this keeps the text of each nearest opener/closer pair.
src/literature/sources/arxiv.ts:84:    -- an Atom tag's content is `<tag …>` up to the nearest `</tag>`; the expression is built per tag name, and a tag name is not data.
src/literature/sources/arxiv.ts:106:    -- a self-closing Atom tag carries its attributes in the tag itself: `<tag … />`; the expression is built per tag name.
src/literature/sources/arxiv.ts:137:-- the Atom envelope probe: a `<feed` element opens the document; the word boundary keeps a longer element name from passing.
src/literature/sources/pubmed.ts:7:-- the PubmedArticleSet envelope probe; the word boundary keeps a longer element name from passing.
src/memory/test/ai-sdk-message-storage.test.ts:77:        -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/memory/test/ai-sdk-message-storage.test.ts:105:        -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/memory/test/ai-sdk-message-storage.test.ts:203:        -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/memory/test/conversation-display-storage.test.ts:139:        -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/memory/test/conversation-display-storage.test.ts:162:        -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/memory/test/conversation-display-storage.test.ts:210:        -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/memory/test/conversation-display-parity.test.ts:107:                      -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/memory/test/message-backfill.test.ts:1:-- the refusal names the thread and the redacted_thinking part in that order
src/contracts/structure-source.ts:35:-- the AlphaFold file-path grammar with its accession, fragment, and version captures; the captures name the fields the source record carries.
src/contracts/schemas/chat-parts.ts:92:-- the issued plan-id shape: the pln- prefix plus 8 hex digits.
src/contracts/report-reference.ts:23:-- the hash shape is algorithm:hex with lowercase hex only; the case rule is what makes the exact equality comparison resolve.
src/contracts/report-reference.ts:313:-- the base64url alphabet check; Buffer.from never throws, so this explicit shape check is the only malformed-payload guard.
src/providers/test/ai-sdk.test.ts:1:-- the unpadded base64url digest of the session key, whose shape is a pattern
src/providers/test/ai-sdk.request-timeout.test.ts:407:                -- the emitter re-arms its own next write, unref'd so the fake endpoint never holds the process; a wait cannot re-arm itself here.
src/providers/test/ai-sdk.request-timeout.test.ts:413:        -- the emitter re-arms its own next write, unref'd so the fake endpoint never holds the process; a wait cannot re-arm itself here.
src/providers/integration/test/pubchem.integration.test.ts:1:-- the InChIKey grammar of 14-10-1 uppercase blocks, whose shape is a pattern
src/providers/ai-sdk.ts:1151:            -- a guard, not a wait: it aborts the controller of the in-flight fetch at the deadline, unrefs so an armed guard never holds a short-lived process, and the finally clears it.
src/workflows/test/sql-writes.ts:8:-- the suspend write that the body inlines, across wrapped SQL lines
src/workflows/test/sql-writes.ts:11:-- the run status write, across wrapped SQL lines
src/workflows/test/sql-writes.ts:14:-- the run status write in any letter case, across wrapped SQL lines
src/workflows/test/sql-writes.ts:17:-- the synthesis status write on the run row, across wrapped SQL lines
src/workflows/test/sql-writes.ts:20:-- the seed insert of the step ledger, across wrapped SQL lines
src/workflows/test/sql-writes.ts:23:-- the conflict arm of the seed insert, across wrapped SQL lines
src/workflows/test/sql-writes.ts:26:-- the conflict arm of the mark-running upsert, across wrapped SQL lines
src/workflows/test/sql-writes.ts:29:-- the parameterized terminal status write on the step ledger, across wrapped SQL lines
src/workflows/test/sql-writes.ts:32:-- the terminal sweep of pending steps to skipped, across wrapped SQL lines
src/workflows/test/sql-writes.ts:35:-- the parameterized run status write, across wrapped SQL lines
src/workflows/test/sql-writes.ts:38:-- the step-ledger update that marks a canceled step, across wrapped SQL lines
src/workflows/test/sql-writes.ts:41:-- the parts write on the run row, across wrapped SQL lines
src/workflows/test/sandbox-step.test.ts:1:-- the ISO instant shape of a recorded activity timestamp
src/state/test/plans.test.ts:1:-- the parent index definition that the migration declares, over the qualified table name
src/state/test/plans.test.ts:3:-- the runs index definition that the migration declares, over the qualified table name
src/report-render/number-format.ts:367:-- the coefficient and exponent captures with the boundary lookarounds keep a name such as `rs1e5` outside the match.
src/report-render/test/table-data.test.ts:162:        -- the text gives `__proto__` as an own key, which an object literal cannot express.
src/report-render/test/chart.test.ts:1:-- the element that carries the chart id and the chart-container class on one tag
src/report-render/test/chart.test.ts:3:-- the declaration body of each report-chart-card rule of the style sheet
src/report-render/test/chart.test.ts:5:-- the declaration body of each chart-container rule of the style sheet
src/report-render/test/chart.test.ts:7:-- one height declaration of a rule body
src/report-render/test/chart.test.ts:9:-- a nonzero length value with a css unit, which the chart box needs
src/report-render/test/chart-toolbox.test.ts:180:        -- the round trip is the assertion: the toolbox must survive a JSON cycle verbatim.
src/report-render/test/validity.test.ts:1:-- the inline JSON script block that the page embeds, read up to its closing tag
src/report-render/test/hybrid-svg.test.ts:1:-- the background rectangle element that the runtime SVG carries on its own line
src/report-render/test/hybrid-svg.test.ts:3:-- the vector text element of one labeled axis, read for its inner text
src/report-render/test/hybrid-svg.test.ts:5:-- the drawn image element of the raster layer, read for its placed rectangle
src/report-render/test/chart-export.test.ts:1:-- one XML tag of the SVG, with its attributes
src/report-render/test/chart-export.test.ts:3:-- the well-formed tag grammar that the XML reader of the file accepts
src/report-render/test/chart-export.test.ts:5:-- the instance token that the chart runtime renumbers, the shape that chart-export.ts names INSTANCE_TOKEN
src/report-render/test/chart-export.test.ts:7:-- the id attribute of one SVG element
src/report-render/test/chart-export.test.ts:9:-- the page count of the wrapped legend, drawn as text
src/report-render/test/chart-export.test.ts:11:-- the straight line segment that one series draws
src/report-render/test/chart-export.test.ts:13:-- the axis line that the chart draws in the ink color with a round cap
src/report-render/test/chart-export.test.ts:15:-- the rotated title of the y axis, read for its x from the transform matrix
src/report-render/test/chart-export.test.ts:17:-- the positioned text element, read for its origin and its inner text
src/report-render/test/chart-export.test.ts:19:-- one text element of the SVG, read for its inner text
src/report-render/test/chart-export.test.ts:21:-- the positioned label that the axis paints over the grid, read for its origin
src/report-render/test/chart-export.test.ts:472:    -- the bar path grammar of one rectangle drawn as four line runs
src/report-render/test/chart-export.test.ts:581:        -- the end-anchored label line of one legend term
src/report-render/test/chart-export.test.ts:584:                -- the term escapes to a literal form inside the label line
src/report-render/test/chart-export.test.ts:801:        -- the round trip of a value in hand simulates the storage write and read; a schema proves nothing there.
src/report-render/test/chart-renderers.test.ts:1:-- the straight stem segment that one series draws, with its attribute tail
src/report-render/test/chart-renderers.test.ts:3:-- the polygon that the highlight fill draws, read for its points
src/report-render/test/render.test.ts:1:-- the src, href, and srcset reference attributes of the page, read as the render gate reads them
src/report-render/test/render.test.ts:3:-- the quoted or bare source of one url() font or image reference of the inline sheet
src/report-render/test/render.test.ts:5:-- the quoted target of one @import rule of the inline sheet
src/report-render/test/render.test.ts:7:-- the candidate list of one image-set() rule of the inline sheet
src/report-render/test/render.test.ts:9:-- the quoted source that leads one image-set() candidate
src/report-render/test/render.test.ts:11:-- one css comment, which no rule reader reads through
src/report-render/test/render.test.ts:14:    -- the rule body of one selector, read with its declarations
src/report-render/test/render.test.ts:17:            -- the selector text escapes to a literal form, which no caller can spell wrong
src/report-render/test/render.test.ts:22:-- the report-lineage class names that the style sheet defines
src/report-render/test/render.test.ts:24:-- the remote http(s) scheme that the gate admits, in any letter case
src/report-render/test/render.test.ts:26:-- the absolute-URL scheme grammar that the page scheme check reads
src/report-render/test/render.test.ts:28:-- the content column rule that caps the measure at the shared variable
src/report-render/test/render.test.ts:30:-- the pixel value that the shared measure variable holds
src/report-render/test/render.test.ts:32:-- the font size of one reference-list item, in pixels
src/report-render/test/render.test.ts:34:-- the negative bottom margin of the lineage observer, which pulls one section into the box
src/report-render/test/render.test.ts:36:-- the bottom-margin percentage of the lineage observer
src/report-render/test/render.test.ts:38:-- the overflow-wrap guard of the stat card value
src/report-render/test/render.test.ts:40:-- the print media block that hides the chart download control
src/report-render/test/render.test.ts:42:-- the closed form of the chart menu fault, which stands hidden until a fault shows it
src/report-render/test/render.test.ts:44:-- the print media block that hides the open chart menu
src/report-render/test/render.test.ts:46:-- the closed form of the chart menu, which stands closed before the page opens it
src/report-render/test/render.test.ts:48:-- the long path data of the dense point cloud, which no short path reaches
src/report-render/test/render.test.ts:589:        -- the text gives `__proto__` and `constructor` as own keys, which an object literal cannot express.
src/report-render/gallery/test/gallery.test.ts:233:    -- the license name as a whole word of the license text
src/report-render/gallery/test/gallery.test.ts:235:    -- the license name as a whole word of the license text
src/report-render/gallery/test/gallery.test.ts:237:    -- the Creative Commons Attribution 4.0 name in its short and its long form
src/report-render/gallery/test/gallery.test.ts:239:    -- the license name as a whole word of the license text
src/report-render/gallery/test/gallery.test.ts:241:    -- the EBI license phrase of the license text
src/report-render/gallery/test/gallery.test.ts:243:    -- the public-domain notice in its hyphenated and its spaced form
src/report-render/chart-export.ts:36:-- the chart-runtime token grammar (zr<digits>-<family>-<n>); the renumbering rewrites exactly these tokens and nothing else.
src/report-render/chart-export.ts:44:-- the three attribute and reference places carry the tokens; the alternation bounds the rewrite to them.
src/report-render/chart-export.ts:155:                -- the token family (zr<digits>-<letters>) is the runtime's own naming scheme, read verbatim from the token it renumbers.
src/report-render/figures/test/manhattan.test.ts:543:    -- the chromosome-2 text form, bare or with a chr prefix, that the axis labels spell
src/report-render/figures/test/manhattan.test.ts:547:    -- the genome position line of the x axis, whose shape is a pattern
src/report-render/figures/test/sankey.test.ts:1:-- each path and text element of a chart SVG with its attributes and inner text
src/report-render/figures/test/sankey.test.ts:3:-- the width segment of the box path, drawn from x=0 as one horizontal run
src/report-render/figures/test/forest.test.ts:1:-- the inner text of each text element of a chart SVG
src/report-render/figures/test/forest.test.ts:3:-- the translated title line of an export SVG, read for its y
src/report-render/figures/locuszoom.ts:163:-- the declared unit suffix (bp, base pairs, kb, Mb) in its parenthesised form, stripped with the whitespace around it.
src/report-render/hybrid-svg.ts:74:-- the SVG root tag of the chart output, read host-side and interpolated into the page script that locates the same tag.
src/report-render/hybrid-svg.ts:76:-- the transparent background rectangle that the chart runtime writes first; the fixed attribute shape is the contract between the two sides.
src/__tests__/setup/postgres.ts:1:-- the testcontainers wait matches the Postgres readiness line of the server log
src/sandbox/test/identity.test.ts:1:-- the DNS-1123 label grammar that the K8s object name must obey, whose shape is a pattern
src/sandbox/test/k8s-client.test.ts:1:-- the DNS-1123 subdomain grammar that an ownership label value must obey, whose shape is a pattern
src/sandbox/package-identity.ts:191:-- the specifier grammar is a run of comparison characters; the parser reads the first run verbatim to accept only `==` and to report any other run.
src/sandbox/package-identity.ts:200:-- the guard reads the first intruder run of the version text to report it verbatim; the run is the compound specifier the pool must not see.
src/sandbox/exec.ts:140:    -- a deadline guard, not a wait: it aborts the controller of the in-flight submit, and the finally clears it.
src/sandbox/exec.ts:170:    -- a deadline guard, not a wait: it aborts the controller of the in-flight poll, and the finally clears it.
src/sandbox/labels.ts:36:-- the K8s label-value grammar: the bounded charset with the letter-or-digit ends; the shape is the K8s validation rule.
src/lib/page-capture.ts:145:        -- the browser runs this body as page source, so the node timers module does not exist here; the timer bounds a page that never signals.
src/lib/test/console-logger.test.ts:132:        -- the round trip is the assertion: it shows what JSON.stringify keeps of the error fields.
src/lib/test/console-logger.test.ts:134:        -- the round trip is the assertion: the default stringify of a raw Error carries no message.
src/lib/zod-issues.ts:62:-- the two call-tag closers of the model wire format, stripped from a repaired tool-call text.
src/lib/zod-issues.ts:232:            -- the markdown fence opener with its optional json tag and leading whitespace; the whitespace-to-newline rule is the fence grammar.
src/lib/zod-issues.ts:239:            -- the closing fence of a repaired block, with whatever whitespace the model left after it.
src/lib/regulatory-corpus.ts:57:    -- the split marker is a level-2 heading (newline, two hashes, whitespace); the whitespace run may cross the heading's own newline, which the string split cannot express.
src/lib/parse-json.ts:4:    -- the one JSON.parse of the tree: every caller states the schema its boundary assumes.
src/prompts/test/briefing.test.ts:1:-- a heading whose body is blank before the next heading or the end, whose shape is a pattern
src/prompts/sandbox/test/data-profiler.test.ts:1:-- the backtick-quoted camelCase tokens, whose shape is a pattern
src/input-scan/quarantine.ts:17:-- LibreOffice-style atomic writes suffix `.tmp-` with a full UUID; the dashed hex groups are the shape.
src/input-scan/quarantine.ts:19:-- the same writer without a UUID: `.tmp-` and at least eight hex digits.
src/input-scan/readout.ts:175:-- the SAM header sort order: `SO:<value>` at the line start or after a tab, ending at the next tab.
src/input-scan/readout.ts:295:-- a top-level YAML key: an identifier from the line start, then `:` and end of line or whitespace.
src/input-scan/readout.ts:315:-- an ATX heading opens with one to six `#` and a whitespace character.
src/input-scan/tokens.ts:66:-- the fixed 8-4-4-4-12 hex groups are what make an identifier machine-issued rather than written.
src/input-scan/tokens.ts:69:-- captures year, month, and day out of `2026-08-24` or `2026_08_24` for the calendar range check below.
src/input-scan/tokens.ts:71:-- the same capture for the compact `20260824` form.
src/input-scan/tokens.ts:73:-- finds a date fused inside a longer run; the lookarounds keep digits outside the date in their own runs.
src/input-scan/tokens.ts:75:-- letter and digit runs are the shape whose mean length separates written words from random class-mixed tokens.
src/input-scan/tokens.ts:77:-- splits a run into letter, digit, and `-_=` separator tokens; the three classes are the token lattice below.
src/input-scan/tokens.ts:79:-- splits a path segment into base64url-charset runs and the runs outside that charset, each whole.
src/input-scan/tokens.ts:81:-- an alphanumeric run of three or more characters inside a shared affix is identifier material to mask.
src/input-scan/shapes.ts:50:    -- the stem atomizer: digit runs, letter runs, and the delimiters between them, so `PT001_D0` splits inside each token.
src/citations/clients/common.ts:3:-- a publication year stands alone in untyped metadata; the boundaries keep the tail of a longer number out.
src/citations/normalize.ts:9:-- the DOI suffix is deliberately permissive because the registry allows nearly any character in it.
src/citations/normalize.ts:11:-- a PMID is a bounded digit run behind an optional `pmid:` prefix.
src/citations/normalize.ts:13:-- the two arXiv id shapes (new-style and old-style) behind their optional URL and `arxiv:` spellings.
src/citations/normalize.ts:20:-- punctuation and symbols carry no citation identity; they fold to spaces before comparison.
src/citations/normalize.ts:27:-- generational suffixes are noise in author comparison; the word boundaries keep the letters inside longer tokens.
src/citations/normalize.ts:122:-- an arXiv id carries a version suffix (`v3`) that the registry lookup must not see.
src/citations/normalize.ts:130:-- the phrase marks a personal communication; the boundaries keep partial words from matching.
src/citations/normalize.ts:132:-- the phrases that mark work with no registered record.
src/citations/normalize.ts:134:-- the phrases that mark work accepted but not yet registered.
src/citations/plan.ts:5:-- the words "arxiv" or "preprint" anywhere in free prose flag a preprint; the boundaries keep them inside longer words out.
src/citations/plan.ts:7:-- the same hint read off a venue string.
src/reference-data/test/catalog.test.ts:1:-- the catalog format-token grammar that the format field declares, whose shape is a pattern
src/reference-data/catalog.ts:10:-- a dataset id is lowercase segments joined by one separator; the shape is the stable-id rule.
src/reference-data/catalog.ts:12:-- a version is alphanumeric segments joined by one separator; the shape is the path-segment rule.
src/reference-data/catalog.ts:14:-- a lowercase SHA-256 digest is 64 hex digits, the fixed digest shape.
src/reference-data/catalog.ts:42:-- a format token is lowercase segments joined by one plus sign, the free-token rule the reader table keys on.
src/reference-data/catalog.ts:74:-- an organism common name is lowercase words joined by a space or hyphen; the shape keeps the search axis one canonical form.
src/data/safety-panel-schema.ts:6:-- the fixed CHEMBL<n> shape is the identifier that the ChEMBL registry issues.
src/data/safety-panel-schema.ts:10:-- the fixed six-character accession shape is what UniProt issues.
src/data/safety-panel-schema.ts:13:-- an HGNC symbol is uppercase alphanumeric segments joined by hyphens; the shape is the naming rule.
src/data/safety-panel-schema.ts:22:-- an Ensembl gene id is ENSG plus 11 digits, the fixed Ensembl shape.
src/data/safety-panel-schema.ts:25:-- a reference is one of the two prefixed provenance forms; the alternation is the rule.
src/data/safety-panel-schema.ts:46:    -- a dotted three-part version is the file format's own version rule.
src/input-sanitization.ts:66:    -- the AWS access-key format with its fixed AKIA prefix and 16-character id body.
src/input-sanitization.ts:68:    -- the Anthropic key format with its sk-ant- prefix and base64url body.
src/input-sanitization.ts:70:    -- the generic OpenAI sk- format; the (?!ant-) lookahead keeps the Anthropic label ahead of it.
src/input-sanitization.ts:72:    -- the GitHub token format with its gh*_ prefix and 36-character body.
src/input-sanitization.ts:76:        -- the three dot-separated base64url JWT segments after the eyJ signature prefix.
src/input-sanitization.ts:79:    -- the Bearer scheme with its token characters and padding, the header form of a leaked credential.
src/input-sanitization.ts:83:        -- the DB connection schemes with their :// and unquoted authority, the connection-string form of a leaked credential.
src/loop/run-agent.ts:1415:    -- the NUL-stripping reviver walks a value this code serialized one line above, not text of unknown shape; a schema proves nothing here.
src/loop/test/run-agent.test.ts:271:            -- the fake step cache mirrors the durable step cache, which re-parses each serialized tool result.
src/report-model/block-walk.ts:117:-- a free-standing numeral with its optional sign, percent, and decimals; the lookbehind keeps a symbol such as `TP53` outside the match.
src/report-model/block-walk.ts:126:-- the same left boundary with the exponent tail, so one warning names the exponent form and not its coefficient alone.
src/report-model/test/reference-stamp.test.ts:220:        -- the text gives `__proto__` as an own key, which an object literal cannot express.
```

