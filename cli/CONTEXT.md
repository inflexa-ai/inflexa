# Inflexa CLI — context

The local-first host for the Inflexa product, and the **embedder** of `@inflexa-ai/harness`: it owns everything host-specific and wires the harness's capability seams to trivial local realizations. Detailed structure, the event-bus contract, and the TUI/opentui rules live in [`CLAUDE.md`](./CLAUDE.md); this file is the domain map.

## Role

`cli/` runs entirely on the user's machine. It presents the terminal UI, persists state to a local SQLite database, authenticates the user, manages the local model proxy, and invokes `harness` to plan and execute analyses inside the Docker sandbox. The harness stays host-agnostic; the CLI supplies the local seam realizations (local auth, filesystem artifact registry, no-op billing).

## Feature slices (`src/modules/<domain>/`)

Code is grouped by feature, not by layer — a module owns its logic, its text command actions, and its logic-local types.

- **`auth/`** — Auth0 device flow + `login` / `logout` / `whoami`. Config seeded from `.env` (`INFLEXA_AUTH0_*`).
- **`proxy/`** — the CLIProxyAPI model helpers (`models.ts`: client key discovery + default-model election — deterministic recency rank walked against the unbilled `count_tokens` accessibility check); the container lifecycle/provisioning lives in `infra/`.
- **`analysis/`** — analysis lifecycle + the `sessions` command (live launch-identity rows; message history is frozen legacy data).
- **`anchor/`** — invisible folder-identity markers (`.inflexa/id`) and lazy path reconciliation.
- **`harness/`** — the harness embedder: boots the harness runtime (DBOS, sandbox, providers) and drives the chat turn, the model-free `run --plan` replay engine, data profiling, and the provenance bridge.
- **`embedding/`** — config-driven embedding-provider resolution + the in-process bge-small local model (download, verify, lifecycle).
- **`infra/`** — the container stack: `setup` / `up` / `down` provisioning CLIProxyAPI + Postgres/pgvector via a generated Docker Compose file.
- **`libs/`** — the published sandbox image variants (GHCR refs) + the `sandbox pull` / `status` actions.
- **`project/`** — project CRUD command actions (`project new` / `project ls`).
- **`prov/`** — the provenance recorder: a bus subscriber that builds, signs, and persists each analysis's PROV document, plus `prov export` / `prov verify`.
- **`staging/`** — stages analysis input files under the analysis workspace's `data/` root with content hashes into the harness-compatible `StagedInput` manifest.

## Shared infrastructure

- **`src/db/`** — the SQLite layer (connection, migrations, verb-split query/mutation, errors). The store is a file on the user's machine and may legitimately desync from on-disk markers — a miss heals or degrades, it never hard-fails.
- **`src/tui/`** — the presentation layer: the Solid + opentui chat app, the keymap engine, the design system, and shared widgets. Presentation depends on logic; modules never import `tui/`.
- **`src/lib/`** — non-domain infrastructure (`env`, `config`, `bus`, `log`, `otel`, `design_system`).
- **`src/types/`** — shared persisted-entity shapes and the typed event contract.

See [`CLAUDE.md`](./CLAUDE.md) for the full project structure and coding conventions, and [`HORRIBLE_BUG_FIXES.md`](./HORRIBLE_BUG_FIXES.md) for postmortems to read before working in those areas.
