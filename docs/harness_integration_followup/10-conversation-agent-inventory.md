# 10 — Conversation-Agent Inventory (RQ2)

Written 2026-07-07, researched against HEAD `825d7825643caff9c75e6a1cc4207aac5de1416f`.
Answers RQ2 of `02-conversation-agent-adoption-research.md`: the full dep/tool/prompt
surface of the conversation agent + chat-turn machinery, verified post-AI-SDK-migration,
against what the cli composition root already realizes — and the full-root-vs-direct-
registration decision that discharges or re-documents change C's D1 debt.

Companion artifacts: `11-chat-topology.md` (RQ1/RQ3), `12-planner-flow.md` (RQ4/RQ5),
`13-sequencing-memo.md` (RQ7/RQ6).

> **Pin note:** mid-loop, HEAD advanced to `06f85b8` (records the #28 data-profile
> kill/resume verification; #28 closed, wedge issue filed as #41). Its only overlap
> with this artifact's citations is `cli/src/modules/harness/runtime.ts`, where a
> 7-line `TODO(robustness)` block at `:388-394` was removed — citations to that file
> **above** line 388 are unchanged; those below shift by −7 at `06f85b8`
> (`:397-408` → `:390-401`, `:442` → `:435`).

---

## 0. Corrections to inherited claims (read first)

Re-verification found the brief and the harness's own docs materially stale on the
chat-turn machinery. These corrections supersede prior descriptions:

1. **`app/chat-turn.ts` contains no `runAgent` call and no stream consumption.** The
   brief (§1: "chat-turn machinery (`app/chat-turn.ts` — direct `runAgent` with
   `passthroughStep`, background completion via `consumeStream`)") and
   `harness/CLAUDE.md:146` ("Chat turn (`app/chat-turn.ts`): Direct `runAgent` call with
   `passthroughStep`. Background completion after client disconnect via `consumeStream`")
   both describe a file that ships only the **preparation half**. The file's own header
   (`harness/src/app/chat-turn.ts:4-9`):

   > "This is the PREPARATION half of a conversation turn, lifted out of the HTTP route
   > so callers other than the route (e.g. a CLI) can reuse it. […] It deliberately owns
   > NONE of the transport orchestration (streaming/SSE/queue/status codes) — that stays
   > in the caller. A turn is `prepareChatTurn → runAgent(own emit) → appendTurn`."

2. **`consumeStream` does not exist anywhere in `harness/src`.** Greps:
   `grep -rn "consumeStream|consume_stream|consume-stream|backgroundCompletion|background-completion|detachedCompletion" harness/src --include='*.ts'`
   → zero hits (the string appears only in `harness/CLAUDE.md:146` and the AI SDK's own
   changelog under `node_modules`). The managed reference (see §6) achieves background
   completion without it: a detached `runPromise` that an SSE abort deliberately does not
   cancel. `harness/CLAUDE.md:146` should be corrected upstream.

3. **`prepareChatTurn` and `appendTurn` have zero non-test callers in the harness.**
   Greps: `grep -rn "prepareChatTurn" harness/src --include='*.ts'` → definition +
   `chat-turn.test.ts` only; `grep -rn "appendTurn" harness/src --include='*.ts' | grep -v .test`
   → definitions/comments in `memory/`, `app/` only. The turn loop is entirely
   embedder-owned; the harness has designed it but never run it — exactly the risk
   profile the brief predicted.

4. **Stale docstrings in the harness name a dead registration helper and a dead
   workflow-id shape.** `agents/conversation-agent.ts:108-109` and
   `tools/execute-plan.ts:56` say the workflow callable is "produced by
   `registerAnalysisWorkflows`" — that helper is **uncalled and structurally unusable**
   (`workflows/register-workflows.ts:53`: "No in-tree caller holds a pre-registered child
   callable, so this helper is currently uncalled"). `agents/conversation-agent.ts:15-16`
   says `executePlan` starts the workflow "with `workflowID = "${analysisId}:${runId}"`" —
   the code uses the bare runId (`tools/execute-plan.ts:243`:
   `await runLauncher.launch(executeAnalysisWorkflow, { workflowId: runId }, workflowInput)`,
   with the comment at `:239-240`: "`workflowId = runId` — both are the same bare UUID").
   Flag upstream; neither affects behavior.

---

## 1. `assembleCoreRuntime` — the full dep surface

`harness/src/runtime/assemble.ts:81-107` is small: five workflow registrations plus one
conversation-agent build.

```ts
export function assembleCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime {
    const { conversation, workflows: wf, resourcePolicy } = deps;

    const sandboxStep = registerSandboxStep(wf.sandboxStep);
    const executeAnalysis = registerExecuteAnalysis(wf.buildExecuteAnalysis(sandboxStep));
    const executeTargetAssessment = registerExecuteTargetAssessment(wf.executeTargetAssessment);
    const dataProfile = registerDataProfileWorkflow(wf.dataProfile);
    const ephemeral = registerEphemeralWorkflow({ ...wf.ephemeral, resourcePolicy });

    const conversationAgent = createConversationAgent({
        ...conversation,
        executeAnalysisWorkflow: executeAnalysis,
        ephemeralWorkflow: ephemeral,
        resourcePolicy,
    });
    ...
}
```

`CoreRuntimeDeps` (`assemble.ts:64-74`) = `{ conversation: ConversationAssemblyDeps;
workflows: CoreWorkflowDeps; resourcePolicy?: ResourcePolicy }`.
`ConversationAssemblyDeps` (`assemble.ts:62`) =
`Omit<ConversationAgentDeps, "executeAnalysisWorkflow" | "ephemeralWorkflow" | "resourcePolicy">`
— "so a caller cannot wire a stale callable or a policy that diverges from the one the
workflows see" (`assemble.ts:57-61`).

### 1a. `ConversationAssemblyDeps` — field-by-field vs the cli root

`ConversationAgentDeps` is `harness/src/agents/conversation-agent.ts:95-150`. The cli's
existing realizations are in `cli/src/modules/harness/runtime.ts` (boot) and
`run_deps.ts`. Status per field:

| Dep (type) | cli status | Realization / gap note |
|---|---|---|
| `provider: ChatProvider` | **realized** | `createAnthropicProvider({baseURL: env.cliproxyApiUrl, token: apiKey, model, resolveBilling})` — `runtime.ts:348` |
| `pool: Pool` | **realized** | `createPool` over the infra `PostgresConnection` — `runtime.ts:325-332` |
| `embedding: EmbeddingProvider` | **realized** | `resolveEmbedder(readConfig())` + boot probe — `runtime.ts:203,262-280` |
| `workspaceFs: WorkspaceFilesystem` | **realized** | `createWorkspaceFilesystem({ sessionsBasePath: env.sessionsDir })` — `runtime.ts:362` |
| `model: string` | **realized** | `cfg.model` or proxy auto-resolve + Claude guard — `runtime.ts:282-298` |
| `sessionsBasePath: string` | **realized** | `env.sessionsDir` (change C's D2 single global base) — `runtime.ts:360,374` |
| `runAuthorizer: RunAuthorizer` | **realized** | `createLocalRunAuthorizer()` — `runtime.ts:366` |
| `runLauncher: RunLauncher` | **realized** | `createDbosRunLauncher()` — `runtime.ts:442` |
| `bioKeys: BioToolKeys` | **realized** | `cfg.bioKeys` — `runtime.ts:377`. Shape (`tools/bio/keys.ts`): `{drugbank, disgenet, epaCcte, ncbi?, github?}` — absent keys pass as empty strings, tools surface per-call auth errors (change C D6 precedent) |
| `createPreviewPublisher` | **GAP — trivial** | `IterateReportDeps["createPreviewPublisher"]` (`tools/iterate-report.ts:247-253`): `(args: {session, resourceId, runId, previewId, ttlSeconds}) => Promise<PreviewPublisher>`. Local realization: `async () => new UnavailablePreviewPublisher()` — the barrel-exported class returns `{ok: false, error: {message: "report preview is unavailable in this environment"}}` so `preview_snapshot` "short-circuits before touching Chrome and the report still builds (submit_report is the only gate)" (`tools/report/preview-publisher.ts:8-11,27-34`) |
| `templatesDir: string` | **GAP — config** | Root templates dir for report rendering; the runner joins `report-html` (`iterate-report.ts:238-239`). The repo ships `templates/report-html/` at the root (base.html.j2, components, theme.css, echarts-theme.json). Realization mirrors `skillsDir`: repo-root `templates/`, config-overridable (`resolveHarnessConfig` grows one key). Same installed-cli packaging caveat change C recorded for `skillsDir` (a repo-relative dir only works from a checkout) |
| `chrome: ChromeConfig` | **GAP — config** | `{browserUrl?: string; maxPages?: number}` (`lib/chrome.ts:13-16`). Both optional; `getBrowser(browserUrl?)` (`chrome.ts:57`) — with no `browserUrl` the snapshot path launches/attaches per its own default. With the unavailable preview publisher, `preview_snapshot` short-circuits before Chrome, so `{}` is an honest local default; a config key can expose `browserUrl` later |

Supplied by `assembleCoreRuntime` itself (cannot and must not be wired by the cli):
`executeAnalysisWorkflow`, `ephemeralWorkflow`, `resourcePolicy` (the cli already holds
`cfg.resourcePolicy` — `config.ts` via `resolveHarnessConfig`, threaded today as
`cfg.resourcePolicy.perStep` into the sandbox client and `cfg.resourcePolicy.budget`
into `RunTriggerDeps`, `runtime.ts:359,442`).

### 1b. `CoreWorkflowDeps` — field-by-field vs the cli root

`CoreWorkflowDeps` (`assemble.ts:40-46`):

| Bundle | cli status | Note |
|---|---|---|
| `sandboxStep: SandboxStepDeps` | **realized** | `buildSandboxStepDeps(composition)` — `run_deps.ts:122-135` (bus-adapter `ArtifactRegistry`, catalog `buildAgent`, `resolveWritePrefix`) |
| `buildExecuteAnalysis: (child) => ExecuteAnalysisDeps` | **realized (reshape)** | `buildExecuteAnalysisDeps(composition, sandboxStepCallable, runAuthorizer)` — `run_deps.ts:151-168` already takes the child callable as a parameter; currying it into the builder shape is mechanical |
| `executeTargetAssessment: ExecuteTargetAssessmentDeps` | **GAP — realizable, unexercised** | `workflows/execute-target-assessment.ts`: `{pool, runAuthorizer, ncbiApiKey?, chatProvider: AgentChat, decisionModel, synthesisModel}`. Every field exists at the cli root (`pool`, `runAuthorizer`, `cfg.bioKeys.ncbi`, `provider`, `model`/`model`). But **no cli surface can trigger it** (it is a separate top-level entity, not a conversation-agent tool — `harness/CLAUDE.md:163`), so registering it registers a durable workflow nothing launches. Harmless (recovery finds no `PENDING` rows for a never-launched workflow) but should be a deliberate line in the adoption design, not an accident |
| `dataProfile: DataProfileDeps` | **realized** | the change-C wiring — `runtime.ts:397-408` |
| `ephemeral: Omit<EphemeralDeps, "resourcePolicy">` | **GAP — zero new backends** | `execution/ephemeral-runner.ts:64-78`: `{provider, pool, sandboxClient, workspaceFs, embedding, sessionsBasePath, model, bioKeys}` — every field is already in `RunEngineComposition` (`run_deps.ts:33-50`). Registration is free; the *boot duty* it drags in is not (§2) |

### 1c. Barrel and deep-import surface

Adoption needs symbols the curated barrel (`harness/src/index.ts`) does not export
today. Verified by grep of `index.ts`: exported — `assembleCoreRuntime` (`index.ts:9`),
`createConversationAgent` (`:12`), `UnavailablePreviewPublisher` (`:38`),
`runAgent`/`finalText` (`:50`). **Not exported**: `prepareChatTurn`, `assembleMessages`,
`createThreadHistory`, `createThreadStore`, `contentToCortexMessages`,
`createCardResolver`, everything under `contracts/` (chat events, chat parts,
part registry), `sweepEphemeralWorkflows`, `registerEphemeralWorkflow`,
`registerExecuteTargetAssessment`, the `CoreRuntimeDeps`/`ConversationAssemblyDeps`/
`CoreWorkflowDeps` types.

Deep subpaths are importable by design (`harness/package.json` `exports` `./*` →
`dist/*.js`; `harness/CLAUDE.md:17`: "Every deep subpath stays importable … the barrel
is additive, not a wall" — the harness itself deep-imports
`@inflexa-ai/harness/contracts/chat-parts.js` in `app/synthesize-run.ts:20`). House
precedent (changes C D7, F D8) is to grow the barrel additively rather than deep-import
from the cli. Recommended barrel growth for adoption (all additive):
`prepareChatTurn` + types, `assembleMessages` (or leave internal — `prepareChatTurn`
wraps it), `createThreadHistory`/`createThreadStore` + `StoredMessage`,
`contentToCortexMessages`/`createCardResolver`, the `contracts/` chat-event/part types
(or bless the deep subpath for contracts only — they are already designed as a consumer
surface: `harness/CLAUDE.md:151` "Shared contracts (`harness/src/contracts/`) …
exported from `@inflexa-ai/harness` for consumers" — **currently false**; either fix the
doc or fix the barrel), `sweepEphemeralWorkflows`, `CoreRuntimeDeps` family, and a
run-stream read helper once it exists (see `11-chat-topology.md` §5).

---

## 2. What actually breaks out of wiring order (verified, not quoted)

The assemble docstring declares order load-bearing (`assemble.ts:10-15`). What the code
actually enforces / breaks:

1. **Parent-before-child is unrepresentable, not merely wrong.**
   `ExecuteAnalysisDeps.sandboxStepCallable` must be the *registered* child callable;
   `assembleCoreRuntime` models this as the `buildExecuteAnalysis(sandboxStep)` builder
   (`assemble.ts:36-38,85`). Registering the parent first is a type error — there is no
   callable to put in its deps. The flat helper `registerAnalysisWorkflows`
   (`register-workflows.ts:55-60`) is unusable for the same reason: it "takes a
   fully-formed `AnalysisWorkflowDeps`, so it fits only a caller that already holds a
   registered sandbox-step callable … registering the child here as well would make its
   `registerSandboxStep` a second registration under the same name, which the SDK
   rejects" (`register-workflows.ts:44-53`). Nothing calls it.

2. **Registering after `launchDbos` breaks recovery, silently.**
   `register-workflows.ts:35-39`: "Call this BEFORE `launchDbos`: `DBOS.launch()` runs
   recovery synchronously and resolves in-flight workflows by their registered name, so
   a workflow that is not registered at launch cannot be reclaimed." The cli boot
   restates it (`runtime.ts:380-386`: "All of it lands before `launch`, which is the
   invariant that matters"). A late registration does not throw — the workflow simply
   isn't reclaimable at that boot's recovery pass. (The old contradicting docstring
   change C flagged at `register-workflows.ts:35` — "register *after* launch" — has been
   fixed upstream; the file now agrees with `assemble.ts`.)

3. **Double registration is an SDK invariant violation.**
   `register-workflows.ts:40-42`: "Idempotency is owned by the SDK — calling twice with
   the same name is a `DBOS.registerWorkflow` invariant violation." This is why one
   process = one registration cohort = one `sessionsBasePath` (change C D2 stands).

4. **One `applicationVersion` cohort.** All registrations land under the single
   `launchDbos` stamp (`assemble.ts:13-15`); splitting registration across launches
   would split the blue/green drain cohort. Not reachable in the cli (single boot path).

5. **NEW — the ephemeral sweep is a pre-launch boot duty `assembleCoreRuntime` does NOT
   own.** `runtime/dbos.ts:152-164` (`sweepEphemeralWorkflows`): "Cancel any
   `ephemeral:`-prefixed PENDING workflow this executor owns — called BEFORE
   `launchDbos`, whose recovery would otherwise re-dispatch them. […] the only race-free
   point is a direct system-DB UPDATE before launch." Grep across `harness/src` and
   `cli/src`: **zero callers** — the OSS tree never calls it (the managed host predates
   the extraction), and it is not barrel-exported. `harness/CONTEXT.md:71` describes the
   sweep as if it ran ("the launch path cancels any `PENDING` `ephemeral:*` workflow for
   this executor before DBOS launch") — **stale relative to the OSS tree**. The moment
   the cli registers the `ephemeral` workflow, a host crash mid-`run_ephemeral` leaves a
   `PENDING ephemeral:*` row that the next boot's recovery would re-dispatch — running a
   sandbox for a chat turn that no longer exists. Adoption MUST add
   `sweepEphemeralWorkflows` to `bootHarnessRuntime` between pool creation and
   `launchDbos` (it needs `{pool, logger, executorId: "local"}`), and export it from the
   barrel.

---

## 3. The conversation agent itself

`createConversationAgent(deps): AgentDefinition` (`agents/conversation-agent.ts:153`)
returns `{id: "conversation-agent", systemPrompt, model, tools, maxIterations: 50}`
(`:254-260`; `CONVERSATION_MAX_ITERATIONS = 50`, `:92`).

**System prompt** — static composition, no processor pipeline:
`composeSystemPrompt(conversationPrompt)` (`:256`) = `SOULKernelPrompt` +
`SOULConversationalPrompt` + `prompts/conversation.ts` (~41 KB;
`agents/system-prompt.ts:29-33`). Analysis context is NOT in the prompt — it is a tail
`user` message injected at assembly time (§4).

**Tool surface** — 40 tools in wiring order (`conversation-agent.ts:175-252`):

- *Bio-lookup leaves (pure)*: `searchGeneTool`, `searchPathwayTool`, `lookupGoTermTool`,
  `searchInteractionsTool`; NCBI (`createNcbiTools(bioKeys)`): `searchPubMed`,
  `getArticleDetails`, `getArticleFullText`; ChEMBL: `searchCompoundsTool`,
  `getBioactivityTool`, `searchTargetsTool`, `getMechanismTool`, `getDrugInfoTool`;
  PubChem: `searchPubchemCompoundTool`, `getPubchemCrossRefsTool`,
  `getPubchemAssaysTool`; translational: `searchOpenTargetsTool`, `getTargetSafetyTool`,
  `searchPharmgkbTool`, `searchFaersTool`, `searchClinicalTrialsTool`,
  `searchGeoDatasetsTool`, `searchDgidbTool`; preclinical: `searchBgeeExpressionTool`,
  `getImpcKoProfileTool`; off-target: `checkSafetyPanelTool`; EPA CompTox
  (`createChemDbTools(bioKeys)`): `searchToxcast`, `searchCtxHazard`,
  `searchCtxChemical`, `searchCtxExposure`. (29 tools)
- *Execution*: `createInspectRunTool(pool)`;
  `createGeneratePlanTool({provider, pool, model, resourcePolicy})`;
  `createExecutePlanTool({pool, executeAnalysisWorkflow, runAuthorizer, runLauncher, resourcePolicy})`;
  `createRunEphemeralTool({workflow: ephemeralWorkflow, runAuthorizer, runLauncher})`;
  `createIterateReportTool({provider, pool, sessionsBasePath, model, templatesDir, chrome, createPreviewPublisher})`. (5)
- *Display*: `showUserTool` (→ `data-presentation`), `createShowPlanTool(pool)`
  (→ `data-plan`), `showFileTool` (→ `data-file-reference`). (3)
- *Sub-agents-as-tools*: `createLiteratureReviewerTool({provider, model, bioKeys})`,
  `createGenerateAnalogyReportTool({provider, model, bioKeys})`. (2)
- *Workspace read*: `createWorkspaceSearchTool(pool, embedding)`,
  `createReadFileTool(workspaceFs)`, `createListFilesTool(workspaceFs)`,
  `createFileStatTool(workspaceFs)`, `createGrepTool(workspaceFs)`. (5)
- *Working memory*: `createUpdateWorkingMemoryTool(createWorkingMemory(pool))`. (1)

DBOS quarantine holds throughout: only `execute_plan` (fire-and-forget
`runLauncher.launch`, `execute-plan.ts:243`) and `run_ephemeral` (inline
`runLauncher.launchAndAwait`, `run-ephemeral.ts:77-82`) touch durable workflows, both
through the `RunLauncher` seam. `iterate_report` is in-process Nunjucks + `runAgent`
with `passthroughStep` (`execution/report-runner.ts:217`) — no workflow. `inspect_run`
is pull-only ledger reads (`queryRunsByAnalysis`/`queryRun`/`queryStepsByRun`).
`workspace_search` degrades an absent per-analysis pgvector table (SQLSTATE 42P01) to
`ok([])` (`tools/workspace/workspace-search.ts:24-30,83-87`).

---

## 4. The chat-turn machinery (embedder-owned loop, harness-owned pieces)

The turn is three calls, of which the harness ships the first and the third:

1. **`prepareChatTurn(deps, params)`** (`app/chat-turn.ts:43-85`).
   Deps: `{pool: Pool}` — one field. Params: `{analysisId, threadId, userInput}`.
   Result: `({kind: "ok"} & AssembledMessages) | {kind: "not_found"}` (thread owned by a
   different analysis is indistinguishable from absent, `:49-53`). Body: ownership check
   via `createThreadStore(pool).getThread`, best-effort title seed
   (`deriveThreadTitle`, try/catch → `console.warn`, `:56-70`),
   `loadAnalysisStatus(pool, analysisId).unwrapOr(null)` (`:72`), then
   `assembleMessages` (`:74-82`).

2. **`runAgent(agent, messages, session, {provider, signal, emit, runStep: passthroughStep})`**
   — the caller's own emit sink and abort handling. Message assembly
   (`app/message-assembly.ts:73-104`) builds
   `[...loadRecent(threadId, 120_000 tokens), {user: "[Analysis Context]\n…"}?, {user: render(workingMemory)}, userMessage]`;
   sanitization (`normalizeUnicode(redactSecrets(userInput))`) is applied once, to the
   new input only (`:79-82`); the tail injections are ephemeral and never persisted
   (header `:20-23`).

3. **`appendTurn(threadId, [userMessage, ...loopOutput])`**
   (`memory/thread-history.ts:154-193`): transactional, per-thread
   `pg_advisory_xact_lock(hashtext($1))`, `MAX(seq)` continuation, one
   `INSERT … ON CONFLICT (thread_id, seq) DO UPDATE` per message with write-time
   `tokens = countTokens(...)`.

**Thread store** — `messages` (Postgres, `state/init.ts:203-212`): PK
`(thread_id, seq)`, `message_envelope JSONB` rows of
`{kind: "ai-sdk-model-message", aiSdkMajor: 7, message: ModelMessage}`
(`memory/ai-sdk-message-storage.ts:5-21`); legacy `role`/`content_jsonb` are
write-frozen and backfilled at startup (`init.ts:316-317,368,373`;
`memory/message-backfill.ts` throws if any row remains unbackfilled).
`loadRecent` walks turns newest-first to the token budget, snapping to
genuine-user-start boundaries (`thread-history.ts:195-233`). Thread metadata —
`cortex_analysis_threads` `{thread_id PK, analysis_id, title, created_at, updated_at, deleted_at}`
(`init.ts:219-226`), soft-delete. Working memory — `cortex_working_memory`, one JSONB
row per analysis, rendered to Markdown each turn (`memory/working-memory.ts:164-210,259-261`).

**Display read** — also harness-shipped, also uncalled in-tree:
`ThreadHistory.loadPage` → `contentToCortexMessages(rows, createCardResolver(pool,
analysisId, sessionsBasePath))` (`memory/content-to-cortex.ts:78`,
`memory/reconstruct-cards.ts:29`). Display cards are "emitted live over the chat SSE
stream but never persisted (storage holds only the AI SDK model-message transcript).
`resolveCard` rebuilds them from the persisted tool-call part so they reappear on
reload" (`content-to-cortex.ts:15-17`). This settles a store question for RQ1: **there
is no separate render-parts store to design — the transcript is the store, cards are
derived.**

**The emit sink** — `EmitFn = (event: EmitEvent | ChatStreamEvent | ChatDataPart) =>
void | Promise<void>` (`loop/types.ts:107`): orchestration events
(`iteration`/`tool-started`/`tool-finished`, each with `source: {agentId, callPath}`),
provider text deltas (`{type: "text-delta", text}` … `{type: "done", response}`,
`providers/types.ts:36-38`), and typed `data-*` parts from tools. The wire vocabulary a
consumer renders is in `contracts/`: `CortexChatEvent` (5 events:
`text-delta`/`tool-started`/`tool-finished`/`finish`/`error`,
`contracts/chat-events.ts:68`) and `CortexChatPart` (17 members,
`contracts/chat-parts.ts:363-380`), with `PART_REGISTRY`
(`contracts/part-registry.ts:19-37`) tagging each part
`{emitter: "workflow"|"conversation", consumer: "sidebar"|"conversation", transient, reconciling}`.
Conversation-emitted parts: `data-presentation`, `data-plan`, `data-run-card`,
`data-file-reference`, `data-preview`, `data-preview-failed`. Full streaming trace:
`11-chat-topology.md`.

---

## 5. D1 debt decision: adopt `assembleCoreRuntime` (recommended) vs continue direct registration

**Fact that reframes the debt**: `assembleCoreRuntime` has **zero production callers
anywhere** — the cli defers it (change C D1, restated at F D1), and the managed Cortex
host predates it (vendored older harness; it registers directly via its own
`registerHarnessWorkflows` and hand-builds the conversation agent in
`cortex/harness/server.ts:233-298`; grep for `assembleCoreRuntime` in that repo: zero
hits). Adopting it in the cli is not "catching up to how the harness is used" — it is
the function's **first exercise**, which cuts both ways: it discharges the debt as
designed, and it may surface assembly bugs (budget the walking skeleton accordingly).

**Recommendation: adopt the full root at conversation-agent adoption** — discharging
C's D1 debt as written, because the marginal cost of the two extra bundles is near zero
(§1b: ephemeral = zero new backends; target-assessment = six fields all present at the
root) and the alternative preserves a hand-maintained mirror of `assemble.ts`'s order
invariants that the builder API exists to make unrepresentable. The counterweights,
priced:

- *Registering `executeTargetAssessment` nothing can trigger.* Harmless at runtime
  (never launched → never recovered) but semantically odd. If the design prefers
  honesty over completeness, the fallback is NOT direct registration — it is a harness
  change making `executeTargetAssessment` optional in `CoreWorkflowDeps`. Price: small
  additive harness change vs one line of "registered, deliberately untriggerable" in
  the adoption design. Either is defensible; registering it is cheaper.
- *`buildExecuteAnalysisDeps` reshape.* Mechanical: today's
  `(composition, sandboxStepCallable, runAuthorizer)` becomes the
  `buildExecuteAnalysis: (child) => ExecuteAnalysisDeps` closure.
- *Boot additions the full root does NOT cover* (stay in `bootHarnessRuntime`): the
  three sandbox-hygiene crons (`registerReaper`/`registerWatchdog`/
  `registerNotificationSweep` — change F D5; `assembleCoreRuntime` does not register
  them), `initCortexState`, the ingress, the embedding probe, and — new —
  `sweepEphemeralWorkflows` before launch (§2.5).

The boot sequence after adoption:

```
prerequisites (skills, templates, embedder probe, key, model) → ensurePostgres →
startIngress → acquire runtime lock → createPool → initCortexState →
sweepEphemeralWorkflows(pool, "local") →
assembleCoreRuntime({conversation, workflows, resourcePolicy}) →
registerReaper/Watchdog/NotificationSweep → launchDbos → HarnessRuntime{…, conversationAgent}
```

---

## 6. The managed reference embedding (what an embedder actually wires)

The only production embedding of the conversation agent is the managed Cortex host
(`/Users/s-ved/repos/inferentia/cortex`), which vendors an **older, diverged** harness
in-tree (`cortex/harness/`; app `inflexa-agent`, boots `tsx harness/server.ts`; no
`@inflexa-ai/harness` dependency; no `app/`, no `runtime/assemble.ts`, no `contracts/`
dir). Its wiring, as the reference for what the OSS embedder must reproduce:

- Composition root `server.ts:233-298`: `registerHarnessWorkflows({pool, provider,
  sandboxClient})` (child-first, five workflows) then `createConversationAgent({...,
  executeAnalysisWorkflow: workflows.executeAnalysis, ephemeralWorkflow:
  workflows.ephemeral, templatesDir: env.TEMPLATES_DIR, chrome: {browserUrl:
  env.CHROME_BROWSER_URL, ...}, bioKeys})`; DBOS launched after all registration
  (`server.ts:315-325`).
- Chat route (`routes/chat.ts`): Hono `streamSSE`; session rebuilt with `threadId` in
  scope before the loop so `executePlan` can stamp `cortex_runs.thread_id`
  (`chat.ts:160-170`); detached `runPromise` + `stream.onAbort` that deliberately does
  not cancel = background completion (`chat.ts:19-21,309-322`); `appendTurn` persists
  `[userMessage, ...appended]` after the loop.
- `templatesDir` from env (default `"templates"`), report tools join `report-html`
  (`report-runner.ts:190`); bio keys from env (`bioToolKeysFromEnv`); preview publishing
  realized by its Nexus client (`mintPreviewAccess`), i.e. the role the OSS
  `PreviewPublisher` seam abstracts.

Full route/streaming detail is in `11-chat-topology.md` §4; the point for RQ2 is that
every `ConversationAssemblyDeps` field has a proven managed realization shape, and the
OSS gaps (§1a) are exactly the three fields the managed host fills from env
(`templatesDir`, `chrome`) or platform services (`createPreviewPublisher`).

---

## 7. Open user decisions (RQ2 slice)

- [ ] **Full root vs direct registration** — §5 recommends `assembleCoreRuntime`
      (discharge D1). Accept registering `executeTargetAssessment` untriggerable, or
      fund the small harness change making it optional?
- [ ] **Barrel growth vs blessed deep imports for `contracts/`** — §1c. The barrel is
      the house style (C D7/F D8); contracts are already documented as a consumer
      surface but not actually exported (`harness/CLAUDE.md:151` is wrong either way).
- [ ] **`templatesDir` packaging** — repo-root `templates/` works from a checkout only;
      same open question change C left for `skillsDir` (still open).
