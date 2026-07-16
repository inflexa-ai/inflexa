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

The package emits `dist/` from `src/` and publishes only `dist`. Most configuration arrives through dependency objects passed to the composition point — the LLM backend, for instance, is a fully injected provider config (endpoint/key/model or a `LanguageModel` instance), not read from env; helper modules read conventional env vars (`DB_PG_*`, sandbox limits) — see `CONTEXT.md` and the specs for the catalog.

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
    createConsoleLogger,            // Logger — writes to console
    createNoopLogger,               // Logger — discards (the fallback when none is wired)
    defaultErrorFields,             // the shipped `Logger.errorFields` mapping
    defineTool,
    runAgent,
    makeLocalAuth,
} from "@inflexa-ai/harness";
```

`assembleCoreRuntime` is the single composition point: it registers the durable workflows and builds the conversation agent over them. The harness declares **five capability seams** an embedder wires — `RunAuthorizer`, `ResolveBilling`, `ArtifactRegistry`, `RunCharge`, `PreviewPublisher` — plus the **shared `RunLauncher`** (one host-neutral realization, `createDbosRunLauncher`). Local, dependency-free realizations of all five ship from the barrel; an embedder constructs them (or its own) and passes them in. The harness only ever sees the interface.

## Logging

The harness names no logging library. It logs through a `Logger` you supply, so the destination, format, and verbosity stay yours:

```ts
export interface Logger {
    debug(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
    with(fields: LogFields): Logger;        // bind context onto every record (slog's `With`)
    named(name: string): Logger;            // bind a namespace, rendered as a `[a.b]` message prefix
    errorFields(err: unknown): LogFields;   // normalize a thrown value; `defaultErrorFields` is the shipped mapping
}
```

Pass `createConsoleLogger()` if you have no logging infrastructure. Wire nothing and the harness falls back to `createNoopLogger()` — it never falls back to `console`, because a host whose UI owns stdout (an alternate-screen TUI, say) discards console output, and a diagnostic written to a discarded stream is worse than no diagnostic at all.

`errorFields` is on the interface, not a helper we own, so your realization can defer to your sink's native error handling rather than a shape we imposed.

**Migrating from a version that took a `pino.Logger`** — `bootHarness` and the deps bags now take this interface. pino is object-first where this is message-first, so pass an adapter:

```ts
import type { LogFields, Logger } from "@inflexa-ai/harness";
import type pino from "pino";

function pinoAsHarnessLogger(p: pino.Logger, names: readonly string[] = []): Logger {
    const prefixed = (msg: string): string => (names.length > 0 ? `[${names.join(".")}] ${msg}` : msg);
    const emit =
        (level: "debug" | "info" | "warn" | "error") =>
        (msg: string, fields?: LogFields): void => {
            p[level](fields ?? {}, prefixed(msg));
        };
    return {
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
        with: (fields) => pinoAsHarnessLogger(p.child(fields), names),
        named: (name) => pinoAsHarnessLogger(p, [...names, name]),
        errorFields: (err) => ({ err }), // let pino's own `err` serializer render it
    };
}
```

## How it executes

Chat is a plain in-process turn (`prepareChatTurn` → `runAgent` → `appendTurn`); the harness ships no HTTP layer, so the host owns the route. Compute-heavy work runs as **durable workflows** — `executeAnalysis` starts a child workflow per plan step once its dependencies have completed, and each step drives a sandbox agent inside a container. The same `runAgent` primitive runs in both modes; durability and the event sink are injected, so the loop body is identical.

The sandbox protocol is submit-then-retrieve, which is what lets a long run survive a host restart: the host `POST /exec`s a command and retrieves the result over one of two transports — **poll** (the default: the host asks, the sandbox initiates nothing and needs no network egress) or **callback** (opt-in: the sandbox POSTs signed callbacks to an ingress the embedder runs). Both exec endpoints are HMAC signature-authenticated. See the [`harness-sandbox-exec`](./openspec/specs/harness-sandbox-exec/) spec.

## Further reading

- [`CONTEXT.md`](./CONTEXT.md) — domain glossary and load-bearing patterns
- [`openspec/specs/`](./openspec/specs/) — feature specs and the source of truth for architectural decisions
- [`CLAUDE.md`](./CLAUDE.md) — working conventions, public-interface map, and the seam/session model
