# Cortex Harness — context glossary

The domain language and the load-bearing architectural patterns of the OSS agent
harness. The hard decisions and their reasons are in the OpenSpec specs under
`openspec/specs/`, which is the source of truth for the harness design decisions.

## Domain

- **Analysis** — A long-lived, resource-scoped entity. It has a conversation
  thread, an input-file tree under `data/inputs/` (refer to **Input staging**),
  and zero or more runs. Its identifier is `analysisId`, which is also the
  `threadId` and the `resourceId`. Its lifecycle is
  `created → active ↔ suspended → archived`.
- **Input staging** — The **embedder** fills the `data/inputs/` tree of an
  analysis. This work happens *before* a call to the harness, and it is not the
  work of the harness ([data-profile-init](openspec/specs/data-profile-init/spec.md)).
  The workflows and the tools of the harness expect a full tree. **The harness has
  no staging seam, and no harness code calls stage.** The local CLI stages a file
  when it copies or links a local file in its own repository. An input is
  immutable, and it is staged one time only, thus a recovered run finds the tree
  in place. Staging is not a durable step. `executeAnalysis` reads the tree
  directly. `runDataProfile` receives the staged-input manifest (`StagedInput[]`,
  the one staging *type* of the harness) in its workflow input. The embedder
  handles a staging failure, and it marks the profile `failed`.
- **Run** — One execution of a workflow against an analysis. Its identifier is
  `runId`, a bare UUID that *is* the DBOS `workflowID`. There is no composite
  prefix and no separate `workflow_id` column. A run has a run directory at
  `runs/{runId}/` in the workspace tree of the analysis, with one subdirectory for
  each step. The `runId` and the durable `RunSession` are minted at the async edge,
  before `DBOS.startWorkflow`. The session rides in the workflow input, and DBOS
  replay builds it again on resume.
- **Step** — One node in an analysis plan DAG. Each step runs in its own sandbox
  container. The DAG is **dependency-gated and budget-admitted**. The parent
  workflow starts the child workflow of a step under two conditions. Each of its
  `depends_on` steps must be complete. The machine resource budget must have
  capacity for the declared resources of the step.

  The budget is a snapshot in the workflow input at launch,
  when the embedder configures one. There is no wave batching. With no budget,
  each step with satisfied dependencies starts immediately. A step that has its
  dependencies but waits for capacity is emitted as `queued` on the dag-state
  part. A step that waits for a dependency stays `pending`. A topological *level*
  can be computed for the UI, but it never gates the execution. A step ends in one
  of three terminal states:
  - **`completed`** — the agent stored its deliverables and ended cleanly.
  - **`blocked`** — the agent called `report_blocker` to declare, with a reason,
    that it could not do the step. This is a distinct, honest terminal status.
  - **`failed`** — an unexpected error.

  The execution is **fail-fast**. The first step that is `failed` *or* `blocked`
  cancels the siblings that still run, and it stops the schedule of new steps.
- **Step deliverable** — The output of a step is its **persisted files**: the
  scripts that it wrote (`scripts/`), the data that those scripts computed
  (`output/`), and the figures (`figures/`). The conclusions come from those
  computed output files, which come from the input data. A conclusion never comes
  from the stdout of `execute_command`. An agent that cannot make those files
  calls `report_blocker`, and it does not improvise an inline result. The harness
  does not conclude that something went wrong from a count of the outputs. Honesty
  is structural, because the blocker tool gives it, and a real error shows as
  `failed`.
- **Blocker** — The terminal escape hatch. An agent calls
  `report_blocker({ reason })` when it genuinely cannot do its work. Examples are
  absent data, a tool that is not available, and a broken environment.
  The model is the `report_blocker` of the synthesizer (the shared `OutcomeHolder`
  mechanism). For a **step** agent it gives the `blocked` status and it fails
  fast. For the **synthesizer** it gives a `skipped` outcome that is not fatal,
  because the analysis steps already delivered. Interpretive aggregation that
  honestly has nothing to add is not a run failure.
- **Sandbox** — An ephemeral container that runs the sandbox HTTP worker. The
  harness submits a command with a signed `POST /exec`, then it gets the result
  through one of two **transports** (refer to the next entry). It does not hold a
  long-lived `/exec` stream. `GET /exec/{execId}` gives the terminal result, and
  the sandbox signs it fresh at request time. This is the poll primitive in poll
  mode, and the recovery pull in callback mode.
- **Transport (`SandboxTransport`)** — How the progress events and the terminal
  result of a command come to the host: **`poll`** (the default) or
  **`callback`**. It is backend-independent. The embedder selects it at its
  composition root, and it goes to the container as `SANDBOX_TRANSPORT`.

  In **poll** mode the host polls `GET /exec/{execId}?since={cursor}` for a signed
  `{ status, events[], cursor, result? }`. The sandbox initiates nothing and needs
  no egress. On Docker an in-container `iptables -P OUTPUT DROP` firewall confines
  it: a root entrypoint with `CAP_NET_ADMIN` installs the rule, then `setpriv`
  drops to uid 1000. The exec port is published to `127.0.0.1` only. The poll loop
  is durable, and its per-attempt step names are unique
  (`sandbox.poll-exec-result.${execId}.${n}`). A dead sandbox in poll mode fails
  fast in the loop. Sustained
  `unavailable` polls escalate to a durable `isAlive` probe
  (`sandbox/liveness.ts`), and a machine that is dead gives the synthetic-failure
  result without a wait for `step.timeout`. The synthetic-complete of the watchdog
  is the callback-mode path.

  In **callback** mode the sandbox POSTs signed callbacks to `CORTEX_BASE_URL`,
  and the embedder runs the ingress. `awaitExec` uses `DBOS.recv`, with the pull
  as its recovery backstop. There is no gateway sidecar and no `--internal` network,
  because the two transports removed the contradiction that the gateway existed to
  reconcile. The local CLI defaults to poll.
