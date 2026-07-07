# Design: embed-conversation-agent

## Context

The harness ships a complete, never-run conversation stack: `assembleCoreRuntime`
(`harness/src/runtime/assemble.ts`) builds the five-workflow cohort plus the
conversation agent; `prepareChatTurn`/`appendTurn` (`app/chat-turn.ts`,
`memory/thread-history.ts`) are the transport-free turn halves; `contracts/` carries
the consumer wire vocabulary (`CortexChatEvent`, 17 `CortexChatPart`s). All of it has
zero production callers (`docs/harness_integration_followup/10-conversation-agent-inventory.md` §0.3, §5 —
the managed Cortex host vendors an older harness and wires by hand). The cli boot
(`cli/src/modules/harness/runtime.ts`) registers workflows directly, deferring the
composition root (change C decision D1).

This change is the Ordering-C walking skeleton from `13-sequencing-memo.md` §3: prove
the whole conversational loop embedded, behind a deliberately temporary clack command,
before #33's daemon milestones build the product surface on it. Constraints inherited
from the program: the DBOS quarantine (cli never imports `@dbos-inc/dbos-sdk`), the
no-litter policy (passive flows write nothing), neverthrow-first error handling, the
no-forEach rule, and the boundary rule (harness-first design; the cli supplies values
at its composition root).

## Goals / Non-Goals

**Goals:**

