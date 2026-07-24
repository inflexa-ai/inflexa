## 1. Factor the shared transfer utility

- [ ] 1.1 Extract the streaming-download primitive from `src/modules/refs/store.ts` (`downloadArtifact` / `measureReferenceDownload`) — HTTPS re-checked on the post-redirect URL, sha256, `.part`→atomic activation, progress, HEAD size probe — into a shared utility both the reference installer and the GEO source use. Return `Result`, per the neverthrow rule.
- [ ] 1.2 Point the reference installer at the shared utility; keep `refs` tests green.

## 2. GEO source module

- [ ] 2.1 Implement accession validation + NCBI URL resolution: bucket derivation (`GSE12345` → `GSE12nnn/GSE12345/`), the SOFT family file, the series matrix incl. per-platform parts, and `suppl/` enumeration — excluding raw SRA. Malformed / unresolvable / empty-processed-files return `Result` errors.
- [ ] 2.2 Fetch the resolved set to a temp dir via the shared utility (size estimate first, HTTPS-on-redirect re-check, size cap); enroll the local paths on the target analysis via `applyInputsDiff`/`addInputs` only on full success.
- [ ] 2.3 Unit tests: multi-platform matrix resolution; SRA exclusion; HTTPS-on-redirect refusal; malformed and empty-Series error outcomes; failed download enrolls nothing; a successful run enrolls the files and they stage under `data/inputs`.

## 3. Command registration

- [ ] 3.1 Register the command via `registerAction(..., "approval", handler)` with full argument/option descriptions (per `cli-reference-docs`); resolve the target analysis through `resolveContext` (so the injected ambient analysis is honored); report success/failure at the CLI boundary with `dieOn`.
- [ ] 3.2 Update the `agent_policy_tree` snapshot test for the new command; confirm `run_inflexa` resolves it to `approval` and it is not `auto`/`blocked`.
- [ ] 3.3 Test: the command appears in the reference-docs generation with descriptions; agent-policy classification is `approval`.

## 3a. Session-analysis injection (robust chat targeting)

- [ ] 3a.1 In `run_inflexa` (`src/modules/harness/inflexa_tool.ts`), read the analysis id from `ctx.session` scope when kind is `analysis` and set `INFLEXA_ANALYSIS` on the spawned subprocess env (thread an explicit `env` into `runSubprocess`/`Bun.spawn`); inject nothing for a non-analysis scope.
- [ ] 3a.2 Expose `INFLEXA_ANALYSIS` through `lib/env.ts` (the sole env reader) and read it at the CLI boundary; pass it into `resolveContext` as the ambient analysis ref (below an explicit `--analysis`, above the marker walk-up), keeping `context.ts` library-pure.
- [ ] 3a.3 Tests: `run_inflexa` sets `INFLEXA_ANALYSIS` from the session (and only from the session, not the argv); a non-analysis session injects nothing; `resolveContext` resolves the ambient ref when no flag is set, an explicit flag overrides it, and the marker is consulted only when neither is set.

## 4. Sandbox parse readiness

- [ ] 4.1 Confirm GEOparse and/or GEOquery are provisioned in the sandbox library store so the offline `get_GEO(filepath=…)` / `getGEO(filename=…)` path is available; flag for the lib-store build if missing.

## 5. Validate & finish

- [ ] 5.1 `openspec validate download-geo-datasets --strict`; `bun run typecheck`; `bun run lint`; `bun test`; `bun run format:file` on changed `src/` files.
- [ ] 5.2 Integration test: download a small public GSE end-to-end into an analysis; confirm the enrolled files stage as inputs, the profile refreshes, and they parse offline in a sandbox step.
