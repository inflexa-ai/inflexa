## Why

Dev and production builds namespace their container/network names (`inflexa-dev-*` vs `inflexa-*`) but share everything those containers bind: host ports 8317/8432, the CLIProxyAPI config + provider-credential dir, the Postgres data dir, and the generated compose file. On a dual-build machine (every developer) the stacks fight — the port loser's containers sit dead in `Created`, whichever build runs last rewrites the shared compose file and `config.yaml` (401-ing the other build's client key), and two proxies sharing one rotating OAuth refresh-token credential can trip provider reuse-detection and kill the grant, resurrecting the forced re-login symptom the launch-gate fix removed. Two aggravators keep this recurring: both images float (`eceasy/cli-proxy-api:latest`; `pgvector/pgvector:pg18` also moves), so upstream pushes silently change behavior the launch gate is calibrated against; and setup freezes the *accepted default* Postgres port into the channel-shared `config.json`, which would override a channel-aware default on every existing machine.

## What Changes

- The entire stack identity becomes environment-aware: dev gets its own host ports (proxy 8318, postgres default 8433), compose file, CLIProxyAPI config + credential dir, and Postgres data dir. Production paths and ports are byte-for-byte unchanged. One-time dev cost: sign in once into the new dev credential dir; dev Postgres starts fresh.
- Both images are pinned by version tag AND manifest digest: `eceasy/cli-proxy-api:v7.2.90@sha256:6aa1ffb6…` and `pgvector/pgvector:0.8.5-pg18@sha256:12a379b4…` (current latest as of 2026-07-19). Bumps become deliberate one-line diffs; a republished tag cannot slip through the digest.
- The launch-gate calibration points (the `auth_unavailable` 503 body, the `/v1/models` registration window and client-key-only 401, the `count_tokens` `not_found_error` body) are re-verified against v7.2.90 — they were verified on v7.2.77 — as part of this change, and the pin site documents that re-verification as the bump procedure.
- Setup persists only explicit Postgres choices: a prompted value equal to its (channel-aware) default writes nothing to `config.json`, and a re-run that accepts defaults heals a previously frozen one. Explicitly customized values keep winning, per the existing per-field override contract.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `postgres-provisioning`: the compose requirement gains the tag+digest image pins (both services); "Container names are environment-aware" widens to the full stack identity (ports, compose file, mount sources); "Setup prompts for Postgres credentials and port" gains the persist-only-explicit rule.

## Impact

- `cli/src/lib/env.ts` — channel-aware ports and the four stack paths (pure helpers beside `isDevelopmentBuild`).
- `cli/src/lib/config.ts` — the Postgres port default resolves from the channel-aware value.
- `cli/src/modules/infra/compose.ts` — both image pins; compose generation already reads `env`.
- `cli/src/modules/infra/setup.ts` — the postgres-prompt persistence rule.
- Tests across `lib/` and `infra/` asserting ports, paths, images, and persistence.
- No new dependencies. No prod-visible behavior change beyond the postgres image moving from floating `pg18` to the pinned equivalent.
