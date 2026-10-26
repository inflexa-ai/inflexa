# Proposal

## Why

Issue #733 is the consolidated review of the harness lint stack #724. The lint sweeps of that stack changed some behavior at a boundary, and they left latent defects, weak tests, and stale text. Each finding is still present on `main`. This change fixes the findings of sections 1 to 6 of the issue.

## What Changes

- **Behavior that changed (section 1).**
  - The input scan skips a decoder stdout line that is not complete JSON. The other readouts of the batch stay.
  - A box series with no group carries no `name`.
  - The grid top margin of a chart reads an empty `graphic` list as no annotation.
  - The token counters add the `model` and `provider` labels only when the response reports them.
  - The two `.rejects` assertions of the display storage test run.
  - The template contract parse accepts a `null` parameter default, and reads it as no default.
- **Latent defects (section 2).**
  - The regulatory corpus freshness check reads `age_days` as a number.
  - The `knowledge_template` description states the input check of a slot value type.
  - A non-string alias in the `otherNames` of a clinical trial is dropped, and the search continues.
  - `answerAsk` refuses a bad grant row through its `DbError` channel.
  - The write step of the draft operations refuses an atom at the root, and the compiler checks its result type.
  - `read_block` tells an unknown id from a stored block that fails the authoring parse.
  - The row bound partitions the rows with one predicate.
  - `pageCall` runs the page source again for each call.
  - `cancelSelf` fails when it runs outside a workflow.
- **The conditional-spread sweep (section 3).** An audit of the sweep found two more sites that dropped a gate: the y key of a faceted embedding, and the `servedModelId` of a fallback hop that names no model. Each gets its gate back with a test. The barrel load probe prints the message of the error.
- **Model-facing schemas (section 4).** The date fields of the Amass tools give a `pattern` again. The `spec` input of `show_user` gives a flat JSON Schema.
- **Duplication (section 5).** One array-to-AsyncIterable test helper, one errno reader, and a pair loop that visits each pair one time.
- **Stale text and boundaries (section 6).** The comments of `oxlint.config.ts` that cite change artifacts or give volatile counts, and the docs that describe removed code. Two `contracts/` modules stop the value import from `lib/`. The failure of `awaitOk` carries a stack and a cause. Two spec Purpose texts and a `CLAUDE.md` line get the current test paths and the current exemption.
- Section 7 of the issue is not a code change, and this change does not do it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `input-scan-manifest`: a decoder line that is not complete JSON costs only its own readout.
- `echart-layout`: an empty `graphic` list is not an annotation for the grid top.
- `report-render`: a box series with no group carries no name.
- `report-authoring`: a block read tells an unknown id from a stored block that the authoring grammar refuses.

## Impact

- Code under `harness/src`: `input-scan`, `report-render`, `tools/display`, `loop`, `tools/knowledge`, `tools/lib`, `tools/bio`, `tools/approval`, `report-model`, `workflows`, `tasks`, `execution`, `contracts`, and test helpers.
- `harness/oxlint.config.ts`: comment text, and one zone entry for the flat `show_user` schema.
- The model-facing tool schemas of `show_user`, `search_patents`, and `search_regulatory_approvals`, and the description of `knowledge_template`.
- The managed host calls `maybeKickOffRegulatoryCorpusRefresh` at boot (`cortex/managed/server.ts:549`), thus the freshness fix reaches it at its next harness bump.
- No public type of the barrel changes.
