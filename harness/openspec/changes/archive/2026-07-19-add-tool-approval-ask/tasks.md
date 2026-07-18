## 1. Approval contract types and the ask part

- [x] 1.1 Add `AskRequest` (title + concrete command/operation + optional detail; no tool- or domain-specific fields) and `AskReply` (`{ kind: "once" } | { kind: "always" } | { kind: "reject"; feedback?: string }`) to the tools layer.
- [x] 1.2 Add `AskRejectedError` carrying the reject feedback (the throw a `reject` reply raises out of `ctx.ask`).
- [x] 1.3 Add the `Ask` seam interface (`ask(request) => Promise<AskReply>`) and extend `ToolContext` in `tools/define-tool.ts` to `{ session, signal, emit, runStep, ask }`.
- [x] 1.4 Add the shipped deny-by-default `UnavailableAsk` realization (the `UnavailablePreviewPublisher` pattern) that rejects every request.
- [x] 1.5 Define the `data-ask` part: interface in `contracts/chat-parts.ts` (ask id, request incl. the exact command, status), Zod schema in `contracts/schemas/chat-parts.ts`, and a `PART_REGISTRY` entry `{ emitter: "conversation", consumer: "conversation", transient: false, reconciling: true }` (the `data-dag-state` precedent — resolution re-emits under the same id, latest-wins).

## 2. Poll-based ask ledger and grants

- [x] 2.1 Add `cortex_asks` (uuidv7 id, `analysis_id`/`thread_id` scope, request payload, `status` `pending | resolved | rejected | aborted | expired`, reply, timestamps) and `cortex_ask_grants` (analysis_id + exact action key + timestamps) to the `state/init.ts` DDL, next to the other `cortex_*` ledgers (`CREATE TABLE IF NOT EXISTS` under the startup advisory lock).
- [x] 2.2 Implement the gateway over the injected `Pool` in a new `tools/approval/` module: `insert(pending)`, `poll(id, signal)` at a fixed 200ms interval until terminal, `answer(id, reply)` as a guarded `UPDATE … WHERE status='pending'` returning `applied | not_found | already_terminal`, `pending()` enumeration.
- [x] 2.3 At the poll site, land the `// DESIGN(WHY)` block (poll over in-memory resolver map — DB as single source of truth, pure-UPDATE answer, crash-orphan just ends the poll, cross-process answer still lands, latency invisible / LISTEN-NOTIFY later) with a trailing `// TODO(refine)` in the same block noting the ask records might move into provenance later. Inline the rationale; do NOT cite the change name, task ids, or issue numbers.
- [x] 2.4 Wire `ctx.ask`: check `cortex_ask_grants` first — a matching grant short-circuits without prompting and records the ask as `resolved`; otherwise insert a `pending` row, emit the `data-ask` part, poll until terminal, re-emit the part with the terminal status, return the reply — or throw `AskRejectedError` on `reject`. On `ctx.signal` abort, mark the row `aborted` and re-throw the cancellation so the existing turn-abort path engages.
- [x] 2.5 On an `always` reply, write the grant row keyed by `(analysis_id, exact action key from the AskRequest)` — grants survive restarts and never cross analyses.
- [x] 2.6 Add the boot-time sweep that moves prior-process `pending` rows to `expired`.

## 3. Loop wiring and turn termination

- [x] 3.1 Add optional `ask` to `RunAgentOptions` (`loop/types.ts`), defaulting to `UnavailableAsk`, and thread it into `toolCtx` (`run-agent.ts:85-90`) exactly as `emit`.
- [x] 3.2 In `dispatchTool`, map a caught `AskRejectedError` to a `tool-result` with the AI SDK `execution-denied` output carrying the feedback prose.
- [x] 3.3 Hard-stop the turn when a denial is present in a turn's results: concurrent siblings from the same reply complete and all results are appended, then the loop returns with a denial-marking terminal finish — no further tool-calling iteration and no tool-less wrap-up call.

## 4. Public surface

- [x] 4.1 Export from `index.ts`: a `createAskGateway(pool)`-style factory closure (house factory pattern — it realizes the `Ask` seam and carries `answer`/`pending`/the boot sweep), plus `UnavailableAsk` and the `AskRequest` / `AskReply` / `AskRejectedError` types.

## 5. Tests

- [x] 5.1 Deferred round-trip: a suspended `ctx.ask` returns the reply an out-of-band `answer(id, …)` writes — one case per variant (`once`, `always`, `reject` → throws).
- [x] 5.2 Ledger: `answer` returns `applied` on a pending row, `already_terminal` on an answered row (row unchanged), `not_found` on an unknown id; `pending()` returns only unresolved asks.
- [x] 5.3 Grants: an `always` reply writes the grant; a matching ask auto-approves without pausing and records a `resolved` row; the grant holds across a simulated restart (fresh gateway over the same pool) and does not apply in a different analysis.
- [x] 5.4 Abort: a pending ask on an aborted turn becomes `aborted` and `ctx.ask` re-throws the cancellation.
- [x] 5.5 Boot sweep: a prior-process `pending` row becomes `expired`.
- [x] 5.6 Deny-default: an unwired runtime denies every `ctx.ask`.
- [x] 5.7 Loop termination: a turn with a denied approval ends with no subsequent model call while a concurrent sibling's result is still appended; an approved (`once`) approval lets the loop continue.

## 6. Build hygiene

- [x] 6.1 `bun run format:file` the changed `src/` files, then `tsc -p tsconfig.json` and `bun test` pass.
