## Context

Reference provisioning is split across two files. `src/modules/refs/store.ts` is the headless installer — plan resolution, streaming download, staging, atomic activation, receipts — and returns `Result` throughout. `src/modules/refs/commands.ts` is the CLI layer: it owns the clack prompts, the consent question, and every line printed. `inflexa setup` does not reimplement any of it; it calls `runReferenceSetup`, which shares `downloadReferences` with `inflexa refs download`.

Two properties of the current flow motivate this change:

- `chooseIds` seeds the grouped multi-select with `initialValues` = every dataset carrying `recommendation.recommended: true` — 32 of 56 catalog datasets. The picker therefore opens fully armed, and the only way to a smaller install is manual deselection.
- The installer is silent while transferring. `installDataset` loops artifacts, `downloadArtifact` pipes the response body straight to a `.part` file, and nothing is printed until the whole plan resolves. There is no seam through which byte-level progress could reach the terminal even if the CLI wanted to render it.

A third constraint shapes everything about the progress readout: **the catalog pins no sizes.** `ReferenceDownloadEstimate` carries an artifact *count*, deliberately — the comment at `referenceDownloadEstimate` records that the honest pre-transfer statement is a file count, and the consent question says "upstream-determined size" for the same reason. Any total-byte denominator would have to be invented.

## Goals / Non-Goals

**Goals:**

- Make "install everything", "install the recommended set", and "install nothing" each a single keystroke, and make the per-dataset picker an opt-in that starts empty.
- Tell a user who picks nothing how to get a dataset later, in terms that are true of the shipped system.
- Report one combined progress readout for the whole transfer — files done of total, cumulative bytes, current rate — without inventing a total size or an ETA.
- Keep `store.ts` free of presentation, and keep the installer's `Result` contract, staging, activation, and receipts byte-for-byte unchanged.
- Add no dependencies.

**Non-Goals:**

- Sizing the catalog. No `HEAD` sweep, no checked-in byte counts, no ETA. If a total is ever wanted it belongs in the catalog, which is harness-owned.
- Changing headless behavior. Non-TTY setup keeps defaulting to the recommended set gated on explicit `--yes`, and `setup --refs <ids>` keeps bypassing the prompt entirely.
- Resumable downloads. The `TODO(robustness)` about `If-Range` in `downloadArtifact` stays open.
- Parallel downloads. Artifacts stay sequential; the progress readout describes the sequential transfer it observes.
- Touching the `--json` modes of `refs list` / `refs verify`, which must stay byte-stable.

## Decisions

### A preset `select` in front of the picker, not a smarter picker

The interactive path asks one `select` first — **all**, **recommended**, **none**, **choose specific datasets** — and only the last opens the existing `groupMultiselect`, now with no `initialValues`.

The fourth entry is a deliberate addition to the three categories that were asked for. Without it, moving the default off "everything recommended" would also delete the only way to install a hand-picked set, which is a capability `refs download`'s interactive mode has today and which nothing else replaces. It is last in the list and is the only entry that opens a second prompt, so the three one-keystroke outcomes stay one keystroke.

Alternatives considered:

- *Keep one multi-select, just drop the preselection.* Fixes the deselection chore but makes "install the recommended set" — the outcome most first-run users want — a manual 32-item selection. Rejected: it moves the work rather than removing it.
- *Rely on `selectableGroups`.* Already enabled; group headers toggle their members. It is still a wall of 15 groups and does not express "recommended", which cuts across groups.
- *Preset as a flag only (`setup --refs recommended`).* Does nothing for the interactive path, which is where the complaint is.

The preset resolves against **the datasets the caller offers**, not the catalog: setup passes only missing/updateable datasets, so `all` there means "everything still missing", and a user with an intact store is not re-offered what they already have. `refs download` with no ids offers the full catalog, as today.

`recommended` keeps its existing meaning — the datasets carrying `recommendation.recommended: true` within the offered set. If that set is empty (an unusual catalog, or every recommended dataset already installed), the preset resolves to an empty selection and the flow continues exactly as "none" does rather than silently falling back to `all`.

Cancelling the preset select (Ctrl+C / Esc) is a cancellation, not a selection: it maps to the same "declined" outcome the current cancelled picker produces, so setup continues and nothing is transferred.

### The "none" note describes a path that exists

