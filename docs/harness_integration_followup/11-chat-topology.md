# 11 — Chat Topology and the Streaming Contract (RQ1 / RQ3)

Written 2026-07-07, researched against HEAD `825d7825643caff9c75e6a1cc4207aac5de1416f`.
Maps both chat stacks end-to-end — the cli's incumbent intelligence module and the
harness's chat-turn machinery — plus the two thread stores and the streaming contract,
and answers RQ1 (one chat or two; which store owns threads; what the history view
reads) and RQ3 (the streaming path, what transfers from the cli's existing bus→Solid
streaming, how run events merge into chat for #33 M4).

---

## 0. Corrections to inherited claims

1. **There is no paced reveal.** The brief's RQ3 ("what of the cli's existing
   bus→Solid-store streaming (including the paced reveal …) transfers") assumes a
   typewriter mechanism that was tried and deliberately reverted. The authority is
   `cli/src/tui/hooks/conversation.ts:60-63`:

   > "No sub-delta reveal/typewriter: feeding the `<markdown>` renderable a growing
   > prefix many times a second races its async (treesitter) parse, which left inline
   > syntax (`**bold**`) rendered as raw literal `**` inconsistently. We mirror
   > opencode — render the whole accumulated `streamText` as it arrives (a handful of
   > coarse proxy chunks per turn), which the parser keeps up with cleanly."

   Greps for `reveal|typewriter|paced|charInterval|cadence|smooth` across `tui/` and
   `modules/intelligence/` find no mechanism — only a stale comment at
   `app.launch.tsx:42-43` ("60fps so the smooth streamed-text reveal (conversation.ts)
   repaints finely") that contradicts the code it cites and should be fixed. (Also:
   `app.launch.tsx:44` sets `targetFps: 60` while `cli/CLAUDE.md`'s launch section says
   30 — the code is 60.)

2. **`inflexa run`'s progress display does not consume typed run-event parts.** The
   brief says run-event parts are "consumed today by `run.ts`'s progress display" —
   false. `waitForRunTerminal` (`cli/src/modules/harness/run.ts:540-587`) polls
   `cortex_runs` (`queryRun`), the step ledger (`queryStepsByRun`), and DBOS's own
   tables (`dbos.workflow_status`, and `dbos.operation_outputs` via
   `readNewestWorkflowStep`, `profile.ts:322-333`) on a 2-second `Promise.sleep` tick.
   Nothing in `cli/src` reads the DBOS-backed run-event stream or any `data-*` part —
   greps for `readStream`, `run-event`, `DagState`, `StepActivity`, `data-step`,
   `data-run` return zero consumers (the only `data-run-card` mention is `run.ts:7`'s
   comment explaining the cli does NOT render them). The typed parts are written by the
   workflow bodies and **nobody local ever reads them**.

3. **No TUI surface shows live run progress today.** The sidebar's CONTEXT and RUNS
   sections render mock fixtures by design (`tui/layout/sidebar.tsx:42-44`: "CONTEXT
   and RUNS render MOCK fixtures … never live telemetry"); `RunBlock`'s only caller is
   the design gallery. The TUI never imports `@inflexa-ai/harness` (grep: zero hits in
   `tui/`).

---

## 1. Stack A — the incumbent: intelligence module → bus → Solid store

The proxy chat the TUI runs today. End-to-end:

1. **Submit**: `app.tsx:227` → `conversation.send({sessionId, userText})` →
   `chat({sessionId, userText, abort})` (`tui/hooks/conversation.ts:216-224`, owns the
   `AbortController`).
2. **Engine** (`modules/intelligence/chat.ts:45-172`): persists the user turn
   (message+part in one transaction), emits `message.created`/`part.updated`; builds
   history from **all** persisted messages (`listSessionMessages` →
   `toModelMessages` — text parts only, empty messages dropped); creates the assistant
   message + **empty part**, emitted up front ("the live typing effect needs the part
   mounted up front", `chat.ts:89-93`).
3. **Wire**: AI SDK `createOpenAICompatible({name: "cliproxy", baseURL:
   env.cliproxyApiUrl, apiKey})` + `streamText({model, system: SYSTEM_PROMPT, messages,
   abortSignal, maxOutputTokens: 8192, onError})` (`chat.ts:132-148`). The system
   prompt is a placeholder — `"You are Inflexa, a concise and helpful coding assistant
   operating in a terminal."` (`chat.ts:23`). Model selection: `GET /models` on the
   proxy, first id matching `["claude", "gpt", "gemini", "qwen"]`, else `ids[0]`
   (`chat.ts:33,209-235`). Errors surface via `onError` (not the stream consumer) →
   `session.error` bus event.
4. **Streaming**: per delta, `Bus.emit("inflexa", {type: "part.delta", sessionId,
   messageId, partId, delta})` — deltas carry strings, never the Part object.
5. **Finalize**: the engine **mutates the one `assistantPart` object in place**
   (`(assistantPart as TextPart).text = accumulated`, `chat.ts:165`), persists, then
   emits `part.updated` (same reference), `message.updated`, `session.status idle`.
6. **Store** (`tui/hooks/conversation.ts:90-173`): `part.delta` accumulates in the
   `streamText`/`streamPartId` signals — never the store; `part.updated` **clones**
   (`{...part}`) because "the engine REUSES one Part object across emits … keeping its
   reference (a) leaks untracked mutations into the store and (b) makes the final
   same-reference `parts[idx] = part` a no-op Solid skips" (`conversation.ts:138-142`);
   `session.status idle` triggers `commitStream()` — a fresh-object flush of the
   accumulated text into the store (`conversation.ts:65-83`). `MESSAGE_CAP = 200`
   bounds the mounted window.
7. **Render**: `message_block.tsx:67-73` — `<markdown content={content()} …
   streaming={true} internalBlockMode="top-level">`, `streaming` pinned true because
   `streaming={false}` renders nothing in @opentui/core 0.4.0; `content()` switches
   between live `streamText()` and stored `part.text`.

**Store**: SQLite `sessions`/`messages`/`parts` — JSON-blob tables
(`db/primary_migrations.ts:66-91`), cascade `analyses → sessions → messages → parts`,
`sessions.analysis_id` is a real column. The TUI message view reads
`listRecentSessionMessages(sessionId, 200)` (`primary_query.ts:59-68`); the session
picker reads `listSessionsByAnalysis` (`commands.tsx:239-264`). Session selection on
launch: resume id, else most-recently-updated session for the analysis, else
`createSession` (`modules/analysis/launch.ts:52-67`). Only `TextPart` is ever produced
by the live engine (`types/session.ts` — thinking/tool-call/file-edit kinds are
fixture-only).

**Bus events** (`types/events.ts:23-62`): six session-scoped members
(`session.status`, `message.created`, `message.updated`, `part.updated`, `part.delta`,
`session.error`) + nine `prov.*` analysis-scoped members. The bus is an in-process
`EventEmitter` (`lib/bus.ts`) — `types/events.ts:6` calling it "the cross-process event
contract" is aspirational, as #36 §5.3 already noted.

## 2. Stack B — the harness chat-turn (designed, never run)

Documented fully in `10-conversation-agent-inventory.md` §4; the streaming-relevant
shape:

```
prepareChatTurn({pool}, {analysisId, threadId, userInput})     ← ownership, title, context, window
  → runAgent(conversationAgent, messages, session,
             {provider, signal, emit, runStep: passthroughStep})
       emit ← EmitEvent (iteration / tool-started / tool-finished, each with source)
       emit ← ChatStreamEvent (text-delta / done) — via createStreamingChat(provider, onText)
       emit ← ChatDataPart (data-plan / data-run-card / data-presentation / …)
  → appendTurn(threadId, [userMessage, ...loopOutput])          ← pg, advisory-locked
```

The consumer-facing vocabulary is `contracts/`: `CortexChatEvent` — `text-delta`,
`tool-started`, `tool-finished`, `finish`, `error`, each carrying
`source: {agentId, callPath}` (`contracts/chat-events.ts:25-73`); `CortexChatPart` — 17
typed `data-*` parts (`contracts/chat-parts.ts:363-380`); `PART_REGISTRY` tags each
part `{emitter, consumer, transient, reconciling}` (`contracts/part-registry.ts:19-37`).
`contracts/chat-events.ts:6-9`: "these are the agent-loop stream events the harness
chat route frames as Cortex-native SSE … there is no AI SDK UI Message Stream Protocol
and no translation layer."

**Store**: Postgres `messages` (AI SDK `ModelMessage` envelopes, PK
`(thread_id, seq)`) + `cortex_analysis_threads` (title, soft-delete) +
`cortex_working_memory`. History display: `loadPage` → `contentToCortexMessages(rows,
createCardResolver(...))` — text parts pass through, recognized tool-calls become
reconstructed display cards, everything else drops; **cards are never persisted, always
derived from the transcript** (`memory/content-to-cortex.ts:15-21`).

## 3. RQ1 — one chat or two, and who owns the threads

### The answer: one chat per analysis; the conversation agent replaces the proxy chat wherever an analysis is in scope; harness Postgres owns those threads.

Evidence-based reasoning:

1. **The incumbent is a placeholder, not a product surface.** Its system prompt is a
   generic "coding assistant" string (`chat.ts:23`); its store renders text parts only;
   it has no tools, no analysis context, no working memory. The product interaction
   (converse → plan → approve → execute → interpret) exists only in Stack B. There is
   nothing to "coexist" with at feature level — coexistence would mean two chat UIs
   where one cannot do the product's job.

2. **The thread store is not a free variable.** The conversation agent's context
   assembly is hard-wired to the pg thread machinery: `prepareChatTurn` constructs
   `createThreadStore(pool)`/`createThreadHistory(pool)`/`createWorkingMemory(pool)`
   internally (`app/chat-turn.ts:49,74-81`) — the embedder supplies exactly `{pool}`.
   Putting conversation-agent threads in SQLite would mean forking the harness's
   memory layer, against the boundary rule (harness-first capabilities; the embedder
   supplies values, not redefinitions — root `CLAUDE.md`).

3. **Compatibility with #36's recommendations** (SQLite = product/identity store,
   Postgres = execution substrate): conversation-agent threads are the agent's working
   context — the same class as `cortex_working_memory`, which #36 already places in
   pg. The #36 ownership rule survives intact for identity (analyses, anchors,
   projects stay SQLite-canonical; a pg thread row is valid only while the SQLite
   analysis row exists — the same derived-state contract as `cortex_analysis_state`).
   What changes vs #36's snapshot table (§0) is one row: `sessions`/`messages`/`parts`
   stop being *the* chat store and become the **legacy/proxy-chat** store. The
   pg-readiness objection #36 raised against consolidation (§1: "Move chat/analyses
   into pg and every client interaction inherits a pg-readiness gate") applies with
   full force — and is priced in `13-sequencing-memo.md`: analysis chat through the
   conversation agent *requires the booted runtime anyway* (its tools are
   pool/DBOS/sandbox-backed), so the pg gate is inherent to the feature, not an
   avoidable storage choice. Chat without a booted runtime (history browsing) is a
   read path the daemon serves (#33 M3).

4. **What the TUI history view reads**: through the daemon (end-state), `GET
   …/threads` → `listThreads` and `GET …/threads/:id/messages` → `loadPage` →
   `contentToCortexMessages` — the exact managed shape (`cortex/harness/routes/
   threads.ts:51-89,161-211`), with cards rebuilt from tool-call blocks. In an embedded
   interim, the same two harness functions are called in-process. Either way **no cli
   mirror of the transcript exists** — the reconstruction design makes a second render
   store unnecessary, and #36 §2.4's "don't mirror across stores" rule says don't
   build one.

5. **What happens to `sessions`/`messages`/`parts` and the proxy chat**: decision for
   the user, two honest options —
   - *(a) Retire with adoption's TUI cutover*: the TUI chat is always
     analysis-scoped (the launch flow creates/resolves an analysis before mounting;
     `workspace.analysis` null only in degenerate flows), so the proxy chat has no
     remaining home; existing SQLite chat history stays readable until deleted
     (`inflexa sessions` continues to work) but new turns go to the conversation
     agent. The `intelligence` module shrinks to its `readApiKey`/`resolveModelId`
     helpers (already consumed by `bootHarnessRuntime`, `runtime.ts:52`).
   - *(b) Keep as an explicit "quick chat" mode* (no analysis, no runtime boot, no
     containers) beside the agent chat. Costs: two chat engines, two stores, a mode
     switch users must understand, and the placeholder prompt becomes a product
     surface needing real design.
   Recommendation: (a). The container-free lightweight path #36 §1 defends is about
   *reads* (ls, status, history), which the daemon serves without booting sandbox
   infrastructure; a second live chat engine is not worth its topology.

## 4. The managed streaming reference (what M3's daemon chat engine looks like)

The managed host (`/Users/s-ved/repos/inferentia/cortex`, vendored older harness) is
the only place the full streaming path has ever run:

- **Route**: `POST …/analyses/:analysisId/chat` (Hono), `streamSSE`; each frame is one
  flat JSON `data:` line (`routes/chat.ts:55,309-322`).
- **Translation**: `translateEvent` (`routes/sse-events.ts:37-78`) maps the loop's
  `EmitFn` traffic → wire frames and **drops sub-agent events** (`callPath.length > 1`)
  so only top-level conversation-agent activity reaches chat; `data-*` parts flatten to
  `{type, ...data}`.
- **Buffering**: a per-request in-memory `EventQueue` (single producer/consumer,
  `routes/event-queue.ts:10-67`); `queue.firstSettled` lets the route return a plain
  JSON error (402/500) if the turn dies before producing anything.
- **Background completion**: the loop runs as a detached promise; `stream.onAbort`
  deliberately does not cancel; `appendTurn` persists `[userMessage, ...appended]`
  when the loop ends (`chat.ts:19-21,234-247,312-314`). No `consumeStream` exists
  there either.
- **Thread scope**: the session is rebuilt with `threadId` in scope before the loop so
  `executePlan` stamps `cortex_runs.thread_id` (`chat.ts:160-170`) — the lineage hook
  RQ6 builds on.
- **Chat is NOT resumable**: the queue is per-request memory; a dropped client loses
  the frames (the turn still completes and persists). **The run stream IS resumable**:
  `GET …/run/:wfId/stream` re-reads `DBOS.readStream(wfId, "events")` for the parent +
  every child from offset 0 on each connect and folds reconciling parts latest-wins by
  `id` (`routes/run-stream.ts:48-50,105-154`, child discovery `:352-386`); the client
  (`observeRunStream`) reconnects when the stream closes while the run-status route
  still reports `running`.
- **Watch-from-chat**: `execute_plan` emits `data-run-card` into chat (also
  reconstructed on reload from the persisted tool-call); the live DAG/step detail is
  the separate run stream, routed by `PART_REGISTRY`'s `consumer: "sidebar"` tags.

## 5. RQ3 — the streaming path for adoption, and what transfers

### 5a. The contract, layer by layer

```
provider (proxy, Anthropic wire)          coarse chunks (~85 chars — proxy buffers upstream tokens)
  └─ ChatProvider.chatStream → ChatStreamEvent {text-delta|done}
       └─ createStreamingChat forwards each delta to the emit sink
            └─ EmitFn: EmitEvent | ChatStreamEvent | ChatDataPart
                 └─ [embedded]  in-process adapter → render
                 └─ [daemon]    translateEvent-style framing → SSE → TUI client
                      wire vocabulary = CortexChatEvent + CortexChatPart (contracts/)
                           └─ TUI reducer: delta signal + flush-on-finish → Solid store
```

The proxy's coarse chunking survives unchanged: the harness re-emits deltas as the
provider yields them, so the TUI receives the same sentence-sized chunks it renders
today — the no-typewriter rendering decision (§0.1) transfers as-is.

### 5b. What transfers from the incumbent TUI streaming

| Incumbent mechanism | Fate under adoption |
|---|---|
| Delta-in-signal, flush-on-idle reducer (`conversation.ts:85-158`) | **Transfers directly**: `text-delta` frames → `streamText` signal; `finish` frame plays the role of `session.status idle`; the flush writes a fresh object (same reconciliation reasoning) |
| Clone-before-store (`conversation.ts:138-144`) | **Becomes structurally unnecessary over SSE** (serialization mints fresh objects — #36 §5.3 predicted exactly this) but the reducer should keep owning its copies; in any embedded interim where `emit` crosses in-process, the mutable-reference hazard is live and the clone rule stays mandatory |
| `<markdown streaming={true} internalBlockMode="top-level">` pin (`message_block.tsx:67-73`) | **Transfers** — renderer-level, independent of source |
| `MESSAGE_CAP = 200` mounted-window cap | **Transfers** |
| Bus event shapes (`part.delta`/`part.updated`/…) | **Do not transfer as the wire contract.** The harness already ships the designed vocabulary (`CortexChatEvent`/`CortexChatPart`); inventing SSE frames from the cli's bus events would duplicate it. #33 note 6's "the bus contract is a good starting shape" is superseded by this finding: the *harness contracts* are the wire shape; the cli bus, if kept at all, becomes an internal fan-out detail |
| `part.delta`→`part.updated` two-phase persistence display | Replaced by the contracts' `text-delta`→`finish` (+ history reconstruction on reload) |

New TUI work with no incumbent to transfer from: rendering `tool-started`/
`tool-finished` chips, and the six conversation-emitted card parts (`data-plan`,
`data-run-card`, `data-presentation`, `data-file-reference`, `data-preview`,
`data-preview-failed`) — the design-gallery-first rule applies (new blocks enter the
gallery).

### 5c. Run events into chat (#33 M4)

Typed workflow parts (`data-run-started`, `data-dag-state`, `data-step-activity`, …)
are **not** on the chat stream — they are written by workflow bodies to the DBOS-backed
run stream, and `PART_REGISTRY` routes them `consumer: "sidebar"`. "Watch the run from
chat" therefore = render `data-run-card` in the transcript + subscribe the run view to
the daemon's run-stream endpoint keyed by `runId` (= `workflowID`).

**Gap, named**: the OSS harness ships only the *write* side of the run stream. The
read side — `DBOS.readStream` over parent + discovered children, latest-wins fold —
exists only in the managed route (`cortex/harness/routes/run-stream.ts`). Because the
cli must never import `@dbos-inc/dbos-sdk` directly (module-singleton fork risk —
`run.ts:497-500`; change C D4 set the precedent with `deliverExecEvent`), M4 requires a
**harness-side additive read helper** (an app-fn in the `synthesizeRun` mold, or a
ported `readRunStream(pool→DBOS, wfId)` with fold + child discovery) that the daemon
wraps in SSE. Greps confirming absence: `readStream|readRunStream|discoverChildStreams|
pipeDebouncedFold` over `harness/src` → only `writeStream` comments and the
target-assessment progress reader note (`workflows/target-assessment/progress.ts:11,21`
reads a different stream key, `"progress"`, and is likewise not exported).

## 6. Open user decisions (RQ1/RQ3 slice)

- [ ] **Proxy-chat fate** — §3.5: retire at TUI cutover (recommended) vs keep as an
      explicit no-analysis "quick chat" mode. Decides whether
      `sessions`/`messages`/`parts` is legacy-frozen or stays a live store.
- [ ] **Existing SQLite chat history** — leave readable in place (recommended; zero
      migration, `inflexa sessions` keeps working) vs one-time import into pg threads
      (costly: the proxy transcripts have no ModelMessage envelopes or tool calls, so
      the import is text-only).
- [ ] **Wire contract versioning** — the contracts are TypeScript-only today; #33 M1's
      shared zod contract module must decide whether chat frames get an explicit
      version field (per #36 §5.3's payload-versioning note) before clients ship.
