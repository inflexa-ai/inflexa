# CLAUDE.md

Guidance for Claude Code that works with the Cortex **harness** package
(`@inflexa-ai/harness`).

## Project Overview

The harness is the **host-agnostic agent runtime** of Cortex. It is a hand-rolled
agent loop and an execution boundary for long-running bioinformatics analysis. One
Conversation Agent handles each interactive task: data discovery, analysis
planning, workflow triggers, result interpretation, and hypothesis exploration.
Compute-heavy work in R and Python runs in isolated sandbox containers, and
DBOS-durable workflows operate them.

The harness ships each part that does not depend on a particular host. Those parts
are:

- the loop
- the two provider interfaces
- `defineTool`
- the dependency-injection composition pattern
- the session value objects
- the sandbox submit and recv protocol
- the memory
- the storage layout
- the six capability **seams** that the harness declares, plus the shared
  `RunLauncher` seam.

An embedder gives its own composition root. It can also swap a local seam
realization for a host-specific one.

The source is under `harness/src/...`, and this document uses those paths.

The OpenSpec specs (`openspec/specs/`) record the design decisions, and they are
the source of truth. There is no `docs/adr`. Make a spec change with the openspec
CLI from this directory (`cd harness && openspec ...`).

### Public interface

`harness/src/index.ts` is the curated front door. It re-exports only the surface
that an embedder faces:

- `assembleCoreRuntime` and `createConversationAgent`
- the six capability seams and their local adapters:
  `RunAuthorizer`/`createLocalRunAuthorizer`, `ResolveBilling`/`createNoopBillingResolver`,
  `ArtifactRegistry`/`createNoopArtifactRegistry`, `RunCharge`/`createNoopRunCharge`,
  `UsageRecorder`/`createNoopUsageRecorder`, `PreviewPublisher`/`UnavailablePreviewPublisher`
- `RunLauncher`/`createDbosRunLauncher`
- the `Logger` seam and its realizations (`createConsoleLogger`,
  `createNoopLogger`, `defaultErrorFields`)
- `defineTool` and `runAgent`
- the public types of the loop, the session, and the provider.

Prefer an import from `@inflexa-ai/harness`, because the bare specifier resolves to
this barrel. Each deep subpath (`@inflexa-ai/harness/...`) stays importable for
internal wiring. The barrel is additive, not a wall.

`harness/package.json` is the package manifest. It declares the name
`@inflexa-ai/harness` and `type: "module"`. It declares the `exports` map: `.` goes
to `dist/index.js`, and `./*` and `./*.js` go to `dist/*.js`.

The pattern with the extension exists because a harness-internal self-import and a
consumer alike can write a deep specifier with a `.js` suffix. A lone `./*` would
capture the extension into `*` and resolve them to `dist/*.js.js`. The manifest
also declares the `tsc -p tsconfig.json` build that emits `dist/`.

At publish time a consumer resolves the public surface through that `exports` map.
During in-repo development the bare and deep specifiers (`@inflexa-ai/harness`,
`@inflexa-ai/harness/*`) resolve through the `paths` map of
`harness/tsconfig.json`: bare goes to `src/index.ts`, and `/*` goes to `src/*`. The
manifest declares its own `dependencies`, thus the third-party packages of the
harness resolve from its own install. It is a standalone package, not a workspace
member.

## Commands

`@inflexa-ai/harness` is a library. There is no server entry point and no task
runner here.

```bash
tsc -p tsconfig.json    # Build: emit dist/ from src/ (also `npm run build`)
bun test                # Unit tests only — DB/DBOS suites need Postgres (see Testing notes)
```

**Runtime**: Node.js. Bun is only for the tests (`bun test`).

**Composition**: `assembleCoreRuntime` is the single host-neutral assembly point.
It registers the durable workflows with DBOS, and it builds the conversation agent
over the registered callables. The local seam realizations have no dependencies,
and `index.ts` exports them: `createLocalRunAuthorizer`,
`createNoopBillingResolver`, `createNoopRunCharge`, `createNoopUsageRecorder`,
`createNoopArtifactRegistry`, `UnavailablePreviewPublisher`, and `makeLocalAuth`.
An embedder constructs them, or its own realizations, and passes them into
`assembleCoreRuntime` at its composition root. The local sandbox path makes an
ephemeral Docker container for each analysis step. The session data, the lib store,
and the ref store are host directories, bind-mounted into them.

