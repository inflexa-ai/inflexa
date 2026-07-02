## Context

The cli and the harness are independent packages with zero wire between them: no cli
code imports `@inflexa-ai/harness`, and the harness's embedder API has never had a
caller (`assembleCoreRuntime` is referenced only by its own file and the barrel).
Research backing this design: `docs/harness_integration-new/` (esp. `04` materialization,
`06` change graph).

What already exists on each side, verified:

- **Harness ships the OSS seam realizations** in its curated barrel
  (`harness/src/index.ts`): `createLocalRunAuthorizer` (local `RunSession`, no-op
  revoke — `auth/local-run-authorizer.ts:13-26`), `createNoopBillingResolver`,
  `createNoopRunCharge`, `makeLocalAuth()` (trivial opaque `AuthContext`,
  `auth/local-auth-context.ts:22-24`), `createAnthropicProvider`,
  `createEmbeddingProvider`. The walking skeleton is assembly, not invention.
- **The cli pre-built the substrate**: the infra module provisions Postgres
  (pgvector/pg18) via Docker Compose, exposes `ensurePostgresReady()` and a resolved
  `PostgresConnection`, and its own header names "the future harness-wiring change"
  as the consumer (`cli/src/modules/infra/postgres_types.ts:1-10`).
- **The staging blueprint exists**: the untracked `src/modules/staging/` draft is
  wire-compatible with the harness `StagedInput` field-for-field, with two known bugs
  to fix on relocation (`docs/harness_integration-new/05-prior-work.md` §3).
- **The trigger contract**: `triggerDataProfile(deps, params)` needs
  `{pool, runAuthorizer, workflow}` where `workflow` is the *registered* DBOS callable
  (`harness/src/tasks/data-profile.ts:375-391,457`), and the workflow body's own deps
  (`DataProfileDeps`, `data-profile.ts:58-79`) are closed over at registration.

One piece is genuinely missing on both sides: **exec-callback ingress**. The Go
sandbox-server POSTs signed callbacks to
`{CORTEX_BASE_URL}/sandbox/{execId}/{event|complete}` with `X-Sandbox-Signature` /
`X-Sandbox-Timestamp` headers (`images/sandbox-base/server/callback.go:24-27,75-77`);
the workflow body receives them via `DBOS.recv` on topic `exec-event:{execId}`
(`harness/src/sandbox/await-exec.ts`). Nothing in the harness bridges HTTP → topic —
that route lived in the managed host. The embedder must provide it.

## Goals / Non-Goals

**Goals:**

- The cli can stage an analysis's inputs and run a real data-profile through the
  embedded harness: Docker sandbox, real LLM calls through the local proxy, results in
  the harness ledger, output files on host disk.
- Every `DataProfileDeps` seam has a named, deliberate local realization.
- The embedding seam (composition module, callback ingress, lifecycle) is reusable by
  the later `executeAnalysis` wiring without redesign.

**Non-Goals:**

- Provenance bridging (change D of the change graph) and the prov event port (change B).
- `executeAnalysis` / ephemeral / target-assessment wiring; the harness conversation
  agent (the cli keeps its own chat).
- Harness-side deletion of the custom provenance persistence (change E).
- K8s backend, Podman for sandbox containers, multi-machine deployment.

## Decisions

### D1. Register only the data-profile workflow; defer `assembleCoreRuntime`

`assembleCoreRuntime` registers all five workflows and unconditionally builds the
conversation agent (`runtime/assemble.ts:73-97`), which would force this change to
realize `ExecuteAnalysisDeps`, `EphemeralDeps`, `ExecuteTargetAssessmentDeps`, and
`ConversationAssemblyDeps` — none of which the skeleton exercises. Instead the cli
calls `registerDataProfileWorkflow(deps)` directly and hands the returned callable to
`triggerDataProfile`. Registration happens **before** `launchDbos` so DBOS recovery
can find the workflow by name — matching `assemble.ts`'s documented contract
("all registration happens ... before launch", `assemble.ts:12-15`).

Deliberate debt, recorded here: when `executeAnalysis` lands, the cli moves to
`assembleCoreRuntime` so all workflows share one registration cohort. Observed drift
to not copy: `workflows/register-workflows.ts:35` says to register *after* launch,
contradicting `assemble.ts` — flag upstream, follow `assemble.ts`.

### D2. `sessionsBasePath` is a single global base — per-analysis is impossible

