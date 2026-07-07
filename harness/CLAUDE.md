# CLAUDE.md

Guidance for Claude Code working with the Cortex **harness** package (`@inflexa-ai/harness`).

## Project Overview

The harness is Cortex's **host-agnostic agent runtime**: a hand-rolled agent loop and execution boundary for long-running bioinformatics analysis. A single Conversation Agent handles all interactive work (data discovery, analysis planning, workflow triggering, result interpretation, hypothesis exploration), while compute-heavy work (R/Python) runs in isolated sandbox containers driven by DBOS-durable workflows.

The harness ships everything that does not depend on a particular host: the loop, the two provider interfaces, `defineTool`, the dependency-injection composition pattern, the session value objects, the sandbox submit/recv protocol, memory, storage layout, and the five capability **seams** the harness declares (plus the shared `RunLauncher` seam). Embedders provide their own composition root and may swap the local seam realizations for host-specific ones.

Source lives under `harness/src/...`; this doc uses those paths.

Design decisions are recorded in the OpenSpec specs (`openspec/specs/`), the single source of truth — there is no `docs/adr`. Make spec changes via the openspec CLI from this directory (`cd harness && openspec ...`).

### Public interface

`harness/src/index.ts` is the curated front door: it re-exports the embedder-facing surface only — `assembleCoreRuntime`, `createConversationAgent`, the five capability seams + their local adapters (`RunAuthorizer`/`createLocalRunAuthorizer`, `ResolveBilling`/`createNoopBillingResolver`, `ArtifactRegistry`/`createNoopArtifactRegistry`, `RunCharge`/`createNoopRunCharge`, `PreviewPublisher`/`UnavailablePreviewPublisher`), `RunLauncher`/`createDbosRunLauncher`, `defineTool`, `runAgent`, and the loop/session/provider public types. Prefer importing from `@inflexa-ai/harness` (the bare specifier resolves to this barrel). Every deep subpath (`@inflexa-ai/harness/...`) stays importable for internal wiring; the barrel is additive, not a wall.

`harness/package.json` is the package manifest: it declares the name `@inflexa-ai/harness`, `type: "module"`, the `exports` map (`.` → `dist/index.js`, `./*` → `dist/*.js`), and the `tsc -p tsconfig.json` build that emits `dist/`. At publish time consumers resolve the public surface through that `exports` map. During in-repo development the bare and deep specifiers (`@inflexa-ai/harness`, `@inflexa-ai/harness/*`) resolve through `harness/tsconfig.json`'s `paths` map (bare → `src/index.ts`, `/*` → `src/*`). The manifest declares its own `dependencies`, so the harness's third-party packages resolve from its own install — it is a standalone package, not a workspace member.

## Commands

`@inflexa-ai/harness` is a library; there is no server entry point or task runner here.

```bash
tsc -p tsconfig.json    # Build: emit dist/ from src/ (also `npm run build`)
bun test                # Run unit tests (bun:test)
```

**Runtime**: Node.js. Bun is used only for testing (`bun test`).

**Composition**: `assembleCoreRuntime` is the single host-neutral assembly point — it registers the durable workflows with DBOS and builds the conversation agent over the registered callables. The local, dependency-free seam realizations (`createLocalRunAuthorizer`, `createNoopBillingResolver`, `createNoopRunCharge`, `createNoopArtifactRegistry`, `UnavailablePreviewPublisher`, `makeLocalAuth`) are exported from `index.ts`; an embedder constructs them (or its own realizations) and passes them into `assembleCoreRuntime` at its composition root. The local sandbox path creates ephemeral Docker containers per analysis step; session data, lib store, and ref store are host directories bind-mounted into them.

**LLM backend** is whatever the wired `ChatProvider`/`EmbeddingProvider` points at — an embedder supplies an AI SDK `LanguageModel` instance or endpoint/key/model configuration (Anthropic or OpenAI-compatible). The local billing seam is a no-op (`createNoopBillingResolver`), so no attribution headers are added.