**LLM backend** is whatever the wired `ChatProvider` and `EmbeddingProvider` point
at. An embedder supplies an AI SDK `LanguageModel` instance, or an endpoint, key,
and model configuration (Anthropic or OpenAI-compatible). The local billing seam
does nothing (`createNoopBillingResolver`), thus no attribution header is added.

The sandbox client includes a Docker backend and a Kubernetes backend. The
`SANDBOX_BACKEND` value (`docker` or `k8s`) selects the backend that the
composition root wires.

**After a big change**, run `tsc -p tsconfig.json` and `bun test`.

## Formatting

**After you edit a source file in `src/`, run `bun run format:file <paths>` on the
files that you changed.** Do this before you report the task as complete. Format
only a file inside `src/`. Never format a markdown file, a config file, or a spec
file. Use `bun run format` for the format of the full project.

## Architecture

**Core Philosophy**: The harness has the agent loop and the execution boundary.
Chat is regular HTTP. A durable operation is a DBOS workflow. The same `runAgent`
primitive runs in both. The operative architectural decisions are in
[`CONTEXT.md`](CONTEXT.md) and in the OpenSpec specs
([`openspec/specs/`](openspec/specs/)).

### Two-Layer Architecture

Chat is regular HTTP, with one replica for each turn. A durable operation is a
DBOS workflow. The layer model is in [`CONTEXT.md`](CONTEXT.md), under
`Workflow scope`.

**There is no sandbox access from the chat route.** Sandbox work happens inside a
workflow.

### Design Principles

The loop, the providers, `defineTool`, the dependency injection, and the stream
model are in [`CONTEXT.md`](CONTEXT.md), under `Loop primitives`,
`Dependency injection`, and `Stream model`. Read that before you change any of
them. These two rules bind the code, and `CONTEXT.md` does not carry them:

1. **Diagnostics go through the injected `Logger`, never through `console`**
   ([structured-logging](openspec/specs/structured-logging/spec.md)).
   `lib/logger.ts` declares the shape. The harness names no logging library,
   because it is published and it must not push one onto a consumer. The shape is
   message-first (`error(msg, fields?)`), which is the order of `slog`, winston,
   and `console`, and it is deliberately not the object-first order of pino. It
   has `with(fields)` for context, `named(name)` for the `[a.b]` module prefix,
   and `errorFields(err)`.

   `errorFields` is on the interface for a reason. A realization can then defer to
   the native error handling of its sink, instead of the shipped
   `defaultErrorFields`. Examples are the `err` serializer of pino and the
   `exception.*` of OTel.

   An identifier rides as a structured field, and it is never interpolated into
   the message. This includes "which stage failed", which rides as a `named(...)`
   namespace and not as prose. `bootHarness` **requires** a `logger`, because
   booting is the one place where the embedder must consciously decide where the
   diagnostics go. Each deps bag below it takes `logger?` and resolves
   `?? createNoopLogger()` one time for each entry point, thus an internal call
   site never threads `?.`. The fallback is never console, which a host with a UI
   that has stdout would discard. That silent loss is the reason for the ban, and
   `no-console` in `eslint.config.js` enforces it. It exempts
   `lib/console-logger.ts` by path, not by an inline disable.
2. **Keep a step body self-contained.** Each child workflow runs the sandbox
   agent, generates the file metadata, summarizes, registers the artifacts, and
   indexes. All of that stays inside the same DBOS workflow body. The synthesis,
   which is a cross-step literature-grounded aggregation, is the final step of the
   parent.

### Session model

The value objects, the two bundles, and their lifetimes are in
[`CONTEXT.md`](CONTEXT.md), under `Session model`, and in `src/auth/types.ts`.
Three rules bind the code:

- **`RequestSession` MUST NOT be JSON-serialized into durable state.**
- **`RunAuthorizer.authorize(...)` (`execution/run-authorizer.ts`) is the sole
  constructor of a `RunSession`.** An async or durable API accepts only a
  `RunSession`, thus async work that starts without an authorized run is
  unrepresentable.
- **Code MUST NOT branch on `callPath`, and it MUST NOT read the `auth`
  capability.** The harness forwards `auth` untouched. An embedder downcasts it at
  its own adapters.

### Capability Seams

