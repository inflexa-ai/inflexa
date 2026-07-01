## Context

The CLI today has exactly one containerized dependency, CLIProxyAPI, provisioned by `inflexa setup` (`cli/src/modules/proxy/setup.ts`). The setup flow assumes Docker or Podman — `ensureReady(rt)` at `setup.ts:46` aborts the entire flow when the runtime is not installed and ready, and the entire `lib/container.ts` execution wrapper exists precisely to abstract `docker` vs `podman` behind one binary-agnostic surface.

The harness — the next integration target (`docs/harness_integration/`) — requires Postgres + pgvector + DBOS as its durable substrate. Three earlier research docs (`07-postgres-dbos-constraint.md`, `08-postgres-shipping.md`, `09-postgres-options-deep-research.md`) evaluated shipping Postgres alongside the CLI binary and converged on a tiered strategy favoring an embedded binary. This design rejects that path: the CLI's container-runtime prerequisite already makes a second container cheaper and lower-risk than any embedded-binary option, and it eliminates a non-trivial new npm dependency and its maintenance tail.

The first iteration of this change surfaced a critical networking bug: the proxy and Postgres containers run on separate Docker networks, so the proxy's `localhost:8432` resolves to its own loopback, not the host's. This — plus the growing complexity of managing two independent `docker run` calls — motivates the move to Docker Compose (or Podman Compose), which puts both services on a shared network with DNS-based service discovery.

Additionally, the first iteration's `modules/proxy/` module name became misleading once it orchestrated two services, and the setup command ran silently through Postgres provisioning with no user interaction or progress feedback. This revision addresses all three issues.

Constraints inherited from the codebase that this design honors:
- **`neverthrow` `Result`-first** — every fallible function in the new module returns `Result` (no `throw` except exhaustive-switch defaults).
- **No-new-deps without approval** (`cli/CLAUDE.md`) — `pg`, `dockerode`, and any embedded-postgres package would each require sign-off; this design needs none of them. `@clack/prompts` is already a dependency.
- **Feature-slice layout** — the new code lives in `cli/src/modules/postgres/`, not `lib/`. The setup orchestrator moves from `modules/proxy/` to `modules/infra/` (reflecting its multi-service scope). `lib/container.ts` is reused rather than copied.
- **Single bus, typed events** — this change adds no bus events.
- **Subprocess spawn mechanics** — every container invocation goes through `lib/container.ts`'s `capture`/`inherit`.
- **`@clack/prompts` for text commands** — the interactive prompts use the existing `lib/cli.ts` prompt layer, never the opentui TUI.

## Goals / Non-Goals

**Goals:**
- Postgres + pgvector reachable after `inflexa setup`, with no new npm dependencies.
- Both containers on a shared Docker Compose network so inter-container communication works via service names.
- Interactive prompts for Postgres username, password, and port during setup (with sensible defaults).
- Clear progress feedback at every provisioning step — no silent waits.
- Mirror the existing proxy module's shape so future maintainers see one consistent container-provisioning pattern.
- Sensible, single-source defaults (`inflexa`/`inflexa`/`inflexa`/`8432`/`pgvector/pgvector:pg18`), connection fields overridable through `config.json` and the settings TUI.
- Rename `modules/proxy/` → `modules/infra/` to reflect the multi-service scope.
- Persist a `PoolConfig`-shaped connection record in config so the future harness-wiring change reads it without translation.
- Fast-fail `inflexa setup` when pgvector is missing from the image.

**Non-Goals:**
- Calling `assembleCoreRuntime()` from the harness — that is the next change and depends on this one.
- Materializing a `pg.Pool` in the CLI — the CLI stays SQLite-only.
- Importing or aliasing harness internals.
- Postgres binary downloads, embedded builds, PGlite, `@boomship` — superseded.
- Bring-your-own-Postgres / external mode — removed; always provisions its own container.
- User-overridable image ref — always `pgvector/pgvector:pg18`.
- An `inflexa postgres` subcommand with start/stop/reset verbs.

## Decisions

### Decision 1: Docker Compose for multi-container orchestration

**Choice:** Generate a `docker-compose.yml` (or `podman-compose.yml`) in the CLI's data dir that defines both `inflexa-cliproxy` and `inflexa-postgres` services on a shared `inflexa` network. All lifecycle operations (`up`, `down`, `pull`) go through `{runtime} compose` rather than individual `{runtime} run` calls.

**Rationale:** The first iteration revealed a networking bug: two independently `docker run`'d containers can't see each other via `localhost`. Compose creates a shared network with DNS-based service discovery (the proxy reaches Postgres at `inflexa-postgres:5432`, not `localhost:8432`). Compose also gives:
- One `compose up -d` to start everything, one `compose down` to stop everything.
- A declarative file the user can inspect (`~/.local/share/inflexa/docker-compose.yml`).
- Consistent behavior across Docker and Podman (both support `compose`).
- The `--restart unless-stopped` policy lives in the compose file, not scattered across `docker run` flags.

