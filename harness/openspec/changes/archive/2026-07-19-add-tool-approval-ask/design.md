## Context

The conversation loop (`runAgent`, `loop/run-agent.ts`) drives one turn to a
terminal reply. It is **not durable** — chat runs on `passthroughStep`
(`loop/run-step.ts:25`, `(_name, fn) => fn()`), single-replica per turn; only
DBOS workflows use `durableStep`. Tools receive a `ToolContext` of
`{ session, signal, emit, runStep }` built per-call by `toolCtx`
(`run-agent.ts:85-90`), and `emit` (`loop/types.ts:107`) is a one-directional,
fire-and-forget event sink — nothing flows back into a running tool.

A tool that needs an explicit user decision (the `inflexa` shell-out of #154;
`execute_plan`, whose approval is prose-only today) has no primitive to pause
on. This change adds one: `ctx.ask`. The harness embeds in-process in the CLI
and runs against real Postgres provisioned by the CLI
(`cli/src/modules/infra/postgres_types.ts:1`), so an ask can be a durable ledger
row rather than pure memory.

The harness owns the primitive as a generic capability (per the #130 family
design: the harness never learns what `inflexa` or `refs` is). The CLI's docked
prompt, gallery exhibit, and TUI wiring are a **separate companion change** in
the `cli` spec tree, gated on a harness release.

## Goals / Non-Goals

**Goals:**
- A generic `ctx.ask(request) → AskReply` primitive any conversation tool can call.
- A three-variant reply (`once | always | reject(feedback)`), not a boolean.
- A denied ask that **ends the turn** with model-visible prose, not a retry loop.
- Deny-by-default when unwired (workflows, headless embedders) via the
  `Unavailable*` seam pattern.
- The DB as the **single source of truth** for ask state — no second in-memory
  registry to keep in sync.
- An outward `answer(id, reply)` / `pending()` API an embedder drives, transport-
  agnostic (direct call in the CLI; an HTTP route in a hosted deployment).

**Non-Goals:**
- **True crash-resumption of a paused turn.** A chat turn's suspended
  continuation is in-memory and dies with the process; the ledger records the
  loss (`pending → expired`) but does not rebuild the turn. Genuine resume would
  require the turn to run as a DBOS workflow with `ctx.ask ↔ DBOS.recv` — a
  separate, larger change that reshapes the non-durable chat path. Explicitly
  deferred.
- The CLI docked-prompt UI, its gallery exhibit, and TUI wiring (companion change).
- Cross-analysis or global standing grants — a grant never outlives or escapes
  its analysis.

## Decisions

### D1 — Poll the ledger; do NOT hold an in-memory resolver map

`ctx.ask` inserts a `pending` row, emits the UI part, then **polls that row**
until it reaches a terminal status, and returns the recorded reply. `answer` is
a single guarded `UPDATE`. There is no `Map<askId, resolveFn>`.

*Why over the resolver-map alternative:* a resolver map is a second source of
truth that must be reconciled with the ledger, and it forces the answering path
to find a live in-process resolver — which does not exist after a crash, or in a
hosted deployment where the answer arrives in a different process than the one
running the loop. Polling makes the **DB the only state**: `answer` is a pure
write, the awaiting tool observes the row flip, and a crash-orphaned row swept to
`expired` simply ends the poll. It costs poll latency (invisible against human
think-time; erasable later with Postgres `LISTEN/NOTIFY`), and it matches the
house poll-until-terminal pattern already used for the sandbox exec transport
(`awaitExec`). The interval is **200ms fixed** — imperceptible against human
decision speed, bounded chatter for a low-frequency interactive path; poll only,
no `NOTIFY` in this change. This is the decision the implementation must
annotate — see *Implementation notes*.

### D2 — Reject throws; the loop maps it to `execution-denied` and stops

A `reject` reply causes `ctx.ask` to **throw** an `AskRejectedError` (carrying
the feedback). Tools do not each set a "was denied" flag — only asks throw, so
the throw is the signal. `dispatchTool`'s existing catch (`run-agent.ts:255`)
recognizes this error specifically and produces a tool result with the AI SDK
`execution-denied` output type — already a valid `ToolResultPart` output and
already treated as an error by `isErrorOutput` (`run-agent.ts:293`) — carrying
`"The user rejected … with feedback: X"`. The loop, seeing a denial in the
turn's results, appends them and **hard-stops the turn**: concurrent siblings
already dispatched in the same `Promise.all` complete and their results are
appended, but no subsequent model call is made — not even a tool-less wrap-up.
The user just said no; spending another model call to acknowledge is not worth
it, and the denial tool result itself is what the surface renders. `approve`
(`once`/`always`) returns normally and the tool proceeds.

*Why throw over a per-tool flag:* the flag path would require every tool author
to both return the right variant and trip a separate signal; the throw keeps the
stop decision inside the harness and reuses the error boundary already in place.

### D3 — `ask` is an optional `RunAgentOptions` field, defaulting to `UnavailableAsk`

