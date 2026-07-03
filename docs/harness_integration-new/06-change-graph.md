# Change Graph: From Two Finished Engines to One Product

Written 2026-07-02 after the research loop (00–05) closed. This is the forward plan:
how the migration phases in `03-provenance-migration-plan.md` §5 and the materialization
seam in `04-file-materialization.md` decompose into OpenSpec changes, in what order, and
why. Decision taken same day: **proceed with change C first** (A folded in as its first
slice), specced via OpenSpec in `cli/`.

**Status (2026-07-02, same day):** C is specced AND implemented through code-complete —
`cli/openspec/changes/embed-harness-runtime` (proposal, design D1–D8, 3 capability
specs, 23/25 tasks). Remaining: the live E2E + kill/resume verification, blocked on a
user-supplied OpenAI-compatible embeddings endpoint (spike S1 found the proxy serves
Anthropic `/v1/messages` but NO `/v1/embeddings`, and embedder failure is fatal to the
profile workflow). Implementation facts that supersede the research below:

- **`sessionsBasePath` cannot be per-analysis** — workflow deps close over at
  registration, once per process (DBOS forbids re-registering). It is the global
  `{dataDir}/inflexa/sessions` (`cli/src/lib/env.ts`), superseding 04 §3.1's lean.
- **"Harness impact: barrel only" was wrong in one way**: the embedder cannot call
  `DBOS.send` through its own SDK copy (module-singleton state; a second
  `node_modules` copy is un-launched), so one additive helper landed —
  `harness/src/sandbox/deliver-exec-event.ts`. The barrel also re-exports
  `createPool`/`Pool` (no cli-side `pg`) and the ledger surface.
- **Three integration requirements no research doc had**: `upsertAnalysis` must seed
  `cortex_analysis_state` BEFORE `triggerDataProfile` (the trigger's CAS transitions
  that row — without it every trigger returns "failed"); `initCortexState(pool)` must
  run at boot before launch; and the launch command must BLOCK until a terminal ledger
  state, because the durable workflow executes inside the cli process's own DBOS
  runtime — exiting after the trigger orphans the run until a future boot.
