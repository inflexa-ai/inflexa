## Context

`env.ts` derives every stack path from `join(dataDir(), "inflexa", …)` and fixes `cliproxyPort = 8317` / `postgresPort = 8432` with no channel awareness; `compose.ts` namespaces only container/network names by `env.isDevelopment`. The shared mutable surface is exactly: the two host ports, `inflexa/cliproxy/{config.yaml,auth}`, `inflexa/postgres`, and `inflexa/docker-compose.yml`. Images: `eceasy/cli-proxy-api:latest` (floating) and `pgvector/pgvector:pg18` (floating within PG 18). Setup's `promptPostgresConfig` persists the full resolved connection into `config.json` — including values the user merely accepted — and `config.json` is shared by both channels. The launch gate merged in `fix-launch-gate-spurious-relogin` is calibrated against fork behaviors verified on v7.2.77.

## Goals / Non-Goals

**Goals:**

- Two stacks (one per build channel) run simultaneously with zero shared mutable state.
- Production installs see no path/port change; the only prod-visible diff is the postgres image pin.
- Image versions change only via a reviewed one-line diff; a republished tag cannot slip through.
- `config.json` never freezes a channel default; existing frozen defaults heal on the next setup run.

**Non-Goals:**

- No namespacing of non-stack state (SQLite db, logs, refs, content, locks, config.json/auth.json) — none of it is container-bound, so it has no collision surface; moving it would orphan data for no gain.
- No automatic migration of dev-stack state into the new dev paths — copying the credential would re-create the rotation race; dev signs in once.
- No new config surface: dev port values are fixed constants, postgres port stays overridable (its default becomes channel-aware).

## Decisions

1. **Suffix strategy, prod-invariant.** Dev variants are sibling paths — `cliproxy-dev/`, `postgres-dev/`, `docker-compose.dev.yml` — derived from the same channel signal as container names (`isDevelopmentBuild(bakedEnv.buildChannel)`, never NODE_ENV). Exposed as pure, exported helpers (`stackPorts(channel)`, `stackPaths(dataDirBase, channel)`) beside `isDevelopmentBuild`, because the frozen `env` object cannot be re-driven in a test process — the file's established testability pattern. Alternative rejected: a whole `inflexa-dev/` data tree, which would also orphan dev refs/db/logs that have no collision problem.

2. **Dev ports are fixed siblings: proxy 8318, postgres default 8433.** Deterministic, documented beside the prod constants. 5433 is avoided — the harness testcontainer claims it.

3. **Tag + digest pins for both images.** `image: <name>:<tag>@<sha256>` — the tag names the semantics a reviewer can check release notes against; the digest makes a republished tag inert (the engine resolves by digest when both are present). Current latest pinned: `v7.2.90` (cli-proxy-api) and `0.8.5-pg18` (pgvector). The pin site's comment carries the bump procedure: update tag+digest together, then re-verify the launch-gate calibration points (`auth_unavailable` 503 body shape, `/v1/models` empty-until-registration boot window, client-key-only 401 on `/v1/models`, `count_tokens` `not_found_error` body). This change itself performs that re-verification for v7.2.90, since the calibrations were established on v7.2.77.

4. **Persist-only-explicit for the Postgres prompt.** The persisted `postgres` block is rebuilt from the prompted values keeping only fields that differ from their defaults (host `localhost`, database/user/password constants, port = channel-aware `env.postgresPort`); an all-defaults result removes the block. Rebuilding fresh (never spreading the old block) is what heals a previously frozen default when the user re-accepts the prompt. Trade-off accepted: a user who explicitly typed the value that equals the default loses the pin — semantically a no-op on their own channel, and indistinguishable from the freeze bug being healed. The rule lives in a pure exported helper taking the default port as a parameter (same frozen-env reasoning as decision 1).

5. **No compose-project rename.** The dev compose project stays `inflexa-dev`, so the first `up` after this change recreates the existing dev containers under the new mounts/ports instead of stranding them as orphans.

## Risks / Trade-offs

- [Dev machines re-login + fresh dev Postgres once] → deliberate; the launch gate's missing-credential login handles it inline; prod state untouched at the old paths.
- [v7.2.90 may have changed a calibration point since v7.2.77] → the re-verification task runs against the pinned image before archive; if a shape changed, the launch-gate classifiers are updated in the same change (they degrade to warn-and-proceed on mismatch by design, so even a miss is not a regression to forced logins).
- [Digest pins make bumps two-field edits] → accepted for the republish immunity; the bump procedure comment makes it mechanical.
- [Prod postgres image moves from floating `pg18` to pinned `0.8.5-pg18`] → same major (data-compatible); existing data dirs load unchanged.

## Migration Plan

Code-only. Prod: next launch pulls the pinned images if absent; data and credentials untouched. Dev: next `bun run dev` regenerates the dev compose file at the new path, compose recreates `inflexa-dev-*` with new ports/mounts, the gate prompts one sign-in. Rollback = revert.

## Open Questions

None — port-freeze handling and pin style were decided with the user (persist-only-explicit; tag+digest).