The harness declares each external seam as an interface, and it ships a trivial
OSS realization. An embedder binds one at its composition root. **The code of the
harness only ever sees the interface, and it never branches on which realization
is bound.**

Each seam, its path, and its OSS realization are in [`CONTEXT.md`](CONTEXT.md),
under `The six seams`.

### Sandbox Architecture

```
Harness host process
  |
  +- SandboxBase (abstract)
  |   +- Shared: HTTP submit + await, provenance, abort handling
  |   |
  |   +- DockerSandbox                          K8sSandbox
  |       docker run sandbox-base                 K8s Job sandbox-base
  |       bind mounts (host dirs)                 PVC mounts
  |       loopback-published :8765                 pod IP:8765
  |       + in-container egress firewall (poll)    + NetworkPolicy
  |
  +- POST /exec  (submit, idempotent on execId; signed request)
  |   |
  |   sandbox runs in background
  |   |
  |   v
  +- poll (default): host asks, sandbox initiates nothing
  |     GET /exec/{execId}?since={cursor}
  |       -> signed { status, events[], cursor, result? }
  |     awaitExec loops durable poll steps; emits events; returns result
  |
  +- callback (opt-in): sandbox POSTs signed callbacks to CORTEX_BASE_URL
  |     POST /sandbox/:execId/event     (progress; HMAC-verified at recv)
  |     POST /sandbox/:execId/complete  (final result; HMAC-verified at recv)
  |     ...body PULLS GET /exec/{execId} if the topic falls quiet (recovery)
  |
  +- Container removed on completion
```

The submit and result protocol
([harness-sandbox-exec](openspec/specs/harness-sandbox-exec/spec.md)) is what lets
a long sandbox run survive a host restart. The sandbox worker keeps running
separately, and the host gets its result through one of two transports.
`SandboxTransport` (`poll` or `callback`) selects the transport. The embedder
chooses it at its composition root, and it goes to the container as
`SANDBOX_TRANSPORT`. The default of the OSS build and the CLI is `poll`.

The two transports, the in-container egress firewall of poll mode, and the two
distinct lifetimes (an exec command against a sandbox machine) are in
[`CONTEXT.md`](CONTEXT.md) — the `Transport (SandboxTransport)` glossary entry and
`Sandbox exec`. **Do not conflate the two lifetimes.**

**A single base image**: one `sandbox-base` image for each sandbox agent. It has
the R, Python, and Node.js runtimes and the system libraries. No R package and no
Python package is baked in. The packages are in the shared library store, mounted
read-only at `/mnt/libs`.

**sandbox-server**: a statically-linked Go binary at
`images/sandbox-base/server/`. Its endpoints are:

- `GET /health` — unauthenticated.
- `POST /exec` — an idempotency-keyed submit.
- `GET /exec/{execId}` — the terminal result, signed fresh at request time. With
  `?since={cursor}` in poll mode it gives `{ status, events[], cursor, result? }`,
  always signed.

The two exec endpoints are **signature-authenticated inbound** in the two
transport modes. The caller signs each request with the per-sandbox secret, over
the same HMAC construction as the served or pushed bodies. It is a request
signature, not a bearer, thus a cleartext hop can drop a request but it can never
mint one. An unsigned, forged, or stale request gives a `401`. This confines the
siblings: a sandbox that holds only its own secret cannot operate the `/exec` of a
different one. There is no `kill` route. `SANDBOX_TRANSPORT` selects poll (the
default, with no outbound, which serves the ring and the result) or callback (which
POSTs to `CORTEX_BASE_URL`).

**Workspace storage**: the data and the artifacts of each analysis are in the
workspace tree of the analysis. The tree is rooted at the workspace root that the
embedder resolves — refer to Storage Layout. Each sandbox container gets a **flat
read-only mount** of the full analysis tree at `/{resourceId}`. It also gets a
**nested read-write mount** at `/{resourceId}/runs/{runId}/{stepId}` for the
artifacts of the step. The workspace tools enforce the write restriction with
`allowedWritePrefix`.

**Auth and attribution.** These are the seams of the harness. The concrete policy
is an embedder concern.

- **Inbound** — the harness consumes a session that is built upstream, from
  whatever auth the host runs at its edge. It sees only the opaque `auth`
  capability (local: `makeLocalAuth`). Per-route authorization is a host concern,
  not a harness seam.
