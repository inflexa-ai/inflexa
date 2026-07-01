# @inflexa-ai/harness

`@inflexa-ai/harness` is the host-agnostic agent harness — the `runAgent` loop, DBOS-durable workflows, the sandbox submit/recv protocol, and the provider interfaces. It is a **library, not a server**: it ships everything that does not depend on a particular host, and an embedder supplies the composition root, transport, and any non-local seam realizations.

## Run locally

Requirements:

- Node.js `>=24` (the runtime; Bun is used only to run tests)
- Postgres with pgvector (app tables + DBOS workflow state)
- a sandbox backend, selected by `SANDBOX_BACKEND` (`docker` | `k8s`)
- an Anthropic-shaped chat/embedding provider endpoint

```bash
npm install @inflexa-ai/harness   # or add file:../harness from an in-repo embedder

tsc -p tsconfig.json              # build: emit dist/ from src/ (also `npm run build`)
bun test                          # run the test suite
```

The package emits `dist/` from `src/` and publishes only `dist`. Most configuration arrives through dependency objects passed to the composition point; helper modules read conventional env vars (`ANTHROPIC_*`, `DB_PG_*`, sandbox limits) — see `CONTEXT.md` and the specs for the catalog.

## Public surface

Import the curated, embedder-facing surface from the package root. Every deep subpath (`@inflexa-ai/harness/...`) stays importable for advanced wiring; the barrel is additive.

```ts
import {
    assembleCoreRuntime,        // host-neutral composition point
    createConversationAgent,
    createAnthropicProvider,
    createEmbeddingProvider,
    createLocalRunAuthorizer,   // RunAuthorizer  seam (local default)
    createNoopBillingResolver,  // ResolveBilling seam
    createNoopRunCharge,        // RunCharge      seam
    createFilesystemArtifactRegistry, // ArtifactRegistry seam
    UnavailablePreviewPublisher,      // PreviewPublisher seam
    createDbosRunLauncher,      // shared RunLauncher
    defineTool,
    runAgent,
    makeLocalAuth,
} from "@inflexa-ai/harness";
```

`assembleCoreRuntime` is the single composition point: it registers the durable workflows with DBOS and builds the conversation agent over them. The harness declares **five capability seams** an embedder wires — `RunAuthorizer`, `ResolveBilling`, `ArtifactRegistry`, `RunCharge`, `PreviewPublisher` — plus the **shared `RunLauncher`** (one host-neutral realization, `createDbosRunLauncher`). Local, dependency-free realizations of all five ship from the barrel; an embedder constructs them (or its own) and passes them in. The harness only ever sees the interface.

## Further reading

- [`CONTEXT.md`](./CONTEXT.md) — domain glossary and load-bearing patterns
- [`openspec/specs/`](./openspec/specs/) — feature specs and the source of truth for architectural decisions
- [`CLAUDE.md`](./CLAUDE.md) — working conventions, public-interface map, and the seam/session model
