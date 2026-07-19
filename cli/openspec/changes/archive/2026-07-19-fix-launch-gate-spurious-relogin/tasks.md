## 1. Probe classification core (`cli/src/modules/infra/setup.ts`)

- [x] 1.1 Add a `not_ready` kind to `ProbeAttempt`, map `classifyModelResolution`'s `no_models` case to it, and extend `retryWhileUnreachable` to retry `not_ready` under the same `PROXY_BOOT_BUDGET_MS` budget as `unreachable` (update its JSDoc to carry the answering-but-unregistered rationale)
- [x] 1.2 Map budget expiry on `not_ready` to a new ambiguous `CredentialProbe` outcome (empty list at deadline) carrying the two-cause detail (unloadable credential file / provider-side suspension) instead of `unauthorized`
- [x] 1.3 Reclassify the model-listing `HTTP 401` in `classifyModelResolution` from `unauthorized` to a client-key-drift outcome whose warning names the config-vs-running-proxy mismatch and `inflexa setup` as the remedy
- [x] 1.4 Add a `cooling_down` probe outcome: parse a served 503 body in `askProxy` (and the model-resolution 503 path) for the proxy's `auth_unavailable` marker with a zod schema beside the existing `count_tokens` 404 body schema pattern; an unrecognized 503 body stays on the generic unobservable path

## 2. Launch-gate policy (`ensureLiveCredential`)

- [x] 2.1 Replace the unconditional TTY re-login with a clack confirm prompt; declining warns that provider calls will fail until a re-login and proceeds; non-TTY behavior stays the existing hard error naming `inflexa setup --provider <kind>`
- [x] 2.2 Handle the new outcomes: `cooling_down` prints the cooldown notice and proceeds; the ambiguous empty-at-deadline outcome prints the two-cause notice with the `--provider` remedy and proceeds; neither drives a login
- [x] 2.3 Keep the accepted-login path (login → restart → re-probe → second-rejection hard error) and confirm the re-probe reaches the shared readiness wait rather than a bare attempt

## 3. Tests

- [x] 3.1 Unit tests for `classifyModelResolution`: `no_models` → `not_ready`, model-listing 401 → client-key-drift (not `unauthorized`), other statuses unchanged
- [x] 3.2 Unit tests for the retry loop: `not_ready` retried like `unreachable`, empty-at-deadline yields the ambiguous outcome, a list that populates mid-budget yields the populated proxy's verdict
- [x] 3.3 Unit tests for `askProxy` 503 handling: `auth_unavailable` body → `cooling_down`, unrecognized 503 body → unobservable
- [x] 3.4 Policy-matrix tests via `LiveCredentialDeps`: confirm-accept runs login/restart/re-probe, confirm-decline warns and proceeds, `cooling_down` and ambiguous outcomes never call `relogin`, second definite rejection fails, non-TTY rejection fails actionably
- [x] 3.5 Update existing tests that assert the old `no_models` → `unauthorized` and models-401 → `unauthorized` mappings

## 4. Verify

- [x] 4.1 `bun run format:file` on touched files, then `bun run typecheck`, `bun run lint`, `bun test` all green
- [x] 4.2 Walk the delta spec's scenarios against the test list — every scenario has a covering test or a noted manual check (cold-boot window and cooldown behavior verified against a live restarted proxy)
