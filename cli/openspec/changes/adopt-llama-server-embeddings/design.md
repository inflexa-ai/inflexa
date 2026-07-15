## Context

Local embeddings run bge-small-en-v1.5 (GGUF q8_0, 384-dim, CLS pooling baked into the model metadata, 512-token context) on the user's machine. The current realization, `node-llama-cpp`, cannot exist inside the compiled single-file binary: its native addon family is `external` to the build, its JS reads files relative to its own package dir at import time (crashes under `/$bunfs`), and upstream explicitly requires "original file structure" deployment. All findings below are from primary-source research with empirical probes on this machine (July 2026).

Verified facts the design rests on:
- `ggml-org/llama.cpp` publishes prebuilt archives per release tag (`b<build>`), ~10 MB compressed / ~26 MB unpacked for macOS arm64, containing `llama-server` plus its `@rpath` dylibs — the archive dir must ship together. No `llama-embedding` tool is shipped; the server is the embedding surface. Upstream publishes **no checksums**, and releases land many times per day with no stability channel.
- `llama-server --embeddings` serves OpenAI-compatible `/v1/embeddings`; for our GGUF it read CLS pooling from the model automatically and returned L2-normalized 384-dim vectors (norm 1.000000 measured). Loopback is the default host; `--api-key` yields 401 on bad keys; warm start to `/health` 200 in 0.16 s; 86 MB RSS; SIGTERM exits 0 in <10 ms. Inputs over 512 tokens return HTTP 500 — the client must guard.
- Post-2026-05-29 upstream macOS arm64 builds carry `minos 26.0` and refuse to load on macOS 14/15 (empirically hit); b9310-era builds (`minos 14.0`) run fine on macOS 14.
- Bun compiled binaries embed assets byte-exactly with zero startup/memory cost until read (lazily mmapped segment); per-target assets work via define-gated dynamic imports (a static `with { type: "file" }` import always embeds); nothing native can read `/$bunfs`, and extraction must use `Bun.write`/`readFileSync` (fd-based APIs ENOENT on bunfs).
- CLI-initiated downloads (verified with Bun `fetch`) never receive `com.apple.quarantine`, so Gatekeeper does not assess the sidecar; llama.cpp binaries are ad-hoc signed only, which is irrelevant on the no-quarantine path.
- The harness already exports `createEmbeddingProvider({ baseURL, token, model, dimensions, resolveBilling })` — an OpenAI-shaped client the `api-key` mode uses today; a loopback sidecar is just another `baseURL`.

## Goals / Non-Goals

**Goals:**
- Local embeddings work identically in the compiled binary and from source — one stack, no capability gap between install contexts.
- Remove `node-llama-cpp` and every accommodation it required (postinstall trust, optional-dependency handling, compiled-context refusals).
- Runtime acquisition is deterministic and verifiable: exact pinned tag, vendored SHA-256s, atomic materialization; the container-era lesson applies — never let a failed/partial acquisition wedge a later run.
- The sidecar is invisible when unused: nothing spawns unless local mode actually embeds, and shutdown never leaks the process.

**Non-Goals:**
- Baking the GGUF into the binary (B-full). The model download works, is resumable, and is the stable half of the pipeline; promoting it to an embedded asset later is a one-asset addition to the same materialization seam. Recorded as the follow-up if an offline-first story is wanted.
- GPU tuning/back-end selection beyond what the pinned default build ships (Metal on macOS arm64 works out of the box; measured numbers are already far better than needed).
- Coercing `node-llama-cpp` into the binary via an extracted npm tree — proven possible on macOS, but rejected: ~119-package (~75 MB) closure to version-lock, a global build-flag change (`--compile-autoload-package-json`), and an unresolved self-fork hazard on Linux/Windows (the library forks `process.execPath`, which re-runs this CLI).
- WASM inference — the credible candidate (wllama) ships a browser-only bundle that fails under Bun.

## Decisions