- **Async** — a workflow step that outlives the originating HTTP request rides the
  `RunSession` that the `RunAuthorizer` seam minted. The credential, if there is
  one, rides opaque inside the `RunSession` in the DBOS workflow input. A workflow
  body never mints it again, and it never reads it back from the DB.
- **Outbound to sandbox-server** — an idempotent submit. A sandbox callback is
  HMAC-verified at recv
  ([harness-sandbox-exec](openspec/specs/harness-sandbox-exec/spec.md)).

### Key Components

- **Conversation Agent** (`agents/conversation-agent.ts`): the single user-facing
  agent. It has the bio-lookup tools, the workspace search, `inspectRun`,
  `inspectDataProfile`, `updateWorkingMemory`, `generatePlan`, `executePlan`,
  `runEphemeral`, `iterateReport`, `generateAnalogyReport`, and `showUser`.
  `createConversationAgent(deps)` is the composition root that wires the deps of
  each tool.
- **Literature Reviewer** (`tools/research/literature-reviewer.ts`): a sub-agent
  that is a tool. It receives a research brief, investigates with the bio-lookup
  tools, and gives a structured evidence report.
- **`generatePlan` Tool** (`tools/research/generate-plan.ts`): an internal-LLM
  tool. It captures the planner outcome with closure state (`PlannerOutcome`). The
  planning prompt is in `prompts/`, with an `{{AGENT_CATALOG}}` placeholder that
  the sandbox-agent metadata fills.
- **`executeAnalysis` Workflow** (`workflows/execute-analysis.ts`, with the
  scheduler in `execute-analysis-scheduler.ts`): it validates the plan, gates the
  steps on their dependencies, and starts one child workflow for each step. For
  each child: the sandbox-agent loop, then `generateFileMetadata`, then
  `generateStepSummary`, then the artifact registration through
  `ArtifactRegistry`, then the index in the vector store. The final step of the
  parent is the literature-grounded synthesis.
- **Chat turn** (`app/chat-turn.ts`): the preparation half of one turn only.
  `prepareChatTurn` resolves the thread ownership, seeds the title, loads the
  analysis status, and assembles the message array. It has none of the transport.
  The caller runs `runAgent` with its own `emit`, then it persists the turn with
  `appendTurn` (`memory/thread-history.ts`). A turn is
  `prepareChatTurn → runAgent → appendTurn`. The host wraps this in its own
  request handler, because the harness ships no HTTP route layer.
- **Run-event stream**: a single DBOS-backed stream for each workflow. The
  workflow bodies produce it, and a reader of the typed run-event parts of the
  harness (`harness/src/contracts/`) consumes it. There is no standalone route file
  in the harness.
- **Workspace** (`workspace/`): the read surface (`read_file`, `grep`, semantic
  search) is sandbox-independent, and it is available to the conversation agent.
  The mutate surface (`write_file`, `edit_file`, `execute_command`) is
  sandbox-gated.
- **Composition root** (`runtime/assemble.ts`): `assembleCoreRuntime` is the
  host-neutral assembly point. It registers the durable workflows, and it builds
  the conversation agent over them. The local seam realizations that it can be
  wired with carry zero cloud deps, and `index.ts` re-exports them:
  `auth/local-run-authorizer.ts`, `auth/local-auth-context.ts`,
  `billing/noop-resolver.ts`, `billing/noop-run-charge.ts`,
  `execution/noop-artifact-registry.ts`, and the `UnavailablePreviewPublisher` of
  `tools/report/preview-publisher.ts`. Refer to
  [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md).
- **Workflow recovery**: there is no standing component. Each host supplies a
  stable `executorID`. Refer to [`CONTEXT.md`](CONTEXT.md), under
  `Workflow recovery`.
- **Shared contracts** (`harness/src/contracts/`): the Cortex-native chat-stream
  event and data-part types (`CortexChatEvent`, `CortexChatPart`, and the part
  registry). `@inflexa-ai/harness` exports them for a consumer that renders the
  stream.

### Analysis Lifecycle

```
CREATE --> [chat | workflow | ...] --> ARCHIVE (deferred) --> [resume]
```

An analysis is created. Then it enters an active state, where it can handle a chat
message and trigger a workflow. It can be archived, and it can resume later. The
`runId` is minted at the workflow start, at the same point where the
`RunAuthorizer` seam issues the `RunSession`.