- **Active-sandbox registry** — The set of sandbox machines that are bound to a
  running step at this time. It is a projection over `cortex_step_executions`: the
  rows with a non-null `sandbox_ref` and `status='running'`. `state/active-sandboxes.ts`
  has it. `sandbox/create-sandbox.ts` writes a row when it mints a machine, and
  the teardown clears it. The liveness watchdog (`sandbox/watchdog.ts`) enumerates
  the registry, shards it, and fans out one `isAlive` check for each shard. An
  entry that is dead but not complete unblocks the recv with a synthetic
  failure-`complete`.
- **Orphaned sandbox** — A sandbox machine that runs in a configured backend, but
  nothing in the harness refers to it: no registry row, and no DBOS step-cache
  entry. It comes from a process that dies after the backend creation but before
  the `sandbox.create` step checkpoint. The registry-driven watchdog cannot see it.
  Only a backend inventory sweep finds it.
- **Stale registry row** — A `cortex_step_executions` row that is still
  `status='running'` with a `sandbox_ref`, but the workflow that owns it is
  terminal. This is usually a sibling that fail-fast canceled, because a
  cancellation runs no teardown, thus the machine can still run too. The watchdog
  sees it as dead and skips the synthetic send, because the workflow is not
  PENDING or ENQUEUED. The **sandbox reaper** clears it, not the watchdog.
- **Sandbox reaper** — A `@DBOS.scheduled` workflow (`sandbox/reaper.ts`,
  registered beside the watchdog) that cleans up an orphaned sandbox and a stale
  registry row. It is distinct from the liveness watchdog: it sweeps
  **backend→registry**, the watchdog sweeps registry→backend. It is unsharded, and
  it runs on a slower cadence. It lists the sandbox machines with
  `SandboxClient.listManagedSandboxes()`, and it reads the workflow metadata of the
  owner. On a terminal or missing workflow status it tears the machine down and it
  reconciles the row. It keys off the workflow status, which is written at enqueue
  before the machine exists. Thus a creation that is in flight is never an orphan.
  The cleanup is separate because DBOS does not permit a teardown step in a
  canceled workflow ([harness-sandbox-exec](openspec/specs/harness-sandbox-exec/spec.md)).
- **Workspace** — The analysis file tree and the vector index under one consistent
  path model that each agent shares (refer to **Workspace path model** below). The
  host root of the tree comes from the `resolveWorkspaceRoot(resourceId)` seam of
  the embedder ([workspace-root-resolution](openspec/specs/workspace-root-resolution/spec.md)):
  the embedder has *where* the tree of each analysis lives, and the harness has the
  layout inside it. A sandbox always sees it at `/{resourceId}`. The workspace has
  two surfaces with different requirements:
  - **Read surface** (`WorkspaceFilesystem`) — `read_file`, `list_files`,
    `file_stat`, `grep`, and the semantic `workspace_search`. It operates on the
    file system and the index directly, and it is **sandbox-independent**. It is
    available to an agent with no sandbox. The conversation agent reads and
    searches the workspace and never holds a sandbox.
  - **Mutate surface** (`WorkspaceMutator`) — `write_file` and `edit_file`, plus
    the raw `execute_command` chokepoint. It is **sandbox-gated**. `write_file`
    and `edit_file` resolve the path, confine it to the writable working directory
    of the agent, write through the sandbox, and record the provenance. All of
    that is behind the one `WorkspaceMutator` seam, and no tool does it again.
    `execute_command` defaults its `cwd` to the same working directory.
- **Workspace working directory** — Each agent run has one writable **working
  directory** that the composition root supplies. A plannable step gets
  `runs/{runId}/{stepId}`. The data profiler gets `runs/data-profile/profile`. A
  report-session derivation gets `report-sessions/{threadId}/derived`. The conversation agent gets the analysis
  root, which is read-only, because chat cannot write. The working directory is
  the `cwd` of `execute_command` for that agent, and it is the confinement root
  for its writes.
- **Workspace path model** — One resolution rule across each file tool
  (`read_file`, `list_files`, `file_stat`, `grep`, `write_file`, `edit_file`,
  `execute_command`) and the scripts that agents run:
  - **A relative path is frame-local.** It resolves against the working directory
    of the agent. `output/x.csv` names the same byte when a script writes it, when
    `write_file` writes it, and when `read_file` reads it again.
  - **An absolute `/{resourceId}/…` path is canonical and frame-independent.** It
    ignores the working directory and resolves against the analysis root in each
    frame. This is the interchange format. A path that crosses an agent boundary
    or a frame boundary MUST be absolute. Examples are a path passed to a
    sub-agent, a path stored in working memory, and a path in a plan.
  - **A read roams, but a write is confined.** A read resolves anywhere in the
    analysis tree, and it is read-only outside the working directory. A write
    outside the working directory gives `out_of_prefix` with no I/O. A path out of
    the tree or in a different analysis gives `out_of_scope`.
  - The reserved artifact-subdir names (`scripts`, `output`, `figures`, `logs`,
    `notebooks`) MUST NOT be step ids. Plan validation rejects them, thus a step
    directory never collides with a subdir convention. Refer to
    [harness-workspace-tools](openspec/specs/harness-workspace-tools/spec.md).
- **Target assessment** — A separate top-level entity. It is NOT a kind of
  analysis. It is a snapshot-style target dossier. `cortex_target_assessments`
  holds it, and it runs the `executeTargetAssessment` workflow. Its schema is in
  `src/contracts/target-dossier.ts`.
