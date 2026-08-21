# Inflexa CLI — context

The local-first host for the Inflexa product, and the **embedder** of
`@inflexa-ai/harness`. It has each host-specific part, and it connects the
capability seams of the harness to simple local realizations. This file is the
domain map. The structure, the event-bus contract, and the TUI and opentui rules
are in [`CLAUDE.md`](./CLAUDE.md).

## Role

`cli/` runs only on the machine of the user. It shows the terminal UI, stores the
state in a local SQLite database, authenticates the user, and manages the local
model proxy. It then uses `harness` to plan an analysis and to run it inside the
Docker sandbox.

The harness stays host-agnostic. The CLI gives the local seam realizations: the
local authentication, the artifact registry on the file system, and the billing
that does nothing.

## Feature slices (`src/modules/<domain>/`)

The code is in groups by feature, not by layer. A module has its logic, its text
command actions, and its logic-local types.

- **`auth/`** — the Auth0 device flow, with `login`, `logout`, and `whoami`. The
  configuration comes from `.env` (`INFLEXA_AUTH0_*`).
- **`proxy/`** — the CLIProxyAPI model helpers. `models.ts` finds the client key
  and elects the default model: it ranks the models by recency, then it tests
  each one against the unbilled `count_tokens` accessibility check. The container
  lifecycle and the provisioning are in `infra/`.
- **`analysis/`** — the analysis lifecycle: the creation, the resolution, and the
  chat-target launcher. The session identity is not here, because a conversation
  is only in the Postgres thread store of the harness.
- **`anchor/`** — the invisible folder-identity markers (`.inflexa/id`) and the
  lazy reconciliation of the paths.
- **`harness/`** — the harness embedder. It boots the harness runtime (DBOS, the
  sandbox, and the providers), and it operates the chat turn, the model-free
  `run --plan` replay engine, the data profiler, and the provenance bridge.
- **`embedding/`** — the resolution of the embedding provider from the
  configuration, and the in-process bge-small local model: the download, the
  check, and the lifecycle.
- **`infra/`** — the container stack. `setup`, `up`, and `down` provision
  CLIProxyAPI and Postgres with pgvector, through a generated Docker Compose
  file.
- **`libs/`** — the package store on the host: the content-addressed pool, the
  per-analysis farms, the acquisition flights with the pending set, the detached
  transfers, and the catalog download. It also carries the references of the two
  images (`sandbox-base`, `sandbox-provisioner`) and the `store` and `sandbox`
  command actions. The vocabulary of the store is in the harness
  [`CONTEXT.md`](../harness/CONTEXT.md).
- **`project/`** — the project CRUD command actions (`project new` and
  `project ls`).
- **`prov/`** — the provenance recorder. It is a bus subscriber that builds,
  signs, and stores the PROV document of each analysis. It also gives
  `prov export` and `prov verify`. The PROV dialect itself — the QName
  derivations, the statements, the crypto primitives, and the sidecar schema —
  comes from `@inflexa-ai/prov-kernel`; the recorder owns only the lifecycle
  around it.
- **`staging/`** — it puts the analysis input files under the `data/` root of the
  analysis workspace. It gives each file a content hash, and it writes the
  `StagedInput` manifest that the harness accepts.

## Shared infrastructure

- **`src/db/`** — the SQLite layer: the connection, the migrations, the
  verb-split query and mutation, and the errors. The store is a file on the
  machine of the user, thus it can go out of agreement with the markers on disk.
  A miss recovers or it degrades. It never fails hard.
- **`src/tui/`** — the presentation layer: the Solid and opentui chat app, the
  keymap engine, the design system, and the shared widgets. The presentation
  depends on the logic, but a module never imports `tui/`.
- **`src/lib/`** — non-domain infrastructure (`env`, `config`, `bus`, `log`,
  `otel`, `design_system`).
- **`src/types/`** — the shared shapes of the persisted entities, and the typed
  event contract.

Refer to [`CLAUDE.md`](./CLAUDE.md) for the full project structure and the coding
conventions. Refer to [`HORRIBLE_BUG_FIXES.md`](./HORRIBLE_BUG_FIXES.md) for the
postmortems. Read the applicable postmortem before you work in that area.