The note names two ways to get a dataset later: run `inflexa refs download <id>`, or ask the agent in chat. The second is true because `refs download` is registered with `{ kind: "approval" }` in the command registry, and `run_inflexa` maps `approval` to the in-chat `ctx.ask` flow — the agent proposes the exact argv and the user approves it. Wording stays at that level of promise: the agent *offers* the download, it does not perform one unattended.

### Progress is a callback on `ReferenceInstallDeps`

`ReferenceInstallDeps` already exists as the composition-edge seam for `fetch`, `now`, and `attemptId`. Progress joins it as an optional reporter — absent by default, so every existing caller and test is unaffected and the installer stays headless.

The reporter receives a discriminated union rather than a bare byte count, because the renderer needs to distinguish "a new file started" (advance the file counter, learn its `Content-Length` if the upstream sent one) from "more bytes arrived" (accumulate, resample the rate). Events are emitted, never awaited: the reporter is called synchronously and its return value ignored, so a slow or throwing renderer cannot alter transfer semantics. The installer wraps reporter invocation so a throwing reporter is swallowed — a progress bar must never fail an install.

Alternatives considered:

- *The event bus (`lib/bus.ts`).* Every `BusEvent` member is analysis-scoped provenance carrying an `analysisId`; a setup-time download has no analysis. Widening the contract for one readout is worse than a local callback, and the project rule is one bus, better types — not more event kinds of a different nature.
- *Returning progress in the `Result`.* Progress is only useful during the operation.
- *Having `store.ts` render directly.* Puts clack and TTY detection inside the tested headless installer.

### Byte observation is a pass-through `Transform` in the existing pipeline

`downloadArtifact` currently runs `pipeline(Readable.fromWeb(response.body), createWriteStream(partPath))`. A counting `Transform` is inserted between them: it forwards each chunk untouched and reports `chunk.length`. `pipeline` keeps propagating backpressure and errors across the added stage, so failure handling and the `.part` semantics are unchanged.

Alternatives considered: attaching a `data` listener to the readable (fights `pipeline` for the flow), or reading the web stream by hand into the write stream (reimplements backpressure that `pipeline` already handles correctly).

`Content-Length` is read from the response headers and parsed to a positive finite integer; anything else — absent, malformed, `-1`, chunked encoding — is reported as *unknown*, and unknown is the normal case, not a failure. It refines the in-flight file's readout only; it is never summed into a plan-wide denominator, because the plan's later files have not been requested yet and their sizes are unknowable.

### The readout: counted files, measured bytes, sampled rate

The renderer in `commands.ts` owns all formatting. The denominator is the artifact count from the existing estimate — a number the CLI already computes and already shows before consent. Bytes and rate are measurements, so they are stated as such:

```
Downloading references  ▪▪▪▪▪▪▪▪░░░░░░░  12/38 files · 1.4 GB · 8.2 MB/s · file 240.0 MB/3.1 GB
```

The trailing `file` segment appears only while the artifact in flight declared a `Content-Length`. It
is the one place a declared size can honestly be spent, and it earns its width: with 38 files of
wildly different sizes, a single multi-gigabyte download otherwise leaves the file counter — the only
denominator there is — motionless for minutes.

The bar in that sketch is illustrative only — it is drawn by clack's `progress()` under its `style` option, not composed here. (`GLYPHS` in `lib/design_system.ts` governs the opentui TUI, not the clack prompt surface, so the readout mints no glyph vocabulary of its own.)

Rendered with `progress()` from `@clack/prompts` (already a dependency, already the vocabulary of `setup.ts` and `embedding/setup.ts`): `max` is the artifact count, `advance(1, …)` fires per completed file, and `message(…)` refreshes the byte/rate tail as chunks arrive. There is no percentage of bytes and no ETA anywhere in the readout.

Two count edges are decided here rather than left to the renderer:

