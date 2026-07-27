# Tasks — non-interactive setup

## 1. The answers module

- [x] 1.1 Create `src/modules/infra/setup_answers.ts`: the `SetupAnswers` zod schema (connection mode/provider/baseURL/protocol/model/auth, postgres fields, resources.sharePct, embedding mode/baseURL/model/gguf, refs preset-or-ids, sandbox variant, runtime) — all fields optional at parse; strict object (unknown keys rejected) for the file front-end
- [x] 1.2 Implement the YAML front-end: read `--config <path>` via `Bun.YAML.parse` boundary-wrapped into a `Result`; a missing, unreadable, or unparseable file fails naming the path and parse error; strict-parse into the answers schema with errors naming the offending key; reject execution-modifier keys (`start`, `force`, `postgres: false`, `validate`, …) by omission from the schema
- [x] 1.3 Implement the flag front-end: map the new commander option values into the same `SetupAnswers` shape (flags win over file values per-question)
- [x] 1.4 Implement `resolveSetupAnswers(flags, file, tty)`: merge with precedence, then run upfront whole-set validation — contextually-required answers (direct: baseURL/provider/model under batch), `--provider` vocabulary keyed on connection mode (reject account-kind answer under batch cliproxy), reserved postgres ports under batch, refs preset words validated against catalog ids, runtime enum, mode-mismatched answers the resolved modes cannot consume (direct-only answers under cliproxy, `--embeddings-gguf` with api-key mode) — every error naming both the flag and file-key spelling
- [x] 1.5 Unit-test the resolver: precedence, strictness, each upfront-validation error, non-TTY ≡ `--yes` resolution, execution-modifier rejection

## 2. Secrets and env surface

- [x] 2.1 Add `INFLEXA_EMBEDDING_API_KEY` to `src/lib/env.ts` (call-time read, sole `process.env` reader) with an env-doc row; requiredness enforced by the resolver when batch answers select api-key embeddings
- [x] 2.2 Unit-test the env read (empty = unset) and its resolver coupling

## 3. Command registration

- [x] 3.1 Register the new options on `setup` in `src/cli/index.ts` under a "Batch mode" `helpGroup` heading, every option described (docs:gen gate): `--config`, `--base-url`, `--protocol`, `--model`, `--auth-env`, `--auth-command`, `--auth-scheme`, `--auth-format`, `--postgres-user/-password/-port/-database/-host`, `--resource-share`, `--embeddings-url`, `--embeddings-model`, `--embeddings-gguf`, `--sandbox`, `--runtime`, `--no-validate`; extend `--refs` help for the `recommended|all` presets; extend `--yes`/`--provider` help for their new meanings
- [x] 3.2 Confirm the agent-policy tree is unchanged (`setup` stays `blocked`; `agent_policy_tree.test.ts` snapshot) and `bun run docs:gen` passes with the new descriptions

## 4. Orchestrator wiring (`src/modules/infra/setup.ts`)

- [ ] 4.1 Thread resolved `SetupAnswers` through `setup()`: resolve + validate first (fail-before-mutate), replace each direct `process.stdin.isTTY` prompt gate with "answered? → use answer; else prompt (TTY, not --yes); else default-or-error"
- [ ] 4.2 Connection step: batch direct builds `DirectConnectionInput` from answers (no adoption, no credential-helper detection, no prompts); batch cliproxy rejects a provider answer (resolver) and skips OAuth — pre-staging notice + exit 0 when `hasProviderCredential` is false
- [ ] 4.3 Direct model: batch requires the answer (resolver); validate via `pingMessagesEndpoint` when validation on — any non-pass outcome (not-found, auth-rejected, unreachable, ambiguous) fails with the endpoint's answer and names `--no-validate` as the escape; persist via `writeAgentModel` for both agents
- [ ] 4.4 Credential-source answers: build the token-free `auth` block from `--auth-*`/file, validate via `probeCredentialSource` when validation on — any non-pass outcome (rejection, unreachable, ambiguous) fails with the probe's answer and names `--no-validate` as the escape — persist via `writeDirectConnection`
- [ ] 4.5 Cliproxy model answer: persist to both agents without the select; check via `checkModelAccess` when the proxy answers — only definite `not_found` fails; skip the interactive election entirely under batch
- [ ] 4.6 Postgres step: answered fields skip prompts; batch unanswered = silent current resolution; persist through `explicitPostgresFields` unchanged (reserved-port answer already rejected upfront)
- [ ] 4.7 Resource step: `sharePct` answer persists the machine-relative absolute budget without the prompt; batch unanswered skips (resolved default applies unpersisted)
- [ ] 4.8 Runtime: answered runtime probes alone as a hard gate (no fallback) and persists on success; unanswered keeps detect-preference-then-pin
- [ ] 4.9 Sandbox: answered variant calls `sandboxPull({variant, yes: true})` (no size prompt); unanswered batch skips with the pull-later hint
- [ ] 4.10 Integration-test the batch orchestrator paths: bare `--yes` defaults outcome, batch direct happy path, fail-before-mutate ordering, pre-staging exit 0, idempotent second run

## 5. Embedding step answers (`src/modules/embedding/setup.ts`)

- [ ] 5.1 Extend `runEmbeddingSetup` to take injected answers: api-key branch consumes `--embeddings-url`/`--embeddings-model` + `INFLEXA_EMBEDDING_API_KEY` without prompts; custom-GGUF branch consumes `--embeddings-gguf` (exists-check, measured-width verify unchanged); an answered `off` persists `embedding.mode: "off"` (declared state — distinct from the picker's skip, which stays a no-write); interactive runs use answers as per-question skips
- [ ] 5.2 Generalize the pre-runtime-gate reorder in `setup()` to fire on any embedding-mode ANSWER (flag or file), not only the `--embeddings` flag; keep the run-once guard
- [ ] 5.3 `--no-validate`: skip the api-key network probe (dimensions fall back to configured/default, stated in output); local sidecar verification always runs
- [ ] 5.4 Unit-test the three answered branches + the batch missing-env-key upfront error

## 6. Refs step answers (`src/modules/refs/commands.ts`)

- [x] 6.1 Add preset resolution: `recommended`/`all` resolve against the OFFERED set (installed-and-intact excluded); validate preset words don't collide with catalog ids; ids answer keeps existing behavior
- [x] 6.2 Make the explicit answer the consent: drop the separate `--yes` requirement for an answered selection in `runReferenceSetup`; batch with no answer = download nothing + store path + hint (remove the headless recommended-set default)
- [x] 6.3 Update the refs unit tests for value-is-consent and the removed headless default

## 7. Docs and release notes

- [ ] 7.1 Verify `bun run docs:gen` output for the new flag surface; regenerate reference docs
- [ ] 7.2 Changelog entries for the three BREAKING notes — `--yes` never prompts (TTY included), headless `--yes` no longer downloads the recommended refs set (`--refs recommended` restores it), non-TTY direct setup no longer adopts `ANTHROPIC_*`/`OPENAI_*` (explicit answers replace it) — plus a minor note that `--embeddings off` now persists `embedding.mode: "off"`

## 8. Verification

- [ ] 8.1 `bun run typecheck`, `bun run lint`, full `bun test` in `cli/`
- [ ] 8.2 Manual smoke: `setup --yes` (bare), `setup --yes --config <fleet.yml>` with a direct connection, a strict-file rejection, and an interactive run with a partial config file (prompts only for unanswered questions)