The sandbox client includes Docker and Kubernetes backends. The `SANDBOX_BACKEND` value (`docker` | `k8s`) selects the backend the composition root wires.

**After a big change**, run `tsc -p tsconfig.json` and `bun test`.

## Architecture

**Core Philosophy**: The harness owns the agent loop and the execution boundary. Chat is regular HTTP; durable operations are DBOS workflows. The same `runAgent` primitive runs in both. Operative architectural decisions live in [`CONTEXT.md`](CONTEXT.md) and the OpenSpec specs ([`openspec/specs/`](openspec/specs/)).

### Two-Layer Architecture

- **Conversation Layer** — chat is regular HTTP, single-replica per turn ([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)). The Conversation Agent handles all interactive work: data discovery, analysis planning (via the `generatePlan` tool), workflow triggering, result interpretation, and hypothesis exploration. Has bio-lookup tools, workspace search, run event queries, `generatePlan` + `executePlan`, and `showUser`. No sandbox access from the chat route; sandbox work happens inside workflows.
- **Workflow Layer** — DBOS-durable. `executeAnalysis`, `executeTargetAssessment`, `runEphemeral` (when long-running), and the background `runDataProfile` run as DBOS workflows. Reports render in-process via `iterate_report`, not as a DBOS workflow. Streaming events flow back to the UI via the single DBOS-backed run-event stream.

### Design Principles

1. **Hand-rolled `runAgent` loop, ~80 LOC.** `loop/run-agent.ts`. Pure async TypeScript that owns the message loop and nothing else. Durability (`runStep`) and the event sink (`emit`) are injected — the loop runs identically in a host request path (passthrough step) and inside DBOS workflow steps (`DBOS.runStep` wrapper). Same body, two execution modes.
2. **AI SDK `ModelMessage` is the harness lingua franca** ([harness-providers](openspec/specs/harness-providers/spec.md)). The loop's working message array is AI SDK `ModelMessage`; thread history stores each one in a versioned envelope (`{kind: "ai-sdk-model-message", aiSdkMajor, message}`). Signed provider metadata (Anthropic thinking signatures, cache control) rides provider-scoped in `providerOptions` and round-trips through storage.
3. **Two narrow provider interfaces** in `providers/types.ts`:
   - `ChatProvider.chat(req, session, signal?) → ResultAsync<ChatResponse, ProviderError>` — non-streaming; cacheable as a DBOS step.
   - `ChatProvider.chatStream(req, session, signal?) → AsyncIterable<ChatStreamEvent>` — text deltas then one terminal `done` event; for the chat loop.
   - `EmbeddingProvider.embed(texts, session) → ResultAsync<number[][], ProviderError>`.
   Every method takes `session`. You cannot make a wire call without a session; billing headers (if any) are resolved internally through the `ResolveBilling` seam — the OSS default returns none. Providers advertise `capabilities.toolCalling`; `runAgent` rejects a tool-requiring agent before the first model call when the model can't do mature tool calling.
