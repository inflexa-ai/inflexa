# Notes

Working record of the adopt-non-null-narrowing change (#706).

## Baseline (measured 2026-10-26, branch feat/706-harness-no-non-null-assertions, plugin 0.8.0)

Baseline gates before any edit: harness `bun run lint` exit 0,
`bun run typecheck` exit 0, `bun test` 6125 pass / 0 fail / 51 skip
(6176 tests, 358 files, 74 s).

Forced-on counts (throwaway config copy `tmp/oxlint-706.config.ts`, full
output `tmp/706-report.txt`; the live run after the task 1.1 flip is the
authority). The split is by `*.test.ts` extension: two files inside test
folders count as non-test by extension (`src/report-render/test/options.ts`,
2 condition reports; `src/__tests__/setup/dbos.ts`, 5 assertion reports) —
groups 6 and 8 own them.

| Rule | Reports | In tests | Non-test src |
| --- | ---: | ---: | ---: |
| `typescript/no-non-null-assertion` | 2141 | 1894 | ~247 |
| `typescript/no-unnecessary-condition` | 154 | 43 | 111 |
| `typescript/no-unnecessary-type-assertion` | 23 | 17 | ~6 |

The issue body's numbers (1902/260/1253) predate the #705 flags and the #707
sweep; they are history, not targets.

Drift ledger from #707 (archived 2026-10-25-adopt-assertion-safety,
notes.md:1991): 33 added `!` — 31 test-side same-expression construction
reads and 2 guarded production reads at `src/lib/zod-issues.ts:277,283`.
They sweep with the rest.

## Per-group records

### Group 1 record (2026-10-26, task group 1: rule flip, shared read helpers, lib and input-scan production)

**1.1 — the flip.** The three `off` entries and the `#706` comment line are
removed from `oxlint.config.ts`; the #708/#709/#710 entries and their comments
stand untouched. `bun run lint` is red from here (the sanctioned D1 mid-state).
Full live run after the flip saved at `tmp/706-live-after-flip.txt`: 2318
reports total, matching the pre-flip census.

Fresh per-rule counts, non-test vs test (the 1.1 filter excludes every path
under `**/test/` and `**/__tests__/`):

| Rule | Non-test | Test |
| --- | ---: | ---: |
| `no-non-null-assertion` | 242 | 1899 |
| `no-unnecessary-condition` | 106 | 48 |
| `no-unnecessary-type-assertion` | 1 | 22 |

Non-test per directory (worklist for groups 2–8; the live run stays the
authority):

- `no-non-null-assertion`: input-scan 75, tools 59, citations 29, memory 18,
  tasks 17, workflows 10, app 5, literature 5, loop 4, contracts 3, execution
  3, lib 3, state 4, runtime 2, sandbox 2, provenance 1, providers 1,
  reference-data 1.
- `no-unnecessary-condition`: tools 61, workflows 9, report-render 9,
  execution 5, providers 5, tasks 3, loop 2, sandbox 2, report-model 2,
  citations 1, contracts 1, lib 1, prompts 1, runtime 1, state 1, workspace 1,
  scripts/refresh-fixtures.ts 1.
- `no-unnecessary-type-assertion`: src/auth 1 (the enumerated #707 residual
  `local-auth-context.ts:23`).

**1.2 — the helper family.** `src/lib/present.ts` beside `null-proto.ts` and
`unknown-array.ts`: `presentFirst<T>(values, what?)`, `presentAt<T>(values,
index, what?)`, `presentLast<T>(values, what?)` over `readonly T[]`, and
`presentGet<V>(source, key, what?)` over `Map<string, V> | Readonly<Record<string,
V>>`. Each returns `T`/`V` and throws an `Error` whose message is
`"<what> is absent"`, with a shape-named fallback when `what` is omitted
(the element index, the key). Internal to `src/`; the barrel exports nothing.
One deviation from the design's prose, recorded for later groups:
`presentGet` takes a concrete `Map`, not `ReadonlyMap` — neither `instanceof
Map` nor `"get" in source` narrows a `ReadonlyMap | Record` union to the record
branch (measured: TS2349 / TS7053), and the overload form that does narrow
trips `typescript/unified-signatures`. A `ReadonlyMap`-typed caller keeps its
own `.get` read; widen the parameter only when a real caller needs it.

**1.2 — `src/lib` production sites (non-test reports now 0).**

