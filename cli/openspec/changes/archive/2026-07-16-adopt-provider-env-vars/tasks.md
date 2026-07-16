## 1. Provider-derived key resolution (env.ts)

- [x] 1.1 In `src/lib/env.ts`, replace the static `env.modelApiKey` field with a `resolveModelApiKey(provider: string): string | undefined` function that reads `INFLEXA_MODEL_API_KEY` first, then the provider-conventional variable (`ANTHROPIC_API_KEY` for `anthropic`, `OPENAI_API_KEY` otherwise) — keeping `env.ts` the sole `process.env` reader.
- [x] 1.2 Extend `envDoc` so `--help` documents the provider-derived fallback (name `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` alongside `INFLEXA_MODEL_API_KEY`) without widening the secret's exposure.
- [x] 1.3 Update every consumer of the old `env.modelApiKey` (e.g. `readModelApiKey` / the model-listing + provider-construction sites) to call `resolveModelApiKey(connection.provider)`.

## 2. Boot key-missing error

- [x] 2.1 In direct mode, when the whole chain resolves to no key, fail boot with an actionable error naming BOTH `INFLEXA_MODEL_API_KEY` and the provider-conventional variable that was tried, plus the config path — before any provisioning or chat request.

## 3. Setup env detection + adoption (setup.ts)

- [x] 3.1 Add a `baseURL` normalizer that ensures the `/v1`-terminated form (append `/v1` when the path has no version segment) and defaults to the provider's public root (`https://api.anthropic.com/v1`, `https://api.openai.com/v1`) when no `*_BASE_URL` is set.
- [x] 3.2 In `promptDirectConnection`, detect the ecosystem env (`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` ⇒ anthropic/anthropic; `OPENAI_API_KEY`/`OPENAI_BASE_URL` ⇒ openai/openai-compatible) and, when found, present the normalized connection as an editable pre-filled default the user confirms.
- [x] 3.3 When both ecosystem sets are present, prompt which to adopt (interactive) / apply the anthropic-before-openai precedence (non-TTY).
- [x] 3.4 On confirmation, write only `{ provider, baseURL, protocol }` via the existing `writeDirectConnection` — never the key. Declining falls through to the current manual prompts.

## 4. Non-interactive self-configure

- [x] 4.1 Allow `setup --connection direct` on a non-TTY terminal to self-configure from a detected env with no prompts; when no provider env is detectable, keep the existing "needs an interactive terminal" failure.

## 5. Documentation of deferred scope

- [x] 5.1 In setup's direct-path note and/or `envDoc`, state that `ANTHROPIC_AUTH_TOKEN` and Bedrock/Vertex are not adopted, with the one-line reason and the `protocol: openai-compatible` workaround for a bearer gateway.

## 6. Tests

- [x] 6.1 Unit-test `resolveModelApiKey` precedence: override wins; anthropic fallback; openai fallback; none → undefined.
- [x] 6.2 Unit-test the `baseURL` normalizer: bare anthropic root → `/v1`-terminated; already-`/v1` unchanged; absent → provider default.
- [x] 6.3 Test setup adoption: anthropic detection + normalized prefill; openai detection; both-present tiebreak; decline → manual; key never written to config (assert `config.json` carries no key material).
- [x] 6.4 Test the boot key-missing error names both variables in direct mode.
- [x] 6.5 `bun run typecheck`, `bun run lint`, and `bun test` pass; run `bun run format:file` on every changed `src/` file.