- **Skills** — Runtime knowledge packs (`skills/<name>/SKILL.md` plus
  `references/`). Each agent declares them with `AgentMeta.skills`, and the
  `skill_search` and `skill_read` tools surface them to a sandbox agent. The
  search is by keyword, not by vector. `shared/omics-general` loads for each
  analysis agent.
- **Package store** — The host directory with the pool, the farms, and the
  graph, mounted read-only at `/mnt/libs`. The sandbox images bake no analysis
  package: the store is the one source of a library. The term replaces
  "lib store" everywhere.
- **Pool** (`store/`) — The content-addressed directories of the store, one
  per installed distribution, write-once. Ten analyses that use one package
  version share one copy.
- **Store-directory markers** — Two one-line files inside each pool
  directory. `.inflexa-pin` holds the request identity, `name==version`.
  `.inflexa-hash` holds the full sha256 of the sorted tree, because the
  directory name carries only its first 16 characters. The content hash and
  the farm links exclude the markers, and they exclude uv's own `.lock` too.
- **Farm** — The per-analysis symlink tree into the pool. A backend resolves
  it through the required `farmSource` config at each `createSandbox`, and it
  mounts as a second read-only bind nested inside the store bind. Under
  `toolchainSource: "image"` the farm container path is `/mnt/libs/farm`.
  Under `"store"` (or absent) it stays `/mnt/libs/current`, because the baked
  resolvers of the old images name it. A farm carries exactly one metadata
  file, `inflexa.lock` — the mount gate and the package inventory read it.
- **Farm source (`farmSource`)** — The required backend config field that
  names where the farm of an analysis comes from. `fixed` names one farm for
  every analysis (the managed shape). `per-analysis` supplies a resolver of
  the embedder. The harness never invents a farm location.
- **Toolchain source (`toolchainSource`)** — The declared owner of the
  sandbox toolchain: `"image"` (conda at `/opt/conda`, Node at `/opt/node`)
  or `"store"`, with absent as `"store"`. It keys the resolver env and the
  orient-core prompt text. The harness never infers its host.
- **Catalog** — The published default package set that the store download
  delivers, as the farm `farms/catalog` with its prepared caches.
- **Graph** (`deps.json`) — The resolved dependency edges at the store root.
  `emit_deps.py` of the provisioner writes it, and a farm composition walks
  it as a lookup, never a resolution.
- **Provisioner** — The network-enabled container
  (`images/sandbox-provisioner`) that writes the pool and the farms. Five
  subcommands, one mode each: `build`, `acquire`, `prepare`, `reclaim`,
  `remove-farm`. It holds the compilers and an egress allowlist. The runtime
  image holds neither.
- **Acquisition** — An install into the pool, by the provisioner, with no
  farm work. It is two-phase. The run stages its graph nodes in a report
  file, and it never touches `deps.json`. The host commits after the load
  check passes inside the sandbox image.
- **Farm extension (`ExtendAnalysisFarm`)** — The optional seam behind the
  `link_packages` sandbox tool and the pre-launch link pass of
  `execute_analysis`. The realization of the embedder links host-staged
  packages into the farm of the analysis, live, with no restart.

## Session and capability seams

The identity model of the harness is **host-agnostic**. A session carries an
*opaque* auth capability that the harness forwards but never inspects. Each thing
that the harness reaches *outside itself* is an injectable **seam** that the
harness *declares* and an **embedder** *wires*
([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)).
Examples are:

- the issue of a durable run
- the record of an artifact
- the resolution of the call attribution
- the publication of a report-session page.

The OSS build wires a trivial **local realization** for each of them. The harness
never branches on which realization is bound, and a unit test passes a fake.

### Session model

- **Session** — The per-request identity is two lifetime-typed bundles, built from
  immutable value objects (`Identity`, `Scope`, `Credential`, `Provenance`,
  `RunFrame`, `auth`). `RequestSession` is the live request value. It has no
  `RunFrame`, and it MUST NOT be JSON-serialized into durable state. `RunSession`
  is durable and JSON-serializable, it carries a `RunFrame`, and the
  `RunAuthorizer` seam (below) is its only constructor. An async or durable API
  accepts only a `RunSession`, thus async work that starts without an authorized
  run is unrepresentable. A workflow body never authorizes again: the `RunSession`
  rides in the workflow input, and DBOS replay builds it again on resume. A child
  workflow gets its input from `forStep(parent.runSession, stepId)`. The two
  bundles both satisfy the structural `AgentSession` type that the loop and the
  providers consume, and neither carries a resolved call-attribution header. Refer
  to [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md),
  [harness-session-model](openspec/specs/harness-session-model/spec.md), and
  `src/auth/types.ts`.
- **`Identity`** — `{ user }`, always complete. It is the one part of the caller
  identity that the harness itself reads.
- **`Scope`** — A discriminated union that describes what the session acts on:
  `{ kind: "analysis"; analysisId; threadId? }` or
  `{ kind: "target-assessment"; targetAssessmentId; billingContextId }`. The
  harness reads it for the routing and the storage, and the seams key their
  behavior off it.
- **`Provenance`** — `{ agentId; callPath }`, read-only. Code MUST NOT branch on
  `callPath`. It is for the `source` stamp of an event and for sub-agent lineage
  only.
- **`RunFrame`** — `{ runId; stepId? }`, present only inside a workflow run. Its
  presence is what makes a `RunSession` different from a `RequestSession` at the
  type level.
- **`Credential` (opaque)** — A branded value that the harness never reads. The
  harness only ever *forwards* it. The embedder side defines its concrete shape
  fully. The variant that an OSS reader meets is the trivial local one. The brand
  makes the promise "never branch on the credential kind" a type rule.