- `zod-issues.ts:277,283` (the #707 drift-ledger pair): `if (key === undefined)
  return value;` after the destructure, beside the empty-path return with the
  same absence result; both reads take the narrowed `key` (D2.2).
- `rate-limit.ts` `sleepWithSignal`: an explicit `signal === undefined` early
  return that hands back the plain-timeout promise — the exact behavior the
  optional-chain path had when the signal was absent — after which every read
  uses the narrowed binding (D2.2; no absence path changed).
- `fs-helpers.ts:153` (condition report): the `?? 0` on `fsConstants.O_NOFOLLOW`
  removed as a redundant operator. Type evidence: the constants type the flag
  `number`, so the rule is right; and the old comment's runtime claim was wrong
  — bitwise OR coerces an absent flag to 0 (measured `1 | undefined === 1`), so
  removal preserves behavior whether the platform defines the flag or not. The
  comment now states the platform gap and the coercion.

**1.2 — `src/input-scan` production sites (non-test reports now 0).** Every
throwing read below sits on presence its own function guarantees by
construction or by the guard just above it; no absence path changed (D3).

- `shapes.ts`: family/bucket/merged-group heads and `rows[0]` → `presentFirst`
  (a bucket is created with one member; a group is created with one row);
  `values[i]` value sets → `presentAt` (indexes into the table built one entry
  per position); `covered`/`shapes` pair loops → `entries()`; the
  `distinctPerPosition` set table is read through `sets.entries()` so the
  binding carries the table's own length.
- `templates.ts`: family/bucket/stem heads, `items[0]` rows, `family items`,
  `merged template group` → `presentFirst`; `distinctCounts(group)[position]` →
  `presentAt` (the memo builds one entry per token kind); the `size === 1`
  literal binds `const [literal]` before the guard; the prefix trie splits
  `TrieNode` from `TrieChild & { token: NameToken }`, so `child.token` needs no
  assertion — the root is the only tokenless node and the type now says so.
- `detect-sets.ts`: `slots`/`slotIds`/`directorySlots` parallel tables →
  `presentAt` (each table is filled in lockstep with the segments that index
  it); the cross-check loops read through `entries()`; the `size === 1`
  directory literal and the `names.length === 1` cluster bind before the guard.
- `tokens.ts`: `splitStem`'s trailing part and `tokenizeName`'s dot-parts →
  `presentAt` (loop bounds); `caseTransitions` binds `value.split("")` once and
  reads its chars through `presentAt`; `classifyValues` reads the guarded
  single value and the digit width through `presentFirst` and binds the
  `size === 1` skeleton; `commonAffixes` binds `presentFirst(values)` once for
  both affix passes (guarded `length >= 2`).
- `readout.ts`: `lines[1]` (guarded `length > 1`), the found header line
  (guarded `headerIndex >= 0`), the SO:/yaml-key regex captures (the group
  always participates) → `presentAt`; the JSON and markdown fallback first
  lines → `presentFirst` (`textFields` returned early on empty `lines`, and
  `clip` dereferenced the value immediately, so the failure mode today);
  `splitDelimited` binds `line.split("")` and reads chars through `presentAt`.
- `clustering.ts`: tree path segments → `presentAt`; `skeletonKin` heads →
  `presentFirst` (a split always yields an element); the cluster merge loop
  keeps its index reads (`splice` mutates the array mid-iteration) and carries
  the bounds through `presentAt`.
- `companions.ts`: `suffixes.get(file.path)` → `presentGet` (the key is set in
  the same pass for every path that reached `roots`).
- `enrich.ts`: the work-stealing index read → `presentAt` (loop bound).
- `formats.ts`: `buf[3]` binds first and returns `"gzip"` on the impossible
  absent flag — the identical outcome of today's numeric coercion of
  `undefined`; `innerExtensions` reads its last element through a bound guard.
- `markers.ts`: the first path segment after a `split` → `presentFirst`.
- `menu.ts`: the correspondence pair loops → `entries()`.
- `quarantine.ts`: the last path segment → `presentLast`.
- `scan.ts`: `queue.shift()` binds and breaks on `undefined` (the `while`
  condition already exited on the empty queue).

**Verification (group 1 scope).** `bun --bun oxlint src/lib src/input-scan`
filtered to non-test paths: 0 reports from all three rules (the remaining
reports in those directories are all under `test/`, owned by groups 6–8).
`bun run typecheck`: exit 0. `bun test src/lib/test/rate-limit.test.ts
src/lib/test/fs-helpers.test.ts src/lib/test/zod-issues.test.ts`: 55 pass /
0 fail. `bun test src/input-scan`: 150 pass / 0 fail. The four
`src/tasks/test/data-profile-*.test.ts` consumers of input-scan: 83 pass /
0 fail. Each changed `src/` file was passed through `bun run format:file`.

## Artifact-review corrections record (coordinator, 2026-10-26)

Sources: two viv-issue-reviewer runs (zai/glm-5.3:high, zai/glm-5.3-flash:high),
codex artifacts review, claude artifacts review, coordinator audit. All
supported findings corrected in one pass; none needed a maintainer ruling.

- D3 rewritten: a `!` erases at runtime; only the following dereference
  throws. Immediate-dereference sites keep the failure through the D2.1
  helper (an `Error`, not the same error class); value-flows-on sites add no
  throw (codex C2, claude C1, reviewer B).
- D2.6 now sorts the condition reports into four outcomes — dead code
  (delete the dead part only: a dead guard around live assertions goes, the
  body stays), wrong type (with a stop rule for barrel-re-exported types and
  zod schema outputs), redundant operator (removed, expression stays), and
  rule false positive (live guards TS CFA cannot see through, with the
  recorded devices: wider annotation, `for (;;)` rewrite, call-site
  annotation; never a deletion) (codex C1, reviewer A W1, reviewer B W1,
  claude W4).
- D2.2 and task 1.2 corrected: the zod-issues fix is an explicit
  `if (key === undefined) return value;` after the destructure — a length
  check does not narrow an element read under `noUncheckedIndexedAccess`
  (claude W2, reviewer A W2, reviewer B W2; verified against the code).
- D2.1 names the helper family (`presentFirst`, `presentAt`, `presentLast`,
  `presentGet`, optional description, internal to `src/`, not
  barrel-exported); proposal aligned to the same shared family for repeated
  test reads (codex W1, claude W1/W3).
- Task 1.1 defines the non-test filter for the scoped runs; notes.md table
  caption names the extension-vs-folder split (claude W5, reviewer A S3/S6).
- "Zero `!`" wording now says non-null assertion expressions; logical
  negation stays (codex W2).
- Spec delta adds the no-`!` scenario; task 9.1 adds the oxlint.config.ts
  diff check and names the archived residual list, minus the swept
  `src/auth/local-auth-context.ts:23` site (claude S3/S4, reviewer B; the
  report at tmp/706-report.txt confirms that site carries
  no-unnecessary-type-assertion).
- Context adds the literal-comparison category and the false-positive
  category; task 8.1 names the lib/provenance/schemas/prompts test files;
  per-file counts dropped from the artifacts (the live report holds them)
  (reviewer A S4/S5, claude S1/S2).
- D2.4 softened: several distinct read shapes; a shared narrowing only where
  the shape truly repeats (claude S2).

### Group 2 record (2026-10-26, task group 2: citations, tasks, providers, tools, workflows)

Start: 195 non-test reports in scope (live run `tmp/706-group2-live.json`).
End: 193 fixed; 2 live guards remain reported (below). `bun run typecheck`
exit 0; module tests of the changed directories 2365 pass / 0 fail / 23 skip;
`bun run format:file` ran on every changed file. Task 2.1 is left UNCHECKED
pending the maintainer ruling on the two remaining sites.

**Helper family extensions (`src/lib/present.ts`, used across the group).**
`presentFind<T>(values, matches, what?)` for a find-by-key whose construction
guarantees the hit (`resolve.ts` plan lookups). `presentGet` gained an overload
pair so a non-string key works: `presentGet<K, V>(source: Map<K, V>, key: K)`
alongside the string-keyed record form (the `ids: Map<DraftGroup, string>`
lookups of `data-profile-resolve.ts`). Measured: the overload form does NOT
trip `typescript/unified-signatures`, contrary to the group-1 worry.

**Throwing reads with their guarantee (D2.1).** `resolve.ts` (the settled
request, entry/uncached/outcome-table indexes, the `firstByKey`/`pending`/
`outcomesByKey` lookups of keys inserted in the same pass, `resolveOne`'s
single result); `match.ts` (UnionFind parent links, cluster/record loop
bounds); `data-profile-resolve.ts` (`set.members` at a claim's recorded index,
`byValue` buckets of keys iterated from the map itself, the `paths.length === 1`
head); `data-profile.ts` (`split("\n", 1)` head); `data-profile-index.ts`
(`formats.length === 1` head); `refresh-regulatory-corpus.ts` (embeddings
filled in lockstep with chunks); `data-profile-resolve.ts` map lookups of keys
set in the same pass (`ids`, `claimants`, `byPath`, `byValue`); `cbioportal-client.ts`
and `impc-client.ts` (`get` of keys set on the line above); `iuphar-client.ts`
(batch/subunit lockstep tables); `chembl-client.ts` (median indexes below
`length`); `alphafold-client.ts` (`length === 0` early return); `pubmed.ts`
citation client (`results` filled before the read); `show-file.ts` (`.min(1)`
parse guarantee, already commented); `grep.ts` line bounds; `web-fetch.ts`
(non-empty stack head); `execute-analysis-scheduler.ts` (step map of the plan's
own steps, non-empty stack head); `workflows/execute-analysis.ts` (`stepRuntime`
seeded for every input step, `stepIndexById`, the winning child's in-flight
entry); `gene-disease-evidence.ts` / `search-regulatory-approvals.ts` /
`search-patents.ts` (`length > 0` heads); `lookup-annotation.ts` contract read.

**Guards and restructures (D2.2/D2.3).** The refine-validated tool inputs
(chembl, pubmed, pubchem, opentargets, search-clinical-trials,
lookup-annotation, search-regulatory-approvals, search-patents,
update-working-memory, web-search, tools/execute-analysis): the schema
`.refine` admits only calls that carry the action's fields ("fails at the loop
boundary, without reaching execute" — the module doc of chembl.ts), so each
read gained an explicit `undefined` check that throws with the action's
requirement in the message; the throw sits on a path the refine makes
unreachable, and no absence path changed. One behavior bug CAUGHT and FIXED
en route: the first `toFindingOp` guard threw on revise/retire, which omit
`runId` lawfully — the guard moved inside the add branch
(`update-working-memory.ts`), tests green again. `suspension.ts` `cancelSelf`:
the SDK types `cancelWorkflow(workflowID: string)` while `DBOS.workflowID` is
`string | undefined`, and the sandbox-step test fake records the call verbatim
(undefined included), so the assertion became `?? ""` pass-through with a
comment — production always has the id (data-profile's caller guards it), and
the fake's recorded value is only counted, never compared. `crossref.ts` exact
branch restructured into `if (exact) { guard; build } else { build }` so the
narrowing reaches `encodeDoiPath`. `errors.ts` `suspendOn[status]!` became a
bound reason check that falls through on absence — same reachable-path
behavior as the `Object.hasOwn` guard it replaced. `read-tool-output.ts` and
`list-available-refs.ts` pops: bind + `undefined` break beside the loop's own
empty exit. `tools/execute-analysis.ts`: the plan/adhoc branch split so
`planId`/`request` narrow without assertions.

**Dead-code deletions (D2.6, with type evidence).** `errors.ts`:
`|| cursor === null` after the loop's `&& cursor` truthiness (no overlap).
`dgidb-client.ts`: `!body ||` after the isErr throw (Result value non-nullish).
`clinical-benchmarks-client.ts`: the whole `phase_transitions.all` load guard —
the JSON module's own type declares the field (the #707 annotation at line 37
is backed by it), so the guard cannot fire. `clinical-trials-client.ts`:
`!== null` on `.optional()` string fields (null not in the type).
`drainChildSuspensions`: `msg.kind === "suspended"` (ChildSuspended.kind is the
literal); `while (true)` became `for (;;)` (D2.6 device).
`mutator.ts`/`start-report-session.ts`/`authoring-tools.ts`/
`tools/execute-analysis.ts`: `scope.kind !== "analysis"` deleted — `Scope.kind`
is the `"analysis"` literal (auth/types.ts:35), the comparison has no overlap;
the tools/execute-analysis auth check (`!ctx.session.auth`) went with it
(non-nullish per the session type). `ad-hoc-router.ts`:
`&& !input.signal.aborted` after the catch's rethrow narrows it false.
`execute-analysis.ts`: six `durationMs ?? undefined` (field is `number`).
`match.ts` / `data-profile-resolve.ts:158`: filter+map pairs became flatMap
with the guard inside. `execute-analysis.ts` describeCall: `depends_on ?? []`
removed (`depends_on` required).

**Redundant operators removed (D2.6, expression kept).** openfda-client (14),
gwas-catalog (6), clinvar (4), ctx-ops (3), cbioportal (6), dgidb, pharmgkb,
clinical-trials (2), impc (2), search-geo-datasets (3), ai-sdk (3 usage
`?.` + `timer.unref?.()` — web-fetch.ts:306 already calls `unref()` plainly,
the stale DOM comment went with it), web-fetch (`dom.document.body.textContent`
is typed `string`; `?? ""` dead), tools/execute-analysis describeCall request
fallback (type non-optional; the refine guarantees it in adhoc mode).

**Wrong-type corrections.** None that touch a barrel type or a zod output a
consumer reads; the stop rule never fired. `crossref.ts`/`doi-registry.ts`
`parseYear(...)!` — the `!` dropped and the possibly-undefined result flows
into `year?: number` (same runtime value the assertion erased).

**Rule false positives (D2.6) — two LIVE guards remain reported.**
- `src/tasks/data-profile.ts:806` (`!accepted`) and `:853` (`selfCancelled`):
  fixed with the recorded device — the closure-assigned locals dropped their
  initializers and carry the wider annotation (`boolean | undefined`; the
  object union `| undefined`), and the one `!== null` read became
  `!== undefined` (same falsy semantics). Reported no more.
- `src/tools/workspace/grep.ts:169` `if (matches.length === 0)` and
  `src/tools/display/normalize-echart-spec.ts:200`
  `out.graphic !== undefined` — STILL REPORTED. Both guards are live
  (no_matches is a real outcome; a spec may carry a graphic annotation).
  Evidence gathered: tsgolint models a pushing closure as an UNCONDITIONAL
  mutation (probe: one direct `push()` call makes a later `length === 0`
  "always falsy"), and it specializes callees ACROSS modules (the devices an
  opaque initializer `emptyArray<T>()`, a cross-module `isEmptyArray`, a
  same-file helper, a hoisted read, a `const graphic: unknown` local, and
  `"graphic" in out` all still reported). A deletion is forbidden (D2.6), and
  no recorded device silences the rule. LEFT FOR THE MAINTAINER: rule the
  device (e.g. a tsgolint escape for closure-mutated containers, or a
  sanctioned recorded exception in the #707 pattern).

**Notes for later groups.** `data-profile.ts:809`'s #707 destructuring
annotation still compiles (the post-guard narrowing excludes undefined). The
`presentFind`/overload additions are internal to `src/`; the barrel is
untouched. The tasks/test and tools/test populations seen in this run's
outputs are groups 5–8 work, untouched here.

## Group 2 closure record (coordinator, 2026-10-26)

Maintainer ruling (2026-10-26, through the parent): the two residual
no-unnecessary-condition reports close with per-site
`oxlint-disable-next-line no-unnecessary-condition` directives in the
`input-sanitization.ts` form, exactly two sites, no config exception.

Site identities corrected against the handoff (the file:line sites were
right; the expressions named were not):
- `src/tools/workspace/grep.ts:168` — the live guard is `if (truncated)`,
  not `matches.length === 0` (which does not report: the pushing-closure
  mutation is modeled). `truncated = true` sits inside the walk/searchFile
  closures.
- `src/tools/display/normalize-echart-spec.ts:200` — the reported value is
  `rotated` in the bottom-margin ternary, not `out.graphic` (which does not
  report). `rotated = true` sits inside the normalizeAxis closure.

The eight measured restructures that failed (six by the group-2 run: opaque
initializer, cross-module isEmptyArray, same-file helper, hoisted read,
wider-annotated local, `in` check; two by the coordinator: `matches.at(0)
=== undefined`, `Object.hasOwn`): the analysis model itself keeps the
boolean initializer across the closure assignment, so no sound local shape
clears it. The directives are the last resort, not the first.

Applied and verified: `bun --bun oxlint` on both files exit 0;
`bun test src/tools/workspace/test/grep.test.ts
src/tools/display/test/normalize-echart-spec.test.ts` 54 pass / 0 fail.
Design D2.6, D4, and task 9.1 amended to enumerate the two sites.

### Group 3 record (2026-10-26, task group 3: the rest of src and scripts)

Start: 75 non-test reports in scope (live run `tmp/706-group3-live-raw.json`).
End: 71 fixed; 3 live guards remain reported in `src/execution/run-event-stream.ts`
(below — the maintainer-ruling class, left for a ruling, no directive added).
`bun run typecheck` exit 0; the module tests of the changed directories 3459 pass
/ 0 fail / 28 skip; `bun run format:file` ran on every changed file. The helper
family gained nothing: `presentFirst`/`presentAt`/`presentLast`/`presentGet`
carried every site.

**Throwing reads with their guarantee (D2.1).** `data-profile-orientation.ts` /
`data-profile-view.ts` (the `length === 1` format heads); `chat-turn.ts` (the
pending turn under the `opened()` guard); `collector.ts` (a split always yields
the script path); `arxiv.ts` (the capture group always participates); `run-agent.ts`
(dispatch loop bounds, the trailing call behind the `length === 0` continue, the
backward walk bound); `catalog.ts` (the `has` guard above the map); `topo-sort.ts`
(every `dependents`/`stepById` key is a validated step id); `exec.ts` (the
non-empty new-event head); `init.ts`, `thread-history.ts`, `thread-store.ts`
(scalar SELECTs — `current_schema()`, `COALESCE(MAX …)`, `EXISTS + MAX`, `COUNT(*)`
— give exactly one row); `working-memory.ts` `runOfFinding`/revise/retire (the key
came from `Object.keys` of the same record); `conversation-view.ts` (loop bounds,
the open last turn behind the `length === 0` branch); `tool-call-integrity.ts`
(loop bounds and the insert-point bound); `sandbox-error.ts` (a split always
yields the first cause line); `dbos.ts` (the default level is a literal key of the
rank record; the passes check reads a `keyof`).

**Guards and restructures (D2.2/D2.3).** `http.ts` `delay`: an explicit
`signal === undefined` early return that hands back the plain-timeout promise —
the exact behavior the optional-chain path had — after which a `const` binding
carries the narrowed signal into the listener closures. `vector-store.ts` upsert
and `artifacts.ts` updateFileIds: `presentAt` on the loop bounds. `working-memory.ts`
and `message-backfill.ts`: the `length` checks became bound-first `undefined`
checks with the same absence outcome. `card-builders.ts` `deriveRunId`: the
segment bound before the guard. `chat-frame.ts` `tool-finished`: the
closure-set `started` flag became a `parts.some(...)` read plus a map that
replaces every match — the flag is derived, no closure mutation, same output.

**Dead-code deletions (D2.6, with type evidence).** `run-agent.ts:368`:
`?? agent.id` — `Provenance.agentId` is `string` (`auth/types.ts:59`), the
comparison has no nullish left side. `vector-store.ts` `buildIndex`: the whole
`type !== "hnsw"` guard — `BuildIndexInput.indexConfig` is
`{ readonly type: "hnsw" }` (vector-store.ts:53), the only caller passes the
literal; the unused binding left the destructure. `create-sandbox.ts`: the whole
`if (!spec.resources)` rejection — `SandboxSpec.resources` is required
(sandbox/types.ts), every caller is typed, and the stale "rejects a sandbox with
none" sentence left the field doc. `metrics.ts` `hasReportedUsage`: `Object.values`
became `TOKEN_USAGE_FIELDS.some((field) => usage[field] !== undefined)` — tsgolint
drops `undefined` from `Object.values` element types (probe), the field
enumeration keeps the comparison live-typed and folds with the same list the
module already pins the three declarations to. `manhattan.ts:399`:
`groupColumn === undefined ?` — `channelColumn` returns `string`
(`contracts/report-blocks.ts:598`). `pca.ts:244`: the conjuncts swapped so the
direct `labelColumn !== undefined` narrows first and the `labeled` alias is not
restated. `locuszoom.ts` `locusColumns`: `Object.values(found)` became the literal
array of the six columns — same tsgolint `Object.values` model, same order; the
`:439` read lost `x !== undefined` — `room.xs` is `readonly (number | null)[]`
(locuszoom.ts:404) and `.entries()` never yields `undefined`. `chart.ts`
`plottedSeries`: the `entry.x`/`entry.y` guards — both fields are required on
`ResolvedSeries` (chart.ts:2035-2036), only `y0` is optional. `chart.ts`
`thinnedLabels`: the closure-set `thinned` flag became a reference-identity read
(`thinnedAxes.some((axis, index) => axis !== axes[index])`) — thin returns the
input unchanged when it does nothing, so identity is exactly the old flag.
`production-resolver.ts` / `fixture-resolver.ts`: `|| cell === null` deleted —
no producer can put `null` in a resolved row: `coerceCell` drops it
(production-resolver.ts:283) and `snapshotRows` refuses the row cell
(reference-resolver.ts:86-88); the fixture annotation narrowed to the initializer's
`string | number | undefined` and both comments now state the absent-key fact.
The two `run-event-stream.ts` closure booleans `parentDrained` (:321) and
`sawTerminal` (:377) and the `signal.aborted` re-check after `await onPart`
(:231) are NOT fixed: all three are live guards the analysis cannot see through,
the D2.6 residual class (a value set outside the straight-line flow — closure or
external abort — whose initializer the model keeps). The eight group-2
restructures do not apply to a promise-settlement or mid-batch-abort shape
without inventing timing. LEFT FOR THE MAINTAINER: rule the device for the three
`src/execution/run-event-stream.ts` sites (the 2026-10-26 ruling covers exactly
`grep.ts` `truncated` and `normalize-echart-spec.ts` `rotated`).

**Redundant operators removed (D2.6, expression kept).** `filesystem.ts:353`:
`?? 0` on `fsConstants.O_NOFOLLOW` — the constants type the flag `number`; the
comment now states the platform gap and the bitwise-OR coercion. `result-serialization.ts`
and `scripts/refresh-fixtures.ts`: the lying `JSON.stringify` signature (typed
`string`, gives `undefined`) got the honest-signature wrapper — a module-local
`stringifyJson(value: unknown): string | undefined` — because the D2.6 call-site
annotation device is measured broken (tsgolint types an initialized local from
its initializer, not its annotation; probe `tmp/pi/706-probe.ts`). The guards
then type live and stand.

**Wrong-type corrections.** None that touch a barrel type or a zod output a
consumer reads; the stop rule never fired.

**Drift-ledger sites swept.** None in this group: the two production reads of
the #707 ledger are `src/lib/zod-issues.ts:277,283`, swept in group 1. The one
enumerated #707 residual in this group's scope, `{} as AuthContext` at
`src/auth/local-auth-context.ts:23`, is swept: the assertion dropped (the brand
is an optional phantom, `{}` satisfies `AuthContext` directly) and its SAFETY
comment went with it; the archived #707 residual list shrinks by that site.

**Verification (group 3 scope).** `bun --bun oxlint src scripts` filtered to
non-test paths: 0 reports from the three rules and from `no-unused-vars`, except
the three recorded `run-event-stream.ts` guards. `bun run typecheck`: exit 0.
`bun test` over the changed directories (`src/app src/provenance src/literature
src/loop src/reference-data src/execution src/contracts src/memory src/runtime
src/workspace src/prompts src/report-render src/report-model src/auth`): 2935
pass / 0 fail / 28 skip; `src/sandbox src/state`: 524 pass / 0 fail. `bun run
format:file` ran on every changed file.

## Group 3 closure record (coordinator, 2026-10-26)

Second maintainer ruling (2026-10-26, through the parent): the sanction
extends to three more sites of the same class, now named the
closure-and-event analysis fault. Five enumerated sites total:
- src/tools/workspace/grep.ts (`truncated`, walk closures)
- src/tools/display/normalize-echart-spec.ts (`rotated`, normalizeAxis
  closure)
- src/execution/run-event-stream.ts:231 (event-wired `signal.aborted`
  re-check after each delivered part)
- src/execution/run-event-stream.ts:321 (`signal.aborted` again, and
  `parentDrained` set by the `parentRead` `.finally`)
- src/execution/run-event-stream.ts:377 (`sawTerminal` set by the
  readWorkflowStream closure; the missing-terminal fallback)

Escalation rule for the rest of the change: a sixth site of this class
stops for a ruling, and the parent files an issue against the analysis
model (inflexa-ai/lint) rather than accumulating directives.

Applied and verified: `bun --bun oxlint src/execution/run-event-stream.ts`
exit 0; `bun test src/execution/test/run-event-stream.test.ts
src/execution/test/run-event-parts.test.ts` 52 pass / 0 fail;
`bun run typecheck` exit 0. Design D2.6 and D4, and task 9.1, updated to
the five-site enumeration and the class name.

### Group 4 record (2026-10-26, task group 4: test sweep of loop and app)

Start: 358 reports in scope (live run saved at `tmp/pi/706-group4-live.txt`:
348 `no-non-null-assertion`, 5 `no-unnecessary-condition`, 5
`no-unnecessary-type-assertion`). End: 0 reports under `src/loop` and
`src/app`, production and test files. 20 test files changed; no production
file was touched in this group. The #707 drift-ledger sites in these
directories, if any, swept with the rest (every report closed).

**Fix shapes.** 276 reads through the present-family helpers (loop:
presentFirst 100, presentAt 62, presentLast 20, presentFind 7; app:
presentFirst 51, presentAt 21, presentLast 10, presentFind 4, presentGet 1)
— each a read of a value the test just built, each throwing on absence so
the test fails loudly (D2.5). 27 one-off sites narrowed in place: a bind
plus an explicit `undefined`/`null` check that throws (the D2.2 form; the
`getThread()._unsafeUnwrap()` rows, `capture.finish`, the
`compactionParts`/`normalizeDetail` values). 5 dead conditions deleted with
type evidence (below). `?.` into a matcher only where the matcher fails on
absence: `storedTurn?.durationMs` over `toBeGreaterThanOrEqual`
(chat-turn.test.ts:463).

**Dead-code deletions (D2.6, type evidence).**

- chat-turn.test.ts:735 `request.system !== undefined &&` — `ChatRequest.system`
  is `string | SystemModelMessage`, never undefined (providers/types.ts:56).
- spawn-report-session.test.ts:512 `|| delta.newestChild === null` —
  `newestChild` is `NewestReportChild | null` (spawn-report-session.ts:162);
  `undefined` has no overlap.
- metrics.test.ts:107,147 `histogram === null` conjuncts — the datapoint
  value types as `number | Histogram | ExponentialHistogram`, never null.
- run-agent.test.ts:152 `blocks.every((b) => b.type === "tool-result")` —
  literal-vs-literal: `toolResultParts` filters with the same type
  predicate, so `b.type` is the `"tool-result"` literal; the length
  assertion above stays.

**Vacuous-pass hazards found and closed.** Bun's `toEqual` ignores
undefined-valued expected properties (jest semantics), so two shapes would
have passed with the value absent: `durationMs: done!.durationMs!` inside a
`toEqual` object (run-agent.test.ts:2895) and `toEqual(LEGACY.files!)`
(data-profile-view.test.ts:112). Both closed with a bind-plus-throw narrow
before the assertion, never with `?.`. The permitted `?.` and plain-index
reads lean only on matchers that fail on absence (`toEqual`, `toMatchObject`,
`toBeTypeOf`, `toBeGreaterThanOrEqual`).

**Notes for later groups.**

- `presentFind` keeps its `(value: T) => boolean` parameter and returns `T`,
  so a find whose type predicate narrows to a union member loses the narrow
  (measured in run-agent's `finishedDurationMs`). The used workaround:
  filter with the type predicate first, then `presentFind` on the
  member-typed array. A predicate overload on `presentFind` (the
  `presentGet` overload pattern) is the candidate family extension; not made
  here, the group brief kept `src/lib` untouched.
- `presentFirst` over a union-of-array-types value (metrics'
  `iterations.dataPoints`) infers `T` from the use site and fails to compile
  (TS2339/TS2345); the site keeps `[0]?.value` into its existing throw guard.
- A destructure of possibly-undefined elements (`const [a, b] = parts`)
  cannot carry the narrow; the replaced form is one `presentAt` binding per
  element, or a bound pair with one shared guard (run-to-terminal
  `firstRequest`/`salvageRequest`).
- Assignment through a present read mutates in place through the object
  reference: `presentAt(steps, slot).value = value` (run-agent),
  `presentFirst(bad.findings).stepId = ...` (synthesize-run).

**Verification (group 4 scope).** `bun --bun oxlint src/loop src/app`
exit 0 — the three rules report nothing in production and test files.
`bun run typecheck` exit 0. `bun test` over the 20 changed files: 470 pass /
0 fail. `bun run format:file` ran on every changed file.

## Interruption repair record (coordinator repair run, 2026-10-26)

The group-5 implementor run was cut off by a provider limit mid-edit. It left
half-applied conversions across its own scope (src/sandbox, src/tools,
src/providers, src/literature) and beyond it (src/memory, src/execution,
src/lib, src/provenance, src/input-scan, src/agents, src/citations,
src/contracts, src/state, src/workflows, src/tasks test files). After the
coordinator's two mechanical repairs (12 malformed `in presentAt(` sites, 136
wrong-depth `lib/present.js` import paths rewritten), `bun run typecheck`
showed 117 semantic errors in 37 test files. This repair run closed all 117
and restored a consistent tree. No `!`, no `as`, and no lint directive was
added; no production file was touched.

Error classes repaired:

- Mangled identifiers from the interrupted write. A space after `return` or
  `typeof` was eaten (`returnpresentAt`, `returnpresentFind`,
  `typeofpresentAt`), and an `in` prefix of a receiver was eaten
  (`presentAt(puts` for `inputs`, `presentAt(put` for `input`,
  `dopresentAt(omed` for `doomed`). Restored to the intended helper call with
  the real receiver: input-signature.test.ts:35, exec-frame.test.ts:348-352,
  zod-issues.test.ts:342, purge-analysis.test.ts:535, k8s-client.test.ts:507
  (restructured to the file's bind-and-throw podSpec guard),
  knowledge-tools.test.ts:328, configured-provider.barrel.test.ts:291,
  generate-plan.test.ts:839-841 and :912 (a filter predicate that had swallowed
  the helper call), string/impc/bgee fixtures (`typeof presentAt(...)`).
- Wrong-shape helper use. `presentAt`/`presentFirst` over a Record →
  `presentGet` (catalog.test.ts:40, generate-plan.test.ts:114,
  ad-hoc-router.test.ts:432, tools execute-analysis.test.ts:146 and :1293,
  reaper.test.ts:111, grep.test.ts:22, workflows execute-analysis.test.ts:369).
  `presentGet` over a `ReadonlyMap` (data-profile-resolve.test.ts:657) hit the
  recorded group-1 helper limitation; the site keeps its own `.get` read with a
  bind-and-throw guard, per that record.
- Half-applied optional chains. `.spec.template?.spec(…)` →
  `.spec?.template?.spec(?.containers…)`, `.metadata.name` → `.metadata?.name`,
  `sandboxOf(created).labels` → `sandboxOf(created)?.labels`,
  `gateway.peek("t1").document?.sections[0].blocks[0]` →
  `gateway.peek("t1")?.document?.sections[0]?.blocks[0]` (k8s-client,
  docker-client:514, authoring-tools.test.ts:214,242). Each feeds an existing
  or added `undefined` guard, so absence still fails loudly.
- Narrowing lost where a `!` was deleted with no replacement. Bind-and-throw
  guards: dbos-run-launcher.test.ts:82 (context and span), thread-history
  (tombstone rows, evicted metric points, first createdAt),
  clinical-trials-client.fixtures.test.ts:69, examine-page.test.ts:352,
  preview-report.test.ts:649, tools execute-analysis.test.ts `newestStartedAt`,
  workflows execute-analysis.test.ts:1007, shapes.test.ts:68. Guards corrected
  from `=== undefined` to `=== null` where the store returns null (uniprot
  client fixtures, report-session-state.test.ts:105-108,
  report-versions.test.ts:316). Value-level fixes that let the assertion fail
  on absence: `group.unclassified === true` (absorb.test.ts:309), `args[0]` as
  a tuple read (data-profile.trigger.test.ts:341), `?? {}` / `?? ""` /
  `?? null` into assertion-backed positions (card-builders:139, ctx-ops:195,
  tool-outputs:36, report-session-state:179).
- The tsc control-flow `never` fault on closure-captured spy configs
  (create-sandbox.test.ts, two blocks). The mock assigns the captured config
  inside a closure, so tsc keeps the `null` initializer at the read. The reads
  now go through a function-boundary reader whose return type is the declared
  `Config | null`, then a bind-and-throw guard — the closure sees the declared
  type, so no assertion and no cast is needed.
- cpu-files.test.ts: the `processorCount` helper now takes
  `string | undefined` and reads `0` processors from an absent cpuinfo, so a
  missing file fails the count assertion instead of typechecking as an erased
  assertion.

Formatting: the interrupted run never reached its `format:file` step, and it
had written `=presentAt` (no space) at ~250 sites across 93 test files. Prettier
ran over all 93 (the 37 repaired files plus 56 conversion-only files it had
touched); the mangle pattern is gone tree-wide.

Verification. `bun run typecheck`: exit 0, 0 errors. Module tests of the 37
repaired files: 919 pass / 1 skip / 0 fail (the skip is the
`CORTEX_LIVE_API_TESTS`-gated live Open Targets test; its body is covered by
the typecheck). `bun test` over the 56 conversion-only files the interrupted
run had left unverified: 1002 pass / 13 skip / 0 fail — their conversions are
behaviorally sound. `bun run format:file` clean on all 93.

State handed to the groups: typecheck green; the tree holds only lint-visible
residue (`!` on lines that typecheck, for example k8s-client.test.ts
`metadata!.labels`, and the `=presentAt` spacing is gone). The owning sweep
groups close those under their own scopes; nothing in this repair widened any
group's brief.

## Group 5 record (2026-10-26, task group 5: test sweep of sandbox, tools, providers, literature — CLOSED)

Scope: 216 reports (live run saved at `tmp/pi/706-group5-live.txt`; the live run stays the
authority). The main run closed 155 and stopped at its tool budget. The continuation run
closed the last 61 over 26 files. Final state: the three rules report nothing under
`bun --bun oxlint src/sandbox src/tools src/providers src/literature`.

**Closed in the main run (155; 0 reports left in these files).** `src/sandbox`:
k8s-client.test.ts, docker-client.test.ts, exec.test.ts, mount-plan.test.ts,
reaper.test.ts (also drops the unused `presentAt` import the interrupted run
left). `src/tools`: authoring-tools.test.ts, drug-gene-interactions.test.ts,
comptox.test.ts, gene-disease-evidence.test.ts, preclinical.test.ts,
translational-medicine.test.ts, search-protein.test.ts,
alphafold-prediction.test.ts, generate-plan.test.ts, derive-table.test.ts.

**Fix shapes.** Reads of what the test just built went through the present
family or a bind-and-throw narrow (D2.5/D2.2). File-local helpers where the
family cannot reach: `peeked(gateway, threadId)` (authoring-tools — the fake
gateway's rows Map is private), `sandboxOfCreated` over a shared
`sandboxPredicate` (docker-client — 22 same-shape `sandboxOf(created)!`
reads), `outcomeOf` (drug-gene-interactions, gene-disease-evidence),
`planIdOf` (generate-plan). `?.` only into a matcher that fails on absence
(`toBe`, `toContain`, `toMatchObject`, `toHaveLength`) or behind an added
`undefined` guard.

**Dead conditions and redundant operators (D2.6).** k8s-client.test.ts: the
`?.` before `.template` on 12 `.spec?.template…` chains —
`V1JobSpec.template` is required (`V1JobSpec.d.ts:67`), and
`V1PodTemplateSpec.spec` is the optional hop; `v?.name` where the `find`
predicate parameter cannot be nullish (k8s-client.test.ts:1152 area).
authoring-tools.test.ts:214,242 — the `?.` after `.document`, which is
required on `ReportSessionState` (authoring-tools.ts:205). The two literal
comparisons in web-fetch.test.ts:308 and mutate-surface-e2e.test.ts:129 went
in the continuation run (recorded there).

**Assertion reports (closed).** record-version.test.ts:386 (`versionId!` inside a `toBe`
compare — the bind-plus-throw form the group-4 record prescribes for a value compare) and
template-binding.test.ts:226 (`substitute_for!` inside `toEqual` — the recorded
toEqual-ignores-undefined hazard; bind-plus-throw before the assertion). Each site held a
`no-non-null-assertion` and a `no-unnecessary-type-assertion` report; the one fix closed
both.

**Inference finding for later groups.** `presentFirst(values ?? [], what)`
over an optional array returns the FIRST ELEMENT, not the array: the `?? []`
operand makes the argument type `T[] | never[]`, and inference collapses the
candidates to `T` (measured at drug-gene-interactions.test.ts, where a
follow-up `presentAt` on the result failed to compile). So the form replaces
`values![0]!` directly and correctly, but a site that needs the whole array
binds first and throws on absence. Sites that use it as the element read say
so with their `what` string.

**Verification (main run's closed files).** `bun --bun oxlint src/sandbox
src/tools src/providers src/literature`: the 155 closed reports are gone. `bun run
typecheck`: exit 0. `bun test` over the 15 changed files: 359 pass / 0 fail.
`bun run format:file`: clean on all 15.

**Closed in the continuation run (61 reports, 26 files).** `src/tools/lib/test`:
uniprot-search 6, ctx-ops 6, openfda-client 4, dgidb-client 3, clinical-trials-client 3,
drugbank-client 1, iuphar-client 1. `src/tools/knowledge/test`: knowledge-tools 5,
template-binding 4. `src/tools/memory/test`: update-working-memory 5.
`src/tools/report-session/test`: examine-page 3, record-version 3, list-artifacts 1,
preview-report 1. `src/tools/workspace/test`: mutator 3, execute-command 1, write-file 1,
mutate-surface-e2e 1. `src/tools/test`: describe-call 1, execute-analysis 1, registry 1.
`src/tools/research/test`: web-fetch 1. `src/providers/test`: ai-sdk.request-timeout 2.
`src/providers/integration/test`: anthropic-caching 1, opentargets 1.
`src/literature/sources/test`: http 1. `src/sandbox` stayed untouched (already clean).

**Fix shapes (continuation).** Reads of schema-parsed fixtures went through the present
family: `presentFirst(response.results ?? [], "the first result row")` over an optional
`results` array (uniprot-search, openfda, drugbank — the element-read form of the recorded
`?? []` finding, named with its `what` string), `presentGet` over the OpenAPI excerpt
record and the registry definitions (ctx-ops, registry), `presentAt` over indexed fixture
rows (clinical-trials, update-working-memory, dgidb), and `presentFind` over a searched
tool or interaction list (template-binding, dgidb). One-off binds with a throwing guard:
the iuphar family record and the opentargets info (`=== null` — the clients return null),
the dgidb EGFR node (`=== null` — a GraphQL node the mapper may drop), the recorded
version id before its `toBe` compare, and the abort signal of the literature http double.
Optional tool hooks (`describeCall`, `describeResult`, `foldCallRecord`) bind once and
throw when the tool declares none (examine-page, list-artifacts, preview-report,
record-version, describe-call, mutator, write-file, execute-command). The tuple
destructures of `createKnowledgeTools` became one `presentAt` binding per element (the
recorded destructure limitation). `apiKey: API_KEY ?? ""` (anthropic-caching) follows the
swept amass.integration.test.ts:20 idiom — the `describe.skipIf(!API_KEY)` gate keeps the
empty string away from every call.

**Dead conditions and redundant operators (D2.6, continuation, type evidence).**

- web-fetch.test.ts:308 `options.all === true` — the lookup seam types `options` as
  `LookupAllOptions`, whose `all` is the `true` literal (web-fetch.ts:80). The comparison
  goes, the operand stays, and the `toEqual([true])` assertion keeps its meaning.
- mutate-surface-e2e.test.ts:129 `if (out.status === "ok")` — `_unsafeUnwrap()` returns
  the ok variant only, so the guard is a literal-vs-literal tautology around live
  assertions. The guard goes; the three assertions stay.
- ai-sdk.request-timeout.test.ts:400,405 `setTimeout(...).unref?.()` — `unref` is a
  required member of the timer type. The optional chain goes.
- opentargets.integration.test.ts:23-32 — the `?.` hops after
  `expect(info).not.toBe(null)` went with the bind-and-throw narrow; the assertions stay,
  now on the narrowed binding.

**Verification (continuation, final).** `bun --bun oxlint src/sandbox src/tools
src/providers src/literature`: exit 0 — the three rules report nothing in the whole group
scope. `bun run typecheck`: exit 0. `bun test` over the 26 changed files: 504 pass /
2 skip / 0 fail (the skips are the `API_KEY`- and `CORTEX_LIVE_API_TESTS`-gated live
tests; their bodies stay covered by the typecheck). `bun run format:file`: clean on all
26. No `!`, no new `as`, and no lint directive was added; no production file was touched.

## Group 6 record (2026-10-26, task group 6: test sweep of memory, state, execution, citations, tasks — CLOSED)

Start: the live scoped run (`bun --bun oxlint src/memory src/state src/execution src/citations
src/tasks src/__tests__`, saved at `tmp/pi/706-group6-worklist.txt`) held 88 error lines over 26
files; several sites carry reports from more than one rule, so the unique sites and stray-import
reports number 75. The files already carried PARTIAL present-family conversions from the
interrupted group-5 run; the correct ones stand untouched and this group closed the rest. End: the
three rules report nothing in the whole scoped run (exit 0, the `no-unused-vars` strays included).
`bun run typecheck`: exit 0. `bun test` over the 25 changed test files: 542 pass / 0 fail (the
testcontainer rig started; the DB-backed files ran in the same pass). `bun run format:file`: clean
on all 26 changed files. No production file was touched, no lint directive was added, no `as` was
added, and no non-null assertion remains in the touched files (grepped).

**Helper additions (file-local, the family cannot carry the shape).** `cursorOf(page)` in
thread-history.test.ts — six same-shape `before: newest.before!` cursor reads of a page the test
just observed (the #705 `firstSeries` pattern: one helper for one repeated shape).
`storedThread(threadId)` in thread-store.test.ts — four same-shape `(await
store.getThread(id))._unsafeUnwrap()!` reads.

**Present-family and bind-and-throw (D2.5/D2.2).** working-memory (the `[first, second]`
destructure became one `presentAt` binding per element — the recorded destructure limitation — and
the `findings[...]![0]!` reads became `presentAt(presentGet(findings, run), 0)`); card-builders
(`=== null` bind guards over `buildPresentationCardData`, which returns null);
report-session-state (`readState` null guards; the `derivations[0]!` pair through one
`presentAt` binding); report-versions (`getVersion` null guards); conversation-display-parity (the
`[user, reply]` destructure of `shown` became `presentAt` bindings); conversation-display-storage,
-recorder (`finish(...)[1]!`, `takeRound(...)[0]!` through `presentAt`); clients.test
(`client.resolveMany!` — the optional method bound once and thrown on when the client declares
none, the group-5 tool-hook form); dbos-run-launcher (the capture context and span bound and
guarded, the file's repair-run form); step-summary (the regex `exec` capture bound, guarded, and
read through `presentAt(match, 1, ...)`); run-synthesis (`references[0]!` assignments through
nested `presentAt`, `synthesis.findings[0]!` through `presentAt`); data-profile-resolve
(`somatic.slots?.find(...)!` became `?.distinctValues` behind `toBe`, which fails on absence; the
property-test bucket write through `presentAt`; the sweep `paths!` bound and guarded);
data-profile-absorb (`prior.groups!`/`prior.recipe!`/`dimensions![0]!.observations[0]!` bound and
guarded or read through `presentAt`, the slot find nested through `presentFind`); extract-values
(`body.env!` bound and guarded); data-profile-resolve.property (`JUNK_NAMES[i-1]!` through
`presentAt`).

**Dead-code deletions (D2.6, type evidence).** thread-history.test.ts:99 — the `value === null`
conjunct of the histogram-sum guard: the metric datapoint value types as
`number | Histogram | ExponentialHistogram`, never null (the same type the group-4 record cited
for the metrics.test deletions); the `typeof value !== "object"` arm keeps null out. dbos.test.ts
and run-event-stream.test.ts — the `if (rig)` guards over `await rig.drop()`: `rig` types as the
non-optional `DbosTestRig`, the condition is always truthy; the body stays.

**Redundant operators removed (D2.6, expression kept).** The four state column tests and
thread-history: `drop?.()` → `drop()` and `meterProvider?.shutdown()` → `meterProvider.shutdown()`
— the locals type non-optional. `src/__tests__/setup/dbos.ts` — the five `!` and three `??`
fallbacks on the `process.env` reads of the launch config: each property is assigned from a
`string` a few lines above, so control-flow narrowing already types the read `string` (the
rule's unnecessary-assertion and no-nullish-left reports name exactly that); the fallbacks removed
with it were unreachable on every typed flow.

**Wrong-comparison fix.** conversation-display-replay.unit.test.ts:22 — the repair-run guard
`if (card === undefined)` against `planCardOf`, whose return type is `PlanCardData | null`; the
guard now reads `=== null`, so it guards the live absence instead of reporting a no-overlap
condition.

**Strays from the interrupted run.** The unused `presentAt` import of
data-profile.trigger.test.ts and the unused `presentGet` import of data-profile-resolve.test.ts
were removed; a missing space in `id:presentGet(` in working-memory.test.ts left with the line's
replacement.

**Inference finding for later groups.** The recorded `?? []` element-read form fails when the
array itself is a UNION of array types: `presentAt(total?.dataPoints ?? [], 0)` over
`DataPoint<number>[] | DataPoint<Histogram>[] | DataPoint<ExponentialHistogram>[]` does not infer
`T` (TS2345), the same class as the group-4 `presentFirst` union limitation. A site like the
`total_tokens` datapoint read keeps the bind-plus-throw form (`const point = total?.dataPoints[0];
if (point === undefined) throw ...`).

## Group 7 record (2026-10-26, task group 7: test sweep of workflows, runtime, contracts, agents, auth — CLOSED)

Scope: 16 test files over `src/workflows`, `src/runtime`, `src/contracts`, `src/agents`, `src/auth`,
`src/reference-data`, and `src/input-scan` (live scoped run saved at `tmp/pi/706-group7-worklist.txt`;
37 error lines, several sites reported by more than one rule — `execute-analysis.test.ts:2437` held a
`no-non-null-assertion` and a `no-unnecessary-type-assertion` on the same expression). `src/workspace`
held no reports. Several files already carried PARTIAL present-family conversions from the interrupted
group-5 run; the correct ones stand untouched. End: the three rules report nothing in the whole scoped
run (exit 0, "Found 0 warnings and 0 errors" over 143 files, the stray `no-unused-vars` included).
`bun run typecheck`: exit 0. `bun test` over the 16 changed files: 304 pass / 0 fail (206 across the 11
non-DB files; 98 across the 5 DB-backed files — the testcontainer rig started). Prettier clean on all 16.
No production file was touched, no lint directive was added, no `as` was added, and no non-null assertion
remains in the touched files (grepped).

**Present-family and bind-and-throw (D2.5/D2.2).** menu.test (the nested
`presentAt(presentAt(menu.sets, 0).members, 0)` read and the three spreads of `presentAt(base.sets, 0)`);
templates.test (`presentAt(sets, 0).suffixes`); reference-data catalog.test (the nested
`presentAt(presentAt(plan.datasets, 0).artifacts, 0)` and the spread of `presentAt(content.artifacts, 0)`);
chat-parts.test (the spread of `presentAt(finding.references, 0)`); subagent-activity.test
(`presentAt(part?.entries ?? [], 0)` — the recorded `?? []` element-read form; the optional chain behind
`toHaveLength` stays, the matcher fails on absence); execute-analysis.test (`presentGet(base.planStepById,
"B")` in the grounding spread). One-off binds that throw: runtime dbos.test (`sdk.logger`, optional on
`DBOSConfig`); detect-sets.test (the `linked` slot find — the guard replaces `toBeDefined()` and narrows
both former `linked!` reads; `target?.` stays behind `toBe`, which fails on absence); sandbox-step.test
(`referenceIn` binds the regex match and reads the capture through `presentAt(match, 1)`; the two
`ctx.toolOutputStore` reads guarded in their `buildAgent` closures; the two mocked `runStep` fakes guard
`config?.name` before the cache read); step-seed.test (the `resourcesByStepId` map guards `s.resources`,
optional on the persistence schema by design); execute-analysis.test (`once === null` before the
`toEqual(once)` — the recorded toEqual-ignores-undefined hazard, `fold` returns `RunObservation | null`).

**`DBOS.workflowID` reads.** The SDK types the static getter `string | undefined`
(`dbos.d.ts:205`), and the bodies only run under a DBOS execution, so the id's
presence comes from that execution. workflow-replay.test made the 4 same-shape
`DBOS.cancelWorkflow(DBOS.workflowID!)` reads a file-local `cancelSelf()` helper
(the #705 one-helper-per-repeated-shape pattern; the production `suspension.ts`
name) that binds and throws when the id is absent; result-checkpoint.test has
the one site inline in the same form. The cancel stays a body-level call, so the
recorded step sequence is unchanged.

**Dead-code deletions (D2.6, type evidence).** The four `if (rig)` guards in
`afterAll` (workflow-replay:341, result-checkpoint:79, suspension-cascade:198,
run-end-record:83): `rig` types as the non-optional `DbosTestRig`, the condition
is always truthy; the body stays (the group-6 precedent). auth types.test:22:
`scope.kind === "analysis" ? scope.threadId : undefined` — `Scope` is the single
analysis-variant object type (auth/types.ts:33-37) and `kind` is the `"analysis"`
literal, so the comparison is literal-vs-literal (the same fact group 2 cited for
the production deletions); the body stays as `expect(scope.threadId).toBe("thread-1")`,
which still typechecks only because `threadId` sits on `Scope`.

**Strays from the interrupted run.** The unused `presentAt` import of
agents/sandbox/test/catalog.test.ts was removed (`presentGet` stays, in use). The
workflow-replay pattern comment named `DBOS.cancelWorkflow(DBOS.workflowID!)`; it
now names `cancelSelf()`.

## Group 8 record (2026-10-26, task group 8: test sweep of report-render, report-model, and the remainder — CLOSED)

Scope: 42 reports over 15 files (live run saved at `tmp/pi/706-group8-worklist.txt`; the last group, so the
scoped run was the full `bun --bun oxlint`). End: the full run exits 0 — zero warnings, zero errors over the
whole harness, production and test files and `scripts/` included. `bun run typecheck`: exit 0. `bun test` over
the 14 test files of the changed set: 625 pass / 0 fail / 28 skip (all non-DB; the testcontainer rig never
started). `bun run format:file`: clean on all 15 changed files. The changed set is test files plus
`src/report-render/test/options.ts` (the non-test-by-extension helper the task names); no production file was
touched, no lint directive was added, no `as` was added, and no non-null assertion remains in the touched
files (grepped; the full lint reports none tree-wide).

**Present-family and bind-and-throw (D2.5/D2.2).** zod-issues.test: the 15 `const [issue] =
issuesFor(schema, input)` destructures became `const issue = presentAt(issuesFor(schema, input), 0)` — the
declared failure the helper asserts above guarantees the issues array holds at least one — and every later
`issue!` reads the narrowed binding; the `issue?.path` of the nested-path test lost its hop with it (the
binding is non-nullish). metrics.test: `stepOutcomeOf("blocked")!` bound and thrown on (the "skipped" status
keeps its recorded `undefined` outcome; "blocked" guarantees one). briefing.test: `step.grounding!` bound and
thrown on before the `{ ...grounding, template: undefined }` spread. render.test: the `tableAsset` find went
through `presentFind` (the `t-` prefix the page names), and the `expect(tableAsset).toBeDefined()` that the
throw supersedes went with it. label-room.test: the `leaderNameBox(name!, ...)` map callback binds `name` and
throws on absence; the `placed.every((name) => name !== undefined)` assertion above it went (the throw fails
the same absence, loudly).

**Dead-code deletions (D2.6, type evidence).** heatmap.test: the `strips === undefined` guard after `gridAt`
— the accessor returns `EchartOption`, never undefined; the throws-after-parse guard the repair run left was
already dead at birth. pca.test and roc.test: the same guard shape inside each file's `firstGrid` wrapper —
collapsed to `return gridAt(option, 0)`. gallery.test: the `start === undefined` guard after `optionPair` —
the accessor returns `[number, number]`. draft-operations.test: the `block.binding.kind ===
"artifact-table"` inner guard and three `&&` conjuncts — after `block?.kind === "table"` narrows to the table
atom, `binding` is `ArtifactTableReference` (contracts/report-blocks.ts:420), whose `kind` is the literal, so
each comparison is literal-vs-literal; the `toBe("artifact-table")` assertions stay. draft-finish.test: the
filter gained the recorded `Extract` type predicate (`(gap): gap is Extract<FinishGap, { kind:
"unresolved-reference" }>`, the run-agent.test.ts:2047 idiom), which makes the map's `gap.kind ===
"unresolved-reference"` ternary literal-vs-literal in tsc too — the ternary and its `[]` arm went, and the
map reads `blockId, slot, failure.reason` straight.

**Redundant operators removed (D2.6, expression kept).** chart.test: the five `source?.` hops after
`chartSourceOf` (a non-nullish object return) and the dead `?? []` on the `for` of `source.series`. gallery.test:
the `item?.name` after `optionsOf` — the array elements are options, never nullish. chart-export.test:
the second `match[5]?.includes("ecmeta_series_index")` hop — the first disjunct's falsity proves `match[5]`
holds (a truthy `match[5]?.includes(...)` implies a non-nullish base), so the hop is dead; the `!` stays. The
first cut of this fix dropped the `!` with the hop; the two server-render tests caught the inversion at once
(3 whiskers expected, 1 found) and the negation went back — the fixed line is `!match[5].includes(...)`.

**Rule false positives (D2.6).** chart-toolbox.test: `if (element.transform)` reported always-truthy —
zrender types `Transformable.transform` as `MatrixArray`, always present, while its own code reads a null
transform (`Transformable.js:122`, `if (!this.transform)`); the guard is live. Device: the call-site
annotation of the lying signature — the test's `Drawn` alias widened to `Omit<DrawnElement, "transform"> & {
transform: DrawnElement["transform"] | null }`, with the fact on the alias. options.ts: the `JSON.stringify`
`?.`/`??` pair reported non-nullish-left — the lib types the result `string` while it gives `undefined`; the
group-3 honest-signature device applied (module-local `stringifyJson(value: unknown): string | undefined`).
No site of the closure-and-event class appeared, so the five-site directive enumeration stands.

**Verification (group 8 scope).** Full `bun --bun oxlint`: exit 0. `bun run typecheck`: exit 0. `bun test`
over the changed test files: 625 pass / 0 fail / 28 skip. `bun run format:file`: clean on all 15. The task
8.1 gate "a full `bun --bun oxlint` reports nothing" holds at the end of the group.

## Final verification record (2026-10-26, task group 9: the full gates and the diff)

**Format.** Four changed files had drifted since their group's `format:file` pass
(`src/citations/test/resolve.test.ts`, `src/input-scan/test/companions.test.ts`,
`src/tools/lib/test/ema-client.fixtures.test.ts`, `src/tools/lib/test/pathway-client.fixtures.test.ts`);
all four were re-passed through `prettier --write`, after which every changed `src/`/`scripts/` file
(319 paths) is prettier-clean.

**Harness gates.**

- `bun run lint`: exit 0 — "Found 0 warnings and 0 errors. Finished on 910 files with 134 rules".
  Final per-rule counts on the full run: `no-non-null-assertion` 0, `no-unnecessary-condition` 0,
  `no-unnecessary-type-assertion` 0 (the output holds no mention of any of the three rule names).
- `bun run typecheck`: exit 0, 0 errors.
- Full `bun test`, run 1: 6124 pass / 51 skip / **2 fail** (6177 tests, 358 files, 90.97s). Both fails
  are one event: the `beforeAll` of "the data profile — the keys of its usage records"
  (`src/tasks/test/data-profile-suspension.test.ts:166`) hit the 5s hook timeout while the DBOS
  testcontainer came up, so `rig` stayed `undefined` and the `afterAll` `rig.drop()` threw
  (`TypeError: undefined is not an object` at `:169`). The hook path (`setupDbosForTests` →
  `getTestPool`/`withSchema`) is rig boilerplate the sweep did not touch. Run 2 (the D6 re-run):
  **6125 pass / 0 fail / 51 skip** (6176 tests, 358 files, 74.29s) — the baseline shape. The gate holds.
- `bun run build`: exit 0 (fresh `dist/` before the cli gates, the #707 stale-dist lesson).

**Cross-stack gates (in `../cli`, against the freshly built, linked harness).**

- `bun run harness:local`: exit 0 (rebuilds the harness dist, re-points the symlink).
- `bun run kernel:local`: exit 0 (rebuilds prov-kernel, re-points both links, incl. tsprov).
- `bun run typecheck`: exit 0, 0 errors.
- Full `bun test`, run 1: 4130 pass / 2 skip / **1 fail** (4133 tests, 218 files, 100.12s). Run 2 (the
  D6 re-run): identical counts (109.54s). The fail both runs is
  `cli/src/modules/libs/composition.test.ts:1156` ("the composed layout stays in parity with the
  provisioner layout"): the test's own precondition guard at `:1130` — the `python3` on PATH (pyenv
  shim) lacks the `packaging` module the provisioner image has. This is the exact environmental guard
  the #707 archive records at its close (`ModuleNotFoundError` confirmed by a direct
  `python3 -c 'import packaging'`). Not harness fallout: `git diff 4c131661 -- cli` is empty (the cli
  working copy holds zero diff against the baseline) and the file imports no harness symbol. The state
  is strictly better than #707's recorded cli close (4126 pass / 5 fail): the four prov-JSON
  round-trip failures are gone under the working-copy kernel link, leaving only the `packaging` guard.
  Remedy on this host, when consented: `python3 -m pip install packaging`, then re-run the cli suite.

**Census completeness (D4 spans the group records).** Every D4 census class has a record: the
production throwing reads with the guarantee each names (groups 1–3, per-site); the test-side throwing
reads (groups 4–8, per-file counts and shapes — the finer per-site census was the task-3.1 production
duty; the full-run lint zero is the backstop); the dead code deleted with type evidence (groups 1–3
production, 4–8 test); the wrong-type corrections (groups 2 and 3 record "none that touch a barrel
type or a zod output; the stop rule never fired", plus the recorded devices: the crossref/doi-registry
`year?: number` flow, the group-8 `Drawn` alias widening, the honest-signature `stringifyJson`
wrappers); the redundant operators removed (groups 1, 2, 3, 5, 6, 8 — group 4 held none, its five
deletions are dead conditions); the rule false positives with devices and evidence (group 2's
data-profile pair under the wider-annotation device, the five D2.6 directive sites under the
maintainer rulings, group 3's stringifyJson device, group 8's chart-toolbox alias); the drift-ledger
sites (the two `zod-issues.ts` reads and `local-auth-context.ts:23` swept in groups 1 and 3, the
31 test-side ledger sites swept inside the group 4–8 scopes); and the count drift under other
children's rules (below). No site class is missed. One line-number drift: the group-3 closure record
names the run-event-stream directive sites `:231/:321/:377`; the tree holds `:231/:322/:379` — the
same three guards, the comment lines shifted by formatting.

**Count drift under rules of other children of #607.** None. The full `bun --bun oxlint` reports
zero warnings and zero errors tree-wide (910 files, 134 rules), so no on-rule population moved; the
`off` entries of #708/#709/#710 stand untouched (the config diff names them below), so their
populations stay at their sanctioned quiet state. The diff adds no `@ts-expect-error`, `@ts-ignore`,
or `@ts-nocheck` anywhere under `src/` or `scripts/`.

**Diff verification against the baseline commit 4c131661 (read-only `git diff`/`git show` only).**

- Non-null assertion expressions under `src/` and `scripts/`: **zero**. Primary evidence: the
  syntactic rule reports zero on the full run. Secondary: a postfix-`!` sweep (a `!` preceded by a
  word char, a closer, or a quote, not followed by `=`) over every `.ts`/`.tsx`/`.mjs` file finds 18
  lines, all of them string literals (the GraphQL `String!`/`[String!]!` markers of the opentargets
  and dgidb queries, the markdown `![](...)` of show-user.ts, test strings like `"finding 0!"`) or
  definite-assignment declarations (`let release!: () => void;` — rate-limit.ts, run-event-stream.ts,
  and their tests), each verified pre-existing at the baseline; the sweep's positive control finds the
  baseline's own `key!` reads. No `!` expression was added or left.
- Added lint directives: **exactly the five enumerated D2.6 closure-and-event sites**, all
  `oxlint-disable-next-line no-unnecessary-condition` (grep.ts `truncated`, normalize-echart-spec.ts
  `rotated`, run-event-stream.ts `:231`, `:322`, `:379`), each with its invariant in the directive
  comment. Zero directives removed; zero ts-flavor directives added. With the two pre-existing
  `input-sanitization.ts` `no-control-regex` lines, the tree holds exactly seven `oxlint-disable`
  lines.
- Added `as` assertions outside the remaining #707 residual: **zero**. The added-lines scan over the
  diff finds seven ` as ` lines: two `as const` (excluded by D5) and five comment/doc prose
  ("types the values as `string`" and the like). The remaining #707 residual is empty: the archived
  D4 list held exactly one `as` assertion outside `as const` (`local-auth-context.ts:23`), swept by
  group 3, and the archive's second listed site (`package-identity.ts:80`) was already removed by the
  #707 brand ruling.
- The barrel `src/index.ts`: **unchanged** (zero diff lines against the baseline).
- The `oxlint.config.ts` diff: **exactly** the removed `#706 turns the non-null and
  unnecessary-assertion set back on.` comment line and the three removed `off` entries
  (`typescript/no-non-null-assertion`, `typescript/no-unnecessary-condition`,
  `typescript/no-unnecessary-type-assertion`). Nothing else; the #710 entries and every other block
  stand as they were.

**Deviation.** Task 9.1 stays UNCHECKED on the cli full-suite fail: the `packaging` precondition
means the cli suite cannot reach 0 fail on this host without a host change (the pip install) that
needs maintainer consent. Everything else the task names is verified above.

**Coordinator ruling on the deviation (2026-10-26).** The cli environmental
failure closes in the #707 archive pattern: the failure is the test's own
documented precondition guard (host `python3` lacks `packaging`), reproduced
directly, identical on the D6 re-run, with the cli tree at zero diff against
the baseline and no harness import in the failing file. Task 9.1 is checked
with the caveat recorded above: the cli test gate is green except one
documented environmental failure; the host remedy (`python3 -m pip install
packaging`, then re-run) belongs to the user. No maintainer decision is
open: the cli typecheck is exit 0 (the two transient TS2322 errors in the
run narration measured a stale dist before the fresh `harness:local`
rebuild; `git diff 4c131661 -- cli` is empty, and
`harness/src/tools/define-tool.ts` differs from the baseline by exactly the
one redundant-check removal at :324 — the `describeCall` return signatures
were already `string | undefined` at the baseline, so no public-surface
change occurred).

## Implementation-review corrections record (coordinator, 2026-10-26)

Sources: two viv-issue-reviewer runs, codex, claude. Dispositions:

- Supported and fixed (artifacts): proposal.md and design.md Goals now state
  the five-site directive exception consistently with D2.6 (codex Medium);
  D2.1 names `presentFind` and records that `presentGet` carries the
  keyed-read overload (claude W2).
- Supported and fixed (record): the D4 census gains the missing entry — the
  dead conjunct deleted at `src/tools/define-tool.ts:327`
  (`def.describeCall !== undefined &&` → `!== "none"`); the type evidence is
  `ToolDefinition.describeCall` being required (`:244`, the
  `((input) => string | undefined) | "none"` union), and the sole consumer
  (`computeDetail`, `src/tools/tool-detail.ts:125-129`) checks `typeof`,
  so no behavior change (reviewer A W1). The final record's "319 paths"
  counts the tracked diff; the new untracked `src/lib/present.ts` is named
  here (reviewer A S1).
- Flow-on sites (claude S1): the production present-reads at flow-on
  positions — `src/tools/lib/readout.ts:285` (`clip(presentFirst(lines, …))`)
  and its recorded peers in the group 2-3 censuses — keep D3's silent flow:
  the helper throws only when the construction guarantee is false, which on
  those sites is a contract break the module already treats as impossible;
  the absence paths of each module are unchanged (the group records name
  them).
- Investigated and closed without change: codex Medium on
  `src/workflows/suspension.ts:51` (`DBOS.workflowID ?? ""`) — the branch is
  unreachable in production (DBOS sets the id inside a workflow), the
  invariant is recorded in the comment at the site, the unit-test fake
  records the call verbatim, and reviewer A's deep check of the same site
  found the only observable difference in fake counting; the form is D3's
  silent same-flow shape. Reviewer B's crossref/doi-registry note
  (`doi === undefined` arm returns "unavailable") sits on the module's
  existing absence path per D2.3, the planner only selects the DOI plan
  when a DOI exists, and the record documents it — awareness only.
- Routed to the correction implementor: `src/lib/test/present.test.ts`
  (claude W1 — 206 files rely on the family; the sibling idioms
  `null-proto`/`unknown-array` carry tests) and the one-line invariant
  comment on the three-state `emittedInStep` local
  (`src/workflows/execute-analysis.ts:1812`, claude S2).
- Codex High (the cli gate's environmental failure) is the ruled close: the
  coordinator ruling of 2026-10-26 stands (documented environmental guard,
  cli tree at zero diff, #707 archive precedent). The host remedy
  (`python3 -m pip install packaging`, then a cli re-run) belongs to the
  user.

## Correction round 1 record (correction implementor, 2026-10-26)

Both routed corrections are done.

- **`src/lib/test/present.test.ts` (claude W1).** The named style files
  (`null-proto.test.ts`, an `unknown-array` test) do not exist — the record's
  claim that the sibling idioms "carry tests" is true only through use sites
  (`isUnknownArray` in other tests, `nullProtoRecord` in
  `src/state/test/report-versions.test.ts`), not through dedicated files. The
  test instead follows the `src/lib/test/` house style (`result.test.ts`,
  `zod-issues.test.ts`: bun:test `describe`/`it`, `.js`-suffixed imports, a
  header doc comment naming the load-bearing behavior, state assertions
  only). Each exported helper gets its present and absent paths:
  `presentFirst`, `presentAt` (in range and out of range),
  `presentLast`, `presentFind` (match and no match), and `presentGet` over
  the string-keyed Map form, the record form, and the generic keyed Map
  overload. Each absent path asserts the thrown message — the default
  naming and the `what` description form. 17 tests, 0 fail.
- **The `emittedInStep` invariant comment (claude S2).** One line directly
  above `let emittedInStep: boolean | undefined;` in
  `src/workflows/execute-analysis.ts`: "The `undefined` in the annotation
  exists only because control-flow analysis cannot see the closure
  assignment; no code may depend on the initial state." It joins the
  adjacent comment block in form and adds the D2.6 device rationale that
  block did not state.
- **Vacuous-matcher grep (read-only).** Over the added lines of
  `git diff 4c131661 -- harness/src`, the patterns
  `expect(...?...).toBeUndefined()` and `.not.toBeNull` yield five sites.
  None passes vacuously: four `.not.toBeNull` sites are plain property
  reads on a `presentAt` result whose property the production code always
  assigns to `value | null` (`panelEntry` at
  `src/tools/bio/target-safety.ts:162`, the pg row columns typed
  `Date | null` / `unknown` with the key always present), so `undefined`
  is outside the runtime domain; the one `?.`-into-matcher site
  (`metadata?.title`, `src/tools/sandbox/test/list-available-refs.test.ts:94`)
  is guarded by the `toMatchObject` on the line above, which fails unless
  `metadata` is present, so the `?.` cannot reach its vacuous branch. The
  broader `expect(x?.y).toBeNull()` family on added lines uses the positive
  matcher, which fails on `undefined`, so the `?.` obeys D2.5's rule.
- **Verification.** `bun test src/lib/test/present.test.ts`: 17 pass,
  0 fail. `bun run format:file` on both changed files: unchanged.
  `bun run lint`: exit 0. `bun run typecheck`: exit 0.
