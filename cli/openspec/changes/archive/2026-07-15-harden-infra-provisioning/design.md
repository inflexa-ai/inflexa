## Context

The compose stack bind-mounts host paths into containers: `cliproxy/config.yaml` (a **file**), `cliproxy/auth` and `postgres/` (**directories**). Container engines create a missing bind-mount source as a *directory* on the host — so any `compose up` that runs before the file-typed source exists manufactures a directory where a file belongs, and every later attempt to write that file dies with `EISDIR`. Today only `ensureProxyReady` (the TUI launch gate) writes the proxy config before composing; `inflexa setup` writes it in cliproxy mode; `inflexa up` composes without it, despite `postgres-provisioning` already declaring `up` "the user-initiated equivalent of the self-healing launch-time gate". `writeProxyConfig` throws raw filesystem errors that surface through setup's `catch` as "Setup failed unexpectedly: Error: EISDIR …" — a dead end no command can heal.

Separately, the shipped CLI is a Bun single-file executable (built by `scripts/build.ts` with `compile:` per platform; the runtime is embedded, users do not need `bun`). `node-llama-cpp` — the local-embeddings native runtime — is deliberately `external` in that build: it is a family of per-platform native packages that cannot be bundled. Inside the compiled binary, `import("node-llama-cpp")` can never resolve (`/$bunfs` has no node_modules), yet setup still offers the "Local" embedding mode: it downloads the 36 MB GGUF and then verification fails unconditionally. The `bun pm trust node-llama-cpp` step (`embedding/setup.ts`) spawns the `bun` CLI against the user's **cwd** — a dev-repo assumption that emits a confusing "No package.json" warning anywhere else, and is the product's only shell-out to a `bun` binary. Local embeddings therefore work only from source today; the compiled binary offers a choice that cannot succeed.

## Goals / Non-Goals

**Goals:**
- No command ordering can wedge the system: every compose entry point provisions/validates its mount sources first, and re-running any command from any partial state converges.
- One shared seam owns mount-source integrity — no per-caller copy-pasted guards.
- Damaged state is healed when provably safe (empty wrong-type entry) and reported with named remediation when not (non-empty entry) — never silently destroyed.
- Expected filesystem failures travel the `Result` channel with typed causes; raw errno text stops reaching users from known-cause states.

**Non-Goals:**
- Shipping the native embedding runtime inside (or alongside) the compiled binary — a real feature effort (per-platform binaries, download/verify/signing) recorded as future work; this change makes the compiled binary *honest* about local mode, not capable of it.
- DB/anchor-marker desync (already governed by the "never hard-fail on desync" rule and `resolveAnchor`).
- The k8s sandbox backend, sandbox image store state, and `inflexa down` (it stops existing containers and creates no mount sources).

## Decisions

**1. Mount-source integrity lives inside the compose seam, not at call sites.**
The guard runs as part of bringing the stack up (`compose.ts`), deriving the mount manifest from the same mode/connection facts that generate the compose file — the one place that knows which sources are files and which are directories. Every caller (`setup`, `up`, launch gates) inherits it automatically. *Alternative rejected:* per-caller guards — that is exactly the drift that let `up` skip the proxy config while `ensureProxyReady` wrote it.

**2. The proxy-config provisioner moves out of `setup.ts` into an infra sibling shared by both.**
`setup.ts` already imports `compose.ts`, so the seam cannot import `setup.ts` back; `writeProxyConfig` (+ `proxyConfig`/`generateApiKey`) relocates to a module both can import. This is the multi-caller threshold that justifies a new file under the repo's single-caller rule.

**3. Heal policy: empty wrong-type entries heal; non-empty entries are inviolable.**
An empty directory at a file-typed source has exactly one known cause (engine manufacture) and zero information content — remove and re-provision. Removal uses `rmdir`, which *cannot* delete a non-empty directory, so the safety property is enforced by the primitive, not by our checks. Anything non-empty produces an actionable error naming the path and the fix; the CLI never `rm -rf`s state it did not just create. Directory-typed sources are simply `mkdir -p`-ed (an engine-manufactured directory there is indistinguishable from correct provisioning).