- **`AuthContext` (the opaque auth capability)** — The `auth` field that each
  session carries, and the **sole source** of the credential and the scope behind
  a session. There is no top-level `orgId` field and no top-level `credential`
  field. The harness forwards it untouched and never downcasts it. An embedder
  adapter can downcast its own concrete shape. The OSS build gives a trivial empty
  `auth` (`makeLocalAuth`, `auth/local-auth-context.ts`), and the local harness
  never inspects it.

### The five seams

The harness declares each seam as an interface. An embedder binds one realization
at the composition root.

- **`RunAuthorizer`** (`execution/run-authorizer.ts`) — it changes the opaque
  caller `auth` into a durable `RunSession` at the async edge. It is the sole
  constructor of a `RunSession`, thus it is the single chokepoint where the
  in-process identity becomes the durable workflow identity. OSS realization:
  `auth/local-run-authorizer.ts` issues a `RunSession` with no remote mint, no jti,
  and no revoke, thus the authorization is purely structural.
- **`ResolveBilling`** (`billing/resolver.ts`) — it gives a call-attribution
  header map that the provider spreads at the LLM or embedding call site. It
  resolves lazily, only at the wire boundary. OSS realization:
  `createNoopBillingResolver` gives `{}`, an empty header map.
- **`ArtifactRegistry`** (`execution/artifact-registry.ts`) — post-step artifact
  recording with content-attested lineage. `register(input, session)` and
  `sync(input, session)` are the two methods. `register` takes the manifest of the
  step, and `sync` copies its bytes to permanent storage. The two are
  session-scoped, and the adapter authenticates for each run off the session. OSS
  realization: `createNoopArtifactRegistry` registers nothing outside and reports
  zero failures, because the harness itself writes the local `cortex_artifacts`
  ledger around the seam. Its `sync` does nothing, because the bytes are already
  in the local workspace tree.
- **`RunCharge`** (`billing/run-charge.ts`) — the run-level billing bracket that
  `executeAnalysis` opens at the init and closes on the terminal path, for one of
  four reasons. Local realization: `createNoopRunCharge` does nothing.
- **`UsageRecorder`** (`billing/usage-recorder.ts`) — one attributed
  `LlmUsageRecord` for each completed LLM call, delivered from the loop. The
  contract makes it fire-and-forget, thus a realization must not throw and must
  not block. A consumer upserts on the replay-stable `recordKey` of the record.
  Local realization: `createNoopUsageRecorder`
  (`billing/noop-usage-recorder.ts`) drops each record.
- **`RunLauncher`** (`execution/run-launcher.ts`) — it starts a registered
  workflow under an id that the caller chooses. `launch` is fire-and-forget.
  `launchAndAwait` is inline with cancel-on-abort, and a discriminated
  `LaunchOutcome` hides the cancellation. It is the DBOS quarantine seam, and it
  is the reason that `execute_plan` and `run_ephemeral` do not import the
  durability engine. One host-neutral realization, `createDbosRunLauncher`
  (`execution/dbos-run-launcher.ts`), is shared by each embedder.

### Embedder and composition roots

The program that embeds the harness and wires its seams. The harness exports
`assembleCoreRuntime` and the local seam realizations. The host has its transport,
its process bootstrap, and any adapter that is not local.

## Streaming

- **Chat data part** — A typed JSON event that a workflow emits. It is persisted
  in the DBOS-backed stream, and there is no separate JSONB blob. A consumer reads
  the Cortex-native types directly, with no AI SDK mapping.

---

## Architecture

### Workflow scope

- **Chat is in-process**, one host for each turn. The agent loop runs
  synchronously in the request path of the embedder. If the process dies in the
  middle of a turn, the caller sends the message again. There are no DBOS workflow
  rows for chat. Refer to
  [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md).
- **A DBOS workflow** is reserved for a *durable operation*: `executeAnalysis`,
  `executeTargetAssessment`, and the background `runDataProfile`. **Each run that
  a sandbox backs is a DBOS workflow.** A report session is the exception: it
  renders in-process, and it is not a DBOS workflow. There is no in-process sandbox consumer,
  and no in-memory exec transport. A sandbox exec callback routes only through
  `DBOS.send` and `DBOS.recv`.
- **Turn-scoped workflow** — `runEphemeral` is a DBOS workflow with a deliberately
  non-durable flavor. The `run_ephemeral` chat tool starts it. It is **awaited
  inline** with `handle.getResult()`, and it is the only chat tool that blocks on
  a workflow result. It is **canceled** with `DBOS.cancelWorkflow` when the chat
  turn disconnects, and it is **not recovered** after the death of the process:
  before the DBOS launch, the launch path cancels any `PENDING` `ephemeral:*`
  workflow for this executor. Thus a re-run never starts, and no result goes to a
  dead turn. It is a workflow only so that its sandbox callbacks route through
  DBOS messaging like each other consumer. The **sandbox reaper** reaps its
  machine on cancel. Refer to
  [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md).

### Application service layer

- **Application service (`app/`)** — Host-agnostic *ability* functions, lifted out
  of the transport edge so that each embedder can use them again. Each one is an
  `appFn(deps, params) → result` in the shape of `app/chat-turn.ts`. **Deps** are
  construction-time values and seams (`pool`, `provider`, `embedder`, the base
  paths, the model ids). **Params** are call-time (`analysisId`, `runId`,
  `session`, `emit`). The return is a typed result. An app-fn has the ability from
  end to end: load, compute, persist, and emit a *domain* event. It has none of
  the transport:
  - no stream framing and no SSE framing
  - no HTTP status code
  - no DBOS step boundary
  - no choice of the sink that `emit` writes to
  - no choice of the billing that the injected `embedder` carries.

  Its members include `prepareChatTurn`,
  `assembleMessages`, `synthesizeRun`, and `data-profile-policy`.

