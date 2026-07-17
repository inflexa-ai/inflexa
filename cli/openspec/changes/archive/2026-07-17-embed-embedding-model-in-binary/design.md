## Context

Local-embeddings setup has two artifacts to acquire: the `llama-server` sidecar runtime and the bge-small GGUF model. The runtime is already source-aware (`llama_runtime.ts`): compiled binaries materialize it from a build-time embedded asset with no network; source checkouts download the pinned release. The model is not — `downloadModel()` in `setup.ts` always fetches from huggingface.co, which fails for users behind egress-restricted corporate proxies even when they run the official binary. `scripts/build.ts` already owns the whole embed pipeline: an out-of-git `.llama-cache/`, vendored-SHA-256 verification with loud build failure, a stale-artifact sweep, and define-gated `import(..., { with: { type: "file" } })` embedding.

## Goals / Non-Goals

**Goals:**

- `inflexa setup --embeddings local` in a compiled binary completes with zero network access.
- One integrity story: the same vendored `MODEL_SHA256` verifies the build-time fetch, the embedded copy, and the from-source download; nothing lands at `env.embeddingModelPath` unverified.
- Maximal reuse of the existing llama-runtime embed pattern — no new mechanism, cache, or define where an existing one serves.

**Non-Goals:**

- Committing the model to git (LFS) — rejected in the proposal (owner-billed bandwidth quota, contributor friction, second distribution mechanism).
- Per-target model variants — the GGUF is platform-independent; every target embeds the same asset.
- Self-healing a missing model at the launch gate (`ensureEmbedderReady`) — the model is the object of the user's explicit setup consent, unlike the runtime (an internal detail the gate heals silently). The gate keeps directing to `inflexa setup --embeddings local`, whose remediation now works offline in compiled binaries.
- Changing the from-source flow, the sidecar verification probe, or any config surface.

## Decisions

**D1 — Reuse `.llama-cache/` as the single build artifact cache.** The model GGUF is cached beside the runtime archives. An alternative `.model-cache/` would mean a second gitignore entry, a second sweep, and a second "delete this dir to force re-fetch" story for zero isolation benefit. The `.gitignore` comment widens to "build-time embedded artifacts".

**D2 — Gate the embed import on `__INFLEXA_COMPILED__`, not a new define.** The runtime needs `__INFLEXA_LLAMA_TARGET__` because each target embeds a *different* archive and the other four imports must be DCE'd. The model is one asset for all targets, so the existing every-target `__INFLEXA_COMPILED__` define is exactly the right key: under a `typeof` guard the bundler folds the branch to the file-import when compiling and to `null` in dev/source/test runs (where the identifier is undeclared), so the import specifier into `.llama-cache/` is never resolved outside a release build. `setup.ts` declares the ambient const locally under the same `typeof` discipline — precedent: `llama_runtime.ts` declaring `__INFLEXA_LLAMA_TARGET__`, `install_context.ts` declaring `__INFLEXA_COMPILED__`.

**D3 — Route acquisition with `isCompiledBinary()`, resolve bytes with the folded import.** Mirrors `materialize()` in `llama_runtime.ts` exactly: the routing decision goes through the accessor (which honors `__setCompiledBinaryForTest`), while the embedded-path resolution lives in a private `embeddedModelPath(): Promise<string | null>` whose branches fold at build time. Embedded bytes are read with `Bun.file(path).bytes()` and written with `Bun.write` — the bunfs-safe pair (fd-based APIs ENOENT on `/$bunfs`), same as `writeEmbeddedArchive`.

**D4 — `downloadModel()` becomes `acquireModel()`, keeping its contract.** Skip-if-present, `.part` staging with atomic rename, SHA-256 verification, and clack spinner narration all stay; only the byte source branches. The embedded branch verifies the copied bytes against `MODEL_SHA256` too — the build already verified them, but re-verifying keeps the single invariant "nothing lands at the final path unverified" unconditional rather than source-dependent (identical to `materialize()` hashing the embedded archive). No external callers exist (`runLocalSetup` is the only call site; tests exercise the flow above it), so the rename is contained.

**D5 — Home the pin in a leaf `model_pin.ts` module; both `setup.ts` and the build import it.** The three constants — `MODEL_URL`, `MODEL_SHA256`, and `MODEL_ARTIFACT` (the cache/embed filename, `bge-small-en-v1.5-q8_0.gguf`) — live in a new leaf module `src/modules/embedding/model_pin.ts` with NO imports of its own. They are deliberately NOT homed in `setup.ts`: `setup.ts` transitively imports the `@inflexa-ai/harness` package (via `local-provider.ts`), so `scripts/build.ts` importing the pin from `setup.ts` would evaluate the entire interactive-setup graph (@clack, the harness runtime) inside the build script, for the sake of three constants. A leaf module keeps the build's dependency footprint to the constants alone. `setup.ts` imports the pin from `model_pin.ts` (no re-export — the repo forbids re-exports); `scripts/build.ts` imports all three for its `ensureModelCached()`. Either way it is one hash source shared by build-time and runtime verification, the same sharing `LLAMA_PINS` already does. The string-literal import specifier in `embeddedModelPath()` must be edited in lockstep on a pin bump (Bun embeds only statically-known paths); the pin module's JSDoc carries that lockstep note, mirroring `LLAMA_RUNTIME_TAG`'s.