4. **`defineTool` is the tool primitive.** `defineTool({id, description, inputSchema: ZodSchema, execute(input, ctx) => result, executionMode?})`. `ctx` is `ToolContext = {session, signal, emit, runStep}` — no injected dependencies. Dep-bearing tools are factory closures (`createXTool(deps)`) that capture deps and call `defineTool`. Zod 4's `z.toJSONSchema()` emits the AI SDK-compatible tool input schema (top-level object only — unions are rejected at construction). Every tool declares or defaults to an execution mode: `step` (deterministic durable-step wrap — the default), `workflow` (body-only/multi-operation durable tools: `execute_command`, `write_file`, `edit_file`), or `inline` (pure logic only). See `tools/define-tool.ts`.
5. **Tool error contract.** Expected outcomes (incl. "not found") return as data variants of the result type; unexpected failures throw or return `err(ToolError)` → the loop maps them to model-visible error tool results. Zod input-validation failure → error tool result at the boundary, without calling `execute`. Errors matched by the injected fatal predicate (cancellation, workflow-fatal failures) propagate out of the loop instead.
6. **Dependency injection at the composition root** ([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)). Construction-time deps (`Pool`, `ChatProvider`, `EmbeddingProvider`, `Logger`, sandbox factories, seam implementations) are injected when a module is built. Call-time values (`Session`, `AbortSignal`, `EmitFn`) are passed as explicit parameters. Modules are factory closures: `createX(deps) => {op1, op2}`. No classes, no god-ctx, no ALS, no magic-key bag. Tools are exploded apart inside `createConversationAgent(deps)` (`agents/conversation-agent.ts`).
7. **Sub-agents are regular tools.** No special delegation primitive, no message stripping. A child agent is exposed as a tool whose `execute` calls `runAgent(subAgent, prompt, forSubAgent(ctx.session, childAgentId))`. The child's `callPath` extends the parent's. Sub-agent transcripts are ephemeral. Examples: `literature-reviewer`, `analogical-reasoner`.
8. **No agent framework, no processor pipeline.** SOUL kernel/conversational personality lives as static `systemPrompt` composition in the agent definition. Input sanitization (`normalizeUnicode`, trimmed `redactSecrets`) is two functions applied once in the chat route. Analysis context is injected at chat-route message assembly time.
9. **Static, dependency-gated, budget-admitted workflows** ([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md), [resource-budgeted-scheduling](openspec/specs/resource-budgeted-scheduling/spec.md)). `executeAnalysis` is a DBOS parent workflow that starts a child workflow per sandbox-agent step once all its `depends_on` steps have completed and — when the embedder configures a machine resource budget — the declared resources of concurrently running steps leave room for it (held steps surface as `queued` on the dag-state part). No wave batching; no budget means every dependency-satisfied step starts immediately. Fail-fast: the first step failure cancels in-flight siblings.
10. **Self-contained step bodies.** Each child workflow runs the sandbox agent, generates file metadata, summarizes, registers artifacts, and indexes — all inside the same DBOS workflow body. Synthesis (cross-step literature-grounded aggregation) is the parent's final step.
11. **Single DBOS-backed run-event stream per workflow.** Live consumers and historical replay read the same source. All events persisted; reconciling events folded latest-wins by `id` on read. Consumers read Cortex-native typed parts directly — no AI SDK format mapping.

### Session model — `RequestSession` vs `RunSession`

Per-request identity decomposes into immutable value objects (see `auth/types.ts`):

- `Identity` — `{ user }`, always complete.
- `Scope` — discriminated union: `{ kind: "analysis"; analysisId; threadId? }` or `{ kind: "target-assessment"; targetAssessmentId; billingContextId }`.
- `Credential` — an **opaque brand** the harness never inspects. The harness only forwards it; the concrete credential shape is defined by whatever wraps the harness.
- `AuthContext` — the **opaque inward auth capability** every session carries (the `auth` field) and the SOLE source of credential/org behind a session. The harness forwards it but never reads it; an embedder downcasts it to its own concrete type at its adapters. The OSS build supplies a trivial empty `auth` (`makeLocalAuth`, `auth/local-auth-context.ts`). There is no top-level `orgId`/`credential` field (serialization cutover — [harness-session-model](openspec/specs/harness-session-model/spec.md)).
- `Provenance` — `{ agentId; callPath }`. Read-only — code MUST NOT branch on `callPath`.
- `RunFrame` — `{ runId; stepId? }`, present only inside a workflow run.

Two bundles compose these with honest lifetimes:

- `RequestSession` — live HTTP door; no `RunFrame`. MUST NOT be JSON-serialized into durable state.
- `RunSession` — durable + JSON-serializable; carries a `RunFrame`. Constructed solely at the run-authorization **seam**, `RunAuthorizer.authorize(...)` (`execution/run-authorizer.ts`). The OSS impl (`auth/local-run-authorizer.ts`) issues a `RunSession` with no remote mint, no jti, no revoke; an embedder may supply a realization that mints a scoped credential at the async edge. The resulting bundle rides in DBOS workflow input. Async/durable APIs accept only `RunSession`, so starting async work without authorizing a run is unrepresentable. See [harness-session-model](openspec/specs/harness-session-model/spec.md).

Both bundles satisfy the structural type `AgentSession` consumed by the loop and providers. Neither bundle carries resolved billing headers — billing is resolved lazily at the LLM/embedding call site via the `ResolveBilling` seam.

### Capability Seams

The harness declares five external seams as interfaces and ships trivial OSS realizations; an embedder may swap in cloud-backed ones. The harness's code only ever sees the interface.

- **`RunAuthorizer`** (`execution/run-authorizer.ts`) — the only constructor of a `RunSession`. OSS: `auth/local-run-authorizer.ts` (no remote mint, no revoke).
- **`ResolveBilling`** (`billing/resolver.ts`) — resolves attribution headers at the wire-call site. OSS: `billing/noop-resolver.ts` (empty headers).
- **`ArtifactRegistry`** (`execution/artifact-registry.ts`) — records + syncs produced artifacts (`register(input, session)` + `sync(input, session)`, session-scoped). OSS: `createNoopArtifactRegistry` (registers nothing externally — the harness writes the local `cortex_artifacts` ledger itself around the seam; `sync` no-op).
- **`RunCharge`** (`billing/run-charge.ts`) — run-level billing bracket (`open`/`close`) around `executeAnalysis`. OSS: `createNoopRunCharge`.
- **`PreviewPublisher`** (`tools/report/preview-publisher.ts`) — publishes report previews. OSS: `UnavailablePreviewPublisher`.
- **`RunLauncher`** (`execution/run-launcher.ts`) — starts a registered workflow under a caller-chosen id (fire-and-forget `launch` / inline `launchAndAwait`). The DBOS-quarantine seam: tools and the loop never import the durability engine — `execute_plan` / `run_ephemeral` launch through this. Single shared realization `createDbosRunLauncher` (`execution/dbos-run-launcher.ts`).

### Sandbox Architecture

```
Harness host process
  |
  +- SandboxBase (abstract)
  |   +- Shared: HTTP submit + recv, provenance, abort handling
  |   |
  |   +- DockerSandbox                     K8sSandbox
  |       docker run sandbox-base            K8s Job sandbox-base
  |       bind mounts (host dirs)            PVC mounts
  |       dynamic port mapping               pod IP:8765
  |
  +- POST /exec  (submit, idempotent on execId)
  |   |
  |   sandbox runs in background
  |   |
  |   v
  +- sandbox-server POSTs to Cortex:
  |     POST /sandbox/:execId/event     (progress; HMAC-verified at recv)
  |     POST /sandbox/:execId/complete  (final result; HMAC-verified at recv)
  |
  +- Cortex workflow body: DBOS.recv unblocks; forwards events to the run stream
  +- Container removed on completion
```

The submit + recv + HMAC-callback protocol ([harness-sandbox-exec](openspec/specs/harness-sandbox-exec/spec.md)) is what makes long sandbox runs survive host restarts: the sandbox worker keeps running separately; the host callback handler forwards callbacks via `DBOS.send` to the per-exec topic.

**Two distinct lifetimes** (do not conflate):

- **Exec command** — one `submit → recv result`. Many per sandbox; most are near-instant. `execId = "${workflowId}:${stepId}:${functionId}"`. Bounded by `step.timeout`. **No per-exec heartbeats.**
- **Sandbox machine** — one per step, long-lived; the sandbox-agent loop issues many commands into the same container. Liveness is checked at a per-sandbox-machine cadence by a `@DBOS.scheduled` workflow (`SandboxClient.isAlive(sandboxRef)`); dead + no completion recorded → synthetic failure-`complete` unblocks the recv.