### Decomposition

- `executeAnalysis` is the parent workflow.
- For each wave there is one **child workflow for each sandbox-agent run**,
  dispatched in parallel with `DBOS.startChildWorkflow`. Each child body is the
  sandbox-agent loop, with one DBOS step for each LLM call and each tool call
  inside it.
- `executeTargetAssessment` obeys the same pattern. Its `.foreach` sub-workflows
  are DBOS child workflows.

### Post-step pipeline

After the sandbox-agent loop of a step returns, the child workflow body
(`sandbox-step.ts`) runs a **typed post-step pipeline**. It walks the writable
artifact tree of the step **one time** into a hashed manifest. Then it threads
that manifest, and the typed output of each stage, explicitly through the body:
`manifest → file-metadata entries / step summary / reconciled manifest → vector
index + step-detail emit`.

A stage output is a value that the body holds and passes downstream
(`PostStepArtifacts`), not shared mutable state. Thus there is no module-global
stash, the producer-to-consumer order is a type constraint, and
`collectStepOutputs` is a pure function of the threaded products.

**An integrity stage fails fast, and an enrichment stage degrades**
([artifact-manifest](openspec/specs/artifact-manifest/spec.md)). Artifact
**registration** and **sync** are content-attested lineage: a drift, a
whole-activity rejection, or an input that cannot be hashed is terminal, and it
fails the step loudly. A transient registry error throws, and DBOS retries it. A
registry that is not available is a skip. The **metadata, summary, and
vector-index** stages stay best-effort (`safeRun` and `safeRunValue` log and
degrade), thus a flaky LLM describer never sinks a run of many hours.

The two post-step **LLM producers** (`generateFileMetadata`,
`generateStepSummary`) are wrapped in `DBOS.runStep`, thus their outputs are
checkpointed. The conditional terminal emits that they gate then become
replay-stable, and the LLM calls stop the re-fire on recovery
([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)). The
other stages (walk, reconcile, sync, index) still run inline and run again on
replay. A durable cache for them is a deferred follow-up that the typed returns
make possible.

**File metadata is lossless.** `generateFileMetadata` describes an artifact
through a focused `runAgent` tool-call loop, which mirrors `generatePlan`. The
describer agent calls `submit_file_metadata` keyed **by path**, and the tool
validates each path against the known artifact set. A path that the model
invented is rejected with feedback, and a file with no coverage is reported as
`remaining`. A description matches a file by path, never by array position, thus
a dropped or reordered entry cannot land on the wrong file. Each input artifact
gives exactly one result entry. A file that the model never describes gets a
**deterministic description with no LLM**: the path, the inferred type, and the
size. That fallback is logged, and a file is never dropped in silence and never
chunked out of the index.

### Workflow recovery

There is no standing component (the harness-durable-runtime spec). The embedder
supplies a stable `executorID` to DBOS. When the same executor identity launches
again, DBOS recovery can reclaim the in-flight workflows of its predecessor. The
harness gives no HTTP recovery route. Any operator-facing recovery control belongs
to the host.

### Sandbox exec

Refer to [harness-sandbox-exec](openspec/specs/harness-sandbox-exec/spec.md) for
the protocol and for the callback auth.

Two distinct lifetimes. Do not conflate them:

- **Exec command** — one submit, then one recv of the result. There are many for
  each sandbox, and most are near-instant (`ls`, `find`) and make only a finished
  message. `submitExec` POSTs the command with
  `execId = "${workflowId}:${stepId}:${functionId}"`. sandbox-server runs it in
  the background and dedups a duplicate submit by idempotency. The workflow body
  does `DBOS.recv` for the result, bounded by `step.timeout`, because one command
  can legitimately run for hours. **There are no per-exec heartbeats.**
- **Sandbox machine** — one for each step, and long-lived. The sandbox-agent loop
  issues many commands into the *same* container. Its concerns are machine-level:
  did it **start**, and is it still **alive** (not crashed, not OOMKilled, not
  node-lost). The child workflow has the lifecycle (the creation and the teardown)
  as DBOS steps.

Other facts:

- **Events are sandbox-lifetime, on-change, and coalesced.** The sandbox executor
  diffs its working tree and emits an update only when the tree changes, not for
  each exec. A meaningful progress event flows on this path:
  - from the sandbox to `POST /sandbox/:execId/event`
  - to `DBOS.send` on the per-exec topic
  - to the forwarding loop of the workflow body.

  That loop does recv, then it verifies the HMAC, then it does `writeStream`.
- **A sandbox event is folded into a typed per-step part in the sandbox-step
  body.** A raw per-exec event never reaches the observer as it is. One translator
  in the `emit` chokepoint of `sandbox-step.ts` maps it to the typed part that the
  UI renders. The `tool-started` of the agent loop becomes `data-step-activity`
  with phase `executing`. The `describeCall` hook of the called tool phrases it,
  through `createDetailResolver(agent.tools)`. The tool name is the fallback.
  The `file-tree` delta of the executor becomes `data-step-file-tree`: the body
  folds the per-exec `added`, `modified`, and `removed` deltas into a per-step path
  set, and it emits the **full** tree, paths only. Both use a stable per-step
  reconciling id, thus the run-stream fold and the observer collapse them
  latest-wins. The terminal `walkArtifacts` tree reconciles onto the same file-tree
  id at the end of the step. The fold is replay-stable because it is a 1:1 pure
  function of the checkpointed `recv` sequence. There is no Cortex-side timer and
  no debounce, because that would break
  [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md) again.
