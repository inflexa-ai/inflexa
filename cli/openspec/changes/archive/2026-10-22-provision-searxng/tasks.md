# Tasks

## 1. The compose service and the image pin

- [x] 1.1 Resolve the current dated SearXNG tag and its manifest digest from the Docker Hub registry (no `latest`), and add `SEARXNG_IMAGE` to `src/modules/infra/compose.ts` with the tag+digest pin and a bump-procedure comment. Verify the pin literal appears in the generated compose file of both modes
- [x] 1.2 Add the SearXNG service to `generateComposeFile` (mode-independent, `container_name: ${PREFIX}-searxng`, shared network, `restart: unless-stopped`, loopback-only published port, read-only settings mount through the new `ComposeHost.searxngSettingsPath`) and add the image to `composePullIfMissing` for both modes and to the `composePull`/`composePullInteractive` error text. Verify the updated `compose.test.ts` snapshots pass and the manifest-coverage test still passes
- [x] 1.3 Add `searxng` to `StackPorts` and `stackPorts` (production 28437, development 28438), add `env.searxngPort` and `env.searxngBaseUrl` on the derived-port pattern (excluded from `envDoc`), and update the bound-port-set comment. Verify the port-table test passes with the new member

## 2. The settings provisioner

- [x] 2.1 Lift the classify/heal helpers of `proxy_config.ts` (`classifyPath`, `tryFs`, and a shared `ensureFileMountSource`) into `src/modules/infra/mount_source.ts` with `proxy_config.ts` as their caller, then write `src/modules/infra/searxng_config.ts`: `writeSearxngSettings()` returns the `InfraStateError` Result, writes the canonical settings (`use_default_settings: true`, `formats: [html, json]`, `limiter: false`, `public_instance: false`, random 32-byte hex `secret_key`) when no file exists, and keeps an existing file untouched. Add the channel-aware `searxngSettingsPath` to `stackPaths` (`searxng/` / `searxng-dev/`). Verify tests cover: first write (key present, not `ultrasecretkey`), a second run keeps the key byte-identical, the channel paths differ, and the proxy-config tests still pass after the lift
- [x] 2.2 Push the `file` mount source for the settings path into `mountManifest` in every mode, through `ComposeHost`. Verify the manifest-coverage assertions are updated for the new source in every mode (direct mode gains a file source, and a Windows direct-mode host gains a bind mount) and pass

## 3. The harness hand-off

- [x] 3.1 Pass the SearXNG base URL into the conversation deps of the harness runtime at its composition root, beside the knowledge binding. Verify a test of the runtime wiring asserts the URL value reaches the conversation deps, and `bun run format:file` runs on every changed file
- [x] 3.2 Run the full CLI suite, `bun run typecheck`, and `bun run lint` one time, and record the results. The pre-existing environment failure of the farm-parity test (missing Python `packaging` module in the local `python3`) is out of scope
