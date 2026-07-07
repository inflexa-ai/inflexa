# Tasks: embed-conversation-agent

## 1. Harness riders (additive; land first — the cli work imports them)

- [x] 1.1 Barrel-export the conversation surface from `harness/src/index.ts`: `prepareChatTurn` + its param/result types, `createThreadStore`/`createThreadHistory` + `StoredMessage` + thread types, `contentToCortexMessages`/`createCardResolver`, `passthroughStep`, `sweepEphemeralWorkflows`, and the `CoreRuntimeDeps`/`ConversationAssemblyDeps`/`CoreWorkflowDeps` types; export the `contracts/` chat-event and chat-part types (`CortexChatEvent`, `CortexChatPart`, part registry types). Additive only — no moves, no renames. Run `bun run typecheck` in `harness/`.
- [x] 1.2 Fix stale harness docs: `harness/CLAUDE.md:151` (contracts now genuinely barrel-exported — make the sentence true), `harness/CLAUDE.md:146` (remove the `consumeStream`/background-completion claim; `app/chat-turn.ts` is preparation-only), and the two stale docstrings if trivially reachable (`agents/conversation-agent.ts:15-16,108-109`, `tools/execute-plan.ts:56` — dead `registerAnalysisWorkflows` producer claim and wrong composite workflow-id shape).
- [x] 1.3 Rebuild/refresh the harness package consumed by the cli (`file:../harness` — whatever `bun install`/build step the cli needs to see the new exports).

## 2. Boot adoption (cli composition root)

- [x] 2.1 Reshape `buildExecuteAnalysisDeps` (`cli/src/modules/harness/run_deps.ts`) into the `buildExecuteAnalysis: (child) => ExecuteAnalysisDeps` closure shape `CoreWorkflowDeps` wants; add the `ephemeral` deps bundle (all fields already in `RunEngineComposition`) and the `executeTargetAssessment` deps bundle (pool, runAuthorizer, ncbi key, provider, models — all at the root).
- [x] 2.2 Realize the three conversation gaps: `templatesDir` config key in `resolveHarnessConfig` (default: repo-root `templates/`, resolved like `skillsDir`; pre-flight gate that it exists), `chrome: {}`, `createPreviewPublisher: async () => new UnavailablePreviewPublisher()`.
- [x] 2.3 Replace direct workflow registration in `bootHarnessRuntime` (`runtime.ts`) with `assembleCoreRuntime({conversation, workflows, resourcePolicy})`; keep hygiene crons, ingress, `initCortexState`, embedder probe in boot; expose `conversationAgent` on the runtime handle. Comment records that `executeTargetAssessment` is registered deliberately untriggerable (design D1).
- [x] 2.4 Call `sweepEphemeralWorkflows({pool, logger, executorId: "local"})` between `initCortexState` and `assembleCoreRuntime` (strictly before `launchDbos`).
- [x] 2.5 Unit coverage: boot-order test asserting sweep-before-launch and one-cohort registration still holds (extend the existing runtime boot tests rather than inventing a new harness).

## 3. Locks (#37 interim fix 1)

- [x] 3.1 `inflexa run` and `inflexa profile`: acquire `acquireInstanceLock(analysis.id)` after resolution, before boot/mutation; conflict → stderr message naming the analysis + non-zero exit. Match the TUI's message shape (`app.launch.tsx`).
- [x] 3.2 Unit test: second acquire against a live holder is refused; dead-pid reclaim path unaffected (extend `lock.ts` tests only if behavior there changes — it should not).

## 4. The chat command

- [x] 4.1 Create `cli/src/modules/harness/chat.ts`: resolve analysis → pre-flight (same gates as run/profile + templates dir) → `acquireInstanceLock` → boot → thread create (default) or resume (`--thread <id>`; foreign/absent → actionable not-found exit). `TODO(extend)` header per the clearing contract (#33 M3 named replacement, `chat-command` spec named as the record to clear).
- [x] 4.2 Turn loop: clack line prompt → `prepareChatTurn` → `runAgent(agent, messages, session, {provider, signal, emit, runStep: passthroughStep})` with `threadId` in the session scope → `appendTurn(threadId, [userMessage, ...loopOutput])`. neverthrow-first at every boundary; no DBOS SDK imports; no raw SQL.
- [x] 4.3 The printer (own small module beside the command): copy-on-receive; drop `source.callPath.length > 1`; accumulate + flush `text-delta`s (no typewriter); tool chips on started/finished; `data-plan` and `data-run-card` text renderings; one-line tagged fallback for other conversation parts; stderr for diagnostics.
- [x] 4.4 Abort semantics: per-turn `AbortController`; SIGINT mid-turn aborts the turn and returns to the prompt (partial turn persisted); SIGINT/EOF at the prompt exits cleanly (locks released, graceful runtime shutdown); second SIGINT during abort force-exits.
- [x] 4.5 Register the command in the commander registry (lazy-imported action, same shape as `run`/`profile`).
- [x] 4.6 Unit coverage for the printer (pure: given an emit sequence, assert stdout lines — sub-agent drop, chip lifecycle, plan/run-card rendering, unknown-part fallback, no retained references) and the thread-selection branches (mock pool boundary as existing harness-module tests do).

## 5. Clearing-contract rewrites (#32 stage 1, docs-only)

- [x] 5.1 Rewrite the `TODO(extend)` header in `plan_intake.ts`: intake is the protocol replay surface; planner is the primary author; hand-authoring is a dev workflow; `plan export` is the named follow-up.
- [x] 5.2 Rewrite the `TODO(extend)` header in `run.ts`: the trigger replica stands until #33 M2 absorbs it into the daemon trigger endpoint (not deleted at adoption); fix the now-stale "the cli runs no conversation agent" language.

## 6. Live E2E findings (budgeted, frugal — one or two real conversations)

- [x] 6.1 Boot + first turn: `inflexa chat <analysis>` on a prepared analysis; verify first-ever `assembleCoreRuntime` assembly, a streamed text answer, tool chips, and `appendTurn` persistence (second turn sees the first in context).
- [x] 6.2 The full product loop, once: ask for an analysis plan → `data-plan` renders → approve conversationally → `execute_plan` launches a real run (`cortex_runs.thread_id` stamped with the chat thread) → later turn `inspect_run` reads results. Record findings (bugs found = new tasks here, not scope creep).
- [x] 6.3 Abort + lock checks (no credits): Ctrl+C mid-turn returns to prompt; concurrent `inflexa run` on the same analysis is refused while chat holds the lock; chat refused while TUI holds it.
- [x] 6.4 Record E2E findings + resolutions in the change (append to this file or a findings note), matching the C/F discipline.