- **Completion** — the sandbox worker POSTs the final result to
  `/sandbox/:execId/complete`. The host callback handler verifies it and forwards
  it with `DBOS.send` on the same per-exec topic, with a `done` marker. The
  forwarding loop recognizes the marker and returns. One topic, one recv loop, and
  no stuck recv.
- **Liveness is per-sandbox-machine, not per-exec.** The oracle is always the
  backend inspect (`SandboxClient.isAlive(sandboxRef)`), but the transport decides
  who invokes it. A `@DBOS.scheduled` workflow fans out over the *active
  sandboxes* (the registry is the `cortex_step_executions` rows with a
  `sandbox_ref` and status running). It is sharded, thus no single invocation
  polls each sandbox. On dead with no completion recorded it sends a synthetic
  failure-`complete` to unblock the recv, which is the callback mode. In poll mode
  the await loop is its own fail-fast: sustained `unavailable` polls escalate to a
  durable `isAlive` probe (`sandbox/liveness.ts`), and a dead machine gives the
  synthetic failure in the loop. Same oracle, same result constructor, and no
  topic. Recovery also checks the liveness again before a recovered child continues
  a step. The await that `step.timeout` bounds is the durable backstop, and the
  liveness verdict is the fail-fast.
- **The creation is two durable steps, and the cleanup is a separate reaper.**
  `sandbox.mint` checkpoints the machine identity (`sbx-{run8}-{uuid4}` plus the
  HMAC secret) before `sandbox.create` spawns it. Thus a crash in the middle of the
  creation runs the spawn again. The spawn **adopts** the existing machine, and it
  does not leak a second one
  ([harness-sandbox-exec](openspec/specs/harness-sandbox-exec/spec.md)). The
  **sandbox reaper** is the sole cleanup for the machines that this does not
  cover: a cancellation leak and a scale-down orphan. Refer to its glossary entry
  above.

### Stream model

- One DBOS-backed stream for each workflow. A live consumer and a historical
  replay read the same source.
- No AI SDK format mapping. A consumer reads the Cortex-native typed events
  directly.
- Typed UI parts (RunStarted, DagState, StepActivity, StepOutput, RunCompleted,
  and others). **Each event is persisted, and the fold happens on read**: each
  part is written to the one DBOS stream, and a reconciling event is folded
  latest-wins by `id` on read. Thus the read stays bounded although the storage is
  append-only. The coalescence (no heartbeats, and an on-change tree only) keeps
  the volume tractable on a run of many hours.
- **A run result is pull-only.** The workflow writes nothing to the conversation
  thread on completion. The UI run tracker shows the completion from the stream,
  and the conversation agent fetches the results on demand with `inspectRun`. The
  DAG schedule is dependency-gated and budget-admitted, not wave-batched. Refer to
  [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md) and
  [resource-budgeted-scheduling](openspec/specs/resource-budgeted-scheduling/spec.md).
  The scheduler loop selects the next finished child with **`DBOS.waitFirst`**, a
  checkpointed "who finished first". It does not use `Promise.race` over
  `getResult`. The race winner is not checkpointed, thus it reorders the
  downstream operations that consume a function ID on replay
  ([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)).

### Dependency injection

- **A construction-time dependency** (long-lived, shared, immutable) is injected
  when a module is built: `Pool`, `ChatProvider`, `EmbeddingProvider`, `Logger`,
  the `SandboxClient` factory, and the five seam realizations. **A call-time
  value** (request-scoped) is passed as an explicit parameter: `Session`,
  `AbortSignal`, and `EmitFn`.
- A module is a **factory closure**: `createX(deps) => { op1, op2 }`. A module
  with one operation is a free function that takes the deps as leading
  parameters. There are no classes, no god-ctx, no ALS, and no magic-key bag.
- **There is no ambient dependency accessor.** A process composition root
  constructs `env` and `pool` one time, and it threads them as constructor deps.
  No module reaches for a dependency. `getPool()` is a pool factory and a test
  seam, not a hidden request context. The conversation-agent factory is a nested
  composition root: it receives its deps from the root and explodes them apart for
  each tool. `ToolContext` is `{session, signal, emit, runStep}`, which is
  request-scoped seams only, with no injected deps.
- **A process fact is exempt.** State that is one for each process, write-only,
  and never faked stays module-level: the `lifecycle.ts` draining flag, the
  `otel.ts` init guard, and the OTel instrument handles. Injection of it buys no
  testability. A dependency is something that you can swap or fake. A process fact
  is a truth that is one for each process. Refer to
  [harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md),
  and to the 2026-05-29 amendment in it.

### Loop primitives

- **`ChatProvider`** — AI SDK-backed. The AI SDK `ModelMessage` is the lingua
  franca of the harness everywhere: the loop, the memory persistence, and the DBOS
  step cache. Signed provider metadata (an Anthropic thinking signature, a cache
  control) rides provider-scoped in `providerOptions`. A provider is built from an
  AI SDK `LanguageModel` instance that the embedder supplies, or from an endpoint,
  key, and model configuration (`anthropic` or `openai-compatible`). It advertises
  `capabilities.toolCalling`. Refer to
  [harness-providers](openspec/specs/harness-providers/spec.md). It has two
  methods:
  - `chat(req, session, signal?) → ResultAsync<ChatResponse, ProviderError>` —
    non-streaming, for a workflow step and an out-of-band call. It is cacheable as
    a DBOS step.
  - `chatStream(req, session, signal?) → AsyncIterable<ChatStreamEvent>` — text
    deltas, then one terminal `done` event. This is the chat loop.

  An output-token truncation shows as the AI SDK `finishReason: "length"`, thus
  the loop sees exactly one truncation signal.