### Target Assessment

A separate top-level entity. It is NOT a kind of analysis. It gives snapshot-style
target dossiers. `cortex_target_assessments` and the `executeTargetAssessment`
workflow (`workflows/target-assessment/`) back it. The dossier schema is in
`src/contracts/target-dossier.ts`, and it is the contract with a consumer. The
coverage discipline is a hard schema invariant: each section that depends on
enrichment carries `coverage: "available" | "queried_no_data" | "not_loaded"`. A
host chooses how to show the progress to its clients.

### Memory

The thread history, the working memory, and the absence of semantic recall are in
[`CONTEXT.md`](CONTEXT.md), under `Memory`.

**File discovery**: an agent finds a file with the workspace vector semantic
search. The file descriptions are embedded into pgvector at write time. A vector
entry has consistent `type` metadata (`"input"`, `"output"`, `"summary"`,
`"synthesis"`, `"profile"`) for a filtered search. The search gives the paths, the
descriptions, and the metadata. An agent must then call `read_file` separately.

### Prompt Design Principles

The agent prompts are in `prompts/`. Each prompt obeys these conventions:

1. **No run-order assumptions.** An agent must never assume that it operates on a
   first run. Search broadly for what exists before you continue.
2. **Anti-patterns are explicit.** Each prompt has a "Do NOT" section that lists
   the specific failure modes. When you edit a prompt, always maintain and extend
   those lists. To tell an agent what not to do is as important as to tell it what
   to do.
3. **What the agent was handed is authoritative. Look further only where it is
   thin.** There is no unconditional orient-first pass. The **briefing** of a
   sandbox step is its first user message, composed at dispatch
   (`prompts/briefing.ts`). It already names its task, its working directory, the
   analysis root, the dataset, and what each completed dependency produced and
   where. The prompt tells it not to derive any of that again:
   - no filesystem hunt for its inputs
   - no second read of an upstream summary that it was handed
   - no second derivation of the organism from the raw bytes.

   The conversation agent obeys the same rule. When the tool results of a prior
   turn are still in its context, it does not do a search again. It does not orient
   again. To reach further is *targeted*:
   `inspect_data_profile` when the orientation is thin, `read_file` on an upstream
   summary whose excerpt was not enough, and `workspace_search` for a file that
   nothing named.
4. **Search, then read, then act.** The semantic search discovers, `read_file`
   inspects, then the agent acts. The search gives descriptions and metadata, not
   file contents.
5. **A sandbox agent knows its tools.** The shared sandbox-agent composition is in
   `agents/sandbox/shared.ts`. It has the always-on substrate (the workspace read
   and mutate surface, plus `inspect_data_profile`) and the `meta.tools` allowlist
   of the agent. An environment lookup is **conditional and narrow**, and never a
   catalog dump up front: `list_available_packages` before an import of a package
   that the agent is not sure is staged, and `list_available_refs` narrowed to the
   collection that it needs. There are no assumed paths, no runtime installs, and
   no network.
6. **The persisted data profile is the one record of what the data is.** No
   profile file exists on disk, because the scratch tree of the profiler is
   deleted on completion. Thus nothing hand-types a data context. The conversation
   agent reads it with `inspect_data_profile` and passes that into
   `generate_plan`. The seed of a step carries a bounded projection of the same
   persisted profile, composed at dispatch (`app/data-profile-orientation.ts`). A
   vague context still produces a vague plan, but the cure is the profile, not
   prose.
7. **A per-step value rides in the seed, never in the system prompt.** The
   `systemPrompt` of a sandbox agent is a pure function of its agent type. It is
   byte-identical across each step of each run, thus the prompt cache of the
   provider can reuse the prefix of about 20k characters. One interpolated path or
   id makes the prefix of each step unique, and each step then pays a full cache
   write and reads nothing back. The paths, the dataset, and the dependency
   handoffs belong in the briefing.