The research docs leaned per-analysis (`04-file-materialization.md` §3.1, following the
stash's `sessionTreeRoot`). That lean is **superseded by a hard constraint found during
this design**: `DataProfileDeps.sessionsBasePath` is closed over at registration
(`data-profile.ts:373`: "construction-time deps are closed over at registration"), and
DBOS forbids registering the same workflow twice (`register-workflows.ts:38-40`). One
process, one registration, one `sessionsBasePath` — it cannot vary by analysis.

So: `sessionsBasePath = {cli data dir}/sessions`, exposed by one path helper the
staging call, `CreateSandboxClientConfig.sessionsBasePath`, and
`WorkspaceFilesystemDeps.sessionsBasePath` all consume. The per-analysis tree is
`{sessionsBasePath}/{analysisId}/…` exactly as the harness joins it
(`create-sandbox.ts:126-130`). Surfacing session trees next to the user's anchor
(the `resolveOutputDir` aesthetic) becomes a later UX concern, not a mount concern.

### D3. Input layout stays `data/inputs/local/{key}`

The harness addresses inputs purely by the `relativePath` the embedder supplies
(`04-file-materialization.md` §5); the staging draft's `inputs/local/{key}` is
human-readable and preserves user directory structure. The `{fileId}/`-style examples
in harness prompts are a harness-side doc fix, out of scope here. Staging is invoked as
`stageInputs(analysis.id, join(sessionsBasePath, analysis.id, "data"))` — targetDir is
the `data/` root, NOT `data/inputs` (the double-segment bug the old research caught).

### D4. Exec-callback ingress: a localhost HTTP listener owned by the cli runtime module

A minimal `Bun.serve` listener bound to `127.0.0.1` on an ephemeral port:

```
POST /sandbox/{execId}/{event|complete}
  → parse workflowIdFromExec(execId)          (harness/src/sandbox/exec-id.ts:14-20)
  → envelope = { payload, payloadRaw, signature: X-Sandbox-Signature ?? null,
                 timestamp: X-Sandbox-Timestamp ?? null }   (ExecEventMessageSchema, sandbox/types.ts:110-116)
  → kind=complete: payload wrapped as DoneMarker {done: true, result}  (types.ts:118-126)
  → deliverExecEvent(workflowId, execId, envelope)   (harness sandbox/deliver-exec-event.ts)
  → 200
```

Delivery goes through the harness's `deliverExecEvent`, never a cli-side `DBOS.send`:
the DBOS SDK is module-singleton state, and with per-package `node_modules` the cli's
own copy would be a second, un-launched instance whose `send` writes nowhere. This is
the one additive harness helper the change adds beyond barrel exports.

HMAC verification deliberately stays in `awaitExec` (workflow body,
`await-exec.ts:1-30`) — the ingress forwards raw envelopes and never holds the
`callbackSecret`. Unparseable execId → 4xx (sandbox-server treats 4xx as give-up,
`callback.go:70-71`); transient send failure → 5xx (retried with backoff).
`cortexBaseUrl` passed to the sandbox client is `http://host.docker.internal:{port}`
so the container reaches the host listener (threaded into the container env as
`CORTEX_BASE_URL`, `docker-client.ts:123`).

### D5. Lazy, on-demand runtime boot; shutdown on exit

The runtime (Postgres readiness → callback listener → register → `launchDbos`) boots on
the **first profile trigger**, held as a module singleton, reused afterward. Passive
flows (bare `inflexa`, TUI launch) never boot it — consistent with the no-litter policy
and with TUI startup latency. `launchDbos` is itself idempotent
(`runtime/dbos.ts:85-88`). Cli exit runs `shutdownDbos` (never throws,
`dbos.ts:117-125`) and closes the listener; in-flight workflows are marked recoverable
and DBOS recovery resumes them on the next boot — durability is the feature, not a bug,
but the launch action must surface "resumed a previous run" comprehensibly.

### D6. Seam realizations (the full `DataProfileDeps` map)

| Dep | Realization | Source |
|---|---|---|
| `provider` | `createAnthropicProvider({baseURL: cliproxy `/v1` URL, token: proxy client key, model, resolveBilling})` — S1-verified: the proxy serves Anthropic-shaped streamed `/v1/messages` | barrel; `providers/anthropic.ts:27-63` |
| `pool` | `pg.Pool` from infra `PostgresConnection` | `infra/postgres_types.ts:48-54` |
| `sandboxClient` | `createSandboxClient({pool, env: {backend: "docker", namespace: ""}, cortexBaseUrl, image, resourceLimits, sessionsBasePath})` | `sandbox/create-sandbox.ts:43-85` |
| `workspaceFs` | `createWorkspaceFilesystem({sessionsBasePath})` — no presigned fallback | `workspace/filesystem.ts:108-118` |
| `sessionsBasePath` | global base (D2) | — |
| `model` | cli config key (label only; provider owns wire model) | `data-profile.ts:64-65` |
| `runAuthorizer` | `createLocalRunAuthorizer()` | barrel |
| `bioKeys` | cli config, each key defaulting to empty — tools surface auth failures as normal tool errors by design | `tools/bio/keys.ts:15-28` |
| `resolveBilling` | `createNoopBillingResolver()` | barrel |
| `embedding` | `{model, baseURL, token}` from a NEW cli config key pointing at a user-supplied OpenAI-compatible embeddings endpoint — S1 found the proxy serves NO `/v1/embeddings` (404), and an unreachable embedder is fatal to the profile (`createEmbedder` throws via `unwrapOrThrow`, `workspace/search-config.ts:43-47`, inside the workflow before `completeDataProfile`). The launch pre-flight gates on this config being present. A fake local embedder is prohibited (fabricated similarity); making harness vector-indexing optional is the better long-term seam but is a harness behavior change → follow-up change, not this one | `data-profile.ts:72-76` |
| `skillsDir` | repo-root `skills/`, config-overridable | root `CLAUDE.md` (shared content dir) |

Trigger auth: `makeLocalAuth()`; trigger deps: `{pool, runAuthorizer, workflow}`.

### D7. Import via the barrel; grow it as the one harness-side edit

The embedding imports only from `@inflexa-ai/harness` (the curated embedder surface).
Missing from the barrel today and needed here: `launchDbos`/`shutdownDbos`/`DbosConfig`,
`registerDataProfileWorkflow`/`DataProfileDeps`, `triggerDataProfile` + trigger types,
`StagedInput`, `createSandboxClient` + config types, `createWorkspaceFilesystem`,
`workflowIdFromExec`, `ExecEventMessageSchema`/`DoneMarker`. All are additive exports —
no harness behavior change.

### D8. The launch action is a deliberate text command

A dedicated command (working name `inflexa profile`, final name at implementation)
resolves the analysis, runs staging, boots the runtime, triggers, and reports the
`DataProfileTriggerResult` (`"started" | "restarted" | "already_running" | "failed"`,
`data-profile.ts:367`). It lives in the clack text-command layer, not the TUI
(TUI surfacing is follow-up). It is the ONLY path that stages or boots.

## Risks / Trade-offs

- **[S1 — proxy wire-shape mismatch] RESOLVED 2026-07-02 against the live
  `inflexa-dev-cliproxy` deployment.** Chat: `POST /v1/messages` with
  `x-api-key`/`anthropic-version` returned a correct Anthropic SSE stream
  (`message_start` → `content_block_delta` → `message_stop`) — `createAnthropicProvider`
  works unmodified. Embeddings: `POST /v1/embeddings` → 404; the Anthropic-authenticated
  proxy serves none, and embedder failure is fatal to the profile workflow
  (`search-config.ts:43-47` throws pre-`completeDataProfile`). Decision: embeddings come
  from a user-configured OpenAI-compatible endpoint (new config key); the launch
  pre-flight treats absent embedding config as a missing prerequisite with actionable
  guidance. Follow-up (separate harness change): make vector indexing optional so a
  proxy-only setup can profile without external keys.
  *Post-rebase addenda (origin/main @ 141bcc6):* the AI SDK migration turned
  `createAnthropicProvider` into a compatibility wrapper with the same deps shape —
  the S1-verified wiring stands; and an `openai-compatible` provider kind now exists
  (`providers/ai-sdk.ts`) as a ready fallback for non-Anthropic proxies. The
  unmerged `origin/feat/local-embeddings` branch (in-process bge-small via
  node-llama-cpp, `resolveEmbedder()` with `local|api-key|off` modes) is the
  intended resolution of this prerequisite — but its instance-shaped provider needs
  the harness's config-shaped `DataProfileDeps.embedding` seam made injectable, and
  the 1536-dim `ensureSearchIndex` hardcode parameterized, before it can serve
  profiling. See `docs/harness_integration-new/06-change-graph.md` (upstream
  contributions section) for the full reconciliation map.
- **[Linux container→host reachability]** `host.docker.internal` is native on
  Docker Desktop (macOS); the harness docker client sets no `--add-host`
  (grep: no ExtraHosts in `docker-client.ts`). → Skeleton targets macOS (the dev
  machine); Linux needs a host-gateway alias — recorded as an explicit follow-up, not
  silently broken.
- **[Sandbox image availability]** Data-profile sandboxes need the sandbox-base image
  locally. → The launch action must fail with an actionable "build/pull the image"
  error, reusing infra's error-surfacing conventions.
- **[Proxy advertises unserveable models]** Known behavior: `/models` lists dead
  models; calls fail at request time. → Profile LLM failures must surface through the
  ledger/status path, not vanish into the fire-and-forget trigger.
- **[Registration-order doc drift]** `register-workflows.ts:35` contradicts
  `assemble.ts:12-15` on register-vs-launch order. → Follow `assemble.ts`; verify
  recovery re-dispatch works in the E2E test; flag the stale docstring upstream.
- **[Recovery surprise]** A crashed session's PENDING profile workflow resumes on next
  runtime boot. → Surface "resumed" state in the status output; acceptable for a
  durability-first design.

## Migration Plan

Additive throughout: new cli modules + one additive harness barrel edit. No cli SQLite
schema change; DBOS creates its own schema in the provisioned Postgres on first launch.
Rollback = don't use the command; nothing passive changes. The root `src/modules/staging/`
draft is deleted as part of relocation (its content moves into `cli/src/modules/staging/`).

## Open Questions

- Final command name/UX (`inflexa profile <analysis>`? flag on an existing command?) —
  decide at implementation; the capability spec constrains behavior, not naming.
- Skills packaging for an *installed* cli (repo-relative `skills/` only works from a
  checkout) — out of scope for the skeleton, tracked for the packaging change.
- ~~S1 outcome may add a provider-realization decision~~ — resolved, see the S1 entry
  under Risks.