- **`EmbeddingProvider`** — a separate narrow interface for the embeddings, and
  `providers/types.ts` declares the two provider interfaces. It
  takes a `Session`.
- **`defineTool({id, description, inputSchema: ZodSchema, execute(input, ctx) => result, executionMode?, describeCall?})`**
  — `ctx` is `ToolContext = {session, signal, emit, runStep}`, which is
  request-scoped seams with no deps. `tools/define-tool.ts` has it. The
  `z.toJSONSchema()` of Zod 4 emits the tool input schema that the AI SDK accepts:
  a top-level object only, and it rejects a union at construction. `runStep` is the
  durability seam that a tool
  uses to wrap its own durable work: it is a passthrough in chat and
  `DBOS.runStep` in a workflow, and the loop namespaces the name under the step
  name of the tool. A tool that carries deps is a factory closure
  (`createXTool(deps)`) that captures the deps and calls `defineTool`. Each tool
  declares an **`executionMode`** or defaults to one: `step`, `workflow`, or
  `inline`. Refer to *The loop*. The error contract: an expected outcome, which
  includes "not found", is a data variant of the result type. An unexpected
  failure throws or gives `err(ToolError)`, and the loop maps it to a
  model-visible error tool result. A Zod input-validation failure gives an error
  tool result at the boundary, without a call to `execute`.
- **`describeCall(input) => string` is the call-time counterpart of
  `description`** (the `tool-call-detail` capability). `description`
  self-describes the tool at attach time. `describeCall` self-describes one
  invocation, thus a surface renders four `update_working_memory` calls as four
  distinct lines. It is optional, synchronous, pure, and typed against
  `z.infer<Schema>`. It is colocated with the schema, because that is the one
  place where the compiler checks the two against each other. The loop computes
  the detail best-effort at dispatch: it does `safeParse` on the raw model input
  first, and it calls the hook only on success. A `tool-started` event is emitted
  BEFORE dispatch-time validation, thus the value there is unvalidated. It
  guards the call, and it drops the detail on any failure. The normalization
  happens one time at the emit site, never in tool code: one line, control
  characters stripped, secrets redacted, and a cap of 120 characters. A host
  renders the string and parses nothing out of it. `createDetailResolver(tools)`
  maps a tool name and an input to a detail, for the surfaces that hold a name
  rather than a `Tool`: the reload conversion, and the sandbox and data-profile
  activity lines. The caller supplies the tool list, because a tool that comes
  through the host-tools seam is invisible to any map that the harness holds.
  Nothing is persisted, thus the storage stays the pure model transcript.
- **`tool-finished` reports `outcome: "ok" | "error" | "denied"`**, not an error
  boolean ([harness-agent-loop](openspec/specs/harness-agent-loop/spec.md)). The
  loop already separates a denial from a recoverable tool error in the control
  flow, because a denial hard-stops the turn. Thus the observation channel carries
  the same distinction, and a user who rejects an approval no longer sees their
  own decision reported as a fault. It is one three-state field, not two booleans,
  which would admit the impossible "not an error, but denied".
- **There is no processor pipeline.** The SOUL kernel and the conversational
  personality are a static `systemPrompt` composition in the agent definition. The
  input sanitization (`normalizeUnicode`, a trimmed `redactSecrets`) is two
  functions, applied one time to the user input in the chat route. The analysis
  context is injected at the message assembly of the chat route.
- **Sub-agents** — exposed as regular tools. The `execute` of such a tool calls
  `runAgent(subAgent, prompt, childSession)`, where `childSession` derives the
  agentId and the callPath from the parent, through
  `forSubAgent(ctx.session, childAgentId)`. The examples are `literature-reviewer`
  and `analogical-reasoner`. There is no special delegation
  primitive and no message stripping. A sub-agent transcript is ephemeral. The
  workflow-decides path uses `runAgent` directly, with no tool wrapper.
- **The loop** (`loop/run-agent.ts`) —
  `runAgent(agent, messages, session, {signal, emit, runStep}) → { messages, finish }`,
  where `finish = { reason, cappedOut, truncationRecoveries }`: the terminal
  finish reason, whether the iteration cap was hit, and how many truncations were
  recovered. `runStep` is injected: a passthrough in chat, and `DBOS.runStep` in a
  workflow. The loop emits orchestration events stamped with `source` from
  `session.callPath`. At the iteration cap it forces a final tool-less wrap-up
  call, and it does not throw. A `finishReason: "length"` truncation is a
  **recoverable soft-error, not a stop**. Only the final content part can be
  truncated. Thus the loop does **not** execute a truncated trailing tool call,
  because its input can be incomplete in silence. It feeds back a retryable error
  tool result and continues: an earlier complete tool call still dispatches, and
  truncated prose gets a steer-and-continue turn. Thus a truncated write never
  lands a partial file. The step names (`llm-${i}`, `tool-${name}-${id}`) are a
  documented, deterministic contract. Refer to
  [harness-thread-store](openspec/specs/harness-thread-store/spec.md).
- **Execution-mode partitioned dispatch**
  ([harness-tools](openspec/specs/harness-tools/spec.md)). The dispatch obeys the
  `executionMode` of each tool. A `step` tool is the default: the ~35 external bio
  and chem API tools, and the workspace reads. Each is wrapped in a deterministic
  `runStep` and runs concurrently (`Promise.all`), and each reserves one function
  ID synchronously in array order. A `workflow` tool runs sequentially **after**,
  unwrapped in the workflow body, thus its internal `DBOS.recv` and `writeStream`
  (body-only) are legal. These are exactly `execute_command`, `write_file`, and
  `edit_file`, which have their own durability: the submit is a step, and the recv
  is a body call. They reserve multiple function IDs across awaits, thus
  concurrent ones would race the counter. An `inline` tool is pure deterministic
  logic and runs unwrapped. The results are assembled by the original index, thus
  the tool-result order holds. The loop emits (`iteration`, `tool-started`,
  `tool-finished`) are awaited, thus each body-path `writeStream` lands at a
  deterministic function ID on replay
  ([harness-durable-runtime](openspec/specs/harness-durable-runtime/spec.md)).

