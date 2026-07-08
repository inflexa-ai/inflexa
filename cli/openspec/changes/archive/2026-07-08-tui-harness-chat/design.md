# tui-harness-chat — Design

## Context

The binding direction is `docs/harness_integration_followup/14-tui-chat-direction.md` (user decision
2026-07-08): one chat — the TUI talks to the harness conversation agent, embedded, now. Everything risky
was retired live by `embed-conversation-agent` (archived): `assembleCoreRuntime` boots, the turn loop
round-trips pg threads, a chat-drafted plan launched a real run with `cortex_runs.thread_id` stamped.
This change moves that proven loop behind the product surface.

Verified ground (this session):
- `runTurn` (`modules/harness/chat.ts:269-349`) is transport-agnostic except SIGINT wiring + sink lines.
- `conversation.send` (`tui/hooks/conversation.ts:216`) is the only proxy-engine call in the TUI.
- Boot never writes to the terminal; pino is file-only (`lib/log.ts:52-58`, written for alternate-screen
  safety). `ensureSandboxImage` IS interactive (`profile.ts:135-155`) — normal-stdio only.
- `HarnessRuntime` (`runtime.ts:94-118`) carries `conversationAgent`, `provider`, `pool`, `triggerDeps`.
- Cortex's chat route has no profile gate; profiling is seeded automatically and surfaced to the UI.
- `prepareChatTurn` creates an absent thread under the caller-supplied id (REPL relies on this).

## Goals / Non-Goals

**Goals:**
- The TUI chat drives the conversation agent end-to-end (plan → conversational approval → execute →
  run card) with streaming text, visible tool activity, and honest unknown-part fallbacks.
- One turn-loop implementation shared by TUI and REPL; one classification ruleset shared with the printer.
- Boot behind an animation with the input gated; failures actionable; quit always clean.
- Profile auto-trigger at parity, non-blocking.

**Non-Goals:**
- Sidebar sections (change 2), proxy-engine deletion + dev umbrella (change 3), thread picker, any
  daemon/SSE work, run-watching beyond the run card, provenance riders (`record-plan-lineage`).

## Decisions

**D1 — Thread identity: `threadId := workspace.sessionId`.** `prepareChatTurn` creates absent threads
under the given id, so binding the pg thread 1:1 to the SQLite session reuses the ENTIRE existing
session machinery — launch resolution (resume/most-recent/create), the session picker, in-place swap,
sidebar identity — with zero new selection UI. New session ⇒ fresh thread; resume ⇒ same thread.
*Alternative rejected*: doc 14's sketch (resume analysis's latest thread via `listThreads`, else mint)
— decouples transcript from the session picker, makes `session.switch` meaningless, and needs new
state. *Consequences accepted*: REPL-minted threads are invisible to the TUI picker (REPL is a dev
surface); legacy sessions open with an empty pg transcript (SQLite history is legacy-frozen, per 14).

**D2 — Turn engine extraction: `modules/harness/turn.ts`.** Move `runTurn`'s body (prepare → runAgent →
unconditional `appendTurn` → outcome) plus the session builder into an exported engine keyed on
`{runtime, history, session, emit, signal, userInput}` returning a discriminated outcome
(`ok(fallbackText) | aborted | failed(cause) | prepare_failed(cause) | thread_gone`). The REPL keeps
SIGINT/forceStop/clack; the TUI hook keeps AbortController/store writes. Multi-caller justifies the new
file (repo rule). `provenance.agentId`: `"tui-chat"` for the TUI (`callPath: ["tui-chat"]`, length 1 —
passes the depth filter), REPL keeps `"cli-chat"`.

**D3 — Event classification is shared, not duplicated.** Export the printer's pure pieces from
`chat_printer.ts` (depth filter, `readPlanCard`, `readRunCard`) or lift them to a sibling module the
printer and the TUI adapter both import; the copy-on-receive rule is re-stated at the adapter. The TUI
adapter maps: `text-delta` → `streamText` signal (existing); `tool-started/finished` → a live tool part
in the store; `data-plan`/`data-run-card` → card parts; other `data-*` → tagged-mention part;
`iteration`/`done` → dropped. Everything stored is extracted/cloned at receipt.