- First production execution of `assembleCoreRuntime` — discharge C's D1 debt.
- Prove the proxy-backed `ChatProvider` sustains the conversation agent's tool loop
  (40 tools' schemas per call, 50-iteration cap, 13-iteration inner planner).
- Round-trip the pg thread machinery (`appendTurn` → `loadRecent` window → working
  memory render → analysis-context injection).
- Close the full product loop once, live: `generate_plan` → `show_plan` part →
  conversational approval → `execute_plan` → real `executeAnalysis` run with
  `cortex_runs.thread_id` stamped → `inspect_run` on a later turn.
- Carry all three emit categories (deltas / orchestration events / data parts)
  through one in-process sink without ordering surprises.
- Close the #37 two-recorder window for these surfaces via the per-analysis lock.

**Non-Goals:**

- No TUI work (rendering built at #33 M3/M4 against the wire contracts).
- No SSE framing, reconnect semantics, or multi-client behavior.
- No plan-lineage provenance rider (successor change `record-plan-lineage`).
- No proxy-chat retirement (decided at TUI cutover, M3).
- No `executeTargetAssessment` trigger surface.
- No paced/typewriter output anywhere (settled: render accumulated text).

## Decisions

### D1 — Adopt the full composition root, including its two extra registrations

`bootHarnessRuntime` replaces direct `register*` calls with
`assembleCoreRuntime({ conversation, workflows, resourcePolicy })`. Alternative
(continue direct registration, add only what chat needs) rejected: it preserves a
hand-maintained mirror of `assemble.ts`'s order invariants that the builder API makes
unrepresentable (child-before-parent is a type error there). Consequences accepted:

- `executeTargetAssessment` is registered **deliberately untriggerable** — no cli
  surface can launch it; harmless at runtime (never launched → never recovered).
  This line is the design record the inventory (§1b) required. The fallback, if
  honesty-over-completeness is later preferred, is a small harness change making it
  optional in `CoreWorkflowDeps` — not direct registration.
- `buildExecuteAnalysisDeps(composition, child, runAuthorizer)` reshapes into the
  `buildExecuteAnalysis: (child) => ExecuteAnalysisDeps` closure (mechanical).
- The hygiene crons (`registerReaper`/`registerWatchdog`/`registerNotificationSweep`),
  `initCortexState`, ingress, and the embedder probe stay in `bootHarnessRuntime` —
  `assembleCoreRuntime` does not own them.
- The runtime handle grows `conversationAgent` (the assembled `AgentDefinition`).

Boot sequence after adoption (from inventory §5, normative for the spec delta):

```
prerequisites (skills, templates, embedder probe, key, model) → ensurePostgres →
startIngress → acquire runtime lock → createPool → initCortexState →
sweepEphemeralWorkflows(pool, executorId "local") →
assembleCoreRuntime(...) → registerReaper/Watchdog/NotificationSweep →
launchDbos → HarnessRuntime{…, conversationAgent}
```

### D2 — `sweepEphemeralWorkflows` is a mandatory pre-launch boot duty

The moment `ephemeral` is registered, a host crash mid-`run_ephemeral` leaves a
`PENDING ephemeral:*` row that the next boot's recovery would re-dispatch — running a
sandbox for a chat turn that no longer exists (inventory §2.5; `runtime/dbos.ts:152-164`:
"the only race-free point is a direct system-DB UPDATE before launch"). The sweep is
called between `initCortexState` and `assembleCoreRuntime`, and is barrel-exported from
the harness (rider). Not optional, not deferred-to-first-chat: registration alone
creates the hazard.

### D3 — The three dep realizations

- `templatesDir`: config-overridable, default = repo-root `templates/` resolved the
  same way `skillsDir` is today. The installed-cli packaging caveat change C recorded
  for `skillsDir` applies verbatim and stays open — recorded, not solved here.
- `chrome: {}` — honest local default; with the unavailable preview publisher,
  `preview_snapshot` short-circuits before touching Chrome. A config key can expose
  `browserUrl` later.
- `createPreviewPublisher: async () => new UnavailablePreviewPublisher()` — the
  barrel-exported class; report preview degrades gracefully, `submit_report` remains
  the only gate.

### D4 — Command surface: a REPL, new thread by default, `--thread` to resume

`inflexa chat <analysis>` (clack, `src/modules/harness/`, lazy-imported action — the
same shape as `run`/`profile`). REPL over one-shot because it exercises multi-turn
windowing (`loadRecent` + working memory across turns) — the thread machinery is half
the point. Per invocation: resolve analysis → pre-flight → per-analysis instance lock
(`acquireInstanceLock(analysis.id)`, `src/lib/lock.ts` — same key the TUI takes) →
boot → thread: `createThreadStore(pool).createThread(...)` by default, `--thread <id>`
resumes (ownership enforced by `prepareChatTurn`'s `not_found` on foreign threads) →
loop: read line → `prepareChatTurn` → `runAgent(agent, messages, session, { provider,
signal, emit, runStep: passthroughStep })` → `appendTurn(threadId, [userMessage,
...loopOutput])` → print → next line. The session is built with `threadId` in scope so
`execute_plan` stamps `cortex_runs.thread_id` (the lineage hook the managed route
proves; `12-planner-flow.md` §3.4).

Clearing contract: the command module carries a `TODO(extend)` header naming #33 M3 as
the replacement and the `chat-command` spec as the record to clear — the same contract
shape `plan_intake.ts` carries. Everything else it exercises transfers verbatim.

### D5 — The printer: copy-on-receive, top-level only, accumulate-then-render

One in-process `EmitFn` sink. Rules, each load-bearing:

- **Copy immediately.** In-process emit shares mutable references with the loop (the
  same hazard the TUI's clone-before-store rule guards). The printer extracts what it
  renders (strings, ids, statuses) at receipt and never retains a received object.
- **Top-level only.** Drop events with `source.callPath.length > 1` — sub-agent
  traffic (literature reviewer, planner internals) stays out of the transcript, the
  same filter the managed `translateEvent` applies.
- **Accumulate deltas, render coarsely.** `text-delta`s append to a turn buffer
  flushed to stdout as received (the proxy's ~sentence-sized chunks are the pacing; no
  typewriter — settled repo-wide). Tool chips print one line on `tool-started` and
  complete on `tool-finished` (name + status + duration). `data-plan` renders id,
  title, and step lines; `data-run-card` renders runId, title, and step count — the
  fields the harness `RunCardData` contract actually carries (it has no run-status
  field). Other parts (already filtered to conversation-emitted ones) print a one-line
  tagged fallback — the skeleton must *observe* unknown traffic, not hide it.
- stderr carries diagnostics; stdout is the conversation.

### D6 — Approval stays conversational; the hard gate is named, not built

Prompt-enforced approval (the product mechanism — `12-planner-flow.md` §2: the plan is
persisted by `submit_plan` before any human sees it; approval is a user message). The
structural fallback if unprompted launches are ever observed: a "pending-approval"
`RunAuthorizer` realization refusing un-flagged launches — an embedder-side seam, no
harness change. Recorded here so the skeleton's trust framing is deliberate.

### D7 — Ctrl+C aborts the turn, not the process

Each turn gets an `AbortController`; SIGINT during a streaming turn aborts it. The
user's message is persisted by `appendTurn`, but the loop's partial assistant output is
not: `runAgent` throws on abort before returning its message array, so that output is
structurally unavailable to the caller (this is the honest consequence of the D10
no-harness-change constraint — a version that persisted partial output would need
`runAgent` to return-on-abort). Tokens already streamed stay visible on the terminal
but do not enter the thread. SIGINT at the prompt exits the REPL cleanly: release locks,
close the runtime (existing shutdown path). A second SIGINT during abort-in-flight
force-exits.

### D8 — The per-analysis lock extends to `run`, `profile`, and `chat`

#37 interim fix 1: `inflexa run` and `inflexa profile` call
`acquireInstanceLock(analysis.id)` after resolution, before any mutation; a conflict
prints the holder and exits non-zero — identical UX to the TUI's launch guard. With
`chat` also holding it, every provenance-emitting surface on one analysis is
single-process for its duration (closes the exact two-recorder pair #37 documents,
for these surfaces; M2 closes it structurally). The lock is PID-liveness-based, so a
crashed holder is reclaimed.

### D9 — #32 stage-1 rewrites are docs-only and ride along

This change is the named "adoption arrives" trigger the clearing contracts point at.
The `plan-intake` spec purpose/requirement invert to "protocol replay surface; planner
is the primary author; hand-authoring is a dev workflow"; the `TODO(extend)` headers
in `plan_intake.ts` and `run.ts` rewrite to match (currently they instruct deletion).
No intake/trigger code changes. `run.ts`'s replicated trigger is absorbed by #33 M2 —
that is recorded in the rewritten spec, discharging #32 item 4 with no harness
extraction.

### D10 — Harness riders: additive barrel exports + doc corrections only

Barrel additions (`harness/src/index.ts`): `prepareChatTurn` + its types,
`createThreadStore`/`createThreadHistory` + `StoredMessage`,
`contentToCortexMessages`/`createCardResolver`, the `contracts/` chat-event/part
types, `sweepEphemeralWorkflows`, `passthroughStep` (currently unexported —
`loop/run-step.ts:25`), and the `CoreRuntimeDeps`/`ConversationAssemblyDeps`/
`CoreWorkflowDeps` types. Doc fixes: `harness/CLAUDE.md:151` (contracts claimed
barrel-exported — make it true and keep the sentence), `:146` (stale `consumeStream`
claim), and the two stale docstrings flagged in inventory §0.4 if trivially reachable.
House precedent: barrel growth over deep imports (C D7, F D8). No harness behavior
changes, so no harness-tree openspec change — same rider budget as changes C/F.

## Risks / Trade-offs

- **First-ever `assembleCoreRuntime` execution may surface assembly bugs** → budgeted
  live-E2E findings task group (changes C and F both converted such findings into
  fixes); failures land as findings, not scope creep.
- **Proxy provider at 40-tool scale is unproven** (schema payload size, tool-call
  fidelity through CLIProxyAPI) → the skeleton exists to observe exactly this; be
  frugal — one or two live end-to-end conversations, not a soak.
- **In-process emit mutable-reference hazard** → D5 copy-on-receive rule; also the
  reason the printer never buffers received objects.
- **Registered-but-untriggerable `executeTargetAssessment` reads as dead code** →
  deliberate, recorded in D1; revisit only if the harness makes it optional.
- **Chat boot latency** (Postgres readiness, DBOS launch, embedder probe, image
  check) → acceptable: `chat` is a deliberate command, not a passive flow; no-litter
  is untouched.
- **REPL is throwaway** → by design; it is the *only* throwaway (13 §2 Ordering C),
  and it carries the clearing contract in code and spec.

## Migration Plan

Purely additive; no data migration. Rollback = revert the commit (no schema changes;
pg thread tables already exist via `initCortexState`). The command ships immediately
usable but marked temporary.

## Open Questions

- `templatesDir`/`skillsDir` packaging for an installed (non-checkout) cli — remains
  open from change C; recorded in D3, not blocking (checkout-run is the supported
  mode today).