`ask` threads into `toolCtx` exactly as `emit` does — a per-turn value on
`RunAgentOptions`, passed by the caller (`turn.ts`). When omitted it resolves to
the shipped **`UnavailableAsk`**, which denies every request (the
`UnavailablePreviewPublisher` pattern, `tools/report/preview-publisher.ts:26`).
This gives workflow contexts and non-interactive embedders a safe default with
no wiring, and keeps the harness core stateless — the ledger + poll live in a
constructed seam realization over the injected `Pool`, never in module state.

### D4 — Chat-only

The poll body is ordinary DB reads, legal under `passthroughStep`. It is **never**
`DBOS.recv` and never runs in a workflow step context (where `recv` is the only
legal wait and a human block is illegal). A workflow-context tool receives the
deny-default. This is why the ledger poll is not modeled as a durable step.

### D5 — Status machine and crash sweep

`pending → resolved(once|always) | rejected | aborted | expired`. `aborted` when
the turn's `ctx.signal` fires: the poll exits, the row is marked, and `ctx.ask`
**re-throws the cancellation** so the loop's existing turn-abort path engages
(the turn outcome is `aborted`, `appendTurn` persists the user message). `expired`
when a boot sweep finds `pending` rows from a prior process (no live continuation
can consume them). `answer` is idempotent via `WHERE status = 'pending'` and
returns a discriminated outcome — `applied | not_found | already_terminal` — so
the answering surface can distinguish a landed decision from a stale or bogus id
rather than seeing a silent no-op. Rows carry `analysis_id`/`thread_id` so a
hosted `answer` is authorization-scoped.

### D6 — `always` is an analysis-scoped standing grant, persisted in `cortex_ask_grants`

An `always` reply writes a grant row keyed by `(analysis_id, action key)`, where
the action key is the exact concrete command/operation string the `AskRequest`
presented for approval — what the user saw is what is granted, nothing broader.
`ctx.ask` checks grants **before** pausing: a matching grant short-circuits the
prompt entirely, recording the ask in `cortex_asks` as `resolved` so the ledger
stays a complete audit of every approval-gated action. Grants live for the
analysis lifecycle — they survive process restarts and never apply to another
analysis. Deleting/expiring grants is deferred until a consumer needs it.

### D7 — The ask prompt is a harness-defined `data-ask` chat part

The harness owns the part contracts the CLI renders, so the ask part is defined
here, not in the companion change: an interface in `contracts/chat-parts.ts`, a
Zod schema in `contracts/schemas/chat-parts.ts`, and a `PART_REGISTRY` entry
`{ emitter: "conversation", consumer: "conversation", transient: false,
reconciling: true }` — reconciling because the part is re-emitted with the same
id on resolution, so readers fold pending → terminal latest-wins (the
`data-dag-state` precedent). The part carries the ask id, the request (title,
the exact command, optional detail), and the status — the id is what the
surface passes back to `answer`.

## Risks / Trade-offs

- **Poll latency** → sub-second interval is invisible at human decision speed;
  `LISTEN/NOTIFY` can remove it later without changing the contract.
- **A pending row implies durability the turn cannot honor on crash** → the boot
  sweep to `expired` + a UI that shows "expired when the session ended" keeps the
  ledger honest; no worse than today, where every in-flight turn is lost silently.
- **Concurrent asks** (parallel step tools dispatch in `Promise.all`,
  `run-agent.ts:207`) → each tool polls its own row; the surface **stacks**
  pending asks and the user answers them one by one, each answer resolving its
  own poll — the flow stays fluid with no cross-ask blocking in the harness.
- **DB chatter from polling** → bounded by interval + terminal-status short-circuit;
  acceptable for an interactive, low-frequency approval path.

## Migration Plan

- Add `cortex_asks` + `cortex_ask_grants` to the `state/init.ts` DDL — the
  harness creates its tables at startup via `CREATE TABLE IF NOT EXISTS` under a
  Postgres advisory lock (`src/state/init.ts:1-15`); there are no migration
  files. Thin ledgers, like `cortex_runs`. Additive; no backfill.
- Ship harness with the primitive + `UnavailableAsk` default. Existing callers
  that pass no `ask` get deny-by-default — no behavior change until a consumer
  wires a real realization.
- The CLI companion change bumps the harness pin and wires the realization + UI.
- Rollback: unwire `ask` (revert to default) — every current tool still works,
  since none depends on approval yet.

## Implementation notes (comments to land verbatim)

At the poll site, include a `// DESIGN(WHY)` block explaining the poll-over-map
choice, and — in the **same block** — a trailing `// TODO(refine)` noting the
ask records may fold into provenance later. Inline the rationale; do NOT cite
this change, any task id, or issue numbers in the code comment. Shape:

```
// DESIGN(WHY): we poll the ask ledger instead of holding an in-memory
// resolver map. The DB is the single source of truth, so answering is a pure
// UPDATE, a crash-orphaned pending row just ends the poll, and an answer that
// arrives in a different process than the loop (a hosted deployment) still
// lands. A resolver map would be a second state to reconcile and cannot be
// resolved once its process dies. Latency is invisible at human decision speed
// and can be erased later with LISTEN/NOTIFY.
// TODO(refine): these ask records might move into provenance later.
```

## Open Questions

None — the two candidates (poll interval, denial wrap-up) were resolved into
D1 (200ms fixed, poll only) and D2 (hard-stop, no wrap-up call).