**D6 — The sweep's keep-set is "current llama artifacts + current model artifact".** `sweepLlamaCache()` currently deletes anything not in `LLAMA_PINS` — which would delete the model on every build. Widening the keep-set preserves the sweep's purpose for the model too: after a model pin bump, the superseded GGUF is removed before compiling, so a stale import literal fails the build loudly instead of silently embedding the old model.

**D7 — Fetch the model once per build, before the target loop.** Unlike the per-target runtime archives, the model is target-independent; `ensureModelCached()` runs once beside `sweepLlamaCache()`, not inside the loop.

**D8 — Install-context-aware user copy.** The mode-picker label ("downloads a ~36 MB model + runtime") and the acquisition spinner text say "download … from HuggingFace" — wrong and alarming for the proxy-restricted compiled-binary user this change exists for. Both pick their wording via `isCompiledBinary()` (compiled: "installs the bundled ~36 MB model"; source: today's copy).

**D9 — Preselected embeddings run before the container-runtime gate; the interactive flow is untouched.** `inflexa setup` gates on a ready container runtime early — `firstReadyRuntime` runs before `intro` (`src/modules/infra/setup.ts`) — and the embedding step lives deep inside that gated flow (the lazy `runEmbeddingSetup(...)` call). The audience this whole change exists for — egress-restricted / air-gapped users, now that the model is a build-time embedded asset — may have no container runtime at all, so `setup --embeddings local` is unreachable for exactly them. Decision: when `options.embeddings` is an explicit preselection (`--embeddings local|api-key|off`), `setup()` runs the embedding step BEFORE the runtime probe, then continues into the rest of setup unchanged — a missing runtime still errors and exits 1 afterward (the remainder genuinely needs one), but the user's embeddings are already durably configured to disk by then. The step must not run twice: the preselected pre-gate run is remembered so the later in-flow embedding step is skipped in the same invocation. The interactive no-preselection flow is untouched — the embedding question stays after provider auth, because the local-embeddings spec ("Embedding setup is wired into the interactive setup flow") requires "an embedding-mode question after provider auth".

Rejected — hoisting the embedding step unconditionally: it would move the interactive question ahead of provider auth, breaking the spec'd interactive question order. Rejected — a standalone `inflexa embeddings` command: a whole new CLI surface for one flag's worth of behavior, and `setup --embeddings` is already the remediation string the launch gate and the docs point users to; a second command would fork that guidance.

Rationale: (1) the air-gapped audience is the reason this change exists, so the one remediation string we advertise must work for them without a runtime; (2) the interactive order is spec-bound and cannot be reordered; (3) exit-code honesty — the remainder of setup genuinely needs a runtime, so still exiting 1 on a missing one is correct, while the embedding outcome is separately durable and separately narrated. This scopes the reorder to the local-embeddings capability only: the container-runtime "Setup falls back to any ready runtime" requirement is honored unchanged (setup still fails when no runtime is ready; the runtime is still pinned before any container work — a non-container step moving ahead of the probe is not something that requirement constrains), so no container-runtime spec delta is warranted.

## Risks / Trade-offs

- [Release binaries grow ~36 MB per target] → Accepted in the proposal; the smoke test already catches a binary that compiles but cannot start with its embedded assets.
- [HuggingFace outage or throttling breaks release builds] → Same exposure class as the existing GitHub-releases fetch for the runtime; the URL pins an immutable revision (not `main`), `.llama-cache/` makes it once-per-machine, and the failure is loud, never a silently different artifact.
- [Model pin bump forgets one of the lockstep sites (pin constants vs import literal)] → The sweep removes the superseded file, turning the mismatch into an import-resolution build failure — the same protection the runtime relies on (D6).
- [Embedded copy doubles peak memory briefly (~36 MB bytes in RAM)] → One-shot at setup time, immediately released; the runtime's archive copy already does the same.
- [Preselected embeddings succeed but setup still exits 1 on a missing runtime → user confusion (D9)] → The runtime error already carries its own remediation, and the embedding step narrates its own success (acquisition spinner + `embedding.mode = "local"` written) BEFORE the probe runs, so the user sees "embeddings configured" and then the distinct runtime error — two separately legible outcomes, not one ambiguous failure.

## Migration Plan

No data or config migration. The next release's binaries simply carry the model; existing binaries keep downloading as before. From-source checkouts are unaffected. Rollback is reverting the build-script/setup changes — the download path remains intact underneath.

## Open Questions

None.
