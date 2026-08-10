## Why

The report session composes, previews, and persists a draft, but no code realizes the value tier, and nothing gates a recorded version. Thus a claim can bind a real coordinate and state a wrong number. A version can record with no proof and no look at the page. #310 closes this: the gate is the guarantee against fabrication.

## What Changes

- Add the production reference resolver behind the existing seam, with three layers: the identity compare, the host fast path, and the sandbox fall-through.
- The host fast path parses CSV, TSV, JSON, and parquet in process, for a file at or under a configurable 16 MiB cap. The parquet read uses the `hyparquet` dependency.
- The fall-through runs a one-shot extraction workflow on the rails of the data profile, and it submits only a fixed harness-authored extraction script.
- Extract the assert rules of the fixture resolver into shared functions, thus the two realizations keep one semantics.
- Add an optional `prepare` method to the resolver seam. The validator calls it one time before its per-reference loop, and a realization batches there.
- Add the record tool: the full validation gate runs before `store.record`, thus a version that the gate did not accept never lands.
- Add the look-before-record rule: the record refuses until the visual tool ran against the current document state. The rule is mechanical, and the visual judgment stays advisory.
- Add the eyes tool: headless Chrome opens the session page through a `file://` navigation, and gives back the screenshot, the console errors, and the failed requests.
- Extend the report-session prompt with the verification loop and its anti-pattern list.

## Capabilities

### New Capabilities

- `report-value-resolution`: the production resolver — the three layers, the cap, the script discipline, and the lease seam.
- `report-verification`: the record gate, the look-before-record rule, and the eyes tool.

### Modified Capabilities

- `report-grounding`: the resolver seam gains the optional `prepare` method, and the reason set gains `extraction-unavailable` for an absent sandbox arm.
- `report-session-agent`: the prompt obligations gain the verification loop and its anti-pattern list.

## Impact

- New code under `harness/src/report-model/` for the resolver, and under `harness/src/tools/report-session/` for the two tools.
- The extraction workflow lands under `src/tasks/`, the session-state columns under `src/state/`, and the prompt edit under `src/prompts/`.
- One new dependency: `hyparquet`, for the under-cap parquet read.
- The work is additive and dormant behind the `report` thread type. `src/index.ts` exports none of it, and the old report path stays untouched.
- The extraction workflow reuses the run authorization and the container lifecycle of the data-profile pattern. No standing machine exists.
