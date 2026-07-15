## 1. Shared provisioning seam

- [x] 1.1 Relocate `writeProxyConfig` (+ `proxyConfig`, `generateApiKey`) from `modules/infra/setup.ts` into a shared infra module importable by both `setup.ts` and `compose.ts` (setup already imports compose, so the seam cannot import setup back); update all importers and their tests; convert `writeProxyConfig` from throwing to `Result` with typed causes (`io_failed` with cause, `path_occupied` with the offending path).
- [x] 1.2 Build the mount-source manifest in `compose.ts`, derived from the same mode/connection facts that generate the compose file: file-typed sources carry a provisioner (cliproxy `config.yaml` → the relocated `writeProxyConfig`), directory-typed sources are listed for creation (cliproxy `auth`, postgres data dir); the manifest is mode-aware (no proxy entries in direct mode).
- [x] 1.3 Implement the integrity guard at the compose seam and wire it so every `compose up` path passes through it: directory-typed → `mkdir -p`; file-typed absent → run its provisioner; file-typed occupied by an empty directory → `rmdir` then provision (rmdir's cannot-delete-non-empty property is the safety guarantee); occupied by anything else → typed error naming the path, what belongs there, and the remediation — never delete.

## 2. Entry points

- [x] 2.1 `inflexa up` (`lifecycle.ts`): route through the guarded seam so cliproxy mode gets the proxy config written before the engine is invoked and direct mode provisions nothing extra; behavior otherwise unchanged.
- [x] 2.2 `setup.ts` and `ensureProxyReady`: consume the relocated `Result`-returning `writeProxyConfig`; render known causes (e.g. `path_occupied`) as diagnosis + remediation before setup's outer catch, leaving that catch as the backstop for genuinely unknown errors only.
- [x] 2.3 `ensurePostgresReady` (`postgres.ts`): confirm its compose path passes through the guarded seam (no separate guard copy).

## 3. Tests

- [x] 3.1 Damaged-state matrix unit tests at the seam: missing file provisioned; empty directory at the file path healed (removed + file written); non-empty directory preserved with the typed error; missing directories created.
- [x] 3.2 Manifest-coverage test: every bind-mount source in the generated compose file (both connection modes) appears in the integrity manifest for that mode.
- [x] 3.3 Idempotence tests: second `writeProxyConfig` run reports the existing config without rewriting it; re-running the guard on healthy state changes nothing.
- [x] 3.4 Ordering test for `up`-before-`setup` (engine spawn stubbed): in cliproxy mode the proxy config file exists before the compose command is issued, and no directory is ever created at the config file's path.

## 4. Install-context-aware embeddings

- [x] 4.1 Bake a compiled-context constant into the binary via `scripts/build.ts`'s existing `define` mechanism and expose it through a single `lib/` accessor (dev/from-source runs resolve to not-compiled); no call site sniffs `import.meta.path` for `/$bunfs`.
- [x] 4.2 Make the embedding-mode offering install-context-aware in `modules/embedding/setup.ts`: in the compiled binary the interactive picker does not offer "Local" and states why (`api-key`/`off` remain); `--embeddings local` fails immediately with the reason and the `api-key` alternative; the GGUF download can never start toward an unavailable mode.
- [x] 4.3 Scope the native-runtime trust step: skip it entirely in the compiled binary; from source, run `bun pm trust node-llama-cpp` with cwd pinned to the CLI package root (derived from the module's own location), never the user's working directory.
- [x] 4.4 Context-appropriate remediation in `ensureEmbedderReady` and `local-provider.ts`'s import-failure error: from source → run `inflexa setup --embeddings local`; compiled → switch to `api-key` or `off` (never a command that cannot succeed).
- [x] 4.5 Tests: compiled context simulated via the accessor — picker omits local with the note, `--embeddings local` fails before download, trust step not spawned, readiness gate and provider errors carry the switch-modes remediation; from-source behavior unchanged (existing tests keep passing).

## 5. Verification

- [x] 5.1 `bun run typecheck`, lint, and `bun run format:file` on touched files; full `bun test src` inside `cli/`.
- [x] 5.2 `openspec validate harden-infra-provisioning`; live reproduction checks: (a) manufacture an empty directory at the proxy config path, run `inflexa setup`, confirm it heals and completes; (b) build the host binary via `scripts/build.ts` and confirm its setup does not offer local mode and `--embeddings local` fails fast with the alternative.
