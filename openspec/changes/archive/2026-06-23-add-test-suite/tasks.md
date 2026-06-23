## 1. Test harness (foundational — do first)

- [x] 1.1 Add a preload that sets `XDG_DATA_HOME`/`XDG_CONFIG_HOME` to a per-process temp dir; register it via `bunfig.toml` `[test] preload`. Add a harness self-test asserting `env.dbPath` resolves under the temp dir. → `src/test_support/preload.ts` (lives in src + eslint-exempted like env.ts so it can set `process.env`; `[test].preload` does NOT inherit top-level, so opentui preloads are repeated there).
- [x] 1.2 Add a temp-DB helper (freshly-migrated connection; resets the `db()` `_db` singleton; teardown removes `-wal`/`-shm`). Self-test: write a probe table, confirm it's gone after a reset. → `src/test_support/db.ts` (`freshDb`/`resetDb`) + new `closeDb()` export in `src/db/primary.ts`.
- [x] 1.3 Add a Solid `createRoot` test-lifecycle helper. Self-test: body value returned + root disposed. → `src/test_support/solid.ts` (`withRoot`). NOTE: the broad global-store reset hooks (theme/notice/status/conversation/keymap) were deferred as YAGNI — each store test (§5.x) resets via its own API; revisit if duplication appears.
- [x] 1.4 Add a `testRender` frame helper (`{width,height}` → trimmed `captureCharFrame()`, `renderer.destroy()` in `finally`). Self-test: render a trivial `<text>` and assert the frame. → `src/test_support/tui.ts` (`renderFrame`) + `render.test.tsx`. `testRender` is exported from `@opentui/solid`; opentui renders headlessly under bun:test (no segfault). Node type taken via `Parameters<typeof testRender>[0]` so the helper file needs no JSX.
- [x] 1.5 Add a `Bun.spawnSync` CLI helper (inherits the sandbox env → `{exitCode,stdout,stderr}`). Self-test: `inf --help` exits 0, stdout has the command list. → `src/test_support/cli.ts` (`runCli`). Entry resolved via `import.meta.dir` (absolute, so a `cwd` override doesn't break it); child inherits parent env, so the preload's XDG sandbox flows through — no `process.env` read needed.

## 2. Unit tests — pure logic

- [x] 2.1 `str256`/`asStr256` — empty/whitespace, 256-ok, 257-too-long, emoji code-point counting, trim-before-measure, asStr256 unchecked (`lib/types.ts`). → `src/lib/types.test.ts`.
- [x] 2.2 Extensions — `JSON.parseWith` (bad-json + schema-mismatch → null), `Response.prototype.jsonWith`, `Date.relativeAge` (buckets + negative clamp, pinned via `spyOn(Date,"now")`), `Promise.sleep` (real 20ms, asserts elapsed). → `src/extensions/extensions.test.ts` (imports `./index.ts`).
- [x] 2.3 Auth helpers — `describeAuthError` (all 10 variants + interpolation), `decodeIdTokenClaims` (valid/strip-unknown/missing-seg/bad-json/non-object), `isExpiring` (future/within-buffer/expired), `tokenWireToStoredAuth` (first-login/refresh-merge/missing-field/no-refresh). → `src/modules/auth/auth.test.ts`. Exported `decodeIdTokenClaims` (whoami.ts), `isExpiring` + `tokenWireToStoredAuth` (auth.ts) — export-only, no behaviour change.
- [x] 2.4 Chat shaping — `toModelMessages` (join text parts, empty-turn skip, non-text ignored, role preserved) + `pickDefaultModel` (preference order, substring/case-insensitive, fallback). Exported both. → `src/modules/intelligence/chat.test.ts`.
- [x] 2.5 Analysis pure logic — `canWrite`/`canRead` boundary cases incl. boundary-safe containment (`/work/outside` ∉ `/work/out`); `contains` tested through the public fns. → `src/modules/analysis/boundary.test.ts`.
- [x] 2.6 Analysis pure logic — `makeBaseSlug` (kebab/NFKD/symbol-only fallback), `describeContext` (all 5 `ResolvedContext` kinds, `plural` via it), `openerArgv` (3 platforms). Exported `makeBaseSlug`; exported `openerArgv` with a defaulted `platform` param (testable seam). → `analysis.test.ts`, `context.test.ts`, `open.test.ts`.
- [x] 2.7 Config self-healing (`theme`/`runtime`/`leaderTimeout` `.catch`) vs strict `telemetry` (no `.catch` → whole-config fail-closed), tested through the public `readConfig` with temp config files. → `src/lib/config.test.ts`. ALSO covers §3.6's `readConfig`/`writeConfig` round-trip + malformed-JSON fail-closed.
- [x] 2.8 `design_system.ts` cross-table invariants — id-matches-key, all themes share the same color roles, hex format, dark/light variant, every `MARKERS` role ∈ ThemeColors, single-cell glyphs, `DEFAULT_THEME_ID` valid. → `src/lib/design_system.test.ts`.
- [x] 2.9 `runtimes.*.mountArg` docker-vs-podman `:z` (`lib/container.ts`) + `proxyConfig` YAML & `generateApiKey` structure (`proxy/setup.ts`, exported both). → `src/lib/container.test.ts`, `src/modules/proxy/setup.test.ts`. (`isProvider`/`resolveProvider` left untested — trivial `.includes` guard + thin throw-wrapper, not worth exporting.)

## 3. Integration tests — temp DB / temp dirs (needs §1)

- [x] 3.1 Migration runner — full schema created, `_migrations` ledger records v1, idempotent re-run, analyses FKs declared (via `runMigrations(new Database(":memory:"), migrations)`). → `src/db/primary_migrations.test.ts`.
- [x] 3.2 Round-trips (project, anchor, session+message+part through the query layer) + `DbError` classification (unique / FK / not-null) + absence-on-ok-channel, via `freshDb()`. → `src/db/storage.test.ts`.
- [x] 3.3 id-or-name resolvers — `findProjectByRef` (by id, by name, id-beats-name, null) / `findAnalysesByRef` (id sorts first) + `matchAnalysis` (`others` on name collision, empty on id hit, null). → `src/db/resolvers.test.ts`.
- [x] 3.4 Marker — `readMarker` (absent→null, valid, corrupt-JSON→throw, schema-mismatch→throw), `writeMarker` (create, write-once, corrupt→throw-not-clobber), `findMarkerUpwards` (self, walk-up, none→null). Temp dirs. → `src/modules/anchor/marker.test.ts`.
- [x] 3.5 Anchor reconciliation — `resolveAnchor` step 1 (cached hit) / step 2 (self-heal to search root) / step 3 (unlocatable→null), `classifyMarkerSighting` ok/ok/copy/move. Temp dirs + `freshDb()`. → `src/modules/anchor/anchor.test.ts`.
- [x] 3.6 Path — `classifyInputPath` (inside-anchor→relative, at-anchor→".", no-marker→absolute, missing→error), `resolveOutputDir` 3-case ladder (explicit / writable-anchor / fallback). → `src/modules/analysis/input.test.ts`, `output.test.ts`. (Config round-trip already covered in §2.7.)

## 4. CLI e2e — subprocess (needs §1)

- [x] 4.1 Read commands — `inf ls` (seeded analysis + empty case), `inf project ls` (seeded), `inf sessions` (seeded), `inf status` (empty context) exit 0 and print the seeded entities. → `src/cli/read_commands.test.ts`.
- [x] 4.2 `inf project new` — fresh name persists (read back from DB), exits 0 with confirmation; duplicate name exits non-zero ("already exists"); blank name rejected. → `src/modules/project/project.test.ts`.
- [x] 4.3 `inf repair <path>` — re-points an anchor's stale cached path to the marker's location (exit 0, read back via DB); fails with "No marker" when absent. → `src/modules/anchor/backstop.test.ts`.
- [x] 4.4 No-litter guarantee — `inf status` in a marker-less cwd exits 0 and writes no `.inf/id`. → `src/cli/read_commands.test.ts`.
- [x] 4.5 Help/usage — `inf --help` exits 0 and lists commands; unknown option exits non-zero; unknown subcommand exits non-zero. → `src/cli/cli.test.ts`.

## 5. TUI tests (needs §1)

- [x] 5.1 `applyBusEvent` reducer — message.created (+session-filter ignore), part.updated upsert, part.delta accumulate/reset, session.status idle flush-to-store + buffer clear, session.error. → `src/tui/hooks/conversation.test.ts`. (Module-global signals/store read directly; `resetHotState()` resets between cases — no `createRoot` needed.)
- [x] 5.2 TUI stores — theme `setTheme`/`themeId()`/`theme()` round-trip + `noticeColor` mapping + recolor-on-switch (`src/tui/theme.test.ts`); status `setChatStatus`/`chatStatus` (`src/tui/hooks/status.test.ts`). (notice store already covered by `notice.test.ts`.)
- [x] 5.3 Keymap config-resolution — `resolveKeybind`/`keybindLabel`/`leaderSeq` defaults + a config override + end-to-end remap through `dispatchKey` (new chord fires, old doesn't). → `src/tui/keymap_config.test.ts`. Added a test-only `__resetKeybindCache()` export to keymap.ts (keybinds resolve load-once; the cache must be cleared to re-read a swapped config).
- [x] 5.4 Component render — `renderFrame` (testRender) of `DialogPanel` swept across 2 terminal heights; title (in border), body, and footer all present at both. → `src/tui/components/dialog_panel.test.tsx`.

## 6. Wrap-up

- [x] 6.1 Ran the full `bun test` suite: 183 pass / 0 fail across 33 files, ~5s, clean exit, no leaked temp dirs / hanging timers.
- [x] 6.2 Updated `TESTING-SYSTEM-REPORT.md` "Current state" with the final counts (33 files / 183 tests) + the harness + per-tier coverage summary.
