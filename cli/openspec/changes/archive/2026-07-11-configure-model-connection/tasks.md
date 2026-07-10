## 1. Config + env surface

- [x] 1.1 Add the `models` block to the config schema (`lib/config.ts`): `connection` as the
      mode-discriminated union (`cliproxy` with optional `provider`; `direct` with `provider`,
      `baseURL`, optional `protocol`), failing closed to the cliproxy/anthropic default with a
      reported config error (existing `.catch` pattern)
- [x] 1.2 Add `INFLEXA_MODEL_API_KEY` to `lib/env.ts` (documented in `envDoc`), the only reader
- [x] 1.3 Add a `resolveModelConnection()` in the harness module config layer
      (`modules/harness/config.ts`): defaults, protocol implication (`anthropic`→anthropic, else
      openai-compatible), and the resolved-connection type the boot consumes
- [x] 1.4 Unit tests: schema defaults, invalid-block fail-closed + configError surfacing,
      protocol implication, env var presence/absence

## 2. Boot rewiring

- [x] 2.1 Replace the `createAnthropicProvider` call in `modules/harness/runtime.ts` with the
      harness front-door factory fed by the resolved connection (cliproxy mode resolves to the
      Anthropic kind at `env.cliproxyApiUrl` with the proxy client key — byte-equivalent config)
- [x] 2.2 Gate model resolution by mode: cliproxy keeps `resolveModelId`/`pickDefaultModel` with
      the provider-family agreement guard (`model_provider_mismatch` boot error replacing
      `model_not_claude`, remediation copy in `profile.ts`'s `describeBootError`); direct requires
      an explicit configured model (`model_required` boot error) and skips auto-resolve; direct
      with missing `INFLEXA_MODEL_API_KEY` fails boot naming the var
- [x] 2.3 Thread the connection's `provider` slug into `RunEngineComposition.modelProvider`
      (replacing the `modelProvider(model)` call site) and keep the composed `{provider}/{model}`
      emitters unchanged
- [x] 2.4 Skip the proxy-readiness gate for chat when the connection is direct
      (`ensureProxyReady` callers: TUI launch, REPL) — Postgres/sandbox gating unchanged
- [x] 2.5 Boot/runtime tests: default-connection boot unchanged (regression), direct-mode
      construction, both new boot errors, mismatch guard degenerating to the old Claude check
      under the default provider

## 3. Derivation removal (provenance read-through)

- [x] 3.1 Delete `modelProvider()` from `modules/proxy/models.ts`; reduce `MODEL_FAMILIES` to the
      ranking list (`MODEL_PREFERENCE`) it backs; drop the derivation unit tests
- [x] 3.2 Sweep for remaining family→provider mappings (grep `unknown/`, `modelProvider`,
      `MODEL_FAMILIES`) — provenance/telemetry consumers read the composition fact only
- [x] 3.3 Update prov bridge/wiring tests: identity comes from the configured connection
      (`deepseek/some-alias-v2`-style case asserting no sniffing path exists)

## 4. Setup flow

- [x] 4.1 Add the connection-mode choice to `inflexa setup` (interactive prompt + a
      non-interactive flag, e.g. `--connection cliproxy|direct`); direct path collects
      endpoint/provider/protocol, writes `models.connection`, prints the
      `INFLEXA_MODEL_API_KEY` instruction, and skips proxy provisioning
- [x] 4.2 CLIProxy path: write the connection provider slug from the authenticated account kind
      (account-kind→slug map lives only in `modules/infra/setup.ts`); rewrite on
      re-authentication
- [x] 4.3 Setup tests: both paths write the expected config; direct provisions Postgres but no
      proxy container; provider slug rewritten on provider switch

## 5. Verification

- [x] 5.1 `bun run typecheck`, `bun run lint`, `bun test` green in `cli/` (fresh `harness/dist`
      with the `expose-provider-config` exports)
- [x] 5.2 End-to-end sanity per `verify` skill: default boot (cliproxy) chat turn works
      unchanged; direct mode against a real or stubbed OpenAI-compatible endpoint produces a chat
      turn and a provenance document carrying the configured `{provider}/{model}`
      (settled as automated coverage by user decision: boot-path tests exercise both modes through
      the seams and the prov wiring tests pin the configured `{provider}/{model}` identity; a live
      chat-turn check needs real model traffic + the user's infra and was deliberately not run)