**D4 — Store vocabulary: extend the UI `Part` union.** Add `plan-card` and `run-card` part kinds (and
render real data through the existing `tool-call` kind) so `MessageBlock`'s `never`-default switch
forces renderers (tui-stream-blocks rule). Card parts carry the primitive fields the readers extract —
never harness objects. *Alternative rejected*: a parallel harness-part store beside `messages` —
two sources of truth for one transcript.

**D5 — Boot state is its own store (`tui/hooks/boot.ts`):** `idle | booting | ready(model) |
failed(message)` + the runtime handle module-held (not in a signal — non-reactive infra). `ChatStatus`
stays `idle|busy|error` (turn-scoped). Gating: `handleSubmit` returns unless boot is `ready`;
`ChatBar` shows the gate affordance; `statusState` renders booting/failed; the boot animation mirrors
`ThinkingIndicator` (braille spinner, elapsed) and enters the design gallery. Ctrl+C during boot: the
three-way chord's quit tier already applies (status isn't `busy`); `shutdown` drains whatever the
partial boot registered.

**D6 — Launch phases.** Normal-stdio (before `render()`, beside `ensureProxyReadyOrExit`): harness
config gate (`cfg.configError` → fail) + `ensureSandboxImage` (interactive pull/confirm). Post-render:
`bootHarnessRuntime` async → boot store transitions → on ready, bind the thread scope + profile check.
*Alternative rejected*: boot before `render()` under a clack spinner — blocks the terminal for the
longest phase and abandons the animation UX the user asked for.

**D7 — Analysis swap rebinds scope.** `openSession` to a different analysis: abort in-flight turn,
release the old per-analysis instance lock, acquire the new (refuse the swap with a notice if held
elsewhere — the lock is the #37 interim guard), rebind thread (= new sessionId), reload transcript,
re-run the profile check. The runtime handle survives (it is analysis-agnostic). Same-analysis session
swap: no lock churn, just thread rebind + reload.

**D8 — Profile auto-trigger reuses the command's sequence.** On `ready` (and analysis swap): if
`loadDataProfileStatus` shows no completed/running profile AND the analysis has resolvable inputs,
run stage (`stageInputs` into `sessionTreeDataDir`) → seed (`upsertAnalysis`) → `triggerDataProfile`
(handle's `triggerDeps`) fire-and-forget; surface start/failure as a notice. No chat gate (Cortex
parity, verified). Zero inputs ⇒ skip silently (welcome hint already covers "add inputs").
Extraction from `profile.ts` internals is allowed where needed to avoid duplication.

**D9 — Transcript load.** `loadMessages` gains a thread-history source: `loadPage` (newest window) →
`contentToCortexMessages` → UIMessage mapping (text → text parts; recognized tool-calls → card/tool
parts via the shared readers; everything else dropped by the harness resolver). The 200-cap and
oldest-first ordering rules carry over unchanged.

**D10 — What does NOT change.** `bootHarnessRuntime` and the harness source (barrel riders only if a
gap emerges); the REPL's user-visible behavior; the bus (`part.delta` etc. stays for the legacy engine;
the harness path writes the store directly through the adapter — no new bus vocabulary, per doc 14
hard rule 3); the proxy engine files (change 3); the command registry.

## Risks / Trade-offs

- [Boot latency on open] → animation + gated input (user-accepted, doc 14); boot is async so the UI
  stays responsive; failure is terminal-state, not a hang.
- [Two chats visible in one codebase during changes 1–2] → the TUI no longer reaches the proxy engine
  (only `inflexa sessions` remains on SQLite reads); change 3 deletes.
- [In-process emit reference reuse corrupting the store] → D3/D4: extract-and-clone at receipt,
  enforced by the shared helpers' copy semantics + unit tests on the adapter.
- [Model volatility (F1: dead-but-Claude default passes boot)] → unchanged exposure, REPL-equivalent;
  pin `harness.model` for the E2E pass; boot-probe remains the named follow-up.
- [`runtime_already_active` / lock conflicts when a REPL or `inflexa run` is live] → boot store
  `failed` renders the actionable message; analysis-swap refusal notice (D7).
- [Turn failure mid-plan leaves partial thread state] → engine persists `[userMessage]` on abort/throw
  (same rule the REPL proved); the turn outcome surfaces in the error banner.
- [tsc/test surface: opentui renderables in tests] → headless `testRender`/`captureCharFrame` harness
  (no TTY, no credits) for gate/animation/blocks; one live PTY pass total.