**Alternatives considered:**
- **`--network` flag on individual `docker run` calls.** Requires creating the network manually, tracking its lifecycle, and passing `--network` to every command. More fragile than compose.
- **Host networking mode.** `docker run --network=host` makes `localhost` work but drops port isolation and doesn't work on macOS Docker Desktop (which runs containers in a Linux VM).

### Decision 2: Rename `modules/proxy/` → `modules/infra/`

**Choice:** Rename the module that hosts the `inflexa setup` orchestrator from `proxy` to `infra`. The orchestrator function stays `setup()`. Proxy-specific container plumbing (image ref, auth, config file generation) moves with it since it's all one setup flow.

**Rationale:** The module now manages two services (proxy + Postgres) and will likely manage more in the future (sandbox images, etc.). The name `proxy` is misleading; `infra` describes the module's actual scope — all CLI infrastructure provisioning. The command remains `inflexa setup`; only the internal module name changes.

**Alternatives considered:**
- **`modules/setup/`** — matches the command name but conflates the action (setup) with the domain (infrastructure). `infra` is the domain; `setup` is one action within it.
- **Keep `modules/proxy/`** — minimal churn but accumulating technical debt as more services join.

### Decision 3: Interactive prompts for Postgres credentials and port

**Choice:** `inflexa setup` SHALL prompt the user for Postgres username (default `inflexa`), password (default `inflexa`), and port (default `8432`) using `@clack/prompts` (the existing text-command prompt layer in `lib/cli.ts`). The prompted values are persisted to `config.json` under the `postgres` key. On non-interactive terminals, the defaults are used silently.

**Rationale:** The user explicitly requested interactive prompts ("it should ask me for username and password, and eventually the port"). The proxy's own auth step already prompts interactively (provider chooser at `setup.ts:356`), so prompting for Postgres config is a natural extension of the same flow. `@clack/prompts` is already a dependency; the `promptText` helper in `lib/cli.ts` handles TTY detection and validation.

**Alternatives considered:**
- **Plain `readline` (like `chooseProvider`).** Functional but less polished; no validation, no consistent styling with the rest of the CLI's prompts.
- **Skip prompts; always use defaults.** The first iteration did this and the user rejected it ("it didn't ask me for anything").
- **`--username` / `--password` / `--port` flags only.** No interactive fallback; worse UX for the common case.

### Decision 4: Drop external mode and image override

**Choice:** Remove `postgres.mode` (always `"docker"`) and `postgres.image` (always `pgvector/pgvector:pg18`) from the config schema. The CLI always provisions its own Postgres container.

**Rationale:** The user explicitly requested this ("I don't think we should allow the user to use external DB. We should use pg 18"). Dropping external mode eliminates: the TCP probe code, the psql-on-PATH code path, the mode radio in the settings TUI, and a class of support issues where a user-supplied Postgres doesn't have pgvector or has the wrong PG version. The image is locked to the same version the harness tests against (`pgvector/pgvector:pg18`).

**Alternatives considered:**
- **Keep external mode as an advanced escape hatch.** Adds complexity for a user base that doesn't exist yet. Can be re-added later if needed.
- **Keep image override for pinning.** The user can still override the image by editing the generated compose file directly (power-user path). The config key is unnecessary complexity.

### Decision 5: Container-alongside-proxy, not an embedded binary

**Choice:** Provision `pgvector/pgvector:pg18` as a second service in the Docker Compose stack, alongside CLIProxyAPI.

**Rationale:** The `ensureReady(rt)` gate already aborts `inflexa setup` when the runtime is unusable. Adding a second container costs nothing the user isn't already paying. The embedded-binary options (PGlite, `@boomship/postgres-vector-embedded`, `embedded-postgres`) all have showstopper issues — documented in the prior research docs and rejected.

**Alternatives considered:** (See original design — Decision 1.)

### Decision 6: Reuse `lib/container.ts` verbatim

**Choice:** Every `docker`/`podman` invocation in the postgres and compose modules goes through `capture(rt, args)`/`inherit(rt, args)`/`ensureReady(rt)`. Compose commands are just `capture(rt, ["compose", "-f", composeFilePath, "up", "-d"])`.

**Rationale:** The `container-runtime` spec is explicit: "No module outside the wrapper SHALL reference a container binary name directly." Compose subcommands work through the same binary (`docker compose` / `podman compose`).

### Decision 7: Always-running lifecycle, no shutdown stop

**Choice:** The containers are `restart: unless-stopped` in the compose file and outlive every CLI session. No hook in `lib/shutdown.ts` stops them.