8. **A prompt names a tool. It never names data.** The prompt layer has the
   *mechanism*: which tool to reach for, and when. It states the rules that
   constrain it, for example "never assume a reference path exists and never
   hardcode one". It must not list a specific dataset and it must not promise a
   format. The prompt is a cached constant, but the environment is not. Thus a
   roll-call of what is provisioned goes stale the moment that the provisioning
   changes. A format promise is simply false for a store that ships something else.
   Describe the capability, and let the tool give the specifics.

   The `description` of a tool is prompt surface too, and it carries the same
   obligation. It must teach the caller to search by what the data *is*. Anything
   that teaches a search by location has published an installer detail as an
   interface. Invest in it: **a tool is self-describing at attach time**. Thus its
   `description` is the whole of what an agent knows about it. That is also the
   reason that nothing downstream must restate it, and what lets `skills/` name a task
   without a name for a tool. Refer to the root [`CLAUDE.md`](../CLAUDE.md).

## Storage Layout

The tree of each analysis is rooted at the host directory that the
`resolveWorkspaceRoot(resourceId)` seam of the embedder gives — the
workspace-root-resolution spec. The harness has the layout *inside* the root, and
the embedder has *where* the root lives. A host path carries no `{resourceId}`
segment, but a sandbox still sees the tree mounted at `/{resourceId}`, because a
bind mount decouples the two.

```
{resolveWorkspaceRoot(resourceId)}/
+-- data/                        # Input data (immutable, staged by the embedder)
|   +-- inputs/{fileId}/         # Per-file directories
+-- runs/{runId}/                # Workflow run directory
|   +-- synthesis.json           # Literature-grounded run synthesis
|   +-- {stepId}/                # Step artifacts
|       +-- scripts/             # Generated analysis scripts
|       +-- output/              # Analysis output files (includes summary.md)
|       +-- figures/             # Plots and visualizations
|       +-- logs/                # Execution logs
|       +-- notebooks/           # Generated notebooks
+-- reports/{reportId}/          # Report output
+-- previews/{previewId}/        # Iterative report previews (shared assets/ + v{N}/)
```

The file scratch of the data profiler is under `runs/data-profile/`, and it is
wiped when the profiling completes. Its durable products are the vector index and
`cortex_analysis_state`, not files.

The harness uses Postgres, with `pg` directly and pgvector. The DBOS system DB
carries the workflow state, the step cache, and the durable streams. The app tables
(`cortex_runs`, `cortex_step_executions`, `cortex_artifacts`,
`cortex_target_assessments`, `messages`, `cortex_working_memory`) are thin ledgers.
The rich data (the summaries, the findings, the file descriptions) is in files and
in the vector index, not in DB columns. The connection parameters come from
`DB_PG_HOST`, `DB_PG_PORT`, `DB_PG_NAME`, `DB_PG_USER`, `DB_PG_PASSWORD`, and
`DB_PG_SSLMODE`. `lib/storage.ts:createPool()` has the app pool, and DBOS has a
separate pool
([postgres-storage-backend](openspec/specs/postgres-storage-backend/spec.md)).

## Debugging

**Harness logs**: the harness writes each diagnostic to the `Logger` that the
embedder injected. It has no sink and no level filter, thus the verbosity and the
destination belong to the host. The cli routes its pino at `LOG_LEVEL` into
`~/.inflexa/logs`, and on into OTLP when the user consents to telemetry. An
embedder that wires no logger gets `createNoopLogger()` and sees nothing. If the
harness records are absent completely, examine the composition root before you
suspect the harness.

A record carries a `[module]` prefix from `named(...)`, and it carries its
identifiers as structured fields (`runId`, `stepId`, `analysisId`, `execId`,
`sandboxId`, `agentId`). Filter on the fields, not on the message text.

A step failure logs its cause ONLY here. `failStep` scrubs the error before it
reaches `cortex_step_executions.error`, the run panel, or the re-raise of the
parent. Thus the log line is the sole account of why a step died. A body emits
again on a DBOS replay, thus dedup by `runId` and `stepId`, not by a line count.

**Sandbox failures**: sandbox-server logs a failed command with its exit code and
its stderr. The run-event stream surfaces a `step-activity` failure. For the local
Docker backend, examine it with `docker logs <container>`.

**Workflow recovery**: the in-flight workflows of a host that terminated or
crashed are recovered when a host starts again under the same stable `executorID`.
DBOS then reclaims its own `dbos.workflow_status` rows at launch
([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)). An
operator-facing recovery control, if there is one, belongs to the embedder.

## Error handling — neverthrow with an exception-speaking core

