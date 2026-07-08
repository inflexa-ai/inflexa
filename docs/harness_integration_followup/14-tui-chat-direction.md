# 14 — TUI Chat Direction (BINDING — user decision 2026-07-08)

This document is a **product decision**, not research. It supersedes the sequencing in
`13-sequencing-memo.md` §2/§4 (the daemon-first staging: skeleton → #33 M1/M2 → TUI as
M3/M4). That ordering postponed the actual goal indefinitely and is dead. **The chat
ships in the TUI now, embedded.** The daemon (#33) remains a *later transport swap
underneath an unchanged TUI* — it is never a prerequisite for anything in this doc.

## The decision

1. **One chat.** The TUI chat — what plain `inflexa` opens — talks to the **harness
   conversation agent**. There is no product value in a second, willy-nilly proxy chat
   beside it. The proxy engine (`cli/src/modules/intelligence/chat.ts` — `chat()` +
   `toModelMessages`) is retired; its boot-consumed helpers survive relocation
   (`readApiKey`/`resolveModelId`/`pickDefaultModel`, `chat.ts:200-229`, imported by
   `modules/harness/runtime.ts:50`).
2. **Parity target = Cortex managed.** The flow the user experiences: the analysis's
   data gets profiled → they converse to shape a plan → the agent executes it → they
   inspect results — all inside the TUI.
3. **The text commands are dev surfaces, not product.** `inflexa chat` (clack REPL),
   `inflexa profile`, `inflexa run` (`cli/src/cli/index.ts:134,147,161`) exist to
   exercise machinery. Once the TUI does the job they are gated under a `dev` umbrella
   and excluded from production builds. A user never runs them.
4. **Embedded boot is accepted.** The TUI process boots the harness runtime itself.
   Boot latency is a UX problem (animation + input gate, below), not an architecture
   gate. When #33 lands, the boot swaps for a daemon client and the TUI above it does
   not change — which is why everything here builds against the harness `contracts/`
   vocabulary, never the cli bus shapes (`11-chat-topology.md` §5b).

## Cortex parity reference (verified 2026-07-08)

- Profile is **auto-triggered when an analysis is seeded with inputs** — not asked for
  in chat: `triggerDataProfile` fires inside the seed route
  (`cortex/harness/routes/analyses.ts:114-122`), re-fires when the seeded input set
  drifts from the profiled set (`:218-234`), and has a retry route (`:289`).
- The UI reads profile status from a dedicated route (`GET …/chat-context`,
  `analyses.ts:10`) to decide what the chat surface shows/allows.
- Chat turns stream over the loop's emit events framed as Cortex-native SSE; plan and
  run cards arrive as `data-plan`/`data-run-card` parts; approval is conversational
  (`12-planner-flow.md` §2, `11-chat-topology.md` §4).

## What is already proven and transfers as-is

PR #45 (`embed-conversation-agent`, archived) retired the risky machinery live:

- Boot: `assembleCoreRuntime` + ephemeral sweep + conversation deps
  (`modules/harness/runtime.ts`), handle exposes `conversationAgent` + `provider`.
- Turn loop: `prepareChatTurn → runAgent(createStreamingChat(provider, emit)) →
  appendTurn` with the session scope that stamps `cortex_runs.thread_id` — verified
  end-to-end (chat → plan `pln-beb09e5e` → real run with `thread_id` stamped).
- Event rendering logic: `modules/harness/chat_printer.ts` already consumes
  `CortexChatEvent`/`CortexChatPart` (text-delta accumulation, tool chips,
  plan/run-card readers, sub-agent drop on `callPath.length > 1`).
- Sidebar-ready reads are barrel-exported: `loadDataProfileStatus`
  (`harness/src/index.ts:203`), `queryRunsByAnalysis`/`queryActiveRun` (`:259`),
  `queryStepsByRun` (`:261`), `triggerDataProfile`/`runDataProfile` (`:186`).

## Change sequence — each change ships user-visible TUI behavior

### 1. `tui-harness-chat` — the chat ships (FIRST, nothing before it) — LANDED 2026-07-08

**Status: landed + archived.** The TUI chat now talks to the harness conversation
agent. Live-verified end-to-end (one PTY pass, exit 0): boot animation + input gate →
ready → streamed turn rendered through the emit adapter → profile parity trigger fired
→ clean quit, zero errors. Shipped: the shared turn engine (`modules/harness/turn.ts`,
consumed by both the TUI and the REPL), the boot-state store + normal-stdio preamble
gates + boot animation, the emit adapter over the harness `contracts/` vocabulary with
`plan-card`/`run-card` blocks (design gallery entered), `threadId := sessionId` binding
(D1), the analysis-swap lock exchange, and the parity profile auto-trigger. 535 cli
tests pass (0 fail) after the adversarial-verify and PR-review fix passes. The proxy
engine lost its last TUI caller (its deletion is change 3).

- **Turn engine extraction.** Lift the headless turn core out of
  `modules/harness/chat.ts` (`runTurn`'s prepare → runAgent → append, the session
  scope, abort wiring) into a shared module function consumed by BOTH the TUI and the
  dev REPL. The TUI must not reimplement what the REPL already proved; the REPL keeps
  working as the harness-side E2E vehicle.
- **Boot-on-open with a gate.** Opening an analysis chat is the deliberate action that
  boots the runtime (per-analysis lock is already taken pre-render,
  `tui/app.launch.tsx:33`). Boot runs async after `render()`; a boot-state store
  (`booting → ready | failed`) drives a boot animation and keeps the chat input
  disabled until ready. Boot failure renders actionable (the `describeBootError`
  taxonomy), never a dead screen.
- **Send path swap.** `conversation.send` stops calling the proxy engine and drives
  the turn engine. The emit adapter maps `CortexChatEvent`/`CortexChatPart` into the
  existing reducer shape: `text-delta` → the `streamText` signal, `finish` → flush
  (`tui/hooks/conversation.ts:65-95` transfers). **Clone every object crossing into
  the Solid store** — in-process emit reuses references; the exact hazard
  `conversation.ts:138-142` documents.
- **Threads.** pg threads own the conversation (`11-chat-topology.md` §3). **Landed
  refinement (change 1, design D1):** `threadId := sessionId` — the pg thread binds
  1:1 to the SQLite session, so the entire existing session machinery (launch
  resolution, the session picker, in-place swap, sidebar identity) carries the thread
  with zero new selection UI (`prepareChatTurn` creates the absent thread row under the
  given id). This is cleaner than the "resume the analysis's latest thread else mint"
  sketch above, which would have decoupled the transcript from the session picker.
  History renders via `loadPage` → `contentToCortexMessages`. A thread picker is a
  later nicety, not v1.
- **Parts rendering.** Tool chips + plan/run cards become TUI blocks — design-gallery
  first, reusing existing block patterns (`tool_block.tsx`, `run_block.tsx` exist as
  gallery pieces). Parity minimum: the plan is readable in the transcript for
  conversational approval; the run card appears on execute.
- **Profile at parity.** If the analysis has inputs but no completed profile, trigger
  it from this deliberate open (Cortex parity: profiling is automatic, not requested
  in chat) and surface its state; the exact chat-gating while profiling matches what
  `chat-context` implies — verify against Cortex during the change.

### 2. `tui-sidebar-live` — the sidebar tells the truth

- **DATA PROFILE section** (new): status from `loadDataProfileStatus`, clickable and
  keybound (keymap layer + dialog subsystem) to open a details view — profile summary,
  per-input coverage, timestamps, retry state.
- **RUNS section**: replace `mockRuns` (`tui/layout/sidebar.tsx:134-144`) with
  `queryRunsByAnalysis` rows + `queryStepsByRun` detail; live-update on a tick or bus
  event while a run is active.
- **CONTEXT section**: `mockContext` (`sidebar.tsx:110-115`) is dropped or replaced
  with something real — no fake data remains visible anywhere.

### 3. `retire-proxy-chat-dev-umbrella` — one chat, clean tree

- Delete the proxy engine (`intelligence/chat.ts` `chat()`/`toModelMessages` and the
  bus streaming path); relocate `readApiKey`/`resolveModelId`/`pickDefaultModel` to a
  home that doesn't imply a chat engine (e.g. `modules/proxy/`). SQLite
  `sessions`/`messages`/`parts` freeze as legacy-readable (no new writes; `inflexa
  sessions` fate decided in-change).
- Gate `profile`, `run`, `chat` under a `dev` umbrella absent from production builds
  (`scripts/build.ts` mechanism decided in-change).

Changes 1→2→3 in order. 3 may ride earlier only if trivially separable; nothing rides
before 1.

## Hard rules for every future change in this program

1. Every change ships user-visible TUI behavior. No infrastructure-only changes, no
   new text-command surfaces, no "temporary dev surface" REPLs.
2. Never invent prerequisites. If a step seems to need the daemon, it doesn't — do it
   embedded; #33 is a transport swap later.
3. Build TUI adapters against `CortexChatEvent`/`CortexChatPart` (harness contracts),
   never the cli bus event shapes — that is what makes the daemon swap a no-op for
   the TUI.
4. Reuse before building: the turn engine is shared with the REPL; lists, dialogs,
   inputs, and blocks come from the existing component kit; new visuals enter the
   design gallery.

## Accepted trade-offs (decided, do not re-litigate)

- **TUI holds the runtime + per-analysis lock while chatting.** `inflexa run`/
  `profile` on the same analysis conflict-refuse meanwhile — acceptable; they are dev
  surfaces (decision 3) and the daemon later dissolves the topology.
- **Boot cost on chat open** — mitigated by the animation/input gate, not avoided.
- **Throwaway inventory of embedding** (the in-process emit adapter) — bounded to the
  adapter layer by hard rule 3; everything else transfers per `13` §1.