**Single base image**: One `sandbox-base` image for all sandbox agents. R, Python, Node.js runtimes + system libraries; no R/Python packages baked in. Packages live in the shared library store mounted read-only at `/mnt/libs`.

**sandbox-server**: Statically-linked Go binary at `images/sandbox-base/server/`. Endpoints: `GET /health`, `POST /exec` (idempotency-keyed submit), `POST /exec/{pid}/kill`.

**Session storage**: Per-analysis data and artifacts live in the session directory. Each sandbox container gets a **flat read-only mount** of the full analysis tree at `/{resourceId}`, with a **nested read-write mount** at `/{resourceId}/runs/{runId}/{stepId}` for the step's artifacts. Workspace tools enforce write restriction via `allowedWritePrefix`.

**Auth and attribution** (the harness's seams; concrete policy is an embedder concern):
- **Inbound** — the harness consumes a session built upstream from whatever auth the host runs at its edge; it sees only the opaque `auth` capability (local: `makeLocalAuth`). Per-route authorization is a host concern, not a harness seam.
- **Async** — workflow steps that outlive the originating HTTP request ride the `RunSession` minted at the `RunAuthorizer` seam. The credential (if any) rides opaque inside the `RunSession` in DBOS workflow input; workflow bodies never re-mint and never read it back from the DB.
- **Outbound to sandbox-server** — Idempotent submit. Sandbox callbacks are HMAC-verified at recv ([harness-sandbox-exec](openspec/specs/harness-sandbox-exec/spec.md)).

### Key Components

- **Conversation Agent** (`agents/conversation-agent.ts`): Single user-facing agent. Has bio-lookup tools, workspace search, `inspectRun`, `generatePlan`, `executePlan`, `runEphemeral`, `iterateReport`, `generateAnalogyReport`, and `showUser`. `createConversationAgent(deps)` is the composition root that wires every tool's deps.
- **Literature Reviewer** (`tools/research/literature-reviewer.ts`): Sub-agent exposed as a tool. Receives a research brief, investigates with bio-lookup tools, returns a structured evidence report.
- **`generatePlan` Tool** (`tools/research/generate-plan.ts`): Internal-LLM tool. Captures the planner outcome via closure-state (`PlannerOutcome`); the planning prompt lives in `prompts/` with an `{{AGENT_CATALOG}}` placeholder populated from sandbox-agent metadata.
- **`executeAnalysis` Workflow** (`workflows/execute-analysis.ts` + scheduler in `execute-analysis-scheduler.ts`): Validates the plan, gates steps on dependencies, starts one child workflow per step. Per child: sandbox-agent loop → `generateFileMetadata` → `generateStepSummary` → register artifacts (via `ArtifactRegistry`) → index in vector store. Parent's final step is literature-grounded synthesis.
- **Chat turn** (`app/chat-turn.ts`): Direct `runAgent` call with `passthroughStep`. Background completion after client disconnect via `consumeStream`. Emits Cortex-native typed parts. The host wraps this in its own request handler — the harness ships no HTTP route layer.
- **Run-event stream**: A single DBOS-backed stream per workflow, produced inside the workflow bodies and consumed by readers of the harness's typed run-event parts (`harness/src/contracts/`). No standalone route file in the harness.
- **Workspace** (`workspace/`): Read surface (`read_file`, `grep`, semantic search) is sandbox-independent and available to the conversation agent. Mutate surface (`write_file`, `edit_file`, `execute_command`) is sandbox-gated.
- **Composition root** (`runtime/assemble.ts`): `assembleCoreRuntime` is the host-neutral assembly point — it registers the durable workflows and builds the conversation agent over them. The local seam realizations it can be wired with (`auth/local-run-authorizer.ts`, `auth/local-auth-context.ts`, `billing/noop-resolver.ts`, `billing/noop-run-charge.ts`, `execution/noop-artifact-registry.ts`, `tools/report/preview-publisher.ts`'s `UnavailablePreviewPublisher`) carry zero cloud deps and are re-exported from `index.ts`. See [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md).
- **Workflow recovery** ([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)): no standing component. Each host supplies a stable `executorID`; when that identity launches again, DBOS can reclaim in-flight workflows its predecessor left behind. The harness does not expose an HTTP recovery route.
- **Shared contracts** (`harness/src/contracts/`): the typed run-event part schemas, exported from `@inflexa-ai/harness` for consumers.

### Analysis Lifecycle

```
CREATE --> [chat | workflow | ...] --> ARCHIVE (deferred) --> [resume]
```

An analysis is created, enters an active state where it can handle chat messages and trigger workflows, and can be archived and later resumed. The `runId` is minted at workflow start, at the same point the `RunAuthorizer` seam issues the `RunSession`.

### Target Assessment

Separate top-level entity (NOT a kind of analysis). Snapshot-style target dossiers. Backed by `cortex_target_assessments` and the `executeTargetAssessment` workflow (`workflows/target-assessment/`). The dossier schema lives in `src/contracts/target-dossier.ts` and is the contract with consumers. Coverage discipline is a hard schema invariant: every enrichment-dependent section carries `coverage: "available" | "queried_no_data" | "not_loaded"`. Hosts choose how to expose progress to clients. See `docs/target-assessment/architecture.md`.

### Memory

Thread history (`messages` table) and working memory (`cortex_working_memory`, one JSONB row per analysis with `goal`/`constraints`/`hypotheses`/`findings`) are conversation- and analysis-scoped; there is no semantic recall — agents operate inside the token-bounded thread window only. Workflow and sandbox loops keep no `messages` table — durability is the DBOS step cache, debugged by read-side reconstruction from `dbos.operation_outputs` ([harness-thread-store](openspec/specs/harness-thread-store/spec.md)).

See [`CONTEXT.md`](CONTEXT.md) (Memory) for the full model.

**File discovery**: Agents discover files via workspace vector semantic search (file descriptions embedded into pgvector at write time). Vector entries have consistent `type` metadata (`"input"`, `"output"`, `"summary"`, `"synthesis"`, `"profile"`) for filtered searches. Search returns paths + descriptions + metadata — agents must `read_file` separately.

### Prompt Design Principles

Agent prompts live in `prompts/`. Every prompt follows these conventions:

1. **No run-order assumptions.** Agents must never assume they are operating on a first run. Search broadly for what exists before proceeding.
2. **Anti-patterns are explicit.** Every prompt has a "Do NOT" section listing specific failure modes. When editing prompts, always maintain and extend these lists. Telling agents what not to do is as important as telling them what to do.
3. **Orient first, but only once.** Search the workspace, read key files, and check execution history before starting work — but do not re-orient when context from prior turns is still available.
4. **Search → Read → Act.** Semantic search discovers, `read_file` inspects, then the agent acts. Search returns descriptions + metadata, not file contents.
5. **Sandbox agents know their tools.** Shared sandbox-agent orientation lives in `agents/sandbox/shared.ts` (check `list-available-packages` / `list-available-refs` before writing code). No assumed paths, no runtime installs.
6. **Rich context for planning.** The conversation agent passes detailed structured context to `generatePlan` — data profile, research question, prior run results, user constraints. Vague context produces vague plans.

## Storage Layout

```
/{resourceId}/
+-- data/                        # Input data (immutable, materialized at init)
|   +-- inputs/{fileId}/         # Per-file directories
+-- dataprofile/                 # Data profiling output
|   +-- profile-summary.md       # Analysis summary + file descriptions
+-- runs/{runId}/                # Workflow run directory
|   +-- synthesis.json           # Literature-grounded run synthesis
|   +-- {stepId}/                # Step artifacts
|       +-- scripts/             # Generated analysis scripts
|       +-- output/              # Analysis output files (includes summary.md)
|       +-- figures/             # Plots and visualizations
|       +-- logs/                # Execution logs
|       +-- notebooks/           # Generated notebooks
+-- reports/{reportId}/          # Report output
```

The harness uses Postgres (`pg` directly + pgvector). The DBOS system DB carries workflow state, step cache, and durable streams. App tables (`cortex_runs`, `cortex_step_executions`, `cortex_artifacts`, `cortex_target_assessments`, `messages`, `cortex_working_memory`) are thin ledgers — rich data (summaries, findings, file descriptions) lives in files and the vector index, not in DB columns. Connection parameters come from `DB_PG_HOST`/`DB_PG_PORT`/`DB_PG_NAME`/`DB_PG_USER`/`DB_PG_PASSWORD`/`DB_PG_SSLMODE`. The app pool is owned by `lib/storage.ts:createPool()`; DBOS owns a separate pool ([postgres-storage-backend](openspec/specs/postgres-storage-backend/spec.md)).

## Debugging

**Harness logs**: Set `LOG_LEVEL=debug` for verbose output from the conversation agent and workflow execution.

**Sandbox failures**: sandbox-server logs failed commands with exit code and stderr; the run-event stream surfaces `step-activity` failures. For the local Docker backend, inspect with `docker logs <container>`.

**Workflow recovery**: A terminated or crashed host's in-flight workflows are recovered when a host restarts under the same stable `executorID` and DBOS reclaims its own `dbos.workflow_status` rows at launch ([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)). Operator-facing recovery controls, if any, belong to the embedder.

## Code Comments

Comments describe the **current state** of the code, not its history. Do not leave comments explaining what the code *used to do*, why the current change was made versus the prior version, or what was removed. That context belongs in the commit message and PR description — in the code it rots the moment the next change lands.

If the only thing a comment can say is "this used to be X, now it's Y" or "changed from X because Y", delete the comment. If the current state is obvious from the code, no comment is warranted. Only write a comment when a future reader would genuinely be surprised or misled without it — a hidden constraint, a non-obvious invariant, a workaround for a specific bug.

## Testing

**Test state, not interactions.** Assert on returned values and database state. Do not assert that method X was called N times with arguments Y — this couples tests to implementation details.

**Postgres testcontainer**: Tests that touch the database use `withSchema(testName)` from `__tests__/setup/postgres.ts`. The helper starts a single `pgvector/pgvector:pg18` container per `bun test` run (cold start ~3s on first use; re-used across every test file afterward) and hands each test an isolated schema scoped via `search_path`. Set `CORTEX_TEST_PG_URL=postgres://cortex:dev@localhost:5433/cortex` to skip container startup and point at a locally-running Postgres — instant feedback during tight iteration. Harness modules receive their `Pool` as an injected construction dep (`createPool`), so a test passes the schema-scoped test pool directly into the factory under test — there is no global pool accessor or test-override seam.

**DBOS testcontainer**: Tests that need a launched DBOS engine use `setupDbosForTests` from `__tests__/setup/dbos.ts`. The rig launches lazily, shares one DBOS engine across `bun test`, and carves out a fresh per-test cortex schema via `withSchema()`. Use it for workflow/runtime-shape tests; pure body-level unit tests should stay on `passthroughStep`.

**Integration tests** (`__tests__/integration/`): Hit real external APIs with canonical queries. One file per API provider under `__tests__/integration/`. Assert on response structure and field presence, not exact values. Tools requiring API keys that aren't set are auto-skipped via `describe.skipIf(!process.env.KEY_NAME)`.

## References

- **Context glossary**: [`CONTEXT.md`](CONTEXT.md) — operative domain language + load-bearing patterns
- **ADRs**: [`openspec/specs/`](openspec/specs/) — feature specs and the source of truth for design decisions (ADR rationale now lives here; there is no docs/adr)
- **Specs**: [`openspec/specs/`](openspec/specs/) — feature specifications
- **Docs**: [`docs/`](docs/) — harness architecture and integration notes
