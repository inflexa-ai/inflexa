# tui-harness-chat — Tasks

## 1. Shared turn engine (modules/harness)

- [x] 1.1 Extract the turn body from `chat.ts`'s `runTurn` into `modules/harness/turn.ts`: an exported
      engine (prepare → runAgent → unconditional appendTurn) returning a discriminated outcome
      (`ok(fallbackText) | aborted | failed(cause) | prepare_failed(cause) | thread_gone`), plus the
      session builder (`agentId`/`callPath` parameterized per surface — D2). JSDoc on every export.
- [x] 1.2 Rewire the REPL (`chat.ts`) onto the engine — SIGINT/forceStop/clack shell stays local;
      user-visible behavior unchanged; existing `chat.test.ts` still passes.
- [x] 1.3 Share the printer's classification pieces (sub-agent depth filter, `readPlanCard`,
      `readRunCard`) so the TUI adapter imports them rather than duplicating (D3); printer behavior
      and `chat_printer.test.ts` unchanged (extend exports/tests as needed).

## 2. Boot lifecycle (TUI)

- [x] 2.1 Boot-state store `tui/hooks/boot.ts` (`idle | booting | ready | failed(message)`) holding the
      runtime handle module-side (D5); JSDoc; unit-test the transition/gating helpers.
- [x] 2.2 Launch preamble: harness config gate + `ensureSandboxImage` join the normal-stdio phase for
      every analysis-chat launcher (shared preamble — chat-wiring delta); post-`render()` async
      `bootHarnessRuntime` kickoff driving the store; boot failure maps through `describeBootError`.
- [x] 2.3 Boot animation component (braille spinner + elapsed, `ThinkingIndicator` pattern) + design
      gallery entry; `app.tsx` `statusState` renders booting/failed; `handleSubmit` refuses until
      `ready`; `ChatBar` shows the gated affordance.
- [x] 2.4 Quit-during-boot: the abort chord's quit tier + `/quit` drain cleanly mid-boot (renderer
      destroyed, shutdown hooks run); headless `testRender` coverage for gate states.

## 3. Emit adapter + store swap (TUI)

- [x] 3.1 Extend the UI `Part` union with `plan-card` and `run-card` kinds (primitive fields only, D4);
      `MessageBlock` renderers for both + live tool-call rendering; `never`-default preserved; gallery
      entries for the new blocks.
- [x] 3.2 Emit adapter in `conversation.ts`: harness events → store (text-delta → `streamText`,
      tool started/finished → tool part, plan/run cards → card parts, unknown `data-*` → tagged
      mention, `iteration`/`done` dropped, depth filter, clone/extract at receipt). Unit tests: clone
      semantics, depth filter, unknown-part fallback, tool chip pairing.
- [x] 3.3 `send()` drives the turn engine with a turn-scoped `AbortController` (busy/error status
      lifecycle, flush-on-finish, outcome → error banner); `abort()` aborts the turn; the proxy
      `chat()` import is gone from `tui/`.
- [x] 3.4 `loadMessages` sources the transcript from the pg thread history (`loadPage` →
      `contentToCortexMessages` → UIMessage mapping, 200-cap oldest-first preserved) — empty for
      legacy sessions, no SQLite message reads on the harness path.

## 4. Thread binding, swap semantics, profile parity

- [x] 4.1 Thread scope = `workspace.sessionId` (D1) wired through send/load; the agent session carries
      `scope.threadId` (+ `agentId: "tui-chat"`, length-1 callPath).
- [x] 4.2 `openSession` rebind: abort in-flight turn, rebind thread + reload transcript; analysis swap
      exchanges the per-analysis instance lock with a refusal notice when held elsewhere, and re-runs
      the profile check (D7); unit-test the swap decision logic.
- [x] 4.3 Profile auto-trigger on `ready`/analysis-swap: inputs-present + no completed/running profile
      → stage → seed → trigger via the handle's `triggerDeps`, fire-and-forget with start/failure
      notices; zero inputs skip silently (D8); reuse/extract the sequence from `profile.ts` without
      duplication; unit-test the condition function.

## 5. Verification

- [x] 5.1 `bun run typecheck` + `bun run lint` clean; `bun run format:file` on all touched `src/` files;
      full `bun test` for the touched areas passes.
- [x] 5.2 Live E2E (ONE scripted PTY pass, `harness.model` pinned): open analysis chat → boot animation
      → input gated → ready → streamed turn rendered through the adapter → profile parity trigger fired
      → clean quit (exit 0, zero errors). Scoped to the NEW risk (boot gate + adapter + send); the
      full plan→approve→execute→thread_id loop was proven on the identical engine by the prior change
      (F2). Findings in `findings.md`.
- [x] 5.3 REPL regression: satisfied structurally (F3) — the REPL drives the same `runChatTurn` proven
      live via the TUI; its glue is pure + unit-tested + byte-identical diff. No separate live pass
      (one-PTY-pass budget).

## 6. Docs

- [x] 6.1 Update `docs/harness_integration_followup/14-tui-chat-direction.md` (D1 thread-identity
      refinement) and `00-progress.md` (change 1 landed); `TODO(extend)` header in
      `modules/harness/chat.ts` retargeted per the chat-command delta (done by worker 1).