**Rationale:** Matches the existing proxy behavior users already know. Re-launch is instant.

### Decision 8: Default port `8432`, not `5432` or `5433`

**Choice:** Default host-published port `8432`. Overridable via `config.json` and the setup prompt.

**Rationale:** The standard `5432` collides with a user's own Postgres. `5433` is in use by the harness's own testcontainer. `8432` is unambiguously inflexa-owned.

### Decision 9: Image major version `pg18` — fixed, not user-overridable

**Choice:** Default image `pgvector/pgvector:pg18`, NOT user-overridable via config.

**Rationale:** The harness's own test rig uses `pgvector/pgvector:pg18`. Locking the image prevents a user from picking a non-pgvector image and hitting a cryptic vector extension error. Power users who need a different image can edit the generated compose file directly.

### Decision 10: Config is the single source of truth for the connection

**Choice:** All connection fields live under `config.json`'s optional `postgres` object. The CLI does not introduce `DATABASE_URL`/`DB_PG_*` env reading.

**Rationale:** (Same as original — one source, no silent env overrides.)

### Decision 11: Smoke check via `docker exec psql`, not a `pg` client

**Choice:** After `pg_isready` succeeds, run `CREATE EXTENSION IF NOT EXISTS vector` via `docker exec inflexa-postgres psql`. No `pg` npm dep.

**Rationale:** (Same as original — the CLI stays SQLite-only.)

### Decision 12: Self-healing launch gate — best UX over check-and-fail

**Choice:** The launch-time Postgres gate SHALL self-heal the substrate. When `inflexa-postgres` is missing, the gate transparently generates the compose file (if needed), runs `compose up -d`, waits for `pg_isready`, and runs the pgvector self-install.

**Rationale:** (Same as original — first `inflexa` invocation is a complete path to a working substrate.)

### Decision 13: All settings fields visible, unmasked, and editable

**Choice:** The settings TUI renders `host`, `port`, `database`, `user`, `password` — all in clear text, all editable. No masking, no greying out. No `mode` or `image` fields (removed per Decision 4).

**Rationale:** inflexa is a local-first tool; every value is the user's own data on their own machine. The password is a credential for a Postgres published to `localhost` — masking it from the user who owns it would be security theater.

### Decision 14: Progress feedback at every step

**Choice:** Every provisioning step surfaces a clear progress message before it begins, using `@clack/prompts` spinners (via `spinner()` from `@clack/prompts`) during setup and plain `console.log` during the launch-time gate (where the TUI isn't up yet).

**Rationale:** The first iteration ran silently during image pull and container start, leaving the user with no feedback. The user explicitly flagged this ("it isn't very responsive … the user has no feedback").

## Risks / Trade-offs

- **[Risk] Docker Compose may not be installed.** → Docker Desktop bundles `docker compose` (the V2 plugin) since 2022. Standalone Docker Engine users may need to install `docker-compose-plugin`. The readiness gate checks for `compose` availability and surfaces an actionable error.
- **[Risk] Podman Compose compatibility.** → Podman Compose (`podman-compose`) is a separate package. The CLI checks for it alongside Podman and surfaces an actionable install message when missing.
- **[Risk] Two `--restart unless-stopped` containers running indefinitely.** → Acceptable: matches the proxy today. `docker compose -f <path> down` stops everything cleanly.
- **[Risk] Generated compose file could be stale.** → The compose file is regenerated on every `inflexa setup` run (idempotent). The launch-time gate checks that the file exists and contains the expected services.
- **[Risk] Module rename `proxy/` → `infra/` creates import churn.** → One-time churn, all importers updated in the same commit. The rename is justified by the module's new multi-service scope.
- **[Trade-off] No external-mode escape hatch.** → Accepted per user directive. Can be re-added later if a use case emerges.
- **[Trade-off] No image override.** → Accepted per user directive. Power users edit the compose file directly.

## Migration Plan

This is a net-new capability — there is no prior Postgres provisioning in the CLI to migrate from. The `modules/proxy/` → `modules/infra/` rename is mechanical (all importers updated). The deploy sequence:

1. Land the renamed `modules/infra/`, new `modules/postgres/`, config additions, env additions, compose generation, and settings section.
2. Existing users on a previous CLI build who never run `inflexa setup` again: their next `inflexa` invocation that reaches a harness-integrating code path will provision it transparently via the self-healing gate.
3. Users upgrading who already have a system Postgres on `localhost:5432` are unaffected — the CLI defaults to `8432`.
4. Rollback: `docker compose -f <composeFilePath> down`; remove the optional `postgres` key from `config.json`. The data dir at `<data>/inflexa/postgres/` can be left or removed.

## Open Questions

(None.)
