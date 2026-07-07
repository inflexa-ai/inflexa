# Conversation-Agent Adoption — the research program that must run first

Written 2026-07-07. This is a research *brief*, not research output: it defines what the
loop (in the style of `docs/harness_integration-new/`) must verify before the adoption
can be specced. Nothing here is a design decision; §4's questions are the deliverable
targets.

## 1. Why this is the next program

The product's core interaction — *converse → plan → approve → execute → interpret* — is
the one thing the integration program never built. What exists today:

- The **run engine works** but is driven by a deliberately temporary dev surface:
  `inflexa run <analysis> --plan <file>` + `plan_intake.ts`, both carrying `TODO(extend)`
  clearing contracts pointing at "conversation-agent/planner adoption"
  (`cli/openspec/specs/plan-intake/spec.md`: "expected to be REMOVED when the planner is
  adopted" — but see §3 on #32's proposed inversion).
- The **cli TUI chat never touches the harness**: the intelligence module talks to the
  local proxy directly (#33 problem statement confirms: "chat goes straight to the
  proxy"). The harness's Conversation Agent — the component that owns `generatePlan` /
  `executePlan` / `runEphemeral` / `iterateReport` / workspace search / `showUser` — has
  **never been embedded by anyone**. `executeAnalysis`'s designed caller is the
  conversation agent's `executePlan` tool; the cli replicates that flow by hand
  (`run.ts`, a "faithful replica" per change F).
- **C's D1 debt stands**: the cli registers workflows directly in assemble-order rather
  than calling `assembleCoreRuntime`, explicitly deferred "until conversation-agent
  adoption" (restated at F). Adoption is where the debt is discharged — or deliberately
  re-deferred.

By the change graph's own risk logic (build the thing that has never run), the remaining
product risk is concentrated here: the conversation agent, its chat-turn machinery
(`app/chat-turn.ts` — direct `runAgent` with `passthroughStep`, background completion
via `consumeStream`), and the planner flow are designed-but-unexercised, exactly as the
embedding seam was before change C.

## 2. What changed since `06-change-graph.md` sketched "beyond D"

The change graph imagined adoption as a cli-embeds-more-harness step. Three issues have
since reshaped the terrain:

1. **#33 (decided): the daemon topology.** End-state: `inflexa serve` owns the DBOS
   runtime, the chat engine, SQLite, and the prov recorder; the TUI is a pure
   HTTP/SSE client; "run trigger + live run watching from chat" is explicitly in scope
   (M4). The conversation agent's future home is therefore the **daemon**, not the TUI
   process — adoption designed against the embedded topology would be built twice.
2. **#36 (open): state ownership.** Its recommendations (keep SQLite as the
   product/identity store, Postgres as the execution substrate) directly constrain
   where conversation-agent thread history lives — the harness has its own `messages`
   table (AI SDK `ModelMessage` envelopes, Postgres), the cli has its own
   sessions/messages/parts (SQLite). Two chat stores, one product. #36 notes M1's
   shared contract module hard-codes these answers, so they must be decided first.
3. **#32 (postponed to exactly this program): plan-intake inversion.** The clearing
   contract said "retire plan_intake at planner adoption"; #32 proposes keeping file
   intake as the *replay/export* surface (planner authors, file replays, signed PROV
   completes the reproducibility loop). Its own text: "postponed until planner adoption
   actually starts — this issue is the pickup point." Adoption's proposal must resolve
   #32 either way.

Also relevant: #37 (prov chain-fork with two live recorders) means a conversation agent
that emits prov events (chat/planning lineage) from a second process would widen an
open bug — another argument for sequencing against #33 M2 (recorder daemon-side).

## 3. What is already settled (do NOT re-research)

- **Provider fit**: the cli proxy realizes `ChatProvider` (AI SDK compat wrapper,
  post-migration) — proven live by C (data-profile agents) and F (sandbox step agents).
  The AI SDK migration's message-envelope storage + startup backfill is landed harness
  work (`state/init.ts`).
- **Run engine, budget, provenance bridge**: landed (F, resource-budgeted scheduling,
  D/D2/D3). Adoption consumes these; it does not reopen them.
- **The harness ships no HTTP layer** — transport is the embedder's (harness CLAUDE.md).
  #33's server is cli-side code by design; the harness package needs no changes for the
  topology itself.
- **Planner context plumbing**: the planner prompt already receives per-step ceilings +
  machine budget; `validate_plan` rejects over-ceiling steps (resource-budgeted
  scheduling change).

## 4. The research questions (deliverables of the loop)

**RQ7 goes first — it gates the shape of everything else.**

- **RQ7 — Sequencing against #33.** Does adoption presuppose the daemon (M1 skeleton +
  M2 run-engine-behind-server), with the conversation agent landing as the daemon's
  chat engine (M3)? Or is there an honest embedded first slice (conversation agent
  in-process behind the TUI) that survives the M3 migration without rework? Deliverable:
  a sequencing memo — "adoption = M3+M4 of #33" vs "adoption first, daemon after" —
  with the throwaway-work inventory for each ordering.
