# Design

## Context

See proposal.md for the reason. Issue #733 names each finding with a `file:line` on `main` at `b499e686`. The per-PR review reports behind the issue give the old and the new form of each site.

These constraints shape the fixes:

- The `type-strictness` spec permits only the recorded lint exceptions. Thus a fix must not turn a rule off for a new glob. A zone block that names one rule and gives a reason for each file is the permitted form for an `@inflexa-ai/*` rule.
- The `test-shape` spec keeps `typescript/require-await` on. A test callback with no `await` is not `async`.
- `lib/parse-json.ts` holds the one `JSON.parse` of the tree. Its helpers throw `SyntaxError` on malformed text, and each other caller puts the parse in a `try`.
- The neverthrow rules of `harness/CLAUDE.md` list the places that can throw. `cancelSelf` and a tool `execute` body are on that list.

## Goals / Non-Goals

**Goals:**

- Each finding of sections 1 to 6 of the issue gets the smallest fix. Where a test can show the defect, a test fails before the fix.
- Each boundary that skipped one bad item before the lint stack skips one bad item again.

**Non-Goals:**

- Section 7 of the issue: the CodeQL dismissal is a GitHub write, and the release note belongs to the next harness release.
- The value imports of `contracts/report-reference.ts` from `lib/`. Its JSON parse needs the `lib` helper, and a fix needs a decision on the place of that helper. A deferred entry records it.
- The review findings that the issue does not name.
- The item color of a zero-p Manhattan row with no chromosome cell. The index-access change of #725 moved it, not the spread sweep, and the correct color is not clear. A deferred entry records it.

## Decisions

### D1. A per-line `try` skips a malformed decoder line

The decoder loop in `input-scan/enrich.ts` puts `safeParseJsonAs` in a `try`, and a `catch` goes to the next line. This is the form of each other caller of the helper. A new helper that gives a result for malformed text would change a shared module for one caller. The alternative is not necessary.

The sandbox marks a capped stdout with `stdoutTruncated`. When the flag is true, the reason of a path with no readout names the cut output. The reason "reported nothing" would hide the cause.

### D2. Restore each gate that the conditional-spread sweep dropped

The sweep of `@inflexa-ai/no-conditional-spread` wrote `k: v` where the old spread tested a different fact than the presence of `v`. These sites get their gate back:

- `report-render/chart.ts`: the box series and the outlier series set `name` only when `lane.name !== undefined`, the same as the slot series beside them.
- `tools/display/normalize-echart-spec.ts`: an annotation is a `graphic` value that is not an empty list. This covers each figure that gives an empty list, thus `qq.ts` and `dotplot.ts` do not change.
- `loop/metrics.ts`: the counter attributes get `model` and `provider` only when each is defined. The `harness-agent-loop` spec already states that each label is absent when the response does not report it.
- `input-scan/scan.ts`: `scanLimit` is present only when the scan is truncated, as its type doc states.
- `report-render/figures/embedding.ts`: the y key fields name the axis of the first panel only, the same as the x key fields. The `report-render` spec puts the key at the corner of the first panel.
- `providers/ai-sdk.ts`: `settleFallbackReply` sets `servedModelId` only when the hop names a model. Its doc states that a hop that names no model changes nothing.

The sweep audit read each removed spread of the sweep in `harness/src` and classified it by its condition. In the harness, the two last sites are the only new sites that change an observable output. The audit did not read the key enumeration of the cli, and it treated log fields as not observable.

The fix form is an if-form or a value ternary that gives `undefined`. The lint rule forbids the conditional spread. Each fixed consumer gets a test that tells an absent key from an `undefined` value, where the consumer can see the difference.

### D3. Accept a `null` template default and read it as no default

`tools/knowledge/client.ts` accepts `null` for `default` and changes it to an absent default at the parse. The briefing and the local slot binding then see no default. The service contract is not in this repository or in a sibling repository. If the service never sends `null`, the wider schema changes nothing. If it sends `null`, the contract fetch works again. Thus this choice is correct in each case, and the decision needs no service evidence. A slot with `default: null` and no `required: false` is then required, by the contract rule that an adaptable slot without a default is required.

The list form stays a list of strings. The comment of the schema states that contract for a default, and no evidence shows a different list.

### D4. Read `age_days` as a number in the SQL

The freshness query of `tasks/regulatory-corpus-boot-refresh.ts` casts `age_days` to `float8`. Then node-pg gives a number, and the row type is true. A `Number()` call with a lint directive is the alternative, but the cast makes the type true at the source. The module stays, because the managed host calls `maybeKickOffRegulatoryCorpusRefresh` at boot. A database test drives the fresh path and the stale path.

### D5. Keep the strict slot schema, and state its input check

The #732 change notes record the strict `slots` schema of `knowledge_template` as intended. The description changes. A slot value of the right type that the template refuses comes back as `match: rejected`. A value of a different type fails the input check of the tool.

### D6. Drop a non-string alias, keep the search

The `otherNames` field of a clinical-trial intervention reads a list and keeps its string members. A different member is dropped, and the study and the search stay. The drift twin of each clinical-trials schema must still carry a genuine type break. If a twin breaks only `otherNames`, the twin moves its break to a different field.

The client has no `Logger`. A dropped alias loses one name, not a result, thus the drop stays silent.