**4. Filesystem provisioning converts to the `Result` channel with typed causes.**
`writeProxyConfig` and the integrity guard return `Result<…, InfraStateError>` (discriminated union: e.g. `path_occupied` with the offending path, `io_failed` with cause) instead of throwing. Setup's outer `catch` stays as the last-resort backstop for genuinely unknown errors only — known states are consumed and rendered with remediation before it. This also pays down a `throw` site under the repo's neverthrow-first policy.

**5. `up` provisions mode-aware, exactly like the launch gate.**
In cliproxy mode `up` ensures the proxy config exists before composing (the seam does this once Decision 1 lands); in direct mode there is no proxy service or mount, so nothing extra is provisioned. This makes the existing spec sentence true rather than aspirational.

**6. Compiled-context detection is a build-time define read through one accessor.**
`scripts/build.ts` already bakes per-target `define`s; it additionally bakes a compiled-context constant, and one `lib/` accessor exposes it (dev runs default to not-compiled). *Alternative rejected:* sniffing `import.meta.path` for `/$bunfs` at call sites — it works (the incident proves the path shape) but scatters a stringly platform detail (`B:\~BUN\` on Windows) across modules; the define is explicit, testable, and already the build script's idiom.

**7. The compiled binary is honest about local embeddings: unavailable, with alternatives — never a doomed download.**
Where the native runtime cannot resolve, the embedding-mode picker does not offer "Local" (it shows why it is unavailable and offers `api-key`/`off`); an explicit `--embeddings local` fails immediately with the alternative, **before** the 36 MB download; the hot-path readiness gate and the provider's import-failure error direct the user to switch modes, not to a setup command that cannot succeed. *Alternative rejected:* attempting to bundle or fetch the native runtime now — per-platform native shipping is a feature project (see Non-Goals), and honesty removes the wedge today. Explicitly accepted trade-off: local embeddings remain a from-source capability until the runtime ships properly.

**8. The native-runtime trust step is scoped to the from-source context and the package root.**
`bun pm trust node-llama-cpp` only makes sense where a package.json with that dependency exists — the CLI package itself. It runs only when not compiled, with its cwd pinned to the package root (derived from the module's own location), never the user's working directory. This kills the "No package.json was found for <user cwd>" warning even for developers, and removes the product's only dependence on a `bun` binary on PATH.

## Risks / Trade-offs

- [Extra stat/mkdir syscalls on every compose-up path] → Negligible against container startup cost; the guard is a handful of filesystem probes.
- [Relocating `writeProxyConfig` churns imports and tests in `setup.ts`] → Mechanical; existing setup tests pin the config-file format and API-key behavior and will catch regressions.
- [A future mount added to the compose template but not the manifest silently reintroduces the hole] → The manifest and the compose template are generated from the same function/data in `compose.ts`; a task adds a test asserting every bind mount in the generated file appears in the manifest.
- [Healing races a concurrently starting container] → Compose entry points run the guard before invoking the engine; nothing else mounts these paths.
- [Hiding local mode in the compiled binary reads as a feature regression] → It never worked there (verification fails unconditionally today); the picker note names the reason and the from-source/api-key alternatives, and the future-work path is recorded in Non-Goals.
- [A config with `embedding.mode = "local"` reaching a compiled binary (dev config, hand edit)] → The readiness gate and provider errors carry the switch-modes remediation, so the chat path degrades with instructions instead of a resolve error.

## Migration Plan

No persisted-format changes; no migration. Rollback is a straight revert. Users already wedged by a manufactured `config.yaml` directory are healed by the guard on their next `setup`/`up`/launch.

## Open Questions

None blocking.
