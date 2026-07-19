## 1. Environment (`cli/src/lib/env.ts`)

- [x] 1.1 Add pure exported `stackPorts(channel)` (prod 8317/8432, dev 8318/8433) and `stackPaths(dataDirBase, channel)` (prod paths byte-identical to today; dev siblings `cliproxy-dev/`, `postgres-dev/`, `docker-compose.dev.yml`) beside `isDevelopmentBuild`; the frozen `env` derives each once from `bakedEnv.buildChannel`, and `cliproxyBaseUrl`/`cliproxyApiUrl` interpolate the derived port
- [x] 1.2 Document the WHY at the helpers (stack-collision surface; the OAuth rotation hazard of a shared credential dir)

## 2. Compose (`cli/src/modules/infra/compose.ts`)

- [x] 2.1 Pin both images as tag+digest: `eceasy/cli-proxy-api:v7.2.90@sha256:6aa1ffb6…` and `pgvector/pgvector:0.8.5-pg18@sha256:12a379b4…` (full digests from the delta spec), with the bump procedure documented at the pin site (update tag+digest together, re-verify the launch-gate calibration points)

## 3. Config & setup

- [x] 3.1 `resolvePostgresConfig` defaults the port from the channel-aware `env.postgresPort` (config.json override still wins); retire any duplicate non-channel-aware port constant so one source remains
- [x] 3.2 `promptPostgresConfig` persists only explicit choices via a pure exported helper (default port as parameter); an all-defaults connection removes the `postgres` block entirely

## 4. Tests

- [x] 4.1 `stackPorts`/`stackPaths`: dev vs production values; production asserted equal to the historical literals; the four paths never collide across channels
- [x] 4.2 Compose generation: both modes carry the tag+digest images and env-derived ports/mounts; update tests asserting `:latest`, `pg18`, 8317/8432 literals, or shared paths
- [x] 4.3 Persistence rule: all-defaults persists nothing; custom value persists alone; frozen default heals on re-accept

## 5. Calibration re-verify (v7.2.77 → v7.2.90)

- [x] 5.1 Against a live v7.2.90 container: `auth_unavailable` 503 body shape, `/v1/models` empty-until-registration boot window, client-key-only 401 on `/v1/models`, `count_tokens` `not_found_error` body — update the launch-gate classifiers in this change if any shape moved

## 6. Verify

- [x] 6.1 `bun run format:file` on touched files; `bun run typecheck` (own files clean), `bun run lint`, full `bun test` green
- [x] 6.2 Live: dev compose regenerates at the new dev path with 8318/8433 and dev mounts; the production compose file on disk is untouched