Failure is modeled as a `Result` or `ResultAsync` value (neverthrow). But the
durability engine underneath speaks exceptions: **DBOS records a step as failed —
and retries or fails fast — only on a thrown exception.** A `Result` err that
crosses `DBOS.runStep` as a *return value* is durably cached as a successful step,
and it replays as a success forever.

The full house rules are at the top of `src/lib/result.ts`. There are two
sanctioned bridges:

- `unwrapOrThrow(result)` (`src/lib/result.ts`) — the canonical bridge from Result
  to throw. Use it only inside a DBOS workflow or step body, inside a tool
  `execute` body (the dispatch catch of the loop maps the throw to an error tool
  result), and at a throw-protocol driver edge. Never use it in composable domain
  logic. There, keep the `Result` flowing.
- `resultStep` (`src/loop/run-step.ts`) — the composed seam that the agent loop
  uses (`runStep` plus `unwrapOrThrow`).

The `must-use-result` lint rule is patched in `eslint.config.js` to recognize
`unwrapOrThrow(...)` as a consumer of its Result. Do not rewrite a bridge site into
an inline `.match` plus throw form. Do not add a per-site lint disable for it.

## Code Comments

A comment describes the **current state** of the code, not its history. Do not
leave a comment that explains what the code *used to do*. Do not explain why the
current change was made against the prior version, and do not explain what was
removed. That context belongs in the commit message and the pull request
description. In the code it rots the moment that the next change lands.

If the only thing that a comment can say is "this used to be X, now it is Y" or
"changed from X because Y", delete the comment. If the current state is obvious
from the code, no comment is warranted. Write a comment only when a future reader
would genuinely be surprised or misled without it: a hidden constraint, a
non-obvious invariant, or a workaround for a specific bug.

## Testing

**Test the state, not the interactions.** Assert on the returned values and on the
database state. Do not assert that method X was called N times with arguments Y,
because that couples a test to an implementation detail.

**Postgres testcontainer**: a test that touches the database uses
`withSchema(testName)` from `__tests__/setup/postgres.ts`. The helper starts one
`pgvector/pgvector:pg18` container for each `bun test` run. The cold start is about
3 seconds on first use, and each subsequent test file uses the same container. The
helper hands each test an isolated schema, scoped through `search_path`.

Set `CORTEX_TEST_PG_URL=postgres://cortex:dev@localhost:5433/cortex` to skip the
container startup and point at a local Postgres, for instant feedback during tight
iteration. The container fallback needs a reachable Docker API socket. The ryuk
reaper container of testcontainers does not come up under podman. Thus a bare
`bun test` on a podman host errors out the whole DB and DBOS portion of the suite,
not only one file.

There are two supported local routes. `bun run test:full` starts the one container
itself and reaches podman through its docker-compat socket. As an alternative,
export `CORTEX_TEST_PG_URL` at a Postgres that already runs.
`TESTCONTAINERS_RYUK_DISABLED=true` forces the fallback through as a last resort,
at the cost of one unreaped container for each DB test file.

A harness module receives its `Pool` as an injected construction dep
(`createPool`). Thus a test passes the schema-scoped test pool directly into the
factory under test. There is no global pool accessor and no test-override seam.

**DBOS testcontainer**: a test that needs a launched DBOS engine uses
`setupDbosForTests` from `__tests__/setup/dbos.ts`. The rig launches lazily, shares
one DBOS engine across `bun test`, and carves out a fresh cortex schema for each
test with `withSchema()`. Use it for a workflow test or a runtime-shape test. A
pure body-level unit test must stay on `passthroughStep`.

**Integration tests** (`__tests__/integration/`): they hit a real external API with
canonical queries. There is one file for each API provider under
`__tests__/integration/`. Assert on the response structure and on field presence,
not on exact values. A tool that needs an API key that is not set is skipped
automatically, through `describe.skipIf(!process.env.KEY_NAME)`.

## References

- **Context glossary**: [`CONTEXT.md`](CONTEXT.md) — the operative domain language
  and the load-bearing patterns.
- **Specs and ADRs**: [`openspec/specs/`](openspec/specs/) — the feature
  specifications, and the source of truth for the design decisions. The ADR
  rationale is here. There is no `docs/adr` and no `docs/`.
- **Package README**: [`README.md`](README.md) — the surface that an embedder faces,
  and how the harness executes.
