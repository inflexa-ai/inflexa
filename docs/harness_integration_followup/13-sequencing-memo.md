# 13 — Sequencing Memo: Adoption vs #33's Milestones (RQ7, with RQ6 constraints)

Written 2026-07-07, researched against HEAD `825d7825643caff9c75e6a1cc4207aac5de1416f`.
Decides the ordering question RQ7 put first — "adoption = M3+M4 of #33" vs "adoption
first, daemon after" — with a throwaway-work inventory for each ordering and a
recommended first OpenSpec change whose walking-skeleton verification is stated.
Grounded in artifacts 10–12; the RQ6 provenance constraints are folded in (§5).

> **Pin note:** mid-loop, HEAD advanced to `06f85b8` (#28 closed via live data-profile
> kill/resume verification; wedge issue filed as #41). `runtime.ts` citations below
> line 388 shift by −7 there (a removed `TODO(robustness)` block); nothing else this
> memo cites changed. #41 replaces "file the wedge issue" wherever 01 §5 is referenced.

> **SUPERSEDED IN PART (2026-07-08, user decision — see `14-tui-chat-direction.md`):**
> the daemon-first staging this memo recommends (§2 Ordering C's "then M1/M2, then
> adoption's product surface as M3+M4", and §4's sequence) is overridden — the TUI
> chat ships now, embedded, with #33 demoted to a later transport swap. What survives:
> the §1 portability decomposition (the reason the embedded build is safe), the landed
> skeleton (§3), and §5's provenance constraints. Ordering B's rejection no longer
> stands as written: its costs are now explicitly accepted trade-offs (14 §"Accepted
> trade-offs"), with the boot cost handled as UX (animation + input gate), not avoided.

---

## 1. What "adoption" decomposes into (portability analysis)

The work has four layers with very different portability across the embedded→daemon
move. This decomposition is what makes the sequencing question answerable:

| Layer | Content | Portable to the daemon? |
|---|---|---|
| **Composition root** | `assembleCoreRuntime` adoption (D1 discharge), the three dep gaps (`templatesDir`, `chrome`, `createPreviewPublisher`), `sweepEphemeralWorkflows` boot duty, barrel growth (10 §1, §2.5, §5) | **Verbatim.** #33 itself says "`bootHarnessRuntime` moves from 'called by profile/run' to 'called once by the daemon'" — every realization built here is the daemon's boot |
| **Turn loop** | `prepareChatTurn → runAgent(emit) → appendTurn`, thread/history reads (`loadPage` + `contentToCortexMessages`) | **Verbatim.** The app-fn layer was designed transport-free for exactly this (`app/chat-turn.ts:4-9`); the managed route proves the loop runs unchanged behind SSE |
| **Transport** | in-process emit adapter (embedded) vs `translateEvent`-style SSE framing + EventQueue + client (daemon, M3) | **Not portable** — this is the layer the orderings disagree about |
| **TUI rendering** | reducer (delta signal + flush), markdown pin, new card/tool-chip blocks for `CortexChatEvent`/`CortexChatPart` (11 §5b) | **Portable** — renders wire frames regardless of whether they arrived via bus or SSE, *if* built against the harness contracts rather than the cli bus shapes |

## 2. The orderings and their throwaway inventories

### Ordering A — daemon first: adoption lands as #33 M3+M4

M1 (skeleton/lifecycle/contract) → M2 (run engine + prov recorder behind the server) →
M3 (chat engine = conversation agent) → M4 (TUI pure client).

*Throwaway work*: essentially none — every piece lands in its end-state home.

*Cost that is not throwaway but is real*: the conversation agent, `assembleCoreRuntime`,
`prepareChatTurn`, `appendTurn`, and the planner loop have **zero production callers
anywhere** (10 §0.3, §5 — even the managed host predates these seams and wires by
hand). Under Ordering A their first-ever exercise happens behind three simultaneously
new layers: daemon lifecycle + auth, SSE framing, and a TUI HTTP client. Every
walking-skeleton lesson in this program points the other way — change C found real
bugs in three live E2E rounds with the *smallest possible wrapper* (a clack command),
and change F's design said it explicitly: "build and prove the run engine before
speccing provenance against a runtime whose shape had never been observed"
(`06-change-graph.md:180-182`). A planner mis-turn debugged through SSE frames in a
detached daemon is strictly worse than one debugged in-process at a prompt. M1+M2 are
also substantial changes that would land before any conversation-agent risk retires —
the highest-risk terrain (the brief's own framing) would wait longest.

### Ordering B — adoption first, embedded in the TUI; daemon after

Conversation agent wired into the TUI process now; #33 later.

*Throwaway inventory* (all discarded at M3/M4):
- The TUI-process runtime-boot path for chat (TUI acquires the machine-wide runtime
  lock at chat start — hostage topology worsens: a TUI chatting blocks `inflexa
  run`/`profile` in every other terminal, the exact #33 problem statement).
- The in-process emit→bus adapter and any bus-shaped wire vocabulary (11 §5b: the
  harness contracts supersede the bus shapes).
- Interim mitigations for the widened #37 window: chat mutations + run provenance now
  emit in the TUI process while `inflexa run` can still emit in another — the brief
  called this out; every guard built for it is discarded when M2 moves the recorder
  daemon-side.
- Chat UX built twice if any of it binds to in-process assumptions (abort handling,
  status wiring).

*Plus a product regression*: TUI startup/first-chat latency inherits the full boot
(Postgres readiness, DBOS launch, GGUF embedder load + probe, sandbox image check —
`runtime.ts:241-436`), violating the passive-flow lightness the no-litter policy
protects. **Rejected.**

### Ordering C — RECOMMENDED: embedded walking skeleton behind a deliberate text command, then M1/M2, then adoption's product surface as M3+M4

The pattern this program has now used twice (C: `inflexa profile`; F: `inflexa run
--plan`): exercise the never-run machinery behind a clack command that is explicitly a
dev surface under a clearing contract, then build the product surface on retired risk.

*Throwaway inventory* (the whole point is how small this is):
- The clack chat command itself (a REPL-ish loop: read line → turn → print). Bounded,
  explicitly temporary, `TODO(extend)`-marked with M3 as the named replacement — the
  same contract shape `plan_intake.ts` carries. Everything else it exercises —
  composition root, turn loop, prompts, thread store, contracts — transfers verbatim
  per §1.
- Nothing else. No TUI work happens until M4 (or M3, where rendering is built against
  the wire contracts directly).

*What it does NOT prove* (deliberately deferred to M3/M4): SSE framing, reconnect
semantics, multi-client behavior, TUI rendering of parts, run-watching UX.

**Answer to RQ7 as posed**: adoption does *not* presuppose the daemon for its risk
retirement (the skeleton is honest embedded work that survives M3 without rework,
because the app-fn layer was designed transport-free), but adoption's **product
surface is** M3+M4 of #33 — both poles of the question are half right, and the
decomposition in §1 is what reconciles them.

## 3. The recommended first change

- **Name (working)**: `embed-conversation-agent`
- **Tree**: `cli/openspec` (the composition root, the command, and the seam
  realizations are cli-side; the harness gets additive riders only — barrel exports
  per 10 §1c, and `sweepEphemeralWorkflows` exported — matching the C/F "additive
  riders" budget). If the run-lineage rider (§5) grows `RunProvenanceEvent`, that is a
  second small harness-side delta in the same change, same additive discipline as
  change D's `emitProvenance`.
- **Scope**:
  1. Boot: adopt `assembleCoreRuntime` (discharges C's D1 debt; 10 §5), add
     `sweepEphemeralWorkflows` before `launchDbos` (10 §2.5), keep the three hygiene
     crons + ingress + probe in `bootHarnessRuntime`.
  2. Realize the three gaps: `templatesDir` (root `templates/`, config-overridable),
     `chrome: {}` (config key later), `createPreviewPublisher: async () => new
     UnavailablePreviewPublisher()` (10 §1a).
  3. The command (working name `inflexa chat <analysis>`): resolve analysis →
     pre-flight → boot → per-analysis instance lock (see §5) → loop of
     `prepareChatTurn → runAgent(emit → clack/stdout printer) → appendTurn`. The
     printer renders `text-delta` accumulation, tool chips from
     `tool-started`/`tool-finished`, and text renderings of `data-plan` /
     `data-run-card` parts. Approval is conversational (12 §2). Ctrl+C aborts the turn
     (signal), not the process.
  4. Clearing-contract rewrites from 12 §4c stage 1 (plan-intake spec + the two
     `TODO(extend)` headers) ride along — they are docs-only and this change is the
     named "adoption arrives" trigger.
- **Walking-skeleton verification — what "chat plans and launches a real run" proves**
  (mirroring what C's skeleton proved for the embedding seam):
  1. `assembleCoreRuntime`'s first-ever execution assembles a working runtime over the
     cli's seam realizations (registration order, cohort, agent build).
  2. The proxy-backed `ChatProvider` sustains the conversation agent's tool-driving
     loop at product scale (50-iteration cap, ~40 tools' JSON schemas in every call,
     the 13-iteration inner planner) — C/F proved single-agent profile/step loops, not
     this shape.
  3. The pg thread machinery round-trips: `appendTurn` persists turns, the next turn's
     `loadRecent` window + working-memory render + analysis-context injection actually
     assemble (first non-test caller of all of it).
  4. The full product loop closes: `generate_plan` (real planner, real
     `validate_plan`/`submit_plan` against `cortex_plans`) → `show_plan` part →
     conversational approval → `execute_plan` → **a real `executeAnalysis` run**
     (dedup/reserve/authorize/launch under `workflowId = runId`) whose
     `cortex_runs.thread_id` is stamped from the chat scope — then `inspect_run`
     reads results back on a later turn.
  5. The emit sink carries all three event categories concurrently
     (deltas/orchestration/parts) without ordering surprises.
  Live-E2E findings task group budgeted, as C/F both needed.

## 4. Sequencing after the skeleton

```
embed-conversation-agent (skeleton; discharges D1; rewrites #32 contracts)
  → #33 M1 (daemon skeleton + shared contract — the #36-gated decisions land here,
             including thread-store answers from 11 §3)
  → #33 M2 (run engine + prov recorder daemon-side — closes #37 structurally, fixes the
             recovery-wedge ingress per 01 §4a, absorbs run.ts's replicated trigger per 12 §4c)
  → #33 M3 (chat engine = the skeleton's turn loop behind the daemon; TUI chat cutover;
             proxy-chat retirement decision from 11 §3.5)
  → #33 M4 (TUI pure client; run watching from chat — REQUIRES the harness-side
             run-stream read helper, 11 §5c, an additive harness change to spec with M4)
  → plan-export change (12 §4c stage 3)
```

The skeleton does not block M1 design work proceeding in parallel (they share no code),
but M3 should not start before the skeleton's findings land — it is the direct consumer
of everything the skeleton proves.

## 5. RQ6 — provenance constraints on all of the above

**What enters the signed ledger, minimum bar** (plan authorship lineage — which
conversation produced the plan that produced the run):

- *Already free at the ledger level*: chat-launched runs stamp
  `cortex_runs.thread_id` (12 §3.4). No signed-document coverage though.
- *Signed-document growth (small, additive)*: today's run vocabulary carries
  `planSummary` but no plan identity (`prov_bridge.ts` / `RunProvenanceEvent`,
  change D D3). Extend `run_started` with `planId` + `threadId` (both sit in
  `ExecuteAnalysisInput`, `execute-plan.ts:214-221`), add a plan entity
  (`inflexa:plan-{planId}`, deterministic QName per the D4 discipline) with
  `used(runQn, planQn)` and a `threadId` attribute — replay-idempotent by the same
  deterministic-identifier rule as everything else. Recommend as a rider on the
  skeleton change or an immediate small successor (`record-plan-lineage`), before M1.
- *Actor growth* (01-provenance-cli-target §7, quoted in the prior program): a
  `prov:SoftwareAgent` actor kind (agent id + model) with `actedOnBehalfOf(user)` —
  required before any chat-attributed record exists, because `appendAgent` throws on
  unknown kinds (growth cannot happen by accident). Belongs with the same rider.
- *Deferred, explicitly*: `prov.message_sent` / `prov.tool_invoked` per-turn harvesting
  (`cli/docs/audit.md:153-171` anticipated it; still "blocked on §1.2" there).
  Plan-authorship lineage satisfies the product question ("where did this run come
  from") at a fraction of the document growth; full chat harvesting is a later,
  separate decision with real document-size cost. Nothing in the adoption design may
  *preclude* it (the bus-event seam it needs is the sanctioned growth path and remains
  open).

**The #37 constraint (no new recorder placement)**: the rule for every stage —
*chat/plan provenance is emitted only in the process that hosts the recorder.*
- Skeleton: chat, runtime, and recorder share one process, and the command takes the
  **per-analysis instance lock** (the same key the TUI takes,
  `app.launch.tsx:33` / `workspace.ts:84`) so a concurrent TUI on the same analysis is
  refused — closing, for this command, the exact two-recorder pair #37 documents (its
  interim fix 1). Note `inflexa run`/`profile` still lack the analysis lock (#37's
  recommendation stands independently of adoption).
- M2 onward: the recorder is daemon-side; clients cause prov events only via daemon
  mutations — #37 closes structurally, and chat provenance inherits the single-writer
  guarantee without new machinery.

## 6. Open user decisions (RQ7/RQ6 slice)

- [ ] **Confirm Ordering C** — skeleton-first hybrid — over "pure M3+M4" (Ordering A).
      A is defensible if the appetite is "no temporary surfaces ever again"; the price
      is first-exercise-behind-three-new-layers on the product's riskiest terrain.
- [ ] **Skeleton command surface** — `inflexa chat` as a REPL (recommended: closest to
      the product interaction, exercises multi-turn windowing) vs one-shot
      `inflexa chat -m "..."` (simpler, but proves less of the thread machinery).
- [ ] **Plan-lineage rider placement** — inside `embed-conversation-agent` vs an
      immediate `record-plan-lineage` successor. Either precedes M1; bundling risks the
      skeleton's scope, splitting adds a change. Recommend: split (the D/D2/D3
      precedent — provenance changes landed best when scoped alone).
- [ ] **`inflexa run`/`profile` analysis lock** (#37 interim fix 1) — take it in the
      skeleton change since the file is already open, or leave it to #37? Recommend:
      take it (two lines, closes a live integrity hazard).
