## 1. Shared download utility

- [x] 1.1 Extract a generic HTTPS→file utility (`src/lib/download.ts`: `downloadToFile` + `declaredContentLength`) — HTTPS re-checked on the post-redirect URL, sha256, `.part`→atomic activation, progress events, injected `fetch`. Unit-tested (`download.test.ts`).
- [ ] 1.2 Repoint `refs/store.ts` `downloadArtifact` at `downloadToFile` (thin wrapper: content-addressed dest, `assertOwnedPath`, progress/error remap); dedupe `declaredContentLength`. Keep the 43 refs store tests green. NOT a blind swap — refs treats the `.part` itself as the durable artifact in a separate downloads dir and reclaims it by name, so a naive repoint leaks a copy of every artifact.

## 2. GEO source module

- [x] 2.1 Pure `parseGseAccession(raw): Result` (`/^GSE\d+$/`, uppercase-normalized) and `geoSeriesUrls(acc)` — bucket = digits with last 3 → `nnn` (`GSE12345`→`GSE12nnn`); soft/matrix/suppl paths on `ftp.ncbi.nlm.nih.gov`. Unit-tested purely.
- [x] 2.2 Resolve the artifact set: SOFT family file, series-matrix parts (enumerate `matrix/` for per-platform files), author supplementary (enumerate `suppl/`). Exclude raw SRA. Enumeration resolves each href against the directory URL and keeps only same-origin, exactly-one-segment-deeper results — a `href="..."` regex cannot tell a file from the site-wide hhs.gov footer link NCBI puts on every page, the absolute parent link, or the `mailto:` links on its "Access forbidden" page. Names are HTML-unescaped, percent-decoded, and admitted only as single safe path segments. An absent (404) or unreadable (403) directory contributes nothing rather than failing the resolve.
- [x] 2.3 Retry with exponential backoff and space consecutive requests: NCBI sheds load with 403 — the same status it serves for a directory with no index, observed flapping 200↔403 on identical URLs seconds apart.
- [x] 2.4 Transfer via `downloadToFile` into a staging directory beside the destination (HEAD size sweep + `GEO_SERIES_MAX_BYTES` cap, HTTPS-on-redirect), and move into `<anchor>/<accession>/` only on full success, so a failed run leaves nothing in the user's data folder. Report per-file progress. Malformed/unresolvable/empty/oversized are `Result` errors.
- [x] 2.5 The command downloads and stops: **no input rows, no provenance, no staging, no seed, no reprofile, no runtime boot, no analysis lock** (see D1). Enrolment is the user's separate step through the existing add-inputs path.
- [x] 2.6 Unit tests over **captured real NCBI HTML** (a populated autoindex and the "Access forbidden" page), so no fixture is kinder than production: URL resolution; multi-platform matrix enumeration; hhs.gov footer and off-origin rejection; traversal refusal (plain and percent-encoded); percent/entity decoding; persistent-403-is-empty; 403-clears-on-retry; transport-throw retry; persistent 5xx is `unreachable`; size cap refuses and downloads nothing; a mid-set failure leaves no directory behind; progress event sequence.

## 3. Command registration

- [x] 3.1 Register the `approval` command in `src/cli/index.ts` via `registerAction(...)` with full arg/option descriptions; resolve the target folder via `resolveContext` (ambient-aware); `dieOn` at the boundary.
- [x] 3.2 Add the grantKey row (`"approval"`) to both `EXPECTED_DEV_OFF` and `EXPECTED_DEV_ON` in `agent_policy_tree.test.ts`; run it.
- [x] 3.3 `bun run docs:gen` accepts every description.

## 3a. Session-analysis injection + ambient context

