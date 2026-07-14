# @inflexa-ai/harness

`@inflexa-ai/harness` is the host-agnostic agent harness — the `runAgent` loop, durable workflows, the sandbox submit/recv protocol, and the provider interfaces. It is a **library, not a server**: it ships everything that does not depend on a particular host, and an embedder supplies the composition root, transport, and any non-local seam realizations.

## Run locally

Requirements:

- Node.js `>=24` (the runtime; Bun is used only to run tests)
- Postgres with pgvector (app tables + durable workflow state)
- a sandbox backend, selected by `SANDBOX_BACKEND` (`docker` | `k8s`)
- a chat/embedding provider — Anthropic, or any OpenAI-compatible endpoint

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
    assembleCoreRuntime,            // host-neutral composition point
    createConversationAgent,
    createAnthropicProvider,        // ChatProvider — Anthropic
    createConfiguredAiSdkProvider,  // ChatProvider — any OpenAI-compatible endpoint
    createEmbeddingProvider,
    createLocalRunAuthorizer,       // RunAuthorizer    seam (local default)
    createNoopBillingResolver,      // ResolveBilling   seam
    createNoopRunCharge,            // RunCharge        seam
    createNoopArtifactRegistry,     // ArtifactRegistry seam
    UnavailablePreviewPublisher,    // PreviewPublisher seam
    createDbosRunLauncher,          // shared RunLauncher
    defineTool,
    runAgent,
    makeLocalAuth,
} from "@inflexa-ai/harness";
```

`assembleCoreRuntime` is the single composition point: it registers the durable workflows and builds the conversation agent over them. The harness declares **five capability seams** an embedder wires — `RunAuthorizer`, `ResolveBilling`, `ArtifactRegistry`, `RunCharge`, `PreviewPublisher` — plus the **shared `RunLauncher`** (one host-neutral realization, `createDbosRunLauncher`). Local, dependency-free realizations of all five ship from the barrel; an embedder constructs them (or its own) and passes them in. The harness only ever sees the interface.

## How it executes

Chat is a plain in-process turn (`prepareChatTurn` → `runAgent` → `appendTurn`); the harness ships no HTTP layer, so the host owns the route. Compute-heavy work runs as **durable workflows** — `executeAnalysis` starts a child workflow per plan step once its dependencies have completed, and each step drives a sandbox agent inside a container. The same `runAgent` primitive runs in both modes; durability and the event sink are injected, so the loop body is identical.

The sandbox protocol is submit-then-retrieve, which is what lets a long run survive a host restart: the host `POST /exec`s a command and retrieves the result over one of two transports — **poll** (the default: the host asks, the sandbox initiates nothing and needs no network egress) or **callback** (opt-in: the sandbox POSTs signed callbacks to an ingress the embedder runs). Both exec endpoints are HMAC signature-authenticated. See the [`harness-sandbox-exec`](./openspec/specs/harness-sandbox-exec/) spec.

## Further reading

- [`CONTEXT.md`](./CONTEXT.md) — domain glossary and load-bearing patterns
- [`openspec/specs/`](./openspec/specs/) — feature specs and the source of truth for architectural decisions
- [`CLAUDE.md`](./CLAUDE.md) — working conventions, public-interface map, and the seam/session model