**1. The sidecar realizes local mode through the existing harness provider — no new wire code.**
Local mode = materialize runtime → spawn `llama-server -m <gguf> --embeddings --host 127.0.0.1 --port <free> --api-key <minted>` → poll `/health` → hand the harness `createEmbeddingProvider` a loopback `baseURL`, the minted key, and `dimensions: 384` → SIGTERM via the shutdown hook. The HTTP boundary insulates the product from llama.cpp's daily C-ABI churn, and the provider path is the same one `api-key` mode already exercises. *Alternative rejected:* a bespoke client for the native `/embeddings` endpoint — more code for no capability we need.

**2. Runtime bytes: embedded asset in compiled builds, pinned download from source; one materialization seam.**
`scripts/build.ts` fetches the pinned per-target archive at build time (hash-checked, cached) and embeds it via a define-gated dynamic import so each target carries exactly its own (~10 MB). At first use, compiled binaries extract the embedded archive; source runs download the identical artifact. Both paths converge on one materialize step: verify SHA-256 → extract to a temp dir → atomic rename to `<dataDir>/inflexa/llama-server/<tag>/`. The tag-named directory makes pin bumps self-cleaning upgrades (new tag → new dir; old dirs sweepable). `install_context.ts` selects the byte source — it stops gating the feature and starts routing acquisition.

**3. Pin an exact tag per platform with vendored SHA-256s; macOS arm64 pins a macOS 14-compatible build.**
Upstream ships no checksums and no stable channel, and its current macOS builds require macOS 26. The pin (tag + per-platform SHA-256 + artifact name) lives in one constants module with the rationale inline; bumping it is a deliberate, reviewed act. The subprocess/HTTP boundary means a stale-but-working pin costs nothing.

**4. Sidecar lifecycle: lazy spawn, per-process reuse, guaranteed reap.**
The provider spawns the server on first `embed()`, reuses it for the process lifetime, and registers SIGTERM cleanup with the existing shutdown plumbing. Port comes from an ephemeral allocation; the minted API key means a stray same-port process can never be mistaken for ours (readiness probe authenticates). Startup budget: warm 0.16 s measured; the very first spawn on macOS pays a one-time OS malware-scan delay (~10 s measured) — the readiness timeout accommodates it and the setup-time verification (which runs the same path) absorbs it away from the hot path.

**5. The 512-token ceiling is enforced client-side.**
The server 500s on over-long inputs. The provider truncates/chunks before sending (the in-process runtime had the same model limit — this makes the guard explicit instead of accidental). Verification of what the harness actually sends happens during implementation; the guard is provider-owned either way.

**6. Setup verification runs through the sidecar.**
`verifyModel` (download integrity + 384-dim assert) becomes: materialize runtime, spawn, probe-embed, assert dimension, shut down. Identical compiled and from source — the class of "works in dev, dead in the binary" divergence this change exists to kill.

## Risks / Trade-offs

- [Upstream deletes or re-cuts a pinned release] → Vendored hashes fail loudly, never silently; compiled binaries are immune (asset baked at build time); the pin is bumpable in one place. Mirroring the archive to our own release storage is a cheap later hardening.
- [Sidecar process leaks on crash] → Shutdown-hook + SIGTERM covers normal exits; the spawn uses a process-group/`killSignal` arrangement so an abnormal parent death doesn't orphan the server; the reaper pattern from the sandbox subsystem is the fallback if leaks are observed.
- [Port conflicts on busy machines] → Ephemeral port allocation + authenticated readiness probe; a conflict is a retry, not a failure.
- [Linux glibc floor from upstream's ubuntu-24.04 runners] → Matches the product's existing glibc posture (build.ts already ships glibc-only); musl users are already out of scope.
- [First-run 10 s macOS scan delay surprises users] → Paid once at setup-time verification with a spinner, not mid-analysis.
- [Binary +~10 MB per target] → Accepted; measured startup/memory cost is zero until read.

## Migration Plan

Config is unchanged (`embedding.mode = "local"` + `modelPath` keep working; the runtime dir is derived, never persisted). Existing local-mode users get the sidecar transparently on their next embed; the GGUF they already downloaded is reused. `node-llama-cpp` removal only affects source checkouts (`bun install` gets lighter by ~13 packages and every platform binary). Rollback is a revert — no persisted state depends on the new runtime.

## Open Questions

None blocking. (Implementation verifies what chunk sizes the harness actually sends before choosing truncate-vs-chunk for over-length inputs.)
