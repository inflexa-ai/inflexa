## 1. Shared download utility

- [x] 1.1 Extract a generic HTTPS→file utility (`src/lib/download.ts`: `downloadToFile` + `declaredContentLength`) — HTTPS re-checked on the post-redirect URL, sha256, `.part`→atomic activation, progress events, injected `fetch`. Unit-tested (`download.test.ts`).
- [ ] 1.2 Repoint `refs/store.ts` `downloadArtifact` at `downloadToFile` (thin wrapper: content-addressed dest, `assertOwnedPath`, progress/error remap); dedupe `declaredContentLength`. Keep the 43 refs store tests green.

## 2. GEO source module

- [ ] 2.1 Pure `parseGseAccession(raw): Result` (`/^GSE\d+$/`, uppercase-normalized) and `geoSeriesUrls(acc)` — bucket = digits with last 3 → `nnn` (`GSE12345`→`GSE12nnn`); soft/matrix/suppl paths on `ftp.ncbi.nlm.nih.gov`. Unit-tested purely.
- [ ] 2.2 Resolve the artifact set: SOFT family file, series-matrix parts (enumerate `matrix/` autoindex for per-platform files), author supplementary (enumerate `suppl/` autoindex by regex over `href="..."`). Exclude raw SRA. Empty/absent `suppl/` is a normal "nothing to add".
- [ ] 2.3 Fetch the set to a temp dir via `downloadToFile` (size-estimate/cap, HTTPS-on-redirect); on full success enroll the local paths as inputs via `applyInputsDiff`/`addInputs`. **No staging, no seed, no reprofile, no runtime boot** (see the design decision). Return/report what was enrolled; malformed/unresolvable/empty are `Result` errors.
- [ ] 2.4 Unit tests: URL resolution; multi-platform matrix enumeration; SRA exclusion; HTTPS-on-redirect refusal; malformed/empty errors; enroll records rows and boots no runtime.

## 3. Command registration

- [ ] 3.1 Register the `approval` command in `src/cli/index.ts` via `registerAction(...)` with full arg/option descriptions; resolve target via `resolveContext` (ambient-aware); `dieOn` at the boundary.
- [ ] 3.2 Add the grantKey row (`"approval"`) to both `EXPECTED_DEV_OFF` and `EXPECTED_DEV_ON` in `agent_policy_tree.test.ts`; run it.
- [ ] 3.3 `bun run docs:gen` accepts every description.

## 3a. Session-analysis injection + ambient context

- [ ] 3a.1 `run_inflexa` (`inflexa_tool.ts`): thread an explicit child env through the subprocess seam; set `INFLEXA_ANALYSIS` from `ctx.session.scope` when `kind==="analysis"` (spread `Bun.env`). Tests: env carries the id from the session (not argv); non-analysis scope injects nothing; a parent key survives the merge.
- [ ] 3a.2 `lib/env.ts`: `ambientAnalysisRef()` reader (call-time, empty=unset, out of `env`/`envDoc`). `context.ts`: add `ambientAnalysis?` to `ContextFlags` and the ambient tier (below explicit flag, above marker; miss → fall through). Wire `ambientAnalysisRef()` at the resolveContext boundaries (launch/status/profile). Tests for the tier precedence.

## 3b. Host-side input reconcile after a run_inflexa action

- [ ] 3b.1 `run_inflexa`: after a successful ACTION run (not blocked/denied/introspection) in an analysis-scoped session, invoke an injected host callback to reconcile input parity for the session's analysis. Add the callback to `createRunInflexaTool(deps)`.
- [ ] 3b.2 Wire the callback at the composition root (`harness/runtime.ts`) to drive parity for the open analysis when boot is ready (reuse `driveProfileParity`/the Bus), idempotent no-op when inputs match. Tests: a successful action drives the callback with the session analysis id; a denied/introspection call does not.

## 4. Sandbox parse readiness

- [ ] 4.1 Confirm GEOparse and/or GEOquery are provisioned in the sandbox library store so the offline `get_GEO(filepath=…)` / `getGEO(filename=…)` path works; flag for the lib-store build if missing.

## 5. Validate & finish

- [ ] 5.1 `openspec validate --strict`; `bun run typecheck`; `bun run lint`; `bun test`; `bun run format:file` on changed `src/` files.
- [ ] 5.2 Integration test: enroll a small public GSE end-to-end; confirm the rows are recorded and (under a runtime owner) the files stage + profile and parse offline in a sandbox step.
