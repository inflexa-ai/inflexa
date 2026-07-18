## Why

A tool has no way to pause mid-execution, get an explicit user decision, and
continue on the answer. `execute_plan`'s "approval" is prose-only with zero
enforcement, and the agent-triggered `inflexa` shell-out (#154) must not run a
subprocess on the user's machine without a real gate. The harness needs one
generic, host-agnostic "can I do X?" primitive — reusable by any conversation
tool, never refs- or inflexa-specific.

## What Changes

- Add `ask` to `ToolContext`: a tool calls `ctx.ask(request)` and awaits a
  decision before proceeding.
- The reply is a three-variant `AskReply` — `once | always | reject(feedback)` —
  not a boolean. `always` records a **standing grant for that action, scoped to
  the analysis and lasting its lifecycle** (persisted in `cortex_ask_grants`;
  a later matching ask auto-approves without pausing); `reject` carries optional
  model-facing feedback.
- A rejected ask **throws**; the loop maps the throw to an `execution-denied`
  model-visible tool result and **hard-stops the turn** — concurrent sibling
  tools complete and their results are appended, but no further model call is
  made, so the agent cannot flail against the denial.
- The primitive is realized by an embedder seam with a shipped **deny-by-default**
  `UnavailableAsk` (the established `Unavailable*` pattern), so non-interactive
  hosts and workflow contexts are safe with no wiring.
- Persist asks in a **poll-based ledger** (`cortex_asks`: uuidv7 id + status),
  where the **DB is the single source of truth**. `ctx.ask` inserts a `pending`
  row, emits a `data-ask` chat part (defined harness-side in the part contracts,
  reconciling so status updates fold), then polls that row until it reaches a
  terminal status — there is **no in-memory resolver map** to keep in sync.
- Export an outward API: `answer(id, reply)` (one guarded `UPDATE`) and
  `pending()` (enumerate unresolved asks), so an embedder answers by id — the CLI
  TUI by direct call now, an HTTP route in a hosted deployment later.
- Sweep pending rows orphaned by a dead process to `expired` at boot: a chat
  turn's in-memory continuation does not survive a crash, so the ledger records
  the loss cleanly instead of leaving a permanently-`pending` row.
- **Chat-only.** A workflow-context tool gets the deny-default — there is no
  interactive surface to answer it and a durable step must never block on a human.

## Capabilities

### New Capabilities
- `tool-approval`: the `ctx.ask` inward primitive, the `AskRequest`/`AskReply`
  contract, the poll-based `cortex_asks` ledger and its status machine
  (`pending → resolved | rejected | aborted | expired`), the analysis-scoped
  `cortex_ask_grants` standing grants behind `always`, the `data-ask` chat part,
  the deny-by-default `Ask` seam + `UnavailableAsk` realization, and the
  `answer` / `pending` outward API the embedder drives.

### Modified Capabilities
- `harness-tools`: `ToolContext` gains `ask`; the "carries only request-scoped
  values" requirement changes from exactly `{ session, signal, emit, runStep }`
  to include `ask`.
- `harness-agent-loop`: a denied approval terminates the turn — a new
  loop-termination behavior distinct from the recoverable error-tool-result path
  (a denial is not something the model retries around).

## Impact

- **Harness code**: `tools/define-tool.ts` (`ToolContext.ask` + the `Ask`/
  `AskRequest`/`AskReply` types), `loop/types.ts` (`RunAgentOptions.ask`),
  `loop/run-agent.ts` (thread `ask` into `toolCtx`; map the denial throw to
  `execution-denied` and hard-stop), a new `tools/approval/` module (the
  poll-based gateway + `UnavailableAsk`), the `cortex_asks` + `cortex_ask_grants`
  DDL in `state/init.ts`, the `data-ask` part in `contracts/chat-parts.ts` +
  `contracts/schemas/chat-parts.ts` + the part registry, and `index.ts` exports
  (the gateway factory, `Ask`, `UnavailableAsk`, `AskRequest`, `AskReply`).
- **Test**: a deferred round-trip test proving a suspended `ctx.ask` returns the
  reply an out-of-band `answer(id, …)` writes, across each reply variant.
- **Companion CLI change** (separate spec tree; gated on a harness release per
  the pin-bump discipline): the docked approval prompt above `chat_bar`, its
  design-gallery exhibit, and wiring `answer`/`pending` + the ask data-part into
  the TUI. Out of scope here.
- **First real consumer**: the `inflexa` shell-out tool (#154); `execute_plan`
  is a natural retrofit once the primitive lands.
