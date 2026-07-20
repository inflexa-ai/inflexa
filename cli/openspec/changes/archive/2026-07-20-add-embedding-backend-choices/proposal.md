## Why

The embedding model became a build-time embedded asset (the binary carries `bge-small-en-v1.5` and materializes it offline), but the embedding surface never caught up. Setup still presented one undifferentiated "local" option whose copy implied a download even in a compiled binary — where the model is an embedded asset, not a fetch — and it gave no way to point at a GGUF the user already has. The provider hardcoded bge-small's 384 width, so a local model of any other width could never be wired up, even though the config schema already carries `embedding.dimensions`. `inflexa config` compounded the mismatch: it rendered `embedding.*` as always-visible per-field rows — a model path beside an api key beside a base URL, most of them inapplicable to the active backend — because the block is a mode-discriminated union that a flat row set cannot honestly show. And the launch-time readiness gate checked the built-in location, so a user who pointed at their own GGUF failed the gate for a file the run was never going to use.

## What Changes

- Setup's picker splits the former single "local" option into the BUILT-IN bundled model and the user's OWN local GGUF, alongside api-key and off. Picker copy matches the install context — the built-in choice no longer claims it downloads the model in a compiled binary.
- A custom GGUF is verified WITHOUT asserting a width: the sidecar probe measures whatever the model emits and records it as `embedding.dimensions` (only when it differs from the built-in 384). The local provider no longer hardcodes 384 — one width drives both the sidecar request and the advertised `provider.dimensions` the harness sizes each index to, defaulting to 384 when nothing is recorded.
- `ensureEmbedderReady` gates the CONFIGURED `embedding.modelPath` (falling back to the built-in location only when none is recorded), so a custom GGUF at the user's own path passes the launch gate.
- `inflexa config` replaces the always-visible `embedding.*` field rows with ONE summary row plus a backend picker and per-backend follow-up dialogs, reusing the existing dialog components. Nothing touches the draft until a branch's final step, so cancelling anywhere aborts cleanly; the api key is never printed on the summary row.
- api-key configuration fetches the endpoint's embedding-capable models and offers them as a selection instead of free text, degrading to free-text entry whenever the listing is unavailable. The fetch is its own module: the proxy's model list is chat-only and hardwired to the local proxy, while this backend talks directly to a user-supplied endpoint.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `local-embeddings`: the provider requirement takes a per-config width (`deps.dimensions`, defaulting to 384) that drives both the sidecar request and the advertised width; the vectors requirement generalizes "384-dimensional" to the advertised width; config-driven resolution passes `embedding.dimensions` through to the local provider; the setup requirement becomes a four-way backend picker (built-in / custom GGUF / api-key / off) that measures a custom model's width; the readiness gate checks the configured path; the interactive-flow question offers four choices. A new requirement covers configuring embeddings through dialogs in `inflexa config`.

## Impact

- `cli/src/modules/embedding/setup.ts` — the four-way backend picker, the built-in vs custom-GGUF branches, the measure-don't-assert `verifyModel`, and the configured-path readiness gate.
- `cli/src/modules/embedding/api_models.ts` (new) — remote embedding-model discovery for the api-key backend, with the cleartext-http credential-leak guard.
- `cli/src/modules/embedding/resolve.ts` — local mode passes `embedding.dimensions` through to `createLocalEmbeddingProvider`.
- `cli/src/modules/embedding/local-provider.ts` — `deps.dimensions` drives both the sidecar request width and the advertised `provider.dimensions`, defaulting to `LOCAL_EMBEDDING_DIMENSIONS` (384).
- `cli/src/tui/app_config.tsx` — the single embedding summary row and the backend-picker dialog chain.
- `cli/src/cli/index.ts`, `cli/src/modules/infra/setup.ts` — `--embeddings` help and setup next-steps copy naming the built-in model and `inflexa config`.
- Tests across `modules/embedding` (`api_models`, `resolve`, `local-provider`, `setup`).
- No new dependencies. No config-schema change (`embedding.dimensions` already existed). No prod-visible data migration.