- [x] 3a.1 `run_inflexa` (`inflexa_tool.ts`): thread an explicit child env through the subprocess seam; set `INFLEXA_ANALYSIS` from `ctx.session.scope` when `kind==="analysis"` (spread `Bun.env`). Tests: env carries the id from the session (not argv); non-analysis scope injects nothing; a parent key survives the merge.
- [x] 3a.2 `lib/env.ts`: `ambientAnalysisRef()` reader (call-time, empty=unset, out of `env`/`envDoc`). `context.ts`: add `ambientAnalysis?` to `ContextFlags` and the ambient tier (below explicit flag, above marker; miss → fall through). Tests for the tier precedence. NOTE: the `geo add` command wires `ambientAnalysisRef()` at its own boundary (all the feature needs); wiring it at the shared launch/status/profile boundaries — so every agent-run command honors the ambient env — remains a follow-up.

## 4. Validate & finish

- [x] 4.1 `openspec validate --strict` ✓; `bun run typecheck` ✓ (clean); `bun run lint` ✓ (exit 0); `bun run format:file` applied to changed `src/` files. `bun test`: the only failures are a pre-existing full-suite interference set (identical with this change stashed; each file passes in isolation) touching no file this change modifies.
- [x] 4.2 Live verification against real NCBI: `GSE185553` resolves 5 artifacts including its supplementary files, `GSE110004` resolves both per-platform matrix parts. A full `downloadGeoSeries("GSE185553")` transferred all 5 files (153.1 MB) into the destination with the staging directory cleaned up.
- [ ] 4.3 Integration test: download a small public GSE end-to-end through the registered command, then add it via the existing add-inputs path and confirm the staged series matrix reads cleanly with the general data tools (no GEO-specific library).

## 5. Adjacent defects this change surfaced

- [x] 5.1 `--analysis` was silently swallowed on every subcommand that declares it: the root program declares the same option names (`index.ts:93`), so commander binds the value to the ROOT and the subcommand's action receives `{}` — the flag reached no handler, on six commands, since `864d25a`. `registerAction` now hands every handler `optsWithGlobals()`, fixing all of them at one choke point. NOT `enablePositionalOptions()`: that was tried and reverted before, because it turns a root-style flag placed after a subcommand (`inflexa sessions --project x`) into a hard "unknown option" — pinned by a regression test, which is what caught the second attempt. Both halves of the trade-off are now pinned in `cli.test.ts`.
- [x] 5.2 `--max-size <size>` overrides the per-Series ceiling (`500MB`, `64GB`, or a plain byte count; binary units, so a size copied out of the command's own output round-trips). The over-cap message names the flag and the size that would allow it.
- [x] 5.3 The `run_inflexa` subprocess bound is now QUIET time, not wall-clock: `idleTimeoutMs` (120 s, rearmed on every chunk either stream produces) plus a 30-minute absolute backstop. A flat deadline cannot tell a working command from a wedged one, so any value was wrong for someone — 2 minutes killed a legitimate multi-gigabyte download, and a value generous enough to spare it would have let a hung command hold the turn just as long. `geo add` feeds it a `file_progress` heartbeat every 5 s during a transfer, which doubles as the readout a long download needed anyway.
- [x] 5.4 The harness `search_geo_datasets` description no longer claims fetching is impossible. It still forbids planning an in-sandbox download (the sandbox genuinely has no egress) but defers the question of whether the data can be obtained at all to the agent's actual tool set — it names no host command, since the harness is host-agnostic and `skills`/prompt content must not encode one host's inventory.
- [x] 5.5 `--project` is gone from `geo add`: a project scopes to a SET of analyses and `resolveContext` answers a project ref with a picker, never a single analysis, so the flag could only ever have failed. `--analysis` names a target.
- [x] 5.6 An unresolvable `--analysis <ref>` now reports that no analysis matches the ref (with the known analyses), instead of telling a user who just passed `--analysis` to pass `--analysis`.

## 6. Known gaps (not addressed)

- [ ] 6.1 `refs/store.ts` still carries its own copy of the transfer primitive (task 1.2).
- [ ] 6.2 A cluster of `spawnInflexa` process-bounds tests fails only in a full-suite run — spawned children yield no captured output under 124-file parallel load, so every assertion on child output fails together. Pre-existing (identical set with this change stashed) and each file passes in isolation, but it now also masks the new idle-bound rearm test.