- **A zero-artifact plan gets no readout at all.** An all-intact selection legitimately plans zero fetches (today's consent question already reads "Download 0 files of upstream-determined size"), and a bar whose `max` is zero has no meaningful denominator. The renderer is not started in that case; the existing summary lines carry the outcome.
- **The completed count is clamped to the planned total.** The estimate and the installer both decide "already intact" by digest, but they decide it at different moments, so a dataset damaged in between can add fetches the estimate did not predict. The counter saturates at the total rather than rendering `39/38`, and the final summary — which reports what was actually installed — remains the authoritative record.

Rate is sampled over a trailing window, not averaged over the run, so it tracks what the connection is doing now instead of being dragged by a slow start. The concrete constants, fixed here so the readout is reproducible: samples of cumulative bytes are kept for the last **3 seconds**, rate = Δbytes ÷ Δtime across that window, the rate segment appears only once the window spans at least **1 second** and holds two usable samples, and `message(…)` refreshes at most every **100 ms** regardless of how fast chunks arrive. When Δtime is zero or no sample qualifies, the rate segment is omitted entirely rather than rendered as `0 B/s`, `NaN`, or `Infinity`.

A stall needs two mechanisms, because a stalled stream is defined by the absence of the events that would otherwise drive the readout. The rate's staleness is judged against the wall clock rather than against the newest sample, so a window whose last sample has aged out yields no rate at all; and an unref'd interval repaints on the window's period, so the stale rate actually leaves the screen instead of merely being absent from a snapshot nobody asked for. Together they make a stalled transfer read as stalled — file counter still, byte total still, no rate — rather than as a connection still moving at whatever it managed last.

### Non-TTY degrades to plain lines

When stdout is not a TTY (the `run_inflexa` subprocess, CI, a piped shell), the animated renderer is replaced by plain line output — one line per completed file carrying the same facts — so captured logs hold readable text instead of cursor escapes. clack exports `isTTY(output)` and `isCI()`; the decision is made once when the download starts, and both paths report the same numbers.

### `Number.prototype.formatBytes()` replaces `formatReferenceBytes`

The user-facing ask is an extension method on `Number`, and `src/extensions/` already has the instance-method precedent in `Response.prototype.jsonWith`. `number.ext.ts` declares `interface Number { formatBytes(): string }`, registered by one side-effect import in `extensions/index.ts`.

The unit labels are `B` / `KB` / `MB` / `GB` on 1024-based math, one decimal above bytes. Three conventions exist in the tree today and this picks the majority one: `embedding/setup.ts` — the setup step immediately before references — already prints `Downloaded 36.0 MB` from `written / 1024 / 1024`, and the harness's own `formatBytes` uses `KB`/`MB`/`GB` on the same 1024 base. Only `formatReferenceBytes` says `KiB`/`MiB`/`GiB`, so keeping it would leave one wizard printing `1.4 GiB` two lines below another printing `36.0 MB`. The strictly-correct IEC labels lose to the vocabulary the rest of the product already speaks, and the binary basis is stated in the extension's JSDoc so the choice is not silent. The one shipped line that changes is the refs post-install summary.

Non-finite and negative inputs clamp to `0 B` the way `Date.relativeAge` clamps a future timestamp, rather than printing `NaN B`.

`formatReferenceBytes` is deleted and its callers moved; `embedding/setup.ts`'s hand-rolled division moves onto the extension in the same pass, so "one shared formatter" is true of the tree rather than only of the refs module. Extensions are installed by `src/extensions/index.ts`, which `src/index.ts` imports before `cli.parse()`, so every command action has it; test files that exercise it import the loader as `extensions.test.ts` already does.

## Risks / Trade-offs

- **A preset hides which datasets were chosen.** → The consent question still states the plan (file count and destination) before any transfer, and `all`/`recommended` are named in the confirmation, so nothing is installed without a stated plan. The picker escape remains for users who want to see and choose each entry.
- **"Press Enter installs the recommended set" stops being true.** → Intended, and the only behavior removal in this change. The implicit default *is* the reported problem, so it cannot survive; what survives is the outcome. `recommended` is the first entry and the select's initial value, so an untouched prompt plus Enter still plans the recommended set — now as a visible, named choice rather than 32 pre-ticked boxes. Nothing else about the flow is removed: the picker, the consent question, `--refs`, and the headless path all keep their current behavior.
- **A rate readout on a stalled connection reads as motion.** → The rate is windowed against the wall clock and repainted on a timer, so a stall decays to nothing and the segment disappears rather than freezing at a stale number; the file counter is the honest progress signal.
- **Per-chunk callbacks add work to the hot path.** → The reporter does arithmetic and a throttled string build; rendering is time-throttled independently of chunk arrival.
- **A throwing reporter could break an install.** → Reporter invocation is guarded inside the installer; a failed render is dropped, never surfaced as a download failure.
- **`Content-Length` is often absent** (gzip-on-the-fly upstreams, chunked responses). → Treated as the normal case: absence removes the in-flight refinement and changes nothing else about the readout.