### D7. The fragile rewrites of the stack

- `answerAsk` (`tools/approval/queries.ts`): the grant row parse runs in the `tryMutation` body, thus a parse failure is a `DbError`. The stale comment about the cast goes.
- `setChildren` (`report-model/draft-operations.ts`): the root path gives a refusal with the reason `atom-at-root` when a child is not a section. The insert, remove, and replace helpers carry that refusal to their callers. A generic signature that the compiler checks replaces the overload of `setChildrenInBlocks`. Each operation refuses an atom at the root before it builds a candidate, thus no operation reaches this refusal. The module exports the write step for its unit test, and the barrel does not change.
- `readBlock` (`report-model/draft-read.ts`): the read gives three outcomes: a block, an unknown id, and a stored atom that the authoring grammar refuses. `read_block` gives `found: false` for the second. For the third, it gives a tool error that is not retryable and names the block id.
- `applyRowBound` (`report-model/reference-resolver.ts`): one pass partitions the rows with one predicate that gives the rankable row or nothing.
- `pageCall` (`report-render/test/options.ts`): the closure runs `pageExports` on each call, thus each call gets new page globals.
- `cancelSelf` (`workflows/suspension.ts`): an absent workflow id throws an `Error` before the cancel. The comment states the current behavior.

### D8. The model-facing schemas

- The date fields of `search_patents` and `search_regulatory_approvals` use `.regex` with one named constant and a reasoned `oxlint-disable-next-line`, the form of `lookup-annotation.ts`. `z.toJSONSchema` then gives the `pattern`.
- The `spec` input of `show_user` is `z.record(z.string(), z.unknown())`. A zone entry of `@inflexa-ai/no-empty-schema` in `oxlint.config.ts` gives the reason. The model sends the tool input as JSON text, thus `z.json()` refuses nothing more. The recursive `$defs` of `z.json()` reaches each backend, and the repository cannot do a check of each OpenAI-compatible backend. The presentation schema in `contracts/` keeps `z.json()`, because no model reads it.

### D9. Lint fixes that weaken a test

- The two `.rejects` assertions of `conversation-display-storage.test.ts` are awaited in `async` tests.
- A test body that is synchronous loses its placeholder `return Promise.resolve();`. A test double that returns the value of an async function keeps its return.
- An assertion of the form `expect(tool.describeCall?.bind(tool)).toBeDefined()` becomes `expect(typeof tool.describeCall).toBe("function")`, or `"undefined"` for the absent case. The `typeof` operand is a safe use for `typescript/unbound-method`, and the assertion now checks the type. No lint exception is added.

### D10. One copy of each helper

- One generic array-to-AsyncIterable helper in the new module `lib/test/async-iterable.ts`, beside `lib/test/result-assert.ts`, serves `scripted-provider.ts`, `streaming-chat.test.ts`, and `run-event-parts.test.ts`. The helper takes the optional thrown error of the streaming-chat form.
- `post-step.ts` and `reconcile-manifest.ts` use `errnoOf` from `lib/fs-result.ts`, and their local schemas go.
- The pair loop of `input-scan/menu.ts` visits `candidates.slice(i + 1)` in its inner loop.

### D11. Stale text and the `contracts/` boundary

- `oxlint.config.ts` comments lose each citation of a change artifact and each volatile count. The text names the rule in place of "the rule-4 zone entry".
- The `defineTool` comment names the sentinel test that the code does.
- `apiFetchValidated` sets `parseAs: "json"` at run time again, thus its doc is true.
- `decision-record.ts` keeps one copy of the doc comment of `expectedScriptSha256`.
- The test doc comments that name a sibling test by its old path get the `test/` segment.
- `contracts/structure-source.ts` and `contracts/profile-vocabulary.ts` read their lookups locally. `structure-source.ts` gives `null` for a missing capture, the absence path of its function. `profile-vocabulary.ts` throws an `Error` that names the entry. Each module doc states again that each import from outside `contracts/` is a type import.
- `awaitOk` throws an `Error` with the err value as its `cause`.
- The barrel load probe writes `errorMessageOf(error) ?? textOf(error)`.
- The comment at `state/snapshot-parse.ts:112-113` says that an absent part stays absent, but a parsed part can now carry an own `undefined` key. The comment changes to the current fact.
- The Purpose text of `integration-tests-external-api` and `structured-logging`, and the test path in `harness/CLAUDE.md`, get the current paths and the current exemption. A delta cannot change a Purpose, thus the coordinator edits those main spec files directly.

## Risks / Trade-offs

- [The sweep audit misses a site] → The audit classifies each removed spread by its condition. A site that tested the presence of its own value changes only the key presence. For such a site, the audit reads each consumer for a presence read.
- [No current operation reaches the `atom-at-root` refusal of `setChildren`] → A test drives the write step with a candidate that breaks the root rule.
- [A flat `show_user` schema admits any `spec` member value] → The record schema still refuses a non-object. The card builder parses the presentation schema.
- [A stricter `cancelSelf` breaks a test fake with no workflow id] → The fake gets a workflow id. A test shows the throw outside a workflow.
- [The oxlint port of `typescript/unbound-method` reports a `typeof` operand] → The task stops and goes back to the coordinator. No lint exception is added for it.
