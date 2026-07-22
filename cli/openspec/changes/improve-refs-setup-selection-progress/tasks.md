## 1. Byte formatting extension

- [x] 1.1 Add `src/extensions/number.ext.ts` declaring `interface Number { formatBytes(): string }` on the global `Number` interface, implemented on `Number.prototype` following the `Response.prototype.jsonWith` shape in `response.ext.ts`: whole bytes below 1024, then one decimal of `KB`/`MB`/`GB` stepping every 1024. Clamp negative and non-finite input to `0 B`, and state in the JSDoc both the clamp (as `date.ext.ts` does) and that the units step on 1024 while carrying the shorter labels the rest of the CLI prints.
- [x] 1.2 Register the side-effect import in `src/extensions/index.ts`.
- [x] 1.3 Delete `formatReferenceBytes` from `src/modules/refs/commands.ts` and move its one caller (the installed-dataset summary) to `bytes.formatBytes()`; no shim, no second formatter.
- [x] 1.4 Move the hand-rolled byte string in `src/modules/embedding/setup.ts` (the `written / 1024 / 1024` readout in the model-download stop message) onto the extension, so the spec's one-shared-formatter rule is true of the tree.
- [x] 1.5 Cover the extension in `src/extensions/extensions.test.ts`: unit boundaries across `B`/`KB`/`MB`/`GB` and the negative/non-finite clamp. Update `src/modules/refs/commands.test.ts`, which imports and asserts on `formatReferenceBytes` (`1024` now reads `1.0 KB`).

## 2. Progress seam in the installer

- [x] 2.1 Define the progress event union in `src/modules/refs/store.ts` — artifact started (dataset id, artifact path, upstream-declared size when known), bytes transferred (delta), artifact completed — as a discriminated union with JSDoc on the type and every field.
- [x] 2.2 Add the optional reporter to `ReferenceInstallDeps` beside `fetch`/`now`/`attemptId`, and invoke it through a guard that swallows a throwing reporter so progress can never fail an install; comment why the guard exists.
- [x] 2.3 Emit artifact-started in `downloadArtifact` after the response is accepted, parsing `Content-Length` to a positive finite integer and reporting unknown otherwise (absence is the normal case, not an error).
- [x] 2.4 Insert a pass-through counting `Transform` between `Readable.fromWeb(response.body)` and the `.part` `createWriteStream` in the existing `pipeline` call so byte deltas are observed without taking over the flow; comment why a `Transform` rather than a `data` listener (backpressure and error propagation stay with `pipeline`).
- [x] 2.5 Emit artifact-completed once the `.part` is written and hashed, and confirm no existing early-return path (HTTP failure, non-https redirect, hash failure) reports completion.
- [x] 2.6 Extend `src/modules/refs/store.test.ts` with a reporter-attached install asserting event order and cumulative bytes, an install whose reporter throws (result, receipts, and activation identical to the no-reporter run), and an upstream response with no `Content-Length` (started event carries no size, install unaffected).

## 3. Combined progress rendering

- [x] 3.1 Build the progress renderer inside `src/modules/refs/commands.ts` (single caller — keep it in the file per the project's no-single-caller-extraction rule): it holds artifacts completed, cumulative bytes, and a trailing-window rate sampler, and renders `<done>/<total> files · <bytes> · <rate>` with the rate segment omitted until measurable. Constants, per design: a 3-second sample window, a 100 ms floor between message refreshes, and no rate shown until the window spans at least 1 second with two usable samples.
- [x] 3.2 Drive it with `progress()` from `@clack/prompts` on a TTY — `max` = the artifact count already computed by `referenceDownloadEstimate`, `advance(1, …)` per completed artifact, throttled `message(…)` refreshes for the byte/rate tail — and stop it with a final summary line on success and `error(…)` on failure.
- [x] 3.3 Handle the two count edges: start no renderer at all when the estimate is zero artifacts (the all-intact plan, which today still prints "Download 0 files…" and proceeds), and clamp the completed count at the planned total so a mid-flight repair cannot render `39/38`.
- [x] 3.4 Add the non-TTY path (decided once at download start via clack's `isTTY`/`isCI`): one plain line per completed artifact carrying the same facts — never a line per byte-delta event — with no animation and no cursor-control sequences.
- [x] 3.5 Wire the reporter into `downloadReferences` so both `inflexa refs download` and the setup path render the same readout; confirm nothing about consent ordering changes — the readout starts only after confirmation.
- [x] 3.6 Assert no fabricated totals anywhere in the rendered strings: no percentage of bytes, no ETA, and no `NaN`/`Infinity` reachable from the rate or byte segments.

## 4. Preset selection

- [x] 4.1 Replace the preselected `groupMultiselect` entry point in `chooseIds` with a preset `select` — everything offered, the recommended subset, none, and an escape into the per-dataset picker — resolving against the datasets the caller passes in, not the whole catalog.
- [x] 4.2 Keep the existing grouped picker as the escape but drop `initialValues` so it opens empty; keep `selectableGroups` and the recommended hint.
- [x] 4.3 Resolve the recommended preset within the offered set, and return an empty selection (not a widened one) when the offered set contains no recommended dataset.
- [x] 4.4 Attach the note to the none preset: a dataset can be fetched later with `inflexa refs download <id>`, or by asking the agent in chat, which proposes that command for approval. Verify the claim still holds against the `refs download` registration in `src/cli/index.ts` (`approval`) before wording it.
- [x] 4.5 Map a cancelled preset select to the same declined outcome the cancelled picker produces today, so setup continues and nothing is transferred.
- [x] 4.6 Confirm the untouched paths stay untouched: `setup --refs <ids>` bypasses the prompt, and headless setup still defaults to the recommended offered set gated on explicit `--yes`.

## 5. Tests and verification

- [x] 5.1 Add preset coverage to `src/modules/refs/commands.test.ts` through the existing catalog/plan test seam: each preset's resolved id set, the empty-recommended case, the empty-picker default, and the cancelled-preset decline.
- [x] 5.2 Assert the none-preset note names both routes and that setup exits successfully having activated nothing.
- [x] 5.3 Assert setup presets are computed over offered (missing/updateable) datasets only, with an already-installed dataset absent from the everything preset's plan.
- [x] 5.4 Add a rendering test for the two count edges — a zero-artifact plan starts no readout, and a transfer that overruns its estimate saturates at the planned total.
- [x] 5.5 Run `bun run typecheck`, `bun run lint`, and `bun test` in `cli/`, then `bun run format:file` on every changed file under `src/`.
- [x] 5.6 Exercise the real flow once end to end with `XDG_DATA_HOME` pointed at a throwaway directory (`refsDir` resolves under it — `lib/env.ts:41,60-64`), so the manual run cannot touch the real reference store: run the refs step interactively for the TTY readout, then re-run `refs download` with stdout piped to a file to confirm the plain-line degradation.