- **RQ1 — Chat topology.** One chat or two? Does the conversation agent *replace* the
  TUI's proxy chat when an analysis is active, or coexist (general chat vs analysis
  chat)? Which store owns its threads — harness `messages` (Postgres) vs cli
  sessions/parts (SQLite) — and what does the TUI's history view read? Must produce a
  store-ownership answer compatible with #36's recommendations.
- **RQ2 — Assembly inventory.** Enumerate `assembleCoreRuntime`'s full dep surface
  (conversation assembly, target-assessment, ephemeral) against what
  `cli/src/modules/harness/runtime.ts` already realizes; name every gap (e.g.
  `PreviewPublisher`, report templates dir, bio keys for the literature tools) with its
  local realization or a deliberate stub. Decide: full root vs continued direct
  registration (discharging or re-documenting C's D1 debt). The assemble docstring
  declares wiring order load-bearing — verify what actually breaks.
- **RQ3 — Streaming path.** Trace `chat-turn.ts` → `ChatStreamEvent` → (per #33) SSE →
  TUI store. What of the cli's existing bus→Solid-store streaming (including the paced
  reveal and the clone-bus-parts constraint) transfers? How do typed run-event parts
  (already consumed by `run.ts`'s progress display) merge into the chat view for
  "watch the run from chat" (M4)?
- **RQ4 — Planner flow and the approval gate.** Trace `generatePlan` (closure-captured
  `PlannerOutcome`) → plan review → `executePlan`. Where does the human gate live
  (TUI approve dialog? file round-trip per #32 story 3?), and what is the deliberate-
  action boundary under the no-litter policy (plan files written only on explicit
  export)?
- **RQ5 — Resolve #32.** Author/replay split: what stays of `plan_intake.ts` (validated
  intake as the replay surface, `plan export` as the new inverse) vs what retires
  (hand-authoring as the *only* path). The clearing contracts in `plan_intake.ts` /
  `run.ts` / `plan-intake` spec get executed, inverted, or rewritten — explicitly.
- **RQ6 — Chat/planning provenance.** What of the conversation enters the signed
  ledger? `docs/audit.md` anticipated `prov.message_sent` / `prov.tool_invoked`;
  01-provenance-cli-target §7 already scoped the actor-model growth
  (`prov:SoftwareAgent`, `actedOnBehalfOf`). Minimum bar: plan authorship lineage
  (which conversation produced the plan that produced the run). Constraint: no new
  recorder placement that widens #37.

## 5. Proposed loop shape

Same discipline as `harness_integration-new`: short iterations, every claim re-verified
against the tree with file:line, corrections folded back into the artifacts.
Suggested artifacts (working titles):

- `10-conversation-agent-inventory.md` — RQ2: the full dep/tool/prompt surface of the
  conversation agent + chat-turn, verified post-AI-SDK-migration.
- `11-chat-topology.md` — RQ1/RQ3: both chat stacks mapped end-to-end (cli intelligence
  module vs harness chat-turn), the two thread stores, the streaming contract.
- `12-planner-flow.md` — RQ4/RQ5: generatePlan→executePlan traced, the #32 resolution
  options priced.
- `13-sequencing-memo.md` — RQ7 (+ RQ6 constraints): the ordering decision against
  #33's milestones, with a recommended first change and its walking-skeleton
  verification (what "chat plans and launches a real run" proves, mirroring what C's
  skeleton proved for the embedding seam).

Exit criterion: enough verified ground to write the adoption proposal(s) via OpenSpec —
in whichever tree(s) the sequencing memo assigns — without a single "presumably" in the
design.