### Memory

- **Thread history** — the `messages` table. A row stores an AI SDK model message
  in a versioned envelope (`{kind: "ai-sdk-model-message", aiSdkMajor, message}`).
  A legacy Anthropic row is backfilled at startup. `appendTurn` writes a turn
  atomically. `loadRecent` walks newest-first to a token budget, and it snaps the
  window to a valid turn boundary, thus it never gives an orphan tool-result
  continuation. It is conversation-scoped.
- **Working memory** — `cortex_working_memory`, one JSONB row for each analysis.
  It has four sections: `goal`, `constraints`, and `hypotheses` are analysis-flat,
  and `findings` is run-scoped, keyed by `runId`. The agent maintains it section by
  section with one `updateWorkingMemory` tool, and it does not rewrite the whole
  blob. It is rendered to Markdown and injected as a user message in the window
  tail, which is cache-safe.
- **There is no semantic recall.** A conversation operates inside the
  token-bounded thread window only. Refer to
  [harness-thread-store](openspec/specs/harness-thread-store/spec.md).
- **Workflow and sandbox agent loops** — no `messages` table. The durability is
  the DBOS step cache, and the debug method is read-side reconstruction from
  `dbos.operation_outputs`. Refer to
  [harness-thread-store](openspec/specs/harness-thread-store/spec.md).

### Call attribution at the wire boundary

- The session is the compile-time obligation. `ChatProvider.chat(req, session, signal?)`
  and `EmbeddingProvider.embed(texts, session)` both take an `AgentSession`, thus
  you cannot construct a wire call without one. The provider resolves the call
  attribution internally, with its injected `resolveBilling(session)` seam at call
  time. Then it spreads the header map that the seam gives onto the request. The
  OSS realization gives an empty map.
- There is no ALS, no fetch-patch, and no wrapper. A read-only route never
  resolves the attribution, because the seam is lazy and fires only at the LLM or
  embedding call site.
- A background task (a data profile trigger, an async memory write) and the
  `run_ephemeral` chat tool construct an explicit `RunSession` through the
  `RunAuthorizer` seam and pass it through. The scope is whatever resource the
  task acts against. Ephemeral and data-profile both keep their synthetic
  `RunFrame` literals (`"ephemeral"` and `"data-profile"`) as the run tag and the
  step tag. The unique DBOS `workflowID` does the routing.

### Budget-exceeded resume

Do not conflate the two replay scenarios:

- **Pod-crash recovery** (the harness-durable-runtime spec) replays with the
  **same input**. The `attempt` does not change, thus each step name is identical
  and the whole body hits the cache. This is the common case, and it works with no
  extra work.
- **Budget resume** deliberately **increases `attempt`**, thus the failed LLM call
  fires again against a budget that is now available.

The mechanism of the budget resume:

- The step names carry the attempt as a suffix. `attemptStepNameFormatter` (in
  `sandbox-step.ts`) names the loop steps `llm:${iteration}:${attempt}` and
  `tool:${name}:${toolUseId}:${attempt}`. The parent names its own steps
  `open-running-charge:${attempt}`, `close-running-charge:${attempt}`, and
  `revoke-run-auth:${attempt}`. An increased attempt is a name that the cache has
  never held, thus the call fires fresh.
- On a budget error the caller catches the provider-specific error, calls
  `DBOS.cancelWorkflow(DBOS.workflowID!)`, and returns. The next step boundary
  throws `DBOSWorkflowCancelledError`, and the status becomes **`CANCELLED`**. It
  is not `ERROR`, because `ERROR` is terminal in DBOS v4 and it cannot resume.
  Cortex marks the analysis `suspended` from the status flip.
- On resume, `prepareExecuteAnalysisResume` atomically increases
  `cortex_runs.attempt_count`. Then the caller calls `DBOS.resumeWorkflow(wfId)`.
  The parent body replays, reads the increased `attempt` again, and opens the
  running charge again under a fresh step name. The workflow ID never moves, thus
  `cortex_runs.workflow_id` is stable.
- **Why not `ERROR` plus `forkWorkflow`?** A resume from `ERROR` does not work,
  because the DBOS resume excludes a terminal status. `forkWorkflow` works, but it
  makes a new workflow ID, thus Cortex must update its run-to-workflow mapping.
  `CANCELLED` plus `resumeWorkflow` keeps the ID stable.
- **A known limitation: child-level budget resume is not wired (a follow-up).** A
  budget pause that starts inside a **child** sandbox-step (a sandbox-agent LLM
  call) is not cleanly resumable today. Three facts cause this. The parent
  dispatches a child again with `DBOS.startWorkflow(childWorkflowId)`, which
  **dedups on the existing canceled child**: `initWorkflowStatus` gives the
  existing status and ignores the new input, thus the increased attempt never
  reaches the child. Nothing calls `DBOS.resumeWorkflow(childWorkflowId)`, because
  `resume-execute-analysis.ts` resumes only the parent. The child id
  `${workflowId}-${idx}` carries **no attempt**, thus even an explicit child
  resume would replay the step that the cache holds as failed. A fix needs the
  child id to carry the attempt, or it needs `forkWorkflow`. The resume path must
  also fire the canceled children again.
