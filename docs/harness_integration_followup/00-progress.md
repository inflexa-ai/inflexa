# Harness Integration — Follow-up Program Tracker

Successor to `docs/harness_integration-new/` (which re-verified the research after the
monorepo merge and drove the five-change graph). That program is **complete**: C
(embed-harness-runtime), F (embed-execute-analysis), D (bridge-harness-provenance),
D2 (deepen-run-provenance), and D3 (record-command-lineage) are landed and archived in
`cli/openspec/changes/archive/`; E (remove-custom-provenance-persistence) is **landed and
archived** at `harness/openspec/changes/archive/2026-07-07-remove-custom-provenance-persistence/`.

This folder holds the *forward* discussion: what comes after the program, now that the
issue tracker carries a committed daemon architecture (#33) and its follow-ups. Unlike
the predecessor folders, most of the terrain here is already mapped by issues — these
docs connect them and frame the two decisions that need making, they do not re-research
what the issues already verified.

**Reading order:** 01 (the sandbox recovery wedge — what "#28" loosely refers to, and
why its durable fix is #33's stable-ingress milestone) → 02 (the conversation-agent
adoption research program — the next walking skeleton, and why #33/#36/#32 changed its
shape since `06-change-graph.md` sketched it).

---

## Where the program stands (2026-07-09)

```
landed:   … ──► tui-harness-chat ──► tui-sidebar-live ──► retire-proxy-chat-dev-umbrella (2026-07-08)
              ──► tui-profile-lifecycle (2026-07-09, post-doc-14 polish)
DOC-14 SEQUENCE COMPLETE — the TUI chat is the one product conversation surface.
next:     (unsequenced follow-ups below; #33 daemon remains the future transport swap)
later:    ┌─ record-plan-lineage (the RQ6 provenance rider, deferred out of the skeleton)
          ├─ #33 daemon (a transport swap under the unchanged TUI — NOT a prerequisite; see 14)
          └─ durability hardening ────────── framed in 01, largely lands via #33 M2
```

**`tui-profile-lifecycle` LANDED 2026-07-09** (user-requested polish round on PR #45):
the data profile now follows the analysis's input set instead of firing once. Drift-aware
parity ladder (current enumerated drift signatures — fileId+size+mtimeMs — vs the
completed profile's `result.inputFiles`, hardened in a6b4368; enumerate-first so checks cost stat/readdir, staging only on a
decided trigger), live edges (debounced `prov.input_*` bus subscription + a
running→completed completion watch), clear-on-empty (harness rider: `clearDataProfile`,
nullable `data_profile_status`, NULL claimable by the start CAS — the wedge fix caught in
orchestrator review: without it a cleared analysis could never be profiled again), manual
re-profile (palette entry + `r` action in the profile dialog via a new optional
`ResultsDialog` action affordance), and the sidebar reordered to pipeline order
(SESSION → ANALYSIS → DATA PROFILE → RUNS). Full lifecycle live-verified in one tmux
pass (4 profile runs: no-drift silent skip, drift re-profile, forced restart,
clear + NULL row confirmed, re-add re-profiles through the widened CAS). harness 738 /
cli 623 tests, 0 fail. Pre-existing finding (out of scope, untouched code):
`resolveContext` ignores `--analysis <id|name>` on an anchor with multiple analyses, so
`inflexa profile --analysis … --status` dies at the ambiguity picker.

**`tui-harness-chat` LANDED 2026-07-08** (change 1 of doc 14): the TUI chat (plain
`inflexa`) now talks to the harness conversation agent — one chat, at Cortex-managed
parity. Shared turn engine (TUI + REPL), boot-state store + gate + animation, emit
adapter over the harness contracts with plan/run-card blocks, `threadId := sessionId`,
analysis-swap lock exchange, parity profile auto-trigger. Live-verified (PTY pass, exit
0); 535 cli tests pass after the verify + PR-review fix passes. Next: `tui-sidebar-live`
(data-profile section + real runs).

**Course correction (2026-07-08, user decision — BINDING):** the daemon-first staging
(13 §4: skeleton → #33 M1/M2 → TUI as M3/M4) postponed the actual product goal and is
superseded. The TUI chat ships NOW, embedded — one chat (the conversation agent; the
proxy engine retires), Cortex-managed parity (profile → plan → execute → inspect), the
sidebar wired to real profile/run data, boot behind an animation + input gate, and the
`chat`/`profile`/`run` text commands demoted to a dev umbrella. The binding direction
and change sequence live in `14-tui-chat-direction.md`.

The Ordering-C walking skeleton (`13-sequencing-memo.md` §3) is **landed and archived**:
`cli/openspec/changes/archive/2026-07-08-embed-conversation-agent/`. It adopts
`assembleCoreRuntime` (discharging change C's D1 debt), realizes the three conversation
deps (`templatesDir`/`chrome`/`createPreviewPublisher`), adds the pre-launch ephemeral
sweep, and ships `inflexa chat <analysis>` — a deliberately temporary clack REPL behind
the same clearing contract as `plan_intake`/`run` (#33 M3/M4 named as the replacement).
It also took the #37 interim per-analysis lock across `run`/`profile`/`chat` and did the
#32 stage-1 docs-only clearing-contract inversion (plan-intake = protocol replay surface).

## Backlog map — every known open item and its home

| Item | Home | State |
|---|---|---|
| Change E — delete custom prov persistence | `harness/openspec/changes/archive/2026-07-07-remove-custom-provenance-persistence` | landed + archived 2026-07-07 |
| Sandbox recovery wedge (leaked-container recv hang) | #41 (filed from 01 in this folder) | issue filed — observed live 2× |
| Data-profile kill/resume verification | #28 | done — verified live 2026-07-07 (clean resume, `recovery_attempts` 1→2) |
| Linux Docker ingress reachability | #27 | open; proposed bridge-gateway bind |
| TUI chat = conversation agent (parity with Cortex managed) | `14-tui-chat-direction.md` change 1 (`tui-harness-chat`) | **LANDED + archived 2026-07-08**; live-verified (PTY, exit 0) |
| Sidebar: data-profile section + real runs (mocks out) | `14-tui-chat-direction.md` change 2 (`tui-sidebar-live`) | **LANDED 2026-07-08**; live-verified via tmux capture; found+fixed the trigger→sidebar refresh gap |
| Proxy-chat retirement + `dev` command umbrella | `14-tui-chat-direction.md` change 3 | **LANDED 2026-07-08** — `modules/intelligence/` gone; bus = `prov.*` only; channel gate verified |
| Release binary build (was BROKEN, pre-existing) | retire-proxy-chat findings F1 | **FIXED at 442a304** — winston/winston-transport/otlp-proto + node-llama-cpp marked external in build.ts (DBOS-SDK requires them only on its never-enabled OTLP path); build + build:all verified clean in that commit |
| `INFLEXA_GIT_COMMIT` baking (was: never baked, pre-existing) | retire-proxy-chat verify observation | **FIXED at 40eb417** — build.ts refuses a production build without the commit and emits its --define explicitly (the bakedEnv scanner deliberately does not cover it); env.ts keeps a channel-keyed runtime backstop |
| Daemon architecture (one runtime, many clients) | #33 | decided + milestoned (M1–M4); demoted 2026-07-08 — a later transport swap, NOT a prerequisite (14) |
| State ownership under the daemon | #36 | open; 4 decision areas with recommendations |
| Provenance chain-fork (two recorders, one analysis) | #37 | open bug; structurally closed by #33 M2/M3 |
| Plan-intake reframe (author/replay split) | #32 | stage 1 LANDED (docs-only inversion in embed-conversation-agent, 2026-07-08); `run.ts` trigger absorbed by #33 M2; `plan export` = post-M3 change |
| Conversation-agent adoption | **02 in this folder** | skeleton LANDED + archived 2026-07-08 (`embed-conversation-agent`); artifacts 10–13 drove it; TUI integration next per 14 |
| Plan-authorship provenance rider (plan entity + `threadId` + `SoftwareAgent` actor) | `record-plan-lineage` (unfiled successor) | deferred out of the skeleton per 13 §6; later — no longer sequenced before the TUI work (14) |
| Chat-model boot probe gap (dead-but-Claude model passes the guard) | embed-conversation-agent `findings.md` F1 | surfaced live 2026-07-08; boot probes the embedder but not the chat model — candidate follow-up |
| Test-harness data-loss guard (root `bun test` bypassed the cli sandbox preload and deleted real user state) | tui-sidebar-live `findings.md` F2 | guard LANDED 2026-07-08: `resetDb` refuses paths outside the preload-stamped sandbox |
| Tool-read lineage gap (`read_file` invisible to lineage) | `harness_integration-new/00-progress.md` §D2 findings | unfiled |
| Tool-write lineage gap (`recordFileToolWrite` uncalled) | change E design D2 names it out-of-scope | unfiled |
| Data-profile + ephemeral lineage coverage hole | `03-provenance-migration-plan.md` open decisions | undecided |
| `summary.md` walk-ordering (unregistered artifact) | #38 | filed |
| Sandbox-step builds full agent catalog per step | #30 | filed (perf) |
| Analysis-inputs UX | #26 | filed |
| `inflexa run` detach messaging overstates Ctrl+C | `harness_integration-new/00-progress.md` §D findings | superseded by #33 M2 attach/detach UX |
| Archive `add-resource-budgeted-scheduling` | `harness/openspec/changes/archive/2026-07-07-add-resource-budgeted-scheduling` | archived (commit 1e5156f) |

## Open user decisions

- [x] Land order — resolved by events: E landed first (2026-07-07, archived), and the
      02 research loop was kicked off the same day.
- [x] File the recovery wedge as its own issue — filed as #41 (supersedes 01's §5
      recommendation), linked from #27 and #33 design-note-5.
- [x] Whether conversation-agent adoption presupposes #33 M1/M2 (daemon skeleton + run
      engine behind the server) or starts embedded — answered by the loop:
      `13-sequencing-memo.md` recommends Ordering C (embedded walking skeleton behind a
      deliberate text command → M1/M2 → adoption's product surface as M3+M4). The
      remaining calls are in the aggregated decisions list below.

---

## 2026-07-07 — the 02 research loop ran: conversation-agent adoption (RQ1–RQ7) — COMPLETE

Researched against HEAD `825d7825643caff9c75e6a1cc4207aac5de1416f`; same discipline as
`harness_integration-new`: an **inventory pass** (4 parallel research readers — the
harness chat surface, the cli chat stack, the managed Cortex reference embedding, the
prior docs — plus direct full reads of every load-bearing file), a **verification
pass** (highest-stakes claims spot-re-verified by direct read, not agent-relayed:
`contracts/chat-events` + `part-registry`, the cli engine's Part lifecycle,
`appendTurn`'s advisory lock, the message-envelope shape, the managed route's threadId
rebuild and background-completion header, `insertPlan`'s id minting, the data-profile
vs sandbox-step sandbox-create asymmetry — all passed, no artifact corrections
needed), and this close-out.

**Mid-loop HEAD move**: `06f85b8` landed while the loop ran (records the #28
data-profile kill/resume verification; #28 CLOSED; wedge issue filed as **#41**;
tracker rows above updated by that commit). Only citation drift: `runtime.ts` lines
below 388 shift by −7 (a removed `TODO(robustness)` block); pin notes added to
artifacts 10 and 13.

### Artifacts (the RQ deliverables)

- **`10-conversation-agent-inventory.md` — RQ2.** `assembleCoreRuntime`'s full dep
  surface vs the cli root: 12-field `ConversationAssemblyDeps` with only 3 gaps, all
  trivial (`templatesDir` → root `templates/`, `chrome` → `{}`,
  `createPreviewPublisher` → `UnavailablePreviewPublisher`); the two unregistered
  workflow bundles cost ~nothing (ephemeral = zero new backends; target-assessment =
  six fields all present). What actually breaks out of wiring order, verified from
  code — including the previously unknown **`sweepEphemeralWorkflows` pre-launch boot
  duty with zero callers in the OSS tree** (registering `ephemeral` without it makes
  recovery re-dispatch dead chat-turn sandboxes). D1 verdict: adopt the full root.
- **`11-chat-topology.md` — RQ1/RQ3.** Both chat stacks end-to-end. Answer: **one chat
  per analysis** — the conversation agent replaces the proxy chat; **harness Postgres
  owns its threads** (compatible with #36: threads are agent working state, the
  `cortex_working_memory` class; identity stays SQLite-canonical; the history view
  reads `loadPage` → `contentToCortexMessages`, cards derived from the transcript, no
  mirror store). The wire contract is the harness `contracts/` vocabulary
  (`CortexChatEvent` + 17 `CortexChatPart`s), **not** the cli bus shapes. The
  run-stream READ side (fold/merge/child-discovery) exists only in managed Cortex —
  #33 M4 needs an additive harness read helper (cli must never import the DBOS SDK).
- **`12-planner-flow.md` — RQ4/RQ5.** `generatePlan` → `executePlan` traced. The
  approval gate is **prompt-enforced and conversational** — no structural gate; the
  plan is persisted by `submit_plan` before any human sees it; a TUI approve button is
  UX sugar that sends a message. No-litter boundary named: plan files only on explicit
  export or hand-authoring. #32 priced across three options; recommend **Option B
  (invert, staged)**: contract rewrites at adoption (docs-only), the `run.ts` trigger
  replica absorbed by #33 M2, `plan export` post-M3 — with the load-bearing id
  asymmetry documented (planner ids random via `insertPlan`, intake ids
  content-hashed; export→replay mints a NEW plan id, which is correct replay semantics
  but needs deliberate lineage carriage).
- **`13-sequencing-memo.md` — RQ7 + RQ6.** Neither pure ordering wins. Recommended
  **Ordering C**: an embedded walking skeleton behind a deliberate clack command
  (`embed-conversation-agent`, cli tree; the only throwaway is the command itself —
  composition root and turn loop transfer verbatim to the daemon because the app-fn
  layer is transport-free by design) → #33 M1/M2 → adoption's product surface as
  M3+M4. The skeleton's verification statement mirrors change C's ("chat plans and
  launches a real run" = first exercise of `assembleCoreRuntime`, the proxy provider
  at 40-tool/50-iteration scale, the pg thread machinery, and the full
  plan→approve→execute→inspect loop with `cortex_runs.thread_id` stamped). RQ6:
  minimum bar = plan-authorship lineage (plan entity + `threadId` + `SoftwareAgent`
  actor as a small provenance rider before M1); per-turn `prov.message_sent`/
  `prov.tool_invoked` harvesting explicitly deferred; rule everywhere — chat/plan
  provenance is emitted only in the recorder's process (the skeleton takes the
  per-analysis lock, closing #37's pair for its duration; M2 closes #37 structurally).

### Corrections found (the predecessor pattern held — prior claims failed re-verification)

1. **`app/chat-turn.ts` is preparation-only** — no `runAgent`, no stream consumption;
   `consumeStream` does not exist anywhere in `harness/src` (greps in 10 §0). The
   brief §1 and `harness/CLAUDE.md:146` are stale; background completion in the
   managed reference is a detached promise plus an SSE abort that deliberately does
   not cancel.
2. **No paced reveal exists in the TUI** — `conversation.ts:60-63` documents the
   typewriter was tried and reverted; the brief's RQ3 premise and the stale comment at
   `app.launch.tsx:42-43` are wrong.
3. **`run.ts`'s progress display never consumes typed run-event parts** — it polls
   `cortex_runs`/`queryStepsByRun`/`dbos.*` on a 2 s tick; nothing in `cli/src` reads
   the DBOS run-event stream at all (greps in 11 §0.2).
4. **`assembleCoreRuntime` has zero production callers anywhere** — managed Cortex
   vendors an older harness and registers directly (`cortex/harness/server.ts:233-298`).
   Adopting the full root is its first exercise, not a catch-up; budget the skeleton
   accordingly.
5. **Stale harness docs to flag upstream**: `registerAnalysisWorkflows` named as the
   callable's producer (`agents/conversation-agent.ts:108`, `tools/execute-plan.ts:56`)
   while being uncalled and structurally unusable; the composite
   `workflowID = "${analysisId}:${runId}"` docstring (`conversation-agent.ts:15-16`)
   vs the bare-runId reality (`execute-plan.ts:243`); `harness/CONTEXT.md:71`
   describes the ephemeral pre-launch sweep as running while `sweepEphemeralWorkflows`
   has zero callers; `harness/CLAUDE.md:151` claims `contracts/` is barrel-exported —
   it is not; `contracts/chat-events.ts:4` says "15 `data-*` parts" — the registry
   has 17.
6. **Context-update claims re-verified rather than trusted**: the wedge asymmetry
   holds by direct read (data-profile creates its sandbox in the workflow body,
   `tasks/data-profile.ts:189-198` → fresh container on recovery; the run path's
   `sandbox.mint`/`sandbox.create` are `DBOS.runStep`-wrapped,
   `workflows/sandbox-step.ts:392,406` → leaked container reused). The "#28 closed /
   wedge issue filed" claims were **not yet true at loop start** (checked via `gh`:
   #28 OPEN, no #41) and became true mid-loop via `06f85b8` — recorded here so the
   timeline is honest.

### Open user decisions (aggregated) — RESOLVED by the skeleton landing (2026-07-08)

The `embed-conversation-agent` change resolved these as its recommendations predicted:

- [x] **Ordering C** confirmed — embedded walking skeleton landed first; #33 M1/M2 next.
- [x] Skeleton command surface: **`inflexa chat` REPL** (with `--thread` resume).
- [x] D1 debt: adopted `assembleCoreRuntime`; `executeTargetAssessment` registered
      deliberately untriggerable (recorded in the spec + a boot comment).
- [x] Contracts surface: **barrel growth** (additive riders); `harness/CLAUDE.md:151`
      fixed (and `:146` `consumeStream` claim, plus two stale docstrings).
- [x] #32: **Option B** (invert, staged) — stage 1 (docs-only) landed; `run.ts` trigger
      absorbed by #33 M2; `plan export` = post-M3 change.
- [x] Per-analysis lock in `run`/`profile` (+ `chat`) — taken in the skeleton (#37 fix 1).
- [x] Prompt-enforced approval gate — accepted for the skeleton; `RunAuthorizer` hard
      gate named as the structural fallback, not built.

Still open (deferred deliberately, not decided here):

- [ ] Plan-lineage provenance rider — **split into a `record-plan-lineage` successor**
      (the D/D2/D3 precedent). Later — no longer sequenced before the TUI work (14).
- [x] Proxy-chat fate — DECIDED 2026-07-08 (user, 14): retire the engine; one chat
      (the conversation agent). SQLite chat history freezes legacy-readable; the
      cutover is 14's change 1, deletion completes in change 3 — not #33 M3.
- [ ] `templatesDir` packaging for an installed cli — same open question change C left
      for `skillsDir` (10 §7); recorded in the change's design, checkout-run supported.
- [ ] Chat-model boot probe — findings F1; boot probes the embedder but not the chat
      model, so a dead-but-advertised Claude model passes the guard and fails at first
      turn. Candidate follow-up.