- Ported-staging fixes beyond the known two: `stageFile` now removes a stale dest
  before linking (re-staging onto an existing hardlink + `copyFileSync`'s missing
  same-inode check would truncate the user's source file).

## Upstream contributions absorbed at rebase (2026-07-02, `origin/main` @ 141bcc6)

The branch was rebased onto origin/main (one mechanical conflict in the harness
barrel: upstream's new provider-types line + our appended embedder sections; all
suites green after). Two upstream workstreams matter to this program:

### 1. AI SDK migration (`078e63f`, breaking; + streaming fix `141bcc6`)

The harness's agent loop, providers, and thread history moved from the Anthropic SDK
to the Vercel AI SDK (`ai@7`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`).
Impact on the embedding work:

- **Our composition survives unchanged.** `createAnthropicProvider` is now a
  compatibility wrapper over `createConfiguredAiSdkProvider`
  (`providers/anthropic.ts:26-32`) with the same deps shape (`baseURL` now optional)
  — verified: the S1-tested proxy wiring compiles and all 16 composition tests pass.
- **The S1 fallback now exists upstream**: `AiSdkProviderConfig` has an
  `openai-compatible` kind (`providers/ai-sdk.ts:20-37`) — if a future proxy
  deployment lacks the Anthropic Messages surface, the composition can switch kinds
  instead of writing a provider. (`createConfiguredAiSdkProvider` is not
  barrel-exported yet; the compat wrapper covers today's need.)
- **Message shapes changed on the wire types**: the harness lingua franca is now AI
  SDK `ModelMessage` (barrel exports `ChatResponse`/`ModelMessage`; Anthropic
  `Message` is gone), and the harness `messages` table stores
  `message_envelope` JSONB with a startup backfill from the legacy
  `role`/`content_jsonb` columns (`state/init.ts` — `initCortexState` still the
  boot entry point, now also the backfill site). Relevant to the future
  conversation-agent adoption (change graph beyond D), not to data-profile.
- `providers/llm-capabilities.ts` is deleted; per-model quirk-gating now lives in the
  AI SDK path.

### 2. `origin/feat/local-embeddings` (unmerged, in flux — force-pushed)

"feat(cli): add local in-process embeddings via node-llama-cpp" — a cli-side
embedding module (`cli/src/modules/embedding/`: `local-provider`, `resolve`,
`setup`) with an archived openspec change + `local-embeddings` spec. It is the
intended resolution of THIS change's blocked E2E (the S1 embedding prerequisite):
`bge-small-en-v1.5` q8_0 GGUF (36.8 MB, 384-dim, MIT) run in-process via a lazy,
opt-in `node-llama-cpp`; config `embedding.mode = local | api-key | off`;
`resolveEmbedder(config)` returns a ready `EmbeddingProvider` or a precise error.
Reconciliation notes for whoever lands the two together:

- **Seam gap their design underestimates**: their design says a cli-side realization
  injects "without any harness change", but `DataProfileDeps.embedding` is
  `{model, baseURL, token}` CONFIG — the data-profile workflow constructs its own
  embedders internally (`tasks/data-profile.ts:212-215` for the sandbox agent,
  `workspace/search-config.ts` `createEmbedder` for the write-side indexer). There is
  no `EmbeddingProvider` instance injection point on the profiling path today. The
  harness change this folder already flags as follow-up (make the embedding seam
  injectable / vector indexing optional) is exactly what their local provider needs
  to serve profiling.
- **Dimension mismatch**: `ensureSearchIndex` hardcodes `dimension: 1536`
  (`search-config.ts`), their local model emits 384-dim (they defer this with the
  store decision). Local-embedding profiles need the dimension parameterized.
- **Their `api-key` mode routes embeddings through `env.cliproxyApiUrl`** — S1
  measured 404 on `/v1/embeddings` against the Anthropic-authenticated deployment;
  that mode only works when the proxy fronts an embeddings-capable upstream. Not a
  contradiction, but the mode's precondition should be named.
- **Config-key convergence**: this change added `harness.embedding
  {baseURL, token, model}`; their change adds `embedding {mode, modelPath, apiKey}`.
  When both land, the composition root should consume their `resolveEmbedder()` and
  the `harness.embedding` key should fold into their `embedding` key (one config
  surface for one concern). Their branch also touches the same files this change
  edited (`lib/config.ts`, `lib/env.ts`, `cli/index.ts`, `package.json`) — textual
  conflicts are certain; the resolution above is the semantic target.

## Where the codebase actually is

Three facts that frame everything (each verified by direct grep/read, 2026-07-02):

1. **Nobody has ever called the harness's front door.** `assembleCoreRuntime` is
   referenced exactly twice in `harness/src`: its own file (`runtime/assemble.ts`) and
   the barrel export (`index.ts`). `harness/src/app/` is not a runnable root — it holds
   chat-turn/message-assembly/synthesize-run logic. The embedder API (`CoreRuntimeDeps`,
   seam realizations, DBOS launch sequence) is designed but unexercised; the cli will be
   its first caller.
2. **`FilesystemArtifactRegistry` has zero production instantiations** (own file + its
   test + barrel only). The custom provenance persistence is not a working system being
   replaced — it was built for an embedder that never arrived. Deleting it (change E) is
   unblocked *today*.
3. **The cli's launch path stops at chat.** `cli/src/modules/analysis/launch.ts`
   resolves a `ChatTarget {sessionId, workingDir, analysis}` for the TUI; no code path
   can run an analysis. Anchors, analyses, inputs, prov, Postgres provisioning (PR #20)
   all exist — the product's core verb is missing.

```
            cli (works today)                  harness (works today, in isolation)
  ┌──────────────────────────────┐      ┌────────────────────────────────────┐
  │ anchors → analyses → inputs  │      │ assembleCoreRuntime ← NEVER CALLED │
  │ TUI chat (own proxy/models)  │      │   ├ dataProfile workflow           │
  │ tsprov ledger (chat events)  │      │   ├ executeAnalysis + sandboxStep  │
  │ postgres infra (PR #20) ─────┼──?──▶│   └ conversation agent             │
  └──────────────────────────────┘      │ Docker sandbox + 4-layer prov      │
                 ▲                      └────────────────────────────────────┘
                 └────── nothing crosses this gap in either direction ────────┘
```

## The five changes

```
A. add-input-staging (cli)          B. port-prov-run-events (cli)
   staging module + sessionTree        stash port: events, builders,
   helpers + layout decision           recorder cases, 03 §4 fixes
        │                                   │
        ▼                                   │
C. embed-harness-runtime (cli + harness barrel)
   pkg dep, composition root, Postgres+DBOS launch,
   trigger dataProfile on staged inputs   ◀── walking skeleton #1
        │                                   │
        ▼                                   │
F. embed-execute-analysis (cli + harness barrel)   ◀── walking skeleton #2
   run engine: registerSandboxStep+registerExecuteAnalysis cohort,
   plan intake (dev surface), stub ArtifactRegistry, `inflexa run`
        │                                   │
        └────────────┬──────────────────────┘
                     ▼
D. bridge-harness-provenance (cli + tiny harness change)
   ArtifactRegistry bus adapter + run-lifecycle events
   (03 §3 Option A/B) + end-to-end signed-document test
                     │
                     ▼
E. remove-custom-provenance-persistence (harness)
   delete the GOES items (03 §1), spec hygiene (03 §5.6)
```

| Change | Subsystem(s) | Source material | Hard deps |
|---|---|---|---|
| A — add-input-staging | cli | `04` §3–§5, `05` §3 (module verdict + 2 fixes) | none |
| B — port-prov-run-events | cli | `03` §4 (schema + 7 fixes), `05` §2 (port plan) | none |
| C — embed-harness-runtime | cli + harness barrel | `04` §1–§3, old `04-composition-wiring.md` | A (`DataProfileWorkflowInput.stagedInputs` is required, `data-profile.ts:86-95`) |
| F — embed-execute-analysis | cli + harness barrel | this doc, `cli/openspec/changes/embed-execute-analysis/` | C (reuses the booted runtime, seams, command pattern) |
| D — bridge-harness-provenance | cli + harness (Option A only) | `03` §2–§3, §5.3–5.4 | B and F (F gives observed run boundaries + a live `ArtifactRegistry` call site) |
| E — remove-custom-prov-persistence | harness | `03` §1 GOES table | none technically; sequenced after D to keep a fallback visible |

Parallelism: B is independent of A/C/F (pure cli, blueprint-complete from the stash) but
its events have no emitter until C lands — it can proceed any time motion is wanted.

## Change F — embed-execute-analysis (walking skeleton #2)

**Status (2026-07-03):** specced AND implemented, 19/19 tasks, live E2E green. The
run engine — `executeAnalysis` parent + `sandbox-step` children — now has its first
caller anywhere. The change graph originally routed C→D; grounding D against the code
during F's exploration showed the gap: the `ArtifactRegistry` seam and the run
boundaries D hangs events on fire ONLY inside `executeAnalysis`, which nothing could
trigger (its sole caller is the conversation agent's `executePlan` tool, and the cli
runs no conversation agent). So F was inserted as C's successor: build and prove the
run engine before speccing provenance against a runtime whose shape had never been
observed — the same risk logic that put C first.

What F landed (all in `cli/src/modules/harness/`, plus additive harness barrel
growth + one additive `upsertPlan` state fn):

- **Registration cohort grew from one workflow to three + scheduled hygiene
  workflows**: `registerSandboxStep` → `registerExecuteAnalysis` (child before
  parent — the parent's deps close over the registered child callable, mirroring
  `assemble.ts:75-76`) → the existing data-profile registration →
  `registerSandboxReaper`/`registerWatchdog`/`registerNotificationSweep`, all before
  the single `launchDbos`. `assembleCoreRuntime` stays deferred (it also builds the
  conversation agent + target-assessment + ephemeral, none exercised here) — C's D1
  debt is restated, not discharged: move to the full root at conversation-agent
  adoption.
- **`SandboxStepDeps`/`ExecuteAnalysisDeps` realizations**: catalog-backed
  `buildAgent` (`createSandboxAgents(deps)[agentId]`), `resolveWritePrefix` via the
  harness's own `runStepDir`, a real `EmbeddingProvider` instance, no-op `RunCharge`,
  `synthesisEnabled` left true, and a **stub `ArtifactRegistry`** (registers nothing,
  `failedCount: 0`, no-op sync). The stub is contract-honest: the post-step pipeline
  fails a step only on `failedCount > 0`, and registry impls must not touch
  `cortex_artifacts` (the harness writes the local ledger around the seam). Run
  outputs are ledgered + on disk with NO external provenance yet — the change-D gap,
  carried in the stub's `TODO(extend)`.
- **Plan intake — a deliberately temporary dev surface** (`plan_intake.ts`): file →
  `AnalysisPlanSchema` → `validatePlan` → deterministic `pln-` id (sha256 over
  analysisId + file bytes; stable id ⇒ re-run dedups) → `upsertPlan`. Under a
  `TODO(extend)` clearing contract with the `plan-intake` spec: retired at
  conversation-agent/planner adoption, together with the replicated trigger flow.
- **`inflexa run <analysis> --plan <file>`** (`run.ts`): the deliberate action, a
  faithful replica of `executePlan`'s dedup→reserve→authorize→build→launch flow
  (same `TODO(extend)`), blocking to a terminal `RunStatus` with live per-step
  progress, `--status` read-only view, Ctrl+C detach with DBOS-recoverable semantics.

Findings verified during F (feed the later changes / upstream):

- **`registerAnalysisWorkflows` is unusable by an embedder** — it takes a
  fully-formed `ExecuteAnalysisDeps` (with `sandboxStepCallable`), which only exists
  after `registerSandboxStep` runs, and registering the child itself would
  double-register. Flagged in its JSDoc; embedders register directly in
  assemble-order (as F and `assemble.ts` do).
- **`executeAnalysis` does NOT materialize inputs** — its docstring claimed it did;
  `validateAndInit` only mkdirs the run dir + opens the charge. Corrected upstream.
  The embedder must stage `data/` before triggering (F does, same as profile).
- **`ExecuteAnalysisInput.steps` uses the scheduler's minimal `PlanStep`**
  (`{id, depends_on}`), not the richer schema type; a parsed `AnalysisStep[]` is
  structurally assignable, no cast.

What D now inherits from F: observed `executeAnalysis` run boundaries to hang
`prov.run_started`/`prov.run_completed` on, and a live `ArtifactRegistry` call site —
D shrinks to swapping the stub for the bus adapter + adding run-lifecycle events.
Note the new fact strengthening 03 §3 Option B: `inflexa run` already BLOCKS to a
terminal ledger status, so cli-side run-lifecycle emission has authoritative status
without a harness change.

## Why C first (A folded in as its first slice)

All the risk in this program lives in the one thing that has never run. The provenance
work (B, D) is verified-by-reading with a design-complete blueprint — low uncertainty,
portable almost verbatim. What is genuinely unknown is the embedding seam:
`DataProfileDeps` (`harness/src/tasks/data-profile.ts:58-79`) demands `ChatProvider`,
`Pool`, `SandboxClient`, `WorkspaceFilesystem`, `RunAuthorizer`, `resolveBilling`,
`embedding` config, `bioKeys`, `skillsDir` — several with **no cli realization at all
today**. Whether the cli's model proxy satisfies `ChatProvider`, what a local-first
`resolveBilling` is, how DBOS launches inside the cli process against the PR #20
Postgres — these only get answered by making one workflow actually execute.

A walking skeleton — `inflexa` stages the analysis's inputs and triggers a real
data-profile run in a real sandbox, outputs landing on host disk — converts the whole
dependency column from "designed" to "proven". Every later change becomes small and
local. Building the prov bridge first would mean speccing events against a runtime whose
shape has never been observed.

## Design questions change C must settle

1. **`assembleCoreRuntime` vs direct registration.** The full root builds the
   conversation agent unconditionally, but the cli has its own chat. Stub
   `ConversationAssemblyDeps`, or deep-import `registerDataProfileWorkflow` and defer
   the full root? The assemble docstring declares wiring order load-bearing — bypassing
   it must be a deliberate, documented debt if chosen.
2. **Local seam realizations**, each named in the spec: no-op billing, always-allow
   `RunAuthorizer`, cli proxy as `ChatProvider` (verify interface fit), embedding config
   (local model vs skip vector indexing at first), `bioKeys` sourcing, `skillsDir`
   pointing at the repo-root `skills/`.
3. **The two materialization decisions carried in from A** (`04` §3, §5):
   - layout `data/inputs/local/{key}` vs `{fileId}/` — recommendation: keep
     `local/{key}`, fix the spec/prompt examples;
   - `sessionsBasePath` per-analysis vs global — the stash's design implies
     per-analysis (`resolveOutputDir(analysis)/{analysis.id}`).
4. **Where the trigger lives in the cli.** It must be a deliberate action (staging
   writes files — no-litter policy forbids passive-flow writes), presumably a command /
   TUI action adjacent to `launch.ts`'s territory, never part of bare `inflexa` launch.
5. **Barrel growth in the harness**: export `StagedInput` + `triggerDataProfile`
   (neither is exported today, grep-verified) — the one harness-side edit C needs.

## What each later change inherits from C

- D gets a proven `ArtifactRegistry` seam location and observed run boundaries to hang
  `prov.run_started`/`prov.run_completed` on, plus the Option A/B decision made against
  a running system.
- E gets confidence: once the cli adapter is the registry realization, the filesystem
  registry has no hypothetical consumer left.
- B's §4 fixes (deterministic QNames, activity/entity resolution, actor kind) are
  unaffected by C — the port can proceed from the stash blueprint whenever.
